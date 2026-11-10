import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import jpeg from "jpeg-js";
import {
  SmartSpectraSDK,
  CameraSelection,
  FrameTransform,
  PixelFormat,
  breathingMetrics,
  cardioMetrics,
  type PixelFormatValue,
} from "@smartspectra/node-sdk";
// The typed protobuf decoder lives in /messages (the root export returns a raw Buffer).
import { decodeMetrics } from "@smartspectra/node-sdk/messages";
import { config } from "../config.js";
import { verifyAccessToken } from "../middleware/auth.js";
import { validationMessage, friendlyError } from "./messages.js";

/*
 * Two input modes (MEASURE_INPUT in .env):
 *  - "camera"  (default, as in the SmartSpectra Node.js docs): the SDK opens the camera on the
 *              machine running this backend via useCamera(). Best quality (1280x720 @ 30 fps,
 *              exposure/white balance locked). Only works when the user sits at that machine.
 *  - "browser": the browser captures the camera and streams JPEG frames here (useCustomInput +
 *              sendFrame). Needed when the backend runs on a remote server.
 */

const AUTH_TIMEOUT_MS = 5_000;
const MAX_FRAME_BYTES = 1024 * 1024; // 1 MB per message is plenty for a 640px JPEG
const PREVIEW_MAX_WIDTH = 480; // camera mode: preview frames sent to the browser
const PREVIEW_INTERVAL_MS = 100; // ~10 fps preview
const STABLE_HOLD_MS = 3_000; // both readings must stay stable this long before we auto-stop

// SDK native state is process-global → run one measurement at a time.
let sessionActive = false;

type Stats = { framesIn: number; framesAccepted: number; frameBytes: number };

export function attachMeasureSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws/measure", maxPayload: MAX_FRAME_BYTES });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // Only our frontend may open this socket (blocks cross-site WebSocket hijacking).
    if (req.headers.origin !== config.corsOrigin) {
      ws.close(1008, "Origin not allowed");
      return;
    }
    handleConnection(ws);
  });
}

function send(ws: WebSocket, msg: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function handleConnection(ws: WebSocket) {
  let sdk: SmartSpectraSDK | null = null;
  let authState: "pending" | "checking" | "ok" = "pending";
  let ownsLock = false;
  let closed = false;
  let lastTimestampUs = -1;
  let limitTimer: ReturnType<typeof setTimeout> | undefined;
  let statsTimer: ReturnType<typeof setInterval> | undefined;
  // Diagnostics only: frame counts per 5 s window (no frame content or readings logged)
  const stats: Stats = { framesIn: 0, framesAccepted: 0, frameBytes: 0 };
  // Auto-stop: latest stability of each reading, and when both first became stable
  let heartStable = false;
  let breathingStable = false;
  let bothStableSince: number | null = null;

  function onStability(heart: boolean | null, breathing: boolean | null) {
    if (heart !== null) heartStable = heart;
    if (breathing !== null) breathingStable = breathing;
    if (!(heartStable && breathingStable)) {
      bothStableSince = null;
      return;
    }
    bothStableSince ??= Date.now();
    if (Date.now() - bothStableSince >= STABLE_HOLD_MS && authState === "ok" && !closed) {
      send(ws, { type: "done", reason: "stable" });
      ws.close(1000, "Readings stable"); // close → cleanup() stops the SDK and releases the camera
    }
  }

  // The client must authenticate quickly or get disconnected.
  const authTimer = setTimeout(() => {
    if (authState !== "ok") ws.close(1008, "Authentication timeout");
  }, AUTH_TIMEOUT_MS);

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (authState === "ok") {
      if (isBinary && config.measureInput === "browser") handleFrame(toBuffer(data));
      return;
    }
    if (authState === "checking") return;
    if (isBinary) {
      ws.close(1008, "Authenticate first");
      return;
    }
    authState = "checking";
    void authenticate(toBuffer(data).toString("utf8"));
  });

  ws.on("close", () => void cleanup());
  ws.on("error", () => void cleanup()); // must be handled, or a socket error crashes Node

  async function authenticate(text: string) {
    // 1. First message must be {"type":"auth","token":"..."}
    let token: unknown;
    try {
      token = (JSON.parse(text) as { token?: unknown }).token;
    } catch {
      /* invalid JSON → handled below */
    }
    if (typeof token !== "string") {
      ws.close(1008, "Invalid auth message");
      return;
    }

    // 2. Same Keycloak check as the REST API
    try {
      await verifyAccessToken(token);
    } catch {
      send(ws, { type: "error", message: "Your session has expired. Please log in again." });
      ws.close(1008, "Invalid token");
      return;
    }
    if (closed) return;
    clearTimeout(authTimer);

    if (!config.smartspectraApiKey) {
      send(ws, { type: "error", message: "Measurement is not configured on the server (missing API key)." });
      ws.close(1011, "Not configured");
      return;
    }

    // 3. One measurement at a time
    if (sessionActive) {
      send(ws, { type: "error", message: "Another measurement is in progress. Please try again in a minute." });
      ws.close(1013, "Busy");
      return;
    }
    sessionActive = true;
    ownsLock = true;

    // 4. Start SmartSpectra
    try {
      sdk = createSdk(ws, stats, onStability);
      if (config.measureInput === "camera") {
        // As in the docs' camera quickstart: the SDK opens and drives the camera itself.
        sdk.useCamera(CameraSelection.default, { width: 1280, height: 720, fps: 30 });
      } else {
        // Browser mode: we push the browser's frames ourselves.
        sdk.useCustomInput(FrameTransform.kNone);
      }
      sdk.start();
    } catch (err) {
      const e = err as { code?: number; message?: string };
      console.error(`[smartspectra] failed to start: ${e.code ?? "?"} ${e.message ?? err}`);
      send(ws, { type: "error", message: friendlyError(e.code ?? -1) });
      ws.close(1011, "Start failed");
      return;
    }

    authState = "ok";
    statsTimer = setInterval(() => {
      const fps = (stats.framesIn / 5).toFixed(1);
      const kb = stats.frameBytes ? ` ~${Math.round(stats.frameBytes / stats.framesIn / 1024)} KB/frame` : "";
      console.log(`[smartspectra] ${config.measureInput} mode: ${fps} fps, ${stats.framesAccepted}/${stats.framesIn} accepted${kb}`);
      stats.framesIn = stats.framesAccepted = stats.frameBytes = 0;
    }, 5_000);
    limitTimer = setTimeout(() => {
      send(ws, { type: "done", reason: "time_limit" });
      ws.close(1000, "Time limit reached");
    }, config.measureMaxSeconds * 1000);

    send(ws, { type: "ready", maxSeconds: config.measureMaxSeconds, input: config.measureInput });
  }

  // Browser mode. Frame packet = [8 bytes: float64 capture timestamp in µs, LE][JPEG bytes]
  function handleFrame(buf: Buffer) {
    if (!sdk || buf.length <= 8) return;

    const timestampUs = Math.round(buf.readDoubleLE(0));
    if (!Number.isFinite(timestampUs) || timestampUs <= lastTimestampUs) return; // SDK needs strictly increasing
    lastTimestampUs = timestampUs;

    let image: { width: number; height: number; data: Uint8Array };
    try {
      image = jpeg.decode(buf.subarray(8), {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: 2,
        maxMemoryUsageInMB: 64,
      });
    } catch {
      return; // skip a corrupt frame
    }

    stats.framesIn++;
    stats.frameBytes += buf.length;
    if (sdk.sendFrame(image.data, image.width, image.height, image.width * 4, PixelFormat.kRGBA, timestampUs)) {
      stats.framesAccepted++;
    }
    // Frames live only in memory here — never stored or logged.
  }

  async function cleanup() {
    if (closed) return;
    closed = true;
    clearTimeout(authTimer);
    clearTimeout(limitTimer);
    clearInterval(statsTimer);

    const s = sdk;
    sdk = null;
    if (s) {
      try { await s.stopAsync(); } catch { /* already stopped */ } // also releases the camera
      try { await s.destroy(); } catch { /* already destroyed */ }
    }
    // Release the lock only after the SDK is fully torn down.
    if (ownsLock) {
      ownsLock = false;
      sessionActive = false;
    }
  }
}

function createSdk(
  ws: WebSocket,
  stats: Stats,
  onStability: (heartStable: boolean | null, breathingStable: boolean | null) => void,
): SmartSpectraSDK {
  const sdk = new SmartSpectraSDK({
    apiKey: config.smartspectraApiKey,
    requestedMetrics: [...breathingMetrics, ...cardioMetrics], // cardio is needed for heart rate
    enableTelemetry: false,
  });

  // Face position / lighting / movement guidance
  sdk.on("validationStatus", (code, _timestampUs, hint) => {
    send(ws, { type: "status", code, message: validationMessage(code, hint) });
  });

  // Live readings: forward the latest sample of each
  sdk.on("metrics", (buf) => {
    const m = decodeMetrics(buf);
    const pulse = m.cardio?.pulseRate?.at(-1);
    const breathing = m.breathing?.rate?.at(-1);
    if (!pulse && !breathing) return;
    send(ws, {
      type: "metrics",
      heartRate: pulse?.value ?? null,
      heartRateStable: pulse?.stable ?? false,
      heartRateConfidence: pulse?.confidence ?? null,
      breathingRate: breathing?.value ?? null,
      breathingRateStable: breathing?.stable ?? false,
      breathingRateConfidence: breathing?.confidence ?? null,
    });
    // null = no new sample for that reading in this packet → keep the previous state
    onStability(pulse ? Boolean(pulse.stable) : null, breathing ? Boolean(breathing.stable) : null);
  });

  sdk.on("error", (code, message, retryable) => {
    console.error(`[smartspectra] error ${code}: ${message}`); // no frames or readings in logs
    send(ws, { type: "error", message: friendlyError(code) });
    if (!retryable) ws.close(1011, "Measurement error");
  });

  if (config.measureInput === "camera") {
    // Count frames the SDK's own camera pushes through the pipeline
    sdk.on("frameSentThrough", (sent) => {
      stats.framesIn++;
      if (sent) stats.framesAccepted++;
    });

    // Live preview for the browser: downscaled JPEG at ~10 fps (binary WebSocket messages)
    let lastPreviewAt = 0;
    sdk.on("videoOutput", (buf, width, height, stride, pixelFormat) => {
      const now = Date.now();
      if (now - lastPreviewAt < PREVIEW_INTERVAL_MS || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 256 * 1024) return; // browser not keeping up — skip
      lastPreviewAt = now;
      const jpegBytes = encodePreview(buf, width, height, stride, pixelFormat);
      if (jpegBytes) ws.send(jpegBytes);
    });
  }

  return sdk;
}

/** Downscales a raw frame (RGB/BGR/RGBA/BGRA) and encodes it as JPEG for the preview. */
function encodePreview(
  buf: Buffer,
  width: number,
  height: number,
  stride: number,
  pixelFormat: PixelFormatValue,
): Buffer | null {
  // [red offset, green offset, blue offset, bytes per pixel]
  const layout: Partial<Record<PixelFormatValue, [number, number, number, number]>> = {
    [PixelFormat.kRGBA]: [0, 1, 2, 4],
    [PixelFormat.kBGRA]: [2, 1, 0, 4],
    [PixelFormat.kRGB]: [0, 1, 2, 3],
    [PixelFormat.kBGR]: [2, 1, 0, 3],
  };
  const l = layout[pixelFormat];
  if (!l) return null; // YUV formats: skip preview
  const [r, g, b, bpp] = l;

  const step = Math.max(1, Math.ceil(width / PREVIEW_MAX_WIDTH));
  const w = Math.floor(width / step);
  const h = Math.floor(height / step);
  const out = Buffer.allocUnsafe(w * h * 4);
  let o = 0;
  for (let y = 0; y < h; y++) {
    let i = y * step * stride;
    for (let x = 0; x < w; x++, i += step * bpp) {
      out[o++] = buf[i + r];
      out[o++] = buf[i + g];
      out[o++] = buf[i + b];
      out[o++] = 255;
    }
  }
  return jpeg.encode({ data: out, width: w, height: h }, 70).data;
}

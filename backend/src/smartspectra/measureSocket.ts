import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import jpeg from "jpeg-js";
import {
  SmartSpectraSDK,
  FrameTransform,
  PixelFormat,
  breathingMetrics,
  cardioMetrics,
} from "@smartspectra/node-sdk";
// The typed protobuf decoder lives in /messages (the root export returns a raw Buffer).
import { decodeMetrics } from "@smartspectra/node-sdk/messages";
import { config } from "../config.js";
import { verifyAccessToken } from "../middleware/auth.js";
import { validationMessage, friendlyError } from "./messages.js";

const AUTH_TIMEOUT_MS = 5_000;
const MAX_FRAME_BYTES = 1024 * 1024; // 1 MB per message is plenty for a 640px JPEG

// SDK native state is process-global → run one measurement at a time.
let sessionActive = false;

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

  // The client must authenticate quickly or get disconnected.
  const authTimer = setTimeout(() => {
    if (authState !== "ok") ws.close(1008, "Authentication timeout");
  }, AUTH_TIMEOUT_MS);

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (authState === "ok") {
      if (isBinary) handleFrame(toBuffer(data));
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

    // 4. Start SmartSpectra in "custom input" mode: we push the browser's frames ourselves.
    try {
      sdk = createSdk(ws);
      sdk.useCustomInput(FrameTransform.kNone);
      sdk.start();
    } catch (err) {
      const e = err as { code?: number; message?: string };
      console.error(`[smartspectra] failed to start: ${e.code ?? "?"} ${e.message ?? err}`);
      send(ws, { type: "error", message: friendlyError(e.code ?? -1) });
      ws.close(1011, "Start failed");
      return;
    }

    authState = "ok";
    limitTimer = setTimeout(() => {
      send(ws, { type: "done", reason: "time_limit" });
      ws.close(1000, "Time limit reached");
    }, config.measureMaxSeconds * 1000);

    send(ws, { type: "ready", maxSeconds: config.measureMaxSeconds });
  }

  // Frame packet = [8 bytes: float64 capture timestamp in µs, little-endian][JPEG bytes]
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

    sdk.sendFrame(image.data, image.width, image.height, image.width * 4, PixelFormat.kRGBA, timestampUs);
    // Frames live only in memory here — never stored or logged.
  }

  async function cleanup() {
    if (closed) return;
    closed = true;
    clearTimeout(authTimer);
    clearTimeout(limitTimer);

    const s = sdk;
    sdk = null;
    if (s) {
      try { await s.stopAsync(); } catch { /* already stopped */ }
      try { await s.destroy(); } catch { /* already destroyed */ }
    }
    // Release the lock only after the SDK is fully torn down.
    if (ownsLock) {
      ownsLock = false;
      sessionActive = false;
    }
  }
}

function createSdk(ws: WebSocket): SmartSpectraSDK {
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
      breathingRate: breathing?.value ?? null,
      breathingRateStable: breathing?.stable ?? false,
    });
  });

  sdk.on("error", (code, message, retryable) => {
    console.error(`[smartspectra] error ${code}: ${message}`); // no frames or readings in logs
    send(ws, { type: "error", message: friendlyError(code) });
    if (!retryable) ws.close(1011, "Measurement error");
  });

  return sdk;
}

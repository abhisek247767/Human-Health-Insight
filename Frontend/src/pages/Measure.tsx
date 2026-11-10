import { useEffect, useRef, useState } from "react";
import { useAuth } from "react-oidc-context";
import { useApi } from "../api/useApi";

type Phase = "idle" | "connecting" | "measuring" | "done" | "error";

type Urgency = "none" | "checkup" | "urgent";
type Insight = {
  urgency: Urgency;
  summary: string;
  tips: string[];
  source: "ai" | "rules";
  disclaimer: string;
};

// Fixed notices chosen by the app's rules (not by the AI)
const URGENCY_NOTICE: Record<Urgency, { text: string; color: string; bg: string }> = {
  none: { text: "Your readings look within the typical resting range.", color: "#065f46", bg: "#d1fae5" },
  checkup: {
    text: "Some readings are outside the typical range. Consider a routine doctor check-up if they stay like this.",
    color: "#92400e",
    bg: "#fef3c7",
  },
  urgent: {
    text: "A reading is far outside the typical range. If you have chest pain, dizziness, fainting or trouble breathing, seek medical care now.",
    color: "#991b1b",
    bg: "#fee2e2",
  },
};

type Reading = { value: number | null; stable: boolean };
type Vitals = { heartRate: Reading; breathingRate: Reading };

type ServerMessage =
  | { type: "ready"; maxSeconds: number; input: InputMode }
  | { type: "status"; code: number; message: string }
  | {
      type: "metrics";
      heartRate: number | null;
      heartRateStable: boolean;
      breathingRate: number | null;
      breathingRateStable: boolean;
    }
  | { type: "done"; reason: string }
  | { type: "error"; message: string };

// "camera": the SmartSpectra SDK opens the camera on the backend machine (docs' way) and sends us preview JPEGs.
// "browser": this page opens the camera and streams frames to the backend.
type InputMode = "camera" | "browser";

type Session = {
  ws: WebSocket | null;
  stream: MediaStream | null;
  stopFrames: (() => void) | null;
  tick: number | undefined;
  previewUrl: string | null;
};

const WS_URL = import.meta.env.VITE_WS_URL;
const MAX_FRAME_WIDTH = 640;
const FPS = 30;
// Pulse is read from tiny skin-colour changes; heavy JPEG compression erases them.
const JPEG_QUALITY = 0.95;
const PREVIEW_STYLE = {
  width: "100%",
  aspectRatio: "4 / 3",
  objectFit: "cover",
  borderRadius: 12,
  background: "#0f172a",
  transform: "scaleX(-1)", // mirror the preview like a selfie camera
} as const;
const EMPTY_VITALS: Vitals = {
  heartRate: { value: null, stable: false },
  breathingRate: { value: null, stable: false },
};

/** Captures video frames as JPEG and sends [8-byte timestamp µs][JPEG] packets. */
function startFrameLoop(ws: WebSocket, video: HTMLVideoElement): () => void {
  if (!video.videoWidth) return () => {};
  const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  const t0 = performance.now(); // monotonic clock → valid SDK timestamps
  let busy = false;

  const id = window.setInterval(() => {
    // Skip a frame if the previous one is still encoding or the network is backed up
    if (busy || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 512 * 1024) return;
    busy = true;
    const timestampUs = (performance.now() - t0) * 1000;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      async (blob) => {
        try {
          if (!blob || ws.readyState !== WebSocket.OPEN) return;
          const jpegBytes = new Uint8Array(await blob.arrayBuffer());
          const packet = new Uint8Array(8 + jpegBytes.length);
          new DataView(packet.buffer).setFloat64(0, timestampUs, true);
          packet.set(jpegBytes, 8);
          ws.send(packet);
        } finally {
          busy = false;
        }
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  }, 1000 / FPS);

  return () => window.clearInterval(id);
}

/** Stops the frame loop, timer, socket and camera. Safe to call more than once. */
function endSession(s: Session, video: HTMLVideoElement | null) {
  s.stopFrames?.();
  s.stopFrames = null;
  window.clearInterval(s.tick);
  s.tick = undefined;
  if (s.ws && s.ws.readyState <= WebSocket.OPEN) s.ws.close(1000);
  s.ws = null;
  s.stream?.getTracks().forEach((t) => t.stop()); // turns the camera light off
  s.stream = null;
  if (video) video.srcObject = null;
  if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
  s.previewUrl = null;
}

export default function Measure() {
  const auth = useAuth();
  const api = useApi();
  const videoRef = useRef<HTMLVideoElement>(null);
  const session = useRef<Session>({ ws: null, stream: null, stopFrames: null, tick: undefined, previewUrl: null });
  const [inputMode, setInputMode] = useState<InputMode | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [vitals, setVitals] = useState<Vitals>(EMPTY_VITALS);
  const [elapsed, setElapsed] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(60);
  const [insight, setInsight] = useState<Insight | null>(null);
  const [insightLoading, setInsightLoading] = useState(false);
  const [insightError, setInsightError] = useState<string | null>(null);

  async function getInsights() {
    setInsightLoading(true);
    setInsightError(null);
    try {
      // Only stable readings are used — an unsettled value can be far off and cause false alarms.
      const result = await api<Insight>("/api/insights", {
        method: "POST",
        body: JSON.stringify({
          heartRate: vitals.heartRate.stable ? vitals.heartRate.value : null,
          breathingRate: vitals.breathingRate.stable ? vitals.breathingRate.value : null,
        }),
      });
      setInsight(result);
    } catch (e) {
      setInsightError((e as Error).message);
    } finally {
      setInsightLoading(false);
    }
  }

  // Always release the camera when leaving the page
  useEffect(() => {
    const s = session.current;
    const video = videoRef.current;
    return () => endSession(s, video);
  }, []);

  async function start() {
    const s = session.current;
    const video = videoRef.current;
    if (!video) return;

    setError(null);
    setVitals(EMPTY_VITALS);
    setInsight(null);
    setInsightError(null);
    setPreviewUrl(null);
    setElapsed(0);
    setPhase("connecting");
    setStatus("Connecting to the measurement server…");

    // Browser mode only: open this device's camera and start streaming frames
    async function startBrowserCamera(ws: WebSocket, videoEl: HTMLVideoElement) {
      try {
        s.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
        });
        videoEl.srcObject = s.stream;
        await videoEl.play();
        if (s.ws !== ws) return; // stopped while waiting for permission
        s.stopFrames = startFrameLoop(ws, videoEl);
        setStatus("Look at the camera and hold still…");
      } catch {
        endSession(s, videoEl);
        setError("Camera access was denied or no camera was found.");
        setPhase("error");
      }
    }

    // WebSocket → auth → server says which input mode it uses
    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    s.ws = ws;

    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: auth.user?.access_token }));

    ws.onmessage = (event) => {
      if (s.ws !== ws) return;

      // Binary message = preview JPEG from the backend camera (camera mode)
      if (typeof event.data !== "string") {
        const url = URL.createObjectURL(new Blob([event.data as ArrayBuffer], { type: "image/jpeg" }));
        if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
        s.previewUrl = url;
        setPreviewUrl(url);
        return;
      }

      const msg = JSON.parse(event.data) as ServerMessage;
      switch (msg.type) {
        case "ready": {
          setMaxSeconds(msg.maxSeconds);
          setInputMode(msg.input);
          setPhase("measuring");
          const t0 = Date.now();
          s.tick = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
          if (msg.input === "browser") {
            setStatus("Starting camera…");
            void startBrowserCamera(ws, video);
          } else {
            setStatus("Camera is on. Look at the camera and hold still…");
          }
          break;
        }
        case "status":
          setStatus(msg.message);
          break;
        case "metrics":
          setVitals((prev) => ({
            heartRate: msg.heartRate != null ? { value: msg.heartRate, stable: msg.heartRateStable } : prev.heartRate,
            breathingRate:
              msg.breathingRate != null
                ? { value: msg.breathingRate, stable: msg.breathingRateStable }
                : prev.breathingRate,
          }));
          break;
        case "done":
          setStatus(
            msg.reason === "stable"
              ? "Both readings are stable. Measurement complete, camera off."
              : "Time limit reached. Measurement stopped.",
          );
          break;
        case "error":
          setError(msg.message);
          setPhase("error");
          break;
      }
    };

    ws.onerror = () => {
      if (s.ws !== ws) return;
      setError("Could not reach the measurement server.");
      setPhase("error");
    };

    ws.onclose = () => {
      if (s.ws !== ws) return; // an old session closing — ignore
      endSession(s, video);
      setPhase((p) => (p === "error" ? p : "done"));
    };
  }

  function stop() {
    endSession(session.current, videoRef.current);
    setPhase("done");
    setStatus("Stopped.");
  }

  const running = phase === "connecting" || phase === "measuring";
  const hasReadings = vitals.heartRate.value != null || vitals.breathingRate.value != null;
  const hasStableReadings =
    (vitals.heartRate.value != null && vitals.heartRate.stable) ||
    (vitals.breathingRate.value != null && vitals.breathingRate.stable);
  const unstableNames = [
    vitals.heartRate.value != null && !vitals.heartRate.stable ? "heart rate" : null,
    vitals.breathingRate.value != null && !vitals.breathingRate.stable ? "breathing rate" : null,
  ].filter(Boolean);

  return (
    <main style={{ padding: 16, maxWidth: 960, margin: "0 auto" }}>
      <h2>Measure your vitals</h2>
      <p style={{ color: "#64748b" }}>Wellness readings only. This is not a medical diagnosis.</p>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        <div>
          {/* Browser mode: live <video>. Kept mounted (hidden) so the ref always exists. */}
          <video
            ref={videoRef}
            muted
            playsInline
            style={{ ...PREVIEW_STYLE, display: inputMode === "camera" ? "none" : "block" }}
          />
          {/* Camera mode: preview JPEGs sent by the backend's SmartSpectra camera */}
          {inputMode === "camera" &&
            (previewUrl ? (
              <img src={previewUrl} alt="Camera preview" style={PREVIEW_STYLE} />
            ) : (
              <div style={{ ...PREVIEW_STYLE, display: "grid", placeItems: "center", color: "#cbd5e1" }}>
                {running ? "Camera is on…" : "Camera off"}
              </div>
            ))}
        </div>

        <section>
          <ReadingCard label="Heart rate" reading={vitals.heartRate} unit="bpm" />
          <ReadingCard label="Breathing rate" reading={vitals.breathingRate} unit="breaths/min" />

          {phase === "measuring" && (
            <p>
              {elapsed}s · stops automatically when both readings are stable (max {maxSeconds}s)
            </p>
          )}
          <p aria-live="polite">{status}</p>
          {error && (
            <p role="alert" style={{ color: "#b91c1c" }}>
              {error}
            </p>
          )}

          {running ? (
            <button onClick={stop}>Stop</button>
          ) : (
            <>
              <label style={{ display: "block", margin: "12px 0" }}>
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I agree to
                use my camera. Video is processed live and not stored.
              </label>
              <button disabled={!consent} onClick={start}>
                {phase === "idle" ? "Start measurement" : "Measure again"}
              </button>
              {hasStableReadings && !insight && (
                <button onClick={getInsights} disabled={insightLoading} style={{ marginLeft: 8 }}>
                  {insightLoading ? "Thinking…" : "Get health tips"}
                </button>
              )}
            </>
          )}
          {!running && hasReadings && !insight && unstableNames.length > 0 && (
            <p style={{ fontSize: 14, color: "#b45309" }}>
              {hasStableReadings
                ? `The ${unstableNames.join(" and ")} did not stabilize, so it won't be used for tips.`
                : "Readings did not stabilize. Sit still in good light and measure again for tips."}
            </p>
          )}
          {insightError && (
            <p role="alert" style={{ color: "#b91c1c" }}>
              {insightError}
            </p>
          )}
        </section>
      </div>

      {insight && <InsightCard insight={insight} />}
    </main>
  );
}

function InsightCard({ insight }: { insight: Insight }) {
  const notice = URGENCY_NOTICE[insight.urgency];
  return (
    <section style={{ marginTop: 24, padding: 16, border: "1px solid #e2e8f0", borderRadius: 12 }}>
      <h3 style={{ marginTop: 0 }}>Your health tips</h3>
      <p role="status" style={{ padding: 12, borderRadius: 8, color: notice.color, background: notice.bg, fontWeight: 600 }}>
        {notice.text}
      </p>
      <p>{insight.summary}</p>
      <ul>
        {insight.tips.map((tip) => (
          <li key={tip} style={{ marginBottom: 6 }}>
            {tip}
          </li>
        ))}
      </ul>
      <p style={{ fontSize: 12, color: "#64748b", marginBottom: 0 }}>
        {insight.disclaimer} {insight.source === "ai" ? "Tips written by AI." : "Built-in tips (AI unavailable)."}
      </p>
    </section>
  );
}

function ReadingCard({ label, reading, unit }: { label: string; reading: Reading; unit: string }) {
  return (
    <div style={{ padding: 12, border: "1px solid #e2e8f0", borderRadius: 12, marginBottom: 12 }}>
      <div style={{ color: "#64748b", fontSize: 14 }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 700 }}>
        {reading.value != null ? Math.round(reading.value) : "—"}{" "}
        <span style={{ fontSize: 14, fontWeight: 400, color: "#64748b" }}>{unit}</span>
      </div>
      {reading.value != null && (
        <div style={{ fontSize: 12, color: reading.stable ? "#0f766e" : "#b45309" }}>
          {reading.stable ? "Stable reading" : "Stabilizing…"}
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useAuth } from "react-oidc-context";
import { useApi } from "../api/useApi";
import {
  ActivityIcon,
  BreathIcon,
  CameraIcon,
  CheckIcon,
  FaceScanIcon,
  HeartIcon,
  SparkleIcon,
  StopIcon,
} from "../components/HealthIcons";
import "../styles/health.css";

type Phase = "idle" | "connecting" | "measuring" | "done" | "error";

type Urgency = "none" | "checkup" | "urgent";
type Insight = {
  urgency: Urgency;
  summary: string;
  tips: string[];
  source: "ai" | "rules";
  model: string | null;
  disclaimer: string;
};

// Fixed notices chosen by the app's rules (not by the AI)
const URGENCY_NOTICE: Record<Urgency, string> = {
  none: "Your readings look within the typical resting range.",
  checkup: "Some readings are outside the typical range. Consider a routine doctor check-up if they stay like this.",
  urgent:
    "A reading is far outside the typical range. If you have chest pain, dizziness, fainting or trouble breathing, seek medical care now.",
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

/** Console logging for development only — production builds never print health readings. */
function debugLog(label: string, data: unknown) {
  if (import.meta.env.DEV) console.log(`%c${label}`, "color:#0f766e;font-weight:bold", data);
}
const MAX_FRAME_WIDTH = 640;
const FPS = 30;
// Pulse is read from tiny skin-colour changes; heavy JPEG compression erases them.
const JPEG_QUALITY = 0.95;
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
      debugLog(`[LLM insight] source=${result.source}${result.model ? ` model=${result.model}` : ""}`, result);
      setInsight(result);
    } catch (e) {
      debugLog("[LLM insight] request failed", e);
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
      debugLog(`[SmartSpectra] ${msg.type}`, msg);
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

  const showVideo = inputMode === "browser" && running;
  const showPreview = inputMode === "camera" && running && !!previewUrl;
  const progress = Math.min(100, (elapsed / maxSeconds) * 100);
  const emptyText = running
    ? "Camera is on, getting ready…"
    : phase === "done"
      ? "Measurement finished. Camera is off."
      : "Camera is off";

  return (
    <main className="hi-page">
      <div className="hi-container">
        <header className="hi-page-head">
          <div className="hi-head-icon">
            <ActivityIcon size={26} />
          </div>
          <div>
            <h1 className="hi-title">Measure your vitals</h1>
            <p className="hi-subtitle">Wellness readings only. This is not a medical diagnosis.</p>
          </div>
        </header>

        <div className="hi-grid-2">
          {/* ---------- Camera ---------- */}
          <section className="hi-card">
            <div className="hi-camera">
              {/* Browser mode: live <video>. Kept mounted (hidden) so the ref always exists. */}
              <video
                ref={videoRef}
                muted
                playsInline
                className="hi-camera-media"
                style={{ display: showVideo ? "block" : "none" }}
              />
              {/* Camera mode: preview JPEGs sent by the backend's SmartSpectra camera */}
              {showPreview && <img src={previewUrl} alt="Camera preview" className="hi-camera-media" />}

              {!showVideo && !showPreview && (
                <div className="hi-camera-empty">
                  <FaceScanIcon size={56} />
                  <span>{emptyText}</span>
                </div>
              )}

              {running && (
                <>
                  <span className="hi-corner tl" />
                  <span className="hi-corner tr" />
                  <span className="hi-corner bl" />
                  <span className="hi-corner br" />
                </>
              )}
              {phase === "measuring" && (
                <span className="hi-live">
                  <span className="hi-live-dot" />
                  LIVE · {elapsed}s
                </span>
              )}
            </div>

            {phase === "measuring" && (
              <>
                <div className="hi-progress" aria-hidden="true">
                  <div className="hi-progress-fill" style={{ width: `${progress}%` }} />
                </div>
                <p className="hi-hint">Stops automatically when both readings are stable (max {maxSeconds}s).</p>
              </>
            )}

            {status && (
              <p className="hi-status" aria-live="polite">
                <FaceScanIcon size={18} />
                {status}
              </p>
            )}
          </section>

          {/* ---------- Readings & controls ---------- */}
          <section className="hi-card hi-stack">
            <h2 className="hi-card-title" style={{ margin: 0 }}>
              Your readings
            </h2>
            <ReadingCard
              kind="heart"
              label="Heart rate"
              unit="bpm"
              reading={vitals.heartRate}
              live={phase === "measuring"}
            />
            <ReadingCard
              kind="breath"
              label="Breathing rate"
              unit="breaths/min"
              reading={vitals.breathingRate}
              live={phase === "measuring"}
            />

            {error && (
              <p role="alert" className="hi-alert">
                {error}
              </p>
            )}

            {running ? (
              <div className="hi-actions">
                <button className="hi-btn hi-btn-danger" onClick={stop}>
                  <StopIcon size={18} />
                  Stop
                </button>
              </div>
            ) : (
              <>
                <label className="hi-consent">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  <span>I agree to use my camera. Video is processed live and not stored.</span>
                </label>
                <div className="hi-actions">
                  <button className="hi-btn hi-btn-primary" disabled={!consent} onClick={start}>
                    <CameraIcon size={18} />
                    {phase === "idle" ? "Start measurement" : "Measure again"}
                  </button>
                  {hasStableReadings && !insight && (
                    <button className="hi-btn hi-btn-secondary" onClick={getInsights} disabled={insightLoading}>
                      <SparkleIcon size={18} />
                      {insightLoading ? "Thinking…" : "Get health tips"}
                    </button>
                  )}
                </div>
              </>
            )}

            {!running && hasReadings && !insight && unstableNames.length > 0 && (
              <p className="hi-note">
                {hasStableReadings
                  ? `The ${unstableNames.join(" and ")} did not stabilize, so it won't be used for tips.`
                  : "Readings did not stabilize. Sit still in good light and measure again for tips."}
              </p>
            )}
            {insightError && (
              <p role="alert" className="hi-alert">
                {insightError}
              </p>
            )}
          </section>
        </div>

        {insight && <InsightCard insight={insight} />}
      </div>
    </main>
  );
}

function InsightCard({ insight }: { insight: Insight }) {
  return (
    <section className="hi-card">
      <h2 className="hi-card-title">
        <SparkleIcon />
        Your health tips
      </h2>
      <p role="status" className={`hi-notice ${insight.urgency}`}>
        {URGENCY_NOTICE[insight.urgency]}
      </p>
      <p style={{ margin: 0 }}>{insight.summary}</p>
      <ul className="hi-tips">
        {insight.tips.map((tip) => (
          <li key={tip}>
            <CheckIcon size={18} />
            <span>{tip}</span>
          </li>
        ))}
      </ul>
      <p className="hi-disclaimer">
        {insight.disclaimer} {insight.source === "ai" ? "Tips written by AI." : "Built-in tips (AI unavailable)."}
      </p>
    </section>
  );
}

function ReadingCard({
  kind,
  label,
  unit,
  reading,
  live,
}: {
  kind: "heart" | "breath";
  label: string;
  unit: string;
  reading: Reading;
  live: boolean;
}) {
  const hasValue = reading.value != null;
  return (
    <div className={`hi-reading ${kind}${live && hasValue ? " live" : ""}`}>
      <div className="hi-reading-icon">{kind === "heart" ? <HeartIcon size={26} /> : <BreathIcon size={26} />}</div>
      <div>
        <div className="hi-reading-label">{label}</div>
        <div className="hi-reading-value">
          {hasValue ? Math.round(reading.value!) : "—"}
          <span className="hi-unit">{unit}</span>
        </div>
        {hasValue && (
          <span className={`hi-badge ${reading.stable ? "ok" : "warn"}`}>
            {reading.stable ? (
              <>
                <CheckIcon size={12} /> Stable reading
              </>
            ) : (
              "Stabilizing…"
            )}
          </span>
        )}
      </div>
    </div>
  );
}

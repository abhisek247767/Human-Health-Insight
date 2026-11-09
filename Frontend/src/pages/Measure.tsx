import { useEffect, useRef, useState } from "react";
import { useAuth } from "react-oidc-context";

type Phase = "idle" | "connecting" | "measuring" | "done" | "error";

type Reading = { value: number | null; stable: boolean };
type Vitals = { heartRate: Reading; breathingRate: Reading };

type ServerMessage =
  | { type: "ready"; maxSeconds: number }
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

type Session = {
  ws: WebSocket | null;
  stream: MediaStream | null;
  stopFrames: (() => void) | null;
  tick: number | undefined;
};

const WS_URL = import.meta.env.VITE_WS_URL;
const MAX_FRAME_WIDTH = 640;
const FPS = 30;
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
      0.8,
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
}

export default function Measure() {
  const auth = useAuth();
  const videoRef = useRef<HTMLVideoElement>(null);
  const session = useRef<Session>({ ws: null, stream: null, stopFrames: null, tick: undefined });

  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [vitals, setVitals] = useState<Vitals>(EMPTY_VITALS);
  const [elapsed, setElapsed] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(60);

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
    setElapsed(0);
    setPhase("connecting");
    setStatus("Starting camera…");

    // 1. Camera
    try {
      s.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      });
      video.srcObject = s.stream;
      await video.play();
    } catch {
      endSession(s, video);
      setError("Camera access was denied or no camera was found.");
      setPhase("error");
      return;
    }

    // 2. WebSocket → auth → frames
    setStatus("Connecting to the measurement server…");
    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    s.ws = ws;

    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: auth.user?.access_token }));

    ws.onmessage = (event) => {
      if (s.ws !== ws || typeof event.data !== "string") return;
      const msg = JSON.parse(event.data) as ServerMessage;
      switch (msg.type) {
        case "ready": {
          setMaxSeconds(msg.maxSeconds);
          setPhase("measuring");
          setStatus("Look at the camera and hold still…");
          s.stopFrames = startFrameLoop(ws, video);
          const t0 = Date.now();
          s.tick = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
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
          setStatus("Measurement complete.");
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

  return (
    <main style={{ padding: 16, maxWidth: 960, margin: "0 auto" }}>
      <h2>Measure your vitals</h2>
      <p style={{ color: "#64748b" }}>Wellness readings only. This is not a medical diagnosis.</p>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        <video
          ref={videoRef}
          muted
          playsInline
          style={{
            width: "100%",
            aspectRatio: "4 / 3",
            objectFit: "cover",
            borderRadius: 12,
            background: "#0f172a",
            transform: "scaleX(-1)", // mirror the preview like a selfie camera
          }}
        />

        <section>
          <ReadingCard label="Heart rate" reading={vitals.heartRate} unit="bpm" />
          <ReadingCard label="Breathing rate" reading={vitals.breathingRate} unit="breaths/min" />

          {phase === "measuring" && (
            <p>
              {elapsed}s / {maxSeconds}s
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
            </>
          )}
        </section>
      </div>
    </main>
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

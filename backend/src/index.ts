import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config.js";
import { requireAuth, requireRole } from "./middleware/auth.js";
import { attachMeasureSocket } from "./smartspectra/measureSocket.js";
import { buildInsight } from "./insights/buildInsight.js";

const app = express();
app.use(helmet());
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

// public
app.get("/health", (_req, res) => { res.json({ status: "ok" }); });

// any logged-in user
app.get("/api/me", requireAuth, (req, res) => { res.json(req.user); });

// admins only
app.get("/api/admin/ping", requireAuth, requireRole("admin"), (_req, res) => {
  res.json({ ok: true, message: "hello admin" });
});

// Accepts a number in [min, max] (rounded to 1 decimal), null/undefined → null, anything else → "invalid"
function parseReading(v: unknown, min: number, max: number): number | null | "invalid" {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return "invalid";
  return Math.round(v * 10) / 10;
}

// any logged-in user: AI wellness tips for a finished measurement
app.post("/api/insights", requireAuth, async (req, res) => {
  const heartRate = parseReading(req.body?.heartRate, 20, 250);
  const breathingRate = parseReading(req.body?.breathingRate, 2, 80);
  if (heartRate === "invalid" || breathingRate === "invalid" || (heartRate === null && breathingRate === null)) {
    res.status(400).json({ error: "invalid_readings" });
    return;
  }
  res.json(await buildInsight({ heartRate, breathingRate }));
});

// Express and the measurement WebSocket share port 4000
const server = createServer(app);
attachMeasureSocket(server);

server.listen(config.port, () => {
  console.log(`API on http://localhost:${config.port}`);
  console.log(`Measure WebSocket on ws://localhost:${config.port}/ws/measure`);
  if (!config.smartspectraApiKey) console.warn("SMARTSPECTRA_API_KEY is not set — measurements are disabled.");
});

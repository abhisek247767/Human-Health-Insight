import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config.js";
import { requireAuth, requireRole } from "./middleware/auth.js";
import { attachMeasureSocket } from "./smartspectra/measureSocket.js";

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

// Express and the measurement WebSocket share port 4000
const server = createServer(app);
attachMeasureSocket(server);

server.listen(config.port, () => {
  console.log(`API on http://localhost:${config.port}`);
  console.log(`Measure WebSocket on ws://localhost:${config.port}/ws/measure`);
  if (!config.smartspectraApiKey) console.warn("SMARTSPECTRA_API_KEY is not set — measurements are disabled.");
});

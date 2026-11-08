import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config.js";
import { requireAuth, requireRole } from "./middleware/auth.js";

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

app.listen(config.port, () => console.log(`API on http://localhost:${config.port}`));

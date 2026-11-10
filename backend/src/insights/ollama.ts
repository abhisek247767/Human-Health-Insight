import { config } from "../config.js";
import type { Level, Urgency } from "./vitalsRules.js";

export type InsightInput = {
  heartRate: { value: number; level: Level } | null;
  breathingRate: { value: number; level: Level } | null;
  urgency: Urgency;
};

const SYSTEM_PROMPT = `You are a friendly wellness assistant inside a health app. You are NOT a doctor.
You receive camera-based wellness readings taken at rest (heart rate in bpm, breathing rate per minute).
Each reading is already classified by the app, and the app has already decided an urgency level.

Rules:
- Explain the readings in plain, calm language in 2-3 sentences. Mention that camera readings can be affected by movement, lighting and recent activity.
- Never diagnose a disease, never name a medical condition as the cause, never suggest medication or dosages.
- Do not change the classification or the urgency.
- Give 3-5 short, practical tips such as rest, hydration, slow breathing, sleep, avoiding caffeine before measuring, and measuring again.
- If urgency is "checkup", one tip should suggest a routine check-up with a doctor if readings stay like this or they feel unwell.
- If urgency is "urgent", the app shows its own emergency notice; keep tips calm and include contacting a doctor soon.
- Respond only with JSON: {"summary": string, "tips": string[]}.`;

// JSON schema → Ollama structured output
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    tips: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "tips"],
};

/** Asks the Ollama model for a friendly explanation. Only numbers and levels are sent — no user identity. */
export async function generateInsight(input: InsightInput): Promise<{ summary: string; tips: string[] }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.ollama.apiKey) headers.Authorization = `Bearer ${config.ollama.apiKey}`;

  const res = await fetch(`${config.ollama.baseUrl}/api/chat`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(config.ollama.timeoutMs),
    body: JSON.stringify({
      model: config.ollama.model,
      stream: false,
      format: RESPONSE_SCHEMA,
      options: { temperature: 0.2 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(input) },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = (await res.json()) as { message?: { content?: string } };
  const parsed = JSON.parse(data.message?.content ?? "") as { summary?: unknown; tips?: unknown };
  if (typeof parsed.summary !== "string" || !Array.isArray(parsed.tips)) {
    throw new Error("Unexpected AI response shape");
  }

  return {
    summary: parsed.summary.trim().slice(0, 800),
    tips: parsed.tips
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      .slice(0, 5)
      .map((t) => t.trim().slice(0, 240)),
  };
}

import { config } from "../config.js";
import { generateInsight } from "./ollama.js";
import {
  classifyBreathingRate,
  classifyHeartRate,
  ruleBasedAdvice,
  urgencyFor,
  type Level,
} from "./vitalsRules.js";

export const DISCLAIMER =
  "Wellness information only, not a medical diagnosis. Camera-based readings can be inaccurate. If you feel unwell, contact a doctor.";

export async function buildInsight(readings: { heartRate: number | null; breathingRate: number | null }) {
  const heartRate =
    readings.heartRate != null ? { value: readings.heartRate, level: classifyHeartRate(readings.heartRate) } : null;
  const breathingRate =
    readings.breathingRate != null
      ? { value: readings.breathingRate, level: classifyBreathingRate(readings.breathingRate) }
      : null;

  const levels = [heartRate?.level, breathingRate?.level].filter((l): l is Level => l !== undefined);
  const urgency = urgencyFor(levels);

  let advice: { summary: string; tips: string[] };
  let source: "ai" | "rules";
  try {
    advice = await generateInsight({ heartRate, breathingRate, urgency });
    source = "ai";
  } catch (err) {
    console.warn(`[insights] AI unavailable, using built-in advice: ${(err as Error).message}`);
    advice = ruleBasedAdvice(urgency);
    source = "rules";
  }

  return {
    heartRate,
    breathingRate,
    urgency,
    summary: advice.summary,
    tips: advice.tips,
    source,
    model: source === "ai" ? config.ollama.model : null,
    disclaimer: DISCLAIMER,
  };
}

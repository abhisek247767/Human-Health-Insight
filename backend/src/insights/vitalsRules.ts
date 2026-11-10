// Fixed, rule-based classification of resting adult vitals.
// The app — not the AI — decides levels and urgency, so advice stays predictable.

export type Level = "very_low" | "low" | "slightly_low" | "normal" | "slightly_high" | "high" | "very_high";
export type Urgency = "none" | "checkup" | "urgent";

export function classifyHeartRate(bpm: number): Level {
  if (bpm < 40) return "very_low";
  if (bpm < 50) return "low";
  if (bpm < 60) return "slightly_low"; // common for fit people at rest
  if (bpm <= 100) return "normal";
  if (bpm <= 120) return "high";
  return "very_high";
}

export function classifyBreathingRate(perMin: number): Level {
  if (perMin < 8) return "very_low";
  if (perMin < 12) return "low";
  if (perMin <= 20) return "normal";
  if (perMin <= 24) return "slightly_high";
  if (perMin <= 30) return "high";
  return "very_high";
}

export function urgencyFor(levels: Level[]): Urgency {
  if (levels.some((l) => l === "very_low" || l === "very_high")) return "urgent";
  if (levels.some((l) => l === "low" || l === "high")) return "checkup";
  return "none";
}

/** Used when the AI is unavailable. */
export function ruleBasedAdvice(urgency: Urgency): { summary: string; tips: string[] } {
  switch (urgency) {
    case "none":
      return {
        summary: "Your readings are within the typical resting range. Camera readings can vary with lighting and movement, so look at trends over several days.",
        tips: [
          "Keep a regular sleep schedule.",
          "Stay hydrated through the day.",
          "Stay active — a daily walk helps your heart and lungs.",
          "Measure at the same time each day, sitting still, for comparable results.",
        ],
      };
    case "checkup":
      return {
        summary: "One or more readings are outside the typical resting range. This can happen after activity, stress, caffeine, or poor lighting during the measurement.",
        tips: [
          "Sit and rest for 5 minutes, then measure again.",
          "Avoid caffeine and exercise for 30 minutes before measuring.",
          "Try slow breathing: in for 4 seconds, out for 6 seconds, for 2 minutes.",
          "If readings stay like this or you feel unwell, book a routine check-up with a doctor.",
        ],
      };
    case "urgent":
      return {
        summary: "A reading is far outside the typical resting range. Camera readings can be wrong, so confirm it — but don't ignore how you feel.",
        tips: [
          "Sit down, rest, and measure again in a few minutes.",
          "Confirm with a proper device (pulse oximeter or blood pressure monitor) if you have one.",
          "Contact a doctor soon if the reading repeats.",
        ],
      };
  }
}

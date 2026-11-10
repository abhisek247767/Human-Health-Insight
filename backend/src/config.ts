import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: required("CORS_ORIGIN"),
  issuer: required("KEYCLOAK_ISSUER"),
  audience: required("KEYCLOAK_AUDIENCE"),
  // Optional so the REST API still runs without it; /ws/measure reports "not configured".
  smartspectraApiKey: process.env.SMARTSPECTRA_API_KEY ?? "",
  // Safety limit only — a measurement normally stops as soon as both readings are stable.
  measureMaxSeconds: Number(process.env.MEASURE_MAX_SECONDS ?? 120),
  // "camera" = SDK opens this machine's camera (docs' way); "browser" = browser streams frames
  measureInput: (process.env.MEASURE_INPUT === "browser" ? "browser" : "camera") as "camera" | "browser",
  ollama: {
    // Local Ollama (signed in for cloud models) by default; or https://ollama.com with an API key.
    // Named OLLAMA_BASE_URL (not OLLAMA_HOST) to avoid clashing with the Ollama server's own variable.
    baseUrl: (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, ""),
    model: process.env.OLLAMA_MODEL ?? "gpt-oss:20b-cloud",
    apiKey: process.env.OLLAMA_API_KEY ?? "",
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 30_000),
  },
};

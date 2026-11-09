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
  measureMaxSeconds: Number(process.env.MEASURE_MAX_SECONDS ?? 60),
};

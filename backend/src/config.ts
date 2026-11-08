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
};

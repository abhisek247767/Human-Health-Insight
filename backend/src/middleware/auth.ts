import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { config } from "../config.js";

// Keycloak's public keys — fetched once, cached, auto-refreshed on key rotation
const JWKS = createRemoteJWKSet(
  new URL(`${config.issuer}/protocol/openid-connect/certs`)
);

export interface AuthUser {
  sub: string;          // Keycloak user id — use this as the user key in your DB
  username?: string;
  email?: string;
  roles: string[];
}

declare global {
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

type KeycloakPayload = JWTPayload & {
  preferred_username?: string;
  email?: string;
  realm_access?: { roles?: string[] };
};

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing_token" });
    return;
  }
  try {
    const { payload } = await jwtVerify(header.slice(7), JWKS, {
      issuer: config.issuer,
      audience: config.audience,
    });
    const p = payload as KeycloakPayload;
    req.user = {
      sub: p.sub!,
      username: p.preferred_username,
      email: p.email,
      roles: p.realm_access?.roles ?? [],
    };
    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}

export const requireRole =
  (role: string) => (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.roles.includes(role)) return next();
    res.status(403).json({ error: "forbidden" });
  };

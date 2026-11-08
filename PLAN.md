# Human Health Insight — Implementation Plan

> Status: **Draft for review** · Phase 1 = Keycloak authentication · Phase 2 = SmartSpectra challenges

## Current state

| Part | What exists |
|---|---|
| `Frontend/` | Vite + React 19 + TypeScript starter (no routing, no auth) |
| `backend/` | Empty `package.json` only (Node, no server yet) |
| Infra | None (no Docker, no DB) |

---

## Target architecture

```
┌──────────────┐  1. login redirect (OIDC + PKCE)  ┌──────────────┐
│ React (Vite) │ ────────────────────────────────▶ │   Keycloak   │
│  :5173       │ ◀──────── access/refresh token ── │   :8080      │
└──────┬───────┘                                   └──────┬───────┘
       │ 2. API call: Authorization: Bearer <JWT>         │ JWKS (public keys)
       ▼                                                  │
┌──────────────┐  3. verify JWT signature/iss/aud/exp ◀───┘
│ Node API     │
│  :4000       │ ──▶ Postgres (app data)
└──────────────┘
```

- **Keycloak** is the only place passwords live. The app never sees credentials.
- **Frontend** uses Authorization Code flow + PKCE (public client, no secret in browser).
- **Backend** is a stateless resource server: it only validates the Bearer JWT against Keycloak's JWKS.

---

## Phase 1 — Keycloak authentication

### Step 1. Local infrastructure (Docker Compose)
- Add `docker-compose.yml` at repo root with:
  - `postgres` (one instance, two databases: `keycloak`, `hhi`)
  - `keycloak` (latest stable image, pinned version, `start-dev` for local)
- Add `.env.example` (admin user/password, DB creds) — real `.env` git-ignored.
- Export realm config to `infra/keycloak/realm-hhi.json` and auto-import on startup (`--import-realm`) so every dev gets the same setup.

**Done when:** `docker compose up` → Keycloak admin console at `http://localhost:8080` with the realm pre-loaded.

### Step 2. Keycloak realm configuration
| Item | Value |
|---|---|
| Realm | `human-health-insight` |
| Client (frontend) | `hhi-frontend` — public, Standard flow, PKCE `S256`, redirect `http://localhost:5173/*`, web origin `http://localhost:5173` |
| Client (backend) | `hhi-api` — used as token **audience** (audience mapper on `hhi-frontend`) |
| Realm roles | `user` (default), `admin` |
| Login options | Self-registration ON, email verification (later), forgot password ON |
| Token lifetimes | Access 5 min, SSO session 30 min idle (tune later) |
| Optional | Google/GitHub identity providers, MFA (OTP) for `admin` |

**Done when:** a test user can log in on Keycloak's account page.

### Step 3. Backend (Node + Express + TypeScript)
- Init: `express`, `typescript`, `tsx`, `cors`, `helmet`, `dotenv`, `jose` (JWT/JWKS verification).
- Structure:
  ```
  backend/src/
    index.ts            # app bootstrap
    config.ts           # env: KEYCLOAK_ISSUER, KEYCLOAK_AUDIENCE, PORT, CORS_ORIGIN
    middleware/auth.ts  # requireAuth, requireRole('admin')
    routes/health.ts    # GET /health (public)
    routes/me.ts        # GET /api/me (protected) → returns user id/email/roles from token
  ```
- `requireAuth`: read Bearer token → `jwtVerify` with remote JWKS → check `iss`, `aud=hhi-api`, `exp` → attach `req.user`.
- `requireRole`: check `realm_access.roles`.
- Return `401` for missing/invalid token, `403` for missing role.

**Done when:** `curl /api/me` → 401; with a valid token → 200 + user claims.

### Step 4. Frontend (React)
- Add `keycloak-js` (official adapter) **or** `react-oidc-context` + `oidc-client-ts` (generic OIDC). **Recommendation: `react-oidc-context`** — standard OIDC, not tied to Keycloak, good React hooks.
- Add `react-router` for pages.
- Structure:
  ```
  Frontend/src/
    auth/AuthProvider.tsx   # OIDC config from VITE_ env vars
    auth/ProtectedRoute.tsx # redirects to login if unauthenticated
    api/client.ts           # fetch wrapper that attaches Bearer token, retries after silent refresh
    pages/Home.tsx          # public landing
    pages/Dashboard.tsx     # protected, calls /api/me
  ```
- Header: Login / Logout button, show username.
- Tokens kept **in memory** (not localStorage); silent refresh via refresh token.

**Done when:** Login → redirected to Keycloak → back to Dashboard showing data from `/api/me`; Logout ends the Keycloak session.

### Step 5. Hardening & dev experience
- CORS restricted to frontend origin; `helmet` headers.
- Role-based UI (hide admin pages for non-admins — backend still enforces).
- Root `README.md`: how to run everything (`docker compose up`, `npm run dev` in both apps).
- Basic tests: backend middleware unit tests (valid/expired/wrong-audience token).

### Phase 1 checklist
- [ ] Docker Compose (Postgres + Keycloak) + realm import
- [ ] Realm, clients, roles configured and exported
- [ ] Backend scaffold + JWT middleware + `/api/me`
- [ ] Frontend OIDC login/logout + protected route
- [ ] End-to-end login → API call works
- [ ] README + `.env.example`

---

## Phase 2 — SmartSpectra challenges (outline, detail after Phase 1)

SmartSpectra (Presage Technologies) measures vitals such as heart rate and breathing rate from a camera feed. Phase 2 plugs it into the authenticated app.

**To confirm before designing:**
1. The exact challenge requirements/brief we are targeting.
2. Which SmartSpectra SDK fits our stack (web/JS, C++/Linux, Python, or mobile) and how the API key works — this decides whether processing runs in the browser or in a backend service.

**Likely shape:**
- Protected `/measure` page: camera permission → run SmartSpectra measurement → show live vitals.
- Backend endpoints (protected): `POST /api/measurements`, `GET /api/measurements` — store results **per Keycloak user id (`sub`)**.
- History/trends page with charts.
- SmartSpectra API key kept server-side or in env, never committed.

**Health data handling (applies from day one):**
- Treat all vitals as sensitive: protected routes only, users can only read their own data, HTTPS outside localhost.
- No real personal or health data in the repo, seeds, logs, or screenshots — use synthetic test users and fake readings only.
- Don't log raw tokens or measurement payloads.

---

## Open questions for you
1. `keycloak-js` vs `react-oidc-context` — OK with the recommendation?
2. Social login (Google/GitHub) needed now or later?
3. Backend language confirmed as Node/TypeScript (folder is under `PYTHON_AI` — Python/FastAPI is also an option)?
4. Share the SmartSpectra challenge brief so Phase 2 can be detailed.

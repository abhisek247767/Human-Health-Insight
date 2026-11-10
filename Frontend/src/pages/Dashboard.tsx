import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useApi } from "../api/useApi";
import {
  ActivityIcon,
  ArrowRightIcon,
  CameraIcon,
  ShieldIcon,
  SparkleIcon,
  UserIcon,
} from "../components/HealthIcons";
import "../styles/health.css";

type Me = { sub: string; username?: string; email?: string; roles: string[] };

// Keycloak adds these internal roles to everyone — not useful to show
const HIDDEN_ROLES = new Set(["offline_access", "uma_authorization"]);

export default function Dashboard() {
  const api = useApi();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Me>("/api/me").then(setMe).catch((e: Error) => setError(e.message));
  }, [api]);

  if (error || !me) {
    return (
      <main className="hi-page">
        <div className="hi-container">
          <div className="hi-card">{error ? <p className="hi-alert">{error}</p> : <p>Loading your dashboard…</p>}</div>
        </div>
      </main>
    );
  }

  const roles = me.roles.filter((r) => !HIDDEN_ROLES.has(r) && !r.startsWith("default-roles-"));

  return (
    <main className="hi-page">
      <div className="hi-container">
        {/* Welcome */}
        <section className="hi-card hi-hero">
          <div>
            <h1>Welcome back{me.username ? `, ${me.username}` : ""}</h1>
            <p>Check your heart rate and breathing in about a minute, using just your camera.</p>
            <Link to="/measure" className="hi-btn hi-btn-primary">
              <CameraIcon size={20} />
              Start a measurement
            </Link>
          </div>
          <HeroIllustration />
        </section>

        {/* How it works */}
        <section>
          <h2 className="hi-card-title" style={{ marginBottom: 12 }}>
            How it works
          </h2>
          <div className="hi-grid-3">
            <Step icon={<CameraIcon />} title="1. Look at the camera" text="Sit still in good light, facing the camera." />
            <Step
              icon={<ActivityIcon />}
              title="2. Get live readings"
              text="Heart rate and breathing appear and stop automatically once stable."
            />
            <Step icon={<SparkleIcon />} title="3. Get simple tips" text="Friendly wellness tips based on your readings." />
          </div>
        </section>

        <div className="hi-grid-2">
          {/* Account */}
          <section className="hi-card">
            <h2 className="hi-card-title">
              <UserIcon />
              Your account
            </h2>
            <dl className="hi-meta">
              <dt>Username</dt>
              <dd>{me.username ?? "—"}</dd>
              {me.email && (
                <>
                  <dt>Email</dt>
                  <dd>{me.email}</dd>
                </>
              )}
              <dt>Access</dt>
              <dd className="hi-chips">
                {roles.length ? roles.map((r) => <span key={r} className="hi-chip">{r}</span>) : "—"}
              </dd>
            </dl>
          </section>

          {/* Privacy */}
          <section className="hi-card">
            <h2 className="hi-card-title">
              <ShieldIcon />
              Your privacy
            </h2>
            <div className="hi-stack">
              <p className="hi-disclaimer" style={{ fontSize: 14 }}>
                Video is processed live and never stored. Only your readings are used to create tips.
              </p>
              <p className="hi-disclaimer" style={{ fontSize: 14 }}>
                Readings are wellness information, not a medical diagnosis. If you feel unwell, contact a doctor.
              </p>
              <Link to="/measure" className="hi-btn hi-btn-secondary" style={{ justifySelf: "start" }}>
                Go to measurement
                <ArrowRightIcon size={18} />
              </Link>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function Step({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="hi-card hi-step">
      <div className="hi-step-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

/** Heart with a pulse line — decorative. */
function HeroIllustration() {
  return (
    <svg className="hi-hero-art" viewBox="0 0 240 180" fill="none" aria-hidden="true">
      <circle cx="120" cy="90" r="80" fill="#e6f4f2" />
      <circle cx="120" cy="90" r="58" fill="#cdebe6" />
      <path
        transform="translate(84 52) scale(3)"
        d="M12 20.5s-7.5-4.4-9.4-9.1C1.3 8 3.4 4.5 7 4.5c2 0 3.4 1 5 2.9 1.6-1.9 3-2.9 5-2.9 3.6 0 5.7 3.5 4.4 6.9-1.9 4.7-9.4 9.1-9.4 9.1z"
        fill="#e11d48"
      />
      <path
        d="M14 96h70l10-22 14 44 12-34 8 12h98"
        stroke="#ffffff"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 96h70l10-22 14 44 12-34 8 12h98"
        stroke="#0f766e"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M44 40h12M50 34v12" stroke="#0f766e" strokeWidth="3" strokeLinecap="round" opacity="0.5" />
      <path d="M192 140h10M197 135v10" stroke="#0f766e" strokeWidth="3" strokeLinecap="round" opacity="0.4" />
    </svg>
  );
}

import { useEffect, useState } from "react";
import { useApi } from "../api/useApi";

type Me = { sub: string; username?: string; email?: string; roles: string[] };

export default function Dashboard() {
  const api = useApi();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Me>("/api/me").then(setMe).catch((e: Error) => setError(e.message));
  }, [api]);

  if (error) return <p>{error}</p>;
  if (!me) return <p>Loading…</p>;
  return (
    <main style={{ padding: 16 }}>
      <h2>Welcome {me.username}</h2>
      <p>Roles: {me.roles.join(", ")}</p>
    </main>
  );
}

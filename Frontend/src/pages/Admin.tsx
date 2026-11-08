import { useEffect, useState } from "react";
import { useApi } from "../api/useApi";

export default function Admin() {
  const api = useApi();
  const [msg, setMsg] = useState("Loading…");

  useEffect(() => {
    api<{ message: string }>("/api/admin/ping")
      .then((r) => setMsg(r.message))
      .catch((e: Error) => setMsg(e.message));
  }, [api]);

  return (
    <main style={{ padding: 16 }}>
      <h2>Admin</h2>
      <p>{msg}</p>
    </main>
  );
}

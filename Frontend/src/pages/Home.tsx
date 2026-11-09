import { Link } from "react-router";

export default function Home() {
  return (
    <main style={{ padding: 16 }}>
      <h1>Human Health Insight</h1>
      <Link to="/measure">Measure vitals</Link> · <Link to="/dashboard">Dashboard</Link> · <Link to="/admin">Admin</Link>
    </main>
  );
}

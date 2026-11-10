import { useAuth } from "react-oidc-context";

export function Header() {
  const auth = useAuth();
  return (
    <header style={{ display: "flex", justifyContent: "space-between", padding: 12, borderBottom: "1px solid #ddd" }}>
      <strong>Human Health Insight</strong>
      {auth.isAuthenticated ? (
        <span>
          {auth.user?.profile.preferred_username}{" "}
          <button onClick={() => auth.signoutRedirect()}>Logout</button>
        </span>
      ) : (
        <button onClick={() => auth.signinRedirect()}>Login</button>
      )}
    </header>
  );
}

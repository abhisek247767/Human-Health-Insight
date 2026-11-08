import { useEffect, type ReactNode } from "react";
import { useAuth, hasAuthParams } from "react-oidc-context";
import { useLocation } from "react-router";
import { getRoles } from "./roles";

export function ProtectedRoute({ children, role }: { children: ReactNode; role?: string }) {
  const auth = useAuth();
  const location = useLocation();

  useEffect(() => {
    if (!auth.isLoading && !auth.isAuthenticated && !auth.activeNavigator && !hasAuthParams()) {
      auth.signinRedirect({ redirect_uri: window.location.origin + location.pathname });
    }
  }, [auth, location.pathname]);

  if (auth.error) return <p>Login error: {auth.error.message}</p>;
  if (auth.isLoading || !auth.isAuthenticated) return <p>Loading…</p>;
  if (role && !getRoles(auth.user?.access_token).includes(role)) return <p>Not authorized</p>;

  return <>{children}</>;
}

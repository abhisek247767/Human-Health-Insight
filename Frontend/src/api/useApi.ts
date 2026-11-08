import { useCallback } from "react";
import { useAuth } from "react-oidc-context";

export function useApi() {
  const auth = useAuth();

  return useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`${import.meta.env.VITE_API_URL}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.user?.access_token}`,
      },
    });
    if (res.status === 401) {
      await auth.signinSilent().catch(() => auth.signinRedirect());
      throw new Error("Session expired, please retry");
    }
    if (res.status === 403) throw new Error("You don't have permission for this");
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  }, [auth]);
}

import { WebStorageStateStore, InMemoryWebStorage } from "oidc-client-ts";
import type { AuthProviderProps } from "react-oidc-context";

export const oidcConfig: AuthProviderProps = {
  authority: import.meta.env.VITE_KEYCLOAK_AUTHORITY,   // the realm
  client_id: import.meta.env.VITE_KEYCLOAK_CLIENT_ID,   // hhi-frontend
  redirect_uri: window.location.origin + "/",           // must match "Valid redirect URIs"
  post_logout_redirect_uri: window.location.origin + "/",
  scope: "openid profile email",
  automaticSilentRenew: true,                           // refresh the 5-min token automatically
  // keep tokens in memory only — safer than localStorage
  userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
  // remove ?code=...&state=... from the URL after login
  onSigninCallback: () =>
    window.history.replaceState({}, document.title, window.location.pathname),
};

export function getRoles(accessToken?: string): string[] {
  if (!accessToken) return [];
  const base64 = accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64)).realm_access?.roles ?? [];
}

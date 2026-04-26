const API_BASE = import.meta.env.VITE_API_BASE as string;

async function request<T>(
  path: string,
  init: RequestInit & { idToken?: string | null } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.idToken) headers.Authorization = `Bearer ${init.idToken}`;

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 204) return undefined as unknown as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const msg = (json && json.error) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}

// ----- Invites (admin) -----
export interface Invite {
  email: string;
  groups: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
}
export function listInvites(idToken: string) {
  return request<{ invites: Invite[] }>("/admin/invites", { idToken });
}
export function createInvite(
  idToken: string,
  body: { email: string; groups?: string[]; ttlDays?: number },
) {
  return request<{ email: string; expiresAt: string; groups: string[]; signupUrl: string }>(
    "/admin/invites",
    { method: "POST", idToken, body: JSON.stringify(body) },
  );
}
export function revokeInvite(idToken: string, email: string) {
  return request<void>(`/admin/invites/${encodeURIComponent(email)}`, {
    method: "DELETE",
    idToken,
  });
}

// ----- Mounts (admin) -----
export interface Mount {
  mountPath: string;
  displayName: string;
  description: string;
  /**
   * Only populated when the caller is an admin. If undefined or empty, the
   * mount is visible to every authenticated user; otherwise only listed
   * lowercase emails (plus admins) can see it.
   */
  allowedEmails?: string[];
}
export function createMount(
  idToken: string,
  body: {
    mountPath: string;
    prefix: string;
    displayName: string;
    description?: string;
    bucket?: string;
    /** Optional access control. Empty/omitted = visible to everyone. */
    allowedEmails?: string[];
  },
) {
  return request<Mount>("/admin/mounts", {
    method: "POST",
    idToken,
    body: JSON.stringify(body),
  });
}
export function deleteMount(idToken: string, mountPath: string) {
  return request<void>(`/admin/mounts/${encodeURIComponent(mountPath)}`, {
    method: "DELETE",
    idToken,
  });
}

// ----- Browse (any authenticated user) -----
export function listMounts(idToken: string) {
  return request<{ mounts: Mount[] }>("/mounts", { idToken });
}

export interface BrowseFolder { name: string; path: string; }
export interface BrowseFile { name: string; path: string; size: number; lastModified?: string; }
export function browseList(
  idToken: string,
  mountPath: string,
  subpath: string = "",
  token?: string,
) {
  const qs = new URLSearchParams();
  if (subpath) qs.set("path", subpath);
  if (token) qs.set("token", token);
  const suffix = qs.toString() ? `?${qs}` : "";
  return request<{
    mount: { mountPath: string; displayName: string };
    path: string;
    folders: BrowseFolder[];
    files: BrowseFile[];
    truncated: boolean;
    nextToken?: string;
  }>(`/browse/${encodeURIComponent(mountPath)}${suffix}`, { idToken });
}

export function getDownloadUrl(idToken: string, mountPath: string, path: string) {
  const qs = new URLSearchParams({ path });
  return request<{ downloadUrl: string; expiresInSeconds: number; filename: string }>(
    `/browse/${encodeURIComponent(mountPath)}/download-url?${qs}`,
    { idToken },
  );
}

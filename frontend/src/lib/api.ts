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
/**
 * Create an invite. Server attempts to send an email to the invitee via
 * SES (unless body.sendEmail is explicitly false). Even if the email
 * fails (e.g. SES sandbox + unverified recipient), the invite row is
 * still persisted, so the admin can fall back to copy-pasting `signupUrl`
 * to the invitee. The UI surfaces emailSent/emailError accordingly.
 */
export function createInvite(
  idToken: string,
  body: {
    email: string;
    groups?: string[];
    ttlDays?: number;
    /** Defaults to true on the server. */
    sendEmail?: boolean;
  },
) {
  return request<{
    email: string;
    expiresAt: string;
    groups: string[];
    signupUrl: string;
    emailSent: boolean;
    /** Set when emailSent is false and SES returned an error. */
    emailError?: string;
  }>(
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

// ----- Bucket explorer (admin) -----
export interface ExploreEntry { name: string; path: string; }
export interface ExploreFile extends ExploreEntry { size: number; lastModified?: string; }
export interface ExploreResult {
  bucket: string;
  prefix: string;
  folders: ExploreEntry[];
  files: ExploreFile[];
  truncated: boolean;
  nextToken?: string;
}
/**
 * Admin-only raw-bucket browser. `prefix` is a full S3 key prefix (empty = bucket
 * root); a returned folder's `path` is the full key to hand straight to
 * createMount as the mount's `prefix`.
 */
export function exploreBucket(idToken: string, prefix = "", token?: string) {
  const qs = new URLSearchParams();
  if (prefix) qs.set("prefix", prefix);
  if (token) qs.set("token", token);
  const suffix = qs.toString() ? `?${qs}` : "";
  return request<ExploreResult>(`/admin/explore${suffix}`, { idToken });
}
/** Create an empty directory at `prefix` in the shares bucket. */
export function createFolder(idToken: string, prefix: string, name: string) {
  return request<{ ok: boolean; prefix: string }>("/admin/explore/folder", {
    method: "POST",
    idToken,
    body: JSON.stringify({ prefix, name }),
  });
}

// ----- Browse (any authenticated user) -----
export function listMounts(idToken: string) {
  return request<{ mounts: Mount[] }>("/mounts", { idToken });
}

export interface BrowseFolder { name: string; path: string; }
export interface BrowseFile {
  name: string;
  path: string;
  size: number;
  lastModified?: string;
  /** Admin-only: whether this file is currently shared via a public link. */
  public?: boolean;
  /** Admin-only: the public URL (present when `public` is true). */
  publicUrl?: string;
}
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

// ----- Upload / delete (anyone with access to the mount) -----
/** Get a presigned PUT URL to upload a file to `path` (relative to the mount). */
export function getUploadUrl(idToken: string, mountPath: string, path: string) {
  const qs = new URLSearchParams({ path });
  return request<{ uploadUrl: string; expiresInSeconds: number }>(
    `/browse/${encodeURIComponent(mountPath)}/upload-url?${qs}`,
    { method: "POST", idToken },
  );
}
/** Permanently delete a file from the mount (bucket is unversioned). */
export function deleteFile(idToken: string, mountPath: string, path: string) {
  const qs = new URLSearchParams({ path });
  return request<{ ok: boolean }>(
    `/browse/${encodeURIComponent(mountPath)}/file?${qs}`,
    { method: "DELETE", idToken },
  );
}

// ----- Public file sharing (admin) -----
/** Make a file publicly downloadable; returns the stable shareable URL. */
export function setFilePublic(idToken: string, mountPath: string, path: string) {
  const qs = new URLSearchParams({ path });
  return request<{ public: boolean; token: string; publicUrl: string }>(
    `/browse/${encodeURIComponent(mountPath)}/public?${qs}`,
    { method: "POST", idToken },
  );
}
/** Revoke public sharing for a file. */
export function unsetFilePublic(idToken: string, mountPath: string, path: string) {
  const qs = new URLSearchParams({ path });
  return request<{ public: boolean }>(
    `/browse/${encodeURIComponent(mountPath)}/public?${qs}`,
    { method: "DELETE", idToken },
  );
}

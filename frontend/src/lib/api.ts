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

// ----- Access list (admin): everyone who can sign in + pending invites -----
export interface AccessEntry {
  email: string;
  role: "admin" | "member";
  status: "active" | "pending";
  expiresAt?: string;
}
export function listAccess(idToken: string) {
  return request<{ access: AccessEntry[] }>("/admin/access", { idToken });
}

// ----- Mounts (admin) -----
export interface Mount {
  mountPath: string;
  displayName: string;
  description: string;
  /**
   * Only populated when the caller is an admin. If undefined or empty, the
   * mount is admins-only; otherwise only listed lowercase emails (plus admins)
   * can see it.
   */
  allowedEmails?: string[];
  /**
   * Only populated for admins. Emails who can manage this mount's own
   * allowedEmails (add/revoke viewer access) without being full site admins
   * — see updateMountAccess.
   */
  mountAdmins?: string[];
  /** S3 prefix — admin-only; used to match a mount to an explorer directory. */
  prefix?: string;
}
/** Mount responses from create/update also report any invites auto-created for
 *  newly-granted emails that weren't invited/joined yet. */
export type MountWrite = Mount & { autoInvited?: string[] };
export function createMount(
  idToken: string,
  body: {
    mountPath: string;
    prefix: string;
    displayName: string;
    description?: string;
    bucket?: string;
    /** Optional access control. Empty/omitted = admins-only. */
    allowedEmails?: string[];
    /** Optional: emails who can manage allowedEmails without being site admins. */
    mountAdmins?: string[];
  },
) {
  return request<MountWrite>("/admin/mounts", {
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
/** Update an existing mount's access list (and optionally name/description). */
export function updateMount(
  idToken: string,
  mountPath: string,
  body: {
    allowedEmails?: string[] | null;
    mountAdmins?: string[] | null;
    displayName?: string;
    description?: string;
  },
) {
  return request<MountWrite>(`/admin/mounts/${encodeURIComponent(mountPath)}`, {
    method: "PUT",
    idToken,
    body: JSON.stringify(body),
  });
}

// ----- Mount access (mount admins -- site admins, or a mount's own mountAdmins) -----
export function getMountAccess(idToken: string, mountPath: string) {
  return request<{ allowedEmails: string[]; mountAdmins: string[] }>(
    `/browse/${encodeURIComponent(mountPath)}/access`,
    { idToken },
  );
}
export function updateMountAccess(idToken: string, mountPath: string, allowedEmails: string[] | null) {
  return request<{ allowedEmails: string[]; autoInvited: string[] }>(
    `/browse/${encodeURIComponent(mountPath)}/access`,
    { method: "PUT", idToken, body: JSON.stringify({ allowedEmails }) },
  );
}

// ----- Bucket explorer (admin) -----
export interface ExploreEntry { name: string; path: string; }
export interface ExploreFile extends ExploreEntry {
  size: number;
  lastModified?: string;
  public?: boolean;
  publicUrl?: string;
}
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
/** Permanently delete a directory (all objects under the prefix). Admin-only. */
export function deleteDirectory(idToken: string, prefix: string) {
  const qs = new URLSearchParams({ prefix });
  return request<{ deleted: number; mountsRemoved: string[] }>(
    `/admin/explore/directory?${qs}`, { method: "DELETE", idToken });
}
/** Explorer file actions, addressed by full S3 key (admin-only). */
export function exploreDownloadUrl(idToken: string, key: string, forceDownload = false) {
  const qs = new URLSearchParams({ key });
  if (forceDownload) qs.set("download", "1");
  return request<{ downloadUrl: string; filename: string }>(
    `/admin/explore/download-url?${qs}`, { idToken });
}
export function exploreDeleteFile(idToken: string, key: string) {
  const qs = new URLSearchParams({ key });
  return request<{ ok: boolean }>(`/admin/explore/file?${qs}`, { method: "DELETE", idToken });
}
export function exploreSetPublic(idToken: string, key: string) {
  const qs = new URLSearchParams({ key });
  return request<{ public: boolean; token: string; publicUrl: string }>(
    `/admin/explore/public?${qs}`, { method: "POST", idToken });
}
export function exploreUnsetPublic(idToken: string, key: string) {
  const qs = new URLSearchParams({ key });
  return request<{ public: boolean }>(`/admin/explore/public?${qs}`, { method: "DELETE", idToken });
}

// ----- Public backend discovery (unauthenticated) -----
export interface PublicConfig {
  name?: string;
  cognitoDomain?: string;
  cognitoClientId?: string;
  googleEnabled: boolean;
  facebookEnabled: boolean;
}
/** Which sign-in providers this deployment actually has configured -- used to hide Login's Google/Facebook buttons when they'd otherwise dead-end at a Cognito error. */
export function getPublicConfig() {
  return request<PublicConfig>("/config");
}

// ----- Browse (any authenticated user) -----
export function listMounts(idToken: string) {
  return request<{ mounts: Mount[] }>("/mounts", { idToken });
}

// ----- Global file search (any authenticated user) -----
export interface SearchResult {
  mountPath: string;
  mountName: string;
  name: string;
  path: string;
  size: number;
  lastModified?: string;
}
export function searchFiles(idToken: string, q: string) {
  const qs = new URLSearchParams({ q });
  return request<{ query: string; results: SearchResult[]; truncated: boolean }>(
    `/search?${qs}`, { idToken });
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
    mount: { mountPath: string; displayName: string; canManageAccess: boolean };
    path: string;
    folders: BrowseFolder[];
    files: BrowseFile[];
    truncated: boolean;
    nextToken?: string;
  }>(`/browse/${encodeURIComponent(mountPath)}${suffix}`, { idToken });
}

/** `forceDownload` signs a Content-Disposition: attachment header so the
 *  browser saves the file instead of opening it inline -- use it for the
 *  explicit Download action; leave it off for thumbnail/preview loading. */
export function getDownloadUrl(idToken: string, mountPath: string, path: string, forceDownload = false) {
  const qs = new URLSearchParams({ path });
  if (forceDownload) qs.set("download", "1");
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

// ----- Personal archive (self-service, no mount -- Share Extension target on
// mobile, but readable from anywhere since it's just user_sharing_default/<email>/
// under the shares bucket like anything else) -----
export interface ArchiveFile {
  name: string; key: string; size: number; lastModified?: string;
  public?: boolean; publicUrl?: string;
}
export function listArchive(idToken: string, token?: string) {
  const qs = token ? `?${new URLSearchParams({ token })}` : "";
  return request<{ files: ArchiveFile[]; truncated: boolean; nextToken?: string }>(
    `/archive/list${qs}`,
    { idToken },
  );
}
/** Get a presigned PUT URL to upload a file into the caller's own personal folder. */
export function getArchiveUploadUrl(idToken: string, filename: string) {
  const qs = new URLSearchParams({ filename });
  return request<{ uploadUrl: string; key: string; expiresInSeconds: number }>(
    `/archive/upload-url?${qs}`,
    { method: "POST", idToken },
  );
}
export function getArchiveDownloadUrl(idToken: string, key: string, forceDownload = false) {
  const qs = new URLSearchParams({ key });
  if (forceDownload) qs.set("download", "1");
  return request<{ downloadUrl: string; expiresInSeconds: number; filename: string }>(
    `/archive/download-url?${qs}`,
    { method: "POST", idToken },
  );
}
/** Permanently delete a file from the caller's own personal folder. */
export function deleteArchiveFile(idToken: string, key: string) {
  const qs = new URLSearchParams({ key });
  return request<{ ok: boolean }>(
    `/archive/file?${qs}`,
    { method: "DELETE", idToken },
  );
}
/** Publish an archived item and get back a shareable link (same token mechanism as setFilePublic below). */
export function setArchivePublic(idToken: string, key: string) {
  const qs = new URLSearchParams({ key });
  return request<{ token: string; publicUrl: string }>(
    `/archive/public?${qs}`,
    { method: "POST", idToken },
  );
}
/** Revoke public sharing for an archived item. */
export function unsetArchivePublic(idToken: string, key: string) {
  const qs = new URLSearchParams({ key });
  return request<{ public: boolean }>(
    `/archive/public?${qs}`,
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

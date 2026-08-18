import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, MOUNTS_TABLE, MountRow } from "./db";
import type { CallerIdentity } from "./auth";

const VALID_PATH = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Normalize a mount path: strip leading/trailing slashes, lowercase. */
export function normalizeMountPath(input: string): string {
  return String(input || "").replace(/^\/+|\/+$/g, "").toLowerCase();
}

export function isValidMountPath(mountPath: string): boolean {
  return VALID_PATH.test(mountPath);
}

/** Normalize a prefix: strip leading slashes, ensure trailing slash (unless empty). */
export function normalizePrefix(input: string): string {
  const trimmed = String(input || "").replace(/^\/+/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed : trimmed + "/";
}

/**
 * Reserved top-level prefix for personal storage: per-user content (synced/
 * converted from elsewhere) lives at `user_sharing_default/<email>/...`. The
 * bare top-level prefix can't be mounted directly -- that would put every
 * user's personal folder behind one shared view. Per-user subfolders
 * underneath it are ordinary, mountable content.
 */
export const RESERVED_PERSONAL_PREFIX = "user_sharing_default/";

/** True if `prefix` (after normalization) is exactly the reserved top-level personal-storage prefix. */
export function isReservedTopLevelPrefix(prefix: string): boolean {
  return normalizePrefix(prefix) === RESERVED_PERSONAL_PREFIX;
}

/**
 * Guard against traversal. The caller supplies a subpath they want to browse
 * within the mount; we reject anything that tries to escape the mount's prefix.
 */
export function safeSubpath(subpath: string): string {
  const s = String(subpath || "").replace(/^\/+/, "");
  if (!s) return "";
  if (s.includes("..") || s.includes("\\")) {
    throw new Error("Invalid path");
  }
  return s.endsWith("/") ? s : s + "/";
}

export async function getMount(mountPath: string): Promise<MountRow | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: MOUNTS_TABLE, Key: { mountPath } }),
  );
  return (res.Item as MountRow | undefined) ?? null;
}

/**
 * Returns true if the given caller is allowed to see / browse this mount.
 *
 * Rules:
 *   - Admins always see everything.
 *   - If the mount has no `allowedEmails` (undefined or empty), it is
 *     restricted to admins only.
 *   - Otherwise, only callers whose email (lowercased) appears in the list
 *     are allowed.
 */
export function canSeeMount(caller: CallerIdentity, mount: MountRow): boolean {
  if (caller.isAdmin) return true;
  if (!mount.allowedEmails || mount.allowedEmails.length === 0) return false;
  if (!caller.email) return false;
  return mount.allowedEmails.includes(caller.email.toLowerCase());
}

/**
 * Normalize a user-supplied list of allowed emails:
 *   - coerce to string, trim, lowercase
 *   - drop empties
 *   - dedupe while preserving order
 *   - return undefined if the resulting list is empty (so the column is
 *     omitted from DynamoDB rather than stored as `[]`)
 */
export function normalizeAllowedEmails(input: unknown): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  const arr = Array.isArray(input) ? input : [];
  const cleaned = arr
    .map((s) => String(s ?? "").trim().toLowerCase())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const e of cleaned) {
    if (!seen.has(e)) {
      seen.add(e);
      deduped.push(e);
    }
  }
  return deduped.length > 0 ? deduped : undefined;
}

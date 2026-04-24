import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, MOUNTS_TABLE, MountRow } from "./db";

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

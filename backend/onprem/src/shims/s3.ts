// Replaces src/lib/s3.ts. Objects are ordinary files under CONTENT_ROOT, and
// presigned URLs are HMAC-signed links to /files, served by files.ts. Same
// exports and same behaviour as the S3 version as far as the handlers can tell.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, sep } from "node:path";
import { config } from "../config";

export interface S3Object { key: string; size: number; lastModified?: string; }

export interface S3ListResult {
  folders: string[];
  files: { key: string; size: number; lastModified?: string }[];
  truncated: boolean;
  nextContinuationToken?: string;
}

/** Scratch space for uploads. Must share a filesystem with the content so rename is atomic. */
export const TMP_DIR = ".backfriend-tmp";

export class InvalidKeyError extends Error {
  statusCode = 400;
}

function assertBucket(bucket: string): void {
  const expected = process.env.SHARES_BUCKET;
  if (!expected || bucket !== expected) throw new InvalidKeyError(`Unknown bucket: ${bucket}`);
}

/**
 * Maps an object key to a path inside CONTENT_ROOT, or throws. Handlers already
 * reject "..", but this is the last line of defence, so it checks every key
 * itself. The S3 version gets the same guarantee from S3 having no real paths.
 */
export function keyToPath(key: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(key) || key.includes("\\") || key.startsWith("/")) throw new InvalidKeyError("Invalid key");
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  const segments = trimmed === "" ? [] : trimmed.split("/");
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") throw new InvalidKeyError("Invalid key");
  }
  if (segments[0] === TMP_DIR) throw new InvalidKeyError("Invalid key");
  return join(config().contentRoot, ...segments);
}

/**
 * Symlinks on the share could point outside it, so the nearest existing parent
 * has to resolve to somewhere inside CONTENT_ROOT.
 */
export async function assertInsideRoot(path: string): Promise<void> {
  const root = await fs.realpath(config().contentRoot);
  let probe = path;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (real !== root && !real.startsWith(root + sep)) throw new InvalidKeyError("Invalid key");
      return;
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      const parent = dirname(probe);
      if (parent === probe) throw e;
      probe = parent;
    }
  }
}

async function readDir(path: string) {
  try {
    const entries = await fs.readdir(path, { withFileTypes: true });
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (e: any) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return [];
    throw e;
  }
}

async function walk(prefix: string, visit: (key: string, path: string, isDir: boolean) => Promise<void>): Promise<void> {
  const dir = keyToPath(prefix);
  await assertInsideRoot(dir);
  for (const entry of await readDir(dir)) {
    if (prefix === "" && entry.name === TMP_DIR) continue;
    // Symlinks are skipped, never followed.
    if (entry.isDirectory()) {
      const child = `${prefix}${entry.name}/`;
      await visit(child, join(dir, entry.name), true);
      await walk(child, visit);
    } else if (entry.isFile()) {
      await visit(`${prefix}${entry.name}`, join(dir, entry.name), false);
    }
  }
}

export async function listAllObjects(bucket: string, prefix: string): Promise<S3Object[]> {
  assertBucket(bucket);
  const out: S3Object[] = [];
  await walk(prefix, async (key, path, isDir) => {
    if (isDir) return;
    const st = await fs.stat(path);
    out.push({ key, size: st.size, lastModified: st.mtime.toISOString() });
  });
  return out;
}

export async function listAllKeys(bucket: string, prefix: string): Promise<string[]> {
  assertBucket(bucket);
  const keys: string[] = [];
  await walk(prefix, async (key) => { keys.push(key); });
  // Removes the empty directory too, the same way deleting a folder marker does in S3.
  if (prefix) {
    try {
      if ((await fs.stat(keyToPath(prefix))).isDirectory()) keys.push(prefix);
    } catch { /* nothing there */ }
  }
  return keys;
}

export async function deleteObjects(bucket: string, keys: string[]): Promise<number> {
  assertBucket(bucket);
  let deleted = 0;
  // Deepest first so each directory is empty by the time it's removed.
  for (const key of [...keys].sort((a, b) => b.split("/").length - a.split("/").length || b.length - a.length)) {
    const path = keyToPath(key);
    await assertInsideRoot(path);
    try {
      if (key.endsWith("/")) await fs.rmdir(path);
      else await fs.unlink(path);
      deleted++;
    } catch (e: any) {
      if (e.code !== "ENOENT") console.error(JSON.stringify({ evt: "delete-failed", key, code: e.code }));
    }
  }
  return deleted;
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  assertBucket(bucket);
  const path = keyToPath(key);
  await assertInsideRoot(path);
  await fs.unlink(path).catch((e) => { if (e.code !== "ENOENT") throw e; });
}

export async function putFolderMarker(bucket: string, key: string): Promise<void> {
  assertBucket(bucket);
  const path = keyToPath(key);
  await assertInsideRoot(path);
  await fs.mkdir(path, { recursive: true });
}

export async function listDir(bucket: string, prefix: string, continuationToken?: string, maxKeys = 1000): Promise<S3ListResult> {
  assertBucket(bucket);
  const dir = keyToPath(prefix);
  await assertInsideRoot(dir);
  const entries = (await readDir(dir)).filter((e) => !(prefix === "" && e.name === TMP_DIR) && (e.isDirectory() || e.isFile()));
  const start = continuationToken ? Math.max(0, Number(continuationToken) || 0) : 0;
  const page = entries.slice(start, start + maxKeys);
  const folders: string[] = [];
  const files: S3ListResult["files"] = [];
  for (const e of page) {
    if (e.isDirectory()) {
      folders.push(`${prefix}${e.name}/`);
    } else {
      const st = await fs.stat(join(dir, e.name));
      files.push({ key: `${prefix}${e.name}`, size: st.size, lastModified: st.mtime.toISOString() });
    }
  }
  const truncated = start + maxKeys < entries.length;
  return { folders, files, truncated, nextContinuationToken: truncated ? String(start + maxKeys) : undefined };
}

// ----- Signed URLs -----

function b64(s: string): string {
  return Buffer.from(s).toString("base64url");
}

function signature(method: string, key: string, exp: number, filename: string): string {
  return createHmac("sha256", config().fileSigningKey)
    // JSON, so one field's contents can never be read as the next field.
    .update(JSON.stringify([method, key, exp, filename]))
    .digest("base64url");
}

function signedUrl(method: "GET" | "PUT", key: string, expiresInSeconds: number, filename = ""): string {
  keyToPath(key);
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const params = new URLSearchParams({ exp: String(exp), sig: signature(method, key, exp, filename) });
  if (filename) params.set("filename", filename);
  return `${config().siteOrigin}/files/${b64(key)}?${params}`;
}

export async function presignPut(bucket: string, key: string, expiresInSeconds = 3600): Promise<string> {
  assertBucket(bucket);
  return signedUrl("PUT", key, expiresInSeconds);
}

export async function presignGet(bucket: string, key: string, expiresInSeconds = 300, downloadFilename?: string): Promise<string> {
  assertBucket(bucket);
  return signedUrl("GET", key, expiresInSeconds, downloadFilename?.replace(/["\r\n]/g, "") ?? "");
}

/** Returns the key if the URL's signature is valid for this method and hasn't expired. */
export function verifySignedUrl(method: string, encodedKey: string, params: URLSearchParams): string | null {
  const signedMethod = method === "HEAD" ? "GET" : method;
  const exp = Number(params.get("exp"));
  const sig = params.get("sig") ?? "";
  const filename = params.get("filename") ?? "";
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return null;
  const key = Buffer.from(encodedKey, "base64url").toString();
  const expected = Buffer.from(signature(signedMethod, key, exp, filename));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return key;
}

export function newTempPath(): string {
  return join(config().contentRoot, TMP_DIR, randomUUID());
}

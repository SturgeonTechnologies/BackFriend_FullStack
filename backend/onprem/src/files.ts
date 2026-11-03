// Serves /files/*: the on-prem stand-in for S3 presigned URLs. Possession of a
// valid signature is the authorization; the API checked access before signing.
import { constants, createReadStream, createWriteStream, promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "./config";
import { assertInsideRoot, keyToPath, newTempPath, verifySignedUrl } from "./shims/s3";

// Files are served from the app's own origin, where the sign-in tokens live, so
// uploaded content must not be able to run as the app. S3 avoids this by being a
// different origin. Only these types render inline; everything else downloads,
// and all of it is sandboxed by CSP.
const INLINE_TYPES: Record<string, string> = {
  ".avif": "image/avif", ".bmp": "image/bmp", ".gif": "image/gif", ".heic": "image/heic",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".aac": "audio/aac", ".flac": "audio/flac", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/opus", ".wav": "audio/wav",
  ".m4v": "video/mp4", ".mkv": "video/x-matroska", ".mov": "video/quicktime", ".mp4": "video/mp4", ".webm": "video/webm",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8",
};

function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(message);
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return "invalid";
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start > end || start >= size ? "invalid" : { start, end };
}

async function serveGet(req: IncomingMessage, res: ServerResponse, path: string, filename: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return reject(res, 404, "Not found");
  }
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    return reject(res, 404, "Not found");
  }

  const inlineType = INLINE_TYPES[extname(path).toLowerCase()];
  const attachmentName = filename || (inlineType ? "" : path.split("/").pop()!);
  const headers: Record<string, string | number> = {
    "Content-Type": inlineType ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Last-Modified": stat.mtime.toUTCString(),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    // Chrome's and Firefox's PDF viewers don't run inside a CSP sandbox.
    "Content-Security-Policy": inlineType === "application/pdf" ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; object-src 'self'; frame-ancestors 'self'" : "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; frame-ancestors 'self'",
    // The app previews PDFs and text in an iframe of its own origin. Everywhere else it's DENY.
    "X-Frame-Options": "SAMEORIGIN",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (attachmentName) {
    const safe = attachmentName.replace(/[^\x20-\x7e]|["\\]/g, "_");
    headers["Content-Disposition"] = `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(attachmentName)}`;
  }

  const range = parseRange(req.headers.range, stat.size);
  if (range === "invalid") {
    await handle.close();
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    return void res.end();
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  headers["Content-Length"] = stat.size === 0 ? 0 : end - start + 1;
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(range ? 206 : 200, headers);

  if (req.method === "HEAD" || stat.size === 0) {
    await handle.close();
    return void res.end();
  }
  await pipeline(createReadStream("", { fd: handle.fd, autoClose: false, start, end }), res).catch(() => { res.destroy(); });
  await handle.close();
}

async function servePut(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const max = config().maxUploadBytes;
  if (Number(req.headers["content-length"] ?? 0) > max) return reject(res, 413, "File too large");

  const existing = await fs.lstat(path).catch(() => null);
  if (existing && !existing.isFile()) return reject(res, 400, "Invalid key");

  const temp = newTempPath();
  await fs.mkdir(dirname(temp), { recursive: true });
  let received = 0;
  const out = createWriteStream(temp, { flags: "wx" });
  try {
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > max) req.destroy(new Error("too-large"));
    });
    await pipeline(req, out);
    await fs.mkdir(dirname(path), { recursive: true });
    await assertInsideRoot(dirname(path));
    await fs.rename(temp, path);
    res.writeHead(200, { "Cache-Control": "no-store" });
    res.end();
  } catch (e: any) {
    await fs.unlink(temp).catch(() => {});
    if (e?.statusCode === 400) return reject(res, 400, "Invalid key");
    if (received > max) return reject(res, 413, "File too large");
    if (!res.headersSent) reject(res, 500, "Upload failed");
    else res.destroy();
  }
}

export async function handleFile(req: IncomingMessage, res: ServerResponse, encodedKey: string, params: URLSearchParams): Promise<string | null> {
  const method = req.method ?? "";
  if (!["GET", "HEAD", "PUT"].includes(method)) {
    reject(res, 405, "Method not allowed");
    return null;
  }
  const key = verifySignedUrl(method, encodedKey, params);
  if (!key) {
    reject(res, 403, "This link is invalid or has expired.");
    return null;
  }
  if (key.endsWith("/")) {
    reject(res, 400, "Invalid key");
    return null;
  }
  let path: string;
  try {
    path = keyToPath(key);
    await assertInsideRoot(path);
  } catch {
    reject(res, 400, "Invalid key");
    return null;
  }
  if (method === "PUT") await servePut(req, res, path);
  else await serveGet(req, res, path, params.get("filename") ?? "");
  return key;
}

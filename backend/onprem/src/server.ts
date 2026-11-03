import { createReadStream, promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { authorize, Denied, verifyToken } from "./authz";
import { config } from "./config";
import { handleFile } from "./files";
import { closeDb, db, migrate, purgeExpired } from "./pg";
import { matchRoute } from "./routes";

const MAX_JSON_BYTES = 1024 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
};

const SPA_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
};

function clientIp(req: IncomingMessage): string {
  const hops = config().trustedProxyHops;
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // The right-most entries were added by proxies we run; anything further left is client-supplied.
  return hops > 0 && forwarded.length >= hops ? forwarded[forwarded.length - hops] : req.socket.remoteAddress ?? "unknown";
}

// Public share links are guessable only in theory (128-bit tokens); this just
// stops one address hammering the resolver. Per-replica, which is fine at one replica.
const buckets = new Map<string, { count: number; resetAt: number }>();
function overLimit(ip: string, perMinute: number): boolean {
  const now = Date.now();
  if (buckets.size > 10000) for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  const b = buckets.get(ip);
  if (!b || b.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  b.count++;
  return b.count > perMinute;
}

function audit(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BYTES) throw new Denied(413, "Request too large", "body-too-large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? Buffer.concat(chunks).toString() : undefined;
}

function publicConfig() {
  const c = config();
  return {
    name: c.appName,
    apiBaseUrl: `${c.siteOrigin}/api`,
    authType: "oidc",
    oidcIssuer: c.oidcIssuer,
    oidcClientId: c.oidcClientIds[0],
    googleEnabled: c.googleEnabled,
    facebookEnabled: c.facebookEnabled,
  };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
  const method = req.method ?? "GET";
  const started = Date.now();
  const log: Record<string, unknown> = { evt: "api", method, path, ip: clientIp(req) };

  try {
    if (method === "GET" && path === "/config") return json(res, 200, publicConfig());

    if (method === "GET" && path === "/me") {
      const caller = await authorize(await verifyToken(req.headers.authorization));
      log.user = caller.email;
      log.status = 200;
      return json(res, 200, { email: caller.email, name: caller.claims.name ?? null, groups: caller.groups, isAdmin: caller.isAdmin });
    }

    const match = matchRoute(method, path);
    if (!match) {
      log.status = 404;
      return json(res, 404, { error: "Not found" });
    }

    let claims: Record<string, unknown> = {};
    if (match.route.public) {
      if (overLimit(clientIp(req), 120)) {
        log.status = 429;
        return json(res, 429, { error: "Too many requests" });
      }
    } else {
      const caller = await authorize(await verifyToken(req.headers.authorization));
      log.user = caller.email;
      claims = caller.claims;
    }

    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;

    const result = await match.route.handler({
      version: "2.0",
      routeKey: `${method} ${match.route.path}`,
      rawPath: path,
      rawQueryString: url.search.slice(1),
      headers: req.headers,
      pathParameters: match.params,
      queryStringParameters: query,
      body: await readBody(req),
      isBase64Encoded: false,
      requestContext: { http: { method, path }, authorizer: { jwt: { claims, scopes: [] } } },
    });

    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    for (const [k, v] of Object.entries(result.headers ?? {})) {
      // Everything is same-origin here, so the handlers' permissive CORS headers are dropped.
      if (!k.toLowerCase().startsWith("access-control-")) headers[k] = String(v);
    }
    log.status = result.statusCode;
    res.writeHead(result.statusCode, headers);
    res.end(result.body ?? "");
  } catch (e) {
    if (e instanceof Denied) {
      log.status = e.statusCode;
      log.denied = e.reason;
      if (!res.headersSent) json(res, e.statusCode, { error: e.message });
      return;
    }
    log.status = 500;
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "Internal error" });
  } finally {
    log.ms = Date.now() - started;
    audit(log);
  }
}

async function handleStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const root = config().staticRoot;
  if (!root || !["GET", "HEAD"].includes(req.method ?? "")) return json(res, 404, { error: "Not found" });

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return json(res, 400, { error: "Bad request" });
  }
  const file = normalize(join(root, decoded));
  let target = file.startsWith(root + sep) ? file : join(root, "index.html");
  const isFile = await fs.stat(target).then((s) => s.isFile()).catch(() => false);
  // Client-side routes fall back to the app, but a missing asset is a real 404.
  if (!isFile) {
    if (extname(path)) return json(res, 404, { error: "Not found" });
    target = join(root, "index.html");
  }

  const isHtml = target.endsWith(".html");
  res.writeHead(200, {
    "Content-Type": STATIC_TYPES[extname(target)] ?? "application/octet-stream",
    "Content-Security-Policy": SPA_CSP,
    "Cache-Control": isHtml ? "no-cache" : target.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "public, max-age=3600",
  });
  if (req.method === "HEAD") return void res.end();
  createReadStream(target).on("error", () => res.destroy()).pipe(res);
}

export async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url ?? "/", "http://internal");
  const path = url.pathname;

  try {
    if (path === "/healthz") return json(res, 200, { ok: true });
    if (path === "/readyz") {
      await db().query("SELECT 1");
      await fs.access(config().contentRoot);
      return json(res, 200, { ok: true });
    }

    if (path.startsWith("/files/")) {
      const key = await handleFile(req, res, path.slice("/files/".length), url.searchParams);
      if (key) audit({ evt: "file", method: req.method, key, status: res.statusCode, ip: clientIp(req) });
      return;
    }
    if (path === "/api" || path.startsWith("/api/")) return await handleApi(req, res, path.slice(4) || "/", url);
    // Same two paths the cloud's CloudFront distribution passes through at the top level.
    if (path === "/config" || path.startsWith("/public/")) return await handleApi(req, res, path, url);
    // The proxy only forwards the realm's own paths to the identity provider. Anything
    // else under /idp (the admin console, the master realm) stops here.
    if (path === "/idp" || path.startsWith("/idp/")) return json(res, 404, { error: "Not found" });
    return await handleStatic(req, res, path);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, path === "/readyz" ? 503 : 500, { error: "Internal error" });
    else res.destroy();
  }
}

export function startServer(port = config().port): Server {
  // Node rejects a request whose headers take longer than headersTimeout. Body time is unlimited (below).
  const server = createServer((req, res) => void onRequest(req, res));
  // Large uploads and video streams can run far longer than Node's default request timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return server.listen(port);
}

const isMain = process.argv[1]?.endsWith("server.mjs");
if (isMain) {
  config();
  await migrate();
  const server = startServer();
  const purge = setInterval(() => purgeExpired().catch((e) => console.error(e)), 3_600_000);
  audit({ evt: "started", port: config().port });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      clearInterval(purge);
      server.close(() => void closeDb().then(() => process.exit(0)));
      setTimeout(() => process.exit(0), 10_000).unref();
    });
  }
}

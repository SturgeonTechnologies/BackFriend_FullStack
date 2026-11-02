// A real Postgres and a real signed JWT, with only the identity provider faked.
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

export const ISSUER = "https://sso.test/idp/realms/backfriend";
export const CLIENT_ID = "backfriend-web";
export const ORIGIN = "https://sharing.test";

// The embedded-postgres package's own wrapper forces an en_US locale that minimal
// machines don't have, so only its binaries are used.
async function startPostgres(dir: string, port: number): Promise<() => Promise<void>> {
  const bin = join(process.cwd(), "node_modules/@embedded-postgres", `${process.platform}-${process.arch}`, "native/bin");
  const pwfile = join(dir, "..", `pw-${port}`);
  writeFileSync(pwfile, "pw");
  execFileSync(join(bin, "initdb"), ["-D", dir, "-U", "postgres", `--pwfile=${pwfile}`, "-A", "password", "--locale=C", "-E", "UTF8"], { stdio: "ignore" });
  rmSync(pwfile);
  const proc = spawn(join(bin, "postgres"), ["-D", dir, "-p", String(port), "-k", dir, "-h", "127.0.0.1"], { stdio: "ignore" });
  for (let i = 0; ; i++) {
    try {
      const c = new pg.Client({ connectionString: `postgres://postgres:pw@127.0.0.1:${port}/postgres` });
      await c.connect();
      await c.query("CREATE DATABASE app");
      await c.end();
      break;
    } catch (e) {
      if (i > 100) throw e;
      await new Promise((ok) => setTimeout(ok, 100));
    }
  }
  return () => new Promise((ok) => { proc.once("exit", () => ok()); proc.kill("SIGINT"); });
}

export interface Harness {
  base: string;
  contentRoot: string;
  token: (claims: Record<string, unknown>, opts?: TokenOpts) => Promise<string>;
  stop: () => Promise<void>;
}
interface TokenOpts { issuer?: string; audience?: string; expiresIn?: string; key?: unknown; alg?: string }

export async function startHarness(pgPort: number, adminEmail = "boss@example.com"): Promise<Harness> {
  const pgDir = mkdtempSync(join(tmpdir(), "bf-pg-"));
  const contentRoot = mkdtempSync(join(tmpdir(), "bf-content-"));
  const stopPg = await startPostgres(pgDir, pgPort);

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const jwksServer: Server = createServer((_q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((ok) => jwksServer.listen(0, "127.0.0.1", ok));
  const jwksPort = (jwksServer.address() as any).port;

  Object.assign(process.env, {
    SITE_ORIGIN: ORIGIN,
    DATABASE_URL: `postgres://postgres:pw@127.0.0.1:${pgPort}/app`,
    CONTENT_ROOT: contentRoot,
    FILE_SIGNING_KEY: "x".repeat(40),
    OIDC_ISSUER: ISSUER,
    OIDC_JWKS_URL: `http://127.0.0.1:${jwksPort}/certs`,
    OIDC_CLIENT_IDS: CLIENT_ID,
    BOOTSTRAP_ADMIN_EMAILS: adminEmail,
    SHARES_BUCKET: "content",
    TRUSTED_PROXY_HOPS: "1",
  });
  const { migrate, closeDb } = await import("../src/pg");
  const { startServer } = await import("../src/server");
  await migrate();
  const server = startServer(0);
  await new Promise((ok) => server.once("listening", ok));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  return {
    base,
    contentRoot,
    token: (claims, opts = {}) =>
      new SignJWT({ email_verified: true, ...claims })
        .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: "k1" })
        .setIssuer(opts.issuer ?? ISSUER)
        .setAudience(opts.audience ?? CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime(opts.expiresIn ?? "5m")
        .sign((opts.key ?? privateKey) as any),
    stop: async () => {
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
      jwksServer.closeAllConnections();
      await new Promise((ok) => jwksServer.close(ok));
      await closeDb();
      await stopPg();
      rmSync(pgDir, { recursive: true, force: true });
      rmSync(contentRoot, { recursive: true, force: true });
    },
  };
}
export async function otherKey() { return (await generateKeyPair("RS256")).privateKey; }

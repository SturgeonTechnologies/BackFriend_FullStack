import { strict as assert } from "node:assert";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CLIENT_ID, ISSUER, otherKey, startHarness, type Harness } from "./helpers";

let h: Harness;
const ADMIN = { sub: "s-admin", email: "boss@example.com" };
let adminToken: string;

async function api(path: string, token?: string, init: RequestInit = {}) {
  const res = await fetch(`${h.base}/api${path}`, { ...init, redirect: "manual", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, headers: res.headers };
}
const post = (path: string, token: string, body: unknown, method = "POST") =>
  api(path, token, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const toLocal = (url: string) => { const u = new URL(url); return `${h.base}${u.pathname}${u.search}`; };

async function invited(email: string, sub: string): Promise<string> {
  const res = await post("/admin/invites", adminToken, { email, sendEmail: false });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const token = await h.token({ sub, email });
  assert.equal((await api("/me", token)).status, 200);
  return token;
}

before(async () => {
  h = await startHarness(55433);
  adminToken = await h.token(ADMIN);
  mkdirSync(join(h.contentRoot, "movies"));
  writeFileSync(join(h.contentRoot, "movies", "a.txt"), "0123456789");
  writeFileSync(join(h.contentRoot, "movies", "evil.html"), "<script>alert(1)</script>");
  writeFileSync(join(h.contentRoot, "secret.txt"), "top secret");
  assert.equal((await post("/admin/mounts", adminToken, { mountPath: "movies", prefix: "movies/", displayName: "Movies" })).status, 201);
});
after(async () => { await h.stop(); });

// ----- Tokens -----

test("no token, garbage token and every kind of bad JWT get 401", async () => {
  assert.equal((await api("/mounts")).status, 401);
  assert.equal((await api("/mounts", "garbage")).status, 401);
  assert.equal((await api("/mounts", await h.token(ADMIN, { issuer: "https://evil.test/" }))).status, 401);
  assert.equal((await api("/mounts", await h.token(ADMIN, { audience: "another-app" }))).status, 401);
  assert.equal((await api("/mounts", await h.token(ADMIN, { expiresIn: "-1m" }))).status, 401);
  assert.equal((await api("/mounts", await h.token(ADMIN, { key: await otherKey() }))).status, 401);
  void CLIENT_ID; void ISSUER;
});

test("an alg:none token is refused", async () => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const forged = `${b({ alg: "none" })}.${b({ ...ADMIN, iss: ISSUER, aud: CLIENT_ID, email_verified: true, exp: 9999999999, iat: 1 })}.`;
  assert.equal((await api("/mounts", forged)).status, 401);
});

// ----- Who gets in -----

test("an uninvited person with a valid token gets 403 everywhere", async () => {
  const t = await h.token({ sub: "s-stranger", email: "stranger@example.com" });
  assert.equal((await api("/me", t)).status, 403);
  assert.equal((await api("/mounts", t)).status, 403);
});

test("an unverified email can't claim a bootstrap admin address or an invite", async () => {
  const t = await h.token({ sub: "s-fake-admin", email: ADMIN.email, email_verified: false });
  assert.equal((await api("/me", t)).status, 403);
  await post("/admin/invites", adminToken, { email: "unverified@example.com", sendEmail: false });
  const u = await h.token({ sub: "s-u", email: "unverified@example.com", email_verified: false });
  assert.equal((await api("/me", u)).status, 403);
});

test("groups in the token are ignored", async () => {
  const t = await invited("sneaky@example.com", "s-sneaky");
  const forged = await h.token({ sub: "s-sneaky", email: "sneaky@example.com", groups: ["admins"], "cognito:groups": ["admins"] });
  assert.equal((await api("/admin/invites", forged)).status, 403);
  assert.equal((await api("/me", t)).body.isAdmin, false);
});

test("the bootstrap admin gets in, and an invite is single-use across identities", async () => {
  const me = await api("/me", adminToken);
  assert.equal(me.status, 200);
  assert.equal(me.body.isAdmin, true);
  await invited("once@example.com", "s-once");
  const second = await h.token({ sub: "s-once-other-idp", email: "once@example.com" });
  assert.equal((await api("/me", second)).status, 403);
});

test("a changed email is refused rather than inheriting access", async () => {
  await invited("old@example.com", "s-moved");
  const t = await h.token({ sub: "s-moved", email: "new@example.com" });
  assert.equal((await api("/me", t)).status, 403);
});

test("disabling a user applies to their current token immediately", async () => {
  const t = await invited("gone@example.com", "s-gone");
  assert.equal((await api("/me", t)).status, 200);
  const { db } = await import("../src/pg");
  await db().query("UPDATE users SET enabled = false WHERE sub = 's-gone'");
  assert.equal((await api("/me", t)).status, 403);
  assert.equal((await api("/mounts", t)).status, 403);
});

// ----- What they can do -----

test("a member can't reach any admin route", async () => {
  const t = await invited("member@example.com", "s-member");
  for (const [m, p] of [["GET", "/admin/invites"], ["GET", "/admin/access"], ["GET", "/admin/explore"], ["POST", "/admin/mounts"], ["DELETE", "/admin/invites/x"], ["DELETE", "/admin/explore/file?key=secret.txt"]]) {
    assert.equal((await api(p, t, { method: m, body: m === "POST" ? "{}" : undefined })).status, 403, `${m} ${p}`);
  }
});

test("mount access: not listed can't see or sign, listed can, removal is immediate", async () => {
  const t = await invited("viewer@example.com", "s-viewer");
  assert.deepEqual((await api("/mounts", t)).body.mounts ?? [], []);
  assert.equal((await api("/browse/movies", t)).status, 403);
  assert.equal((await api("/browse/movies/download-url?path=a.txt", t)).status, 403);

  assert.equal((await post("/admin/mounts/movies", adminToken, { displayName: "Movies", allowedEmails: ["viewer@example.com"] }, "PUT")).status, 200);
  assert.equal((await api("/browse/movies", t)).status, 200);
  assert.equal((await api("/browse/movies/download-url?path=a.txt", t)).status, 200);

  assert.equal((await post("/admin/mounts/movies", adminToken, { displayName: "Movies", allowedEmails: [] }, "PUT")).status, 200);
  assert.equal((await api("/browse/movies", t)).status, 403);
});

test("a mount can't be escaped with ..", async () => {
  const res = await api("/browse/movies/download-url?path=../secret.txt", adminToken);
  assert.notEqual(res.status, 200);
});

// ----- Signed file links -----

async function signedGet(path: string) {
  const res = await api(`/browse/movies/download-url?path=${encodeURIComponent(path)}`, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return toLocal(res.body.downloadUrl ?? res.body.url);
}

test("a signed link downloads, supports ranges, and is confined by its signature", async () => {
  const url = await signedGet("a.txt");
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(await full.text(), "0123456789");
  const part = await fetch(url, { headers: { Range: "bytes=2-4" } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), "234");

  const u = new URL(url);
  const sig = u.searchParams.get("sig")!;
  u.searchParams.set("sig", (sig[0] === "A" ? "B" : "A") + sig.slice(1));
  assert.equal((await fetch(u)).status, 403);

  const later = new URL(url);
  later.searchParams.set("exp", String(Number(later.searchParams.get("exp")) + 1000));
  assert.equal((await fetch(later)).status, 403);

  const otherKeyUrl = new URL(url);
  otherKeyUrl.pathname = `/files/${Buffer.from("secret.txt").toString("base64url")}`;
  assert.equal((await fetch(otherKeyUrl)).status, 403);

  // A GET signature can't be used to write.
  assert.equal((await fetch(url, { method: "PUT", body: "overwritten" })).status, 403);
  assert.equal(await (await fetch(url)).text(), "0123456789");
});

test("an expired link stops working", async () => {
  const { presignGet } = await import("../src/shims/s3");
  const url = await presignGet("content", "movies/a.txt", -1);
  assert.equal((await fetch(toLocal(url))).status, 403);
});

test("uploaded HTML can't run on the app's origin", async () => {
  const res = await fetch(await signedGet("evil.html"));
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment/);
  assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("a signed key can't leave the content root, even through a symlink", async () => {
  const { presignGet } = await import("../src/shims/s3");
  await assert.rejects(presignGet("content", "../../etc/passwd"));
  await assert.rejects(presignGet("content", ".backfriend-tmp/x"));
  await assert.rejects(presignGet("not-the-bucket", "movies/a.txt"));
  symlinkSync("/etc/passwd", join(h.contentRoot, "movies", "link"));
  symlinkSync("/etc", join(h.contentRoot, "movies", "linkdir"));
  assert.notEqual((await fetch(toLocal(await presignGet("content", "movies/link")))).status, 200);
  assert.notEqual((await fetch(toLocal(await presignGet("content", "movies/linkdir/passwd")))).status, 200);
});

test("upload through a signed PUT link lands in the mount and appears in the listing", async () => {
  const res = await post("/browse/movies/upload-url?path=up.bin", adminToken, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const put = await fetch(toLocal(res.body.uploadUrl), { method: "PUT", body: "hello" });
  assert.equal(put.status, 200);
  const list = await api("/browse/movies", adminToken);
  assert.ok(JSON.stringify(list.body).includes("up.bin"));
});

test("public share: anonymous link works until it's revoked", async () => {
  const res = await post("/browse/movies/public?path=a.txt", adminToken, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const token = res.body.token;
  const hit = await fetch(`${h.base}/public/${token}`, { redirect: "manual" });
  assert.equal(hit.status, 302);
  assert.equal(await (await fetch(toLocal(hit.headers.get("location")!))).text(), "0123456789");
  assert.equal((await api("/browse/movies/public?path=a.txt", adminToken, { method: "DELETE" })).status < 300, true);
  assert.equal((await fetch(`${h.base}/public/${token}`, { redirect: "manual" })).status, 404);
});

// ----- Surface -----

test("/config exposes nothing secret, and health checks are open", async () => {
  const c = await api("/config");
  assert.equal(c.status, 200);
  assert.deepEqual(Object.keys(c.body).sort(), ["apiBaseUrl", "authType", "facebookEnabled", "googleEnabled", "name", "oidcClientId", "oidcIssuer"]);
  assert.equal((await fetch(`${h.base}/healthz`)).status, 200);
  assert.equal((await fetch(`${h.base}/readyz`)).status, 200);
});

test("identity provider admin paths never fall through to the app", async () => {
  for (const p of ["/idp", "/idp/admin/master/console/", "/idp/realms/master"]) {
    assert.equal((await fetch(`${h.base}${p}`)).status, 404, p);
  }
});

test("a signed link can't be re-aimed or have its expiry removed through a crafted key or filename", async () => {
  const { presignGet, presignPut } = await import("../src/shims/s3");
  // Newlines used to let a link for "a\\n99999999999" verify as a never-expiring link for "a".
  await assert.rejects(presignGet("content", "a.txt\n99999999999"));
  await assert.rejects(presignPut("content", "a.txt\n99999999999"));
  const url = new URL(await signedGet("a.txt"));
  const exp = url.searchParams.get("exp")!;
  url.searchParams.set("exp", "99999999999");
  url.searchParams.set("filename", `${exp}\n`);
  assert.equal((await fetch(url)).status, 403);
});

test("an oversized JSON body is refused", async () => {
  const res = await api("/admin/invites", adminToken, { method: "POST", body: "x".repeat(2 * 1024 * 1024) });
  assert.equal(res.status, 413);
});

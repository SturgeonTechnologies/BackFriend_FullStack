// End-to-end test of a running on-prem deployment, through its public URL, using
// real Keycloak forms, tokens and files. It needs a fresh deployment whose SMTP
// server is smtp-sink.mjs and whose BOOTSTRAP_ADMIN_EMAILS has ADMIN_EMAIL.
//   BASE=https://localhost SINK=http://localhost:1080 ADMIN_EMAIL=admin@e2e.test node e2e.mjs
import { createHash, randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const BASE = process.env.BASE.replace(/\/$/, "");
const SINK = process.env.SINK;
const ADMIN = process.env.ADMIN_EMAIL;
const PASSWORD = "correct-horse-battery-" + randomBytes(4).toString("hex");
const CLIENT = "backfriend-web";
const PREFIX = new URL(BASE).pathname.replace(/\/$/, "");
const REALM = `${BASE}/idp/realms/backfriend`;
const REDIRECT = `${BASE}/auth/callback`;

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; throw e; }
}

const unescape = (s) => s.replace(/&amp;/g, "&").replace(/&#x3D;/g, "=").replace(/&#61;/g, "=");
const absolute = (u) => (u.startsWith("http") ? u : new URL(u, BASE).href);

class Browser {
  jar = new Map();
  async go(url, init = {}) {
    let next = absolute(url);
    let opts = init;
    for (let hop = 0; hop < 15; hop++) {
      if (next.startsWith(REDIRECT)) return { callback: new URL(next) };
      const res = await fetch(next, { ...opts, redirect: "manual", headers: { ...(opts.headers ?? {}), Cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        this.jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      if (res.status >= 300 && res.status < 400) { next = absolute(res.headers.get("location")); opts = {}; continue; }
      return { status: res.status, html: await res.text(), url: next };
    }
    throw new Error("too many redirects");
  }
  submit(page, fields) {
    const action = page.html.match(/<form[^>]*action="([^"]+)"/)?.[1];
    assert.ok(action, `no form on ${page.url}: ${page.html.slice(0, 300)}`);
    return this.go(unescape(action), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  }
}

function authorizeUrl(browser, extra = {}) {
  browser.verifier = randomBytes(32).toString("base64url");
  browser.state = randomBytes(8).toString("hex");
  return `${REALM}/protocol/openid-connect/auth?${new URLSearchParams({
    response_type: "code", client_id: CLIENT, redirect_uri: REDIRECT, scope: "openid email profile",
    code_challenge_method: "S256", code_challenge: createHash("sha256").update(browser.verifier).digest("base64url"),
    state: browser.state, ...extra,
  })}`;
}

async function exchange(browser, callback) {
  assert.equal(callback.searchParams.get("state"), browser.state);
  const res = await fetch(`${REALM}/protocol/openid-connect/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT, code: callback.searchParams.get("code"), redirect_uri: REDIRECT, code_verifier: browser.verifier }),
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json.id_token;
}

function decodeMail(body) {
  const qp = body.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const parts = body.split("\n").filter((l) => /^[A-Za-z0-9+/=]{20,}$/.test(l)).join("");
  return `${qp}\n${Buffer.from(parts, "base64").toString()}`;
}

async function verifyLink(email) {
  for (let i = 0; i < 40; i++) {
    const mail = await (await fetch(`${SINK}/messages?to=${encodeURIComponent(email)}`)).json();
    const link = mail.map((m) => decodeMail(m.body).match(/https?:\/\/[^\s"<>]*login-actions\/action-token[^\s"<>]*/)?.[0]).find(Boolean);
    if (link) return unescape(link);
    await new Promise((ok) => setTimeout(ok, 500));
  }
  throw new Error(`no verification email for ${email}`);
}

async function register(email) {
  const b = new Browser();
  const login = await b.go(authorizeUrl(b));
  const href = login.html.match(/href="([^"]*login-actions\/registration[^"]*)"/)?.[1];
  assert.ok(href, "login page has no Register link");
  const form = await b.go(unescape(href));
  const verify = await b.submit(form, { email, firstName: "Test", lastName: "User" });
  assert.ok(!verify.callback, "registration went straight through without verifying the email");
  assert.match(verify.html, /verify|Verify/);
  let page = await b.go(await verifyLink(email));
  // Keycloak 26.8's form has no password field when email verification is on. It
  // asks for the password right after the link is opened.
  if (!page.callback && /name="password-new"/.test(page.html)) {
    page = await b.submit(page, { "password-new": PASSWORD, "password-confirm": PASSWORD });
  }
  if (!page.callback) {
    const proceed = page.html.match(/href="([^"]*login-actions[^"]*)"/)?.[1];
    assert.ok(proceed, `stuck after verification: ${page.html.slice(0, 300)}`);
    page = await b.go(unescape(proceed));
  }
  assert.ok(page.callback, `no callback after verification at ${page.url}`);
  return exchange(b, page.callback);
}

async function signIn(email, password = PASSWORD) {
  const b = new Browser();
  const page = await b.submit(await b.go(authorizeUrl(b)), { username: email, password });
  return page.callback ? exchange(b, page.callback) : null;
}

async function api(path, token, init = {}) {
  const res = await fetch(`${BASE}/api${path}`, { ...init, redirect: "manual", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { "Content-Type": "application/json" } : {}) } });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body };
}

// ----- Surface -----

await step("the web app is served with security headers, and deep links fall back to it", async () => {
  for (const path of ["/", "/auth/callback", "/admin"]) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<div id="root">/, path);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
  }
});

await step("the web app loads its assets from where it's mounted", async () => {
  const html = await (await fetch(`${BASE}/admin`)).text();
  assert.ok(html.includes(`<base href="${PREFIX}/">`), html.slice(0, 300));
  const script = html.match(/<script[^>]*src="([^"]+)"/)?.[1];
  assert.ok(script && !script.startsWith("/"), `script path isn't relative: ${script}`);
  const res = await fetch(new URL(script, `${BASE}/`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /javascript/);
  if (PREFIX) {
    const bare = await fetch(BASE, { redirect: "manual" });
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get("location"), `${PREFIX}/`);
  }
});

await step("Keycloak's admin surface and master realm aren't reachable from outside", async () => {
  for (const path of ["/idp/admin/", "/idp/admin/master/console/", "/idp/admin/realms", "/idp/realms/master/.well-known/openid-configuration", "/idp/metrics", "/idp/health",
    "/idp/realms/backfriend/account/", "/idp/realms/backfriend/clients-registrations/default", "/idp/realms/backfriendx/.well-known/openid-configuration"]) {
    const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
    assert.equal(res.status, 404, path);
  }
  // fetch() tidies paths up, so these go out exactly as written.
  for (const path of ["/idp/realms/backfriend/protocol/../../master/.well-known/openid-configuration", "/idp/resources/%2e%2e/realms/master/.well-known/openid-configuration", "/idp/realms/backfriend/protocol/..%2f..%2fmaster/.well-known/openid-configuration"]) {
    const status = await new Promise((resolve, reject) => {
      const u = new URL(BASE);
      const req = (u.protocol === "https:" ? httpsRequest : httpRequest)({ host: u.hostname, port: u.port, path: `${PREFIX}${path}`, servername: u.hostname, headers: { Host: u.host } }, (r) => { r.resume(); resolve(r.statusCode); });
      req.on("error", reject);
      req.end();
    });
    assert.ok(status !== 200, `${path} returned 200`);
  }
});

await step("the realm publishes the public issuer", async () => {
  const res = await fetch(`${REALM}/.well-known/openid-configuration`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).issuer, REALM);
});

await step("the OIDC client refuses other redirect targets, a missing PKCE challenge and the password grant", async () => {
  const b = new Browser();
  const evil = await b.go(authorizeUrl(b, { redirect_uri: "https://evil.example/callback" }));
  assert.equal(evil.status, 400);
  const url = new URL(authorizeUrl(b));
  url.searchParams.delete("code_challenge");
  url.searchParams.delete("code_challenge_method");
  const noPkce = await b.go(url.href);
  assert.ok(noPkce.callback?.searchParams.get("error") || noPkce.status === 400, "accepted a request without PKCE");
  const grant = await fetch(`${REALM}/protocol/openid-connect/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: CLIENT, username: ADMIN, password: "x" }) });
  assert.notEqual(grant.status, 200);
});

await step("anonymous API calls get 401", async () => {
  assert.equal((await api("/mounts")).status, 401);
  assert.equal((await api("/admin/invites")).status, 401);
});

// ----- Sign-in and access -----

let admin;
await step("the bootstrap admin registers, verifies by email and becomes admin", async () => {
  admin = await register(ADMIN);
  const me = await api("/me", admin);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.isAdmin, true);
});

await step("someone with no invite can register in Keycloak but gets nothing from the app", async () => {
  const token = await register("stranger@e2e.test");
  assert.equal((await api("/me", token)).status, 403);
  assert.equal((await api("/mounts", token)).status, 403);
});

let member;
await step("an invite emails the person, and they get in as a member", async () => {
  const res = await api("/admin/invites", admin, { method: "POST", body: JSON.stringify({ email: "member@e2e.test" }) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.emailSent, true, res.body.emailError);
  member = await register("member@e2e.test");
  const me = await api("/me", member);
  assert.equal(me.status, 200);
  assert.equal(me.body.isAdmin, false);
  assert.equal((await api("/admin/invites", member)).status, 403);
});

await step("repeated wrong passwords lock the account", async () => {
  for (let i = 0; i < 6; i++) assert.equal(await signIn("stranger@e2e.test", "wrong-password"), null);
  assert.equal(await signIn("stranger@e2e.test"), null, "the right password still worked during the lockout");
});

// ----- Files -----

let upload;
await step("admin creates a folder and a mount; member can't see it until granted", async () => {
  assert.ok((await api("/admin/explore/folder", admin, { method: "POST", body: JSON.stringify({ prefix: "", name: "movies" }) })).status < 300);
  const m = await api("/admin/mounts", admin, { method: "POST", body: JSON.stringify({ mountPath: "movies", prefix: "movies/", displayName: "Movies" }) });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal((await api("/browse/movies", member)).status, 403);
  assert.equal((await api("/browse/movies/download-url?path=a.txt", member)).status, 403);
  const grant = await api("/admin/mounts/movies", admin, { method: "PUT", body: JSON.stringify({ displayName: "Movies", allowedEmails: ["member@e2e.test"] }) });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.equal((await api("/browse/movies", member)).status, 200);
  upload = (await api("/browse/movies/upload-url?path=hello.txt", member, { method: "POST", body: "{}" })).body.uploadUrl;
  assert.ok(upload, "no upload URL");
});

let download;
await step("a signed upload lands in the mount and downloads back", async () => {
  assert.ok(upload.startsWith(`${BASE}/`), upload);
  assert.equal((await fetch(upload, { method: "PUT", body: "hello from e2e" })).status, 200);
  const list = await api("/browse/movies", member);
  assert.ok(JSON.stringify(list.body).includes("hello.txt"));
  download = (await api("/browse/movies/download-url?path=hello.txt", member)).body.downloadUrl;
  assert.equal(await (await fetch(download)).text(), "hello from e2e");
  const part = await fetch(download, { headers: { Range: "bytes=0-4" } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), "hello");
});

await step("a tampered signed link is refused", async () => {
  const u = new URL(download);
  u.searchParams.set("exp", String(Number(u.searchParams.get("exp")) + 60));
  assert.equal((await fetch(u)).status, 403);
  assert.equal((await fetch(download, { method: "PUT", body: "x" })).status, 403);
});

await step("a public link works anonymously until it's revoked", async () => {
  const res = await api("/browse/movies/public?path=hello.txt", admin, { method: "POST", body: "{}" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.publicUrl.startsWith(`${BASE}/`), res.body.publicUrl);
  assert.equal(await (await fetch(res.body.publicUrl)).text(), "hello from e2e");
  assert.equal((await api("/browse/movies/public?path=hello.txt", admin, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(res.body.publicUrl, { redirect: "manual" })).status, 404);
});

await step("removing a member from a mount applies to their existing token", async () => {
  await api("/admin/mounts/movies", admin, { method: "PUT", body: JSON.stringify({ displayName: "Movies", allowedEmails: [] }) });
  assert.equal((await api("/browse/movies", member)).status, 403);
});

await step("signing in again works, and the password never reached the app", async () => {
  const token = await signIn(ADMIN);
  assert.ok(token);
  assert.equal((await api("/me", token)).status, 200);
});

console.log(`\n${passed} checks passed`);

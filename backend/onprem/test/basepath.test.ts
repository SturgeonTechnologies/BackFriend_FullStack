import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startHarness, type Harness } from "./helpers";

let h: Harness;

before(async () => {
  const web = mkdtempSync(join(tmpdir(), "bf-web-"));
  mkdirSync(join(web, "assets"));
  writeFileSync(join(web, "index.html"), '<html><head><title>t</title></head><body><div id="root"></div></body></html>');
  writeFileSync(join(web, "assets", "a.js"), "ok");
  Object.assign(process.env, { BASE_PATH: "/bros", STATIC_ROOT: web });
  h = await startHarness(55434);
  process.env.SITE_ORIGIN = "https://www.example.test/bros";
  (await import("../src/config")).resetConfigForTests();
});
after(async () => { await h.stop(); });

const get = (path: string) => fetch(`${h.base}${path}`, { redirect: "manual" });

test("the app, its assets and the API answer under the sub-path", async () => {
  for (const path of ["/bros/", "/bros/admin", "/bros/auth/callback"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.ok((await res.text()).includes('<head><base href="/bros/">'), path);
  }
  assert.equal(await (await get("/bros/assets/a.js")).text(), "ok");
  const config = await (await get("/bros/api/config")).json();
  assert.equal(config.apiBaseUrl, "https://www.example.test/bros/api");
  assert.equal((await get("/bros/api/me")).status, 401);
});

test("the sub-path without a slash redirects, keeping the query", async () => {
  const res = await get("/bros?x=1");
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/bros/?x=1");
});

test("nothing outside the sub-path is served, except the probes", async () => {
  for (const path of ["/", "/admin", "/api/config", "/assets/a.js", "/config", "/brosx", "/brosx/api/config", "/files/x"]) {
    assert.equal((await get(path)).status, 404, path);
  }
  assert.equal((await get("/healthz")).status, 200);
  assert.equal((await get("/readyz")).status, 200);
});

test("Keycloak's admin paths under the sub-path stop at the app", async () => {
  assert.equal((await get("/bros/idp/admin/")).status, 404);
});

test("a BASE_PATH that could break out of the HTML tag is refused", async () => {
  const { config, resetConfigForTests } = await import("../src/config");
  const good = process.env.BASE_PATH;
  process.env.BASE_PATH = '/x"><script>';
  resetConfigForTests();
  assert.throws(() => config(), /BASE_PATH/);
  process.env.BASE_PATH = good;
  resetConfigForTests();
});

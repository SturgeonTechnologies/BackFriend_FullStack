import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ROUTES } from "../src/routes";

// dist-test/ is one level below backend/onprem.
const template = readFileSync(join(process.cwd(), "../template.yaml"), "utf8");

function templateRoutes(): string[] {
  const out: string[] = [];
  let method = "";
  for (const line of template.split("\n")) {
    const m = line.match(/^\s+Method:\s+(\w+)/);
    if (m) method = m[1].toUpperCase();
    const p = line.match(/^\s+Path:\s+(\S+)/);
    if (p && method) { out.push(`${method} ${p[1]}`); method = ""; }
  }
  return out.sort();
}

test("every route in the SAM template is served on-prem, and nothing else", () => {
  const served = [...ROUTES.map((r) => `${r.method} ${r.path}`), "GET /config"].sort();
  assert.deepEqual(served, templateRoutes());
});

test("only the public share resolver is reachable without a token", () => {
  assert.deepEqual(ROUTES.filter((r) => r.public).map((r) => r.path), ["/public/{token}"]);
  void dirname;
});

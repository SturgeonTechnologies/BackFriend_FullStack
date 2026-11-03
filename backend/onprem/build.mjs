// Bundles the on-prem server. The handlers in ../src are used exactly as the
// cloud deploys them; this plugin swaps the modules they import for AWS
// services with the on-prem versions in src/shims.
import { build } from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shim = (name) => join(here, "src/shims", `${name}.ts`);

const swapAwsModules = {
  name: "swap-aws-modules",
  setup(b) {
    b.onResolve({ filter: /^@aws-sdk\/lib-dynamodb$/ }, () => ({ path: shim("lib-dynamodb") }));
    // Relative imports only: "../../lib/db" from a handler, "./db" from another lib file.
    b.onResolve({ filter: /\/(db|s3|cognito|email)$/ }, (args) => {
      if (!args.path.startsWith(".")) return undefined;
      const target = resolve(args.resolveDir, args.path);
      if (dirname(target) !== join(here, "../src/lib")) return undefined;
      return { path: shim(args.path.split("/").pop()) };
    });
    // Anything else from the AWS SDK reaching the on-prem bundle is a bug.
    b.onResolve({ filter: /^@aws-sdk\// }, (args) => ({
      errors: [{ text: `${args.path} must not be imported by the on-prem build (from ${args.importer})` }],
    }));
  },
};

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  plugins: [swapAwsModules],
  // Optional imports in pg that a Node server never reaches, and that --omit=optional leaves out.
  external: ["pg-native", "pg-cloudflare"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "warning",
};

if (process.argv.includes("--tests")) {
  rmSync(join(here, "dist-test"), { recursive: true, force: true });
  const entries = readdirSync(join(here, "test")).filter((f) => f.endsWith(".test.ts")).map((f) => join(here, "test", f));
  await build({ ...common, entryPoints: entries, outdir: join(here, "dist-test"), outExtension: { ".js": ".mjs" } });
} else {
  rmSync(join(here, "dist"), { recursive: true, force: true });
  await build({
    ...common,
    entryPoints: [join(here, "src/server.ts"), join(here, "src/import-aws.ts")],
    outdir: join(here, "dist"),
    outExtension: { ".js": ".mjs" },
  });
}

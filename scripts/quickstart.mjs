#!/usr/bin/env node
// Guided setup for a new schuit-sharing deployment. Walks through creating
// backend/deploy.config.<name>.json and (optionally) running the deploy.
//
// This is a CONVENIENCE WRAPPER around README.md's numbered steps 1-3, not a
// replacement for them -- it automates the repetitive/mechanical parts
// (bucket creation, SSM parameter writes, assembling the JSON config) but
// skips the genuinely manual bits (creating OAuth clients in Google/Facebook's
// own consoles, custom domains, SES) on purpose, since those need real human
// judgment or a domain/console only you control. See README.md for exactly
// what each step does and the raw commands, in case something here doesn't
// fit your setup or you'd rather run it by hand.
//
// Usage: node scripts/quickstart.mjs   (from the repo root, or via
//        ./quickstart.sh / .\quickstart.ps1 which just check for Node first)

import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rl = createInterface({ input: stdin, output: stdout });

async function ask(question, fallback) {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback || "";
}

async function askYesNo(question, defaultYes = false) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} [${hint}]: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith("y");
}

const NEEDS_SHELL = process.platform === "win32";
function have(cmd) {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore", shell: NEEDS_SHELL });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  console.log(`    $ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", shell: NEEDS_SHELL, ...opts });
}

function runQuiet(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", shell: NEEDS_SHELL, ...opts });
}

function bucketExists(bucket, region) {
  try {
    runQuiet("aws", ["s3api", "head-bucket", "--bucket", bucket, "--region", region], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function createBucket(bucket, region) {
  const args = ["s3api", "create-bucket", "--bucket", bucket, "--region", region];
  if (region !== "us-east-1") {
    args.push("--create-bucket-configuration", `LocationConstraint=${region}`);
  }
  run("aws", args);
}

async function main() {
  console.log("schuit-sharing guided setup");
  console.log("============================");
  console.log("Automates README.md steps 1-3's mechanical parts: bucket");
  console.log("creation, SSM parameter writes, and assembling");
  console.log("deploy.config.<name>.json. Deliberately does NOT automate:");
  console.log("creating OAuth clients (needs the Google/Facebook consoles),");
  console.log("SES/email, or custom domains -- those need a real domain or");
  console.log("console only you control. See README.md for those, once this");
  console.log("basic deployment is live.\n");

  console.log("Checking prerequisites...");
  const missing = ["aws", "sam", "node"].filter((c) => !have(c));
  if (missing.length) {
    console.error(`Missing: ${missing.join(", ")}. See README.md "Prereqs".`);
    process.exit(1);
  }
  console.log("  OK: aws, sam, node all found.\n");

  const spaceName = await ask("Space name (lowercase, used to derive stack/bucket/function names, e.g. \"myspace\")");
  if (!/^[a-z][a-z0-9-]*$/.test(spaceName)) {
    console.error('Space name must be lowercase letters/digits/hyphens, starting with a letter.');
    process.exit(1);
  }
  const stage = await ask("Deployment stage (e.g. prod, dev, test)", "prod");
  const region = await ask("AWS region", "us-east-1");
  const sharesBucket = await ask("S3 bucket to store shared files in (created if missing)", spaceName);
  const adminEmail = await ask("Admin email (bootstrapped as admin on first sign-in)");
  const domain = await ask("Public domain for the SPA (leave blank to skip for now -- you can add it later, see README step 4)");

  const accountId = runQuiet("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"]).trim();
  const artifactBucket = `${spaceName}-sam-artifacts-${accountId}`;
  const stackName = `${spaceName}-sam`;

  console.log(`\n==> Ensuring artifact bucket ${artifactBucket} exists`);
  if (bucketExists(artifactBucket, region)) {
    console.log("    already exists, skipping.");
  } else {
    createBucket(artifactBucket, region);
  }

  console.log(`==> Ensuring shares bucket ${sharesBucket} exists`);
  if (bucketExists(sharesBucket, region)) {
    console.log("    already exists, skipping.");
  } else {
    createBucket(sharesBucket, region);
  }

  const oauth = {};
  console.log("\nOAuth sign-in (optional -- skip for email/password-only; you can add these later by editing the config and redeploying).");
  if (await askYesNo("Set up Google sign-in now? (you need a Client ID/Secret already created -- see README step 1)")) {
    const clientId = await ask("  Google Client ID");
    const clientSecret = await ask("  Google Client Secret");
    const idParam = `/${spaceName}/${stage}/google/client_id`;
    const secretParam = `/${spaceName}/${stage}/google/client_secret`;
    run("aws", ["ssm", "put-parameter", "--name", idParam, "--type", "String", "--value", clientId, "--overwrite", "--region", region]);
    run("aws", ["ssm", "put-parameter", "--name", secretParam, "--type", "SecureString", "--value", clientSecret, "--overwrite", "--region", region]);
    oauth.google = { clientIdSsmParam: idParam, clientSecretSsmParam: secretParam };
  }
  if (await askYesNo("Set up Facebook sign-in now? (you need an App ID/Secret already created -- see README step 1)")) {
    const clientId = await ask("  Facebook App ID");
    const clientSecret = await ask("  Facebook App Secret");
    const idParam = `/${spaceName}/${stage}/facebook/client_id`;
    const secretParam = `/${spaceName}/${stage}/facebook/client_secret`;
    run("aws", ["ssm", "put-parameter", "--name", idParam, "--type", "String", "--value", clientId, "--overwrite", "--region", region]);
    run("aws", ["ssm", "put-parameter", "--name", secretParam, "--type", "SecureString", "--value", clientSecret, "--overwrite", "--region", region]);
    oauth.facebook = { clientIdSsmParam: idParam, clientSecretSsmParam: secretParam };
  }

  const origin = domain ? `https://${domain}` : "http://localhost:5173";
  const config = {
    stage,
    region,
    stackName,
    functionNamePrefix: stackName,
    // Must be unique from any other deployment's in this AWS account (even
    // one you don't control) -- it names the DynamoDB tables and the
    // auto-generated Cognito domain. spaceName always is, since stack names
    // collide first if two people pick the same one.
    resourcePrefix: spaceName,
    artifactBucket,
    sharesBucket,
    siteOrigin: origin,
    allowedOrigins: [origin],
    appDisplayName: spaceName,
    bootstrapAdminEmails: [adminEmail],
    mailFrom: `noreply@${domain || "example.com"}`,
    mailRegion: region,
    webCallbackUrls: domain
      ? ["http://localhost:5173/auth/callback", `https://${domain}/auth/callback`]
      : ["http://localhost:5173/auth/callback"],
    webLogoutUrls: domain ? ["http://localhost:5173/", `https://${domain}/`] : ["http://localhost:5173/"],
    mobileCallbackUrls: ["backfriend://auth/callback"],
    mobileLogoutUrls: ["backfriend://signout"],
    ...(Object.keys(oauth).length ? { oauth } : {}),
  };

  const configPath = resolve(REPO_ROOT, "backend", `deploy.config.${spaceName}.json`);
  if (existsSync(configPath)) {
    if (!(await askYesNo(`${configPath} already exists. Overwrite?`))) {
      console.log("Aborted -- nothing written.");
      process.exit(0);
    }
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`\n==> Wrote ${configPath}`);

  console.log("\nWhat this did NOT set up (see README.md for these, once you're live):");
  console.log("  - SES (invite emails) -- README step 4b");
  console.log("  - Frontend hosting (CloudFront/S3/DNS for the SPA) -- README step 4");
  console.log("  - Custom domains for the API/Cognito Hosted UI -- README \"Custom domains\"");
  if (!domain) {
    console.log("  - You skipped a domain, so this deploys backend-only for now (no 'frontend' block).");
  }

  if (await askYesNo("\nRun the deploy now? (sam build + deploy, Cognito wiring)", true)) {
    console.log();
    const backendDir = resolve(REPO_ROOT, "backend");
    if (!existsSync(resolve(backendDir, "node_modules"))) {
      console.log("==> Installing backend dependencies (first run)");
      run("npm", ["install"], { cwd: backendDir });
    }
    run("node", ["scripts/deploy.mjs", `deploy.config.${spaceName}.json`], { cwd: backendDir });
  } else {
    console.log(`\nWhen you're ready: cd backend && node scripts/deploy.mjs deploy.config.${spaceName}.json`);
  }

  rl.close();
}

main().catch((err) => {
  console.error("\nERROR:", err?.message || err);
  process.exit(1);
});

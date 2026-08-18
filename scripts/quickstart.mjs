#!/usr/bin/env node
// Guided setup for a new deployment of this app. Walks through creating
// backend/deploy.config.<name>.json and (optionally) running the deploy,
// then (if you gave a domain) offers to deploy the frontend hosting stack
// (README step 4) and the SES email stack (README step 4b) too.
//
// This is a CONVENIENCE WRAPPER around README.md's numbered steps 1-4b, not
// a replacement for them -- it automates the repetitive/mechanical parts
// (bucket creation, SSM parameter writes, assembling the JSON config, the
// CloudFormation deploys for steps 4/4b) but skips the genuinely manual bits
// (creating OAuth clients in Google/Facebook's own consoles, and custom
// domains for the API/Cognito Hosted UI) on purpose, since those need real
// human judgment or a console only you control, and the Cognito custom
// domain swap is disruptive to sign-in besides. See README.md for exactly
// what each step does and the raw commands, in case something here doesn't
// fit your setup or you'd rather run it by hand.
//
// Interactive by default, but every prompt can be preset via a --flag or
// env var so repeat/test runs don't need retyping. `--yes` accepts the
// suggested default for any yes/no prompt not explicitly answered. See
// FLAGS below for the full list, or just run it once interactively --
// each prompt echoes the flag/env var name that would have preset it.
//
// Examples:
//   node scripts/quickstart.mjs
//   node scripts/quickstart.mjs --space devtest --domain devtest.example.com --yes
//   SPACE_NAME=devtest DOMAIN=devtest.example.com ASSUME_YES=1 node scripts/quickstart.mjs
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

// ---------- CLI flags / env vars ----------
// FLAGS: --space/SPACE_NAME, --stage/STAGE, --region/REGION,
// --shares-bucket/SHARES_BUCKET, --artifact-bucket/ARTIFACT_BUCKET,
// --admin-email/ADMIN_EMAIL, --domain/DOMAIN,
// --parent-zone/PARENT_ZONE, --mail-from-sub/MAIL_FROM_SUB,
// --google-client-id/GOOGLE_CLIENT_ID, --google-client-secret/GOOGLE_CLIENT_SECRET,
// --facebook-client-id/FACEBOOK_CLIENT_ID, --facebook-client-secret/FACEBOOK_CLIENT_SECRET,
// --google/--no-google, --facebook/--no-facebook,
// --deploy-backend/--no-deploy-backend, --deploy-frontend/--no-deploy-frontend,
// --deploy-ses/--no-deploy-ses, --redeploy-after-ses/--no-redeploy-after-ses,
// --overwrite/--no-overwrite, --confirm-new-bucket (skip the fresh-bucket
// naming-collision warning), --yes (accept the default for anything else
// unanswered -- note --yes alone does NOT skip --confirm-new-bucket, since
// that warning defaults to "no" on purpose; pass both explicitly for a fully
// unattended run of a space you're sure is new)
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else {
      out[a.slice(2)] = "true";
    }
  }
  return out;
}
const argv = parseArgs(process.argv.slice(2));

function presetValue(name, envName) {
  if (argv[name] !== undefined) return argv[name];
  if (envName && process.env[envName] !== undefined) return process.env[envName];
  return undefined;
}

function truthy(v) {
  const s = String(v).toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

// Tri-state: true/false if explicitly set (via --name, --no-name, or env), else undefined.
function presetBool(name, envName) {
  if (argv[`no-${name}`] !== undefined) return false;
  const v = presetValue(name, envName);
  return v === undefined ? undefined : truthy(v);
}

const ASSUME_YES = presetBool("yes", "ASSUME_YES") === true;

async function ask(question, fallback, preset) {
  if (preset !== undefined && preset !== "") {
    console.log(`${question}: ${preset}`);
    return preset;
  }
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback || "";
}

async function askYesNo(question, defaultYes = false, preset) {
  let use = preset;
  if (use === undefined && ASSUME_YES) use = defaultYes;
  if (use !== undefined) {
    console.log(`${question} [${use ? "y" : "n"}]`);
    return use;
  }
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} [${hint}]: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith("y");
}

// ---------- DNS-safe naming ----------
// Space name feeds stack names, the Cognito domain prefix, and (via the
// domain) DNS labels -- all of which have the same real constraint: lowercase
// letters/digits/hyphens, starting with a letter. Sanitize instead of just
// rejecting, so a stray space/underscore/capital doesn't send you back to
// retype the whole thing (or worse, surface as an opaque CFN error later).
function toDnsSafeName(input, maxLen = 24) {
  let s = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(s)) s = `s-${s}`;
  s = s.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/-+$/, "");
  return s || "space";
}

// Only .cmd-shimmed Windows binaries (sam, npm) actually need a shell to
// invoke -- aws.exe/node.exe run directly. Routing everything through cmd.exe
// is dangerous anyway: cmd.exe treats |, &, <, >, ^ as operators even inside
// a "quoted" argument, so any --query JMESPath containing a pipe (extremely
// common: `Foo[?...].Bar | [0]`) gets torn apart as a real shell pipe.
const SHELL_COMMANDS = new Set(["npm", "sam"]);
function needsShell(cmd) {
  return process.platform === "win32" && SHELL_COMMANDS.has(cmd);
}

function have(cmd) {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore", shell: needsShell(cmd) });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  console.log(`    $ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", shell: needsShell(cmd), ...opts });
}

function runQuiet(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", shell: needsShell(cmd), ...opts });
}

function bucketExists(bucket, region) {
  try {
    runQuiet("aws", ["s3api", "head-bucket", "--bucket", bucket, "--region", region], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// S3 bucket names are globally unique (not per-region) -- head-bucket
// succeeding doesn't mean the bucket is actually IN the region you asked
// for. Reusing a same-named bucket that landed in a different region on an
// earlier run is exactly what makes `sam deploy --region X --s3-bucket Y`
// fail later with an opaque "deployment s3 bucket is in a different region"
// error. Check for real, here, where it's cheap to give an actionable
// message instead.
function bucketRegion(bucket) {
  try {
    const out = runQuiet("aws", [
      "s3api", "get-bucket-location", "--bucket", bucket, "--query", "LocationConstraint", "--output", "text",
    ]).trim();
    return !out || out === "None" ? "us-east-1" : out; // us-east-1 reports LocationConstraint: null
  } catch {
    return null;
  }
}

async function ensureBucketInRegion(bucket, region, label) {
  if (!bucketExists(bucket, region)) {
    // This name is fully deterministic (space name + account id, or just the
    // space name for sharesBucket) -- there's no way to tell from here
    // whether some OTHER deployment (this repo checked out elsewhere, or a
    // different space whose name happens to compute the same bucket) is
    // relying on this exact name already. Silently claiming it is exactly
    // what caused a real incident: a second checkout's quickstart run
    // recreated a bucket a live prod config still pointed at, in the wrong
    // region, breaking that deploy. Make it a real decision point instead.
    console.log(
      `\n    ${label} bucket "${bucket}" doesn't exist yet -- would create it fresh in ${region}.\n` +
      `    Its name is deterministic, so if any other deployment (a different checkout of this\n` +
      `    repo, or another space whose name computes the same bucket) already expects this\n` +
      `    exact name, creating it here claims it out from under that config.`,
    );
    if (!(await askYesNo(`    Create "${bucket}" fresh in ${region}?`, false, presetBool("confirm-new-bucket")))) {
      console.error(`\nAborted -- rerun with --confirm-new-bucket once you're sure this name is actually free.`);
      process.exit(1);
    }
    createBucket(bucket, region);
    return;
  }
  const actual = bucketRegion(bucket);
  if (actual && actual !== region) {
    console.error(
      `\nERROR: ${label} bucket "${bucket}" already exists, but in region "${actual}" -- not the "${region}" you asked for.\n` +
      `S3 bucket names are global, so this exact name can't be created in "${region}" too. Either:\n` +
      `  - deploy in "${actual}" instead (matches where this bucket already lives), or\n` +
      `  - pick a different space name so a fresh, region-matched bucket gets created.`,
    );
    process.exit(1);
  }
  console.log(`    already exists in ${actual ?? region}, skipping.`);
}

function createBucket(bucket, region) {
  const args = ["s3api", "create-bucket", "--bucket", bucket, "--region", region];
  if (region !== "us-east-1") {
    args.push("--create-bucket-configuration", `LocationConstraint=${region}`);
  }
  run("aws", args);
}

function hostedZoneIdFor(parentZone) {
  const out = runQuiet("aws", [
    "route53", "list-hosted-zones-by-name",
    "--dns-name", parentZone,
    "--query", `HostedZones[?Name=='${parentZone}.'].Id | [0]`,
    "--output", "text",
  ]).trim();
  return out && out !== "None" ? out.replace("/hostedzone/", "") : null;
}

function cfnDeploy(stackName, templateFile, region, params) {
  run("aws", [
    "cloudformation", "deploy",
    "--region", region,
    "--stack-name", stackName,
    "--template-file", resolve(REPO_ROOT, "infrastructure", templateFile),
    "--parameter-overrides",
    ...Object.entries(params).map(([k, v]) => `${k}=${v}`),
    "--capabilities", "CAPABILITY_IAM",
  ]);
}

async function main() {
  console.log("Guided deployment setup");
  console.log("========================");
  console.log("Automates README.md steps 1-4b's mechanical parts: bucket");
  console.log("creation, SSM parameter writes, assembling");
  console.log("deploy.config.<name>.json, and (if you give a domain) the");
  console.log("frontend hosting (step 4) and SES (step 4b) CloudFormation");
  console.log("deploys. Deliberately does NOT automate: creating OAuth");
  console.log("clients (needs the Google/Facebook consoles) or custom");
  console.log("domains for the API/Cognito Hosted UI -- those need a");
  console.log("console only you control, or (for Cognito) are disruptive");
  console.log("enough to sign-in that they shouldn't happen as a side");
  console.log("effect of a routine setup run. See README.md for those.");
  console.log("\nEvery prompt below can be preset with a --flag or env var");
  console.log("for repeat/test runs -- see the file header for the full list.\n");

  console.log("Checking prerequisites...");
  const missing = ["aws", "sam", "node"].filter((c) => !have(c));
  if (missing.length) {
    console.error(`Missing: ${missing.join(", ")}. See README.md "Requirements".`);
    process.exit(1);
  }
  console.log("  OK: aws, sam, node all found.\n");

  let spaceName;
  const presetSpace = presetValue("space", "SPACE_NAME");
  if (presetSpace) {
    spaceName = toDnsSafeName(presetSpace);
    if (spaceName !== presetSpace) {
      console.log(`Space name "${presetSpace}" isn't DNS-safe -- using "${spaceName}" instead.`);
    } else {
      console.log(`Space name: ${spaceName}`);
    }
  } else {
    while (true) {
      const raw = await ask("Space name (used to derive stack/bucket/Cognito-domain/DNS names, e.g. \"myspace\")");
      if (!raw) {
        console.log("Space name is required.");
        continue;
      }
      const safe = toDnsSafeName(raw);
      if (safe === raw) {
        spaceName = safe;
        break;
      }
      if (await askYesNo(`"${raw}" isn't DNS-safe (lowercase letters/digits/hyphens, starting with a letter) -- use "${safe}" instead?`, true)) {
        spaceName = safe;
        break;
      }
    }
  }

  const stage = await ask("Deployment stage (e.g. prod, dev, test)", "prod", presetValue("stage", "STAGE"));
  const region = await ask("AWS region", "us-east-1", presetValue("region", "REGION"));
  const sharesBucket = await ask("S3 bucket to store shared files in (created if missing)", spaceName, presetValue("shares-bucket", "SHARES_BUCKET"));
  const adminEmail = await ask("Admin email (bootstrapped as admin on first sign-in)", undefined, presetValue("admin-email", "ADMIN_EMAIL"));
  const domain = await ask(
    "Public domain for the SPA (leave blank to skip for now -- you can add it later, see README step 4)",
    undefined,
    presetValue("domain", "DOMAIN"),
  );

  const accountId = runQuiet("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"]).trim();
  // Overridable: if you recently deleted a same-named bucket, S3 can hold the
  // name "reserved" for a while (sometimes well past when the bucket itself
  // shows as gone) and CreateBucket fails with OperationAborted /
  // "conflicting conditional operation" until that clears -- pick a fresh
  // name instead of waiting on AWS's internal state.
  const artifactBucket = presetValue("artifact-bucket", "ARTIFACT_BUCKET") || `${spaceName}-sam-artifacts-${accountId}`;
  const stackName = `${spaceName}-sam`;

  console.log(`\n==> Ensuring artifact bucket ${artifactBucket} exists`);
  await ensureBucketInRegion(artifactBucket, region, "Artifact");

  console.log(`==> Ensuring shares bucket ${sharesBucket} exists`);
  await ensureBucketInRegion(sharesBucket, region, "Shares");

  const oauth = {};
  console.log("\nOAuth sign-in (optional -- skip for email/password-only; you can add these later by editing the config and redeploying).");
  if (await askYesNo("Set up Google sign-in now? (you need a Client ID/Secret already created -- see README step 1)", false, presetBool("google"))) {
    const clientId = await ask("  Google Client ID", undefined, presetValue("google-client-id", "GOOGLE_CLIENT_ID"));
    const clientSecret = await ask("  Google Client Secret", undefined, presetValue("google-client-secret", "GOOGLE_CLIENT_SECRET"));
    const idParam = `/${spaceName}/${stage}/google/client_id`;
    const secretParam = `/${spaceName}/${stage}/google/client_secret`;
    run("aws", ["ssm", "put-parameter", "--name", idParam, "--type", "String", "--value", clientId, "--overwrite", "--region", region]);
    run("aws", ["ssm", "put-parameter", "--name", secretParam, "--type", "SecureString", "--value", clientSecret, "--overwrite", "--region", region]);
    oauth.google = { clientIdSsmParam: idParam, clientSecretSsmParam: secretParam };
  }
  if (await askYesNo("Set up Facebook sign-in now? (you need an App ID/Secret already created -- see README step 1)", false, presetBool("facebook"))) {
    const clientId = await ask("  Facebook App ID", undefined, presetValue("facebook-client-id", "FACEBOOK_CLIENT_ID"));
    const clientSecret = await ask("  Facebook App Secret", undefined, presetValue("facebook-client-secret", "FACEBOOK_CLIENT_SECRET"));
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
    if (!(await askYesNo(`${configPath} already exists. Overwrite?`, false, presetBool("overwrite")))) {
      console.log("Aborted -- nothing written.");
      process.exit(0);
    }
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`\n==> Wrote ${configPath}`);

  console.log("\nStill manual either way (see README.md \"Custom domains\"):");
  console.log("  - Custom domains for the API/Cognito Hosted UI");
  if (!domain) {
    console.log("  - You skipped a domain, so this deploys backend-only for now (no 'frontend' block, no steps 4/4b).");
  }

  const backendDir = resolve(REPO_ROOT, "backend");
  let backendDeployed = false;
  if (await askYesNo("\nRun the backend deploy now? (sam build + deploy, Cognito wiring)", true, presetBool("deploy-backend"))) {
    console.log();
    if (!existsSync(resolve(backendDir, "node_modules"))) {
      console.log("==> Installing backend dependencies (first run)");
      run("npm", ["install"], { cwd: backendDir });
    }
    run("node", ["scripts/deploy.mjs", `deploy.config.${spaceName}.json`], { cwd: backendDir });
    backendDeployed = true;
  } else {
    console.log(`\nWhen you're ready: cd backend && node scripts/deploy.mjs deploy.config.${spaceName}.json`);
  }

  if (domain) {
    console.log("\n---\nStep 4: frontend hosting (CloudFront + ACM + Route 53)");
    if (await askYesNo(`Deploy the frontend hosting stack for ${domain} now?`, true, presetBool("deploy-frontend"))) {
      const parentZone = await ask("Parent Route 53 hosted zone", domain, presetValue("parent-zone", "PARENT_ZONE"));
      const zoneId = hostedZoneIdFor(parentZone);
      if (!zoneId) {
        console.log(`\nNo hosted zone found for ${parentZone}. Create one first:`);
        console.log(`  aws route53 create-hosted-zone --name ${parentZone} --caller-reference "$(date +%s)"`);
        console.log("then re-run this script, or see README.md step 4.");
      } else {
        const frontendStack = `${spaceName}-frontend`;
        console.log(`\n==> Deploying ${frontendStack} to us-east-1 (CloudFront/ACM can take 15-30+ min to fully propagate)`);
        cfnDeploy(frontendStack, "frontend-infra.yml", "us-east-1", {
          DomainName: domain,
          HostedZoneId: zoneId,
          SiteBucket: sharesBucket,
          SitePrefix: "web",
          SiteBucketRegion: region,
        });
        config.frontend = { distributionStackName: frontendStack };
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        console.log(`==> Wrote "frontend": { "distributionStackName": "${frontendStack}" } into ${configPath}`);
        if (backendDeployed) {
          console.log("==> Rebuilding + syncing the SPA to it");
          run("node", ["scripts/deploy.mjs", `deploy.config.${spaceName}.json`], { cwd: backendDir });
          console.log(`\nSPA should be live shortly at https://${domain}`);
        } else {
          console.log(`\nRun the backend deploy to build + sync the SPA to it:`);
          console.log(`  cd backend && node scripts/deploy.mjs deploy.config.${spaceName}.json`);
        }
      }
    } else {
      console.log("Skipped -- run infrastructure/deploy.sh, or see README.md step 4, when ready.");
    }

    console.log("\n---\nStep 4b: SES (invite emails)");
    if (await askYesNo(`Deploy the SES email stack for ${domain} now?`, true, presetBool("deploy-ses"))) {
      const mailFromSub = toDnsSafeName(await ask("MAIL FROM subdomain", "mail", presetValue("mail-from-sub", "MAIL_FROM_SUB")), 32);
      const parentZone = await ask("Parent Route 53 hosted zone", domain, presetValue("parent-zone", "PARENT_ZONE"));
      const zoneId = hostedZoneIdFor(parentZone);
      if (!zoneId) {
        console.log(`\nNo hosted zone found for ${parentZone}. See README.md step 4b.`);
      } else {
        const emailStack = `${spaceName}-email`;
        console.log(`\n==> Deploying ${emailStack} to us-east-1`);
        cfnDeploy(emailStack, "email-infra.yml", "us-east-1", {
          Domain: domain,
          MailFromSubdomain: mailFromSub,
          HostedZoneId: zoneId,
          Region: "us-east-1",
        });
        config.mailFrom = `noreply@${domain}`;
        config.mailRegion = "us-east-1";
        config.email = { stackName: emailStack };
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        console.log(`\nDKIM verification is asynchronous (5-60 min). Check status:`);
        console.log(`  aws ses get-identity-verification-attributes --region us-east-1 --identities ${domain} --query 'VerificationAttributes."${domain}".VerificationStatus' --output text`);
        console.log(`\nSES starts in sandbox mode -- verify a test recipient before real invites go out:`);
        console.log(`  aws ses verify-email-identity --region us-east-1 --email-address ${adminEmail || "you@example.com"}`);
        console.log("then request production access (usually granted within 24h):");
        console.log("  https://console.aws.amazon.com/ses/home?region=us-east-1#/account");
        if (await askYesNo("\nRedeploy the backend now so MAIL_FROM/MAIL_REGION land?", backendDeployed, presetBool("redeploy-after-ses"))) {
          run("node", ["scripts/deploy.mjs", `deploy.config.${spaceName}.json`], { cwd: backendDir });
        } else {
          console.log(`\nWhen ready: cd backend && node scripts/deploy.mjs deploy.config.${spaceName}.json`);
        }
      }
    } else {
      console.log("Skipped -- run infrastructure/email-deploy.sh, or see README.md step 4b, when ready.");
    }
  }

  console.log(`\nWhen you're done testing this space, tear it down with:`);
  console.log(`  node scripts/teardown.mjs --space ${spaceName} --yes`);

  rl.close();
}

main().catch((err) => {
  console.error("\nERROR:", err?.message || err);
  process.exit(1);
});

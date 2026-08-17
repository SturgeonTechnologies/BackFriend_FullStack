#!/usr/bin/env node
// Guided setup for a new schuit-sharing deployment. Walks through creating
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
  console.log("schuit-sharing guided setup");
  console.log("============================");
  console.log("Automates README.md steps 1-4b's mechanical parts: bucket");
  console.log("creation, SSM parameter writes, assembling");
  console.log("deploy.config.<name>.json, and (if you give a domain) the");
  console.log("frontend hosting (step 4) and SES (step 4b) CloudFormation");
  console.log("deploys. Deliberately does NOT automate: creating OAuth");
  console.log("clients (needs the Google/Facebook consoles) or custom");
  console.log("domains for the API/Cognito Hosted UI -- those need a");
  console.log("console only you control, or (for Cognito) are disruptive");
  console.log("enough to sign-in that they shouldn't happen as a side");
  console.log("effect of a routine setup run. See README.md for those.\n");

  console.log("Checking prerequisites...");
  const missing = ["aws", "sam", "node"].filter((c) => !have(c));
  if (missing.length) {
    console.error(`Missing: ${missing.join(", ")}. See README.md "Requirements".`);
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

  console.log("\nStill manual either way (see README.md \"Custom domains\"):");
  console.log("  - Custom domains for the API/Cognito Hosted UI");
  if (!domain) {
    console.log("  - You skipped a domain, so this deploys backend-only for now (no 'frontend' block, no steps 4/4b).");
  }

  const backendDir = resolve(REPO_ROOT, "backend");
  let backendDeployed = false;
  if (await askYesNo("\nRun the backend deploy now? (sam build + deploy, Cognito wiring)", true)) {
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
    if (await askYesNo(`Deploy the frontend hosting stack for ${domain} now?`, true)) {
      const parentZone = await ask("Parent Route 53 hosted zone", domain);
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
    if (await askYesNo(`Deploy the SES email stack for ${domain} now?`, true)) {
      const mailFromSub = await ask("MAIL FROM subdomain", "mail");
      const parentZone = await ask("Parent Route 53 hosted zone", domain);
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
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        console.log(`\nDKIM verification is asynchronous (5-60 min). Check status:`);
        console.log(`  aws ses get-identity-verification-attributes --region us-east-1 --identities ${domain} --query 'VerificationAttributes."${domain}".VerificationStatus' --output text`);
        console.log(`\nSES starts in sandbox mode -- verify a test recipient before real invites go out:`);
        console.log(`  aws ses verify-email-identity --region us-east-1 --email-address ${adminEmail || "you@example.com"}`);
        console.log("then request production access (usually granted within 24h):");
        console.log("  https://console.aws.amazon.com/ses/home?region=us-east-1#/account");
        if (await askYesNo("\nRedeploy the backend now so MAIL_FROM/MAIL_REGION land?", backendDeployed)) {
          run("node", ["scripts/deploy.mjs", `deploy.config.${spaceName}.json`], { cwd: backendDir });
        } else {
          console.log(`\nWhen ready: cd backend && node scripts/deploy.mjs deploy.config.${spaceName}.json`);
        }
      }
    } else {
      console.log("Skipped -- run infrastructure/email-deploy.sh, or see README.md step 4b, when ready.");
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error("\nERROR:", err?.message || err);
  process.exit(1);
});

#!/usr/bin/env node
// Tears down a deployment of this app created by quickstart.mjs: the SAM
// backend stack, the frontend hosting stack, and the SES email stack
// (whichever exist), found by naming convention (<space>-sam / -frontend /
// -email) or from backend/deploy.config.<space>.json if present.
//
// If the space/stage looks like prod, this won't just refuse -- it'll make
// you type a literal confirmation phrase first (see PROD_CONFIRM_PHRASE
// below). There's no flag to skip that prompt; --yes only covers the
// ordinary "proceed?" confirmation for non-prod spaces.
//
// Examples:
//   node scripts/teardown.mjs --space devtest
//   node scripts/teardown.mjs --space devtest --yes
//   node scripts/teardown.mjs --space devtest --keep-backend --keep-email
//   node scripts/teardown.mjs --space devtest --delete-buckets   # also empties+deletes the artifact/shares buckets
//
// FLAGS: --space/SPACE_NAME (required), --stage/STAGE, --region/REGION,
// --yes, --keep-backend, --keep-frontend, --keep-email, --delete-buckets

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rl = createInterface({ input: stdin, output: stdout });

const PROD_CONFIRM_PHRASE = "i know what i'm doing";

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
function flag(name, envName) {
  if (argv[name] !== undefined) return argv[name];
  if (envName && process.env[envName] !== undefined) return process.env[envName];
  return undefined;
}
function boolFlag(name) {
  if (argv[`no-${name}`] !== undefined) return false;
  if (argv[name] === undefined) return false;
  const s = String(argv[name]).toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

// Only .cmd-shimmed Windows binaries (sam, npm -- not used here, but kept
// consistent with quickstart.mjs) need a shell to invoke; aws.exe runs
// directly. Routing aws through cmd.exe is actively dangerous: cmd.exe
// treats |, &, <, >, ^ as operators even inside a "quoted" argument, which
// breaks any --query JMESPath containing a pipe (e.g. `Foo[?...].Bar | [0]`).
const SHELL_COMMANDS = new Set(["npm", "sam"]);
function needsShell(cmd) {
  return process.platform === "win32" && SHELL_COMMANDS.has(cmd);
}
function run(cmd, args, opts = {}) {
  console.log(`    $ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", shell: needsShell(cmd), ...opts });
}
function runQuiet(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", shell: needsShell(cmd), ...opts });
}
async function askYesNo(question, defaultYes = false) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} [${hint}]: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith("y");
}

function stackInfo(stackName, region) {
  try {
    const out = runQuiet("aws", [
      "cloudformation", "describe-stacks",
      "--region", region,
      "--stack-name", stackName,
      "--query", "Stacks[0].[StackStatus,CreationTime]",
      "--output", "text",
    ], { stdio: "pipe" }).trim();
    if (!out) return null;
    const [status, creationTime] = out.split(/\s+/);
    return status && status !== "None" ? { status, creationTime } : null;
  } catch {
    return null;
  }
}

function deleteStack(stackName, region) {
  run("aws", ["cloudformation", "delete-stack", "--region", region, "--stack-name", stackName]);
  console.log(`    waiting for ${stackName} to finish deleting (this can take a few minutes)...`);
  run("aws", ["cloudformation", "wait", "stack-delete-complete", "--region", region, "--stack-name", stackName]);
}

function emptyBucket(bucket, region) {
  try {
    run("aws", ["s3", "rm", `s3://${bucket}`, "--recursive", "--region", region]);
  } catch {
    // may already be empty or not exist -- the delete-bucket call below surfaces the real error
  }
}

async function main() {
  const space = flag("space", "SPACE_NAME");
  if (!space) {
    console.error("Usage: node scripts/teardown.mjs --space <name> [--stage <stage>] [--region <region>] [--yes] [--keep-backend] [--keep-frontend] [--keep-email] [--delete-buckets]");
    process.exit(1);
  }

  const configPath = resolve(REPO_ROOT, "backend", `deploy.config.${space}.json`);
  let config = null;
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  }
  const stage = flag("stage", "STAGE") ?? config?.stage;
  const region = flag("region", "REGION") ?? config?.region ?? "us-east-1";

  const lower = (s) => (s || "").toLowerCase();
  const looksProd = lower(stage) === "prod" || lower(space) === "prod";

  console.log(`Teardown -- space "${space}"${stage ? `, stage "${stage}"` : ""}, region ${region}`);
  if (config) {
    console.log(`Found ${configPath} (this file won't be deleted -- remove it by hand once you're done).`);
  } else {
    console.log(
      `No deploy.config.${space}.json found -- going by naming convention only (<space>-sam / -frontend /\n` +
      `-email). These are GUESSES: if "${space}" happens to match another deployment's stack name (this\n` +
      `repo checked out elsewhere, or a different space that computes the same name), this could target\n` +
      `real resources that aren't yours to tear down. Each guessed target below will ask you to confirm\n` +
      `its creation date looks right before deleting it.`,
    );
  }

  if (looksProd) {
    console.log(`\n!! "${space}"${stage ? ` (stage "${stage}")` : ""} looks like a PROD deployment.`);
    console.log("This script can delete it, but won't as a reflex -- type the phrase below,");
    console.log(`exactly, to continue: "${PROD_CONFIRM_PHRASE}"\n`);
    const typed = (await rl.question("> ")).trim().toLowerCase();
    if (typed !== PROD_CONFIRM_PHRASE) {
      console.log("\nPhrase didn't match -- aborting. Nothing was touched.");
      process.exit(1);
    }
    console.log("\nOK, proceeding.");
  }

  const backendStack = config?.stackName ?? `${space}-sam`;
  const frontendStack = config?.frontend?.distributionStackName ?? `${space}-frontend`;
  const emailStack = config?.email?.stackName ?? `${space}-email`;
  const sharesBucket = config?.sharesBucket ?? space;
  const artifactBucket = config?.artifactBucket;

  const targets = [];
  if (!boolFlag("keep-frontend")) targets.push({ label: "frontend hosting", stack: frontendStack, region: "us-east-1" });
  if (!boolFlag("keep-email")) targets.push({ label: "SES email", stack: emailStack, region: "us-east-1" });
  if (!boolFlag("keep-backend")) targets.push({ label: "backend (SAM)", stack: backendStack, region });

  console.log("\nWill check for and delete these stacks (skips any that don't exist):");
  for (const t of targets) console.log(`  - ${t.label}: ${t.stack} (${t.region})`);
  if (boolFlag("delete-buckets")) {
    console.log(`  - empty + delete bucket: ${sharesBucket}${artifactBucket ? ` and ${artifactBucket}` : ""}`);
    console.log("    WARNING: this deletes every object in those buckets, including any real uploaded files.");
  }

  if (!boolFlag("yes") && !(await askYesNo("\nProceed?", false))) {
    console.log("Aborted -- nothing was touched.");
    process.exit(0);
  }

  for (const t of targets) {
    console.log(`\n==> ${t.label}: ${t.stack}`);
    const info = stackInfo(t.stack, t.region);
    if (!info) {
      console.log("    not found, skipping.");
      continue;
    }
    console.log(`    found (${info.status}), created ${info.creationTime}`);
    // Only the config-driven path is trusted by construction (you typed the
    // space name and it matched a real config file). A guessed name matching
    // a real stack is exactly the failure mode that nearly deleted the wrong
    // live frontend stack during testing -- ask before touching it.
    if (!config) {
      console.log(`    !! This name was GUESSED (no deploy.config.${space}.json) -- confirm the creation date above is really yours.`);
      if (!boolFlag("yes") && !(await askYesNo(`    Delete ${t.stack}?`, false))) {
        console.log("    Skipped.");
        continue;
      }
    }
    console.log("    deleting...");
    deleteStack(t.stack, t.region);
  }

  if (boolFlag("delete-buckets")) {
    console.log(`\n==> Emptying + deleting bucket ${sharesBucket}`);
    emptyBucket(sharesBucket, region);
    run("aws", ["s3api", "delete-bucket", "--bucket", sharesBucket, "--region", region]);
    if (artifactBucket) {
      console.log(`\n==> Emptying + deleting bucket ${artifactBucket}`);
      emptyBucket(artifactBucket, region);
      run("aws", ["s3api", "delete-bucket", "--bucket", artifactBucket, "--region", region]);
    }
  }

  console.log("\nDone.");
  if (config) {
    console.log(`(${configPath} was left in place -- delete it yourself if you're fully done with this space.)`);
  }
  rl.close();
}

main().catch((err) => {
  console.error("\nERROR:", err?.message || err);
  process.exit(1);
});

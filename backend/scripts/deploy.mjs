#!/usr/bin/env node
// One-command deploy: SAM build+deploy, Cognito trigger/theme/email wiring,
// and (optionally) the frontend build+S3 sync+CloudFront invalidation — all
// driven by a single JSON config file instead of scattered CLI flags.
//
// Assumes the S3/CloudFront/Route53 infra already exists (see README "Deploy
// the frontend infra" for that one-time setup) and, if a custom Cognito
// domain is wanted, that it's already been created (see README "Custom
// Cognito domain" — also one-time, tied to a domain only you control, so it
// isn't part of this script).
//
// Usage:
//   node scripts/deploy.mjs [path/to/deploy.config.json]   # default: ./deploy.config.json
//
// Secrets (OAuth client secrets) are never read from the config file itself
// — only SSM parameter *names* are. The actual values are pulled from SSM
// (SecureString) at deploy time. See deploy.config.example.json.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { wireCognito } from "./wire-cognito-triggers.mjs";

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(BACKEND_DIR, "..");

function log(msg) {
  console.log(`\n==> ${msg}`);
}

// On Windows, .cmd shims (sam, npm) can't run via execFileSync without
// shell:true -- Node can't exec a .bat/.cmd directly (EINVAL), even with the
// extension resolved explicitly. aws.exe/node.exe are real executables and
// never need this. That distinction matters beyond just avoiding an
// unnecessary shell: cmd.exe treats |, &, <, >, ^ as operators even inside a
// "quoted" argument, so routing aws through it would mangle any --query
// JMESPath containing a pipe (e.g. `Foo[?...].Bar | [0]`). For the commands
// that do need shell:true, shell:true does NOT quote array elements for you
// (Node warns DEP0190) -- it just concatenates them with spaces -- so any
// argument containing whitespace (e.g. "AppDisplayName=My Space") would
// otherwise get split into multiple tokens. Quote those ourselves.
const SHELL_COMMANDS = new Set(["npm", "sam"]);
function needsShell(cmd) {
  return process.platform === "win32" && SHELL_COMMANDS.has(cmd);
}

function winQuote(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function run(cmd, args, opts = {}) {
  console.log(`    $ ${cmd} ${args.join(" ")}`);
  const shell = needsShell(cmd);
  const finalArgs = shell ? args.map(winQuote) : args;
  execFileSync(cmd, finalArgs, { stdio: "inherit", shell, ...opts });
}

function runCapture(cmd, args, opts = {}) {
  const shell = needsShell(cmd);
  const finalArgs = shell ? args.map(winQuote) : args;
  return execFileSync(cmd, finalArgs, { encoding: "utf8", shell, ...opts }).trim();
}

function loadConfig(path) {
  if (!existsSync(path)) {
    console.error(`Config file not found: ${path}`);
    console.error(`Copy deploy.config.example.json to deploy.config.json and fill it in.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Fetch an SSM parameter's value (decrypting if SecureString). */
function ssmGet(name) {
  return runCapture("aws", [
    "ssm", "get-parameter",
    "--region", process.env.AWS_REGION || "us-east-1",
    "--name", name,
    "--with-decryption",
    "--query", "Parameter.Value",
    "--output", "text",
  ]);
}

function csv(arr) {
  return Array.isArray(arr) ? arr.join(",") : arr;
}

async function getStackOutputs(cfn, stackName) {
  const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = res.Stacks?.[0];
  if (!stack) throw new Error(`Stack ${stackName} not found`);
  return Object.fromEntries((stack.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
}

async function main() {
  const configPath = resolve(process.cwd(), process.argv[2] || "deploy.config.json");
  const cfg = loadConfig(configPath);
  const region = cfg.region || "us-east-1";
  process.env.AWS_REGION = region;

  for (const required of ["stage", "stackName", "functionNamePrefix", "resourcePrefix", "artifactBucket", "sharesBucket"]) {
    if (!cfg[required]) {
      console.error(`Missing required config field: "${required}"`);
      process.exit(1);
    }
  }

  // ---------- 1. Resolve OAuth secrets from SSM (never stored in the config file) ----------
  // Only set a key when the config actually provides a value. Omitting it
  // lets `sam deploy` fall back to the template's Default (first deploy) or
  // the stack's existing value (redeploy) -- passing an empty string instead
  // would explicitly clobber either with "", which is wrong for params like
  // MailFrom/CognitoCustomDomain that have real defaults or prior values.
  //
  // resourcePrefix is required (not defaulted here) on purpose: the template's
  // own Default ("schuit-sharing") is only correct for THIS deployment. Any
  // other deployment in the same AWS account that left it unset would try to
  // create DynamoDB tables / a Cognito domain with the exact same names as
  // this one and fail (or worse, on a stage that also matched, collide for
  // real) -- caught the hard way deploying a second space.
  const paramOverrides = {
    Stage: cfg.stage,
    FunctionNamePrefix: cfg.functionNamePrefix,
    ResourcePrefix: cfg.resourcePrefix,
    SharesBucket: cfg.sharesBucket,
  };
  const setIf = (key, value) => {
    if (value !== undefined && value !== null && value !== "") paramOverrides[key] = value;
  };
  setIf("SharesBucketRegion", cfg.sharesBucketRegion);
  setIf("SiteOrigin", cfg.siteOrigin);
  setIf("AllowedOrigins", cfg.allowedOrigins && csv(cfg.allowedOrigins));
  setIf("AppDisplayName", cfg.appDisplayName);
  setIf("CognitoCustomDomain", cfg.cognitoCustomDomain);
  setIf("ApiCustomDomain", cfg.apiCustomDomain);
  setIf("ApiCustomDomainCertArn", cfg.apiCustomDomainCertArn);
  setIf("BootstrapAdminEmails", cfg.bootstrapAdminEmails && csv(cfg.bootstrapAdminEmails));
  setIf("MailFrom", cfg.mailFrom);
  setIf("MailRegion", cfg.mailRegion);
  setIf("WebCallbackUrls", cfg.webCallbackUrls && csv(cfg.webCallbackUrls));
  setIf("WebLogoutUrls", cfg.webLogoutUrls && csv(cfg.webLogoutUrls));
  setIf("MobileCallbackUrls", cfg.mobileCallbackUrls && csv(cfg.mobileCallbackUrls));
  setIf("MobileLogoutUrls", cfg.mobileLogoutUrls && csv(cfg.mobileLogoutUrls));

  if (cfg.adopt) {
    setIf("ExistingUserPoolId", cfg.adopt.existingUserPoolId);
    setIf("ExistingWebClientId", cfg.adopt.existingWebClientId);
    setIf("MobileIdentityProviders", cfg.adopt.mobileIdentityProviders && csv(cfg.adopt.mobileIdentityProviders));
  }

  if (cfg.oauth?.google) {
    log("Resolving Google OAuth secret from SSM");
    setIf("GoogleClientId", ssmGet(cfg.oauth.google.clientIdSsmParam));
    setIf("GoogleClientSecret", ssmGet(cfg.oauth.google.clientSecretSsmParam));
  }
  if (cfg.oauth?.facebook) {
    log("Resolving Facebook OAuth secret from SSM");
    setIf("FacebookClientId", ssmGet(cfg.oauth.facebook.clientIdSsmParam));
    setIf("FacebookClientSecret", ssmGet(cfg.oauth.facebook.clientSecretSsmParam));
  }

  // ---------- 2. SAM build + deploy ----------
  log(`Building (sam build)`);
  run("sam", ["build"], { cwd: BACKEND_DIR });

  log(`Deploying stack ${cfg.stackName} to ${region}`);
  // SAM CLI's shorthand --parameter-overrides "Key=Value Key2=Value2" parser
  // truncates any value containing a space at the first space, no matter how
  // it's quoted (confirmed empirically -- not a shell-escaping issue). A
  // parameter-overrides file sidesteps that entirely; SAM only wires up
  // .yaml/.yml file readers (JSON support exists in the code but isn't
  // registered for this flag), but JSON is valid YAML, so writing this file
  // with a .yaml extension and JSON content works fine. Must be a flat
  // {Key: Value} object -- the CFN-style [{ParameterKey,ParameterValue}]
  // array form only keeps the last entry when read this way.
  const overridesFile = resolve(BACKEND_DIR, ".deploy-overrides.yaml");
  writeFileSync(overridesFile, JSON.stringify(paramOverrides, null, 2));
  try {
    run(
      "sam",
      [
        "deploy",
        "--stack-name", cfg.stackName,
        "--region", region,
        "--s3-bucket", cfg.artifactBucket,
        "--capabilities", "CAPABILITY_NAMED_IAM",
        "--no-confirm-changeset",
        "--no-fail-on-empty-changeset",
        "--parameter-overrides", `file://${overridesFile}`,
      ],
      { cwd: BACKEND_DIR },
    );
  } finally {
    unlinkSync(overridesFile);
  }

  // ---------- 3. Wire Cognito triggers + hosted-UI theme + email ----------
  log("Wiring Cognito triggers, hosted-UI theme, and email config");
  await wireCognito({
    stackName: cfg.stackName,
    region,
    functionPrefix: cfg.functionNamePrefix,
    emailFrom: cfg.mailFrom ? `${cfg.appDisplayName ?? "Sharing App"} <${cfg.mailFrom}>` : undefined,
  });

  const cfn = new CloudFormationClient({ region });
  const outputs = await getStackOutputs(cfn, cfg.stackName);
  console.log(`\n    ApiEndpoint            = ${outputs.ApiEndpoint}`);
  console.log(`    ApiCustomDomainUrl     = ${outputs.ApiCustomDomainUrl || "(not set)"}`);
  console.log(`    CognitoDomain          = ${outputs.CognitoDomain}`);
  console.log(`    UserPoolClientId       = ${outputs.UserPoolClientId}`);
  console.log(`    UserPoolClientMobileId = ${outputs.UserPoolClientMobileId}`);

  // ---------- 3.5. Patch getConfig's API_BASE_URL ----------
  // Can't be set in template.yaml itself: `${HttpApi}` isn't known until the
  // API's routes (including getConfig's own) already exist, so referencing
  // it from getConfig's Environment is a real CFN circular dependency
  // (HttpApi's routes need getConfig's ARN; getConfig would need HttpApi's
  // id) -- same class of problem as the Cognito LambdaConfig wiring above.
  // Patched here instead, now that it's a known stack output. get + merge +
  // put because `update-function-configuration --environment` REPLACES the
  // whole map -- a bare `Variables={API_BASE_URL:...}` would wipe every var
  // CFN set (APP_DISPLAY_NAME, COGNITO_DOMAIN, ...).
  log("Setting getConfig's API_BASE_URL (can't be set via CFN -- see template.yaml)");
  const apiBaseUrl = outputs.ApiCustomDomainUrl || outputs.ApiEndpoint;
  const getConfigFnName = `${cfg.functionNamePrefix}-getConfig`;
  const currentEnv = JSON.parse(
    runCapture("aws", [
      "lambda", "get-function-configuration",
      "--function-name", getConfigFnName,
      "--region", region,
      "--query", "Environment.Variables",
      "--output", "json",
    ]),
  );
  run("aws", [
    "lambda", "update-function-configuration",
    "--function-name", getConfigFnName,
    "--region", region,
    "--environment", JSON.stringify({ Variables: { ...currentEnv, API_BASE_URL: apiBaseUrl } }),
  ]);

  // ---------- 4. Frontend build + deploy (optional) ----------
  if (cfg.frontend) {
    log(`Building frontend against the deployed stack`);
    const frontendDir = resolve(REPO_ROOT, "frontend");
    // The API is no longer proxied through the SPA's CloudFront distribution
    // (see infrastructure/frontend-infra.yml) -- it's called cross-origin, so
    // this needs to be a full absolute URL, not the old relative "/api".
    // Prefers the custom domain when configured, else falls back to the raw
    // execute-api URL.
    const apiBase = cfg.frontend.apiBase ?? (outputs.ApiCustomDomainUrl || outputs.ApiEndpoint);
    run("npm", ["ci"], { cwd: frontendDir });
    run("npm", ["run", "build"], {
      cwd: frontendDir,
      env: {
        ...process.env,
        VITE_API_BASE: apiBase,
        VITE_USER_POOL_CLIENT_ID: outputs.UserPoolClientId,
        VITE_COGNITO_DOMAIN: outputs.CognitoDomain,
        VITE_REDIRECT_URI: cfg.frontend.redirectUri,
        VITE_LOGOUT_REDIRECT: cfg.frontend.logoutRedirect,
        VITE_APP_TITLE: cfg.frontend.appTitle ?? "Sharing App",
      },
    });

    log(`Looking up S3/CloudFront targets from stack ${cfg.frontend.distributionStackName}`);
    const feOutputs = await getStackOutputs(cfn, cfg.frontend.distributionStackName);
    const uploadPath = feOutputs.SiteUploadPath;
    const distributionId = feOutputs.DistributionId;
    if (!uploadPath || !distributionId) {
      throw new Error(
        `Stack ${cfg.frontend.distributionStackName} is missing SiteUploadPath/DistributionId outputs`,
      );
    }

    log(`Syncing dist/ to ${uploadPath}`);
    run("aws", ["s3", "sync", "dist/", uploadPath, "--delete"], { cwd: frontendDir });

    // aws s3 sync guesses Content-Type from the file extension -- this one
    // file (frontend/public/.well-known/apple-app-site-association) has none
    // on purpose (that's the fixed path Apple's Universal Links verifier
    // fetches), so it lands as application/octet-stream unless corrected here.
    const aasaPath = resolve(frontendDir, "public/.well-known/apple-app-site-association");
    if (existsSync(aasaPath)) {
      log("Fixing Content-Type on the Universal Links verification file");
      run("aws", [
        "s3", "cp", aasaPath, `${uploadPath}.well-known/apple-app-site-association`,
        "--content-type", "application/json",
      ]);
    }

    log(`Invalidating CloudFront distribution ${distributionId}`);
    run("aws", ["cloudfront", "create-invalidation", "--distribution-id", distributionId, "--paths", "/*"]);

    console.log(`\n    Site: ${feOutputs.Url ?? "(see distribution outputs)"}`);
  }

  log("Deploy complete.");
}

main().catch((err) => {
  console.error("\nERROR:", err?.message || err);
  process.exit(1);
});

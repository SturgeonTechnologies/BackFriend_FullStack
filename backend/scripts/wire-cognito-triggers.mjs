#!/usr/bin/env node
// Wires the PreSignUp/PostAuthentication/PreTokenGeneration Cognito Lambda
// triggers onto the UserPool, applies the hosted-UI dark theme to every app
// client, and points Cognito's own email (verification/recovery) through SES.
//
// Why this is a separate step from `sam deploy`: putting `LambdaConfig`
// directly on the AWS::Cognito::UserPool resource creates a circular
// dependency in CloudFormation when the same UserPool is also used as the
// HTTP API authorizer. Doing the wiring after deploy breaks the cycle.
// SetUICustomization also has no CloudFormation resource at all.
//
// Idempotent — safe to run after every deploy. Exports wireCognito() for
// scripts/deploy.mjs to call in-process; also runnable standalone:
//
//   STACK_NAME=schuit-sharing-prod-sam FUNCTION_PREFIX=schuit-sharing-prod-sam \
//     node scripts/wire-cognito-triggers.mjs
//   AWS_PROFILE=my-profile STAGE=dev node scripts/wire-cognito-triggers.mjs

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  UpdateUserPoolCommand,
  SetUICustomizationCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  LambdaClient,
  GetFunctionCommand,
} from "@aws-sdk/client-lambda";

// Dark theme for the classic hosted UI, matching the SPA palette. Classic
// hosted UI only styles the card/inputs/buttons (not the page body), so the
// page surround stays Cognito's default gray. There is no CloudFormation
// resource for this, so we apply it here post-deploy (idempotent upsert).
const HOSTED_UI_CSS = `.background-customizable {
  background-color: #0f1115;
}
.banner-customizable {
  background-color: #171a21;
}
h1, h2 {
  color: #ffffff;
}
.label-customizable {
  color: #ffffff;
}
.textDescription-customizable {
  color: #ffffff;
}
.idpDescription-customizable {
  color: #ffffff;
}
.legalText-customizable {
  color: #ffffff;
}
.inputField-customizable {
  background-color: #3a4150;
  border: 1px solid #4a5262;
  color: #ffffff;
}
.inputField-customizable:focus {
  border-color: #4f8cff;
}
.submitButton-customizable {
  background-color: #4f8cff;
  color: #ffffff;
  font-size: 14px;
  font-weight: 600;
}
.submitButton-customizable:hover {
  background-color: #3f7ae0;
}
.idpButton-customizable {
  background-color: #1d222b;
  border: 1px solid #262c38;
  color: #e8eaf0;
}
.idpButton-customizable:hover {
  background-color: #262c38;
  color: #ffffff;
}
.errorMessage-customizable {
  background-color: #2a1416;
  border: 1px solid #ff5b5b;
  color: #ff5b5b;
}`;

/**
 * @param {object} opts
 * @param {string} opts.stackName    The deployed SAM stack (e.g. schuit-sharing-prod-sam).
 * @param {string} [opts.region]     Defaults to AWS_REGION env or us-east-1.
 * @param {string} opts.functionPrefix  Must match the stack's FunctionNamePrefix param.
 * @param {string} [opts.emailFrom]  "Display Name <noreply@yourdomain>". Defaults to a placeholder.
 * @param {string} [opts.sesSourceArn]  Defaults to arn:aws:ses:<region>:<acct>:identity/<domain-from-emailFrom>.
 */
export async function wireCognito({ stackName, region, functionPrefix, emailFrom, sesSourceArn }) {
  const REGION = region || process.env.AWS_REGION || "us-east-1";
  const cfn = new CloudFormationClient({ region: REGION });
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const lambda = new LambdaClient({ region: REGION });

  async function getStackOutput(key) {
    const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = res.Stacks?.[0];
    if (!stack) throw new Error(`Stack ${stackName} not found`);
    const out = stack.Outputs?.find((o) => o.OutputKey === key);
    if (!out?.OutputValue) throw new Error(`Output ${key} missing on stack ${stackName}`);
    return out.OutputValue;
  }

  async function getFunctionArn(name) {
    const res = await lambda.send(new GetFunctionCommand({ FunctionName: name }));
    if (!res.Configuration?.FunctionArn) throw new Error(`Lambda ${name} not found`);
    return res.Configuration.FunctionArn;
  }

  console.log(`==> Looking up resources from stack ${stackName} in ${REGION}`);
  const userPoolId = await getStackOutput("UserPoolId");
  const preSignUpArn = await getFunctionArn(`${functionPrefix}-preSignUp`);
  const postAuthArn = await getFunctionArn(`${functionPrefix}-postAuth`);
  const preTokenGenArn = await getFunctionArn(`${functionPrefix}-preTokenGen`);
  console.log(`    UserPoolId       = ${userPoolId}`);
  console.log(`    PreSignUp ARN    = ${preSignUpArn}`);
  console.log(`    PostAuth ARN     = ${postAuthArn}`);
  console.log(`    PreTokenGen ARN  = ${preTokenGenArn}`);

  // Apply the hosted-UI dark theme (idempotent). Done before the LambdaConfig
  // idempotency short-circuit below so it always runs on re-invocation.
  // SetUICustomization is scoped per (UserPoolId, ClientId) — it does NOT
  // apply to every app client, so every client whose hosted UI a human sees
  // needs its own call (web client + mobile client both).
  const clientId = await getStackOutput("UserPoolClientId");
  const mobileClientId = await getStackOutput("UserPoolClientMobileId");
  console.log("==> Applying hosted-UI customization (dark theme) to web + mobile clients");
  await Promise.all(
    [clientId, mobileClientId].map((id) =>
      cognito.send(new SetUICustomizationCommand({ UserPoolId: userPoolId, ClientId: id, CSS: HOSTED_UI_CSS })),
    ),
  );

  console.log("==> Fetching current UserPool config");
  const desc = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: userPoolId }));
  const pool = desc.UserPool;
  if (!pool) throw new Error("UserPool description was empty");

  const desiredLambdaConfig = {
    ...(pool.LambdaConfig ?? {}),
    PreSignUp: preSignUpArn,
    PostAuthentication: postAuthArn,
    PreTokenGeneration: preTokenGenArn,
  };

  // If the pool uses the V2 advanced pre-token-generation trigger
  // (PreTokenGenerationConfig), Cognito requires its LambdaArn to match the V1
  // PreTokenGeneration ARN — otherwise UpdateUserPool rejects the call. Keep the
  // configured LambdaVersion, just repoint the ARN.
  if (desiredLambdaConfig.PreTokenGenerationConfig) {
    desiredLambdaConfig.PreTokenGenerationConfig = {
      ...desiredLambdaConfig.PreTokenGenerationConfig,
      LambdaArn: preTokenGenArn,
    };
  }

  // Email: send Cognito's own verification/recovery mail through SES. The default
  // COGNITO_DEFAULT sender is throttled (~50/day) and unreliable, so native
  // sign-up codes and forgot-password emails silently fail to deliver.
  const accountId = preSignUpArn.split(":")[4];
  const resolvedEmailFrom = emailFrom || process.env.COGNITO_EMAIL_FROM || "Sharing App <noreply@example.com>";
  const emailDomain = resolvedEmailFrom.replace(/^.*<([^>]+)>\s*$/, "$1").split("@")[1];
  const desiredEmailConfiguration = {
    EmailSendingAccount: "DEVELOPER",
    From: resolvedEmailFrom,
    SourceArn: sesSourceArn || process.env.SES_SOURCE_ARN || `arn:aws:ses:${REGION}:${accountId}:identity/${emailDomain}`,
  };

  // Idempotency: skip only if BOTH the triggers and the email config are correct.
  const current = pool.LambdaConfig ?? {};
  const email = pool.EmailConfiguration ?? {};
  const triggersOk =
    current.PreSignUp === preSignUpArn &&
    current.PostAuthentication === postAuthArn &&
    current.PreTokenGeneration === preTokenGenArn;
  const emailOk =
    email.EmailSendingAccount === "DEVELOPER" &&
    email.SourceArn === desiredEmailConfiguration.SourceArn &&
    email.From === desiredEmailConfiguration.From;
  if (triggersOk && emailOk) {
    console.log("==> LambdaConfig + EmailConfiguration already up to date — nothing to do.");
    return;
  }

  // UpdateUserPool resets fields you don't pass back, so we re-pass everything
  // that was on the pool (skipping immutable fields like UsernameAttributes
  // and Schema, which UpdateUserPool rejects).
  //
  // Cognito validates the WHOLE request atomically -- if the SES identity for
  // MailFrom's domain isn't verified yet, EmailConfiguration alone fails the
  // call and LambdaConfig (the triggers -- invite-gating, admin bootstrap)
  // never gets applied either, even though that part had nothing wrong with
  // it. Try the full update first; if it's specifically the SES identity
  // that's the problem, retry with the pool's EXISTING EmailConfiguration
  // (Cognito's own limited default sender) so the triggers still land, and
  // tell the user clearly what's still broken instead of failing opaquely.
  const baseUpdate = {
    UserPoolId: userPoolId,
    LambdaConfig: desiredLambdaConfig,
    Policies: pool.Policies,
    AutoVerifiedAttributes: pool.AutoVerifiedAttributes,
    MfaConfiguration: pool.MfaConfiguration,
    AdminCreateUserConfig: pool.AdminCreateUserConfig,
    EmailVerificationMessage: pool.EmailVerificationMessage,
    EmailVerificationSubject: pool.EmailVerificationSubject,
    VerificationMessageTemplate: pool.VerificationMessageTemplate,
    SmsConfiguration: pool.SmsConfiguration,
    SmsAuthenticationMessage: pool.SmsAuthenticationMessage,
    DeviceConfiguration: pool.DeviceConfiguration,
    AccountRecoverySetting: pool.AccountRecoverySetting,
    UserPoolAddOns: pool.UserPoolAddOns,
    UserPoolTags: pool.UserPoolTags,
  };

  console.log("==> Updating UserPool with new LambdaConfig + EmailConfiguration");
  try {
    await cognito.send(
      new UpdateUserPoolCommand({ ...baseUpdate, EmailConfiguration: desiredEmailConfiguration }),
    );
  } catch (err) {
    const msg = err?.message || "";
    if (!/ses|not verified|identity/i.test(msg)) throw err;
    console.warn(`\n!! SES email config rejected: ${msg}`);
    console.warn(`!! Verify the SES identity for "${desiredEmailConfiguration.SourceArn}" (see README`);
    console.warn(`!! step 4b), then re-run this deploy. Wiring triggers now WITHOUT changing email`);
    console.warn(`!! config -- Cognito's own limited default sender stays in place meanwhile, so`);
    console.warn(`!! sign-up verification codes / forgot-password emails may not reach real inboxes yet.\n`);
    await cognito.send(new UpdateUserPoolCommand({ ...baseUpdate, EmailConfiguration: pool.EmailConfiguration }));
  }

  console.log("==> Done. Triggers are now wired:");
  console.log(`    PreSignUp:          ${preSignUpArn}`);
  console.log(`    PostAuthentication: ${postAuthArn}`);
  console.log(`    PreTokenGeneration: ${preTokenGenArn}`);
}

// Standalone CLI usage — unchanged interface, now delegating to wireCognito().
const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`;
if (isMain) {
  const stackName = process.env.STACK_NAME;
  const functionPrefix = process.env.FUNCTION_PREFIX;
  if (!stackName || !functionPrefix) {
    console.error("Set STACK_NAME and FUNCTION_PREFIX env vars (matching your deploy.config.<name>.json's stackName/functionNamePrefix).");
    process.exit(1);
  }
  wireCognito({ stackName, functionPrefix }).catch((err) => {
    console.error("ERROR:", err?.message || err);
    process.exit(1);
  });
}

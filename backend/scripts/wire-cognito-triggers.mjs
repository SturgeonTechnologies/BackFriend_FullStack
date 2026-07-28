#!/usr/bin/env node
// Wires the PreSignUp + PostAuthentication Cognito Lambda triggers onto the
// UserPool created by `serverless deploy`.
//
// Why this is a separate script: putting `LambdaConfig` directly on the
// AWS::Cognito::UserPool resource creates a circular dependency in
// CloudFormation when the same UserPool is also used as the HTTP API
// authorizer. Doing the wiring after deploy breaks the cycle.
//
// Idempotent — safe to run after every deploy.
//
// Usage:
//   node scripts/wire-cognito-triggers.mjs                  # stage=dev
//   STAGE=prod node scripts/wire-cognito-triggers.mjs
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
.label-customizable {
  color: #8a93a4;
}
.textDescription-customizable {
  color: #8a93a4;
}
.idpDescription-customizable {
  color: #8a93a4;
}
.legalText-customizable {
  color: #8a93a4;
}
.inputField-customizable {
  background-color: #1d222b;
  border: 1px solid #262c38;
  color: #e8eaf0;
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
import {
  LambdaClient,
  GetFunctionCommand,
} from "@aws-sdk/client-lambda";

const STAGE = process.env.STAGE || "dev";
const REGION = process.env.AWS_REGION || "us-east-1";
const SERVICE = "schuit-sharing";
const STACK_NAME = `${SERVICE}-${STAGE}`;

const cfn = new CloudFormationClient({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });

async function getStackOutput(key) {
  const res = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  const stack = res.Stacks?.[0];
  if (!stack) throw new Error(`Stack ${STACK_NAME} not found`);
  const out = stack.Outputs?.find((o) => o.OutputKey === key);
  if (!out?.OutputValue) throw new Error(`Output ${key} missing on stack ${STACK_NAME}`);
  return out.OutputValue;
}

async function getFunctionArn(name) {
  const res = await lambda.send(new GetFunctionCommand({ FunctionName: name }));
  if (!res.Configuration?.FunctionArn) throw new Error(`Lambda ${name} not found`);
  return res.Configuration.FunctionArn;
}

async function main() {
  console.log(`==> Looking up resources from stack ${STACK_NAME} in ${REGION}`);
  const userPoolId = await getStackOutput("UserPoolId");
  const preSignUpArn = await getFunctionArn(`${SERVICE}-${STAGE}-preSignUp`);
  const postAuthArn = await getFunctionArn(`${SERVICE}-${STAGE}-postAuth`);
  const preTokenGenArn = await getFunctionArn(`${SERVICE}-${STAGE}-preTokenGen`);
  console.log(`    UserPoolId       = ${userPoolId}`);
  console.log(`    PreSignUp ARN    = ${preSignUpArn}`);
  console.log(`    PostAuth ARN     = ${postAuthArn}`);
  console.log(`    PreTokenGen ARN  = ${preTokenGenArn}`);

  // Apply the hosted-UI dark theme (idempotent). Done before the LambdaConfig
  // idempotency short-circuit below so it always runs on re-invocation.
  const clientId = await getStackOutput("UserPoolClientId");
  console.log("==> Applying hosted-UI customization (dark theme)");
  await cognito.send(
    new SetUICustomizationCommand({ UserPoolId: userPoolId, ClientId: clientId, CSS: HOSTED_UI_CSS }),
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

  // Idempotency: skip if already wired correctly.
  const current = pool.LambdaConfig ?? {};
  if (
    current.PreSignUp === preSignUpArn &&
    current.PostAuthentication === postAuthArn &&
    current.PreTokenGeneration === preTokenGenArn
  ) {
    console.log("==> LambdaConfig already up to date — nothing to do.");
    return;
  }

  // UpdateUserPool resets fields you don't pass back, so we re-pass everything
  // that was on the pool (skipping immutable fields like UsernameAttributes
  // and Schema, which UpdateUserPool rejects).
  console.log("==> Updating UserPool with new LambdaConfig");
  await cognito.send(
    new UpdateUserPoolCommand({
      UserPoolId: userPoolId,
      LambdaConfig: desiredLambdaConfig,
      Policies: pool.Policies,
      AutoVerifiedAttributes: pool.AutoVerifiedAttributes,
      MfaConfiguration: pool.MfaConfiguration,
      AdminCreateUserConfig: pool.AdminCreateUserConfig,
      EmailVerificationMessage: pool.EmailVerificationMessage,
      EmailVerificationSubject: pool.EmailVerificationSubject,
      VerificationMessageTemplate: pool.VerificationMessageTemplate,
      EmailConfiguration: pool.EmailConfiguration,
      SmsConfiguration: pool.SmsConfiguration,
      SmsAuthenticationMessage: pool.SmsAuthenticationMessage,
      DeviceConfiguration: pool.DeviceConfiguration,
      AccountRecoverySetting: pool.AccountRecoverySetting,
      UserPoolAddOns: pool.UserPoolAddOns,
      UserPoolTags: pool.UserPoolTags,
    }),
  );

  console.log("==> Done. Triggers are now wired:");
  console.log(`    PreSignUp:          ${preSignUpArn}`);
  console.log(`    PostAuthentication: ${postAuthArn}`);
  console.log(`    PreTokenGeneration: ${preTokenGenArn}`);
}

main().catch((err) => {
  console.error("ERROR:", err?.message || err);
  process.exit(1);
});

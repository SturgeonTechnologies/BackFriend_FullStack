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
} from "@aws-sdk/client-cognito-identity-provider";
import {
  LambdaClient,
  GetFunctionCommand,
} from "@aws-sdk/client-lambda";

const STAGE = process.env.STAGE || "dev";
const REGION = process.env.AWS_REGION || "us-east-1";
const SERVICE = "rom-hub";
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
  console.log(`    UserPoolId       = ${userPoolId}`);
  console.log(`    PreSignUp ARN    = ${preSignUpArn}`);
  console.log(`    PostAuth ARN     = ${postAuthArn}`);

  console.log("==> Fetching current UserPool config");
  const desc = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: userPoolId }));
  const pool = desc.UserPool;
  if (!pool) throw new Error("UserPool description was empty");

  const desiredLambdaConfig = {
    ...(pool.LambdaConfig ?? {}),
    PreSignUp: preSignUpArn,
    PostAuthentication: postAuthArn,
  };

  // Idempotency: skip if already wired correctly.
  const current = pool.LambdaConfig ?? {};
  if (
    current.PreSignUp === preSignUpArn &&
    current.PostAuthentication === postAuthArn
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
}

main().catch((err) => {
  console.error("ERROR:", err?.message || err);
  process.exit(1);
});

import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

export const cognito = new CognitoIdentityProviderClient({});

// NOTE: userPoolId is passed in as an argument rather than read from
// process.env.USER_POOL_ID. Injecting USER_POOL_ID through serverless'
// `provider.environment` would make every Lambda DependOn UserPool, which
// creates a circular dependency through UserPool.LambdaConfig → trigger
// Lambdas → role. Cognito triggers get the pool id from `event.userPoolId`;
// other callers can derive it from the JWT issuer claim.

export async function getUserGroups(
  userPoolId: string,
  username: string,
): Promise<string[]> {
  const res = await cognito.send(
    new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: username }),
  );
  return (res.Groups ?? []).map((g) => g.GroupName!).filter(Boolean);
}

export async function addUserToGroup(
  userPoolId: string,
  username: string,
  groupName: string,
): Promise<void> {
  try {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: username,
        GroupName: groupName,
      }),
    );
  } catch (err: any) {
    // Idempotent — ignore "already in group" style errors.
    if (err?.name === "ResourceNotFoundException") return;
    if (String(err?.message ?? "").includes("already")) return;
    throw err;
  }
}

import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

export const cognito = new CognitoIdentityProviderClient({});
export const USER_POOL_ID = process.env.USER_POOL_ID!;

export async function getUserGroups(username: string): Promise<string[]> {
  const res = await cognito.send(
    new AdminListGroupsForUserCommand({ UserPoolId: USER_POOL_ID, Username: username }),
  );
  return (res.Groups ?? []).map((g) => g.GroupName!).filter(Boolean);
}

export async function addUserToGroup(username: string, groupName: string): Promise<void> {
  try {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
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

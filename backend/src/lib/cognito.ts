import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";

export const cognito = new CognitoIdentityProviderClient({});

function emailOf(attrs?: { Name?: string; Value?: string }[]): string | undefined {
  const a = (attrs ?? []).find((x) => x.Name === "email");
  return a?.Value?.toLowerCase();
}

export interface PoolUser {
  email: string;
  status?: string; // CONFIRMED, EXTERNAL_PROVIDER, FORCE_CHANGE_PASSWORD, …
  enabled: boolean;
}

/** All users in the pool (paginated), reduced to email + status. */
export async function listAllUsers(userPoolId: string): Promise<PoolUser[]> {
  const out: PoolUser[] = [];
  let token: string | undefined;
  do {
    const res = await cognito.send(
      new ListUsersCommand({ UserPoolId: userPoolId, Limit: 60, PaginationToken: token }),
    );
    for (const u of res.Users ?? []) {
      const email = emailOf(u.Attributes);
      if (email) out.push({ email, status: u.UserStatus, enabled: u.Enabled ?? true });
    }
    token = res.PaginationToken;
  } while (token);
  return out;
}

/** Lowercased emails of every member of a group (paginated). */
export async function listGroupMemberEmails(userPoolId: string, groupName: string): Promise<Set<string>> {
  const emails = new Set<string>();
  let token: string | undefined;
  do {
    const res = await cognito.send(
      new ListUsersInGroupCommand({ UserPoolId: userPoolId, GroupName: groupName, Limit: 60, NextToken: token }),
    );
    for (const u of res.Users ?? []) {
      const email = emailOf(u.Attributes);
      if (email) emails.add(email);
    }
    token = res.NextToken;
  } while (token);
  return emails;
}

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

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, INVITES_TABLE } from "./db";
import { addUserToGroup, getUserGroups } from "./cognito";

const ADMIN_GROUP = process.env.ADMIN_GROUP ?? "admins";

function bootstrapAdmins(): Set<string> {
  const raw = process.env.BOOTSTRAP_ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Idempotent user provisioning, shared by the Cognito triggers.
 *
 * Assigns group membership on the basis of:
 *   1. BOOTSTRAP_ADMIN_EMAILS — always promoted to the admins group.
 *   2. The Invites table — any `groups` on an active (unredeemed) invite are
 *      applied, and the invite is marked redeemed.
 *
 * Returns the full set of groups the user should belong to after provisioning
 * (existing ∪ newly-assigned) so a Pre Token Generation trigger can override
 * the token's `cognito:groups` claim and make the *current* token correct —
 * otherwise the new membership only shows up on the next sign-in.
 *
 * Safe to call on every token issuance: group adds are idempotent and the
 * invite is only redeemed once.
 */
export async function provisionUser(
  userPoolId: string,
  username: string,
  email: string,
): Promise<string[]> {
  const lowerEmail = email.toLowerCase();
  const groupsToAssign = new Set<string>();

  if (bootstrapAdmins().has(lowerEmail)) {
    groupsToAssign.add(ADMIN_GROUP);
  }

  const invite = (
    await ddb.send(new GetCommand({ TableName: INVITES_TABLE, Key: { email: lowerEmail } }))
  ).Item;

  if (invite && !invite.redeemedAt) {
    for (const g of invite.groups ?? []) groupsToAssign.add(String(g));
    await ddb
      .send(
        new UpdateCommand({
          TableName: INVITES_TABLE,
          Key: { email: lowerEmail },
          UpdateExpression: "SET redeemedAt = :t",
          ExpressionAttributeValues: { ":t": new Date().toISOString() },
        }),
      )
      .catch((e) => console.error("Failed to mark invite redeemed", e));
  }

  const existing = new Set(await getUserGroups(userPoolId, username));
  for (const g of groupsToAssign) {
    if (!existing.has(g)) {
      await addUserToGroup(userPoolId, username, g);
      existing.add(g);
    }
  }

  return [...existing];
}

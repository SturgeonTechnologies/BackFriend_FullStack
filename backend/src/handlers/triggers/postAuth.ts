import type { PostAuthenticationTriggerHandler } from "aws-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, INVITES_TABLE } from "../../lib/db";
import { addUserToGroup, getUserGroups } from "../../lib/cognito";

function bootstrapAdmins(): Set<string> {
  const raw = process.env.BOOTSTRAP_ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

const ADMIN_GROUP = process.env.ADMIN_GROUP ?? "admins";

/**
 * Runs on every successful sign-in. Idempotent.
 *
 * On the user's first sign-in we assign group membership based on:
 *   1. BOOTSTRAP_ADMIN_EMAILS env var — always promoted to admins.
 *   2. The Invites table — any `groups` on an active invite are applied,
 *      and the invite is marked redeemed.
 */
export const handler: PostAuthenticationTriggerHandler = async (event) => {
  const email = String(event.request.userAttributes.email ?? "").toLowerCase();
  const username = event.userName;
  if (!email || !username) return event;

  try {
    const groupsToAssign = new Set<string>();

    if (bootstrapAdmins().has(email)) {
      groupsToAssign.add(ADMIN_GROUP);
    }

    const invite = (
      await ddb.send(new GetCommand({ TableName: INVITES_TABLE, Key: { email } }))
    ).Item;

    if (invite && !invite.redeemedAt) {
      for (const g of invite.groups ?? []) groupsToAssign.add(String(g));
      await ddb
        .send(
          new UpdateCommand({
            TableName: INVITES_TABLE,
            Key: { email },
            UpdateExpression: "SET redeemedAt = :t",
            ExpressionAttributeValues: { ":t": new Date().toISOString() },
          }),
        )
        .catch((e) => console.error("Failed to mark invite redeemed", e));
    }

    if (groupsToAssign.size > 0) {
      // event.userPoolId is supplied by Cognito on every trigger invocation,
      // which lets us avoid an env var that would create a circular dep.
      const userPoolId = event.userPoolId;
      const existing = new Set(await getUserGroups(userPoolId, username));
      for (const g of groupsToAssign) {
        if (!existing.has(g)) {
          await addUserToGroup(userPoolId, username, g);
        }
      }
    }
  } catch (e) {
    // Never block sign-in on a provisioning hiccup; just log it.
    console.error("postAuth provisioning error", e);
  }

  return event;
};

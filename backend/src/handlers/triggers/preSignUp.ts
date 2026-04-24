import type { PreSignUpTriggerHandler } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, INVITES_TABLE } from "../../lib/db";

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
 * Fires before a user is created in the pool.
 *
 * For federated sign-ins (Google, etc.) this runs on the invitee's very first
 * sign-in. We gate creation on: email must be either a bootstrap admin or have
 * an active, unredeemed, unexpired invite. Any failure here causes Cognito to
 * reject sign-in with a generic error shown in the hosted UI.
 */
export const handler: PreSignUpTriggerHandler = async (event) => {
  const email = String(event.request.userAttributes.email ?? "").toLowerCase();
  if (!email) throw new Error("Email is required to sign in.");

  const admins = bootstrapAdmins();
  if (admins.has(email)) {
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
    return event;
  }

  const invite = (
    await ddb.send(new GetCommand({ TableName: INVITES_TABLE, Key: { email } }))
  ).Item;

  if (!invite) {
    throw new Error(`No invite found for ${email}. Contact an admin.`);
  }
  if (invite.redeemedAt) {
    // The invite has already been used by someone who successfully signed up.
    // A second sign-in with the same email is fine if the user already exists
    // (Cognito won't call PreSignUp in that case), but if we got here the
    // account is gone — treat as no invite.
    throw new Error(`Invite for ${email} has already been used.`);
  }
  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    throw new Error(`Invite for ${email} has expired.`);
  }

  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
};

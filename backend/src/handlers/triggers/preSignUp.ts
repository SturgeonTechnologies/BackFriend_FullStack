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
 * Fires before a user is created in the pool. Runs for both:
 *   - federated sign-ins (Google)       → triggerSource "PreSignUp_ExternalProvider"
 *   - native email/password sign-ups    → triggerSource "PreSignUp_SignUp"
 *
 * We gate creation on: email must be either a bootstrap admin or have an active,
 * unredeemed, unexpired invite. This gate applies to *both* paths, so a random
 * person can't self-register with the native form. Any thrown error causes
 * Cognito to reject sign-in/sign-up with a generic message in the hosted UI.
 *
 * Email confirmation differs by path:
 *   - External provider (Google): Google already verified the address, so we
 *     auto-confirm and auto-verify — no code step.
 *   - Native sign-up: we do NOT auto-confirm. Cognito emails a verification code
 *     the invitee must enter (the hosted UI renders the code screen), which
 *     proves they actually own the invited inbox before the account goes live.
 */
export const handler: PreSignUpTriggerHandler = async (event) => {
  const email = String(event.request.userAttributes.email ?? "").toLowerCase();
  if (!email) throw new Error("Email is required to sign in.");

  const isFederated = event.triggerSource === "PreSignUp_ExternalProvider";

  const admins = bootstrapAdmins();
  if (!admins.has(email)) {
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
  }

  // The invite (or bootstrap-admin) gate has passed. Only short-circuit the
  // email-verification step for federated users; native sign-ups verify via
  // the emailed code so we can trust they own the address.
  if (isFederated) {
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
  }
  return event;
};

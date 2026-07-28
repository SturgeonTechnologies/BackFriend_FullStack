import type { PostAuthenticationTriggerHandler } from "aws-lambda";
import { provisionUser } from "../../lib/provision";

/**
 * Runs on successful sign-in via the InitiateAuth/AdminInitiateAuth SDK flows.
 * Idempotent.
 *
 * NOTE: this trigger does NOT fire for hosted-UI / federated (OAuth) sign-ins —
 * which is how every user of this app actually signs in. `preTokenGen` is the
 * trigger that reliably fires for those flows and does the real provisioning.
 * This handler stays wired for completeness (e.g. any future non-hosted-UI
 * flow) and delegates to the same shared logic.
 */
export const handler: PostAuthenticationTriggerHandler = async (event) => {
  const email = String(event.request.userAttributes.email ?? "").toLowerCase();
  const username = event.userName;
  if (!email || !username) return event;

  try {
    await provisionUser(event.userPoolId, username, email);
  } catch (e) {
    // Never block sign-in on a provisioning hiccup; just log it.
    console.error("postAuth provisioning error", e);
  }

  return event;
};

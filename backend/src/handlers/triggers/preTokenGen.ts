import type { PreTokenGenerationTriggerHandler } from "aws-lambda";
import { provisionUser } from "../../lib/provision";

/**
 * Fires on every token issuance — including hosted-UI and federated (Google /
 * email-password) sign-ins, unlike PostAuthentication. This is where user
 * provisioning actually happens for this app.
 *
 * We (idempotently) assign groups + redeem the invite, then override the
 * token's `cognito:groups` claim with the resulting group set so the *current*
 * token already reflects admin/other membership — no second sign-in needed.
 *
 * Never throw: a failure here would block token issuance (i.e. block login).
 */
export const handler: PreTokenGenerationTriggerHandler = async (event) => {
  const email = String(event.request.userAttributes.email ?? "").toLowerCase();
  const username = event.userName;
  if (!email || !username) return event;

  try {
    const groups = await provisionUser(event.userPoolId, username, email);
    if (groups.length > 0) {
      event.response.claimsOverrideDetails = {
        ...(event.response.claimsOverrideDetails ?? {}),
        groupOverrideDetails: { groupsToOverride: groups },
      };
    }
  } catch (e) {
    console.error("preTokenGen provisioning error", e);
  }

  return event;
};

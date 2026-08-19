import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { ok } from "../../lib/response";

/**
 * GET /config   (UNAUTHENTICATED — no JWT authorizer on this route)
 *
 * Backend discovery for clients that support multiple sharing backends (e.g.
 * the mobile app's "add account" flow): given just the API base URL, this
 * returns what's needed to start the Cognito Hosted UI PKCE flow against it.
 */
export const handler: APIGatewayProxyHandlerV2 = async () => {
  return ok({
    name: process.env.APP_DISPLAY_NAME,
    apiBaseUrl: process.env.API_BASE_URL,
    cognitoDomain: process.env.COGNITO_DOMAIN,
    cognitoClientId: process.env.COGNITO_CLIENT_ID,
    googleEnabled: process.env.GOOGLE_ENABLED === "true",
    facebookEnabled: process.env.FACEBOOK_ENABLED === "true",
  });
};

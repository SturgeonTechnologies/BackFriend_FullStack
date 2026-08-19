import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { getCaller } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { presignGet } from "../../lib/s3";
import { RESERVED_PERSONAL_PREFIX } from "../../lib/mounts";

/**
 * POST /archive/download-url?key=<key>
 *
 * Self-service presigned GET for the caller's own archived file — same
 * ownership check as archivePublic.ts (key must be under their own
 * user_sharing_default/<email>/ prefix) but deliberately separate from it:
 * this is a private, short-lived view/download link, not a public share.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = getCaller(event);
    if (!caller.sub) return error(401, "Unauthorized");
    if (!caller.email) return error(400, "Account has no email on file");

    const key = String(event.queryStringParameters?.key ?? "").trim();
    const ownPrefix = `${RESERVED_PERSONAL_PREFIX}${caller.email.toLowerCase()}/`;
    if (!key || !key.startsWith(ownPrefix) || key.includes("..")) {
      return error(403, "Can only access your own archived content");
    }

    const expiresInSeconds = 3600;
    const downloadUrl = await presignGet(process.env.SHARES_BUCKET!, key, expiresInSeconds);

    return ok({ downloadUrl, expiresInSeconds });
  } catch (e) {
    console.error(e);
    return error(500, "Internal error");
  }
};

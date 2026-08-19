import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { getCaller } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { presignPut } from "../../lib/s3";
import { RESERVED_PERSONAL_PREFIX } from "../../lib/mounts";

/**
 * POST /archive/upload-url?filename=<name>
 *
 * Self-service personal storage — NOT mount-based, NOT admin-gated. Every
 * caller can only ever write under their own `user_sharing_default/<email>/`
 * folder (the same reserved convention `lib/mounts.ts` already protects from
 * being exposed as a single shared mount); the key is derived entirely from
 * the caller's own JWT email, never taken from the request.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = getCaller(event);
    if (!caller.sub) return error(401, "Unauthorized");
    if (!caller.email) return error(400, "Account has no email on file");

    const filename = String(event.queryStringParameters?.filename ?? "").trim();
    if (!filename) return error(400, "filename query parameter is required");
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      return error(400, "Invalid filename");
    }

    const key = `${RESERVED_PERSONAL_PREFIX}${caller.email.toLowerCase()}/${filename}`;
    const expiresInSeconds = 3600;
    const uploadUrl = await presignPut(process.env.SHARES_BUCKET!, key, expiresInSeconds);

    return ok({ uploadUrl, key, expiresInSeconds });
  } catch (e) {
    console.error(e);
    return error(500, "Internal error");
  }
};

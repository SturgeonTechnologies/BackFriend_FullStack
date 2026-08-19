import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { getCaller } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { listDir } from "../../lib/s3";
import { RESERVED_PERSONAL_PREFIX } from "../../lib/mounts";

/**
 * GET /archive/list
 *
 * Self-service listing of the caller's own user_sharing_default/<email>/
 * folder — no mount, no admin gate, same as the other /archive/* routes.
 * Archive uploads are always flat (archiveUploadUrl.ts rejects "/" in
 * filenames), but this uses the same delimiter-based listDir() the mount
 * browser uses rather than assuming that, in case that ever changes.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = getCaller(event);
    if (!caller.sub) return error(401, "Unauthorized");
    if (!caller.email) return error(400, "Account has no email on file");

    const prefix = `${RESERVED_PERSONAL_PREFIX}${caller.email.toLowerCase()}/`;
    const token = event.queryStringParameters?.token;
    const res = await listDir(process.env.SHARES_BUCKET!, prefix, token);

    return ok({
      files: res.files.map((f) => ({
        name: f.key.slice(prefix.length),
        key: f.key,
        size: f.size,
        lastModified: f.lastModified,
      })),
      truncated: res.truncated,
      nextToken: res.nextContinuationToken,
    });
  } catch (e) {
    console.error(e);
    return error(500, "Internal error");
  }
};

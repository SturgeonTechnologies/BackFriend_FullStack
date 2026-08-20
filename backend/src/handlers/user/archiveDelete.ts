import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { getCaller } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { deleteObject } from "../../lib/s3";
import { RESERVED_PERSONAL_PREFIX } from "../../lib/mounts";

/**
 * DELETE /archive/file?key=<key>
 *
 * Self-service delete of the caller's own archived file — same ownership
 * check as archiveDownloadUrl.ts / archivePublic.ts (key must be under their
 * own user_sharing_default/<email>/ prefix). Permanently deletes from S3
 * (the bucket is not versioned, so this is irreversible), unlike the mount
 * browser's deleteFile.ts this is NOT admin-gated -- it's the caller's own
 * personal folder.
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
      return error(403, "Can only delete your own archived content");
    }

    await deleteObject(process.env.SHARES_BUCKET!, key);

    console.log(JSON.stringify({ evt: "archive-delete", user: caller.email, key }));

    return ok({ ok: true });
  } catch (e) {
    console.error(e);
    return error(500, "Internal error");
  }
};

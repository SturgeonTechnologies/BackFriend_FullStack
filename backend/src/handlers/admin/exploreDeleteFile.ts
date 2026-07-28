import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { requireAdmin } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { deleteObject } from "../../lib/s3";

function validKey(key: string): boolean {
  return !!key && !key.includes("..") && !key.includes("\\") && !key.endsWith("/");
}

/**
 * DELETE /admin/explore/file?key=<fullS3Key>
 * Admin-only permanent delete of any file in the shares bucket (raw key).
 * The bucket is unversioned, so this is irreversible.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = requireAdmin(event);
    const bucket = process.env.SHARES_BUCKET;
    if (!bucket) return error(500, "SHARES_BUCKET not configured");

    const key = String(event.queryStringParameters?.key ?? "").replace(/^\/+/, "");
    if (!validKey(key)) return error(400, "A valid file key is required");

    await deleteObject(bucket, key);
    console.log(JSON.stringify({ evt: "explore-delete", user: caller.email ?? caller.sub, key }));
    return ok({ ok: true });
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

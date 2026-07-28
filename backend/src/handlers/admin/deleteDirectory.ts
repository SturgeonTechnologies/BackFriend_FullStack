import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, MOUNTS_TABLE, MountRow } from "../../lib/db";
import { requireAdmin } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { listAllKeys, deleteObjects } from "../../lib/s3";

/**
 * DELETE /admin/explore/directory?prefix=<key-prefix>
 *
 * Admin-only. PERMANENTLY deletes every object under the prefix (the bucket is
 * unversioned, so this is irreversible). Also removes any mount pointing at
 * exactly that prefix so we don't leave a dangling share.
 *
 * Guards: refuses the bucket root and the `web/` prefix (the SPA lives there).
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = requireAdmin(event);

    const bucket = process.env.SHARES_BUCKET;
    if (!bucket) return error(500, "SHARES_BUCKET not configured");

    let prefix = String(event.queryStringParameters?.prefix ?? "").replace(/^\/+/, "");
    if (prefix.includes("..") || prefix.includes("\\")) return error(400, "Invalid prefix");
    if (prefix && !prefix.endsWith("/")) prefix += "/";

    if (!prefix) return error(400, "Refusing to delete the entire bucket");
    if (prefix === "web/" || prefix.startsWith("web/")) {
      return error(400, "Refusing to delete the site's web/ directory");
    }

    const keys = await listAllKeys(bucket, prefix);
    const deleted = await deleteObjects(bucket, keys);

    // Remove any mount that points at exactly this prefix.
    const scan = await ddb.send(new ScanCommand({ TableName: MOUNTS_TABLE, Limit: 500 }));
    const mountsRemoved: string[] = [];
    for (const m of (scan.Items ?? []) as MountRow[]) {
      if (m.prefix === prefix) {
        await ddb.send(new DeleteCommand({ TableName: MOUNTS_TABLE, Key: { mountPath: m.mountPath } }));
        mountsRemoved.push(m.mountPath);
      }
    }

    console.log(JSON.stringify({
      evt: "delete-directory",
      user: caller.email ?? caller.sub,
      prefix, deleted, mountsRemoved,
    }));

    return ok({ deleted, mountsRemoved });
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

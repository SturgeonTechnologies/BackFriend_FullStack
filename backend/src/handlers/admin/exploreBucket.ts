import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { requireAdmin } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { listDir } from "../../lib/s3";

/**
 * GET /admin/explore?prefix=<key-prefix>&token=<continuationToken>
 *
 * Admin-only raw-bucket explorer. Lists one "directory level" (folders + files)
 * of the shares bucket so an admin can discover which S3 prefixes exist and turn
 * any of them into a mount — instead of typing the prefix blind.
 *
 * Unlike the user-facing /browse endpoint, paths here are the *full* S3 keys:
 * the whole point is to surface the real layout, and a chosen folder's key is
 * exactly what gets stored as a mount's `prefix`.
 *
 * The bucket is always SHARES_BUCKET — we intentionally don't accept a bucket
 * parameter, because the Lambda role only grants s3:ListBucket on that one
 * bucket and we don't want to open arbitrary cross-bucket listing.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    requireAdmin(event);

    const bucket = process.env.SHARES_BUCKET;
    if (!bucket) return error(500, "SHARES_BUCKET not configured");

    // Normalize the requested prefix: strip leading slashes, reject traversal,
    // ensure a trailing slash so ListObjectsV2 lists *inside* the directory.
    let prefix = String(event.queryStringParameters?.prefix ?? "").replace(/^\/+/, "");
    if (prefix.includes("..") || prefix.includes("\\")) {
      return error(400, "Invalid prefix");
    }
    if (prefix && !prefix.endsWith("/")) prefix += "/";

    const token = event.queryStringParameters?.token;
    const res = await listDir(bucket, prefix, token);

    return ok({
      bucket,
      prefix,
      folders: res.folders.map((k) => ({
        // Trim the current prefix + trailing slash to get the leaf folder name.
        name: k.slice(prefix.length).replace(/\/$/, ""),
        path: k, // full S3 key, e.g. "Video/Movies/" — becomes the mount prefix
      })),
      files: res.files.map((f) => ({
        name: f.key.slice(prefix.length),
        path: f.key,
        size: f.size,
        lastModified: f.lastModified,
      })),
      truncated: res.truncated,
      nextToken: res.nextContinuationToken,
    });
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

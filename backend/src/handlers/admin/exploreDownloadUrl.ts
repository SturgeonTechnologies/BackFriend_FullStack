import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { requireAdmin } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { presignGet } from "../../lib/s3";

/** Reject empty keys, traversal, and directory keys (trailing slash). */
function validKey(key: string): boolean {
  return !!key && !key.includes("..") && !key.includes("\\") && !key.endsWith("/");
}

/**
 * GET /admin/explore/download-url?key=<fullS3Key>
 * Admin-only presigned GET for any file in the shares bucket (raw key).
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    requireAdmin(event);
    const bucket = process.env.SHARES_BUCKET;
    if (!bucket) return error(500, "SHARES_BUCKET not configured");

    const key = String(event.queryStringParameters?.key ?? "").replace(/^\/+/, "");
    if (!validKey(key)) return error(400, "A valid file key is required");

    // 1hr, not the 5min default -- this URL also feeds inline video/audio
    // preview and thumbnailing (FileThumb/MediaPlayer), which need enough
    // headroom to actually watch/scrub something without the link expiring
    // mid-playback.
    const expiresInSeconds = 3600;
    const filename = key.split("/").pop();
    const forceDownload = event.queryStringParameters?.download === "1";
    const url = await presignGet(bucket, key, expiresInSeconds, forceDownload ? filename : undefined);
    return ok({ downloadUrl: url, expiresInSeconds, filename });
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { requireAdmin } from "../../lib/auth";
import { ok, error, parseJson } from "../../lib/response";
import { putFolderMarker } from "../../lib/s3";

interface Body {
  prefix?: string; // current explorer prefix, e.g. "Video/" ("" = bucket root)
  name: string;    // new directory name (single segment)
}

/**
 * POST /admin/explore/folder  { prefix, name }
 *
 * Admin-only. Creates an empty "directory" (zero-byte marker) at
 * `${prefix}${name}/` in the shares bucket so it shows up in the explorer and
 * can be mounted. Bucket is always SHARES_BUCKET (same reasoning as
 * exploreBucket — the role's write grant is scoped to that one bucket).
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    requireAdmin(event);

    const bucket = process.env.SHARES_BUCKET;
    if (!bucket) return error(500, "SHARES_BUCKET not configured");

    const body = parseJson<Body>(event.body);

    // Normalize the parent prefix (strip leading slashes, reject traversal,
    // ensure a trailing slash unless empty) — mirrors exploreBucket.
    let prefix = String(body.prefix ?? "").replace(/^\/+/, "");
    if (prefix.includes("..") || prefix.includes("\\")) return error(400, "Invalid prefix");
    if (prefix && !prefix.endsWith("/")) prefix += "/";

    const name = String(body.name ?? "").trim();
    if (!name) return error(400, "A directory name is required");
    if (name.includes("/") || name.includes("\\") || name.includes("..") || name === ".") {
      return error(400, "Directory name can't contain slashes or '..'");
    }

    const key = `${prefix}${name}/`;
    await putFolderMarker(bucket, key);

    return ok({ ok: true, prefix: key });
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

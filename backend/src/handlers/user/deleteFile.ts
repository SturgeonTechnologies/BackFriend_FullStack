import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { requireAdmin } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { getMount, normalizeMountPath } from "../../lib/mounts";
import { deleteObject } from "../../lib/s3";

/**
 * DELETE /browse/{mountPath}/file?path=<relativePathToFile>
 *
 * Permanently deletes a file from S3 (the bucket is not versioned, so this is
 * irreversible). Admin-only. `path` is relative to the mount prefix and must
 * be a file (not a directory).
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = requireAdmin(event);

    const mountPath = normalizeMountPath(decodeURIComponent(event.pathParameters?.mountPath ?? ""));
    if (!mountPath) return error(400, "mountPath is required");

    const rel = String(event.queryStringParameters?.path ?? "").replace(/^\/+/, "");
    if (!rel) return error(400, "path query parameter is required");
    if (rel.includes("..") || rel.includes("\\") || rel.endsWith("/")) {
      return error(400, "Invalid path");
    }

    const mount = await getMount(mountPath);
    if (!mount) return error(404, "Mount not found");

    const key = mount.prefix + rel;
    await deleteObject(mount.bucket, key);

    console.log(JSON.stringify({
      evt: "delete-file",
      user: caller.email ?? caller.sub,
      mount: mount.mountPath,
      path: rel,
    }));

    return ok({ ok: true });
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { getCaller } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { canSeeMount, getMount, normalizeMountPath } from "../../lib/mounts";
import { presignGet } from "../../lib/s3";

/**
 * GET /browse/{mountPath}/download-url?path=<relativePathToFile>
 *
 * The `path` is relative to the mount's prefix (what `browseList` returned).
 * We refuse anything that looks like a traversal or a directory.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = getCaller(event);
    if (!caller.sub) return error(401, "Unauthorized");

    const mountPath = normalizeMountPath(decodeURIComponent(event.pathParameters?.mountPath ?? ""));
    if (!mountPath) return error(400, "mountPath is required");

    const rel = String(event.queryStringParameters?.path ?? "").replace(/^\/+/, "");
    if (!rel) return error(400, "path query parameter is required");
    if (rel.includes("..") || rel.includes("\\") || rel.endsWith("/")) {
      return error(400, "Invalid path");
    }

    const mount = await getMount(mountPath);
    if (!mount) return error(404, "Mount not found");
    if (!canSeeMount(caller, mount)) return error(403, "Forbidden");

    const key = mount.prefix + rel;
    const url = await presignGet(mount.bucket, key, 300);

    console.log(JSON.stringify({
      evt: "download",
      user: caller.email ?? caller.sub,
      mount: mount.mountPath,
      path: rel,
    }));

    return ok({
      downloadUrl: url,
      expiresInSeconds: 300,
      filename: rel.split("/").pop(),
    });
  } catch (e) {
    console.error(e);
    return error(500, "Internal error");
  }
};

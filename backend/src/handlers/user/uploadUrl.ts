import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { getCaller } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { canSeeMount, getMount, normalizeMountPath } from "../../lib/mounts";
import { presignPut } from "../../lib/s3";

/**
 * POST /browse/{mountPath}/upload-url?path=<relativePathToFile>
 *
 * Returns a short-lived presigned PUT URL so anyone with access to the mount
 * can upload a file directly to S3 (browser → S3, no Lambda payload limit).
 * `path` is relative to the mount prefix and is the destination filename
 * (optionally within a subdirectory the user is browsing).
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
    const url = await presignPut(mount.bucket, key, 3600);

    console.log(JSON.stringify({
      evt: "upload-url",
      user: caller.email ?? caller.sub,
      mount: mount.mountPath,
      path: rel,
    }));

    return ok({ uploadUrl: url, expiresInSeconds: 3600 });
  } catch (e) {
    console.error(e);
    return error(500, "Internal error");
  }
};

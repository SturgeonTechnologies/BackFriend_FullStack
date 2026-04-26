import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { getCaller } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { canSeeMount, getMount, normalizeMountPath, safeSubpath } from "../../lib/mounts";
import { listDir } from "../../lib/s3";

/**
 * GET /browse/{mountPath}?path=<subpath>&token=<continuationToken>
 *
 * Returns folders (CommonPrefixes) and files at one directory level,
 * relative to the mount's root prefix.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = getCaller(event);
    if (!caller.sub) return error(401, "Unauthorized");

    const mountPath = normalizeMountPath(decodeURIComponent(event.pathParameters?.mountPath ?? ""));
    if (!mountPath) return error(400, "mountPath is required");

    const mount = await getMount(mountPath);
    if (!mount) return error(404, "Mount not found");
    if (!canSeeMount(caller, mount)) return error(403, "Forbidden");

    let sub = "";
    try {
      sub = safeSubpath(event.queryStringParameters?.path ?? "");
    } catch {
      return error(400, "Invalid path");
    }

    const fullPrefix = mount.prefix + sub;
    const token = event.queryStringParameters?.token;

    const res = await listDir(mount.bucket, fullPrefix, token);

    // Convert S3 keys to paths *relative to the mount prefix*, so the client
    // never needs to know the raw S3 layout.
    const toRelative = (key: string) =>
      key.startsWith(mount.prefix) ? key.slice(mount.prefix.length) : key;

    return ok({
      mount: {
        mountPath: mount.mountPath,
        displayName: mount.displayName,
      },
      path: sub,
      folders: res.folders.map((k) => ({
        name: k.slice(fullPrefix.length).replace(/\/$/, ""),
        path: toRelative(k), // e.g. "NES/"
      })),
      files: res.files.map((f) => ({
        name: f.key.slice(fullPrefix.length),
        path: toRelative(f.key),
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

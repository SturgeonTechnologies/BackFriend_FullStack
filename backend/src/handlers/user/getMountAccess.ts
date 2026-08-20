import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { getCaller } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { getMount, normalizeMountPath, isMountAdmin } from "../../lib/mounts";

/**
 * GET /browse/{mountPath}/access
 *
 * Returns a mount's current allowedEmails + mountAdmins. Restricted to that
 * mount's own admins (site admins, or emails in its mountAdmins list) --
 * this is a narrower check than canSeeMount (being able to browse a mount
 * doesn't mean being able to see/manage who else can).
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
    if (!isMountAdmin(caller, mount)) return error(403, "Forbidden");

    return ok({
      allowedEmails: mount.allowedEmails ?? [],
      mountAdmins: mount.mountAdmins ?? [],
    });
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

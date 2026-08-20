import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, MOUNTS_TABLE } from "../../lib/db";
import { getCaller } from "../../lib/auth";
import { ok, error, parseJson } from "../../lib/response";
import { getMount, normalizeMountPath, normalizeAllowedEmails, isMountAdmin } from "../../lib/mounts";
import { ensureInvitesFor } from "../../lib/invites";

interface Body {
  /** Replace the allowed-emails list. Empty/omitted-with-key removes it. */
  allowedEmails?: string[] | null;
}

/**
 * PUT /browse/{mountPath}/access
 *
 * Self-service allowedEmails update for a mount's own admins (site admins,
 * or emails in the mount's mountAdmins list). Deliberately narrower than
 * admin/updateMount.ts: this can ONLY set allowedEmails -- never mountAdmins,
 * displayName, description, bucket, or prefix -- so a mount-admin can grant
 * or revoke viewer access to their own directory without being able to hand
 * out mount-admin rights or touch anything else about the mount.
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

    const body = parseJson<Body>(event.body);
    const cleaned = normalizeAllowedEmails(body.allowedEmails);

    const res = await ddb.send(
      new UpdateCommand({
        TableName: MOUNTS_TABLE,
        Key: { mountPath },
        ...(cleaned
          ? {
              UpdateExpression: "SET #ae = :ae",
              ExpressionAttributeNames: { "#ae": "allowedEmails" },
              ExpressionAttributeValues: { ":ae": cleaned },
            }
          : {
              UpdateExpression: "REMOVE #ae",
              ExpressionAttributeNames: { "#ae": "allowedEmails" },
            }),
        ReturnValues: "ALL_NEW",
      }),
    );

    const autoInvited = cleaned ? await ensureInvitesFor(cleaned, caller.email ?? caller.sub) : [];

    return ok({ allowedEmails: (res.Attributes as { allowedEmails?: string[] } | undefined)?.allowedEmails ?? [], autoInvited });
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

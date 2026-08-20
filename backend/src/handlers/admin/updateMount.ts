import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, MOUNTS_TABLE } from "../../lib/db";
import { requireAdmin } from "../../lib/auth";
import { ok, error, parseJson } from "../../lib/response";
import { getMount, normalizeMountPath, normalizeAllowedEmails } from "../../lib/mounts";
import { ensureInvitesFor } from "../../lib/invites";

interface Body {
  /** Replace the allowed-emails list. Empty/omitted-with-key removes it (mount
   *  becomes admins-only). Leave the key out entirely to not touch it. */
  allowedEmails?: string[] | null;
  /** Replace the mount-admins list (see lib/mounts.ts isMountAdmin). Same
   *  empty/omitted-with-key-removes semantics as allowedEmails. Site-admin
   *  only (this whole handler is requireAdmin-gated) -- a mount-admin can't
   *  reach this endpoint to grant themselves or anyone else more mounts. */
  mountAdmins?: string[] | null;
  displayName?: string;
  description?: string;
}

/**
 * PUT /admin/mounts/{mountPath}  — update a mount's access list (and optionally
 * display name / description). Admin-only. Does not move S3 data.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = requireAdmin(event);

    const mountPath = normalizeMountPath(decodeURIComponent(event.pathParameters?.mountPath ?? ""));
    if (!mountPath) return error(400, "mountPath is required");

    const mount = await getMount(mountPath);
    if (!mount) return error(404, "Mount not found");

    const body = parseJson<Body>(event.body);

    const sets: string[] = [];
    const removes: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    let grantedEmails: string[] = [];

    if ("allowedEmails" in body) {
      const cleaned = normalizeAllowedEmails(body.allowedEmails);
      if (cleaned) {
        grantedEmails.push(...cleaned);
        sets.push("#ae = :ae");
        names["#ae"] = "allowedEmails";
        values[":ae"] = cleaned;
      } else {
        removes.push("#ae");
        names["#ae"] = "allowedEmails";
      }
    }
    if ("mountAdmins" in body) {
      const cleaned = normalizeAllowedEmails(body.mountAdmins);
      if (cleaned) {
        grantedEmails.push(...cleaned);
        sets.push("#ma = :ma");
        names["#ma"] = "mountAdmins";
        values[":ma"] = cleaned;
      } else {
        removes.push("#ma");
        names["#ma"] = "mountAdmins";
      }
    }
    if (typeof body.displayName === "string" && body.displayName.trim()) {
      sets.push("#dn = :dn");
      names["#dn"] = "displayName";
      values[":dn"] = body.displayName.trim();
    }
    if (typeof body.description === "string") {
      sets.push("#desc = :desc");
      names["#desc"] = "description";
      values[":desc"] = body.description.trim();
    }

    if (!sets.length && !removes.length) return error(400, "Nothing to update");

    const clauses: string[] = [];
    if (sets.length) clauses.push("SET " + sets.join(", "));
    if (removes.length) clauses.push("REMOVE " + removes.join(", "));

    const res = await ddb.send(
      new UpdateCommand({
        TableName: MOUNTS_TABLE,
        Key: { mountPath },
        UpdateExpression: clauses.join(" "),
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
        ReturnValues: "ALL_NEW",
      }),
    );

    // Auto-invite anyone newly granted access who isn't invited/joined yet.
    const uniqueGranted = [...new Set(grantedEmails)];
    const autoInvited = uniqueGranted.length
      ? await ensureInvitesFor(uniqueGranted, caller.email ?? caller.sub)
      : [];

    return ok({ ...res.Attributes, autoInvited });
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

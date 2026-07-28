import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, MOUNTS_TABLE } from "../../lib/db";
import { requireAdmin } from "../../lib/auth";
import { ok, error, parseJson } from "../../lib/response";
import { getMount, normalizeMountPath, normalizeAllowedEmails } from "../../lib/mounts";

interface Body {
  /** Replace the allowed-emails list. Empty/omitted-with-key removes it (mount
   *  becomes admins-only). Leave the key out entirely to not touch it. */
  allowedEmails?: string[] | null;
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
    requireAdmin(event);

    const mountPath = normalizeMountPath(decodeURIComponent(event.pathParameters?.mountPath ?? ""));
    if (!mountPath) return error(400, "mountPath is required");

    const mount = await getMount(mountPath);
    if (!mount) return error(404, "Mount not found");

    const body = parseJson<Body>(event.body);

    const sets: string[] = [];
    const removes: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};

    if ("allowedEmails" in body) {
      const cleaned = normalizeAllowedEmails(body.allowedEmails);
      if (cleaned) {
        sets.push("#ae = :ae");
        names["#ae"] = "allowedEmails";
        values[":ae"] = cleaned;
      } else {
        removes.push("#ae");
        names["#ae"] = "allowedEmails";
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

    return ok(res.Attributes);
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

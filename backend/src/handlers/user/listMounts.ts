import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, MOUNTS_TABLE, MountRow } from "../../lib/db";
import { getCaller } from "../../lib/auth";
import { canSeeMount } from "../../lib/mounts";
import { ok, error } from "../../lib/response";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = getCaller(event);
    if (!caller.sub) return error(401, "Unauthorized");

    const res = await ddb.send(new ScanCommand({ TableName: MOUNTS_TABLE, Limit: 200 }));
    const allMounts = (res.Items ?? []) as MountRow[];

    const visible = allMounts.filter((m) => canSeeMount(caller, m));

    const mounts = visible
      .map((m) => ({
        mountPath: m.mountPath,
        displayName: m.displayName,
        description: m.description ?? "",
        // Admins also see who the mount is shared with so they can manage it.
        ...(caller.isAdmin ? { allowedEmails: m.allowedEmails ?? [] } : {}),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return ok({ mounts });
  } catch (e) {
    console.error(e);
    return error(500, "Internal error");
  }
};

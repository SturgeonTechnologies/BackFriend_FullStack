import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, MOUNTS_TABLE } from "../../lib/db";
import { getCaller } from "../../lib/auth";
import { ok, error } from "../../lib/response";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = getCaller(event);
    if (!caller.sub) return error(401, "Unauthorized");

    const res = await ddb.send(new ScanCommand({ TableName: MOUNTS_TABLE, Limit: 200 }));
    const mounts = (res.Items ?? [])
      .map((m) => ({
        mountPath: m.mountPath,
        displayName: m.displayName,
        description: m.description ?? "",
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return ok({ mounts });
  } catch (e) {
    console.error(e);
    return error(500, "Internal error");
  }
};

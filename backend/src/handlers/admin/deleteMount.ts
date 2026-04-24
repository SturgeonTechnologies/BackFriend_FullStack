import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, MOUNTS_TABLE } from "../../lib/db";
import { requireAdmin } from "../../lib/auth";
import { noContent, error } from "../../lib/response";
import { normalizeMountPath } from "../../lib/mounts";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    requireAdmin(event);
    const mountPath = normalizeMountPath(decodeURIComponent(event.pathParameters?.mountPath ?? ""));
    if (!mountPath) return error(400, "mountPath path parameter is required");

    await ddb.send(new DeleteCommand({ TableName: MOUNTS_TABLE, Key: { mountPath } }));
    return noContent();
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

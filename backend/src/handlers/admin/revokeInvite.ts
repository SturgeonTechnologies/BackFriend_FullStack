import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, INVITES_TABLE } from "../../lib/db";
import { requireAdmin } from "../../lib/auth";
import { noContent, error } from "../../lib/response";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    requireAdmin(event);
    const email = decodeURIComponent(event.pathParameters?.email ?? "").toLowerCase();
    if (!email) return error(400, "email path parameter is required");

    await ddb.send(new DeleteCommand({ TableName: INVITES_TABLE, Key: { email } }));
    return noContent();
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

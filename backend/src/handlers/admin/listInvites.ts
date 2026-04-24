import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, INVITES_TABLE } from "../../lib/db";
import { requireAdmin } from "../../lib/auth";
import { ok, error } from "../../lib/response";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    requireAdmin(event);
    const res = await ddb.send(new ScanCommand({ TableName: INVITES_TABLE, Limit: 500 }));
    const items = (res.Items ?? []).map((i) => ({
      email: i.email,
      groups: i.groups ?? [],
      createdBy: i.createdBy,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      redeemedAt: i.redeemedAt ?? null,
    }));
    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return ok({ invites: items });
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

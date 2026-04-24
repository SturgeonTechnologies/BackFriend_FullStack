import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, INVITES_TABLE } from "../../lib/db";
import { requireAdmin } from "../../lib/auth";
import { created, error, parseJson } from "../../lib/response";

interface Body {
  email: string;
  groups?: string[]; // e.g. ["admins"]
  ttlDays?: number;
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = requireAdmin(event);
    const body = parseJson<Body>(event.body);

    if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return error(400, "A valid email is required");
    }

    const email = body.email.toLowerCase();
    const ttlDays = body.ttlDays ?? 14;
    const now = new Date();
    const expires = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

    const item = {
      email,
      groups: body.groups && body.groups.length ? body.groups : [],
      createdBy: caller.email ?? caller.sub,
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      ttl: Math.floor(expires.getTime() / 1000),
      redeemedAt: null,
    };

    await ddb.send(
      new PutCommand({
        TableName: INVITES_TABLE,
        Item: item,
        // Allow overwriting only if the existing invite was redeemed or is expired.
        ConditionExpression:
          "attribute_not_exists(email) OR attribute_exists(redeemedAt) OR expiresAt < :now",
        ExpressionAttributeValues: { ":now": now.toISOString() },
      }),
    );

    const siteOrigin = process.env.SITE_ORIGIN ?? "http://localhost:5173";
    return created({
      email,
      expiresAt: item.expiresAt,
      groups: item.groups,
      signupUrl: siteOrigin, // invitee just goes to the site and clicks "Sign in with Google"
    });
  } catch (e: any) {
    if (e.name === "ConditionalCheckFailedException") {
      return error(409, "An active invite already exists for this email. Revoke it first.");
    }
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

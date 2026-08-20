import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, PUBLIC_SHARES_TABLE, BUCKET_PUBLIC_PARTITION } from "../../lib/db";
import { getCaller } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { RESERVED_PERSONAL_PREFIX } from "../../lib/mounts";

/**
 * DELETE /archive/public?key=<key>
 *
 * Self-service revoke of public sharing for the caller's own archived file —
 * same ownership check as the other /archive/* routes. Idempotent (deleting
 * a non-existent share is a no-op), mirrors admin/unsetPublic.ts.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = getCaller(event);
    if (!caller.sub) return error(401, "Unauthorized");
    if (!caller.email) return error(400, "Account has no email on file");

    const key = String(event.queryStringParameters?.key ?? "").trim();
    const ownPrefix = `${RESERVED_PERSONAL_PREFIX}${caller.email.toLowerCase()}/`;
    if (!key || !key.startsWith(ownPrefix) || key.includes("..")) {
      return error(403, "Can only modify your own archived content");
    }

    await ddb.send(
      new DeleteCommand({ TableName: PUBLIC_SHARES_TABLE, Key: { mountPath: BUCKET_PUBLIC_PARTITION, path: key } }),
    );

    return ok({ public: false });
  } catch (e) {
    console.error(e);
    return error(500, "Internal error");
  }
};

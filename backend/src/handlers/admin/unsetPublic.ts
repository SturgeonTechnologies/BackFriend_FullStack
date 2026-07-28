import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, PUBLIC_SHARES_TABLE } from "../../lib/db";
import { requireAdmin } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { normalizeMountPath } from "../../lib/mounts";

/**
 * DELETE /browse/{mountPath}/public?path=<relativePathToFile>
 *
 * Admin-only. Revokes public sharing for a file — the token immediately stops
 * resolving. Idempotent (deleting a non-existent share is a no-op).
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    requireAdmin(event);

    const mountPath = normalizeMountPath(decodeURIComponent(event.pathParameters?.mountPath ?? ""));
    if (!mountPath) return error(400, "mountPath is required");

    const rel = String(event.queryStringParameters?.path ?? "").replace(/^\/+/, "");
    if (!rel) return error(400, "path query parameter is required");

    await ddb.send(
      new DeleteCommand({ TableName: PUBLIC_SHARES_TABLE, Key: { mountPath, path: rel } }),
    );

    return ok({ public: false });
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { randomBytes } from "node:crypto";
import { GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, PUBLIC_SHARES_TABLE, BUCKET_PUBLIC_PARTITION } from "../../lib/db";
import { requireAdmin } from "../../lib/auth";
import { ok, error } from "../../lib/response";

function validKey(key: string): boolean {
  return !!key && !key.includes("..") && !key.includes("\\") && !key.endsWith("/");
}

/**
 * POST   /admin/explore/public?key=<fullS3Key>  → make the file public
 * DELETE /admin/explore/public?key=<fullS3Key>  → revoke
 *
 * Admin-only per-file public sharing addressed by raw S3 key (the explorer has
 * no mount). Stored in PublicSharesTable under the reserved
 * BUCKET_PUBLIC_PARTITION so the shared /public/{token} resolver works
 * unchanged (it keys off the stored bucket + key).
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = requireAdmin(event);
    const bucket = process.env.SHARES_BUCKET;
    if (!bucket) return error(500, "SHARES_BUCKET not configured");

    const key = String(event.queryStringParameters?.key ?? "").replace(/^\/+/, "");
    if (!validKey(key)) return error(400, "A valid file key is required");

    const method = event.requestContext.http.method;
    const Key = { mountPath: BUCKET_PUBLIC_PARTITION, path: key };

    if (method === "DELETE") {
      await ddb.send(new DeleteCommand({ TableName: PUBLIC_SHARES_TABLE, Key }));
      return ok({ public: false });
    }

    const siteOrigin = process.env.SITE_ORIGIN ?? "";
    // NOT /api/public/... -- see setPublic.ts's publicUrlFor comment; same fix.
    const publicUrlFor = (t: string) => `${siteOrigin}/public/${t}`;

    const existing = (
      await ddb.send(new GetCommand({ TableName: PUBLIC_SHARES_TABLE, Key }))
    ).Item;
    if (existing?.token) {
      return ok({ public: true, token: existing.token, publicUrl: publicUrlFor(existing.token) });
    }

    const token = randomBytes(16).toString("base64url");
    await ddb.send(
      new PutCommand({
        TableName: PUBLIC_SHARES_TABLE,
        Item: {
          mountPath: BUCKET_PUBLIC_PARTITION,
          path: key,
          token,
          bucket,
          key,
          createdBy: caller.email ?? caller.sub,
          createdAt: new Date().toISOString(),
        },
      }),
    );
    return ok({ public: true, token, publicUrl: publicUrlFor(token) });
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { randomBytes } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, PUBLIC_SHARES_TABLE } from "../../lib/db";
import { requireAdmin } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { getMount, normalizeMountPath } from "../../lib/mounts";

/**
 * POST /browse/{mountPath}/public?path=<relativePathToFile>
 *
 * Admin-only. Marks a single file publicly shareable: mints (or reuses) an
 * opaque token that the unauthenticated /public/{token} endpoint resolves to a
 * short-lived presigned GET. Idempotent — re-publishing returns the same token.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = requireAdmin(event);

    const mountPath = normalizeMountPath(decodeURIComponent(event.pathParameters?.mountPath ?? ""));
    if (!mountPath) return error(400, "mountPath is required");

    const rel = String(event.queryStringParameters?.path ?? "").replace(/^\/+/, "");
    if (!rel) return error(400, "path query parameter is required");
    if (rel.includes("..") || rel.includes("\\") || rel.endsWith("/")) {
      return error(400, "Invalid path");
    }

    const mount = await getMount(mountPath);
    if (!mount) return error(404, "Mount not found");

    const siteOrigin = process.env.SITE_ORIGIN ?? "";
    const publicUrlFor = (token: string) => `${siteOrigin}/api/public/${token}`;

    // Reuse an existing token if the file is already public.
    const existing = (
      await ddb.send(new GetCommand({ TableName: PUBLIC_SHARES_TABLE, Key: { mountPath, path: rel } }))
    ).Item;
    if (existing?.token) {
      return ok({ public: true, token: existing.token, publicUrl: publicUrlFor(existing.token) });
    }

    const token = randomBytes(16).toString("base64url");
    await ddb.send(
      new PutCommand({
        TableName: PUBLIC_SHARES_TABLE,
        Item: {
          mountPath,
          path: rel,
          token,
          bucket: mount.bucket,
          key: mount.prefix + rel,
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

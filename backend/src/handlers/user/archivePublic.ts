import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { randomBytes } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, PUBLIC_SHARES_TABLE, BUCKET_PUBLIC_PARTITION } from "../../lib/db";
import { getCaller } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { RESERVED_PERSONAL_PREFIX } from "../../lib/mounts";

/**
 * POST /archive/public?key=<key returned by /archive/upload-url>
 *
 * Self-service equivalent of admin/setPublic.ts's public-token mechanism, for
 * personal archive uploads (which aren't under any admin-curated mount, so
 * setPublic's mount lookup doesn't apply here). Reuses the exact same
 * PUBLIC_SHARES_TABLE + resolvePublic.ts resolution path, and the SAME
 * raw-key convention admin/explorePublic.ts already established for this
 * "public share addressed by bucket+key, no mount" case
 * (BUCKET_PUBLIC_PARTITION) rather than inventing a second one.
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
      return error(403, "Can only publish your own archived content");
    }

    const mountPath = BUCKET_PUBLIC_PARTITION;

    // Reuse an existing token if this key is already public (mirrors
    // admin/setPublic.ts's idempotent behavior).
    const existing = (
      await ddb.send(new GetCommand({ TableName: PUBLIC_SHARES_TABLE, Key: { mountPath, path: key } }))
    ).Item;
    const siteOrigin = process.env.SITE_ORIGIN ?? "";
    const publicUrlFor = (token: string) => `${siteOrigin}/public/${token}`;

    if (existing?.token) {
      return ok({ token: existing.token, publicUrl: publicUrlFor(existing.token) });
    }

    const token = randomBytes(16).toString("base64url");
    await ddb.send(
      new PutCommand({
        TableName: PUBLIC_SHARES_TABLE,
        Item: {
          mountPath,
          path: key,
          token,
          bucket: process.env.SHARES_BUCKET!,
          key,
          createdBy: caller.email,
          createdAt: new Date().toISOString(),
        },
      }),
    );

    return ok({ token, publicUrl: publicUrlFor(token) });
  } catch (e) {
    console.error(e);
    return error(500, "Internal error");
  }
};

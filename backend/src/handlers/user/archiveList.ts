import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getCaller } from "../../lib/auth";
import { ddb, PUBLIC_SHARES_TABLE, BUCKET_PUBLIC_PARTITION } from "../../lib/db";
import { ok, error } from "../../lib/response";
import { listDir } from "../../lib/s3";
import { RESERVED_PERSONAL_PREFIX } from "../../lib/mounts";

/**
 * GET /archive/list
 *
 * Self-service listing of the caller's own user_sharing_default/<email>/
 * folder — no mount, no admin gate, same as the other /archive/* routes.
 * Archive uploads are always flat (archiveUploadUrl.ts rejects "/" in
 * filenames), but this uses the same delimiter-based listDir() the mount
 * browser uses rather than assuming that, in case that ever changes.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = getCaller(event);
    if (!caller.sub) return error(401, "Unauthorized");
    if (!caller.email) return error(400, "Account has no email on file");

    const prefix = `${RESERVED_PERSONAL_PREFIX}${caller.email.toLowerCase()}/`;
    const token = event.queryStringParameters?.token;
    const res = await listDir(process.env.SHARES_BUCKET!, prefix, token);

    // Public-share state, same BUCKET_PUBLIC_PARTITION convention
    // archivePublic.ts writes to (keyed by the full S3 key, no mount).
    const publicTokens = new Map<string, string>();
    const shares = await ddb.send(
      new QueryCommand({
        TableName: PUBLIC_SHARES_TABLE,
        KeyConditionExpression: "mountPath = :m",
        ExpressionAttributeValues: { ":m": BUCKET_PUBLIC_PARTITION },
      }),
    );
    for (const s of shares.Items ?? []) {
      if (s.path && s.token) publicTokens.set(String(s.path), String(s.token));
    }
    const siteOrigin = process.env.SITE_ORIGIN ?? "";

    return ok({
      files: res.files.map((f) => {
        const shareToken = publicTokens.get(f.key);
        return {
          name: f.key.slice(prefix.length),
          key: f.key,
          size: f.size,
          lastModified: f.lastModified,
          public: !!shareToken,
          publicUrl: shareToken ? `${siteOrigin}/public/${shareToken}` : undefined,
        };
      }),
      truncated: res.truncated,
      nextToken: res.nextContinuationToken,
    });
  } catch (e) {
    console.error(e);
    return error(500, "Internal error");
  }
};

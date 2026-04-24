import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, MOUNTS_TABLE } from "../../lib/db";
import { requireAdmin } from "../../lib/auth";
import { created, error, parseJson } from "../../lib/response";
import { isValidMountPath, normalizeMountPath, normalizePrefix } from "../../lib/mounts";

interface Body {
  mountPath: string;   // e.g. "roms"
  bucket?: string;     // defaults to SHARES_BUCKET
  prefix: string;      // e.g. "Video_Game_ROMs/"
  displayName: string; // e.g. "Video Game ROMs"
  description?: string;
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = requireAdmin(event);
    const body = parseJson<Body>(event.body);

    const mountPath = normalizeMountPath(body.mountPath);
    if (!isValidMountPath(mountPath)) {
      return error(400, "mountPath must match ^[a-z0-9][a-z0-9_-]{0,31}$");
    }
    if (!body.displayName?.trim()) return error(400, "displayName is required");

    const bucket = body.bucket?.trim() || process.env.SHARES_BUCKET!;
    const prefix = normalizePrefix(body.prefix ?? "");

    const item = {
      mountPath,
      bucket,
      prefix,
      displayName: body.displayName.trim(),
      description: body.description?.trim() ?? "",
      createdBy: caller.email ?? caller.sub,
      createdAt: new Date().toISOString(),
    };

    await ddb.send(
      new PutCommand({
        TableName: MOUNTS_TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(mountPath)",
      }),
    );

    return created(item);
  } catch (e: any) {
    if (e.name === "ConditionalCheckFailedException") {
      return error(409, "A mount with that path already exists");
    }
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

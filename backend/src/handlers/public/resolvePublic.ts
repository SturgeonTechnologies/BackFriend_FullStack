import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, PUBLIC_SHARES_TABLE, PublicShareRow } from "../../lib/db";
import { presignGet } from "../../lib/s3";

/**
 * GET /public/{token}   (UNAUTHENTICATED — no JWT authorizer on this route)
 *
 * Resolves an opaque public-share token to a fresh, short-lived presigned S3
 * GET and 302-redirects the browser to it. The bucket stays private; the only
 * way to reach a file is a valid, un-revoked token. Every hit is logged.
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const token = event.pathParameters?.token;
  if (!token) return { statusCode: 400, body: "Missing token" };

  const res = await ddb.send(
    new QueryCommand({
      TableName: PUBLIC_SHARES_TABLE,
      IndexName: "TokenIndex",
      KeyConditionExpression: "#t = :t",
      ExpressionAttributeNames: { "#t": "token" },
      ExpressionAttributeValues: { ":t": token },
      Limit: 1,
    }),
  );
  const share = res.Items?.[0] as PublicShareRow | undefined;
  if (!share) {
    return { statusCode: 404, body: "This link is invalid or has been revoked." };
  }

  const url = await presignGet(share.bucket, share.key, 300);

  console.log(JSON.stringify({ evt: "public-download", token, mount: share.mountPath, key: share.key }));

  return {
    statusCode: 302,
    headers: { Location: url, "Cache-Control": "no-store" },
    body: "",
  };
};

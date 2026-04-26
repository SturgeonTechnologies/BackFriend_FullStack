import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

const ADMIN_GROUP = process.env.ADMIN_GROUP ?? "admins";

export interface CallerIdentity {
  sub: string;
  email?: string;
  groups: string[];
  isAdmin: boolean;
}

/**
 * Extract caller identity from the JWT authorizer claims.
 * The HTTP API JWT authorizer puts claims under requestContext.authorizer.jwt.claims.
 */
export function getCaller(event: APIGatewayProxyEventV2WithJWTAuthorizer): CallerIdentity {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const sub = String(claims.sub ?? "");

  // "cognito:groups" can arrive in three shapes depending on the runtime
  // path:
  //   1. Actual string[] — e.g. when the Lambda is invoked outside HTTP API,
  //      or when claims are deserialized from JSON.
  //   2. Comma-separated string "[admins, viewers]" — some serializers.
  //   3. Space-separated string "[admins viewers]" — this is what API
  //      Gateway HTTP API v2's JWT authorizer actually emits when it
  //      forwards array claims to the Lambda. It uses Java's default
  //      Object[].toString() formatting (brackets + space-separated, no
  //      commas).
  // We split on both commas AND whitespace to handle all three.
  const raw = claims["cognito:groups"];
  let groups: string[] = [];
  if (Array.isArray(raw)) groups = raw.map(String);
  else if (typeof raw === "string" && raw.length > 0) {
    groups = raw
      .replace(/[[\]]/g, "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return {
    sub,
    email: claims.email ? String(claims.email) : undefined,
    groups,
    isAdmin: groups.includes(ADMIN_GROUP),
  };
}

export function requireAdmin(event: APIGatewayProxyEventV2WithJWTAuthorizer): CallerIdentity {
  const caller = getCaller(event);
  if (!caller.isAdmin) {
    const err = new Error("Admin privileges required");
    (err as any).statusCode = 403;
    throw err;
  }
  return caller;
}

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

  // "cognito:groups" can arrive as string[] or as a stringified list.
  const raw = claims["cognito:groups"];
  let groups: string[] = [];
  if (Array.isArray(raw)) groups = raw.map(String);
  else if (typeof raw === "string" && raw.length > 0) {
    // Sometimes serialized as "[admins, viewers]" — be tolerant.
    groups = raw.replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
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

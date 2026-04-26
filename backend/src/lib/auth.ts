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

  // "cognito:groups" can arrive in several shapes depending on the runtime
  // path. We log the raw shape (DIAG_AUTH_GROUPS) once per request so we
  // can confirm what API Gateway is actually sending — remove the log
  // after the auth flow is confirmed working.
  const raw = claims["cognito:groups"];
  console.log(
    "DIAG_AUTH_GROUPS",
    JSON.stringify({
      raw,
      typeof: typeof raw,
      isArray: Array.isArray(raw),
    }),
  );

  let groups: string[] = [];
  if (Array.isArray(raw)) {
    groups = raw.map(String);
  } else if (typeof raw === "string" && raw.length > 0) {
    // Strategy 1: try JSON.parse — handles JSON-encoded array '["a","b"]'.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // not JSON — fall through to the regex fallback
    }
    if (Array.isArray(parsed)) {
      groups = (parsed as unknown[]).map(String);
    } else {
      // Strategy 2: regex fallback. Strip brackets/quotes/braces, then
      // split on either commas or whitespace. This handles:
      //   "[admins, viewers]"     (comma-separated)
      //   "[admins viewers]"      (Java toString — what HTTP API v2 emits)
      //   "admins,viewers"        (no brackets)
      //   "admins viewers"        (no brackets, space-separated)
      groups = raw
        .replace(/[[\]"{}]/g, "")
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
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

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, INVITES_TABLE } from "../../lib/db";
import { requireAdmin } from "../../lib/auth";
import { ok, error } from "../../lib/response";
import { listAllUsers, listGroupMemberEmails } from "../../lib/cognito";

const ADMIN_GROUP = process.env.ADMIN_GROUP ?? "admins";

function bootstrapAdmins(): Set<string> {
  return new Set(
    (process.env.BOOTSTRAP_ADMIN_EMAILS ?? "")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

/** Pull the user pool id out of the JWT issuer claim (avoids an env var that
 *  would create a CloudFormation circular dependency). */
function userPoolIdFromEvent(event: APIGatewayProxyEventV2WithJWTAuthorizer): string | null {
  const iss = String(event.requestContext.authorizer?.jwt?.claims?.iss ?? "");
  const id = iss.split("/").pop();
  return id || null;
}

interface AccessEntry {
  email: string;
  role: "admin" | "member";
  status: "active" | "pending";
  expiresAt?: string; // pending only
}

/**
 * GET /admin/access
 *
 * Everyone who has access to the app: confirmed pool users (they can sign in)
 * plus still-pending invites (granted access, not yet redeemed). Admins are
 * flagged. Powers the Admin "Invites/Access" table.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    requireAdmin(event);
    const userPoolId = userPoolIdFromEvent(event);
    if (!userPoolId) return error(500, "Could not resolve user pool");

    const [users, adminGroup, invitesRes] = await Promise.all([
      listAllUsers(userPoolId),
      listGroupMemberEmails(userPoolId, ADMIN_GROUP),
      ddb.send(new ScanCommand({ TableName: INVITES_TABLE, Limit: 500 })),
    ]);

    const boot = bootstrapAdmins();
    const isAdmin = (email: string) => adminGroup.has(email) || boot.has(email);

    const byEmail = new Map<string, AccessEntry>();

    // Active pool users first.
    for (const u of users) {
      byEmail.set(u.email, {
        email: u.email,
        role: isAdmin(u.email) ? "admin" : "member",
        status: "active",
      });
    }

    // Pending invites (unredeemed + unexpired) for people not already active.
    const now = Date.now();
    for (const inv of invitesRes.Items ?? []) {
      const email = String(inv.email ?? "").toLowerCase();
      if (!email || byEmail.has(email)) continue;
      if (inv.redeemedAt) continue;
      if (inv.expiresAt && new Date(inv.expiresAt).getTime() < now) continue;
      const inviteAdmin = (inv.groups ?? []).map(String).includes(ADMIN_GROUP);
      byEmail.set(email, {
        email,
        role: inviteAdmin || isAdmin(email) ? "admin" : "member",
        status: "pending",
        expiresAt: inv.expiresAt ? String(inv.expiresAt) : undefined,
      });
    }

    const access = [...byEmail.values()].sort((a, b) =>
      a.role !== b.role ? (a.role === "admin" ? -1 : 1) : a.email.localeCompare(b.email),
    );

    return ok({ access });
  } catch (e: any) {
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

// Replaces src/lib/cognito.ts. The user list lives in Postgres, written by the
// gateway when someone first signs in (see authz.ts).
import { db } from "../pg";

export interface PoolUser {
  email: string;
  status?: string;
  enabled: boolean;
}

export async function listAllUsers(_pool: string): Promise<PoolUser[]> {
  const res = await db().query("SELECT email, enabled FROM users ORDER BY email");
  return res.rows.map((r) => ({ email: r.email, enabled: r.enabled, status: "CONFIRMED" }));
}

export async function listGroupMemberEmails(_pool: string, group: string): Promise<Set<string>> {
  const res = await db().query("SELECT email FROM users WHERE $1 = ANY(groups)", [group]);
  return new Set(res.rows.map((r) => r.email));
}

// Authentication and authorization for every API request. API Gateway's JWT
// authorizer and the Cognito triggers do this job in the cloud. Here it's one
// place, and every path that doesn't end in an explicit allow is a denial.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { PoolClient } from "pg";
import { config } from "./config";
import { db } from "./pg";
import { INVITES_TABLE } from "./shims/db";

export class Denied extends Error {
  constructor(public readonly statusCode: 401 | 403 | 413, message: string, public readonly reason: string) {
    super(message);
  }
}

export interface Caller {
  sub: string;
  email: string;
  groups: string[];
  isAdmin: boolean;
  claims: Record<string, unknown>;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksUrl: string | undefined;

function keySet() {
  const url = config().oidcJwksUrl;
  if (!jwks || jwksUrl !== url) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksUrl = url;
  }
  return jwks;
}

export async function verifyToken(header: string | undefined): Promise<JWTPayload> {
  const m = header?.match(/^Bearer ([A-Za-z0-9._~+/=-]+)$/);
  if (!m) throw new Denied(401, "Unauthorized", "no-token");
  const c = config();
  try {
    const { payload } = await jwtVerify(m[1], keySet(), {
      issuer: c.oidcIssuer,
      audience: c.oidcClientIds,
      algorithms: c.oidcAlgorithms,
      requiredClaims: ["sub", "exp", "iat"],
    });
    return payload;
  } catch (e: any) {
    throw new Denied(401, "Unauthorized", `bad-token:${e?.code ?? "unknown"}`);
  }
}

async function activeInvite(client: PoolClient, email: string) {
  const res = await client.query(
    "SELECT doc FROM items WHERE tbl = $1 AND pk = $2 AND sk = '' FOR UPDATE",
    [INVITES_TABLE, email],
  );
  const invite = res.rows[0]?.doc;
  if (!invite || invite.redeemedAt) return null;
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) return null;
  return invite as { groups?: string[] };
}

/**
 * Decides whether a verified token gets in, and with which groups.
 *
 *  - The email must be verified. Access rules are written against email
 *    addresses, so an unverified one could claim someone else's access.
 *  - The first sign-in needs a bootstrap-admin entry or a live invite, which is
 *    then used up. After that the Postgres row decides.
 *  - An email stays bound to the account that first claimed it. A second
 *    identity with the same address, or a changed address, is refused rather
 *    than inheriting anyone's access.
 *  - Groups come from Postgres, never from the token, and are read on every
 *    request, so disabling a user takes effect immediately.
 */
export async function authorize(payload: JWTPayload): Promise<Caller> {
  const c = config();
  const sub = String(payload.sub);
  const email = String(payload.email ?? "").toLowerCase();
  if (!email) throw new Denied(403, "Your account has no email address.", "no-email");
  if (payload.email_verified !== true) throw new Denied(403, "Verify your email address, then sign in again.", "email-unverified");

  const client = await db().connect();
  try {
    await client.query("BEGIN");
    // One first sign-in at a time for this address, so an invite can't be used twice.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [email]);

    const bySub = (await client.query("SELECT email, groups, enabled FROM users WHERE sub = $1", [sub])).rows[0];
    let groups: string[];

    if (bySub) {
      if (!bySub.enabled) throw new Denied(403, "Your access has been removed. Contact an admin.", "user-disabled");
      if (bySub.email !== email) throw new Denied(403, "Your account's email address changed. Contact an admin.", "email-changed");
      await client.query("UPDATE users SET last_seen = now() WHERE sub = $1 AND last_seen < now() - interval '1 minute'", [sub]);
      groups = bySub.groups;
    } else {
      const byEmail = (await client.query("SELECT 1 FROM users WHERE email = $1", [email])).rows[0];
      if (byEmail) throw new Denied(403, "This email address is already linked to another sign-in. Contact an admin.", "email-claimed");

      const invite = await activeInvite(client, email);
      if (!invite && !c.bootstrapAdmins.has(email)) {
        throw new Denied(403, `No invite found for ${email}. Contact an admin.`, "no-invite");
      }
      groups = (invite?.groups ?? []).map(String);
      await client.query("INSERT INTO users (sub, email, groups) VALUES ($1, $2, $3)", [sub, email, groups]);
      if (invite) {
        await client.query(
          "UPDATE items SET doc = jsonb_set(doc, '{redeemedAt}', to_jsonb($1::text)) WHERE tbl = $2 AND pk = $3 AND sk = ''",
          [new Date().toISOString(), INVITES_TABLE, email],
        );
      }
    }
    await client.query("COMMIT");

    // Bootstrap admin is checked against the current env each time and never
    // stored, so taking someone off the list removes their admin rights.
    const all = c.bootstrapAdmins.has(email) ? [...new Set([...groups, c.adminGroup])] : groups;
    return {
      sub,
      email,
      groups: all,
      isAdmin: all.includes(c.adminGroup),
      claims: { sub, email, name: payload.name, iss: payload.iss, "cognito:groups": all },
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

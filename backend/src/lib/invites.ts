import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, INVITES_TABLE } from "./db";

function bootstrapAdmins(): Set<string> {
  return new Set(
    (process.env.BOOTSTRAP_ADMIN_EMAILS ?? "")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

/**
 * Ensure each listed email can sign in, so that granting someone access to a
 * directory works even before they've been invited/joined. For any email that
 * is NOT a bootstrap admin and has NO existing invite row (pending or
 * redeemed), create a pending invite. Returns the emails that got a new invite.
 *
 * Long TTL (90d) since these back standing directory access, not a quick
 * hand-off. No email is sent — this only makes sign-up possible; the admin can
 * notify from Invites/Access if they want.
 */
export async function ensureInvitesFor(
  emails: string[],
  createdBy: string,
  ttlDays = 90,
): Promise<string[]> {
  const admins = bootstrapAdmins();
  const created: string[] = [];
  const now = new Date();
  const expires = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  for (const raw of emails) {
    const email = String(raw ?? "").trim().toLowerCase();
    if (!email || admins.has(email)) continue;

    const existing = (
      await ddb.send(new GetCommand({ TableName: INVITES_TABLE, Key: { email } }))
    ).Item;
    if (existing) continue; // already invited (pending) or joined (redeemed)

    try {
      await ddb.send(
        new PutCommand({
          TableName: INVITES_TABLE,
          Item: {
            email,
            groups: [],
            createdBy,
            createdAt: now.toISOString(),
            expiresAt: expires.toISOString(),
            ttl: Math.floor(expires.getTime() / 1000),
            redeemedAt: null,
          },
          ConditionExpression: "attribute_not_exists(email)",
        }),
      );
      created.push(email);
    } catch {
      // Concurrent create — treat as already invited.
    }
  }
  return created;
}

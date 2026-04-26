import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, INVITES_TABLE } from "../../lib/db";
import { requireAdmin } from "../../lib/auth";
import { created, error, parseJson } from "../../lib/response";
import { sendInviteEmail } from "../../lib/email";

interface Body {
  email: string;
  groups?: string[]; // e.g. ["admins"]
  ttlDays?: number;
  /**
   * If true (default), also send an invite email via SES. If false, the
   * row is written to DynamoDB but no email is sent — useful when the SES
   * identity isn't verified yet, or when an admin just wants the
   * `signupUrl` to copy/paste.
   */
  sendEmail?: boolean;
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => {
  try {
    const caller = requireAdmin(event);
    const body = parseJson<Body>(event.body);

    if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return error(400, "A valid email is required");
    }

    const email = body.email.toLowerCase();
    const ttlDays = body.ttlDays ?? 14;
    const now = new Date();
    const expires = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

    const item = {
      email,
      groups: body.groups && body.groups.length ? body.groups : [],
      createdBy: caller.email ?? caller.sub,
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      ttl: Math.floor(expires.getTime() / 1000),
      redeemedAt: null,
    };

    await ddb.send(
      new PutCommand({
        TableName: INVITES_TABLE,
        Item: item,
        // Allow overwriting only if the existing invite was redeemed or is expired.
        ConditionExpression:
          "attribute_not_exists(email) OR attribute_exists(redeemedAt) OR expiresAt < :now",
        ExpressionAttributeValues: { ":now": now.toISOString() },
      }),
    );

    const siteOrigin = process.env.SITE_ORIGIN ?? "http://localhost:5173";
    const signupUrl = siteOrigin; // invitee just goes to the site and clicks "Sign in with Google"

    // Send the invite email by default. We do this *after* the DynamoDB
    // Put succeeds — if SES fails (sandbox: unverified recipient, DKIM
    // still pending, throttled, etc.) the invite is still recorded and
    // the admin can fall back to copy/pasting `signupUrl` manually.
    let emailSent = false;
    let emailError: string | undefined;
    const wantEmail = body.sendEmail !== false;
    if (wantEmail) {
      const result = await sendInviteEmail({
        to: email,
        signupUrl,
        invitedBy: caller.email ?? null,
        expiresAt: item.expiresAt,
      });
      if (result.ok) {
        emailSent = true;
      } else {
        emailError = result.error;
        // Don't fail the request — the invite row is already persisted.
        console.warn(`SES sendInviteEmail failed for ${email}: ${result.error}`);
      }
    }

    return created({
      email,
      expiresAt: item.expiresAt,
      groups: item.groups,
      signupUrl,
      emailSent,
      emailError,
    });
  } catch (e: any) {
    if (e.name === "ConditionalCheckFailedException") {
      return error(409, "An active invite already exists for this email. Revoke it first.");
    }
    if (e.statusCode) return error(e.statusCode, e.message);
    console.error(e);
    return error(500, "Internal error");
  }
};

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

/**
 * Thin SES wrapper used by invite handlers. Kept deliberately small —
 * this app only ever sends a one-shot transactional invite email, so we
 * don't need templates, contact lists, or configuration sets.
 *
 * Configuration comes from env (set in serverless.yml):
 *   - MAIL_FROM   : visible From: address (e.g. noreply@schuit.io). Must
 *                   live inside a verified SES identity.
 *   - MAIL_REGION : SES region (e.g. us-east-1). Must match the region
 *                   the email-infra stack was deployed to.
 *
 * The client is module-scoped so warm Lambda invocations re-use the same
 * underlying HTTP connection.
 */

const REGION = process.env.MAIL_REGION ?? "us-east-1";
const FROM = process.env.MAIL_FROM ?? "";

const ses = new SESv2Client({ region: REGION });

export interface SendInviteArgs {
  /** The invitee's email (the To: address). */
  to: string;
  /** URL the invitee should open to sign in (the site's root). */
  signupUrl: string;
  /** Email of the admin who created the invite (shown in the body for context). */
  invitedBy?: string | null;
  /** ISO-8601 timestamp of when the invite expires. */
  expiresAt: string;
}

/**
 * Build a plain-text body. Kept short and human — long templated marketing
 * copy is more likely to land in spam than a one-paragraph note from a
 * person.
 */
function buildText({ signupUrl, invitedBy, expiresAt }: SendInviteArgs): string {
  const inviter = invitedBy ? `${invitedBy} ` : "";
  const expires = new Date(expiresAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return [
    `${inviter}invited you to sharing.schuit.io.`,
    "",
    `Sign in here using your Google account:`,
    signupUrl,
    "",
    `This invite expires on ${expires}.`,
    "",
    `If you weren't expecting this email, you can ignore it.`,
  ].join("\n");
}

/**
 * Build a minimal HTML body. We intentionally do not load remote images,
 * webfonts, tracking pixels, or anything that could downgrade deliverability.
 */
function buildHtml(args: SendInviteArgs): string {
  const inviter = args.invitedBy ? `${escapeHtml(args.invitedBy)} ` : "";
  const expires = new Date(args.expiresAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const url = escapeAttr(args.signupUrl);
  return `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:560px;margin:0 auto;padding:24px;">
  <p>${inviter}invited you to <strong>sharing.schuit.io</strong>.</p>
  <p><a href="${url}" style="background:#1f6feb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block;">Sign in with Google</a></p>
  <p style="font-size:13px;color:#666;">Or paste this URL into your browser: <br><span style="word-break:break-all;">${escapeHtml(args.signupUrl)}</span></p>
  <p style="font-size:13px;color:#666;">This invite expires on ${escapeHtml(expires)}.</p>
  <p style="font-size:12px;color:#999;">If you weren't expecting this email, you can ignore it.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send a single invite email. Never throws — returns {ok:false, error}
 * so the caller can fall back to surfacing the signupUrl in the API
 * response if SES rejects the send (e.g. sandbox: unverified recipient,
 * domain not yet DKIM-verified, throttling).
 */
export async function sendInviteEmail(args: SendInviteArgs): Promise<SendResult> {
  if (!FROM) {
    return { ok: false, error: "MAIL_FROM env var is not configured" };
  }
  try {
    const out = await ses.send(
      new SendEmailCommand({
        FromEmailAddress: FROM,
        Destination: { ToAddresses: [args.to] },
        Content: {
          Simple: {
            Subject: { Data: "You're invited to sharing.schuit.io", Charset: "UTF-8" },
            Body: {
              Text: { Data: buildText(args), Charset: "UTF-8" },
              Html: { Data: buildHtml(args), Charset: "UTF-8" },
            },
          },
        },
      }),
    );
    return { ok: true, messageId: out.MessageId };
  } catch (e: any) {
    // Common SES errors we want to surface verbatim:
    //   - MessageRejected: in sandbox + recipient not verified
    //   - NotFoundException: identity not verified yet (DKIM still pending)
    //   - AccessDeniedException: IAM not granted (deploy ran from old code)
    const msg = e?.name && e?.message ? `${e.name}: ${e.message}` : (e?.message ?? String(e));
    return { ok: false, error: msg };
  }
}

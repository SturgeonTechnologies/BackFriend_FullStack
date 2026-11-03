// Replaces src/lib/email.ts: plain SMTP instead of SES. As in the cloud version,
// a send never throws, and the admin UI falls back to showing the sign-up link.
import nodemailer from "nodemailer";
import { config } from "../config";

export interface SendInviteArgs {
  to: string;
  signupUrl: string;
  invitedBy?: string | null;
  expiresAt: string;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function sendInviteEmail(args: SendInviteArgs): Promise<SendResult> {
  const smtp = process.env.SMTP_URL;
  const from = process.env.MAIL_FROM;
  if (!smtp || !from) return { ok: false, error: "SMTP_URL and MAIL_FROM are not configured" };

  const app = config().appName;
  const expires = new Date(args.expiresAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const inviter = args.invitedBy ? `${args.invitedBy} ` : "";
  try {
    const info = await nodemailer.createTransport(smtp).sendMail({
      from,
      to: args.to,
      subject: `You're invited to ${app}`,
      text: `${inviter}invited you to ${app}.\n\nSign in here:\n${args.signupUrl}\n\nThis invite expires on ${expires}.\n\nIf you weren't expecting this email, you can ignore it.`,
      html: `<p>${escapeHtml(inviter)}invited you to <strong>${escapeHtml(app)}</strong>.</p><p><a href="${escapeHtml(args.signupUrl)}">Sign in</a></p><p>This invite expires on ${escapeHtml(expires)}.</p><p>If you weren't expecting this email, you can ignore it.</p>`,
    });
    return { ok: true, messageId: info.messageId };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

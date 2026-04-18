// server/services/emailService.ts
// Resend-based email delivery for household invitations.

import { Resend } from "resend";
import { logger } from "../config/logger.js";

// Lazy-init: Resend SDK throws if constructed without an API key,
// so we defer instantiation until the first email send attempt.
let _resend: Resend | null = null;
function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

// ── Invitation Email ─────────────────────────────────────────────────────────

interface InvitationEmailParams {
  to: string;
  inviterName: string;
  householdName: string;
  role: string;
  inviteUrl: string;
  expiresAt: Date;
}

export async function sendInvitationEmail(
  params: InvitationEmailParams
): Promise<{ sent: boolean; messageId?: string }> {
  const resend = getResend();
  if (!resend) {
    logger.warn("[email] RESEND_API_KEY not set — skipping invitation email");
    return { sent: false };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: "NutriSmarts <info@nutrismarts.ai>",
      to: params.to,
      subject: `${params.inviterName} invited you to join their household on NutriSmarts`,
      html: buildInvitationEmailHtml(params),
    });

    if (error) {
      logger.error("[email] Resend error:", error);
      return { sent: false };
    }

    logger.info(`[email] Invitation sent to ${params.to} (id=${data?.id})`);
    return { sent: true, messageId: data?.id };
  } catch (err) {
    logger.error("[email] Unexpected error sending invitation:", err);
    return { sent: false };
  }
}

// ── HTML Template Builder ────────────────────────────────────────────────────

function formatRole(role: string): string {
  return role
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

function buildInvitationEmailHtml(params: InvitationEmailParams): string {
  const { inviterName, householdName, role, inviteUrl, expiresAt } = params;
  const formattedRole = formatRole(role);
  const formattedExpiry = formatDate(expiresAt);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta name="color-scheme" content="light"/>
  <meta name="supported-color-schemes" content="light"/>
  <title>Household Invitation</title>
</head>
<body style="margin:0;padding:0;font-family:Inter,Helvetica,Arial,sans-serif;background:#F5F5F0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F0;padding:40px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;
                    box-shadow:0 2px 12px rgba(0,0,0,0.06)">

        <!-- Header Bar (green gradient) -->
        <tr>
          <td style="background:linear-gradient(135deg,#7AB52E,#99CC33);padding:32px 40px;text-align:center">
            <img src="https://app.nutrismarts.ai/images/logo-white.png"
                 alt="NutriSmarts" width="160" style="display:block;margin:0 auto;max-width:160px;height:auto"/>
          </td>
        </tr>

        <!-- Body -->
        <tr><td style="padding:40px 32px">
          <!-- Icon -->
          <div style="text-align:center;margin-bottom:24px">
            <span style="font-size:48px;line-height:1">&#x1F468;&#x200D;&#x1F469;&#x200D;&#x1F467;&#x200D;&#x1F466;</span>
          </div>

          <h1 style="font-size:24px;font-weight:700;color:#1A1A2E;text-align:center;margin:0 0 8px">
            You're Invited!
          </h1>

          <p style="font-size:15px;color:#666;text-align:center;line-height:1.6;margin:0 0 32px">
            <strong style="color:#1A1A2E">${escapeHtml(inviterName)}</strong> has invited you
            to join the <strong style="color:#1A1A2E">${escapeHtml(householdName)}</strong>
            household on NutriSmarts.
          </p>

          <!-- Details Card -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                 style="background:#FAFAFA;border-radius:12px;margin:0 0 32px">
            <tr>
              <td style="padding:14px 20px;font-size:13px;color:#999">Your Role</td>
              <td style="padding:14px 20px;font-size:14px;font-weight:600;color:#1A1A2E;text-align:right">
                ${escapeHtml(formattedRole)}
              </td>
            </tr>
            <tr>
              <td style="padding:14px 20px;font-size:13px;color:#999;border-top:1px solid #EEE">Expires</td>
              <td style="padding:14px 20px;font-size:14px;color:#1A1A2E;text-align:right;border-top:1px solid #EEE">
                ${escapeHtml(formattedExpiry)}
              </td>
            </tr>
          </table>

          <!-- CTA Button -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center">
              <a href="${escapeHtml(inviteUrl)}"
                 style="display:inline-block;width:100%;max-width:400px;padding:16px 32px;border-radius:12px;
                        background:#99CC33;color:#0F172A;font-size:16px;font-weight:700;text-align:center;
                        text-decoration:none;box-sizing:border-box;
                        box-shadow:0 4px 12px rgba(153,204,51,0.3)"
                 target="_blank">
                Accept Invitation &rarr;
              </a>
            </td></tr>
          </table>

          <!-- Fallback link -->
          <p style="font-size:12px;color:#999;text-align:center;margin:24px 0 0;line-height:1.6">
            Or copy this link:<br/>
            <a href="${escapeHtml(inviteUrl)}" style="color:#7AB52E;word-break:break-all">${escapeHtml(inviteUrl)}</a>
          </p>
        </td></tr>

        <!-- Footer -->
        <tr>
          <td style="padding:24px 32px;border-top:1px solid #F0F0F0;text-align:center">
            <p style="font-size:11px;color:#BBB;margin:0;line-height:1.5">
              This invitation expires on ${escapeHtml(formattedExpiry)}.<br/>
              You received this because ${escapeHtml(inviterName)} invited you on NutriSmarts.<br/>
              <a href="https://nutrismarts.ai" style="color:#999;text-decoration:underline">nutrismarts.ai</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Basic HTML entity escaping to prevent injection in email template */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

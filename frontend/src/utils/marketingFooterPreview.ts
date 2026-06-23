/**
 * Visual preview of the CAN-SPAM footer that the backend appends to Marketing
 * emails (see backend/services/marketingEmailCompliance.service.js).
 *
 * This is preview-only — the real footer is generated server-side with a signed,
 * per-member unsubscribe token. Here the links are inert placeholders so editors
 * and quick-send senders can see what recipients of a Marketing template receive.
 */
export const MARKETING_FOOTER_PREVIEW_HTML = `
<div style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.5;color:#6b7280;font-family:system-ui,-apple-system,sans-serif;">
  <p>You are receiving this email because you have a relationship with us.</p>
  <p style="color:#9ca3af;">[Your organization's mailing address appears here]</p>
  <p><a href="#" style="color:#1f8dbf;">Unsubscribe from marketing emails</a> · <a href="#" style="color:#1f8dbf;">Notification preferences</a></p>
  <p style="font-size:11px;color:#9ca3af;">Msg &amp; data rates may apply to SMS. Reply STOP to opt out of marketing texts where supported.</p>
</div>`.trim();

/**
 * Append the marketing footer preview to template body HTML when the template is
 * a Marketing template; otherwise return the body unchanged.
 */
export function withMarketingFooterPreview(
  bodyHtml: string,
  messageCategory?: 'Marketing' | 'System'
): string {
  if (messageCategory !== 'Marketing') return bodyHtml;
  return (bodyHtml || '') + MARKETING_FOOTER_PREVIEW_HTML;
}

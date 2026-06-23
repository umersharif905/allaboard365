const { signMarketingUnsubscribeToken } = require('./marketingUnsubscribeToken');

function escapeHtml(s) {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function publicApiBase() {
  const b = process.env.API_PUBLIC_BASE_URL || process.env.BACKEND_PUBLIC_URL || '';
  return String(b).replace(/\/$/, '');
}

function frontendBase() {
  const b = process.env.FRONTEND_URL || process.env.APP_URL || '';
  return String(b).replace(/\/$/, '');
}

function buildMarketingFooterAndUnsubscribeUrl(htmlContent, opts) {
  const { memberId, tenantId, tenantName = '', postalLine = '' } = opts || {};
  let token = null;
  try {
    token = signMarketingUnsubscribeToken(memberId, tenantId);
  } catch (e) {
    console.warn('[marketingEmailCompliance] Unsubscribe token not generated:', e.message);
  }

  const apiBase = publicApiBase();
  const feBase = frontendBase();
  const listUnsubscribeUrl = token && apiBase
    ? `${apiBase}/api/public/marketing-unsubscribe?token=${encodeURIComponent(token)}`
    : null;
  const preferenceUrl = feBase ? `${feBase}/member/communication-preferences` : null;
  const unsubLinkUrl = token && feBase
    ? `${feBase}/unsubscribe?token=${encodeURIComponent(token)}`
    : (listUnsubscribeUrl || '#');

  const name = escapeHtml(tenantName || 'us');
  const line = escapeHtml(postalLine || '');
  const footer = `
<div style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.5;color:#6b7280;font-family:system-ui,-apple-system,sans-serif;">
  <p>You are receiving this email because you have a relationship with ${name}.</p>
  ${line ? `<p>${line}</p>` : ''}
  <p><a href="${unsubLinkUrl}" style="color:#1f8dbf;">Unsubscribe from marketing emails</a>${preferenceUrl ? ` · <a href="${preferenceUrl}" style="color:#1f8dbf;">Notification preferences</a>` : ''}</p>
  <p style="font-size:11px;color:#9ca3af;">Msg &amp; data rates may apply to SMS. Reply STOP to opt out of marketing texts where supported.</p>
</div>`.trim();

  return {
    htmlWithFooter: (htmlContent || '') + footer,
    listUnsubscribeUrl
  };
}

module.exports = {
  buildMarketingFooterAndUnsubscribeUrl,
  publicApiBase,
  frontendBase,
  escapeHtml
};

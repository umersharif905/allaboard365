/** Subject + HTML/SMS defaults for missing recurring payment outreach (tenant message blast → message service). Tenant-branded — no fixed carrier name. */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function portalHostnameForEmail(loginUrl: string): string {
  try {
    return new URL(loginUrl).hostname.replace(/^www\./i, '');
  } catch {
    return 'member portal';
  }
}

/** Default subject line uses tenant name from oe.Tenants.Name when available. */
export function defaultMissingRecurringSubject(tenantName: string | null | undefined): string {
  const n = tenantName != null && String(tenantName).trim() ? String(tenantName).trim() : '';
  if (n) {
    return `Action needed: Update your payment method for your ${n} account`;
  }
  return 'Action needed: Update your payment method on file';
}

function signoffHtml(tenantName: string | null | undefined): string {
  const n = tenantName != null && String(tenantName).trim() ? String(tenantName).trim() : '';
  if (n) {
    return `<p style="color:#6b7280;font-size:14px;">— The ${escapeHtml(n)} team</p>`;
  }
  return '<p style="color:#6b7280;font-size:14px;">— Your enrollment team</p>';
}

/**
 * One shared HTML body for all recipients (message blast does not merge per-member fields).
 * Uses “Hi there,” instead of a first-name merge tag.
 */
export function buildMissingRecurringBlastEmailHtml(
  memberPortalLoginUrl: string,
  tenantName: string | null | undefined
): string {
  const href = encodeURI(memberPortalLoginUrl);
  const label = portalHostnameForEmail(memberPortalLoginUrl);
  return [
    '<div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;">',
    '<p>Hi there,</p>',
    '<p>We are writing because we do not have a valid payment method on file for your account. To keep your enrollment in good standing, please take a moment to add or update your payment information.</p>',
    '<p><strong>What to do</strong></p>',
    '<p>Sign in to your secure member portal at <a href="' +
      href +
      '" style="color:#2563eb;">' +
      escapeHtml(label) +
      '</a> and add your payment method.</p>',
    '<p>Thank you for your attention to this.</p>',
    signoffHtml(tenantName),
    '</div>'
  ].join('');
}

/**
 * Message Center bulk blast reads this prefix and sets SendGrid Reply-To (see messageCenter/shared/emailContent.js).
 * Only use when tenant has a contact email; do not put that address in the visible body unless you add it yourself.
 */
export function prependBulkEmailReplyToMetadata(htmlBody: string, replyToEmail: string | null | undefined): string {
  const raw = replyToEmail != null ? String(replyToEmail).trim() : '';
  if (!raw || !raw.includes('@')) return htmlBody;
  const t = htmlBody.trimStart();
  if (t.startsWith('<!-- METADATA:')) return htmlBody;
  return `<!-- METADATA:${JSON.stringify({ replyToEmail: raw })} -->\n${htmlBody}`;
}

/** Strip leading METADATA comment for iframe preview (optional). */
export function stripBulkEmailMetadataPrefix(htmlBody: string): string {
  return htmlBody.replace(/^<!--\s*METADATA:\s*\{[\s\S]*?\}\s*-->\s*/i, '').trimStart();
}

/**
 * Plain SMS — tenant name prefix + portal hostname on its own line (resolved URL, not a fixed domain).
 */
export function buildMissingRecurringSmsBody(
  memberPortalLoginUrl: string,
  tenantName: string | null | undefined
): string {
  const name = tenantName != null && String(tenantName).trim() ? String(tenantName).trim() : '';
  const hostLine = portalHostnameForEmail(memberPortalLoginUrl);
  const lead = name ? `${name}: ` : '';
  return (
    `${lead}Your account is missing a valid payment method, your plan requires this to remain active. Please sign in to our secure portal to add or update your payment information to make sure your plan stays active:\n\n${hostLine}`
  );
}

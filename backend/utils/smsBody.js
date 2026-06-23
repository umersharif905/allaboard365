'use strict';

/**
 * Normalize a URL for SMS auto-linking (mobile clients require http(s) scheme).
 * @param {string} url
 * @returns {string}
 */
function normalizeSmsUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  // Strip accidental wrapping / zero-width spaces that break tap-to-open.
  u = u.replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (!/^https?:\/\//i.test(u)) {
    u = `https://${u.replace(/^\/+/, '')}`;
  }
  return u;
}

/**
 * Build an SMS body with message text plus one or more URLs on their own lines.
 * URLs must not share a line with other text — query strings with `&` break autolink
 * detection when prefixed on the same line (common with Azure SAS proposal links).
 *
 * @param {string} message - User-authored text (no URLs required here)
 * @param {string|string[]} urls
 * @param {{ linkLabel?: string }} [opts] - Optional label line immediately above URL(s)
 * @returns {string}
 */
function buildSmsBodyWithLinks(message, urls, opts = {}) {
  const text = String(message || '').trim();
  const list = (Array.isArray(urls) ? urls : [urls])
    .map(normalizeSmsUrl)
    .filter(Boolean);
  if (!list.length) return text;

  const label = opts.linkLabel != null ? String(opts.linkLabel).trim() : '';
  const linkBlock = label ? `${label}\n${list.join('\n')}` : list.join('\n');
  return text ? `${text}\n\n${linkBlock}` : linkBlock;
}

module.exports = {
  normalizeSmsUrl,
  buildSmsBodyWithLinks,
};

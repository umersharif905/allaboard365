'use strict';

const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {string|null|undefined} raw
 * @returns {string[]}
 */
function parseBillingAuditReportEmails(raw) {
  if (raw == null || String(raw).trim() === '') return [];
  const parts = String(raw)
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    if (!SIMPLE_EMAIL.test(p)) continue;
    const lower = p.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(p);
  }
  return out;
}

/**
 * @param {string|null|undefined} raw
 * @returns {{ valid: string[]; invalid: string[] }}
 */
function parseWithInvalidTokens(raw) {
  if (raw == null || String(raw).trim() === '') return { valid: [], invalid: [] };
  const parts = String(raw)
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const p of parts) {
    if (!SIMPLE_EMAIL.test(p)) {
      invalid.push(p);
      continue;
    }
    const lower = p.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    valid.push(p);
  }
  return { valid, invalid };
}

/**
 * @param {string[]} emails
 * @returns {string|null}
 */
function serializeForDb(emails) {
  if (!emails || emails.length === 0) return null;
  return emails.join(', ');
}

module.exports = {
  parseBillingAuditReportEmails,
  parseWithInvalidTokens,
  serializeForDb
};

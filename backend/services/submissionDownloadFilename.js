'use strict';

/**
 * Safe single segment for Content-Disposition filenames (ASCII, no path chars).
 * @param {string} s
 */
function safePart(s) {
    if (!s || typeof s !== 'string') return '';
    return s.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/**
 * @param {Record<string, unknown>|null|undefined} payload
 * @param {string[]} keys
 */
function firstString(payload, keys) {
    if (!payload || typeof payload !== 'object') return '';
    for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(payload, k)) continue;
        const v = payload[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
}

/**
 * @param {Record<string, unknown>|null|undefined} payload
 * @returns {string} e.g. "Jane-Doe" or ""
 */
function submitterSegmentFromPayload(payload) {
    const first = firstString(payload, ['firstName', 'FirstName', 'first_name']);
    const last = firstString(payload, ['lastName', 'LastName', 'last_name']);
    const a = safePart(first);
    const b = safePart(last);
    if (a && b) return `${a}-${b}`;
    if (a) return a;
    if (b) return b;
    return '';
}

/**
 * Basename without extension, for PDF/CSV downloads. Uses firstName + lastName when present.
 * @param {string} formKind
 * @param {Record<string, unknown>|null|undefined} payload
 * @param {string} variant e.g. "submission", "submission-complete", "submission-record"
 * @returns {string}
 */
function buildSubmissionDownloadBasename(formKind, payload, variant) {
    const kind = safePart(String(formKind || 'submission')) || 'submission';
    const name = submitterSegmentFromPayload(payload);
    const v = safePart(String(variant || 'submission')) || 'submission';
    let base = name ? `${name}-${kind}-${v}` : `${kind}-${v}`;
    if (base.length > 120) base = base.slice(0, 120).replace(/-+$/g, '');
    return base || 'submission';
}

module.exports = {
    buildSubmissionDownloadBasename,
    submitterSegmentFromPayload
};

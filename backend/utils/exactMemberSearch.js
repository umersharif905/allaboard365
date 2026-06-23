'use strict';

const { normalizeEmail, looksLikeEmail } = require('./phoneNumberVariants');

/**
 * Decide whether a member-search term is a STRICT identifier we can safely use
 * to surface members who are NOT on the current vendor's plan. Off-plan members
 * are only ever revealed by an exact identity match — never fuzzy — so the care
 * team can't browse/enumerate other vendors' membership. The existing on-plan
 * fuzzy search is unaffected; this only gates the extra off-plan lookup.
 *
 * Recognizes (a term may satisfy more than one — predicates are OR'd):
 *   - email     — contains '@'                 -> exact, case-insensitive Email
 *   - phone     — >= 10 digits                 -> last-10-digit compare
 *   - fullName  — two+ words, has a letter     -> exact "First Last"
 *   - card      — alphanumeric with a digit    -> normalized HouseholdMemberID
 *
 * @param {string} rawTerm
 * @returns {{ email?: string, phone?: string, fullName?: string, card?: string } | null}
 *   null when the term is too weak (e.g. a lone first name) to surface off-plan.
 */
function classifyExactSearch(rawTerm) {
    const term = String(rawTerm == null ? '' : rawTerm).trim();
    if (!term) return null;

    const out = {};

    // Email — must look like a real address, not just contain '@'.
    if (looksLikeEmail(term) && /^\S+@\S+\.\S+$/.test(term)) {
        out.email = normalizeEmail(term);
    }

    // Phone — last 10 digits (handles +1, formatting). Emails never qualify here.
    if (!looksLikeEmail(term)) {
        const digits = term.replace(/\D/g, '');
        if (digits.length >= 10) {
            out.phone = digits.slice(-10);
        }
    }

    // Full name — needs a space and at least one letter ("First Last"). A lone
    // first name does NOT qualify (that's what keeps off-plan from being browsable).
    if (/\s/.test(term) && /[A-Za-z]/.test(term) && !looksLikeEmail(term)) {
        out.fullName = term.replace(/\s+/g, ' ').toLowerCase();
    }

    // Member card id — alphanumeric token (after stripping spaces/dashes) that
    // contains a digit, e.g. "SW8153334". Excludes plain words and emails.
    const card = term.replace(/[\s-]/g, '');
    if (!looksLikeEmail(term) && /\d/.test(card) && /^[A-Za-z0-9]+$/.test(card)) {
        out.card = card.toLowerCase();
    }

    return Object.keys(out).length ? out : null;
}

module.exports = { classifyExactSearch };

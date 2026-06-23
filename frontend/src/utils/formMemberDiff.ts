/**
 * Discrepancy display utilities for auto-resolved form submissions
 * (forms-redesign followup, Slice A.3).
 *
 * When a submission's payload identity fields diverge from the resolved
 * member's profile, the care team UI surfaces both values side-by-side
 * in the form `Account Value (Payload Value)` — but only when normalized
 * values actually differ, so cosmetic formatting differences don't
 * trigger noise.
 *
 * Normalization rules (locked in spec):
 *   - Phone: strip all non-digit characters
 *   - Email: lowercase + trim
 *   - Name: trim + collapse internal whitespace + case-insensitive
 *
 * Display values are always the original (non-normalized) strings.
 */

const normalizePhone = (v: string | null | undefined): string =>
  String(v ?? '').replace(/\D+/g, '');

const normalizeEmail = (v: string | null | undefined): string =>
  String(v ?? '').trim().toLowerCase();

const normalizeName = (v: string | null | undefined): string =>
  String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

const display = (v: string | null | undefined): string =>
  v == null ? '' : String(v);

/**
 * Returns the account value, with `(payload)` appended when normalized
 * values differ. Empty string when account is empty.
 */
const withDiff = (
  account: string | null | undefined,
  payload: string | null | undefined,
  normalize: (v: string | null | undefined) => string
): string => {
  const acc = display(account);
  const pay = display(payload);
  if (!acc) return '';
  const accN = normalize(acc);
  const payN = normalize(pay);
  if (!payN || accN === payN) return acc;
  return `${acc} (${pay})`;
};

export const formatNameWithDiff = (
  accountFirstName: string | null | undefined,
  accountLastName: string | null | undefined,
  payloadFirstName: string | null | undefined,
  payloadLastName: string | null | undefined
): string => {
  const accountName = [display(accountFirstName), display(accountLastName)]
    .filter(Boolean)
    .join(' ');
  const payloadName = [display(payloadFirstName), display(payloadLastName)]
    .filter(Boolean)
    .join(' ');
  return withDiff(accountName, payloadName, normalizeName);
};

export const formatEmailWithDiff = (
  accountEmail: string | null | undefined,
  payloadEmail: string | null | undefined
): string => withDiff(accountEmail, payloadEmail, normalizeEmail);

export const formatPhoneWithDiff = (
  accountPhone: string | null | undefined,
  payloadPhone: string | null | undefined
): string => withDiff(accountPhone, payloadPhone, normalizePhone);

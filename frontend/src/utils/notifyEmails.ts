/**
 * Template NotifyEmails column is a JSON string of string[] (e.g. '["a@b.com"]').
 * Plain comma-, semicolon-, or newline-separated lists are also accepted when reading.
 */

const DELIMITED_SPLIT = /[,;\n\r]+/;

const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseNotifyEmailsJson(json: string | null | undefined): { emails: string[]; parseError: boolean } {
  const raw = (json ?? '').trim();
  if (!raw) return { emails: [], parseError: false };
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return { emails: [], parseError: true };
    const emails = v.map((x) => String(x).trim()).filter((x) => x && SIMPLE_EMAIL.test(x));
    return { emails, parseError: false };
  } catch {
    /** Legacy / mistaken saves: comma-, semicolon-, or newline-separated list (not JSON). */
    const emails = [
      ...new Set(
        raw
          .split(DELIMITED_SPLIT)
          .map((s) => s.trim())
          .filter((s) => s && SIMPLE_EMAIL.test(s))
      )
    ];
    return { emails, parseError: emails.length === 0 };
  }
}

/** UI row list: at least one empty field when there are no saved addresses. */
export function emailsToRowList(emails: string[]): string[] {
  return emails.length ? emails : [''];
}

/** Returns JSON string for API, or an error message for the user. */
export function serializeNotifyEmailsFromRows(
  rows: string[]
): { ok: true; json: string } | { ok: false; message: string } {
  const parts = rows.map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (!SIMPLE_EMAIL.test(p)) {
      return { ok: false, message: `Invalid email address: ${p}` };
    }
  }
  return { ok: true, json: JSON.stringify(parts) };
}

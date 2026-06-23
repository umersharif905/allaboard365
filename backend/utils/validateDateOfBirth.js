/**
 * Strict DOB validation for enrollments (reject bad/legacy values before pricing or persistence).
 *
 * @param {string|Date|null|undefined} value
 * @param {{ required?: boolean, fieldLabel?: string }} [opts]
 * @returns {{ ok: true, iso: string } | { ok: false, message: string }}
 */
function validateDateOfBirthInput(value, opts = {}) {
  const required = opts.required === true;
  const label = opts.fieldLabel || 'Date of birth';

  if (value == null || value === '') {
    if (required) {
      return { ok: false, message: `${label} is required.` };
    }
    return { ok: true, iso: null };
  }

  let year;
  let month;
  let day;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return { ok: false, message: `${label} is not a valid date.` };
    }
    year = value.getUTCFullYear();
    month = value.getUTCMonth() + 1;
    day = value.getUTCDate();
  } else {
    const s = String(value).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) {
      return {
        ok: false,
        message: `${label} must be a valid date in YYYY-MM-DD format.`
      };
    }
    year = parseInt(m[1], 10);
    month = parseInt(m[2], 10);
    day = parseInt(m[3], 10);
  }

  if (year < 1900 || year > 2100) {
    return {
      ok: false,
      message: `${label} must use a year between 1900 and 2100.`
    };
  }

  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return { ok: false, message: `${label} is not a valid calendar date.` };
  }

  const now = new Date();
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  if (dt.getTime() > todayUtc) {
    return { ok: false, message: `${label} cannot be in the future.` };
  }

  const ageMs = todayUtc - dt.getTime();
  const age = Math.floor(ageMs / (365.25 * 24 * 60 * 60 * 1000));
  if (age > 120) {
    return {
      ok: false,
      message: `${label} must represent an age of 120 years or less.`
    };
  }

  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { ok: true, iso };
}

module.exports = { validateDateOfBirthInput };

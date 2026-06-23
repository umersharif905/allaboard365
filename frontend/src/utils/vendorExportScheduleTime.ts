/**
 * Vendor scheduled export times are stored as HH:mm wall clock in the API schedule zone
 * (backend VENDOR_EXPORT_SCHEDULE_TIMEZONE, default America/Chicago).
 * These helpers convert between that zone and the user's browser (IANA) timezone for the time picker.
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function getBrowserIanaTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** YYYY-MM-DD for the given instant in `tz`. */
export function formatDateYmdInTz(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!y || !m || !day) return '';
  return `${y}-${m}-${day}`;
}

function hourMinuteInTz(d: Date, tz: string): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hs = parts.find((p) => p.type === 'hour')?.value ?? '0';
  const ms = parts.find((p) => p.type === 'minute')?.value ?? '0';
  let h = parseInt(hs, 10);
  const m = parseInt(ms, 10);
  if (hs === '24' || h === 24) h = 0;
  return { h, m };
}

/**
 * Find UTC instant where calendar day `dateYmd` in `tz` has wall time `hhmm` (24h).
 */
export function wallTimeToUtcDate(dateYmd: string, hhmm: string, tz: string): Date {
  const [wantH, wantM] = hhmm.split(':').map((x) => parseInt(x, 10));
  const [Y, M, D] = dateYmd.split('-').map((x) => parseInt(x, 10));
  if (!Y || !M || !D || Number.isNaN(wantH) || Number.isNaN(wantM)) {
    throw new Error(`Invalid date or time: ${dateYmd} ${hhmm}`);
  }
  const start = Date.UTC(Y, M - 1, D - 1, 0, 0, 0);
  for (let min = 0; min < 48 * 60; min++) {
    const d = new Date(start + min * 60 * 1000);
    if (formatDateYmdInTz(d, tz) !== dateYmd) continue;
    const { h, m } = hourMinuteInTz(d, tz);
    if (h === wantH && m === wantM) return d;
  }
  throw new Error(`Could not resolve ${hhmm} on ${dateYmd} in ${tz} (invalid or skipped local time).`);
}

export function utcDateToWallHHmm(d: Date, tz: string): string {
  const { h, m } = hourMinuteInTz(d, tz);
  return `${pad2(h)}:${pad2(m)}`;
}

/** DB/API HH:mm (server schedule zone) → value for <input type="time"> (browser local zone). */
export function serverScheduleTimeToLocalInput(serverHHmm: string | undefined | null, serverTz: string): string {
  const raw = (serverHHmm || '').trim().slice(0, 5);
  if (!raw || !/^\d{1,2}:\d{2}$/.test(raw)) return '09:00';
  const [pa, pb] = raw.split(':');
  const normalized = `${pad2(parseInt(pa, 10))}:${pad2(parseInt(pb, 10))}`;
  if (!serverTz) return normalized;
  try {
    const dateStr = formatDateYmdInTz(new Date(), serverTz);
    const utc = wallTimeToUtcDate(dateStr, normalized, serverTz);
    return utcDateToWallHHmm(utc, getBrowserIanaTimeZone());
  } catch {
    return normalized;
  }
}

/** Value from <input type="time"> (browser local) → HH:mm to store (server schedule zone). */
export function localInputToServerScheduleTime(localHHmm: string, serverTz: string): string {
  const raw = (localHHmm || '').trim().slice(0, 5);
  if (!raw || !/^\d{1,2}:\d{2}$/.test(raw)) return '09:00';
  const [pa, pb] = raw.split(':');
  const normalized = `${pad2(parseInt(pa, 10))}:${pad2(parseInt(pb, 10))}`;
  if (!serverTz) return normalized;
  try {
    const dateStr = formatDateYmdInTz(new Date(), getBrowserIanaTimeZone());
    const utc = wallTimeToUtcDate(dateStr, normalized, getBrowserIanaTimeZone());
    return utcDateToWallHHmm(utc, serverTz);
  } catch {
    return normalized;
  }
}

/** Pretty 12h (AM/PM) label for an HH:mm string interpreted in the browser's local timezone. */
export function formatLocalTimeLabel(hhmm: string): string {
  const raw = (hhmm || '').trim().slice(0, 5);
  if (!/^\d{1,2}:\d{2}$/.test(raw)) return '';
  const [h, m] = raw.split(':').map((x) => parseInt(x, 10));
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/** Eastern wall-clock times map to UTC cron using EST (UTC−5), matching ShareWELL seed schedules. */

export type EasternTimeSlot = {
  hour: number;
  minute: number;
};

export type ParsedVendorImportSchedule =
  | { kind: 'daily'; minute: number; slots: EasternTimeSlot[] }
  | { kind: 'custom'; cron: string };

const EST_UTC_OFFSET_HOURS = 5;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Convert Eastern (EST) local time to UTC hour/minute for cron storage. */
export function easternToUtcParts(hour: number, minute: number): { hour: number; minute: number } {
  let utcHour = hour + EST_UTC_OFFSET_HOURS;
  const utcMinute = minute;
  if (utcHour >= 24) utcHour -= 24;
  return { hour: utcHour, minute: utcMinute };
}

/** Convert UTC cron parts to Eastern (EST) for display. */
export function utcToEasternParts(hour: number, minute: number): { hour: number; minute: number } {
  let etHour = hour - EST_UTC_OFFSET_HOURS;
  const etMinute = minute;
  if (etHour < 0) etHour += 24;
  return { hour: etHour, minute: etMinute };
}

export function formatEasternTime(hour: number, minute: number): string {
  const h = hour % 12 || 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `${h}:${pad2(minute)} ${ampm}`;
}

/** Build 6-part daily UTC cron: `0 {minute} {hours} * * *` */
export function buildDailyCronUtc(minute: number, easternSlots: EasternTimeSlot[]): string {
  if (!easternSlots.length) return '';
  const utcHours = easternSlots
    .map((s) => easternToUtcParts(s.hour, s.minute))
    .map((p) => p.hour)
    .sort((a, b) => a - b);
  const uniqueHours = [...new Set(utcHours)];
  const sharedMinute = easternSlots.every((s) => s.minute === easternSlots[0].minute)
    ? easternSlots[0].minute
    : minute;
  return `0 ${sharedMinute} ${uniqueHours.join(',')} * * *`;
}

/**
 * Parse vendor import cron into Eastern daily slots when pattern is
 * `{sec} {min} {hour,...} * * *` with fixed minute across hours.
 */
export function parseVendorImportCron(cron: string): ParsedVendorImportSchedule {
  const trimmed = cron.trim();
  if (!trimmed) return { kind: 'daily', minute: 0, slots: [] };

  const parts = trimmed.split(/\s+/);
  const [sec, min, hour, dom, month, dow] =
    parts.length === 6 ? parts : ['0', ...parts];

  if (dom !== '*' || month !== '*' || dow !== '*') {
    return { kind: 'custom', cron: trimmed };
  }
  if (sec !== '0') {
    return { kind: 'custom', cron: trimmed };
  }
  if (!/^\d+$/.test(min) || !/^[\d,]+$/.test(hour)) {
    return { kind: 'custom', cron: trimmed };
  }

  const minute = Number(min);
  const utcHours = hour.split(',').map((h) => Number(h)).filter((n) => !Number.isNaN(n));
  if (!utcHours.length || Number.isNaN(minute)) {
    return { kind: 'custom', cron: trimmed };
  }

  const slots = utcHours.map((h) => utcToEasternParts(h, minute));
  return { kind: 'daily', minute, slots };
}

export function formatScheduleSummary(cron: string): string {
  const parsed = parseVendorImportCron(cron);
  if (parsed.kind === 'custom') return `${parsed.cron} (UTC)`;
  if (!parsed.slots.length) return '';
  const times = sortEasternSlots(parsed.slots).map((s) => formatEasternTime(s.hour, s.minute));
  if (times.length === 1) return `Daily at ${times[0]} ET`;
  return `Daily at ${times.join(' and ')} ET`;
}

export function defaultEasternSlot(): EasternTimeSlot {
  return { hour: 0, minute: 0 };
}

export function sortEasternSlots(slots: EasternTimeSlot[]): EasternTimeSlot[] {
  return [...slots].sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));
}

export function easternSlotsShareMinute(slots: EasternTimeSlot[]): boolean {
  if (!slots.length) return true;
  const m = slots[0].minute;
  return slots.every((s) => s.minute === m);
}

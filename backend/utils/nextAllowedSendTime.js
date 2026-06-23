'use strict';

const TZ = 'America/New_York';

function etParts(date) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
}

/** Convert ET local Y-M-D H:M to UTC Date (iterative offset correction). */
function etLocalToUtc(year, month, day, hour, minute) {
  let guess = Date.UTC(year, month - 1, day, hour + 5, minute, 0);
  for (let i = 0; i < 4; i++) {
    const p = etParts(new Date(guess));
    const gotY = Number(p.year);
    const gotM = Number(p.month);
    const gotD = Number(p.day);
    const gotH = Number(p.hour);
    const gotMin = Number(p.minute);
    const targetMs = Date.UTC(year, month - 1, day, hour, minute, 0);
    const gotMs = Date.UTC(gotY, gotM - 1, gotD, gotH, gotMin, 0);
    guess += targetMs - gotMs;
  }
  return new Date(guess);
}

/**
 * Next allowed send time for billing/payment notifications:
 * 11:00 America/New_York, skipping Sunday (rolls to Monday 11:00 ET).
 */
function nextAllowedSendTime(now = new Date()) {
  const p = etParts(now);
  let y = Number(p.year);
  let m = Number(p.month);
  let d = Number(p.day);
  const hour = Number(p.hour);
  const min = Number(p.minute);
  const weekday = p.weekday;

  const pastEleven = hour > 11 || (hour === 11 && min > 0);
  if (pastEleven) {
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    y = next.getUTCFullYear();
    m = next.getUTCMonth() + 1;
    d = next.getUTCDate();
  }

  let target = etLocalToUtc(y, m, d, 11, 0);
  let wd = etParts(target).weekday;
  if (wd === 'Sun') {
    const mon = new Date(target.getTime() + 24 * 60 * 60 * 1000);
    const mp = etParts(mon);
    target = etLocalToUtc(Number(mp.year), Number(mp.month), Number(mp.day), 11, 0);
  }

  if (target.getTime() <= now.getTime()) {
    const tomorrow = etLocalToUtc(y, m, d + 1, 11, 0);
    const twd = etParts(tomorrow).weekday;
    if (twd === 'Sun') {
      const mon = new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000);
      const mp = etParts(mon);
      return etLocalToUtc(Number(mp.year), Number(mp.month), Number(mp.day), 11, 0);
    }
    return tomorrow;
  }

  if (weekday === 'Sun' && !pastEleven && hour < 11) {
    const mon = new Date(target.getTime() + 24 * 60 * 60 * 1000);
    const mp = etParts(mon);
    return etLocalToUtc(Number(mp.year), Number(mp.month), Number(mp.day), 11, 0);
  }

  return target;
}

module.exports = { nextAllowedSendTime, etLocalToUtc };

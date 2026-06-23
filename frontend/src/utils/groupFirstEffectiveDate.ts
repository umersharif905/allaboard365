/** Local calendar date as YYYY-MM-DD (avoids UTC shift from toISOString). */
export function formatLocalDateYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDaysYmd(ymd: string, days: number): string {
  const d = parseYmd(ymd);
  d.setDate(d.getDate() + days);
  return formatLocalDateYmd(d);
}

export function isFutureDateYmd(ymd: string, todayYmd = formatLocalDateYmd(new Date())): boolean {
  return ymd > todayYmd;
}

/** First effective date must be 1st of month; 15th also allowed when mid-month cohort is enabled. */
export function isValidFirstEffectiveDayOfMonth(ymd: string, allowMidMonthEffective: boolean): boolean {
  const day = parseYmd(ymd).getDate();
  if (day === 1) return true;
  return allowMidMonthEffective && day === 15;
}

/** Upcoming 1st (and 15th when allowed) for the next `monthsAhead` calendar months. */
export function buildFirstEffectiveDateOptions(
  allowMidMonthEffective: boolean,
  monthsAhead = 12,
  today = new Date()
): string[] {
  const todayYmd = formatLocalDateYmd(today);
  const dates: string[] = [];
  const startMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  for (let m = 0; m < monthsAhead + 2; m++) {
    const base = new Date(startMonth.getFullYear(), startMonth.getMonth() + m, 1);
    const days = allowMidMonthEffective ? [1, 15] : [1];
    for (const day of days) {
      const candidate = new Date(base.getFullYear(), base.getMonth(), day);
      const ymd = formatLocalDateYmd(candidate);
      if (ymd > todayYmd) dates.push(ymd);
    }
  }

  return [...new Set(dates)].sort();
}

export interface InitialEnrollmentPeriodFromFirstEffective {
  startDate: string;
  endDate: string;
  earliestEffectiveDate: string;
}

/**
 * Enrollment window: today through the day before the first effective date.
 * Earliest member effective date matches the selected first effective date.
 */
export function computeInitialEnrollmentPeriodFromFirstEffective(
  firstEffectiveDate: string,
  todayYmd = formatLocalDateYmd(new Date())
): InitialEnrollmentPeriodFromFirstEffective | { error: string } {
  const endDate = addDaysYmd(firstEffectiveDate, -1);
  if (endDate < todayYmd) {
    return {
      error:
        'First effective date must be at least two days from today so the enrollment period has a valid end date.'
    };
  }
  if (endDate <= todayYmd) {
    return { error: 'Enrollment period end must be after today.' };
  }
  return {
    startDate: todayYmd,
    endDate,
    earliestEffectiveDate: firstEffectiveDate
  };
}

export function formatDisplayDate(ymd: string): string {
  return parseYmd(ymd).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

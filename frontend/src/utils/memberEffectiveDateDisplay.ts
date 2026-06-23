import { Member } from '../types/member.types';

export type MemberEffectiveDateInfo = {
  text: string | null;
  days: number;
  hasActivePlans: boolean;
} | null;

/** Calendar date from API (YYYY-MM-DD or ISO): parse parts and build local midnight so the day matches the viewer's timezone (see prompts/backend-system.md Date Display). */
const parseLocalCalendarDate = (dateStr: string | null | undefined): Date | null => {
  const datePart = (dateStr ?? '').split('T')[0];
  if (!datePart || datePart.length < 10) return null;
  const [y, m, d] = datePart.split('-').map(Number);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  return new Date(y, m - 1, d);
};

const startOfLocalDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const calendarDaysFromLocalToday = (targetLocalMidnight: Date) => {
  const todayLocal = startOfLocalDay(new Date());
  return Math.round((targetLocalMidnight.getTime() - todayLocal.getTime()) / (1000 * 60 * 60 * 24));
};

/** "Plan started today" / "Plan goes into effect in X days" for member list and profile. */
export function getMemberEffectiveDateInfo(member: Member): MemberEffectiveDateInfo {
  const earliestFuture = parseLocalCalendarDate(member.EarliestFutureEffectiveDate ?? null);
  const earliestActive = parseLocalCalendarDate(member.EarliestActiveEffectiveDate ?? null);
  if (earliestFuture == null) return null;
  const daysUntil = calendarDaysFromLocalToday(earliestFuture);
  if (daysUntil < 0) return null;
  const futureCount = member.FutureEffectiveDateCount ?? 0;
  if (earliestActive != null) {
    return {
      text:
        futureCount > 0
          ? daysUntil === 0
            ? `${futureCount} New plan${futureCount !== 1 ? 's' : ''} started today`
            : `${futureCount} New plan${futureCount !== 1 ? 's' : ''} go into effect in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}`
          : null,
      days: daysUntil,
      hasActivePlans: true,
    };
  }
  return {
    text:
      daysUntil === 0
        ? 'Plan started today'
        : `Plan goes into effect in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}`,
    days: daysUntil,
    hasActivePlans: false,
  };
}

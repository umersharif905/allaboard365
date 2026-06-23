/**
 * English relative time for a past instant, e.g. "3 hours ago", "4 days ago", "last week".
 */
export function formatRelativeTimeAgo(isoOrDate: string | Date | null | undefined): string | null {
  if (isoOrDate == null) return null;
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return null;

  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 10) return 'just now';
  if (seconds < 60) return rtf.format(-seconds, 'second');

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, 'minute');

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');

  const days = Math.floor(hours / 24);
  if (days < 7) return rtf.format(-days, 'day');

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return rtf.format(-weeks, 'week');

  const months = Math.floor(days / 30);
  if (months < 12) return rtf.format(-months, 'month');

  const years = Math.floor(days / 365);
  return rtf.format(-years, 'year');
}

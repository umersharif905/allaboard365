/** Stored value is still legacy "ARM" in DB — UI label is "Short". */
export const ELIGIBILITY_DATE_FORMAT_OPTIONS = [
  { value: 'ARM', label: 'Short', example: 'M/d/yyyy (e.g. 2/1/2025)' },
  { value: 'Padded', label: 'Zero-padded', example: 'MM/dd/yyyy (e.g. 02/01/2025)' },
  { value: 'TwoDigitYear', label: 'Short year', example: 'M/d/yy (e.g. 11/8/75)' },
  { value: 'Compact', label: 'Compact', example: 'MMDDYYYY (e.g. 02012025)' },
] as const;

export function eligibilityDateFormatLabel(value: string | undefined | null): string {
  const opt = ELIGIBILITY_DATE_FORMAT_OPTIONS.find((o) => o.value === value);
  if (!opt) return value || 'Short';
  return `${opt.label} — ${opt.example}`;
}

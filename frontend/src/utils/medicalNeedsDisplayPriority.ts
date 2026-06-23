/** Member portal ordering: lower number = higher priority (shown first). */

export const MEDICAL_NEEDS_PRIORITY_MIN = 1;
export const MEDICAL_NEEDS_PRIORITY_MAX = 25;

export function clampMedicalNeedsDisplayPriority(n: unknown): number {
  const x = typeof n === 'number' ? n : parseInt(String(n ?? ''), 10);
  if (Number.isNaN(x)) return 1;
  return Math.min(MEDICAL_NEEDS_PRIORITY_MAX, Math.max(MEDICAL_NEEDS_PRIORITY_MIN, x));
}

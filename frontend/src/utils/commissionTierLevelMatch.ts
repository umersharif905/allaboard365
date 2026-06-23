/** Tolerant compare for GrantTierLevel vs oe.CommissionLevels.SortOrder (decimals). */
export const TIER_LEVEL_MATCH_EPSILON = 1e-4;

export function tierLevelsMatch(a: number, b: number): boolean {
  return Math.abs(Number(a) - Number(b)) < TIER_LEVEL_MATCH_EPSILON;
}

export function isGrantTierInLevelSet(
  grantTierLevel: number | null | undefined,
  levels: number[]
): boolean {
  if (grantTierLevel === null || grantTierLevel === undefined) return true;
  const g = Number(grantTierLevel);
  if (!Number.isFinite(g)) return false;
  return levels.some((l) => tierLevelsMatch(l, g));
}

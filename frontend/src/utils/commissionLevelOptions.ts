/**
 * Normalize oe.CommissionLevels rows for tier dropdowns (handles PascalCase / camelCase).
 */

export type NormalizedCommissionLevel = {
  commissionLevelId: string;
  sortOrder: number;
  displayName: string;
  legacyTierLevel: number | null;
  isSystemSeeded: boolean;
};

export type TierSelectOption = {
  level: number;
  label: string;
  commissionLevelId: string;
};

export function normalizeCommissionLevelRow(
  row: Record<string, unknown>
): NormalizedCommissionLevel | null {
  const id = row.CommissionLevelId ?? row.commissionLevelId;
  if (id == null || String(id).trim() === '') return null;

  const sortOrder = Number(row.SortOrder ?? row.sortOrder);
  const displayName = String(row.DisplayName ?? row.displayName ?? '').trim();

  return {
    commissionLevelId: String(id),
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
    displayName,
    legacyTierLevel:
      row.LegacyTierLevel != null
        ? Number(row.LegacyTierLevel)
        : row.legacyTierLevel != null
          ? Number(row.legacyTierLevel)
          : null,
    isSystemSeeded:
      row.IsSystemSeeded === true
      || row.IsSystemSeeded === 1
      || row.isSystemSeeded === true
      || row.isSystemSeeded === 1
  };
}

export function buildTierSelectOptions(
  rawLevels: Array<Record<string, unknown>>,
  meta?: { useCustomCommissionLevelsOnly?: boolean }
): TierSelectOption[] {
  const normalized = rawLevels
    .map(normalizeCommissionLevelRow)
    .filter((row): row is NormalizedCommissionLevel => row != null && row.displayName.length > 0);

  let effective = normalized;
  if (meta?.useCustomCommissionLevelsOnly) {
    const customOnly = normalized.filter((row) => !row.isSystemSeeded);
    if (customOnly.length > 0) effective = customOnly;
  }

  return [...effective]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((row) => ({
      level: row.sortOrder,
      // Match AgentsPage / CommissionRulesModal: show tenant-configured name explicitly
      label: `Level ${row.sortOrder}: ${row.displayName}`,
      commissionLevelId: row.commissionLevelId
    }));
}

/** Map SortOrder → commissionLevelId for apply payloads */
export function commissionLevelIdForSortOrder(
  options: TierSelectOption[],
  sortOrder: number
): string | null {
  const match = options.find((o) => o.level === Number(sortOrder));
  return match?.commissionLevelId || null;
}

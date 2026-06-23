'use strict';

/** Logic mirrored from routes/admin/migration.js commission-levels handler */
function mapMigrationCommissionLevels(rawLevels, flags) {
  const levels = (rawLevels || []).map((row) => ({
    commissionLevelId: row.CommissionLevelId,
    displayName: row.DisplayName,
    sortOrder: Number(row.SortOrder),
    legacyTierLevel: row.LegacyTierLevel != null ? Number(row.LegacyTierLevel) : null,
    isSystemSeeded: !!row.IsSystemSeeded,
    isActive: !!row.IsActive
  }));

  let effectiveLevels = levels;
  if (flags.useCustomCommissionLevelsOnly) {
    const customOnly = levels.filter((row) => !row.isSystemSeeded);
    if (customOnly.length > 0) effectiveLevels = customOnly;
  }

  return { levels, effectiveLevels };
}

describe('migration commission levels mapping', () => {
  it('filters to custom-only tiers when tenant flag is set', () => {
    const { effectiveLevels } = mapMigrationCommissionLevels(
      [
        { CommissionLevelId: '1', DisplayName: 'Agent', SortOrder: 0, IsSystemSeeded: true, IsActive: true },
        { CommissionLevelId: '2', DisplayName: 'Star Producer', SortOrder: 10, IsSystemSeeded: false, IsActive: true }
      ],
      { useCustomCommissionLevelsOnly: true }
    );

    expect(effectiveLevels).toHaveLength(1);
    expect(effectiveLevels[0].displayName).toBe('Star Producer');
    expect(effectiveLevels[0].sortOrder).toBe(10);
  });

  it('keeps all levels when custom-only flag set but no custom rows', () => {
    const { effectiveLevels } = mapMigrationCommissionLevels(
      [{ CommissionLevelId: '1', DisplayName: 'Agent', SortOrder: 0, IsSystemSeeded: true, IsActive: true }],
      { useCustomCommissionLevelsOnly: true }
    );
    expect(effectiveLevels).toHaveLength(1);
  });
});

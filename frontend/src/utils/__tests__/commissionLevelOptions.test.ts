import { describe, expect, it } from 'vitest';
import {
  buildTierSelectOptions,
  normalizeCommissionLevelRow
} from '../commissionLevelOptions';

describe('commissionLevelOptions', () => {
  it('normalizes PascalCase API rows', () => {
    const row = normalizeCommissionLevelRow({
      CommissionLevelId: 'abc',
      SortOrder: 2,
      DisplayName: 'Regional Lead',
      IsSystemSeeded: false
    });
    expect(row?.displayName).toBe('Regional Lead');
    expect(row?.sortOrder).toBe(2);
  });

  it('normalizes camelCase API rows', () => {
    const row = normalizeCommissionLevelRow({
      commissionLevelId: 'def',
      sortOrder: 1,
      displayName: 'Field Rep',
      isSystemSeeded: true
    });
    expect(row?.displayName).toBe('Field Rep');
    expect(row?.isSystemSeeded).toBe(true);
  });

  it('uses custom levels only when tenant flag is set', () => {
    const options = buildTierSelectOptions(
      [
        { CommissionLevelId: '1', SortOrder: 0, DisplayName: 'Agent', IsSystemSeeded: true },
        { CommissionLevelId: '2', SortOrder: 10, DisplayName: 'Star Producer', IsSystemSeeded: false }
      ],
      { useCustomCommissionLevelsOnly: true }
    );
    expect(options).toHaveLength(1);
    expect(options[0].label).toBe('Level 10: Star Producer');
    expect(options[0].level).toBe(10);
  });

  it('keeps all active levels when custom-only flag set but no custom rows', () => {
    const options = buildTierSelectOptions(
      [{ CommissionLevelId: '1', SortOrder: 0, DisplayName: 'Agent', IsSystemSeeded: true }],
      { useCustomCommissionLevelsOnly: true }
    );
    expect(options).toHaveLength(1);
    expect(options[0].label).toBe('Level 0: Agent');
  });

  it('reads migration API camelCase rows', () => {
    const options = buildTierSelectOptions([
      { commissionLevelId: 'x', sortOrder: 3, displayName: 'Broker Pro', isSystemSeeded: false }
    ]);
    expect(options[0]).toEqual({
      level: 3,
      label: 'Level 3: Broker Pro',
      commissionLevelId: 'x'
    });
  });
});

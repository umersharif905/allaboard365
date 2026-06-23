import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAgentMigrationCommissionLevels } = vi.hoisted(() => ({
  getAgentMigrationCommissionLevels: vi.fn()
}));

vi.mock('../../services/e123Migration.service', () => ({
  e123MigrationService: {
    getAgentMigrationCommissionLevels
  }
}));

import { loadTenantCommissionTierOptions } from '../loadTenantCommissionTierOptions';

const PINNACLE_ID = '55EB7262-4DB6-4614-82A8-23FC2E91203B';
const SHAREWELL_ID = 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6';

describe('loadTenantCommissionTierOptions', () => {
  beforeEach(() => {
    getAgentMigrationCommissionLevels.mockReset();
  });

  it('loads Pinnacle custom tier names for Pinnacle tenant id', async () => {
    getAgentMigrationCommissionLevels.mockResolvedValue({
      success: true,
      data: [
        { commissionLevelId: 'a', displayName: 'Junior Partner', sortOrder: 9, isSystemSeeded: false, isActive: true },
        { commissionLevelId: 'b', displayName: 'Senior Partner', sortOrder: 10, isSystemSeeded: false, isActive: true }
      ],
      meta: { useCustomCommissionLevelsOnly: false }
    });

    const result = await loadTenantCommissionTierOptions(PINNACLE_ID);

    expect(getAgentMigrationCommissionLevels).toHaveBeenCalledWith(PINNACLE_ID);
    expect(result.tenantId).toBe(PINNACLE_ID);
    expect(result.options.map((o) => o.label)).toEqual([
      'Level 9: Junior Partner',
      'Level 10: Senior Partner'
    ]);
    expect(result.options.some((o) => o.label.includes('Associate'))).toBe(false);
  });

  it('loads ShareWELL seeded tier names when that tenant is selected', async () => {
    getAgentMigrationCommissionLevels.mockResolvedValue({
      success: true,
      data: [
        { commissionLevelId: '1', displayName: 'Associate', sortOrder: -1, isSystemSeeded: true, isActive: true },
        { commissionLevelId: '2', displayName: 'Agent', sortOrder: 0, isSystemSeeded: true, isActive: true }
      ],
      meta: {}
    });

    const result = await loadTenantCommissionTierOptions(SHAREWELL_ID);

    expect(getAgentMigrationCommissionLevels).toHaveBeenCalledWith(SHAREWELL_ID);
    expect(result.options[0].label).toBe('Level -1: Associate');
    expect(result.options[1].label).toBe('Level 0: Agent');
  });

  it('returns error when API fails', async () => {
    getAgentMigrationCommissionLevels.mockResolvedValue({ success: false, message: 'Forbidden' });

    const result = await loadTenantCommissionTierOptions(SHAREWELL_ID);

    expect(result.options).toEqual([]);
    expect(result.loadedFromTenantApi).toBe(false);
    expect(result.error).toBe('Forbidden');
  });
});

import { e123MigrationService } from '../services/e123Migration.service';
import { buildTierSelectOptions, type TierSelectOption } from './commissionLevelOptions';

export type TenantTierOptionsResult = {
  options: TierSelectOption[];
  meta: {
    useCustomCommissionLevelsOnly?: boolean;
    commissionLevelsHybridEnabled?: boolean;
  } | null;
  error: string | null;
  /** True when options came from oe.CommissionLevels API (never from hardcoded fallback). */
  loadedFromTenantApi: boolean;
  tenantId?: string;
};

/**
 * Load commission tier dropdown options for a tenant — same API as AgentsPage.
 * Never falls back to COMMISSION_TIER_LEVELS constants.
 */
export async function loadTenantCommissionTierOptions(
  tenantId: string | null | undefined
): Promise<TenantTierOptionsResult> {
  if (!tenantId?.trim()) {
    return { options: [], meta: null, error: null, loadedFromTenantApi: false };
  }

  try {
    // Migration wizard: tenant id in URL path (SysAdmin cannot rely on auth primary tenant alone)
    const res = await e123MigrationService.getAgentMigrationCommissionLevels(tenantId.trim());
    if (!res?.success) {
      return {
        options: [],
        meta: null,
        error: res?.message || 'Failed to load tenant commission levels',
        loadedFromTenantApi: false
      };
    }

    const rows = Array.isArray(res.data) ? res.data : [];
    const activeRows = rows.filter((row) => row.isActive !== false);

    return {
      options: buildTierSelectOptions(activeRows as Array<Record<string, unknown>>, res.meta),
      meta: res.meta || null,
      error: activeRows.length === 0 ? 'No active commission levels for this tenant' : null,
      loadedFromTenantApi: true,
      tenantId: tenantId.trim()
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to load tenant commission levels';
    return { options: [], meta: null, error: message, loadedFromTenantApi: false };
  }
}

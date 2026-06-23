const sql = require('mssql');
const { getPool } = require('../config/database');

const LEGACY_LEVELS = [
  { level: -1, code: 'associate', displayName: 'Associate' },
  { level: 0, code: 'agent', displayName: 'Agent' },
  { level: 1, code: 'agency', displayName: 'Agency' },
  { level: 2, code: 'ga', displayName: 'GA' },
  { level: 3, code: 'mga', displayName: 'MGA' },
  { level: 4, code: 'imo', displayName: 'IMO' },
  { level: 5, code: 'fmo', displayName: 'FMO' },
  { level: 6, code: 'enterprise_carrier', displayName: 'Enterprise/Carrier' }
];

class CommissionLevelService {
  static getLegacyLevels() {
    return LEGACY_LEVELS.map((item) => ({ ...item }));
  }

  static getLegacyLabel(level) {
    const normalized = Number(level);
    const match = LEGACY_LEVELS.find((item) => item.level === normalized);
    return match ? match.displayName : `Level ${normalized}`;
  }

  static async getTenantFlags(tenantId) {
    const pool = await getPool();
    const req = pool.request();
    req.input('TenantId', sql.UniqueIdentifier, tenantId);
    const result = await req.query(`
      SELECT
        CAST(ISNULL(CommissionLevelsHybridEnabled, 1) AS BIT) AS CommissionLevelsHybridEnabled,
        CAST(ISNULL(UseCustomCommissionLevelsOnly, 0) AS BIT) AS UseCustomCommissionLevelsOnly
      FROM oe.Tenants
      WHERE TenantId = @TenantId
    `);
    const row = result.recordset[0] || {};
    return {
      commissionLevelsHybridEnabled: row.CommissionLevelsHybridEnabled !== false,
      useCustomCommissionLevelsOnly: row.UseCustomCommissionLevelsOnly === true
    };
  }

  static async listTenantLevels(tenantId, options = {}) {
    const includeInactive = options.includeInactive === true;
    const pool = await getPool();
    const req = pool.request();
    req.input('TenantId', sql.UniqueIdentifier, tenantId);
    const result = await req.query(`
      SELECT
        cl.CommissionLevelId,
        cl.TenantId,
        cl.Code,
        cl.DisplayName,
        cl.SortOrder,
        cl.LegacyTierLevel,
        cl.IsSystemSeeded,
        cl.IsActive,
        (
          SELECT COUNT(1)
          FROM oe.Agents a
          WHERE a.TenantId = cl.TenantId
            AND a.CommissionLevelId = cl.CommissionLevelId
        ) AS AgentCount,
        cl.CreatedDate,
        cl.ModifiedDate
      FROM oe.CommissionLevels cl
      WHERE cl.TenantId = @TenantId
        ${includeInactive ? '' : 'AND cl.IsActive = 1'}
      ORDER BY cl.SortOrder ASC, cl.DisplayName ASC
    `);
    return result.recordset || [];
  }

  static async getCommissionLevelById(tenantId, commissionLevelId, options = {}) {
    if (!commissionLevelId) return null;
    const includeInactive = options.includeInactive === true;
    const pool = await getPool();
    const req = pool.request();
    req.input('TenantId', sql.UniqueIdentifier, tenantId);
    req.input('CommissionLevelId', sql.UniqueIdentifier, commissionLevelId);
    const result = await req.query(`
      SELECT TOP 1
        cl.CommissionLevelId,
        cl.TenantId,
        cl.Code,
        cl.DisplayName,
        cl.SortOrder,
        cl.LegacyTierLevel,
        cl.IsSystemSeeded,
        cl.IsActive
      FROM oe.CommissionLevels cl
      WHERE cl.TenantId = @TenantId
        AND cl.CommissionLevelId = @CommissionLevelId
        ${includeInactive ? '' : 'AND cl.IsActive = 1'}
    `);
    return result.recordset[0] || null;
  }

  static buildEffectiveLevel(levelRecord) {
    const hasCustom = levelRecord?.CommissionLevelId && Number.isFinite(Number(levelRecord?.CustomSortOrder));
    const rank = hasCustom
      ? Number(levelRecord.CustomSortOrder)
      : Number(levelRecord?.CommissionTierLevel ?? 0);

    const effectiveName = hasCustom
      ? (levelRecord?.CustomDisplayName || this.getLegacyLabel(rank))
      : this.getLegacyLabel(rank);

    return {
      effectiveRank: rank,
      effectiveName,
      source: hasCustom ? 'custom' : 'legacy',
      legacyTierLevel: levelRecord?.LegacyTierLevel != null ? Number(levelRecord.LegacyTierLevel) : Number(levelRecord?.CommissionTierLevel ?? rank),
      commissionLevelId: levelRecord?.CommissionLevelId ? levelRecord.CommissionLevelId.toString() : null
    };
  }
}

module.exports = CommissionLevelService;

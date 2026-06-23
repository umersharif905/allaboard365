// backend/routes/tenant-admin-agents.js - UPDATED WITH ADDITIONAL FIELDS
/**
 * Tenant Admin Agents API Routes
 * Handles both individual agents and agencies within tenant scope
 * UPDATED VERSION with additional agent fields and fixed create agent
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../config/database');
const { authenticateUrls } = require('./uploads');
const sql = require('mssql');
const logger = require('../config/logger');
const { v4: uuidv4 } = require('uuid');

// Import middleware
const requireTenantAccess = require('../middleware/requireTenantAccess');
const { authorize , getUserRoles } = require('../middleware/auth');
const UserRolesService = require('../services/shared/user-roles.service');
const agencyAdmins = require('../utils/agencyAdmins');
const agencyAdminProvisioning = require('../services/agencyAdminProvisioning.service');
const CommissionLevelService = require('../services/commissionLevel.service');
const {
  getMonthlyRecurringRevenueByAgencyMap,
  normalizeAgencyKey
} = require('../services/agencyMrr.service');
const {
  buildAgenciesWithAgents,
  getAgencyCommissionTierSql
} = require('../services/shared/agent-hierarchy.service');
const {
  batchTotalAgentCountsByAgency,
  fetchAgentRowsForAgencySubtree
} = require('../services/agentHierarchyBatch.service');
const encryptionService = require('../services/encryptionService');
const { generateAgentCode } = require('../services/agentCode.service');

// Apply tenant access middleware to all routes
router.use(requireTenantAccess);

const GLOBAL_COMMISSION_LEVELS_HYBRID_ENABLED = String(process.env.COMMISSION_LEVELS_HYBRID_ENABLED || 'true').toLowerCase() !== 'false';

function userCanManageTenantPrimaryAgency(userRoles) {
  return userRoles.includes('TenantAdmin') || userRoles.includes('SysAdmin');
}

async function countActiveAgentsInAgency(pool, agencyId) {
  const r = await pool.request()
    .input('AgencyId', sql.UniqueIdentifier, agencyId)
    .query(`
      SELECT COUNT(*) AS cnt
      FROM oe.Agents
      WHERE AgencyId = @AgencyId AND Status = N'Active'
    `);
  return Number(r.recordset[0]?.cnt) || 0;
}

/** Unset primary on all tenant agencies, then set one agency as primary. */
async function transferTenantPrimaryAgency(pool, tenantId, agencyId, modifiedBy, transaction = null) {
  const run = (req) => req
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .input('AgencyId', sql.UniqueIdentifier, agencyId)
    .input('ModifiedBy', sql.UniqueIdentifier, modifiedBy);

  const unsetReq = transaction ? new sql.Request(transaction) : pool.request();
  await run(unsetReq).query(`
    UPDATE oe.Agencies
    SET IsPrimary = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @ModifiedBy
    WHERE TenantId = @TenantId AND IsPrimary = 1
  `);

  const setReq = transaction ? new sql.Request(transaction) : pool.request();
  await run(setReq).query(`
    UPDATE oe.Agencies
    SET IsPrimary = 1, ModifiedDate = GETUTCDATE(), ModifiedBy = @ModifiedBy
    WHERE AgencyId = @AgencyId AND TenantId = @TenantId
  `);
}

/**
 * The DB view omits pending onboarding agents; union those rows so tenant-admin lists and GET /agents/:id
 * stay aligned with oe.Agents (same 16 columns as oe.vw_TenantsAgentsAndAgencies).
 */
const SQL_TENANTS_AGENTS_AGENCIES_UNION = `(
  SELECT * FROM oe.vw_TenantsAgentsAndAgencies
  UNION ALL
  SELECT
    a.AgentId AS Id,
    CAST(N'Agent' AS VARCHAR(20)) AS Type,
    LTRIM(RTRIM(ISNULL(u.FirstName, N'') + N' ' + ISNULL(u.LastName, N''))) AS Name,
    u.Email,
    u.PhoneNumber AS Phone,
    a.NPN,
    a.Status AS Status,
    a.CommissionRole AS Role,
    a.TenantId,
    a.AgencyId,
    ag.AgencyName,
    CAST(NULL AS NVARCHAR(500)) AS GroupName,
    a.CreatedDate,
    a.ModifiedDate,
    (SELECT MIN(al.ExpirationDate) FROM oe.AgentLicenses al WHERE al.AgentId = a.AgentId AND al.Status = N'Active') AS EarliestLicenseExpiration,
    STUFF((
      SELECT DISTINCT N', ' + al.StateCode
      FROM oe.AgentLicenses al
      WHERE al.AgentId = a.AgentId AND al.Status = N'Active'
      ORDER BY N', ' + al.StateCode
      FOR XML PATH(N''), TYPE).value(N'.', N'NVARCHAR(MAX)'), 1, 2, N'') AS LicenseStates
  FROM oe.Agents a
  INNER JOIN oe.Users u ON u.UserId = a.UserId
  LEFT JOIN oe.Agencies ag ON ag.AgencyId = a.AgencyId
  WHERE (a.Status = N'Pending' OR u.Status = N'Pending')
)`;

async function validateCommissionLevelRequest(tenantId, commissionLevelId, options = {}) {
  if (!commissionLevelId) return null;
  const level = await CommissionLevelService.getCommissionLevelById(tenantId, commissionLevelId, {
    includeInactive: options.includeInactive === true
  });
  if (!level) {
    const error = new Error('Commission level was not found for this tenant.');
    error.statusCode = 400;
    throw error;
  }
  return level;
}

async function getCommissionLevelWritePolicy(tenantId) {
  const flags = await CommissionLevelService.getTenantFlags(tenantId);
  return {
    commissionLevelsHybridEnabled: GLOBAL_COMMISSION_LEVELS_HYBRID_ENABLED && flags.commissionLevelsHybridEnabled,
    useCustomCommissionLevelsOnly: flags.useCustomCommissionLevelsOnly
  };
}

/** SQL type for SortOrder / CommissionTierLevel / GrantTierLevel after decimal migration */
const TIER_SQL = sql.Decimal(9, 4);

async function isActiveSortOrderForTenant(db, tenantId, sortOrder) {
  const n = sortOrder === null || sortOrder === undefined ? null : Number(sortOrder);
  if (n === null || !Number.isFinite(n)) return false;
  const req = db.request();
  req.input('TenantId', sql.UniqueIdentifier, tenantId);
  req.input('SortOrder', TIER_SQL, n);
  const res = await req.query(`
    SELECT 1 AS ok
    FROM oe.CommissionLevels
    WHERE TenantId = @TenantId AND SortOrder = @SortOrder AND IsActive = 1
  `);
  return res.recordset.length > 0;
}

/**
 * Validate a numeric tier when no CommissionLevelId was supplied.
 * Hybrid/custom tenants: SortOrder must exist as an active catalog row.
 * Legacy: allow -1..6 only.
 */
async function assertCommissionTierNumericValid(db, tenantId, levelPolicy, sortOrder) {
  const n = sortOrder === null || sortOrder === undefined ? null : Number(sortOrder);
  if (n === null || !Number.isFinite(n)) {
    const err = new Error('Invalid commission tier level.');
    err.statusCode = 400;
    throw err;
  }
  if (levelPolicy.commissionLevelsHybridEnabled || levelPolicy.useCustomCommissionLevelsOnly) {
    if (!(await isActiveSortOrderForTenant(db, tenantId, n))) {
      const err = new Error('Commission tier level is not a valid active level for this tenant.');
      err.statusCode = 400;
      throw err;
    }
  } else if (n < -1 || n > 6) {
    const err = new Error('CommissionTierLevel must be between -1 and 6');
    err.statusCode = 400;
    throw err;
  }
}

async function getCommissionLevelUsage(pool, tenantId, commissionLevelId) {
  const reqDb = pool.request();
  reqDb.input('TenantId', sql.UniqueIdentifier, tenantId);
  reqDb.input('CommissionLevelId', sql.UniqueIdentifier, commissionLevelId);
  const result = await reqDb.query(`
    SELECT
      (SELECT COUNT(1) FROM oe.Agents WHERE TenantId = @TenantId AND CommissionLevelId = @CommissionLevelId) AS AgentCount,
      (SELECT COUNT(1) FROM oe.Agencies WHERE TenantId = @TenantId AND CommissionLevelId = @CommissionLevelId) AS AgencyCount
  `);
  return {
    agentCount: Number(result.recordset?.[0]?.AgentCount || 0),
    agencyCount: Number(result.recordset?.[0]?.AgencyCount || 0)
  };
}

/**
 * @route GET /api/tenant-admin/commission-levels
 * @desc List tenant commission levels (custom + seeded legacy)
 * @access TenantAdmin, SysAdmin, Agent
 */
router.get('/commission-levels', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const includeInactive = String(req.query.includeInactive || '').toLowerCase() === 'true';
    // requireTenantAccess already resolved header/query/body tenant switch into req.tenantId
    const tenantId = req.tenantId || req.user.TenantId;
    const levels = await CommissionLevelService.listTenantLevels(tenantId, { includeInactive });
    const flags = await CommissionLevelService.getTenantFlags(tenantId);
    return res.json({
      success: true,
      data: levels,
      meta: {
        commissionLevelsHybridEnabled: GLOBAL_COMMISSION_LEVELS_HYBRID_ENABLED && flags.commissionLevelsHybridEnabled,
        useCustomCommissionLevelsOnly: flags.useCustomCommissionLevelsOnly
      }
    });
  } catch (error) {
    logger.error('Error listing commission levels', {
      error: error.message,
      tenantId: req.user.TenantId
    }, 'TenantAdmin');
    return res.status(500).json({ success: false, message: 'Failed to list commission levels' });
  }
});

/**
 * @route GET /api/tenant-admin/commission-levels/settings
 * @desc Read tenant commission-level migration flags
 * @access TenantAdmin, SysAdmin
 */
router.get('/commission-levels/settings', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const flags = await CommissionLevelService.getTenantFlags(req.user.TenantId);
    return res.json({
      success: true,
      data: {
        commissionLevelsHybridEnabled: GLOBAL_COMMISSION_LEVELS_HYBRID_ENABLED && flags.commissionLevelsHybridEnabled,
        useCustomCommissionLevelsOnly: flags.useCustomCommissionLevelsOnly
      }
    });
  } catch (error) {
    logger.error('Error reading commission level settings', { error: error.message, tenantId: req.user.TenantId }, 'TenantAdmin');
    return res.status(500).json({ success: false, message: 'Failed to read commission level settings' });
  }
});

/**
 * @route PUT /api/tenant-admin/commission-levels/settings
 * @desc Update tenant commission-level migration flags
 * @access TenantAdmin, SysAdmin
 */
router.put('/commission-levels/settings', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { useCustomCommissionLevelsOnly } = req.body || {};
    if (useCustomCommissionLevelsOnly === undefined) {
      return res.status(400).json({ success: false, message: 'useCustomCommissionLevelsOnly is required.' });
    }
    const pool = await getPool();
    const reqDb = pool.request();
    reqDb.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    reqDb.input('UseCustomCommissionLevelsOnly', sql.Bit, useCustomCommissionLevelsOnly ? 1 : 0);
    await reqDb.query(`
      UPDATE oe.Tenants
      SET UseCustomCommissionLevelsOnly = @UseCustomCommissionLevelsOnly
      WHERE TenantId = @TenantId
    `);
    const flags = await CommissionLevelService.getTenantFlags(req.user.TenantId);
    return res.json({
      success: true,
      data: {
        commissionLevelsHybridEnabled: GLOBAL_COMMISSION_LEVELS_HYBRID_ENABLED && flags.commissionLevelsHybridEnabled,
        useCustomCommissionLevelsOnly: flags.useCustomCommissionLevelsOnly
      }
    });
  } catch (error) {
    logger.error('Error updating commission level settings', { error: error.message, tenantId: req.user.TenantId }, 'TenantAdmin');
    return res.status(500).json({ success: false, message: 'Failed to update commission level settings' });
  }
});

/**
 * @route POST /api/tenant-admin/commission-levels
 * @desc Create tenant commission level
 * @access TenantAdmin, SysAdmin
 */
router.post('/commission-levels', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { code, displayName, sortOrder, legacyTierLevel = null, isActive = true } = req.body || {};
    if (!displayName || sortOrder === undefined || sortOrder === null) {
      return res.status(400).json({ success: false, message: 'displayName and sortOrder are required.' });
    }
    const normalizedCode = (code || String(displayName).toLowerCase().replace(/[^a-z0-9]+/g, '_')).slice(0, 100);
    const normalizedSortOrder = Number(sortOrder);
    if (!Number.isFinite(normalizedSortOrder)) {
      return res.status(400).json({ success: false, message: 'sortOrder must be numeric.' });
    }
    const pool = await getPool();
    if (isActive) {
      const dupReq = pool.request();
      dupReq.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      dupReq.input('SortOrder', TIER_SQL, normalizedSortOrder);
      const dupResult = await dupReq.query(`
        SELECT TOP 1 CommissionLevelId
        FROM oe.CommissionLevels
        WHERE TenantId = @TenantId
          AND SortOrder = @SortOrder
          AND IsActive = 1
      `);
      if (dupResult.recordset.length > 0) {
        return res.status(400).json({ success: false, message: 'An active level with this Tier Level already exists.' });
      }
    }
    const reqDb = pool.request();
    const commissionLevelId = uuidv4();
    reqDb.input('CommissionLevelId', sql.UniqueIdentifier, commissionLevelId);
    reqDb.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    reqDb.input('Code', sql.NVarChar, normalizedCode);
    reqDb.input('DisplayName', sql.NVarChar, displayName);
    reqDb.input('SortOrder', TIER_SQL, normalizedSortOrder);
    reqDb.input('LegacyTierLevel', TIER_SQL, legacyTierLevel === null || legacyTierLevel === undefined ? null : Number(legacyTierLevel));
    reqDb.input('IsActive', sql.Bit, isActive ? 1 : 0);
    await reqDb.query(`
      INSERT INTO oe.CommissionLevels (
        CommissionLevelId, TenantId, Code, DisplayName, SortOrder, LegacyTierLevel,
        IsSystemSeeded, IsActive, CreatedDate, ModifiedDate
      ) VALUES (
        @CommissionLevelId, @TenantId, @Code, @DisplayName, @SortOrder, @LegacyTierLevel,
        0, @IsActive, GETUTCDATE(), GETUTCDATE()
      )
    `);
    const created = await CommissionLevelService.getCommissionLevelById(req.user.TenantId, commissionLevelId, { includeInactive: true });
    return res.status(201).json({ success: true, data: created });
  } catch (error) {
    logger.error('Error creating commission level', {
      error: error.message,
      tenantId: req.user.TenantId
    }, 'TenantAdmin');
    const message = String(error.message || '').includes('UNIQUE')
      ? 'Commission level code/sort order must be unique for this tenant.'
      : 'Failed to create commission level';
    return res.status(400).json({ success: false, message });
  }
});

/**
 * @route PUT /api/tenant-admin/commission-levels/:id
 * @desc Update tenant commission level
 * @access TenantAdmin, SysAdmin
 */
router.put('/commission-levels/:id', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { code, displayName, sortOrder, legacyTierLevel, isActive } = req.body || {};
    const updates = ['ModifiedDate = GETUTCDATE()'];
    const pool = await getPool();
    const reqDb = pool.request();
    reqDb.input('CommissionLevelId', sql.UniqueIdentifier, id);
    reqDb.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);

    if (code !== undefined) {
      reqDb.input('Code', sql.NVarChar, code);
      updates.push('Code = @Code');
    }
    if (displayName !== undefined) {
      reqDb.input('DisplayName', sql.NVarChar, displayName);
      updates.push('DisplayName = @DisplayName');
    }
    let normalizedSortOrder = null;
    if (sortOrder !== undefined) {
      const parsedSortOrder = Number(sortOrder);
      if (!Number.isFinite(parsedSortOrder)) {
        return res.status(400).json({ success: false, message: 'sortOrder must be numeric.' });
      }
      reqDb.input('SortOrder', TIER_SQL, parsedSortOrder);
      updates.push('SortOrder = @SortOrder');
      normalizedSortOrder = parsedSortOrder;
    }
    if (legacyTierLevel !== undefined) {
      reqDb.input('LegacyTierLevel', TIER_SQL, legacyTierLevel === null ? null : Number(legacyTierLevel));
      updates.push('LegacyTierLevel = @LegacyTierLevel');
    }
    if (isActive !== undefined) {
      reqDb.input('IsActive', sql.Bit, isActive ? 1 : 0);
      updates.push('IsActive = @IsActive');
    }

    const levelBeforeReq = pool.request();
    levelBeforeReq.input('CommissionLevelId', sql.UniqueIdentifier, id);
    levelBeforeReq.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    const levelBefore = await levelBeforeReq.query(`
      SELECT TOP 1 SortOrder, IsActive
      FROM oe.CommissionLevels
      WHERE CommissionLevelId = @CommissionLevelId AND TenantId = @TenantId
    `);
    if (!levelBefore.recordset.length) {
      return res.status(404).json({ success: false, message: 'Commission level not found.' });
    }
    const currentSortOrder = Number(levelBefore.recordset[0].SortOrder);
    const nextSortOrder = normalizedSortOrder != null ? normalizedSortOrder : currentSortOrder;
    const nextIsActive = isActive === undefined
      ? (levelBefore.recordset[0].IsActive === true)
      : Boolean(isActive);
    if (nextIsActive) {
      const dupReq = pool.request();
      dupReq.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      dupReq.input('SortOrder', TIER_SQL, nextSortOrder);
      dupReq.input('CommissionLevelId', sql.UniqueIdentifier, id);
      const dupResult = await dupReq.query(`
        SELECT TOP 1 CommissionLevelId
        FROM oe.CommissionLevels
        WHERE TenantId = @TenantId
          AND SortOrder = @SortOrder
          AND IsActive = 1
          AND CommissionLevelId <> @CommissionLevelId
      `);
      if (dupResult.recordset.length > 0) {
        return res.status(400).json({ success: false, message: 'Cannot activate this level because another active level already uses this Tier Level.' });
      }
    }

    await reqDb.query(`
      UPDATE oe.CommissionLevels
      SET ${updates.join(', ')}
      WHERE CommissionLevelId = @CommissionLevelId AND TenantId = @TenantId
    `);

    const updated = await CommissionLevelService.getCommissionLevelById(req.user.TenantId, id, { includeInactive: true });
    return res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('Error updating commission level', {
      error: error.message,
      tenantId: req.user.TenantId
    }, 'TenantAdmin');
    const message = String(error.message || '').includes('UNIQUE')
      ? 'Commission level code/sort order must be unique for this tenant.'
      : 'Failed to update commission level';
    return res.status(400).json({ success: false, message });
  }
});

/**
 * @route GET /api/tenant-admin/commission-levels/:id/usage
 * @desc Get current assignment usage for a commission level
 * @access TenantAdmin, SysAdmin
 */
router.get('/commission-levels/:id/usage', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await getPool();
    const level = await validateCommissionLevelRequest(req.user.TenantId, id, { includeInactive: true });
    const usage = await getCommissionLevelUsage(pool, req.user.TenantId, level.CommissionLevelId);
    return res.json({
      success: true,
      data: {
        commissionLevelId: level.CommissionLevelId,
        agentCount: usage.agentCount,
        agencyCount: usage.agencyCount
      }
    });
  } catch (error) {
    logger.error('Error loading commission level usage', { error: error.message, tenantId: req.user.TenantId, commissionLevelId: req.params.id }, 'TenantAdmin');
    return res.status(400).json({ success: false, message: error.message || 'Failed to load commission level usage' });
  }
});

/**
 * @route POST /api/tenant-admin/commission-levels/:id/deactivate
 * @desc Deactivate level with assignment strategy
 * @access TenantAdmin, SysAdmin
 */
router.post('/commission-levels/:id/deactivate', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  const pool = await getPool();
  const tx = pool.transaction();
  try {
    const { id } = req.params;
    const { strategy, targetCommissionLevelId } = req.body || {};
    const normalizedStrategy = String(strategy || '').toLowerCase();
    if (!['keep_legacy', 'merge_to_level', 'delete_permanently'].includes(normalizedStrategy)) {
      return res.status(400).json({ success: false, message: 'strategy must be keep_legacy, merge_to_level, or delete_permanently.' });
    }

    const sourceLevel = await validateCommissionLevelRequest(req.user.TenantId, id, { includeInactive: true });
    if (sourceLevel.IsActive !== true) {
      return res.status(400).json({ success: false, message: 'Level is already inactive.' });
    }

    let targetLevel = null;
    const usage = await getCommissionLevelUsage(pool, req.user.TenantId, sourceLevel.CommissionLevelId);
    if (normalizedStrategy === 'delete_permanently') {
      if (usage.agentCount > 0 || usage.agencyCount > 0) {
        return res.status(400).json({
          success: false,
          message: `Cannot delete permanently while assignments exist (${usage.agentCount} agents, ${usage.agencyCount} agencies).`
        });
      }
    }
    if (normalizedStrategy === 'merge_to_level') {
      if (!targetCommissionLevelId) {
        return res.status(400).json({ success: false, message: 'targetCommissionLevelId is required for merge_to_level.' });
      }
      targetLevel = await validateCommissionLevelRequest(req.user.TenantId, targetCommissionLevelId, { includeInactive: false });
      if (String(targetLevel.CommissionLevelId).toLowerCase() === String(sourceLevel.CommissionLevelId).toLowerCase()) {
        return res.status(400).json({ success: false, message: 'Target level must be different from source level.' });
      }
    }

    await tx.begin();
    const reqTx = tx.request();
    reqTx.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    reqTx.input('SourceCommissionLevelId', sql.UniqueIdentifier, sourceLevel.CommissionLevelId);

    if (normalizedStrategy === 'delete_permanently') {
      await reqTx.query(`
        DELETE FROM oe.CommissionLevels
        WHERE TenantId = @TenantId
          AND CommissionLevelId = @SourceCommissionLevelId
      `);
    } else if (normalizedStrategy === 'keep_legacy') {
      await reqTx.query(`
        UPDATE oe.Agents
        SET CommissionLevelId = NULL,
            ModifiedDate = GETUTCDATE()
        WHERE TenantId = @TenantId
          AND CommissionLevelId = @SourceCommissionLevelId
      `);
    } else {
      reqTx.input('TargetCommissionLevelId', sql.UniqueIdentifier, targetLevel.CommissionLevelId);
      reqTx.input('TargetSortOrder', TIER_SQL, Number(targetLevel.SortOrder));
      await reqTx.query(`
        UPDATE oe.Agents
        SET CommissionLevelId = @TargetCommissionLevelId,
            CommissionTierLevel = @TargetSortOrder,
            ModifiedDate = GETUTCDATE()
        WHERE TenantId = @TenantId
          AND CommissionLevelId = @SourceCommissionLevelId
      `);
    }

    if (normalizedStrategy !== 'delete_permanently') {
      await reqTx.query(`
        UPDATE oe.CommissionLevels
        SET IsActive = 0,
            ModifiedDate = GETUTCDATE()
        WHERE TenantId = @TenantId
          AND CommissionLevelId = @SourceCommissionLevelId
      `);
    }

    await tx.commit();
    return res.json({ success: true });
  } catch (error) {
    try { await tx.rollback(); } catch {}
    logger.error('Error deactivating commission level', { error: error.message, tenantId: req.user.TenantId, commissionLevelId: req.params.id }, 'TenantAdmin');
    return res.status(400).json({ success: false, message: error.message || 'Failed to deactivate commission level' });
  }
});

/**
 * @route GET /api/tenant-admin/agents
 * @desc Get all agents and agencies for current tenant
 * @access TenantAdmin, SysAdmin
 */
router.get('/agents', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const {
      search,
      status,
      state,
      group,
      type,
      commissionLevelId,
      tenantId: tenantIdParam,
      includeUserId,
      includeInactive,
      page = 1,
      limit = 50
    } = req.query;
    const offset = (page - 1) * limit;
    
    const pool = await getPool();
    const request = pool.request();
    
    // Build dynamic WHERE clause - use table alias 'v' for view columns
    let whereConditions = ['1=1'];
    
    // Tenant isolation
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      whereConditions.push('v.TenantId = @TenantId');
      request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    } else if (tenantIdParam) {
      // SysAdmin can filter by tenantId when provided (e.g. for agent dropdown when tenant is selected)
      whereConditions.push('v.TenantId = @TenantId');
      request.input('TenantId', sql.UniqueIdentifier, tenantIdParam);
    }
    
    // Search filter - searches both agents and agencies by name, email, or Agent ID
    if (search) {
      whereConditions.push('(v.Name LIKE @Search OR v.Email LIKE @Search OR (v.Type = \'Agent\' AND EXISTS (SELECT 1 FROM oe.Agents sa WHERE sa.AgentId = v.Id AND sa.AgentCode LIKE @Search)))');
      request.input('Search', sql.NVarChar, `%${search}%`);
    }
    
    const showInactive =
      String(includeInactive || '').toLowerCase() === 'true' ||
      String(includeInactive || '') === '1';

    // Status filter - when includeUserId is provided, always include that agent even if inactive (e.g. for edit-mode dropdown)
    // Note: v.Id is AgentId for agents; we match by UserId via ag_user join added in main query
    if (status) {
      if (includeUserId) {
        whereConditions.push('(v.Status = @Status OR (v.Type = \'Agent\' AND EXISTS (SELECT 1 FROM oe.Agents au WHERE au.AgentId = v.Id AND au.UserId = @IncludeUserId)))');
        request.input('Status', sql.NVarChar, status);
        request.input('IncludeUserId', sql.UniqueIdentifier, includeUserId);
      } else {
        whereConditions.push('v.Status = @Status');
        request.input('Status', sql.NVarChar, status);
      }
    } else if (!showInactive) {
      // Agency rows: use oe.Agencies.Status (view may not reflect deactivation)
      whereConditions.push(`(
        (v.Type = N'Agency' AND a.Status = N'Active')
        OR (v.Type = N'Agent' AND v.Status = N'Active')
      )`);
    }
    
    // Type filter - allows filtering by Agent or Agency
    if (type) {
      whereConditions.push('v.Type = @Type');
      request.input('Type', sql.NVarChar, type);
    }
    
    // State filter
    if (state) {
      whereConditions.push('v.LicenseStates LIKE @State');
      request.input('State', sql.NVarChar, `%${state}%`);
    }
    
    // Group filter
    if (group) {
      whereConditions.push('v.GroupName LIKE @Group');
      request.input('Group', sql.NVarChar, `%${group}%`);
    }

    // Commission level filter (supports both agents and agencies)
    if (commissionLevelId) {
      whereConditions.push(`(
        (v.Type = 'Agent' AND EXISTS (
          SELECT 1
          FROM oe.Agents fa
          WHERE fa.AgentId = v.Id
            AND fa.TenantId = v.TenantId
            AND fa.CommissionLevelId = @CommissionLevelId
        ))
        OR
        (v.Type = 'Agency' AND EXISTS (
          SELECT 1
          FROM oe.Agencies fg
          WHERE fg.AgencyId = v.Id
            AND fg.TenantId = v.TenantId
            AND fg.CommissionLevelId = @CommissionLevelId
        ))
      )`);
      request.input('CommissionLevelId', sql.UniqueIdentifier, commissionLevelId);
    }
    
    const whereClause = whereConditions.join(' AND ');
    const agencyJoinForFilter = `LEFT JOIN oe.Agencies a ON v.Type = N'Agency' AND v.Id = a.AgencyId`;
    
    // Get total count - use alias 'v' for view (join Agencies when filtering agency status)
    const countResult = await request.query(`
      SELECT COUNT(*) as total
      FROM ${SQL_TENANTS_AGENTS_AGENCIES_UNION} v
      ${agencyJoinForFilter}
      WHERE ${whereClause}
    `);
    
    const total = countResult.recordset[0].total;
    
    // Check if IsPrimary column exists in Agencies table
    const columnCheckRequest = pool.request();
    const columnCheckResult = await columnCheckRequest.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'Agencies' 
      AND COLUMN_NAME = 'IsPrimary' 
      AND TABLE_SCHEMA = 'oe'
    `);
    const isPrimaryColumnExists = columnCheckResult.recordset[0].count > 0;
    
    // Get paginated results with real-time license data
    request.input('Offset', sql.Int, offset);
    request.input('Limit', sql.Int, parseInt(limit));
    
    // Check if CommissionTierLevel column exists
    const tierColumnCheckRequest = pool.request();
    const tierColumnCheckResult = await tierColumnCheckRequest.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'Agencies' 
      AND COLUMN_NAME = 'CommissionTierLevel' 
      AND TABLE_SCHEMA = 'oe'
    `);
    const tierColumnExists = tierColumnCheckResult.recordset[0].count > 0;
    
    // Check if CommissionTierLevel column exists for Agents
    const agentTierColumnCheckRequest = pool.request();
    const agentTierColumnCheckResult = await agentTierColumnCheckRequest.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'Agents' 
      AND COLUMN_NAME = 'CommissionTierLevel' 
      AND TABLE_SCHEMA = 'oe'
    `);
    const agentTierColumnExists = agentTierColumnCheckResult.recordset[0].count > 0;
    
    // Check if CommissionGroupId exists on Agents
    const commissionGroupColumnCheck = await pool.request().query(`
      SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'Agents' AND COLUMN_NAME = 'CommissionGroupId' AND TABLE_SCHEMA = 'oe'
    `);
    const agentCommissionGroupColumnExists = commissionGroupColumnCheck.recordset[0].count > 0;
    
    const agencyLevelIdColumnCheck = await pool.request().query(`
      SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'Agencies' AND COLUMN_NAME = 'CommissionLevelId' AND TABLE_SCHEMA = 'oe'
    `);
    const agentLevelIdColumnCheck = await pool.request().query(`
      SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'Agents' AND COLUMN_NAME = 'CommissionLevelId' AND TABLE_SCHEMA = 'oe'
    `);
    const agencyLevelIdColumnExists = agencyLevelIdColumnCheck.recordset[0].count > 0;
    const agentLevelIdColumnExists = agentLevelIdColumnCheck.recordset[0].count > 0;

    // Build query with conditional IsPrimary and CommissionTierLevel support
    let isPrimarySelect = `NULL as IsPrimary`;
    let isPrimaryJoin = ``;
    let tierLevelSelect = `NULL as CommissionTierLevel`;
    let commissionLevelIdSelect = `CAST(NULL AS uniqueidentifier) as CommissionLevelId`;
    let commissionLevelNameSelect = `CAST(NULL AS nvarchar(200)) as CommissionLevelName`;
    let orderBy = `ORDER BY v.Name`;
    
    // Always join Agencies table to get ContactEmail and ContactPhone
    const agencyJoin = `LEFT JOIN oe.Agencies a ON v.Type = 'Agency' AND v.Id = a.AgencyId`;
    
    if (isPrimaryColumnExists) {
      isPrimarySelect = `CASE WHEN v.Type = 'Agency' THEN a.IsPrimary ELSE NULL END as IsPrimary`;
      isPrimaryJoin = agencyJoin;
      orderBy = `ORDER BY a.IsPrimary DESC, v.Name`;
    } else {
      isPrimaryJoin = agencyJoin;
    }
    
    if (tierColumnExists || agentTierColumnExists) {
      if (tierColumnExists && agentTierColumnExists) {
        tierLevelSelect = `CASE
          WHEN v.Type = 'Agency' THEN COALESCE(cl_agency.SortOrder, a.CommissionTierLevel, 0)
          WHEN v.Type = 'Agent' THEN COALESCE(cl_agent.SortOrder, ag.CommissionTierLevel, 0)
          ELSE NULL 
        END as CommissionTierLevel`;
        commissionLevelIdSelect = `CASE WHEN v.Type = 'Agency' THEN a.CommissionLevelId WHEN v.Type = 'Agent' THEN ag.CommissionLevelId ELSE NULL END as CommissionLevelId`;
        commissionLevelNameSelect = `CASE WHEN v.Type = 'Agency' THEN cl_agency.DisplayName WHEN v.Type = 'Agent' THEN cl_agent.DisplayName ELSE NULL END as CommissionLevelName`;
        if (!isPrimaryJoin) {
          isPrimaryJoin = `LEFT JOIN oe.Agencies a ON v.Type = 'Agency' AND v.Id = a.AgencyId`;
        }
        isPrimaryJoin += ` LEFT JOIN oe.Agents ag ON v.Type = 'Agent' AND v.Id = ag.AgentId`;
        if (agencyLevelIdColumnExists) {
          isPrimaryJoin += ` LEFT JOIN oe.CommissionLevels cl_agency ON a.CommissionLevelId = cl_agency.CommissionLevelId`;
        } else {
          isPrimaryJoin += ` LEFT JOIN oe.CommissionLevels cl_agency ON 1 = 0`;
        }
        if (agentLevelIdColumnExists) {
          isPrimaryJoin += ` LEFT JOIN oe.CommissionLevels cl_agent ON ag.CommissionLevelId = cl_agent.CommissionLevelId`;
        } else {
          isPrimaryJoin += ` LEFT JOIN oe.CommissionLevels cl_agent ON 1 = 0`;
        }
      } else if (tierColumnExists) {
        tierLevelSelect = `CASE WHEN v.Type = 'Agency' THEN COALESCE(cl_agency.SortOrder, a.CommissionTierLevel) ELSE NULL END as CommissionTierLevel`;
        commissionLevelIdSelect = `CASE WHEN v.Type = 'Agency' THEN a.CommissionLevelId ELSE NULL END as CommissionLevelId`;
        commissionLevelNameSelect = `CASE WHEN v.Type = 'Agency' THEN cl_agency.DisplayName ELSE NULL END as CommissionLevelName`;
        if (!isPrimaryJoin) {
          isPrimaryJoin = `LEFT JOIN oe.Agencies a ON v.Type = 'Agency' AND v.Id = a.AgencyId`;
        }
        isPrimaryJoin += agencyLevelIdColumnExists
          ? ` LEFT JOIN oe.CommissionLevels cl_agency ON a.CommissionLevelId = cl_agency.CommissionLevelId`
          : ` LEFT JOIN oe.CommissionLevels cl_agency ON 1 = 0`;
      } else if (agentTierColumnExists) {
        tierLevelSelect = `CASE WHEN v.Type = 'Agent' THEN COALESCE(cl_agent.SortOrder, ag.CommissionTierLevel, 0) ELSE NULL END as CommissionTierLevel`;
        commissionLevelIdSelect = `CASE WHEN v.Type = 'Agent' THEN ag.CommissionLevelId ELSE NULL END as CommissionLevelId`;
        commissionLevelNameSelect = `CASE WHEN v.Type = 'Agent' THEN cl_agent.DisplayName ELSE NULL END as CommissionLevelName`;
        isPrimaryJoin += ` LEFT JOIN oe.Agents ag ON v.Type = 'Agent' AND v.Id = ag.AgentId`;
        isPrimaryJoin += agentLevelIdColumnExists
          ? ` LEFT JOIN oe.CommissionLevels cl_agent ON ag.CommissionLevelId = cl_agent.CommissionLevelId`
          : ` LEFT JOIN oe.CommissionLevels cl_agent ON 1 = 0`;
      }
    }
    
    // CommissionGroupId and CommissionGroupName for agents and agencies
    const agencyCommissionGroupCheck = await pool.request().query(`
      SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'Agencies' AND COLUMN_NAME = 'CommissionGroupId' AND TABLE_SCHEMA = 'oe'
    `);
    const agencyCommissionGroupColumnExists = agencyCommissionGroupCheck.recordset[0].count > 0;

    const ownerAgentColumnCheck = await pool.request().query(`
      SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Agencies' AND COLUMN_NAME = 'OwnerAgentId'
    `);
    const ownerAgentColumnExists = ownerAgentColumnCheck.recordset[0].count > 0;
    const ownerAgentSelect = ownerAgentColumnExists
      ? `CASE WHEN v.Type = 'Agency' THEN a.OwnerAgentId ELSE NULL END as OwnerAgentId`
      : `CAST(NULL AS uniqueidentifier) as OwnerAgentId`;
    let commissionGroupSelect = '';
    let commissionGroupJoin = '';
    if (agentCommissionGroupColumnExists) {
      commissionGroupSelect = `, CASE WHEN v.Type = 'Agent' THEN ag.CommissionGroupId ${agencyCommissionGroupColumnExists ? "WHEN v.Type = 'Agency' THEN a.CommissionGroupId" : ''} ELSE NULL END as CommissionGroupId, CASE WHEN v.Type = 'Agent' THEN cg.Name ${agencyCommissionGroupColumnExists ? "WHEN v.Type = 'Agency' THEN cg_agency.Name" : ''} ELSE NULL END as CommissionGroupName`;
      if (!agentTierColumnExists) {
        commissionGroupJoin = ` LEFT JOIN oe.Agents ag ON v.Type = 'Agent' AND v.Id = ag.AgentId`;
      }
      commissionGroupJoin += ` LEFT JOIN oe.CommissionGroups cg ON ag.CommissionGroupId = cg.CommissionGroupId`;
      if (agencyCommissionGroupColumnExists) {
        commissionGroupJoin += ` LEFT JOIN oe.CommissionGroups cg_agency ON a.CommissionGroupId = cg_agency.CommissionGroupId`;
      }
    }
    
    // Join oe.Agents for agents to get UserId (view Id is AgentId; groups update expects UserId)
    const agentUserIdJoin = `LEFT JOIN oe.Agents ag_user ON v.Type = 'Agent' AND v.Id = ag_user.AgentId`;
    const agentUserIdSelect = `CASE WHEN v.Type = 'Agent' THEN ag_user.UserId ELSE NULL END as UserId`;
    const agentCodeSelect = `CASE WHEN v.Type = 'Agent' THEN ag_user.AgentCode ELSE NULL END as AgentCode`;

    const result = await request.query(`
      SELECT 
        v.Id,
        v.Type,
        v.Name,
        v.Email,
        v.Phone,
        v.NPN,
        CASE WHEN v.Type = N'Agency' THEN a.Status ELSE v.Status END as Status,
        v.Role,
        v.TenantId,
        v.AgencyId,
        v.AgencyName,
        v.GroupName,
        v.CreatedDate,
        v.ModifiedDate,
        ${agentUserIdSelect},
        ${agentCodeSelect},
        -- Get IsPrimary for agencies (if column exists)
        ${isPrimarySelect},
        -- Get CommissionTierLevel (if column exists)
        ${tierLevelSelect},
        ${commissionLevelIdSelect},
        ${commissionLevelNameSelect},
        -- Get ContactEmail and ContactPhone for agencies
        CASE WHEN v.Type = 'Agency' THEN a.ContactEmail ELSE NULL END as ContactEmail,
        CASE WHEN v.Type = 'Agency' THEN a.ContactPhone ELSE NULL END as ContactPhone,
        -- Comma-separated agency admin agent IDs (oe.AgencyAdmins)
        CASE WHEN v.Type = 'Agency' THEN (
          (SELECT STRING_AGG(LOWER(CONVERT(NVARCHAR(36), aa.AgentId)), ',')
           FROM oe.AgencyAdmins aa
           WHERE aa.AgencyId = v.Id AND aa.Status = 'Active')
        ) ELSE NULL END as AgencyAdminAgentIdsCsv,
        -- OwnerAgentId for agencies (omitted from SQL when column missing on oe.Agencies)
        ${ownerAgentSelect},
        -- Parent (upline) agent name for agents
        CASE WHEN v.Type = 'Agent' THEN (
          SELECT u2.FirstName + ' ' + u2.LastName
          FROM oe.AgentHierarchy ah
          INNER JOIN oe.Agents a2 ON ah.ParentId = a2.AgentId AND a2.Status = 'Active'
          INNER JOIN oe.Users u2 ON a2.UserId = u2.UserId
          WHERE ah.AgentId = v.Id AND ah.Status = 'Active'
        ) ELSE NULL END as ParentAgentName,
        -- Get license info directly with JOIN
        (SELECT MIN(al.ExpirationDate) 
         FROM oe.Agents a2 
         JOIN oe.AgentLicenses al ON a2.AgentId = al.AgentId 
         WHERE a2.UserId = v.Id AND al.Status = 'Active') as EarliestLicenseExpiration,
        -- Get license states directly with JOIN
        STUFF((SELECT DISTINCT ', ' + al.StateCode 
               FROM oe.Agents a2 
               JOIN oe.AgentLicenses al ON a2.AgentId = al.AgentId 
               WHERE a2.UserId = v.Id AND al.Status = 'Active'
               ORDER BY ', ' + al.StateCode
               FOR XML PATH('')), 1, 2, '') as LicenseStates
        ${commissionGroupSelect}
      FROM ${SQL_TENANTS_AGENTS_AGENCIES_UNION} v
      ${agentUserIdJoin}
      ${isPrimaryJoin}
      ${commissionGroupJoin}
      WHERE ${whereClause}
      ${orderBy}
      OFFSET @Offset ROWS
      FETCH NEXT @Limit ROWS ONLY
    `);
    
    // Debug: Check for duplicates in the result
    const agentIds = result.recordset.filter(r => r.Type === 'Agent').map(r => r.Id);
    const duplicateAgentIds = agentIds.filter((id, index) => agentIds.indexOf(id) !== index);
    if (duplicateAgentIds.length > 0) {
      console.warn('⚠️ Duplicate agents detected in query result:', duplicateAgentIds);
      const duplicates = result.recordset.filter(r => duplicateAgentIds.includes(r.Id) && r.Type === 'Agent');
      console.warn('⚠️ Duplicate records:', duplicates.map(d => ({ Id: d.Id, Name: d.Name, AgencyId: d.AgencyId })));
    }
    
    // Deduplicate by Id and Type (in case DISTINCT didn't catch everything)
    const seen = new Map();
    const deduplicated = result.recordset.filter(row => {
      const key = `${row.Type}-${row.Id}`;
      if (seen.has(key)) {
        console.warn(`⚠️ Removing duplicate: ${key} - ${row.Name}`);
        return false;
      }
      seen.set(key, true);
      return true;
    });

    try {
      const mrrMap = await getMonthlyRecurringRevenueByAgencyMap(pool, req.user.TenantId);
      deduplicated.forEach((row) => {
        if (row.Type === 'Agency') {
          row.TotalMrr = mrrMap.get(normalizeAgencyKey(row.Id)) ?? 0;
        }
      });
    } catch (mrrErr) {
      logger.warn('Could not attach agency TotalMrr to agents list', { error: mrrErr.message, tenantId: req.user.TenantId });
    }
    
    res.json({
      success: true,
      data: deduplicated,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    logger.error('Error fetching tenant agents', { 
      error: error.message, 
      stack: error.stack,
      sqlMessage: error.originalError?.info?.message,
      tenantId: req.user.TenantId 
    }, 'TenantAdmin');
    
    console.error('❌ Error fetching tenant agents:', {
      message: error.message,
      sqlMessage: error.originalError?.info?.message,
      sqlState: error.originalError?.info?.number,
      fullError: error
    });
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch agents',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      sqlError: process.env.NODE_ENV === 'development' ? error.originalError?.info?.message : undefined
    });
  }
});

/**
 * @route GET /api/tenant-admin/agents/hierarchy/meta
 * @desc Agency shells + batched counts + MRR (no agent subtree rows — lazy load per agency)
 * @access TenantAdmin, SysAdmin, Agent (agency admins see administered agencies only)
 */
router.get(
  '/agents/hierarchy/meta',
  authorize(['TenantAdmin', 'SysAdmin', 'Agent']),
  async (req, res) => {
    try {
      const pool = await getPool();
      const userRoles = getUserRoles(req.user);
      const tenantId = req.tenantId || req.user.TenantId;

      if (!tenantId) {
        return res.status(400).json({ success: false, message: 'Tenant context required' });
      }

      const tenantRequest = pool.request();
      tenantRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
      const tenantResult = await tenantRequest.query(`
        SELECT TenantId, Name, Status
        FROM oe.Tenants
        WHERE TenantId = @TenantId
      `);
      if (tenantResult.recordset.length === 0) {
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }
      const tenant = tenantResult.recordset[0];

      let agenciesRaw = [];

      if (
        userRoles.includes('Agent') &&
        !userRoles.includes('TenantAdmin') &&
        !userRoles.includes('SysAdmin')
      ) {
        const viewerAgentId = await getAgentIdFromUserId(pool, req.user.UserId);
        if (!viewerAgentId) {
          return res.status(403).json({ success: false, message: 'Agent profile not found' });
        }
        const owned = await agencyAdmins.getAdministeredAgenciesForAgent(pool, viewerAgentId);
        agenciesRaw = owned.recordset || [];
      } else {
        const showInactive =
          String(req.query.includeInactive || '').toLowerCase() === 'true' ||
          String(req.query.includeInactive || '') === '1';
        const columnCheckResult = await pool.request().query(`
          SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_SCHEMA='oe' AND TABLE_NAME='Agencies' AND COLUMN_NAME='IsPrimary'
        `);
        const isPrimaryColumnExists = columnCheckResult.recordset[0].cnt > 0;
        const isPrimarySelect = isPrimaryColumnExists ? 'a.IsPrimary,' : 'NULL as IsPrimary,';
        const orderBy = isPrimaryColumnExists ? 'ORDER BY a.IsPrimary DESC, a.AgencyName' : 'ORDER BY a.AgencyName';
        const agencyTierSql = await getAgencyCommissionTierSql(pool);
        const statusFilter = showInactive ? '' : " AND a.Status = 'Active'";

        const agenciesRequest = pool.request();
        agenciesRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
        const agenciesResult = await agenciesRequest.query(`
          SELECT 
            a.AgencyId,
            a.AgencyName,
            a.Status,
            ${isPrimarySelect}
            a.CreatedDate,
            a.CommissionGroupId,
            cg.Name as CommissionGroupName,
            ${agencyTierSql.select}
          FROM oe.Agencies a
          LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
          ${agencyTierSql.join}
          WHERE a.TenantId = @TenantId${statusFilter}
          ${orderBy}
        `);
        agenciesRaw = agenciesResult.recordset || [];
      }

      const countMap = await batchTotalAgentCountsByAgency(pool, tenantId);

      let agencyMrrMap = new Map();
      try {
        agencyMrrMap = await getMonthlyRecurringRevenueByAgencyMap(pool, tenantId);
      } catch (mrrErr) {
        logger.warn('Could not load agency MRR for hierarchy meta', {
          error: mrrErr.message,
          tenantId
        });
      }

      const agencyIds = agenciesRaw.map((r) => r.AgencyId).filter(Boolean);
      const adminMap = await agencyAdmins.getAdminAgentIdsByAgencyMap(pool, agencyIds);

      const agenciesWithCounts = agenciesRaw.map((agency) => {
        const key = normalizeAgencyKey(agency.AgencyId);
        const adminList = adminMap.get(key) || [];
        return {
          ...agency,
          TotalAgentCount: countMap.get(key) ?? 0,
          OwnerAgentId: adminList[0] || null,
          AgencyAdminAgentIds: adminList
        };
      });

      const mrrByAgencyKey = new Map();
      agenciesWithCounts.forEach((agency) => {
        const key = normalizeAgencyKey(agency.AgencyId);
        const mrr = agencyMrrMap.get(key);
        if (mrr != null) mrrByAgencyKey.set(key, mrr);
      });

      const agencies = buildAgenciesWithAgents(agenciesWithCounts, [], mrrByAgencyKey);

      res.json({
        success: true,
        data: {
          tenant: {
            id: tenant.TenantId,
            name: tenant.Name,
            type: 'tenant',
            status: tenant.Status
          },
          agencies
        }
      });
    } catch (error) {
      logger.error('Error fetching hierarchy meta', { error: error.message }, 'TenantAdmin');
      res.status(500).json({
        success: false,
        message: 'Failed to fetch hierarchy meta',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      });
    }
  }
);

/**
 * @route GET /api/tenant-admin/agents/hierarchy/agency/:agencyId
 * @desc Nested agents for one agency subtree (lazy load). Same tree builder as full hierarchy.
 * @access TenantAdmin, SysAdmin, Agent (must administer or tenant-scope agency)
 */
router.get(
  '/agents/hierarchy/agency/:agencyId',
  authorize(['TenantAdmin', 'SysAdmin', 'Agent']),
  async (req, res) => {
    try {
      const pool = await getPool();
      const { agencyId } = req.params;
      const userRoles = getUserRoles(req.user);
      const tenantId = req.tenantId || req.user.TenantId;

      if (!tenantId && !userRoles.includes('SysAdmin')) {
        return res.status(400).json({ success: false, message: 'Tenant context required' });
      }

      const agencyLookup = pool.request();
      agencyLookup.input('AgencyId', sql.UniqueIdentifier, agencyId);
      let agencyWhere = 'WHERE a.AgencyId = @AgencyId AND a.Status = \'Active\'';
      if (!userRoles.includes('SysAdmin')) {
        agencyLookup.input('TenantId', sql.UniqueIdentifier, tenantId);
        agencyWhere += ' AND a.TenantId = @TenantId';
      }
      const agencyTierSqlSubtree = await getAgencyCommissionTierSql(pool);
      const agencyRowResult = await agencyLookup.query(`
        SELECT 
          a.AgencyId,
          a.TenantId,
          a.AgencyName,
          a.Status,
          a.IsPrimary,
          a.CreatedDate,
          a.CommissionGroupId,
          cg.Name AS CommissionGroupName,
          ${agencyTierSqlSubtree.select}
        FROM oe.Agencies a
        LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
        ${agencyTierSqlSubtree.join}
        ${agencyWhere}
      `);
      if (agencyRowResult.recordset.length === 0) {
        return res.status(404).json({ success: false, message: 'Agency not found' });
      }
      const agencyRow = agencyRowResult.recordset[0];

      if (
        userRoles.includes('Agent') &&
        !userRoles.includes('TenantAdmin') &&
        !userRoles.includes('SysAdmin')
      ) {
        const viewerAgentId = await getAgentIdFromUserId(pool, req.user.UserId);
        if (!viewerAgentId) {
          return res.status(403).json({ success: false, message: 'Agent profile not found' });
        }
        const allowed = await isAgencyOwner(pool, agencyId, viewerAgentId);
        if (!allowed) {
          return res.status(403).json({
            success: false,
            message: 'You do not have permission to load this agency hierarchy'
          });
        }
      }

      const effectiveTenantId = agencyRow.TenantId || tenantId;
      const countMap = await batchTotalAgentCountsByAgency(pool, effectiveTenantId);
      const adminMap = await agencyAdmins.getAdminAgentIdsByAgencyMap(pool, [agencyId]);
      const key = normalizeAgencyKey(agencyId);
      const adminList = adminMap.get(key) || [];

      let agencyMrrMap = new Map();
      try {
        agencyMrrMap = await getMonthlyRecurringRevenueByAgencyMap(pool, effectiveTenantId);
      } catch (_e) {
        /* optional */
      }

      const agenciesWithCounts = [
        {
          ...agencyRow,
          TotalAgentCount: countMap.get(key) ?? 0,
          OwnerAgentId: adminList[0] || null,
          AgencyAdminAgentIds: adminList
        }
      ];

      const agentRows = await fetchAgentRowsForAgencySubtree(pool, effectiveTenantId, agencyId);
      const mrrByAgencyKey = new Map();
      const mrr = agencyMrrMap.get(key);
      if (mrr != null) mrrByAgencyKey.set(key, mrr);

      const agencies = buildAgenciesWithAgents(agenciesWithCounts, agentRows, mrrByAgencyKey);

      res.json({
        success: true,
        data: {
          agencies
        }
      });
    } catch (error) {
      logger.error('Error fetching agency subtree hierarchy', { error: error.message }, 'TenantAdmin');
      res.status(500).json({
        success: false,
        message: 'Failed to fetch agency hierarchy',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      });
    }
  }
);

/**
 * @route GET /api/tenant-admin/agents/hierarchy
 * @desc Get complete organization hierarchy (Tenant -> Agencies -> Agents -> Sub-agents)
 * @access TenantAdmin, SysAdmin
 * IMPORTANT: This route MUST come before /agents/:id to avoid treating "hierarchy" as an ID
 */
router.get('/agents/hierarchy', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = req.tenantId || req.user.TenantId;
    const showInactive =
      String(req.query.includeInactive || '').toLowerCase() === 'true' ||
      String(req.query.includeInactive || '') === '1';
    const agencyStatusFilter = showInactive ? '' : " AND a.Status = 'Active'";
    
    console.log('📊 Fetching hierarchy for tenant:', tenantId);
    
    // Get tenant info
    const tenantRequest = pool.request();
    tenantRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
    const tenantResult = await tenantRequest.query(`
      SELECT TenantId, Name, Status
      FROM oe.Tenants
      WHERE TenantId = @TenantId
    `);
    
    if (tenantResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }
    
    const tenant = tenantResult.recordset[0];
    
    // Check if IsPrimary column exists
    const columnCheckRequest = pool.request();
    const columnCheckResult = await columnCheckRequest.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'Agencies' 
      AND COLUMN_NAME = 'IsPrimary' 
      AND TABLE_SCHEMA = 'oe'
    `);
    const isPrimaryColumnExists = columnCheckResult.recordset[0].count > 0;
    
    // Get all agencies for this tenant
    const agenciesRequest = pool.request();
    agenciesRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
    const isPrimarySelect = isPrimaryColumnExists ? 'a.IsPrimary,' : 'NULL as IsPrimary,';
    const orderBy = isPrimaryColumnExists ? 'ORDER BY a.IsPrimary DESC, a.AgencyName' : 'ORDER BY a.AgencyName';
    const agencyTierSqlHierarchy = await getAgencyCommissionTierSql(pool);
    // First, get agencies
    const agenciesResult = await agenciesRequest.query(`
      SELECT 
        a.AgencyId,
        a.AgencyName,
        a.Status,
        ${isPrimarySelect}
        a.CreatedDate,
        a.CommissionGroupId,
        cg.Name as CommissionGroupName,
        ${agencyTierSqlHierarchy.select}
      FROM oe.Agencies a
      LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
      ${agencyTierSqlHierarchy.join}
      WHERE a.TenantId = @TenantId${agencyStatusFilter}
      ${orderBy}
    `);
    
    const countMap = await batchTotalAgentCountsByAgency(pool, tenantId);
    const agenciesWithCounts = (agenciesResult.recordset || []).map((agency) => ({
      ...agency,
      TotalAgentCount: countMap.get(normalizeAgencyKey(agency.AgencyId)) ?? 0
    }));

    let agencyMrrMap = new Map();
    try {
      agencyMrrMap = await getMonthlyRecurringRevenueByAgencyMap(pool, tenantId);
    } catch (mrrErr) {
      logger.warn('Could not load agency MRR for hierarchy', { error: mrrErr.message, tenantId });
    }
    
    // Get all agents (both those with hierarchy records and direct agency agents)
    // Include agents with Status = 'Active' or 'Pending' to show all agents in hierarchy
    const agentsRequest = pool.request();
    agentsRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
    const agentsResult = await agentsRequest.query(`
      SELECT
        a.AgentId,
        a.AgencyId,
        a.BusinessName,
        a.CommissionRole,
        a.CommissionTierLevel,
        a.NPN,
        a.AgentCode,
        a.Status as AgentStatus,
        a.CommissionGroupId,
        cg.Name as CommissionGroupName,
        u.FirstName,
        u.LastName,
        u.Email,
        u.PhoneNumber,
        ah.HierarchyId,
        ah.ParentId,
        ah.Status as HierarchyStatus
      FROM oe.Agents a
      JOIN oe.Users u ON a.UserId = u.UserId
      LEFT JOIN oe.AgentHierarchy ah ON a.AgentId = ah.AgentId AND ah.Status = 'Active'
      LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
      WHERE a.TenantId = @TenantId
        AND a.Status IN ('Active', 'Pending')
        AND u.Status IN ('Active', 'Pending')
      ORDER BY u.FirstName, u.LastName
    `);
    
    // Build the hierarchy tree via the shared service so TenantAdmin and the
    // Agent-role view use identical nesting logic (no drift, no casing bugs).
    const mrrByAgencyKey = new Map();
    agenciesWithCounts.forEach((agency) => {
      const key = normalizeAgencyKey(agency.AgencyId);
      const mrr = agencyMrrMap.get(key);
      if (mrr != null) mrrByAgencyKey.set(key, mrr);
    });

    const agencies = buildAgenciesWithAgents(
      agenciesWithCounts,
      agentsResult.recordset,
      mrrByAgencyKey
    );

    const hierarchy = {
      tenant: {
        id: tenant.TenantId,
        name: tenant.Name,
        type: 'tenant',
        status: tenant.Status
      },
      agencies
    };

    console.log('✅ Hierarchy fetched successfully:', {
      agenciesCount: agencies.length,
      totalAgents: agentsResult.recordset.length,
      agentsByAgency: agencies.map((a) => ({
        agencyName: a.name,
        agentCount: a.agents.length
      }))
    });

    res.json({
      success: true,
      data: hierarchy
    });
    
  } catch (error) {
    console.error('❌ Error fetching hierarchy:', error);
    logger.error('Error fetching hierarchy', {
      error: error.message,
      stack: error.stack,
      tenantId: req.user.TenantId
    }, 'TenantAdmin');
    
    res.status(500).json({
      success: false,
      message: 'Failed to fetch hierarchy',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

function _safeJsonParseTraining(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return fallback;
  }
}

function _modulesByIdFromLibraryTraining(modulesJsonParsed) {
  const map = {};
  if (!Array.isArray(modulesJsonParsed)) return map;
  modulesJsonParsed.forEach(m => {
    if (m && m.id) map[m.id] = m;
  });
  return map;
}

async function _getOrgTrainingLibraryRowTraining(pool) {
  const request = pool.request();
  request.input('Scope', sql.NVarChar(50), 'Organization');
  const result = await request.query(`
    SELECT TOP 1 PackagesJson, ModulesJson
    FROM oe.TrainingLibrary
    WHERE Scope = @Scope
  `);
  return result.recordset[0] || null;
}

async function _queryTrainingTableFallback(requestFactory, queryText) {
  try {
    return await requestFactory().query(queryText);
  } catch (error) {
    const msg = String(error?.message || '');
    if (msg.includes('Invalid object name')) return { recordset: [] };
    throw error;
  }
}

/**
 * @route GET /api/tenant-admin/agents/:id/training-progress
 * @desc Library + product training progress for an agent (for admin modal). Does not honor agent-portal training kill switch.
 * @access TenantAdmin, SysAdmin, Agent (same visibility as GET /agents/:id)
 */
router.get('/agents/:id/training-progress', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    const request = pool.request();
    request.input('Id', sql.UniqueIdentifier, id);

    let whereClause = 'Id = @Id';
    if (!userRoles.includes('SysAdmin')) {
      request.input('TenantId', sql.UniqueIdentifier, req.tenantId);
      whereClause += ' AND TenantId = @TenantId';
    }

    const entityResult = await request.query(`
      SELECT TOP 1 *
      FROM ${SQL_TENANTS_AGENTS_AGENCIES_UNION} v
      WHERE ${whereClause}
    `);

    if (entityResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Agent or agency not found' });
    }

    const entity = entityResult.recordset[0];
    if (entity.Type !== 'Agent') {
      return res.status(400).json({ success: false, message: 'Training progress applies to agents only' });
    }

    const downlineId = entity.AgentId || entity.Id || id;

    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      const viewerAgentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!viewerAgentId) {
        return res.status(403).json({ success: false, message: 'Agent profile not found' });
      }
      const downlineIdStr = String(downlineId).toLowerCase();
      const currentAgentIdStr = String(viewerAgentId).toLowerCase();
      const isSelf = downlineIdStr === currentAgentIdStr;
      const isOwner = entity.AgencyId ? await isAgencyOwner(pool, entity.AgencyId, viewerAgentId) : false;
      const isDirect = await isDirectUpline(pool, downlineId, viewerAgentId);
      const isAncestor = await isUplineAncestor(pool, downlineId, viewerAgentId);
      if (!isSelf && !isOwner && !isDirect && !isAncestor) {
        return res.status(403).json({ success: false, message: 'You do not have permission to view this agent' });
      }
    }

    const tenantId = req.tenantId;
    const targetAgentId = downlineId;

    const libRow = await _getOrgTrainingLibraryRowTraining(pool);
    const packagesJson = libRow ? _safeJsonParseTraining(libRow.PackagesJson, []) : [];
    const modulesJson = libRow ? _safeJsonParseTraining(libRow.ModulesJson, []) : [];
    const moduleById = _modulesByIdFromLibraryTraining(modulesJson);

    const assignReq = pool.request();
    assignReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    const assignResult = await assignReq.query(`
      SELECT PackageId
      FROM oe.TenantTrainingPackageAssignments
      WHERE TenantId = @TenantId AND IsActive = 1
    `);
    const assignedPackageIds = new Set((assignResult.recordset || []).map(r => r.PackageId).filter(Boolean));

    const compReq = pool.request();
    compReq.input('AgentId', sql.UniqueIdentifier, targetAgentId);
    const compResult = await compReq.query(`
      SELECT PackageId, ModuleId, CompletedAt
      FROM oe.AgentTrainingLibraryModuleCompletions
      WHERE AgentId = @AgentId
    `);
    const completionRows = compResult.recordset || [];
    const completionKey = row => `${row.PackageId}\0${row.ModuleId}`;
    const completionMap = {};
    completionRows.forEach(row => {
      const k = completionKey(row);
      if (!completionMap[k] || new Date(row.CompletedAt) > new Date(completionMap[k].CompletedAt)) {
        completionMap[k] = row;
      }
    });

    const libraryPackages = [];
    if (Array.isArray(packagesJson)) {
      packagesJson.forEach(pkg => {
        if (!pkg || !pkg.id || !assignedPackageIds.has(pkg.id)) {
          return;
        }
        const assignments = Array.isArray(pkg.moduleAssignments) ? [...pkg.moduleAssignments] : [];
        assignments.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const modules = assignments.map(a => {
          const mod = moduleById[a.moduleId] || null;
          const k = completionKey({ PackageId: pkg.id, ModuleId: a.moduleId });
          const done = Boolean(completionMap[k]);
          return {
            moduleId: a.moduleId,
            title: mod ? mod.title : a.moduleId,
            required: Boolean(a.required),
            order: a.order ?? 0,
            completed: done,
            completedAt: done ? completionMap[k].CompletedAt : null
          };
        });
        const modulesTotal = modules.length;
        const modulesCompleted = modules.filter(m => m.completed).length;
        libraryPackages.push({
          packageId: pkg.id,
          title: pkg.title || pkg.id,
          status: pkg.status || null,
          modulesTotal,
          modulesCompleted,
          modules
        });
      });
    }

    let libraryQuizzes = [];
    const quizReq = pool.request();
    quizReq.input('AgentId', sql.UniqueIdentifier, targetAgentId);
    const quizResult = await _queryTrainingTableFallback(
      () => quizReq,
      `
        SELECT PackageId, ModuleId, StepId, QuizId, CorrectAnswers, TotalQuestions, ScorePercent, CompletedAt
        FROM oe.AgentTrainingLibraryQuizCompletions
        WHERE AgentId = @AgentId
        ORDER BY CompletedAt DESC
      `
    );
    libraryQuizzes = (quizResult.recordset || []).map(row => {
      const mod = moduleById[row.ModuleId] || null;
      let stepLabel = String(row.StepId || '');
      if (mod && Array.isArray(mod.moduleSteps)) {
        const st = mod.moduleSteps.find(s => s && s.id === row.StepId);
        if (st && st.title) stepLabel = st.title;
      }
      const pkgMeta = Array.isArray(packagesJson) ? packagesJson.find(p => p && p.id === row.PackageId) : null;
      return {
        packageId: String(row.PackageId),
        packageTitle: pkgMeta ? pkgMeta.title || row.PackageId : String(row.PackageId),
        moduleId: String(row.ModuleId),
        moduleTitle: mod ? mod.title : row.ModuleId,
        stepId: String(row.StepId),
        stepTitle: stepLabel,
        quizId: String(row.QuizId),
        correctAnswers: Number(row.CorrectAnswers || 0),
        totalQuestions: Number(row.TotalQuestions || 0),
        scorePercent: Number(row.ScorePercent || 0),
        completedAt: row.CompletedAt ? new Date(row.CompletedAt).toISOString() : null
      };
    });

    const productRequest = pool.request();
    productRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
    const productResult = await productRequest.query(`
      SELECT DISTINCT
        p.ProductId, p.Name, p.TrainingConfig
      FROM oe.Products p
      LEFT JOIN oe.TenantProductSubscriptions tps ON p.ProductId = tps.ProductId
        AND tps.TenantId = @TenantId AND tps.SubscriptionStatus != 'Cancelled'
      WHERE p.Status = 'Active'
      AND (p.ProductOwnerId = @TenantId OR tps.TenantId = @TenantId)
      AND p.TrainingConfig IS NOT NULL
      ORDER BY p.Name
    `);

    const tcReq = pool.request();
    tcReq.input('AgentId', sql.UniqueIdentifier, targetAgentId);
    const tcResult = await tcReq.query(`
      SELECT ProductId, AttemptNumber, ScorePercent, TotalQuestions, CorrectAnswers, CompletedAt
      FROM oe.TrainingCompletions
      WHERE AgentId = @AgentId
      ORDER BY CompletedAt DESC
    `);
    const completionsByProduct = {};
    (tcResult.recordset || []).forEach(row => {
      const key = row.ProductId;
      if (!completionsByProduct[key]) {
        completionsByProduct[key] = row;
      }
    });

    const productTraining = (productResult.recordset || [])
      .map(row => {
        const config = _safeJsonParseTraining(row.TrainingConfig, {});
        const agentTraining = config.agentTraining || null;
        if (!agentTraining) return null;
        const passingScore = agentTraining.passingScorePercent ?? 80;
        const questions = agentTraining.questions || [];
        const last = completionsByProduct[row.ProductId] || null;
        const scorePercent = last ? Number(last.ScorePercent) : null;
        const passed = last != null && scorePercent != null && scorePercent >= passingScore;
        return {
          productId: row.ProductId,
          name: row.Name,
          requiredForSell: Boolean(agentTraining.requiredForSell),
          passingScorePercent: passingScore,
          questionsCount: questions.length,
          modulesCount: (agentTraining.modules || []).length,
          lastScorePercent: scorePercent,
          lastTotalQuestions: last ? Number(last.TotalQuestions) : null,
          lastCorrectAnswers: last ? Number(last.CorrectAnswers) : null,
          lastAttemptNumber: last ? Number(last.AttemptNumber) : null,
          passed,
          lastCompletedAt: last && last.CompletedAt ? new Date(last.CompletedAt).toISOString() : null
        };
      })
      .filter(Boolean);

    return res.json({
      success: true,
      data: {
        agentId: targetAgentId,
        libraryPackages,
        libraryQuizzes,
        productTraining
      }
    });
  } catch (error) {
    console.error('Error fetching agent training progress:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch training progress',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route GET /api/tenant-admin/agents/:id
 * @desc Get single agent or agency details
 * @access TenantAdmin, SysAdmin, Agent (if owner of agent's agency)
 * Handles both AgentId and UserId input for flexible querying
 */
router.get('/agents/:id', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await getPool();
    const request = pool.request();
    const userRoles = getUserRoles(req.user);
    
    request.input('Id', sql.UniqueIdentifier, id);
    
    // Tenant isolation
    if (!userRoles.includes('SysAdmin')) {
      request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    }
    
    // Get basic info from the view
    let whereClause = 'Id = @Id';
    if (!userRoles.includes('SysAdmin')) {
      whereClause += ' AND TenantId = @TenantId';
    }
    
    const result = await request.query(`
      SELECT *
      FROM ${SQL_TENANTS_AGENTS_AGENCIES_UNION} v
      WHERE ${whereClause}
    `);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent or agency not found'
      });
    }
    
    const entity = result.recordset[0];
    
    // Check if agent is owner of this agency (for Agent role)
    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      const agentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!agentId) {
        return res.status(403).json({
          success: false,
          message: 'Agent profile not found'
        });
      }
      
      // If viewing an agency, check if agent owns it
      if (entity.Type === 'Agency') {
        const isOwner = await isAgencyOwner(pool, id, agentId);
        if (!isOwner) {
          return res.status(403).json({
            success: false,
            message: 'You do not have permission to view this agency'
          });
        }
      } else if (entity.Type === 'Agent') {
        // Requested agent id: view may expose Id (primary key) or AgentId for agent rows
        const downlineId = entity.AgentId || entity.Id || id;
        const downlineIdStr = String(downlineId).toLowerCase();
        const currentAgentIdStr = String(agentId).toLowerCase();
        const isSelf = downlineIdStr === currentAgentIdStr;
        const isOwner = entity.AgencyId ? await isAgencyOwner(pool, entity.AgencyId, agentId) : false;
        const isDirect = await isDirectUpline(pool, downlineId, agentId);
        const isAncestor = await isUplineAncestor(pool, downlineId, agentId);
        if (!isSelf && !isOwner && !isDirect && !isAncestor) {
          console.log('[GET agent/:id] Agent permission denied', {
            downlineId: downlineIdStr,
            currentAgentId: currentAgentIdStr,
            isSelf,
            isOwner,
            isDirect,
            isAncestor
          });
          return res.status(403).json({
            success: false,
            message: 'You do not have permission to view this agent'
          });
        }
      }
    }
    
    // Get additional details for agencies
    if (entity.Type === 'Agency') {
      try {
        // Check if CommissionTierLevel column exists
        const tierColumnCheckRequest = pool.request();
        const tierColumnCheckResult = await tierColumnCheckRequest.query(`
          SELECT COUNT(*) as count 
          FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_NAME = 'Agencies' 
          AND COLUMN_NAME = 'CommissionTierLevel' 
          AND TABLE_SCHEMA = 'oe'
        `);
        const tierColumnExists = tierColumnCheckResult.recordset[0].count > 0;
        
        const agencyIdRequest = pool.request();
        agencyIdRequest.input('AgencyId', sql.UniqueIdentifier, id);
        
        if (!getUserRoles(req.user).includes('SysAdmin')) {
          agencyIdRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        let agencyWhereClause = 'WHERE AgencyId = @AgencyId';
        if (!getUserRoles(req.user).includes('SysAdmin')) {
          agencyWhereClause += ' AND TenantId = @TenantId';
        }
        
        // Build SELECT query conditionally based on column existence
        const tierSelect = tierColumnExists 
          ? 'ISNULL(CommissionTierLevel, 0) as CommissionTierLevel'
          : '0 as CommissionTierLevel';
        
        const agencyResult = await agencyIdRequest.query(`
          SELECT ContactName, EIN, AgencyType, CommissionRole, DistributionChannel,
                 Address, City, State, ZipCode,
                 ${tierSelect}
          FROM oe.Agencies
          ${agencyWhereClause}
        `);
        
        if (agencyResult.recordset.length > 0) {
          const agencyRecord = agencyResult.recordset[0];
          entity.ContactName = agencyRecord.ContactName;
          entity.EIN = agencyRecord.EIN;
          entity.AgencyType = agencyRecord.AgencyType;
          entity.CommissionRole = agencyRecord.CommissionRole;
          entity.DistributionChannel = agencyRecord.DistributionChannel;
          entity.Address = agencyRecord.Address;
          entity.City = agencyRecord.City;
          entity.State = agencyRecord.State;
          entity.ZipCode = agencyRecord.ZipCode;
          entity.CommissionTierLevel = agencyRecord.CommissionTierLevel || 0;
          
          // Fetch ACH info from ACHAccounts table
          try {
            const achService = require('../services/ACHService');
            const achAccount = await achService.getACHAccount('Agency', id, true); // includeDecrypted = true
            if (achAccount) {
              entity.BankName = achAccount.BankName;
              entity.AccountHolderName = achAccount.AccountHolderName;
              entity.AccountType = achAccount.AccountType;
              entity.AchRoutingNumber = achAccount.RoutingNumber; // Decrypted
              entity.AchAccountNumber = achAccount.AccountNumber; // Decrypted
              entity.AccountNumberLast4 = achAccount.AccountNumberLast4; // Last 4 digits for display
            }
          } catch (achError) {
            console.error('Error fetching ACH account for agency:', achError);
            // Continue without ACH info
          }
        }
        
        // For agencies, no licenses/documents
        entity.licenses = [];
        entity.documents = [];
      } catch (error) {
        console.error('Error fetching agency details:', error);
        // Set defaults even if query fails
        entity.licenses = [];
        entity.documents = [];
      }
    }
    
    // Get additional details for agents
    if (entity.Type === 'Agent') {
      // Try to find agent by AgentId first, then by UserId
      const agentIdRequest = pool.request();
      agentIdRequest.input('AgentId', sql.UniqueIdentifier, id);
      
      const agentByIdResult = await agentIdRequest.query(`
        SELECT a.AgentId, a.UserId, a.TenantId, a.Status, a.SSNOrTaxID, a.BusinessName, a.IDType,
               a.Address1, a.City, a.State, a.ZipCode, a.FirstName, a.LastName, a.Email, a.Phone, a.NPN, a.CommissionRole, a.AdvanceMonths,
               ISNULL(a.CommissionTierLevel, 0) as CommissionTierLevel,
               a.CommissionGroupId,
               a.AgentCode,
               u.ProfileImageUrl
        FROM oe.Agents a
        LEFT JOIN oe.Users u ON a.UserId = u.UserId
        WHERE a.AgentId = @AgentId
      `);
      
      let agentRecord = null;
      let agentId = null;
      
      if (agentByIdResult.recordset.length > 0) {
        // ID was AgentId
        agentRecord = agentByIdResult.recordset[0];
        agentId = agentRecord.AgentId;
        console.log('🔍 BACKEND - Agent details query result:', agentRecord);
      } else {
        // Try as UserId
        const userIdRequest = pool.request();
        userIdRequest.input('UserId', sql.UniqueIdentifier, id);
        
        const agentByUserIdResult = await userIdRequest.query(`
          SELECT AgentId, UserId, TenantId, Status, SSNOrTaxID, BusinessName, IDType,
                 Address1, City, State, ZipCode, FirstName, LastName, Email, Phone, NPN, CommissionRole, AdvanceMonths,
                 ISNULL(CommissionTierLevel, 0) as CommissionTierLevel,
                 CommissionGroupId,
                 AgentCode
          FROM oe.Agents WHERE UserId = @UserId
        `);
        
        if (agentByUserIdResult.recordset.length > 0) {
          agentRecord = agentByUserIdResult.recordset[0];
          agentId = agentRecord.AgentId;
          console.log('🔍 BACKEND - Agent details query result (by UserId):', agentRecord);
        }
      }
      
      if (agentRecord && agentId) {
        // Add additional fields to entity
        entity.UserId = agentRecord.UserId; // For change-email and other UserId-based operations
        entity.SSNOrTaxID = agentRecord.SSNOrTaxID;
        entity.BusinessName = agentRecord.BusinessName;
        entity.IDType = agentRecord.IDType;
        entity.Address = agentRecord.Address1; // Map Address1 to Address for frontend
        entity.City = agentRecord.City;
        entity.State = agentRecord.State;
        entity.ZipCode = agentRecord.ZipCode;
        entity.FirstName = agentRecord.FirstName;
        entity.LastName = agentRecord.LastName;
        entity.Email = agentRecord.Email;
        entity.Phone = agentRecord.Phone;
        entity.NPN = agentRecord.NPN;
        entity.CommissionRole = agentRecord.CommissionRole;
        entity.AdvanceMonths = agentRecord.AdvanceMonths;
        entity.CommissionTierLevel = agentRecord.CommissionTierLevel;
        entity.CommissionGroupId = agentRecord.CommissionGroupId || null;
        entity.AgentCode = agentRecord.AgentCode || null;
        entity.ProfileImageUrl = agentRecord.ProfileImageUrl || null;
        
        // Get licenses
        const licensesRequest = pool.request();
        licensesRequest.input('AgentId', sql.UniqueIdentifier, agentId);
        
        const licensesResult = await licensesRequest.query(`
          SELECT 
            LicenseId,
            AgentId,
            StateCode,
            LicenseNumber,
            LicenseType,
            ExpirationDate,
            IssueDate,
            Status,
            UploadedDocumentUrl,
            CreatedDate,
            ModifiedDate,
            CreatedBy,
            ModifiedBy
          FROM oe.AgentLicenses
          WHERE AgentId = @AgentId
          ORDER BY StateCode
        `);
        
        // Get documents
        const documentsRequest = pool.request();
        documentsRequest.input('AgentId', sql.UniqueIdentifier, agentId);
        
        const documentsResult = await documentsRequest.query(`
          SELECT 
            DocumentId,
            AgentId,
            DocumentType,
            FileName,
            FileUrl,
            FileSize,
            FileType,
            Description,
            Status,
            CreatedDate
          FROM oe.AgentDocuments
          WHERE AgentId = @AgentId
          ORDER BY CreatedDate DESC
        `);
        
        entity.licenses = licensesResult.recordset;
        entity.documents = documentsResult.recordset;
        
        // Get direct parent (upline) from AgentHierarchy for display
        const parentRequest = pool.request();
        parentRequest.input('AgentId', sql.UniqueIdentifier, agentId);
        const parentResult = await parentRequest.query(`
          SELECT u.FirstName + ' ' + u.LastName as ParentAgentName, u.Email as ParentAgentEmail, ISNULL(a.CommissionRole, 'Agent') as ParentAgentCommissionRole
          FROM oe.AgentHierarchy ah
          INNER JOIN oe.Agents a ON ah.ParentId = a.AgentId AND a.Status = 'Active'
          INNER JOIN oe.Users u ON a.UserId = u.UserId
          WHERE ah.AgentId = @AgentId AND ah.Status = 'Active'
        `);
        if (parentResult.recordset.length > 0) {
          const p = parentResult.recordset[0];
          entity.ParentAgent = {
            Name: p.ParentAgentName,
            Email: p.ParentAgentEmail || '',
            CommissionRole: p.ParentAgentCommissionRole
          };
        }
      } else {
        entity.licenses = [];
        entity.documents = [];
      }
    } else {
      // For agencies, no licenses/documents
      entity.licenses = [];
      entity.documents = [];
    }
    
    // Authenticate blob URLs for agent data
    console.log('🔐 Authenticating URLs for agent:', entity.Name);
    
    // Authenticate licenses
    if (entity.licenses && entity.licenses.length > 0) {
      entity.licenses = await Promise.all(
        entity.licenses.map(license => authenticateUrls(license, ['UploadedDocumentUrl']))
      );
    }
    
    // Authenticate documents
    if (entity.documents && entity.documents.length > 0) {
      entity.documents = await Promise.all(
        entity.documents.map(document => authenticateUrls(document, ['FileUrl']))
      );
    }
    
    console.log('✅ Authentication complete for agent');
    console.log('🔍 BACKEND - Final entity being returned to frontend:', entity);
    
    res.json({
      success: true,
      data: entity
    });
    
  } catch (error) {
    console.error('❌ Error fetching agent/agency details:', {
      error: error.message,
      stack: error.stack,
      id: req.params.id,
      sqlError: error.originalError?.info?.message,
      sqlNumber: error.originalError?.info?.number
    });
    logger.error('Error fetching agent details', { 
      error: error.message, 
      id: req.params.id, 
      stack: error.stack,
      sqlError: error.originalError?.info?.message 
    }, 'TenantAdmin');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch agent details',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      sqlError: process.env.NODE_ENV === 'development' ? error.originalError?.info?.message : undefined
    });
  }
});

// backend/routes/tenant-admin-agents.js - FIXED CREATE AGENT ROUTE

/**
 * @route POST /api/tenant-admin/agents
 * @desc Create new agent - FIXED without GroupId
 * @access TenantAdmin, SysAdmin
 */
router.post('/agents', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    console.log('🔍 CREATE AGENT - Request body:', JSON.stringify(req.body, null, 2));
    
    const {
      firstName,
      lastName,
      email,
      phone,
      npn,
      commissionRole,
      agencyId,
      parentAgentId,
      status = 'Active',
      ssnOrTaxId,
      businessName,
      idType,
      address,
      city,
      state,
      zipCode,
      bankName,
      bankRoutingNumber,
      bankAccountNumber,
      commissionTierLevel,
      commissionLevelId
    } = req.body;
    
    console.log('🔍 CREATE AGENT - Extracted fields:', {
      idType,
      parentAgentId,
      agencyId,
      firstName,
      lastName,
      email
    });
    
    // Validation
    if (!firstName || !lastName || !email) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, and email are required'
      });
    }
    
    const pool = await getPool();
    const levelPolicy = await getCommissionLevelWritePolicy(req.user.TenantId);
    let resolvedCommissionLevel = null;
    if (commissionLevelId) {
      resolvedCommissionLevel = await validateCommissionLevelRequest(req.user.TenantId, commissionLevelId);
    } else if (levelPolicy.useCustomCommissionLevelsOnly) {
      return res.status(400).json({
        success: false,
        message: 'CommissionLevelId is required for this tenant.'
      });
    }
    
    // Check if user with this email already exists
    const emailCheckRequest = pool.request();
    emailCheckRequest.input('Email', sql.NVarChar, email);
    emailCheckRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    
    const emailCheckResult = await emailCheckRequest.query(`
      SELECT 
        u.UserId, 
        u.FirstName, 
        u.LastName, 
        u.Email, 
        u.Status as UserStatus,
        a.AgentId,
        a.Status as AgentStatus
      FROM oe.Users u
      LEFT JOIN oe.Agents a ON u.UserId = a.UserId
      WHERE u.Email = @Email AND u.TenantId = @TenantId
    `);
    
    let userId = null;
    let existingUser = null;
    
    if (emailCheckResult.recordset.length > 0) {
      existingUser = emailCheckResult.recordset[0];
      userId = existingUser.UserId;
      
      // Check if user is already an agent
      if (existingUser.AgentId) {
        return res.status(409).json({
          success: false,
          message: `A user with email ${email} already exists and is already registered as an agent. Please use a different email address.`
        });
      }
      
      // User exists but is not an agent - we'll reuse the existing user
      console.log('🔍 User already exists, reusing existing UserId:', userId);
    }
    
    const transaction = pool.transaction();
    
    try {
      await transaction.begin();
      
      // Create user record only if it doesn't exist
      if (!userId) {
        userId = uuidv4();
        const userRequest = transaction.request();
        
        userRequest.input('UserId', sql.UniqueIdentifier, userId);
        userRequest.input('FirstName', sql.NVarChar, firstName);
        userRequest.input('LastName', sql.NVarChar, lastName);
        userRequest.input('Email', sql.NVarChar, email);
        userRequest.input('Status', sql.NVarChar, status);
        userRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
        userRequest.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
        
        // Users table only gets basic contact info - address fields go to Agents table
        await userRequest.query(`
          INSERT INTO oe.Users (UserId, FirstName, LastName, Email, Status, TenantId, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
          VALUES (@UserId, @FirstName, @LastName, @Email, @Status, @TenantId, GETUTCDATE(), GETUTCDATE(), @CreatedBy, @CreatedBy)
        `);
      } else {
        // Update existing user's name if different
        if (existingUser.FirstName !== firstName || existingUser.LastName !== lastName) {
          const updateUserRequest = transaction.request();
          updateUserRequest.input('UserId', sql.UniqueIdentifier, userId);
          updateUserRequest.input('FirstName', sql.NVarChar, firstName);
          updateUserRequest.input('LastName', sql.NVarChar, lastName);
          updateUserRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
          
          await updateUserRequest.query(`
            UPDATE oe.Users 
            SET FirstName = @FirstName, LastName = @LastName, ModifiedDate = GETUTCDATE(), ModifiedBy = @ModifiedBy
            WHERE UserId = @UserId
          `);
        }
      }
      
      // Note: Assign Agent role AFTER transaction commit to avoid deadlock
      
      // Create agent record with all fields
      const agentId = uuidv4();
      const agentRequest = transaction.request();
      
      agentRequest.input('AgentId', sql.UniqueIdentifier, agentId);
      agentRequest.input('UserId', sql.UniqueIdentifier, userId);
      agentRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      agentRequest.input('Status', sql.NVarChar, status);
      agentRequest.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
      
      // Contact info (duplicated from Users for denormalization)
      agentRequest.input('Email', sql.NVarChar, email);
      agentRequest.input('FirstName', sql.NVarChar, firstName);
      agentRequest.input('LastName', sql.NVarChar, lastName);
      agentRequest.input('Phone', sql.NVarChar, phone || null);
      
      // Agent-specific fields
      agentRequest.input('NPN', sql.NVarChar, npn || null);
      agentRequest.input('CommissionRole', sql.NVarChar, commissionRole || null);
      agentRequest.input('AgencyId', sql.UniqueIdentifier, agencyId || null);
      agentRequest.input('SSNOrTaxID', sql.NVarChar, ssnOrTaxId || null);
      agentRequest.input('BusinessName', sql.NVarChar, businessName || null);
      agentRequest.input('IDType', sql.NVarChar, idType || null);
      
      // Address fields - note: table has Address1, not Address
      agentRequest.input('Address1', sql.NVarChar, address || null);
      agentRequest.input('City', sql.NVarChar, city || null);
      agentRequest.input('State', sql.Char, state || null);
      agentRequest.input('ZipCode', sql.NVarChar, zipCode || null);
      
      const newAgentCode = await generateAgentCode(transaction, req.user.TenantId);
      agentRequest.input('AgentCode', sql.NVarChar(50), newAgentCode);

      console.log('🔍 CREATE AGENT - About to insert with IDType:', idType);
      const agentsColumnCheck = await transaction.request().query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'oe'
          AND TABLE_NAME = 'Agents'
          AND COLUMN_NAME IN ('CommissionTierLevel', 'CommissionLevelId')
      `);
      const agentColumns = new Set((agentsColumnCheck.recordset || []).map((row) => row.COLUMN_NAME));

      const insertColumns = [
        'AgentId', 'UserId', 'TenantId', 'Status', 'Phone', 'NPN', 'CommissionRole', 'AgencyId',
        'SSNOrTaxID', 'BusinessName', 'IDType',
        'Address1', 'City', 'State', 'ZipCode',
        'Email', 'FirstName', 'LastName',
        'AgentCode',
        'CreatedDate', 'ModifiedDate', 'CreatedBy', 'ModifiedBy'
      ];
      const insertValues = [
        '@AgentId', '@UserId', '@TenantId', '@Status', '@Phone', '@NPN', '@CommissionRole', '@AgencyId',
        '@SSNOrTaxID', '@BusinessName', '@IDType',
        '@Address1', '@City', '@State', '@ZipCode',
        '@Email', '@FirstName', '@LastName',
        '@AgentCode',
        'GETUTCDATE()', 'GETUTCDATE()', '@CreatedBy', '@CreatedBy'
      ];

      if (agentColumns.has('CommissionTierLevel') && (commissionTierLevel !== undefined || resolvedCommissionLevel)) {
        const effectiveTierLevel = resolvedCommissionLevel ? Number(resolvedCommissionLevel.SortOrder) : commissionTierLevel;
        if (!resolvedCommissionLevel) {
          try {
            await assertCommissionTierNumericValid(pool, req.user.TenantId, levelPolicy, effectiveTierLevel);
          } catch (e) {
            await transaction.rollback();
            return res.status(e.statusCode || 400).json({ success: false, message: e.message });
          }
        }
        agentRequest.input('CommissionTierLevel', TIER_SQL, effectiveTierLevel === undefined ? null : Number(effectiveTierLevel));
        insertColumns.push('CommissionTierLevel');
        insertValues.push('@CommissionTierLevel');
      }

      if (agentColumns.has('CommissionLevelId') && commissionLevelId !== undefined) {
        if (!levelPolicy.commissionLevelsHybridEnabled && commissionLevelId) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: 'Custom commission levels are currently disabled for this tenant.'
          });
        }
        agentRequest.input('CommissionLevelId', sql.UniqueIdentifier, resolvedCommissionLevel ? resolvedCommissionLevel.CommissionLevelId : null);
        insertColumns.push('CommissionLevelId');
        insertValues.push('@CommissionLevelId');
      }

      await agentRequest.query(`
        INSERT INTO oe.Agents (
          ${insertColumns.join(', ')}
        ) VALUES (
          ${insertValues.join(', ')}
        )
      `);
      
      // Create bank information record if provided (matching onboarding.js pattern)
      if (bankName && bankRoutingNumber && bankAccountNumber) {
        try {
          const routingNumber = bankRoutingNumber.replace(/\D/g, '');
          const accountNumber = bankAccountNumber.replace(/\D/g, '');
          
          const bankInfoId = uuidv4();
          const bankRequest = transaction.request();
          
          bankRequest.input('BankInfoId', sql.UniqueIdentifier, bankInfoId);
          bankRequest.input('AgentId', sql.UniqueIdentifier, agentId);
          bankRequest.input('BankName', sql.NVarChar, bankName);
          bankRequest.input('AccountName', sql.NVarChar, `${firstName} ${lastName}`);
          bankRequest.input('AccountHolderType', sql.NVarChar, 'Individual'); // Individual or Business
          bankRequest.input('AccountType', sql.NVarChar, 'Checking'); // Checking or Savings
          bankRequest.input('RoutingNumber', sql.NVarChar, routingNumber);
          // Encrypt account number with AES-256-GCM (consistent with all other bank-info paths)
          bankRequest.input('AccountNumberEncrypted', sql.NVarChar, encryptionService.encrypt(accountNumber));
          bankRequest.input('AccountNumberLast4', sql.NVarChar, accountNumber.slice(-4));
          bankRequest.input('Status', sql.NVarChar, 'Active');
          bankRequest.input('IsDefault', sql.Bit, 1);
          bankRequest.input('VerificationStatus', sql.NVarChar, 'Pending');
          bankRequest.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
          
          await bankRequest.query(`
            INSERT INTO oe.AgentBankInfo (
              BankInfoId, AgentId, BankName, AccountName, AccountHolderType, AccountType,
              RoutingNumber, AccountNumberEncrypted, AccountNumberLast4,
              Status, IsDefault, VerificationStatus, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
            ) VALUES (
              @BankInfoId, @AgentId, @BankName, @AccountName, @AccountHolderType, @AccountType,
              @RoutingNumber, @AccountNumberEncrypted, @AccountNumberLast4,
              @Status, @IsDefault, @VerificationStatus, GETUTCDATE(), GETUTCDATE(), @CreatedBy, @CreatedBy
            )
          `);
        } catch (bankError) {
          console.error('⚠️ Warning: Failed to create bank info, but agent was created:', bankError.message);
          // Continue - agent was created successfully
        }
      }
      
      // Create agent hierarchy record if parentAgentId is provided
      if (parentAgentId) {
        try {
          // Determine final tenant ID
          const finalTenantId = getUserRoles(req.user).includes('SysAdmin') ? req.user.TenantId : req.user.TenantId;
          
          console.log('🏢 Creating agent hierarchy record with:', {
            parentAgentId,
            agentId,
            agencyId,
            finalTenantId
          });
          
          const hierarchyId = require('crypto').randomUUID();
          const hierarchyRequest = transaction.request();
          hierarchyRequest.input('HierarchyId', sql.UniqueIdentifier, hierarchyId);
          hierarchyRequest.input('Type', sql.NVarChar, 'Agent');
          hierarchyRequest.input('TenantId', sql.UniqueIdentifier, finalTenantId);
          hierarchyRequest.input('AgencyId', sql.UniqueIdentifier, agencyId || null);
          hierarchyRequest.input('AgentId', sql.UniqueIdentifier, agentId);
          hierarchyRequest.input('ParentId', sql.UniqueIdentifier, parentAgentId);
          hierarchyRequest.input('Status', sql.NVarChar, 'Active');
          
          await hierarchyRequest.query(`
            INSERT INTO oe.AgentHierarchy (
              HierarchyId, Type, TenantId, AgencyId, AgentId, ParentId, Status,
              CreatedDate, ModifiedDate
            ) VALUES (
              @HierarchyId, @Type, @TenantId, @AgencyId, @AgentId, @ParentId, @Status,
              GETUTCDATE(), GETUTCDATE()
            )
          `);
          
          console.log('✅ Agent hierarchy record created successfully:', {
            hierarchyId,
            agentId,
            parentId: parentAgentId,
            agencyId
          });
        } catch (hierarchyError) {
          console.error('❌ Failed to create agent hierarchy:', {
            error: hierarchyError.message,
            sqlMessage: hierarchyError.originalError?.info?.message,
            fullError: JSON.stringify(hierarchyError, null, 2)
          });
          // Continue - agent was created successfully
        }
      } else {
        console.log('ℹ️ No parentAgentId provided, skipping hierarchy creation');
      }
      
      await transaction.commit();
      
      // Assign Agent role using UserRolesService (outside transaction to avoid deadlock)
      try {
        await UserRolesService.assignRoleToUser(userId, 'Agent', req.user.UserId);
      } catch (roleError) {
        console.error('⚠️ Warning: Failed to assign Agent role, but user and agent were created:', roleError.message);
        // Continue - the user and agent were created successfully, role can be assigned manually if needed
      }
      
      logger.info('Agent created successfully', {
        agentId,
        userId,
        email,
        tenantId: req.user.TenantId,
        createdBy: req.user.UserId
      }, 'TenantAdmin');
      
      res.status(201).json({
        success: true,
        data: { agentId, userId, email },
        message: 'Agent created successfully'
      });
      
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    
  } catch (error) {
    console.error('❌ CREATE AGENT ERROR:', error);
    console.error('❌ Error message:', error.message);
    console.error('❌ Error stack:', error.stack);
    console.error('❌ SQL Error:', error.originalError);
    
    // Check for duplicate email error
    if (error.message && error.message.includes('UNIQUE KEY') && error.message.includes('UQ_Users_Email')) {
      return res.status(409).json({
        success: false,
        message: `A user with email ${email} already exists. Please use a different email address.`,
        error: 'Duplicate email address'
      });
    }
    
    logger.error('Error creating agent', { 
      error: error.message, 
      stack: error.stack,
      body: req.body,
      tenantId: req.user.TenantId,
      sqlError: error.originalError?.info // SQL Server specific error details
    }, 'TenantAdmin');
    
    // Return more detailed error in development
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create agent',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      details: process.env.NODE_ENV === 'development' ? error.originalError?.info?.message : undefined
    });
  }
});

/**
 * @route POST /api/tenant-admin/agents/agencies
 * @desc Create new agency
 * @access TenantAdmin, SysAdmin
 */
router.post('/agencies', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const {
      agencyName,
      ein,
      contactName,
      contactEmail,
      contactPhone,
      agencyType,
      commissionRole,
      distributionChannel,
      address,
      city,
      state,
      zipCode,
      bankName,
      accountHolderName,
      accountType,
      achRoutingNumber,
      achAccountNumber,
      status = 'Active',
      isPrimary = false,
      commissionTierLevel,
      commissionLevelId,
      ownerAgentId,
      agencyAdminAgentIds
    } = req.body;
    
    // Validation
    if (!agencyName || !contactEmail) {
      return res.status(400).json({
        success: false,
        message: 'Agency name and contact email are required'
      });
    }
    
    const pool = await getPool();
    const request = pool.request();
    const levelPolicy = await getCommissionLevelWritePolicy(req.user.TenantId);
    let resolvedCommissionLevel = null;

    if (commissionLevelId) {
      resolvedCommissionLevel = await validateCommissionLevelRequest(req.user.TenantId, commissionLevelId);
    } else if (levelPolicy.useCustomCommissionLevelsOnly) {
      return res.status(400).json({
        success: false,
        message: 'CommissionLevelId is required for this tenant.'
      });
    }
    
    const agencyId = uuidv4();
    const agencyCode = `AG${Date.now().toString().slice(-6)}`;
    
    request.input('AgencyId', sql.UniqueIdentifier, agencyId);
    request.input('AgencyCode', sql.NVarChar, agencyCode);
    request.input('AgencyName', sql.NVarChar, agencyName);
    request.input('ContactEmail', sql.NVarChar, contactEmail);
    request.input('Status', sql.NVarChar, status);
    request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    request.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
    request.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
    
    // Optional fields
    if (ein) request.input('EIN', sql.NVarChar, ein);
    if (contactName) request.input('ContactName', sql.NVarChar, contactName);
    if (contactPhone) request.input('ContactPhone', sql.NVarChar, contactPhone);
    if (agencyType) request.input('AgencyType', sql.NVarChar, agencyType);
    if (commissionRole) request.input('CommissionRole', sql.NVarChar, commissionRole);
    if (distributionChannel) request.input('DistributionChannel', sql.NVarChar, distributionChannel);
    if (address) request.input('Address', sql.NVarChar, address);
    if (city) request.input('City', sql.NVarChar, city);
    if (state) request.input('State', sql.NVarChar, state);
    if (zipCode) request.input('ZipCode', sql.NVarChar, zipCode);
    if (bankName) request.input('BankName', sql.NVarChar, bankName);
    if (achRoutingNumber) request.input('AchRoutingNumber', sql.NVarChar, achRoutingNumber);
    if (achAccountNumber) request.input('AchAccountNumber', sql.NVarChar, achAccountNumber);
    
    // Check if IsPrimary column exists
    const columnCheckRequest = pool.request();
    const columnCheckResult = await columnCheckRequest.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'Agencies' 
      AND COLUMN_NAME = 'IsPrimary' 
      AND TABLE_SCHEMA = 'oe'
    `);
    const isPrimaryColumnExists = columnCheckResult.recordset[0].count > 0;
    
    // Handle IsPrimary: if setting as primary, unset other primary agencies for this tenant
    if (isPrimaryColumnExists && isPrimary) {
      const unsetPrimaryRequest = pool.request();
      unsetPrimaryRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      unsetPrimaryRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
      await unsetPrimaryRequest.query(`
        UPDATE oe.Agencies 
        SET IsPrimary = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @ModifiedBy
        WHERE TenantId = @TenantId AND IsPrimary = 1
      `);
    }
    
    // Build dynamic SQL query
    const columns = ['AgencyId', 'AgencyCode', 'AgencyName', 'ContactEmail', 'Status', 'TenantId', 'CreatedDate', 'ModifiedDate', 'CreatedBy', 'ModifiedBy'];
    const values = ['@AgencyId', '@AgencyCode', '@AgencyName', '@ContactEmail', '@Status', '@TenantId', 'GETUTCDATE()', 'GETUTCDATE()', '@CreatedBy', '@ModifiedBy'];
    
    // Add IsPrimary if column exists
    if (isPrimaryColumnExists) {
      request.input('IsPrimary', sql.Bit, isPrimary ? 1 : 0);
      columns.push('IsPrimary');
      values.push('@IsPrimary');
    }
    
    if (ein) { columns.push('EIN'); values.push('@EIN'); }
    if (contactName) { columns.push('ContactName'); values.push('@ContactName'); }
    if (contactPhone) { columns.push('ContactPhone'); values.push('@ContactPhone'); }
    if (agencyType) { columns.push('AgencyType'); values.push('@AgencyType'); }
    if (commissionRole) { columns.push('CommissionRole'); values.push('@CommissionRole'); }
    if (distributionChannel) { columns.push('DistributionChannel'); values.push('@DistributionChannel'); }
    if (address) { columns.push('Address'); values.push('@Address'); }
    if (city) { columns.push('City'); values.push('@City'); }
    if (state) { columns.push('State'); values.push('@State'); }
    if (zipCode) { columns.push('ZipCode'); values.push('@ZipCode'); }
    // Add CommissionTierLevel if column exists and value is provided
    if (commissionTierLevel !== undefined || resolvedCommissionLevel) {
      const tierColumnCheckRequest = pool.request();
      const tierColumnCheckResult = await tierColumnCheckRequest.query(`
        SELECT COUNT(*) as count 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'Agencies' 
        AND COLUMN_NAME = 'CommissionTierLevel' 
        AND TABLE_SCHEMA = 'oe'
      `);
      const tierColumnExists = tierColumnCheckResult.recordset[0].count > 0;
      
      if (tierColumnExists) {
        // Determine the final tier level value
        let finalTierLevel = resolvedCommissionLevel
          ? Number(resolvedCommissionLevel.SortOrder)
          : commissionTierLevel;
        
        // Primary agencies: can only be 5 or 6
        if (isPrimaryColumnExists && isPrimary) {
          if (commissionTierLevel !== undefined && commissionTierLevel !== null && commissionTierLevel !== 5 && commissionTierLevel !== 6) {
            return res.status(400).json({
              success: false,
              message: 'Primary agencies can only have Commission Tier Level 5 (FMO) or 6 (Enterprise/Carrier)'
            });
          }
          // Auto-set to 6 if not provided
          finalTierLevel = commissionTierLevel !== undefined && commissionTierLevel !== null ? commissionTierLevel : 6;
        }
        
        if (!resolvedCommissionLevel) {
          try {
            await assertCommissionTierNumericValid(pool, req.user.TenantId, levelPolicy, finalTierLevel);
          } catch (e) {
            return res.status(e.statusCode || 400).json({ success: false, message: e.message });
          }
        }

        request.input('CommissionTierLevel', TIER_SQL, finalTierLevel === null || finalTierLevel === undefined ? null : (finalTierLevel || 0));
        columns.push('CommissionTierLevel');
        values.push('@CommissionTierLevel');
      }
    }

    if (resolvedCommissionLevel && levelPolicy.commissionLevelsHybridEnabled) {
      request.input('CommissionLevelId', sql.UniqueIdentifier, resolvedCommissionLevel.CommissionLevelId);
      columns.push('CommissionLevelId');
      values.push('@CommissionLevelId');
    } else if (commissionLevelId && !levelPolicy.commissionLevelsHybridEnabled) {
      return res.status(400).json({
        success: false,
        message: 'Custom commission levels are currently disabled for this tenant.'
      });
    }
    
    // Log the SQL query for debugging
    console.log('🔍 INSERT SQL:', `INSERT INTO oe.Agencies (${columns.join(', ')}) VALUES (${values.join(', ')})`);
    console.log('🔍 Columns count:', columns.length, 'Values count:', values.length);
    
    await request.query(`
      INSERT INTO oe.Agencies (${columns.join(', ')})
      VALUES (${values.join(', ')})
    `);

    const adminIds = Array.isArray(agencyAdminAgentIds)
      ? agencyAdminAgentIds
      : (ownerAgentId ? [ownerAgentId] : []);
    if (adminIds.length > 0) {
      try {
        await agencyAdmins.replaceAgencyAdmins(pool, agencyId, adminIds, req.user.TenantId);
        await agencyAdmins.ensureAgencyOwnerRolesForAgency(pool, agencyId, req.user.UserId || null);
      } catch (admErr) {
        if (admErr.statusCode === 400) {
          return res.status(400).json({ success: false, message: admErr.message });
        }
        throw admErr;
      }
    }
    
    // Save ACH information to ACHAccounts table if any ACH field was provided.
    // accountType defaults to 'Checking' so callers don't have to send it.
    const createAchProvided =
      bankName !== undefined ||
      accountHolderName !== undefined ||
      accountType !== undefined ||
      achRoutingNumber !== undefined ||
      achAccountNumber !== undefined;

    let createAchWarning = null;
    if (createAchProvided) {
      const resolvedAccountType = accountType || 'Checking';
      console.log('🔍 ACH Data Check (Create):', {
        accountHolderName: !!accountHolderName,
        achRoutingNumber: achRoutingNumber ? '***' : null,
        achAccountNumber: achAccountNumber ? '***' : null,
        accountType: resolvedAccountType,
        bankName
      });

      if (accountHolderName && achRoutingNumber && achAccountNumber) {
        try {
          console.log('💾 Saving ACH account for agency:', agencyId);
          const achService = require('../services/ACHService');
          const achResult = await achService.saveACHAccount('Agency', agencyId, {
            accountHolderName,
            bankName: bankName || null,
            routingNumber: achRoutingNumber,
            accountNumber: achAccountNumber,
            accountType: resolvedAccountType,
            isDefault: true,
            status: 'Active'
          }, req.user.UserId);
          console.log('✅ ACH account saved successfully:', achResult);
        } catch (achError) {
          console.error('❌ Error saving ACH account for agency:', achError);
          console.error('❌ Error stack:', achError.stack);
          createAchWarning = `ACH account could not be saved: ${achError.message}`;
        }
      } else {
        const missing = [];
        if (!accountHolderName) missing.push('Account Holder Name');
        if (!achRoutingNumber) missing.push('ACH Routing Number');
        if (!achAccountNumber) missing.push('ACH Account Number');
        createAchWarning = `ACH information is incomplete. Missing: ${missing.join(', ')}.`;
        console.log('⚠️ ACH data incomplete, skipping ACH account save:', missing);
      }
    }
    
    logger.info('Agency created successfully', {
      agencyId,
      agencyName,
      agencyType,
      distributionChannel,
      tenantId: req.user.TenantId,
      createdBy: req.user.UserId
    }, 'TenantAdmin');
    
    res.status(201).json({
      success: true,
      data: {
        agencyId,
        agencyCode,
        agencyName,
        achWarning: createAchWarning || undefined
      },
      message: createAchWarning
        ? `Agency created, but ${createAchWarning}`
        : 'Agency created successfully',
      warning: createAchWarning || undefined
    });
    
  } catch (error) {
    console.error('❌ Error creating agency - Full error:', error);
    console.error('❌ Error message:', error.message);
    console.error('❌ Error stack:', error.stack);
    if (error.originalError) {
      console.error('❌ Original error:', error.originalError);
      console.error('❌ Original error message:', error.originalError.message);
      if (error.originalError.info) {
        console.error('❌ SQL Error info:', error.originalError.info);
      }
    }
    
    logger.error('Error creating agency', { 
      error: error.message, 
      stack: error.stack,
      body: req.body,
      tenantId: req.user.TenantId,
      originalError: error.originalError?.message,
      sqlInfo: error.originalError?.info
    }, 'TenantAdmin');
    
    const errorMessage = error.originalError?.info?.message || error.message || 'Unknown error';
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create agency',
      error: process.env.NODE_ENV === 'development' ? errorMessage : undefined
    });
  }
});

/**
 * Helper function to check if agent is an admin of an agency (oe.AgencyAdmins)
 */
async function isAgencyOwner(pool, agencyId, agentId) {
  return agencyAdmins.isAgencyAdmin(pool, agencyId, agentId);
}

/**
 * Helper function to get agent's AgentId from UserId
 */
async function getAgentIdFromUserId(pool, userId) {
  if (!userId) return null;
  const agentRequest = pool.request();
  agentRequest.input('UserId', sql.UniqueIdentifier, userId);
  const agentResult = await agentRequest.query(`
    SELECT AgentId
    FROM oe.Agents
    WHERE UserId = @UserId AND Status = 'Active'
  `);
  return agentResult.recordset.length > 0 ? agentResult.recordset[0].AgentId : null;
}

/**
 * Check if uplineAgentId is the direct upline (parent) of downlineAgentId in oe.AgentHierarchy
 */
async function isDirectUpline(pool, downlineAgentId, uplineAgentId) {
  if (!downlineAgentId || !uplineAgentId) return false;
  const r = pool.request();
  r.input('DownlineAgentId', sql.UniqueIdentifier, downlineAgentId);
  r.input('UplineAgentId', sql.UniqueIdentifier, uplineAgentId);
  const result = await r.query(`
    SELECT 1 as ok
    FROM oe.AgentHierarchy
    WHERE AgentId = @DownlineAgentId AND ParentId = @UplineAgentId AND Status = 'Active'
  `);
  return result.recordset.length > 0;
}

/**
 * Check if uplineAgentId is an ancestor (direct or indirect upline) of downlineAgentId in oe.AgentHierarchy
 */
async function isUplineAncestor(pool, downlineAgentId, uplineAgentId) {
  if (!downlineAgentId || !uplineAgentId) return false;
  const r = pool.request();
  r.input('DownlineAgentId', sql.UniqueIdentifier, downlineAgentId);
  r.input('UplineAgentId', sql.UniqueIdentifier, uplineAgentId);
  const result = await r.query(`
    WITH Ancestors AS (
      SELECT AgentId, ParentId, 1 as lvl
      FROM oe.AgentHierarchy
      WHERE AgentId = @DownlineAgentId AND Status = 'Active'
      UNION ALL
      SELECT ah.AgentId, ah.ParentId, a.lvl + 1
      FROM oe.AgentHierarchy ah
      INNER JOIN Ancestors a ON ah.AgentId = a.ParentId AND ah.Status = 'Active'
      WHERE a.lvl < 20
    )
    SELECT 1 as ok FROM Ancestors WHERE ParentId = @UplineAgentId
  `);
  return result.recordset.length > 0;
}

/**
 * @route GET /api/tenant-admin/agencies/:id
 * @desc Get agency details with all fields
 * @access TenantAdmin, SysAdmin, Agent (if owner of agency)
 */
router.get('/agencies/:id', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await getPool();
    const request = pool.request();
    const userRoles = getUserRoles(req.user);
    
    request.input('AgencyId', sql.UniqueIdentifier, id);
    request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    
    // Check if agent is owner of this agency
    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      const agentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!agentId) {
        return res.status(403).json({
          success: false,
          message: 'Agent profile not found'
        });
      }
      const isOwner = await isAgencyOwner(pool, id, agentId);
      if (!isOwner) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to view this agency'
        });
      }
    }
    
    const result = await request.query(`
      SELECT *
      FROM oe.Agencies
      WHERE AgencyId = @AgencyId AND TenantId = @TenantId
    `);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agency not found'
      });
    }
    
    const agency = result.recordset[0];

    const adminsReq = pool.request();
    adminsReq.input('AgencyId', sql.UniqueIdentifier, id);
    const adminsResult = await adminsReq.query(`
      SELECT aa.AgentId, u.FirstName, u.LastName, u.Email
      FROM oe.AgencyAdmins aa
      INNER JOIN oe.Agents a ON a.AgentId = aa.AgentId AND a.Status = 'Active'
      INNER JOIN oe.Users u ON u.UserId = a.UserId
      WHERE aa.AgencyId = @AgencyId AND aa.Status = 'Active'
      ORDER BY aa.AgentId
    `);
    agency.AgencyAdminAgentIds = (adminsResult.recordset || []).map((r) => r.AgentId);
    agency.AgencyAdmins = (adminsResult.recordset || []).map((r) => ({
      AgentId: r.AgentId,
      Name: [r.FirstName, r.LastName].filter(Boolean).join(' ').trim() || r.Email || 'Agent',
      Email: r.Email
    }));

    agency.ActiveAgentCount = await countActiveAgentsInAgency(pool, id);
    
    // Fetch ACH info from ACHAccounts table
    try {
      const achService = require('../services/ACHService');
      const achAccount = await achService.getACHAccount('Agency', id, true); // includeDecrypted = true
      if (achAccount) {
        agency.BankName = achAccount.BankName;
        agency.AccountHolderName = achAccount.AccountHolderName;
        agency.AccountType = achAccount.AccountType;
        agency.AchRoutingNumber = achAccount.RoutingNumber; // Decrypted
        agency.AchAccountNumber = achAccount.AccountNumber; // Decrypted
        agency.AccountNumberLast4 = achAccount.AccountNumberLast4; // Last 4 digits for display
      }
    } catch (achError) {
      console.error('Error fetching ACH account for agency:', achError);
      // Continue without ACH info
    }
    
    res.json({
      success: true,
      data: agency
    });
    
  } catch (error) {
    logger.error('Error fetching agency details', { 
      error: error.message, 
      agencyId: req.params.id,
      tenantId: req.user.TenantId 
    }, 'TenantAdmin');
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch agency details',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route POST /api/tenant-admin/agencies/:id/duplicate-agent-admin
 * @desc Clone a tenant agent to a new login (new email) assigned to this agency and add as agency admin
 * @access TenantAdmin, SysAdmin
 */
router.post('/agencies/:id/duplicate-agent-admin', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id: agencyId } = req.params;
    const {
      sourceAgentId,
      targetEmail,
      copyPasswordHash = false,
      sendWelcomeEmail = true
    } = req.body || {};

    if (!sourceAgentId || !targetEmail) {
      return res.status(400).json({
        success: false,
        message: 'sourceAgentId and targetEmail are required'
      });
    }

    const tenantId = req.tenantId || req.user.TenantId;
    const pool = await getPool();
    const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;

    const result = await agencyAdminProvisioning.duplicateAgentAsAgencyAdmin(pool, {
      tenantId,
      targetAgencyId: agencyId,
      sourceAgentId,
      targetEmail,
      copyPasswordHash: Boolean(copyPasswordHash),
      sendWelcomeEmail: Boolean(sendWelcomeEmail),
      createdByUserId: req.user.UserId,
      baseUrl
    });

    return res.status(201).json({
      success: true,
      message: 'Agent duplicated and added as agency admin',
      data: result
    });
  } catch (error) {
    const status = error.statusCode || (error.message && error.message.includes('already exists') ? 409 : 500);
    logger.error('duplicate-agent-admin', { error: error.message, agencyId: req.params.id }, 'TenantAdmin');
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      message: error.message || 'Failed to duplicate agent',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route POST /api/tenant-admin/agencies/:id/invite-agent-admin
 * @desc Create a minimal agent on this agency and add as admin; user sets password via emailed link
 * @access TenantAdmin, SysAdmin
 */
router.post('/agencies/:id/invite-agent-admin', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { id: agencyId } = req.params;
    const {
      targetEmail,
      firstName,
      lastName,
      phoneNumber,
      commissionLevelId,
      sendWelcomeEmail = true
    } = req.body || {};

    if (!targetEmail || !String(targetEmail).trim()) {
      return res.status(400).json({
        success: false,
        message: 'targetEmail is required'
      });
    }

    const tenantId = req.tenantId || req.user.TenantId;
    const pool = await getPool();
    const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;

    const userRoles = getUserRoles(req.user);
    const isElevated = userRoles.includes('TenantAdmin') || userRoles.includes('SysAdmin');
    if (!isElevated) {
      const callerAgentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!callerAgentId) {
        return res.status(403).json({
          success: false,
          message: 'Agent profile not found'
        });
      }
      const isAdmin = await isAgencyOwner(pool, agencyId, callerAgentId);
      if (!isAdmin) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to invite admins for this agency'
        });
      }
    }
    let effectiveCommissionLevelId = isElevated ? (commissionLevelId || null) : null;
    if (!isElevated && !effectiveCommissionLevelId) {
      const flags = await CommissionLevelService.getTenantFlags(tenantId);
      if (flags.useCustomCommissionLevelsOnly) {
        const levels = await CommissionLevelService.listTenantLevels(tenantId);
        const tier1 = (levels || []).find((l) => Number(l.SortOrder) === 1) || (levels || [])[0];
        if (tier1 && tier1.CommissionLevelId) {
          effectiveCommissionLevelId = tier1.CommissionLevelId;
        }
      }
    }

    const emailNorm = String(targetEmail).trim().toLowerCase();
    const existingUserReq = await pool.request()
      .input('Email', sql.NVarChar, emailNorm)
      .query(`SELECT UserId FROM oe.Users WHERE LOWER(LTRIM(RTRIM(Email))) = @Email`);

    if (existingUserReq.recordset.length > 0) {
      const result = await agencyAdminProvisioning.addExistingUserAsAgencyAdmin(pool, {
        tenantId,
        targetAgencyId: agencyId,
        targetEmail: emailNorm,
        commissionLevelId: effectiveCommissionLevelId,
        createdByUserId: req.user.UserId
      });
      return res.status(201).json({
        success: true,
        message:
          result.addedAgencyAdminOnly === true
            ? 'Agency admin access added. They can sign in with their existing account.'
            : 'Agency admin added. They can sign in with their existing account.',
        data: result
      });
    }

    if (!String(firstName || '').trim() || !String(lastName || '').trim()) {
      return res.status(400).json({
        success: false,
        message:
          'No account exists for this email. Enter first name and last name to create a new user and send an invitation.'
      });
    }

    const result = await agencyAdminProvisioning.inviteAgentAsAgencyAdmin(pool, {
      tenantId,
      targetAgencyId: agencyId,
      targetEmail,
      firstName,
      lastName,
      phoneNumber,
      commissionLevelId: effectiveCommissionLevelId,
      sendWelcomeEmail: Boolean(sendWelcomeEmail),
      createdByUserId: req.user.UserId,
      baseUrl
    });

    return res.status(201).json({
      success: true,
      message: 'Invitation sent and agency admin added',
      data: result
    });
  } catch (error) {
    const status = error.statusCode || (error.message && error.message.includes('already exists') ? 409 : 500);
    logger.error('invite-agent-admin', { error: error.message, agencyId: req.params.id }, 'TenantAdmin');
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      message: error.message || 'Failed to invite agency admin',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route PUT /api/tenant-admin/agencies/:id/settings
 * @desc Merge-enabledCommissionLevelIds into oe.Agencies.Settings (TenantAdmin/SysAdmin).
 * @access TenantAdmin, SysAdmin
 */
router.put('/agencies/:id/settings', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  const { id: agencyId } = req.params;
  const { enabledCommissionLevelIds } = req.body || {};

  if (enabledCommissionLevelIds !== null && !Array.isArray(enabledCommissionLevelIds)) {
    return res.status(400).json({
      success: false,
      message: 'enabledCommissionLevelIds must be an array of CommissionLevelId strings, or null to clear.'
    });
  }
  if (Array.isArray(enabledCommissionLevelIds) && enabledCommissionLevelIds.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'At least one tier must be enabled.'
    });
  }

  try {
    const pool = await getPool();
    const belong = await pool.request()
      .input('AgencyId', sql.UniqueIdentifier, agencyId)
      .input('TenantId', sql.UniqueIdentifier, req.user.TenantId)
      .query(`
        SELECT 1 AS ok
        FROM oe.Agencies
        WHERE AgencyId = @AgencyId AND TenantId = @TenantId
      `);
    if (!belong.recordset.length) {
      return res.status(404).json({ success: false, message: 'Agency not found.' });
    }

    let validatedIds = null;
    if (Array.isArray(enabledCommissionLevelIds)) {
      const idsTable = enabledCommissionLevelIds
        .filter((s) => typeof s === 'string' && s.trim() !== '')
        .map((s) => s.trim().toUpperCase());
      if (idsTable.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'At least one tier must be enabled.'
        });
      }
      const idsCsv = idsTable.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
      const lookup = await pool.request()
        .input('agencyId', sql.UniqueIdentifier, agencyId)
        .query(`
          SELECT cl.CommissionLevelId
          FROM oe.CommissionLevels cl
          INNER JOIN oe.Agencies a ON a.TenantId = cl.TenantId
          WHERE a.AgencyId = @agencyId
            AND cl.IsActive = 1
            AND UPPER(CAST(cl.CommissionLevelId AS NVARCHAR(36))) IN (${idsCsv})
        `);
      validatedIds = (lookup.recordset || []).map((r) => String(r.CommissionLevelId));
      if (validatedIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No valid CommissionLevelIds match this agency tenant.'
        });
      }
    }

    const tx = new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
    try {
      const txReq = new sql.Request(tx);
      txReq.input('agencyId', sql.UniqueIdentifier, agencyId);
      const existing = await txReq.query(`
        SELECT Settings
        FROM oe.Agencies WITH (UPDLOCK, HOLDLOCK)
        WHERE AgencyId = @agencyId
      `);
      if (existing.recordset.length === 0) {
        await tx.rollback();
        return res.status(404).json({ success: false, message: 'Agency not found.' });
      }
      let settings = {};
      const raw = existing.recordset[0].Settings;
      if (raw) {
        try {
          settings = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            settings = {};
          }
        } catch (_) {
          settings = {};
        }
      }
      settings.enabledCommissionLevelIds = validatedIds;
      const merged = JSON.stringify(settings);

      await txReq.input('settings', sql.NVarChar(sql.MAX), merged).query(`
        UPDATE oe.Agencies
        SET Settings = @settings, ModifiedDate = GETDATE()
        WHERE AgencyId = @agencyId
      `);
      await tx.commit();

      logger.info(
        `[TENANT-ADMIN-AGENCIES] agency ${agencyId} enabledCommissionLevelIds updated by UserId=${req.user.UserId}`
      );
      return res.json({
        success: true,
        data: { enabledCommissionLevelIds: validatedIds }
      });
    } catch (e) {
      try {
        await tx.rollback();
      } catch (_) {
        /* swallow */
      }
      throw e;
    }
  } catch (error) {
    logger.error('[TENANT-ADMIN-AGENCIES] Failed to update agency settings:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update agency settings',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @route PUT /api/tenant-admin/agencies/:id
 * @desc Update agency
 * @access TenantAdmin, SysAdmin, Agent (if owner of agency)
 */
router.put('/agencies/:id', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { id } = req.params; // This is AgencyId
    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    
    // Check if agent is owner of this agency
    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      const agentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!agentId) {
        return res.status(403).json({
          success: false,
          message: 'Agent profile not found'
        });
      }
      const isOwner = await isAgencyOwner(pool, id, agentId);
      if (!isOwner) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to update this agency'
        });
      }
    }
    let {
      agencyName,
      ein,
      contactName,
      contactEmail,
      contactPhone,
      agencyType,
      commissionRole,
      commissionTierLevel,
      commissionLevelId,
      distributionChannel,
      address,
      city,
      state,
      zipCode,
      bankName,
      accountHolderName,
      accountType,
      achRoutingNumber,
      achAccountNumber,
      status,
      isPrimary,
      ownerAgentId,
      agencyAdminAgentIds,
      commissionGroupId
    } = req.body;
    const levelPolicy = await getCommissionLevelWritePolicy(req.user.TenantId);
    let resolvedCommissionLevel = null;
    if (commissionLevelId) {
      resolvedCommissionLevel = await validateCommissionLevelRequest(req.user.TenantId, commissionLevelId);
    } else if (levelPolicy.useCustomCommissionLevelsOnly && commissionTierLevel === undefined) {
      return res.status(400).json({
        success: false,
        message: 'CommissionLevelId is required for this tenant.'
      });
    }

    // Agency owners (Agent role) cannot change status, commission tier, or commission group — only TenantAdmin/SysAdmin
    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      const snapReq = pool.request();
      snapReq.input('AgencyId', sql.UniqueIdentifier, id);
      snapReq.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      const snapRes = await snapReq.query(`
        SELECT Status, CommissionTierLevel, CommissionGroupId
        FROM oe.Agencies
        WHERE AgencyId = @AgencyId AND TenantId = @TenantId
      `);
      if (snapRes.recordset.length > 0) {
        const row = snapRes.recordset[0];
        status = row.Status;
        commissionTierLevel = undefined;
        commissionGroupId = undefined;
        resolvedCommissionLevel = null;
      }
    }
    
    // Validation
    if (!agencyName || !contactEmail) {
      return res.status(400).json({
        success: false,
        message: 'Agency name and contact email are required'
      });
    }

    const nextStatus = status || 'Active';
    if (nextStatus === 'Inactive') {
      const activeAgentCount = await countActiveAgentsInAgency(pool, id);
      if (activeAgentCount > 0) {
        return res.status(400).json({
          success: false,
          message: `Cannot deactivate agency: ${activeAgentCount} active agent(s) are still assigned. Reassign or deactivate them first.`,
          activeAgentCount
        });
      }
    }

    const canManageTenantPrimary = userCanManageTenantPrimaryAgency(userRoles);
    if (!canManageTenantPrimary) {
      isPrimary = undefined;
    }
    
    const tenantId = req.tenantId || req.user.TenantId;

    const request = pool.request();
    
    request.input('AgencyId', sql.UniqueIdentifier, id);
    request.input('AgencyName', sql.NVarChar, agencyName);
    request.input('ContactEmail', sql.NVarChar, contactEmail);
    request.input('Status', sql.NVarChar, status || 'Active');
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    request.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
    
    // Optional fields
    if (ein) request.input('EIN', sql.NVarChar, ein);
    if (contactName) request.input('ContactName', sql.NVarChar, contactName);
    if (contactPhone) request.input('ContactPhone', sql.NVarChar, contactPhone);
    if (agencyType) request.input('AgencyType', sql.NVarChar, agencyType);
    if (commissionRole) request.input('CommissionRole', sql.NVarChar, commissionRole);
    if (distributionChannel) request.input('DistributionChannel', sql.NVarChar, distributionChannel);
    if (address) request.input('Address', sql.NVarChar, address);
    if (city) request.input('City', sql.NVarChar, city);
    if (state) request.input('State', sql.NVarChar, state);
    if (zipCode) request.input('ZipCode', sql.NVarChar, zipCode);
    if (bankName) request.input('BankName', sql.NVarChar, bankName);
    if (achRoutingNumber) request.input('AchRoutingNumber', sql.NVarChar, achRoutingNumber);
    if (achAccountNumber) request.input('AchAccountNumber', sql.NVarChar, achAccountNumber);
    if (commissionGroupId !== undefined) {
      if (commissionGroupId) {
        const groupCheck = await pool.request()
          .input('CommissionGroupId', sql.UniqueIdentifier, commissionGroupId)
          .input('TenantId', sql.UniqueIdentifier, req.user.TenantId)
          .query(`
            SELECT 1 FROM oe.CommissionGroups
            WHERE CommissionGroupId = @CommissionGroupId AND TenantId = @TenantId
          `);
        if (groupCheck.recordset.length === 0) {
          return res.status(400).json({ success: false, message: 'Commission group not found or does not belong to your tenant' });
        }
      }
      request.input('CommissionGroupId', sql.UniqueIdentifier, commissionGroupId || null);
    }
    
    // Check if IsPrimary column exists
    const columnCheckRequest = pool.request();
    const columnCheckResult = await columnCheckRequest.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'Agencies' 
      AND COLUMN_NAME = 'IsPrimary' 
      AND TABLE_SCHEMA = 'oe'
    `);
    const isPrimaryColumnExists = columnCheckResult.recordset[0].count > 0;
    
    // IsPrimary: TenantAdmin/SysAdmin may transfer primary; agency admins cannot change it.
    let shouldUpdateIsPrimary = false;
    if (isPrimaryColumnExists && canManageTenantPrimary && isPrimary === true) {
      const currentAgencyRequest = pool.request();
      currentAgencyRequest.input('AgencyId', sql.UniqueIdentifier, id);
      currentAgencyRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      const currentAgencyResult = await currentAgencyRequest.query(`
        SELECT IsPrimary FROM oe.Agencies
        WHERE AgencyId = @AgencyId AND TenantId = @TenantId
      `);
      const isCurrentAgencyPrimary =
        currentAgencyResult.recordset.length > 0 &&
        currentAgencyResult.recordset[0].IsPrimary === true;

      if (!isCurrentAgencyPrimary) {
        await transferTenantPrimaryAgency(pool, tenantId, id, req.user.UserId);
        request.input('IsPrimary', sql.Bit, 1);
        shouldUpdateIsPrimary = true;
      }
    } else if (isPrimaryColumnExists && canManageTenantPrimary && isPrimary === false) {
      const currentAgencyRequest = pool.request();
      currentAgencyRequest.input('AgencyId', sql.UniqueIdentifier, id);
      currentAgencyRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      const currentAgencyResult = await currentAgencyRequest.query(`
        SELECT IsPrimary FROM oe.Agencies
        WHERE AgencyId = @AgencyId AND TenantId = @TenantId
      `);
      const isCurrentAgencyPrimary =
        currentAgencyResult.recordset.length > 0 &&
        currentAgencyResult.recordset[0].IsPrimary === true;
      if (isCurrentAgencyPrimary) {
        return res.status(400).json({
          success: false,
          message: 'Cannot remove primary status from this agency. Set another agency as primary instead.'
        });
      }
    }
    
    // Build dynamic SQL query
    const updates = [
      'AgencyName = @AgencyName',
      'ContactEmail = @ContactEmail',
      'Status = @Status',
      'ModifiedDate = GETUTCDATE()',
      'ModifiedBy = @ModifiedBy'
    ];
    
    // Only add IsPrimary to update if it was allowed by validation above
    if (isPrimaryColumnExists && shouldUpdateIsPrimary) {
      updates.push('IsPrimary = @IsPrimary');
    }
    if (ein) updates.push('EIN = @EIN');
    if (contactName) updates.push('ContactName = @ContactName');
    if (contactPhone) updates.push('ContactPhone = @ContactPhone');
    if (agencyType) updates.push('AgencyType = @AgencyType');
    if (commissionRole) updates.push('CommissionRole = @CommissionRole');
    if (distributionChannel) updates.push('DistributionChannel = @DistributionChannel');
    if (address) updates.push('Address = @Address');
    if (city) updates.push('City = @City');
    if (state) updates.push('State = @State');
    if (zipCode) updates.push('ZipCode = @ZipCode');
    if (commissionGroupId !== undefined) updates.push('CommissionGroupId = @CommissionGroupId');
    // Handle CommissionTierLevel if column exists and value is provided
    if (commissionTierLevel !== undefined || resolvedCommissionLevel) {
      const tierColumnCheckRequest = pool.request();
      const tierColumnCheckResult = await tierColumnCheckRequest.query(`
        SELECT COUNT(*) as count 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'Agencies' 
        AND COLUMN_NAME = 'CommissionTierLevel' 
        AND TABLE_SCHEMA = 'oe'
      `);
      const tierColumnExists = tierColumnCheckResult.recordset[0].count > 0;
      
      if (tierColumnExists) {
        // Check if this agency is primary (either currently or being set to primary in this update)
        const primaryCheckRequest = pool.request();
        primaryCheckRequest.input('AgencyId', sql.UniqueIdentifier, id);
        primaryCheckRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
        const primaryCheckResult = await primaryCheckRequest.query(`
          SELECT IsPrimary FROM oe.Agencies 
          WHERE AgencyId = @AgencyId AND TenantId = @TenantId
        `);
        const isCurrentlyPrimary = isPrimaryColumnExists && primaryCheckResult.recordset.length > 0 && 
                                   primaryCheckResult.recordset[0].IsPrimary === true;
        // Check if agency is being set to primary in this update
        const isBeingSetToPrimary = isPrimaryColumnExists && isPrimary === true;
        const isPrimaryAgency = isCurrentlyPrimary || isBeingSetToPrimary;
        
        // Primary agencies: can only be 5 or 6 — except null is also allowed
        // (None == primary still receives overflow but is excluded from the
        // tier-rule chain).
        const requestedRank = resolvedCommissionLevel ? Number(resolvedCommissionLevel.SortOrder) : commissionTierLevel;
        const explicitlyNull = requestedRank === null;
        if (isPrimaryAgency) {
          if (!explicitlyNull && requestedRank !== undefined && requestedRank !== 5 && requestedRank !== 6) {
            return res.status(400).json({
              success: false,
              message: 'Primary agencies can only have Commission Tier Level 5 (FMO), 6 (Enterprise/Carrier), or None'
            });
          }
          if (requestedRank === undefined) {
            commissionTierLevel = 6; // legacy default when not supplied at all
          } else {
            commissionTierLevel = requestedRank; // pass through 5, 6, or null
          }
        } else if (requestedRank !== undefined) {
          commissionTierLevel = requestedRank;
        }

        if (commissionTierLevel !== null && commissionTierLevel !== undefined && !resolvedCommissionLevel) {
          try {
            await assertCommissionTierNumericValid(pool, req.user.TenantId, levelPolicy, commissionTierLevel);
          } catch (e) {
            return res.status(e.statusCode || 400).json({ success: false, message: e.message });
          }
        }

        request.input('CommissionTierLevel', TIER_SQL, commissionTierLevel === null ? null : commissionTierLevel);
        updates.push('CommissionTierLevel = @CommissionTierLevel');
      }
    }

    if (commissionLevelId !== undefined) {
      if (!levelPolicy.commissionLevelsHybridEnabled && commissionLevelId) {
        return res.status(400).json({
          success: false,
          message: 'Custom commission levels are currently disabled for this tenant.'
        });
      }
      request.input('CommissionLevelId', sql.UniqueIdentifier, resolvedCommissionLevel ? resolvedCommissionLevel.CommissionLevelId : null);
      updates.push('CommissionLevelId = @CommissionLevelId');
    }
    
    const updateResult = await request.query(`
      UPDATE oe.Agencies 
      SET ${updates.join(', ')}
      WHERE AgencyId = @AgencyId AND TenantId = @TenantId
    `);

    if (!updateResult.rowsAffected || updateResult.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agency not found or does not belong to this tenant'
      });
    }

    if (agencyAdminAgentIds !== undefined || ownerAgentId !== undefined) {
      const nextAdmins = Array.isArray(agencyAdminAgentIds)
        ? agencyAdminAgentIds
        : (ownerAgentId !== undefined ? (ownerAgentId ? [ownerAgentId] : []) : undefined);
      if (nextAdmins !== undefined) {
        try {
          await agencyAdmins.replaceAgencyAdmins(pool, id, nextAdmins, tenantId);
          await agencyAdmins.ensureAgencyOwnerRolesForAgency(pool, id, req.user.UserId || null);
        } catch (admErr) {
          if (admErr.statusCode === 400) {
            return res.status(400).json({ success: false, message: admErr.message });
          }
          throw admErr;
        }
      }
    }
    
    // Save or update ACH information in ACHAccounts table.
    // Any ACH field present in the payload triggers a save. Missing fields are
    // backfilled from the existing ACHAccounts row so partial updates work
    // (e.g. the agency admin only changes the routing number).
    const achFieldProvided =
      bankName !== undefined ||
      accountHolderName !== undefined ||
      accountType !== undefined ||
      achRoutingNumber !== undefined ||
      achAccountNumber !== undefined;

    let achWarning = null;
    if (achFieldProvided) {
      const achService = require('../services/ACHService');
      let existingAch = null;
      try {
        existingAch = await achService.getACHAccount('Agency', id, true);
      } catch (lookupErr) {
        console.error('❌ Error loading existing ACH account for merge:', lookupErr);
      }

      const mergedAccountHolderName = accountHolderName ?? existingAch?.AccountHolderName ?? null;
      const mergedBankName = bankName !== undefined ? (bankName || null) : (existingAch?.BankName ?? null);
      const mergedAccountType = accountType ?? existingAch?.AccountType ?? 'Checking';
      const mergedRoutingNumber = achRoutingNumber ?? existingAch?.RoutingNumber ?? null;
      const mergedAccountNumber = achAccountNumber ?? existingAch?.AccountNumber ?? null;

      console.log('🔍 ACH Data Check (Update):', {
        provided: {
          accountHolderName: accountHolderName !== undefined,
          accountType: accountType !== undefined,
          achRoutingNumber: achRoutingNumber !== undefined,
          achAccountNumber: achAccountNumber !== undefined,
          bankName: bankName !== undefined
        },
        hasExisting: !!existingAch,
        merged: {
          accountHolderName: !!mergedAccountHolderName,
          accountType: mergedAccountType,
          routingNumber: mergedRoutingNumber ? '***' : null,
          accountNumber: mergedAccountNumber ? '***' : null,
          bankName: mergedBankName
        }
      });

      if (mergedAccountHolderName && mergedRoutingNumber && mergedAccountNumber && mergedAccountType) {
        try {
          console.log('💾 Saving ACH account for agency (update):', id);
          const achResult = await achService.saveACHAccount('Agency', id, {
            accountHolderName: mergedAccountHolderName,
            bankName: mergedBankName,
            routingNumber: mergedRoutingNumber,
            accountNumber: mergedAccountNumber,
            accountType: mergedAccountType,
            isDefault: true,
            status: 'Active'
          }, req.user.UserId);
          console.log('✅ ACH account saved successfully (update):', achResult);
        } catch (achError) {
          console.error('❌ Error saving ACH account for agency (update):', achError);
          console.error('❌ Error stack:', achError.stack);
          achWarning = `ACH account could not be saved: ${achError.message}`;
        }
      } else {
        const missing = [];
        if (!mergedAccountHolderName) missing.push('Account Holder Name');
        if (!mergedRoutingNumber) missing.push('ACH Routing Number');
        if (!mergedAccountNumber) missing.push('ACH Account Number');
        if (!mergedAccountType) missing.push('Account Type');
        achWarning = `ACH information is incomplete. Missing: ${missing.join(', ')}.`;
        console.log('⚠️ ACH data incomplete, skipping ACH account save (update):', missing);
      }
    }
    
    logger.info('Agency updated successfully', {
      agencyId: id,
      agencyName,
      agencyType,
      distributionChannel,
      tenantId: req.user.TenantId,
      modifiedBy: req.user.UserId
    }, 'TenantAdmin');
    
    res.status(200).json({
      success: true,
      data: {
        agencyId: id,
        agencyName,
        achWarning: achWarning || undefined
      },
      message: achWarning
        ? `Agency updated, but ${achWarning}`
        : 'Agency updated successfully',
      warning: achWarning || undefined
    });
    
  } catch (error) {
    logger.error('Error updating agency', { 
      error: error.message, 
      stack: error.stack,
      body: req.body,
      agencyId: req.params.id,
      tenantId: req.user.TenantId 
    }, 'TenantAdmin');
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update agency',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route PUT /api/tenant-admin/agencies/:id/set-primary
 * @desc Set agency as primary (unsetting others for the tenant)
 * @access TenantAdmin, SysAdmin
 */
router.put('/agencies/:id/set-primary', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { isPrimary } = req.body;
    
    const pool = await getPool();
    
    // Check if IsPrimary column exists
    const columnCheckRequest = pool.request();
    const columnCheckResult = await columnCheckRequest.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'Agencies' 
      AND COLUMN_NAME = 'IsPrimary' 
      AND TABLE_SCHEMA = 'oe'
    `);
    const isPrimaryColumnExists = columnCheckResult.recordset[0].count > 0;
    
    if (!isPrimaryColumnExists) {
      return res.status(400).json({
        success: false,
        message: 'Primary agency feature is not available. Please run the database migration first.'
      });
    }
    
    if (!isPrimary) {
      return res.status(400).json({
        success: false,
        message: 'Use set-primary with isPrimary true to transfer primary agency.'
      });
    }

    const verifyResult = await pool.request()
      .input('AgencyId', sql.UniqueIdentifier, id)
      .input('TenantId', sql.UniqueIdentifier, req.user.TenantId)
      .query(`
        SELECT AgencyId, Status FROM oe.Agencies
        WHERE AgencyId = @AgencyId AND TenantId = @TenantId
      `);

    if (verifyResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agency not found or unauthorized'
      });
    }

    if (verifyResult.recordset[0].Status !== 'Active') {
      return res.status(400).json({
        success: false,
        message: 'Only active agencies can be set as primary.'
      });
    }

    const transaction = pool.transaction();

    try {
      await transaction.begin();
      await transferTenantPrimaryAgency(pool, req.user.TenantId, id, req.user.UserId, transaction);
      await transaction.commit();
      
      logger.info('Primary agency set', {
        agencyId: id,
        tenantId: req.user.TenantId,
        modifiedBy: req.user.UserId
      }, 'TenantAdmin');
      
      res.json({
        success: true,
        message: 'Agency set as primary'
      });
      
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    
  } catch (error) {
    logger.error('Error setting primary agency', { 
      error: error.message, 
      agencyId: req.params.id,
      tenantId: req.user.TenantId 
    }, 'TenantAdmin');
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to set primary agency',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route PUT /api/tenant-admin/agents/:id
 * @desc Update agent - UPDATED with all fields. Agent (upline) may only update commissionTierLevel to a level below their own.
 * @access TenantAdmin, SysAdmin, Agent (upline: tier level only)
 */
router.put('/agents/:id', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { id } = req.params; // This is AgentId
    const {
      firstName,
      lastName,
      email,
      phone,
      npn,
      commissionRole,
      groupId,
      agencyId,
      status,
      ssnOrTaxId,
      businessName,
      idType,
      address,
      city,
      state,
      zipCode,
      advanceMonths,
      commissionTierLevel,
      commissionLevelId,
      commissionGroupId
    } = req.body;
    
    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    const levelPolicy = await getCommissionLevelWritePolicy(req.user.TenantId);

    // Upline agent: only allow updating commissionTierLevel, and only to a level below their own
    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      const currentAgentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!currentAgentId) {
        return res.status(403).json({ success: false, message: 'Agent profile not found.' });
      }
      // Resolve id to target AgentId (id may be AgentId or UserId)
      const resolveRequest = pool.request();
      resolveRequest.input('Id', sql.UniqueIdentifier, id);
      if (!getUserRoles(req.user).includes('SysAdmin')) {
        resolveRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      }
      const resolveWhere = !getUserRoles(req.user).includes('SysAdmin')
        ? 'AND TenantId = @TenantId'
        : '';
      const resolveResult = await resolveRequest.query(`
        SELECT AgentId FROM oe.Agents WHERE (AgentId = @Id OR UserId = @Id) ${resolveWhere}
      `);
      if (resolveResult.recordset.length === 0) {
        return res.status(404).json({ success: false, message: 'Agent not found.' });
      }
      const targetAgentId = resolveResult.recordset[0].AgentId;
      // Prevent agent from changing their own commission level
      if (String(targetAgentId).toLowerCase() === String(currentAgentId).toLowerCase()) {
        return res.status(403).json({ success: false, message: 'You cannot change your own commission tier level.' });
      }
      if (!(await isUplineAncestor(pool, targetAgentId, currentAgentId))) {
        return res.status(403).json({ success: false, message: 'You can only update agents in your downline.' });
      }
      // Only commission tier/level assignment is allowed; must be below upline's level
      const requestedCustomLevel = commissionLevelId
        ? await validateCommissionLevelRequest(req.user.TenantId, commissionLevelId)
        : null;
      const requestedRank = requestedCustomLevel ? Number(requestedCustomLevel.SortOrder) : commissionTierLevel;
      if (requestedRank === undefined || requestedRank === null) {
        return res.status(400).json({ success: false, message: 'Only commission level updates are allowed by upline.' });
      }
      const uplineTierRequest = pool.request();
      uplineTierRequest.input('AgentId', sql.UniqueIdentifier, currentAgentId);
      const uplineTierResult = await uplineTierRequest.query(`
        SELECT COALESCE(cl.SortOrder, a.CommissionTierLevel, 0) as CommissionTierLevel
        FROM oe.Agents a
        LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
        WHERE a.AgentId = @AgentId
      `);
      const uplineTier = Number(uplineTierResult.recordset[0]?.CommissionTierLevel ?? 0);
      const newLevel = Number(requestedRank);
      if (!Number.isFinite(newLevel) || newLevel >= uplineTier) {
        return res.status(400).json({
          success: false,
          message: `Commission tier level must be below your level (${uplineTier}). Choose a lower tier.`
        });
      }
      const updateRequest = pool.request();
      updateRequest.input('AgentId', sql.UniqueIdentifier, targetAgentId);
      updateRequest.input('CommissionTierLevel', TIER_SQL, newLevel);
      updateRequest.input('CommissionLevelId', sql.UniqueIdentifier, requestedCustomLevel ? requestedCustomLevel.CommissionLevelId : null);
      updateRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
      await updateRequest.query(`
        UPDATE oe.Agents
        SET CommissionTierLevel = @CommissionTierLevel,
            CommissionLevelId = @CommissionLevelId,
            ModifiedDate = GETUTCDATE(),
            ModifiedBy = @ModifiedBy
        WHERE AgentId = @AgentId
      `);
      return res.json({ success: true, message: 'Commission tier level updated.', data: { commissionTierLevel: newLevel } });
    }

    const transaction = pool.transaction();
    let cascadedDownlineCount = 0;
    
    try {
      await transaction.begin();
      
      // First get the UserId for this agent
      const lookupRequest = transaction.request();
      lookupRequest.input('AgentId', sql.UniqueIdentifier, id);
      
      const agentResult = await lookupRequest.query(`
        SELECT UserId FROM oe.Agents WHERE AgentId = @AgentId
      `);
      
      if (agentResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Agent not found'
        });
      }
      
      const userId = agentResult.recordset[0].UserId;
      
      // Update user record
      const userRequest = transaction.request();
      userRequest.input('UserId', sql.UniqueIdentifier, userId);
      userRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
      
      if (!getUserRoles(req.user).includes('SysAdmin')) {
        userRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      }
      
      const userUpdateFields = [];
      if (firstName) {
        userUpdateFields.push('FirstName = @FirstName');
        userRequest.input('FirstName', sql.NVarChar, firstName);
      }
      if (lastName) {
        userUpdateFields.push('LastName = @LastName');
        userRequest.input('LastName', sql.NVarChar, lastName);
      }
      if (email) {
        userUpdateFields.push('Email = @Email');
        userRequest.input('Email', sql.NVarChar, email);
      }
      if (status) {
        userUpdateFields.push('Status = @Status');
        userRequest.input('Status', sql.NVarChar, status);
      }
      if (groupId) {
        userUpdateFields.push('GroupId = @GroupId');
        userRequest.input('GroupId', sql.UniqueIdentifier, groupId);
      }
      
      if (userUpdateFields.length > 0) {
        let whereClause = 'WHERE UserId = @UserId';
        if (!getUserRoles(req.user).includes('SysAdmin')) {
          whereClause += ' AND TenantId = @TenantId';
        }
        
        await userRequest.query(`
          UPDATE oe.Users 
          SET ${userUpdateFields.join(', ')}, ModifiedDate = GETUTCDATE(), ModifiedBy = @ModifiedBy
          ${whereClause}
        `);
      }
      
      // Update agent record with all fields
      const agentRequest = transaction.request();
      agentRequest.input('AgentId', sql.UniqueIdentifier, id);
      agentRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
      
      if (!getUserRoles(req.user).includes('SysAdmin')) {
        agentRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      }
      
      const agentUpdateFields = [];
      
      if (phone !== undefined) {
        agentUpdateFields.push('Phone = @Phone');
        agentRequest.input('Phone', sql.NVarChar, phone || null);
      }
      if (npn !== undefined) {
        agentUpdateFields.push('NPN = @NPN');
        agentRequest.input('NPN', sql.NVarChar, npn || null);
      }
      if (commissionRole !== undefined) {
        agentUpdateFields.push('CommissionRole = @CommissionRole');
        agentRequest.input('CommissionRole', sql.NVarChar, commissionRole || null);
      }
      let oldAgencyId = null;
      let newAgencyId = null;
      
      if (agencyId !== undefined) {
        // Get current agency before update
        const currentAgencyRequest = transaction.request();
        currentAgencyRequest.input('AgentId', sql.UniqueIdentifier, id);
        const currentAgencyResult = await currentAgencyRequest.query(`
          SELECT AgencyId FROM oe.Agents WHERE AgentId = @AgentId
        `);
        oldAgencyId = currentAgencyResult.recordset[0]?.AgencyId || null;
        newAgencyId = agencyId || null;
        
        agentUpdateFields.push('AgencyId = @AgencyId');
        agentRequest.input('AgencyId', sql.UniqueIdentifier, agencyId || null);
      }
      if (commissionGroupId !== undefined) {
        // Validate group belongs to tenant (or allow NULL to clear)
        if (commissionGroupId) {
          const groupCheck = await transaction.request()
            .input('CommissionGroupId', sql.UniqueIdentifier, commissionGroupId)
            .input('TenantId', sql.UniqueIdentifier, req.user.TenantId)
            .query(`
              SELECT 1 FROM oe.CommissionGroups
              WHERE CommissionGroupId = @CommissionGroupId AND TenantId = @TenantId
            `);
          if (groupCheck.recordset.length === 0) {
            await transaction.rollback();
            return res.status(400).json({ success: false, message: 'Commission group not found or does not belong to your tenant' });
          }
        }
        agentUpdateFields.push('CommissionGroupId = @CommissionGroupId');
        agentRequest.input('CommissionGroupId', sql.UniqueIdentifier, commissionGroupId || null);
      }
      if (status) {
        agentUpdateFields.push('Status = @Status');
        agentRequest.input('Status', sql.NVarChar, status);
      }
      if (ssnOrTaxId !== undefined) {
        agentUpdateFields.push('SSNOrTaxID = @SSNOrTaxID');
        agentRequest.input('SSNOrTaxID', sql.NVarChar, ssnOrTaxId || null);
      }
      if (businessName !== undefined) {
        agentUpdateFields.push('BusinessName = @BusinessName');
        agentRequest.input('BusinessName', sql.NVarChar, businessName || null);
      }
      if (idType !== undefined) {
        agentUpdateFields.push('IDType = @IDType');
        agentRequest.input('IDType', sql.NVarChar, idType || null);
      }
      if (address !== undefined) {
        agentUpdateFields.push('Address1 = @Address1');
        agentRequest.input('Address1', sql.NVarChar, address || null);
      }
      if (city !== undefined) {
        agentUpdateFields.push('City = @City');
        agentRequest.input('City', sql.NVarChar, city || null);
      }
      if (state !== undefined) {
        agentUpdateFields.push('State = @State');
        agentRequest.input('State', sql.Char, state || null);
      }
      if (zipCode !== undefined) {
        agentUpdateFields.push('ZipCode = @ZipCode');
        agentRequest.input('ZipCode', sql.NVarChar, zipCode || null);
      }
      if (advanceMonths !== undefined) {
        agentUpdateFields.push('AdvanceMonths = @AdvanceMonths');
        agentRequest.input('AdvanceMonths', sql.Int, advanceMonths === null ? null : advanceMonths);
      }
      let resolvedCommissionLevel = null;
      if (commissionLevelId) {
        resolvedCommissionLevel = await validateCommissionLevelRequest(req.user.TenantId, commissionLevelId);
      } else if (levelPolicy.useCustomCommissionLevelsOnly && commissionTierLevel === undefined) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'CommissionLevelId is required for this tenant.'
        });
      }
      if (commissionTierLevel !== undefined || resolvedCommissionLevel) {
        const effectiveTierLevel = resolvedCommissionLevel ? Number(resolvedCommissionLevel.SortOrder) : commissionTierLevel;
        if (!resolvedCommissionLevel) {
          try {
            await assertCommissionTierNumericValid(pool, req.user.TenantId, levelPolicy, effectiveTierLevel);
          } catch (e) {
            await transaction.rollback();
            return res.status(e.statusCode || 400).json({ success: false, message: e.message });
          }
        }
        agentUpdateFields.push('CommissionTierLevel = @CommissionTierLevel');
        agentRequest.input('CommissionTierLevel', TIER_SQL, effectiveTierLevel === null ? null : effectiveTierLevel);
      }
      if (commissionLevelId !== undefined) {
        if (!levelPolicy.commissionLevelsHybridEnabled && commissionLevelId) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: 'Custom commission levels are currently disabled for this tenant.'
          });
        }
        agentUpdateFields.push('CommissionLevelId = @CommissionLevelId');
        agentRequest.input('CommissionLevelId', sql.UniqueIdentifier, resolvedCommissionLevel ? resolvedCommissionLevel.CommissionLevelId : null);
      }
      if (firstName !== undefined) {
        agentUpdateFields.push('FirstName = @FirstName');
        agentRequest.input('FirstName', sql.NVarChar, firstName || null);
      }
      if (lastName !== undefined) {
        agentUpdateFields.push('LastName = @LastName');
        agentRequest.input('LastName', sql.NVarChar, lastName || null);
      }
      if (email !== undefined) {
        agentUpdateFields.push('Email = @Email');
        agentRequest.input('Email', sql.NVarChar, email || null);
      }
      
      if (agentUpdateFields.length > 0) {
        let whereClause = 'WHERE AgentId = @AgentId';
        if (!getUserRoles(req.user).includes('SysAdmin')) {
          whereClause += ' AND TenantId = @TenantId';
        }
        
        await agentRequest.query(`
          UPDATE oe.Agents 
          SET ${agentUpdateFields.join(', ')}, ModifiedDate = GETUTCDATE(), ModifiedBy = @ModifiedBy
          ${whereClause}
        `);
      }
      
      // If agency changed, update hierarchy to set agent at top level (ParentId = new AgencyId)
      // and cascade the AgencyId change to ALL downlines (recursively) so the entire
      // sub-tree moves with this agent. Downline parent/child relationships are preserved;
      // only their AgencyId is rewritten.
      if (agencyId !== undefined && oldAgencyId !== newAgencyId && newAgencyId) {
        // Remove existing hierarchy relationships for the agent being moved
        const removeHierarchyRequest = transaction.request();
        removeHierarchyRequest.input('AgentId', sql.UniqueIdentifier, id);
        await removeHierarchyRequest.query(`
          DELETE FROM oe.AgentHierarchy 
          WHERE AgentId = @AgentId
        `);
        
        // Create new hierarchy relationship with Agency as parent (top level of new agency)
        const hierarchyId = uuidv4();
        const hierarchyRequest = transaction.request();
        hierarchyRequest.input('HierarchyId', sql.UniqueIdentifier, hierarchyId);
        hierarchyRequest.input('Type', sql.NVarChar, 'Agent');
        hierarchyRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
        hierarchyRequest.input('AgencyId', sql.UniqueIdentifier, newAgencyId);
        hierarchyRequest.input('AgentId', sql.UniqueIdentifier, id);
        hierarchyRequest.input('ParentId', sql.UniqueIdentifier, newAgencyId); // Parent is the Agency (top level)
        hierarchyRequest.input('Status', sql.NVarChar, 'Active');
        
        await hierarchyRequest.query(`
          INSERT INTO oe.AgentHierarchy (
            HierarchyId, Type, TenantId, AgencyId, AgentId, ParentId, Status,
            CreatedDate, ModifiedDate
          ) VALUES (
            @HierarchyId, @Type, @TenantId, @AgencyId, @AgentId, @ParentId, @Status,
            GETUTCDATE(), GETUTCDATE()
          )
        `);

        // Cascade the new AgencyId to every downline agent (recursive sub-tree).
        // SQL Server requires us to materialize the descendant set first because
        // the target table can't appear in a recursive CTE used by UPDATE.
        const descendantsRequest = transaction.request();
        descendantsRequest.input('RootAgentId', sql.UniqueIdentifier, id);
        const descendantsResult = await descendantsRequest.query(`
          WITH Descendants AS (
            SELECT ah.AgentId, 1 AS Depth
            FROM oe.AgentHierarchy ah
            WHERE ah.ParentId = @RootAgentId
              AND ah.Status = 'Active'

            UNION ALL

            SELECT ah.AgentId, d.Depth + 1
            FROM oe.AgentHierarchy ah
            INNER JOIN Descendants d ON ah.ParentId = d.AgentId
            WHERE ah.Status = 'Active'
              AND d.Depth < 25
          )
          SELECT DISTINCT AgentId FROM Descendants
          OPTION (MAXRECURSION 25)
        `);

        const descendantIds = descendantsResult.recordset
          .map(r => r.AgentId)
          .filter(Boolean);
        cascadedDownlineCount = descendantIds.length;

        // Re-point agent-owned link records (onboarding, enrollment, templates)
        // for the moved agent AND every descendant. These tables stamp the
        // listed AgencyId onto downstream activity (recruiting, enrollments,
        // commission attribution), so leaving them on the old agency would
        // mis-route future credit.
        // We use AgentId IN (root + descendants) — historical link metadata
        // (LinkToken, UsageCount, etc.) stays intact, only AgencyId changes.
        const movedAgentIds = [id, ...descendantIds];

        if (descendantIds.length > 0) {
          // Build a parameterized IN clause for the descendant ids
          const cascadeRequest = transaction.request();
          cascadeRequest.input('NewAgencyId', sql.UniqueIdentifier, newAgencyId);
          cascadeRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
          cascadeRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);

          const placeholders = descendantIds.map((_, idx) => `@DescId${idx}`).join(', ');
          descendantIds.forEach((descId, idx) => {
            cascadeRequest.input(`DescId${idx}`, sql.UniqueIdentifier, descId);
          });

          // Move each downline agent into the new agency
          await cascadeRequest.query(`
            UPDATE oe.Agents
            SET AgencyId = @NewAgencyId,
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @ModifiedBy
            WHERE AgentId IN (${placeholders})
              AND TenantId = @TenantId
          `);

          // Rewrite their hierarchy rows' AgencyId so they no longer reference
          // the old agency. Parent/child links are preserved.
          await cascadeRequest.query(`
            UPDATE oe.AgentHierarchy
            SET AgencyId = @NewAgencyId,
                ModifiedDate = GETUTCDATE()
            WHERE AgentId IN (${placeholders})
              AND TenantId = @TenantId
          `);
        }

        // Re-point oe.AgentOnboardingLinks for moved agent + every descendant.
        //
        // NOTE: oe.EnrollmentLinks and oe.EnrollmentLinkTemplates intentionally
        // hold a XOR check constraint (CK_EnrollmentLinks_AgentOrAgency /
        // CK_EnrollmentLinkTemplates_AgentOrAgency): a row is owned by EITHER
        // an agent OR an agency, never both. Agent-owned rows leave AgencyId
        // NULL on purpose - the agency is derived at query time via
        // EnrollmentLinks.AgentId -> oe.Agents.AgencyId. Updating those rows'
        // AgencyId would violate the constraint. They auto-follow the agent.
        //
        // oe.AgentOnboardingLinks has no such constraint - it tracks both.
        if (movedAgentIds.length > 0) {
          const onboardingRequest = transaction.request();
          onboardingRequest.input('NewAgencyId', sql.UniqueIdentifier, newAgencyId);
          onboardingRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
          const onboardingPlaceholders = movedAgentIds.map((_, idx) => `@LinkAgentId${idx}`).join(', ');
          movedAgentIds.forEach((aid, idx) => {
            onboardingRequest.input(`LinkAgentId${idx}`, sql.UniqueIdentifier, aid);
          });
          await onboardingRequest.query(`
            UPDATE oe.AgentOnboardingLinks
            SET AgencyId = @NewAgencyId,
                ModifiedDate = GETUTCDATE()
            WHERE AgentId IN (${onboardingPlaceholders})
              AND TenantId = @TenantId
          `);
        }

        logger.info('Agent agency change cascaded to downlines and onboarding links', {
          agentId: id,
          oldAgencyId,
          newAgencyId,
          downlineCount: descendantIds.length,
          movedAgentCount: movedAgentIds.length,
          tenantId: req.user.TenantId,
          modifiedBy: req.user.UserId
        }, 'TenantAdmin');
      }
      
      await transaction.commit();
      
      logger.info('Agent updated successfully', {
        agentId: id,
        tenantId: req.user.TenantId,
        modifiedBy: req.user.UserId,
        cascadedDownlineCount
      }, 'TenantAdmin');
      
      res.json({
        success: true,
        message: cascadedDownlineCount > 0
          ? `Agent updated successfully. ${cascadedDownlineCount} downline ${cascadedDownlineCount === 1 ? 'agent was' : 'agents were'} moved to the new agency.`
          : 'Agent updated successfully',
        data: {
          cascadedDownlineCount
        }
      });
      
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    
  } catch (error) {
    console.error('❌ Error updating agent:', error);
    logger.error('Error updating agent', {
      error: error.message,
      stack: error.stack,
      agentId: req.params.id,
      tenantId: req.user?.TenantId
    }, 'TenantAdmin');
    const isDev = process.env.NODE_ENV === 'development';
    res.status(500).json({
      success: false,
      // In dev, prepend the underlying error so it surfaces in the UI/console.
      message: isDev ? `Failed to update agent: ${error.message}` : 'Failed to update agent',
      error: isDev ? error.message : 'Internal server error'
    });
  }
});

/**
 * @route POST /api/tenant-admin/agents/:id/licenses
 * @desc Add license for agent
 * @access TenantAdmin, SysAdmin
 */
router.post('/agents/:id/licenses', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id: agentId } = req.params; // This is AgentId
    const {
      stateCode,
      licenseNumber,
      licenseType,
      expirationDate,
      issueDate,
      documentUrl
    } = req.body;
    
    // Validation
    if (!stateCode || !licenseNumber) {
      return res.status(400).json({
        success: false,
        message: 'State code and license number are required'
      });
    }
    
    const pool = await getPool();
    const request = pool.request();
    
    // Verify agent exists and tenant access
    request.input('AgentId', sql.UniqueIdentifier, agentId);
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    }
    
    let whereClause = 'AgentId = @AgentId';
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      whereClause += ' AND TenantId = @TenantId';
    }
    
    const agentCheck = await request.query(`
      SELECT AgentId FROM oe.Agents WHERE ${whereClause}
    `);
    
    if (agentCheck.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }
    
    // Create the license
    const licenseId = uuidv4();
    
    request.input('LicenseId', sql.UniqueIdentifier, licenseId);
    request.input('StateCode', sql.NVarChar, stateCode);
    request.input('LicenseNumber', sql.NVarChar, licenseNumber);
    request.input('Status', sql.NVarChar, 'Active');
    request.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
    request.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
    
    if (licenseType) request.input('LicenseType', sql.NVarChar, licenseType);
    if (expirationDate) request.input('ExpirationDate', sql.Date, expirationDate);
    if (issueDate) request.input('IssueDate', sql.Date, issueDate);
    if (documentUrl) request.input('UploadedDocumentUrl', sql.NVarChar, documentUrl);
    
    await request.query(`
      INSERT INTO oe.AgentLicenses (
        LicenseId, AgentId, StateCode, LicenseNumber, LicenseType, 
        ExpirationDate, IssueDate, UploadedDocumentUrl, Status, 
        CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
      ) VALUES (
        @LicenseId, @AgentId, @StateCode, @LicenseNumber, @LicenseType,
        @ExpirationDate, @IssueDate, @UploadedDocumentUrl, @Status,
        GETUTCDATE(), GETUTCDATE(), @CreatedBy, @ModifiedBy
      )
    `);
    
    logger.info('Agent license added', {
      licenseId,
      agentId,
      stateCode,
      createdBy: req.user.UserId
    }, 'TenantAdmin');
    
    res.status(201).json({
      success: true,
      data: { licenseId },
      message: 'License added successfully'
    });
    
  } catch (error) {
    logger.error('Error adding agent license', { 
      error: error.message, 
      agentId: req.params.id,
      body: req.body
    }, 'TenantAdmin');
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to add license'
    });
  }
});

/**
 * @route DELETE /api/tenant-admin/agents/:id/licenses/:licenseId
 * @desc Remove agent license
 * @access TenantAdmin, SysAdmin
 */
router.delete('/agents/:id/licenses/:licenseId', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id: agentId, licenseId } = req.params;
    
    const pool = await getPool();
    const request = pool.request();
    
    request.input('LicenseId', sql.UniqueIdentifier, licenseId);
    request.input('AgentId', sql.UniqueIdentifier, agentId);
    
    const result = await request.query(`
      DELETE FROM oe.AgentLicenses 
      WHERE LicenseId = @LicenseId AND AgentId = @AgentId
    `);
    
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'License not found'
      });
    }
    
    logger.info('Agent license removed', {
      licenseId,
      agentId,
      removedBy: req.user.UserId
    }, 'TenantAdmin');
    
    res.json({
      success: true,
      message: 'License removed successfully'
    });
    
  } catch (error) {
    logger.error('Error removing agent license', { error: error.message, licenseId: req.params.licenseId }, 'TenantAdmin');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to remove license' 
    });
  }
});

/**
 * @route POST /api/tenant-admin/agents/:id/bank-info
 * @desc Save bank information for agent - FIXED UserId→AgentId resolution
 * @access TenantAdmin, SysAdmin
 */
router.post('/agents/:id/bank-info', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params; // This could be either AgentId or UserId
    const {
      bankName,
      accountName,
      accountType,
      routingNumber,
      accountNumber
    } = req.body;
    
    // Validation
    if (!bankName || !accountName || !accountType || !routingNumber || !accountNumber) {
      return res.status(400).json({
        success: false,
        message: 'All bank information fields are required'
      });
    }
    
    // Validate routing number (9 digits)
    if (!/^\d{9}$/.test(routingNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Routing number must be exactly 9 digits'
      });
    }
    
    // Validate account type
    if (!['Checking', 'Savings'].includes(accountType)) {
      return res.status(400).json({
        success: false,
        message: 'Account type must be either Checking or Savings'
      });
    }
    
    const pool = await getPool();
    
    // STEP 1: Resolve UserId to AgentId (same logic as licenses)
    const agentIdRequest = pool.request();
    agentIdRequest.input('AgentId', sql.UniqueIdentifier, id);
    
    const agentByIdResult = await agentIdRequest.query(`
      SELECT AgentId, UserId, TenantId, Status FROM oe.Agents WHERE AgentId = @AgentId
    `);
    
    let agentRecord = null;
    let actualAgentId = null;
    
    if (agentByIdResult.recordset.length > 0) {
      // ID was AgentId
      agentRecord = agentByIdResult.recordset[0];
      actualAgentId = agentRecord.AgentId;
    } else {
      // Try as UserId
      const userIdRequest = pool.request();
      userIdRequest.input('UserId', sql.UniqueIdentifier, id);
      
      const agentByUserIdResult = await userIdRequest.query(`
        SELECT AgentId, UserId, TenantId, Status FROM oe.Agents WHERE UserId = @UserId
      `);
      
      if (agentByUserIdResult.recordset.length > 0) {
        agentRecord = agentByUserIdResult.recordset[0];
        actualAgentId = agentRecord.AgentId;
      }
    }
    
    if (!agentRecord || !actualAgentId) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }
    
    // STEP 2: Apply tenant isolation check
    if (!getUserRoles(req.user).includes('SysAdmin') && agentRecord.TenantId !== req.user.TenantId) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }
    
    const transaction = pool.transaction();
    
    try {
      await transaction.begin();
      
      // Check if bank info already exists
      const existingBankRequest = transaction.request();
      existingBankRequest.input('AgentId', sql.UniqueIdentifier, actualAgentId);
      
      const existingBankResult = await existingBankRequest.query(`
        SELECT BankInfoId FROM oe.AgentBankInfo 
        WHERE AgentId = @AgentId AND Status = 'Active'
      `);
      
      // For security, encrypt the account number and store only last 4 digits.
      // Use AES-256-GCM via encryptionService so all bank-info paths produce
      // the same on-disk format (was previously naive base64 — NOT real
      // encryption — which is what caused inconsistent NACHA file output).
      const accountNumberLast4 = accountNumber.slice(-4);
      const encryptedAccountNumber = encryptionService.encrypt(accountNumber);
      
      if (existingBankResult.recordset.length > 0) {
        // Update existing bank info
        const bankInfoId = existingBankResult.recordset[0].BankInfoId;
        
        const updateRequest = transaction.request();
        updateRequest.input('BankInfoId', sql.UniqueIdentifier, bankInfoId);
        updateRequest.input('BankName', sql.NVarChar, bankName);
        updateRequest.input('AccountName', sql.NVarChar, accountName);
        updateRequest.input('AccountType', sql.NVarChar, accountType);
        updateRequest.input('RoutingNumber', sql.NVarChar, routingNumber);
        updateRequest.input('AccountNumberEncrypted', sql.NVarChar, encryptedAccountNumber);
        updateRequest.input('AccountNumberLast4', sql.NVarChar, accountNumberLast4);
        updateRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
        
        await updateRequest.query(`
          UPDATE oe.AgentBankInfo 
          SET BankName = @BankName,
              AccountName = @AccountName,
              AccountType = @AccountType,
              RoutingNumber = @RoutingNumber,
              AccountNumberEncrypted = @AccountNumberEncrypted,
              AccountNumberLast4 = @AccountNumberLast4,
              ModifiedDate = GETUTCDATE(),
              ModifiedBy = @ModifiedBy,
              VerificationStatus = 'Pending'
          WHERE BankInfoId = @BankInfoId
        `);
        
      } else {
        // Create new bank info
        const bankInfoId = uuidv4();
        
        const insertRequest = transaction.request();
        insertRequest.input('BankInfoId', sql.UniqueIdentifier, bankInfoId);
        insertRequest.input('AgentId', sql.UniqueIdentifier, actualAgentId);
        insertRequest.input('BankName', sql.NVarChar, bankName);
        insertRequest.input('AccountName', sql.NVarChar, accountName);
        insertRequest.input('AccountHolderType', sql.NVarChar, 'Individual'); // Individual or Business
        insertRequest.input('AccountType', sql.NVarChar, accountType);
        insertRequest.input('RoutingNumber', sql.NVarChar, routingNumber);
        insertRequest.input('AccountNumberEncrypted', sql.NVarChar, encryptedAccountNumber);
        insertRequest.input('AccountNumberLast4', sql.NVarChar, accountNumberLast4);
        insertRequest.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
        insertRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
        
        await insertRequest.query(`
          INSERT INTO oe.AgentBankInfo (
            BankInfoId, AgentId, BankName, AccountName, AccountHolderType, AccountType, 
            RoutingNumber, AccountNumberEncrypted, AccountNumberLast4, 
            Status, IsDefault, VerificationStatus, 
            CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
          ) VALUES (
            @BankInfoId, @AgentId, @BankName, @AccountName, @AccountHolderType, @AccountType,
            @RoutingNumber, @AccountNumberEncrypted, @AccountNumberLast4,
            'Active', 1, 'Pending',
            GETUTCDATE(), GETUTCDATE(), @CreatedBy, @ModifiedBy
          )
        `);
      }
      
      await transaction.commit();
      
      logger.info('Agent bank information saved', {
        agentId: actualAgentId,
        bankName,
        savedBy: req.user.UserId
      }, 'TenantAdmin');
      
      res.json({
        success: true,
        message: 'Bank information saved successfully'
      });
      
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    
  } catch (error) {
    logger.error('Error saving agent bank information', { 
      error: error.message, 
      agentId: req.params.id,
      body: req.body
    }, 'TenantAdmin');
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to save bank information'
    });
  }
});

/**
 * @route GET /api/tenant-admin/agents/by-agency/:agencyId
 * @desc Get agents by agency for parent selection. Supports ?search= and ?limit= for query-based search.
 * @access TenantAdmin, SysAdmin, Agent (agency admin for that agency)
 */
router.get('/agents/by-agency/:agencyId', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { search, limit = 50 } = req.query;
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const pool = await getPool();
    const userRoles = getUserRoles(req.user);

    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      const agentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!agentId) {
        return res.status(403).json({ success: false, message: 'Agent profile not found' });
      }
      const isOwner = await isAgencyOwner(pool, agencyId, agentId);
      if (!isOwner) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to list agents for this agency'
        });
      }
    }
    const request = pool.request();
    request.input('AgencyId', sql.UniqueIdentifier, agencyId);
    request.input('Limit', sql.Int, limitNum);

    if (!getUserRoles(req.user).includes('SysAdmin')) {
      request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    }

    let whereClause = 'WHERE a.AgencyId = @AgencyId AND a.Status IN (\'Active\', \'Pending\')';
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      whereClause += ' AND a.TenantId = @TenantId';
    }
    if (search && String(search).trim()) {
      whereClause += ' AND (u.FirstName LIKE @Search OR u.LastName LIKE @Search OR u.Email LIKE @Search)';
      request.input('Search', sql.NVarChar, `%${String(search).trim()}%`);
    }

    const result = await request.query(`
      SELECT TOP (@Limit)
        a.AgentId,
        a.UserId,
        u.FirstName,
        u.LastName,
        u.Email,
        a.NPN,
        a.CommissionRole,
        a.Status,
        a.CreatedDate
      FROM oe.Agents a
      INNER JOIN oe.Users u ON a.UserId = u.UserId
      ${whereClause}
      ORDER BY u.FirstName, u.LastName
    `);

    res.json({
      success: true,
      data: result.recordset
    });

  } catch (error) {
    console.error('❌ Error fetching agents by agency:', error);
    logger.error('Error fetching agents by agency', {
      error: error.message,
      agencyId: req.params.agencyId,
      stack: error.stack
    }, 'TenantAdmin');
    res.status(500).json({
      success: false,
      message: 'Failed to fetch agents by agency',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @route GET /api/tenant-admin/agents/:id/commission-rule
 * @desc Get agent's commission rule
 * @access TenantAdmin, SysAdmin, Agent (if direct upline of agent - view only)
 */
router.get('/agents/:id/commission-rule', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    console.log('💰 GET /api/tenant-admin/agents/:id/commission-rule - Request received');
    const { id } = req.params;
    const pool = await getPool();
    const userRoles = getUserRoles(req.user);

    // STEP 1: Determine if this is an Agency or Agent ID
    let entityType = 'Agent';
    let entityId = id;
    let actualAgentId = null;
    let actualAgencyId = null;
    
    // Check if it's an Agency ID first
    const agencyCheckRequest = pool.request();
    agencyCheckRequest.input('AgencyId', sql.UniqueIdentifier, id);
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      agencyCheckRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    }
    
    let agencyWhereClause = 'WHERE a.AgencyId = @AgencyId';
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      agencyWhereClause += ' AND a.TenantId = @TenantId';
    }
    
    const agencyCheckResult = await agencyCheckRequest.query(`
      SELECT a.AgencyId 
      FROM oe.Agencies a
      ${agencyWhereClause}
    `);
    
    if (agencyCheckResult.recordset.length > 0) {
      // It's an Agency
      entityType = 'Agency';
      actualAgencyId = id;
      console.log('🔍 Identified as Agency ID:', actualAgencyId);
    } else {
      // Check if it's an Agent ID or UserId
      const agentCheckRequest = pool.request();
      agentCheckRequest.input('Id', sql.UniqueIdentifier, id);
      
      if (!getUserRoles(req.user).includes('SysAdmin')) {
        agentCheckRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      }
      
      let agentWhereClause = 'WHERE (a.AgentId = @Id OR a.UserId = @Id)';
      if (!getUserRoles(req.user).includes('SysAdmin')) {
        agentWhereClause += ' AND a.TenantId = @TenantId';
      }
      
      const agentCheckResult = await agentCheckRequest.query(`
        SELECT a.AgentId 
        FROM oe.Agents a
        ${agentWhereClause}
      `);
      
      if (agentCheckResult.recordset.length > 0) {
        // It's an Agent
        entityType = 'Agent';
        actualAgentId = agentCheckResult.recordset[0].AgentId;
        console.log('🔍 Identified as Agent ID:', actualAgentId);
      } else {
        return res.status(404).json({
          success: false,
          message: 'Agent or Agency not found'
        });
      }
    }

    let viewerTierLevel = null;
    // Agent role: allow viewing commission rule for self (read-only) or for a downline agent (not agencies)
    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      if (entityType === 'Agency') {
        return res.status(403).json({ success: false, message: 'Insufficient permissions' });
      }
      const currentAgentId = await getAgentIdFromUserId(pool, req.user.UserId);
      const isSelf = currentAgentId && String(actualAgentId).toLowerCase() === String(currentAgentId).toLowerCase();
      const isDownline = currentAgentId && (await isUplineAncestor(pool, actualAgentId, currentAgentId));
      if (!currentAgentId || (!isSelf && !isDownline)) {
        return res.status(403).json({ success: false, message: 'Insufficient permissions' });
      }
      const tierReq = pool.request();
      tierReq.input('AgentId', sql.UniqueIdentifier, currentAgentId);
      const tierResult = await tierReq.query(`
        SELECT ISNULL(CommissionTierLevel, 0) AS CommissionTierLevel FROM oe.Agents WHERE AgentId = @AgentId
      `);
      viewerTierLevel = tierResult.recordset[0]?.CommissionTierLevel ?? 0;
    }

    // STEP 2: Get commission rule information based on entity type
    const request = pool.request();
    
    try {
      let result;
      // Check if CommissionRuleId column exists
      const commissionRuleColumnCheckRequest = pool.request();
      const commissionRuleColumnCheckResult = await commissionRuleColumnCheckRequest.query(`
        SELECT COUNT(*) as count 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = '${entityType === 'Agency' ? 'Agencies' : 'Agents'}' 
        AND COLUMN_NAME = 'CommissionRuleId' 
        AND TABLE_SCHEMA = 'oe'
      `);
      const hasCommissionRuleIdColumn = commissionRuleColumnCheckResult.recordset[0].count > 0;
      
      if (entityType === 'Agency') {
        request.input('AgencyId', sql.UniqueIdentifier, actualAgencyId);
        const commissionRuleIdSelect = hasCommissionRuleIdColumn 
          ? 'a.CommissionRuleId,'
          : 'NULL as CommissionRuleId,';
        result = await request.query(`
          SELECT
            a.AgencyId as EntityId,
            'Agency' as EntityType,
            ${commissionRuleIdSelect}
            cr.RuleId,
            cr.RuleName,
            cr.ProductId,
            p.Name as ProductName,
            cr.CommissionType,
            cr.CommissionRate,
            cr.FlatAmount,
            cr.PaymentTiming,
            cr.EffectiveDate,
            cr.TerminationDate,
            cr.Status as RuleStatus
          FROM oe.Agencies a
          ${hasCommissionRuleIdColumn ? 'LEFT JOIN oe.CommissionRules cr ON a.CommissionRuleId = cr.RuleId' : 'LEFT JOIN oe.CommissionRules cr ON 1=0'}
          LEFT JOIN oe.Products p ON cr.ProductId = p.ProductId
          WHERE a.AgencyId = @AgencyId
        `);
      } else {
        request.input('AgentId', sql.UniqueIdentifier, actualAgentId);
        const commissionRuleIdSelect = hasCommissionRuleIdColumn 
          ? 'a.CommissionRuleId,'
          : 'NULL as CommissionRuleId,';
        result = await request.query(`
          SELECT
            a.AgentId as EntityId,
            'Agent' as EntityType,
            ${commissionRuleIdSelect}
            cr.RuleId,
            cr.RuleName,
            cr.ProductId,
            p.Name as ProductName,
            cr.CommissionType,
            cr.CommissionRate,
            cr.FlatAmount,
            cr.PaymentTiming,
            cr.EffectiveDate,
            cr.TerminationDate,
            cr.Status as RuleStatus
          FROM oe.Agents a
          ${hasCommissionRuleIdColumn ? 'LEFT JOIN oe.CommissionRules cr ON a.CommissionRuleId = cr.RuleId' : 'LEFT JOIN oe.CommissionRules cr ON 1=0'}
          LEFT JOIN oe.Products p ON cr.ProductId = p.ProductId
          WHERE a.AgentId = @AgentId
        `);
      }

      console.log('💰 BACKEND - Commission rule query result:', result.recordset[0]);

      const defaultData = entityType === 'Agency' 
        ? {
            EntityId: actualAgencyId,
            EntityType: 'Agency',
            CommissionRuleId: null,
            RuleId: null,
            RuleName: null,
            ProductId: null,
            ProductName: null,
            CommissionType: null,
            CommissionRate: null,
            FlatAmount: null,
            PaymentTiming: null,
            EffectiveDate: null,
            TerminationDate: null,
            RuleStatus: null
          }
        : {
            EntityId: actualAgentId,
            EntityType: 'Agent',
            CommissionRuleId: null,
            RuleId: null,
            RuleName: null,
            ProductId: null,
            ProductName: null,
            CommissionType: null,
            CommissionRate: null,
            FlatAmount: null,
            PaymentTiming: null,
            EffectiveDate: null,
            TerminationDate: null,
            RuleStatus: null
          };

      const responseData = result.recordset[0] || defaultData;
      if (viewerTierLevel !== null) {
        responseData.viewerTierLevel = Number(viewerTierLevel);
      }
      res.json({
        success: true,
        data: responseData
      });
    } catch (commissionError) {
      console.error('❌ Error fetching commission rule:', commissionError);
      logger.error('Error fetching commission rule', {
        error: commissionError.message,
        entityType: entityType,
        entityId: entityType === 'Agency' ? actualAgencyId : actualAgentId,
        sqlError: commissionError.originalError?.info?.message,
        stack: commissionError.stack
      }, 'TenantAdmin');
      res.status(500).json({
        success: false,
        message: 'Failed to fetch commission rule',
        error: process.env.NODE_ENV === 'development' ? commissionError.message : 'Internal server error'
      });
    }

  } catch (error) {
    console.error('❌ Error in commission rule endpoint:', error);
    logger.error('Error in commission rule endpoint', {
      error: error.message,
      agentId: req.params.id,
      stack: error.stack
    }, 'TenantAdmin');
    res.status(500).json({
      success: false,
      message: 'Failed to fetch commission rule',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @route PUT /api/tenant-admin/agents/:id/commission-rule
 * @desc Update agent's commission rule
 * @access TenantAdmin, SysAdmin, Agent (upline may update downline agent's rule only)
 */
router.put('/agents/:id/commission-rule', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    console.log('💰 PUT /api/tenant-admin/agents/:id/commission-rule - Request received');
    const { id } = req.params;
    const { commissionRuleId } = req.body;
    const pool = await getPool();
    const userRoles = getUserRoles(req.user);

    console.log('💰 Commission rule update data:', {
      id: id,
      commissionRuleId
    });

    // STEP 1: Determine if this is an Agency or Agent ID
    let entityType = 'Agent';
    let actualAgentId = null;
    let actualAgencyId = null;
    
    // Check if it's an Agency ID first
    const agencyCheckRequest = pool.request();
    agencyCheckRequest.input('AgencyId', sql.UniqueIdentifier, id);
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      agencyCheckRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    }
    
    let agencyWhereClause = 'WHERE a.AgencyId = @AgencyId';
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      agencyWhereClause += ' AND a.TenantId = @TenantId';
    }
    
    const agencyCheckResult = await agencyCheckRequest.query(`
      SELECT a.AgencyId 
      FROM oe.Agencies a
      ${agencyWhereClause}
    `);
    
    if (agencyCheckResult.recordset.length > 0) {
      // It's an Agency
      entityType = 'Agency';
      actualAgencyId = id;
      console.log('🔍 Identified as Agency ID:', actualAgencyId);
    } else {
      // Check if it's an Agent ID or UserId
      const agentCheckRequest = pool.request();
      agentCheckRequest.input('Id', sql.UniqueIdentifier, id);
      
      if (!getUserRoles(req.user).includes('SysAdmin')) {
        agentCheckRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      }
      
      let agentWhereClause = 'WHERE (a.AgentId = @Id OR a.UserId = @Id)';
      if (!getUserRoles(req.user).includes('SysAdmin')) {
        agentWhereClause += ' AND a.TenantId = @TenantId';
      }
      
      const agentCheckResult = await agentCheckRequest.query(`
        SELECT a.AgentId 
        FROM oe.Agents a
        ${agentWhereClause}
      `);
      
      if (agentCheckResult.recordset.length > 0) {
        // It's an Agent
        entityType = 'Agent';
        actualAgentId = agentCheckResult.recordset[0].AgentId;
        console.log('🔍 Identified as Agent ID:', actualAgentId);
      } else {
        return res.status(404).json({
          success: false,
          message: 'Agent or Agency not found'
        });
      }
    }

    // Agent role: may only update commission rule for agents in their downline (not agencies)
    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      if (entityType === 'Agency') {
        return res.status(403).json({ success: false, message: 'Insufficient permissions' });
      }
      const currentAgentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!currentAgentId) {
        return res.status(403).json({ success: false, message: 'Agent profile not found' });
      }
      const isSelf = String(actualAgentId).toLowerCase() === String(currentAgentId).toLowerCase();
      const isDownline = await isUplineAncestor(pool, actualAgentId, currentAgentId);
      if (!isDownline || isSelf) {
        return res.status(403).json({ success: false, message: 'Insufficient permissions' });
      }
    }
    
    // STEP 2: Check if CommissionRuleId column exists
    const commissionRuleColumnCheckRequest = pool.request();
    const commissionRuleColumnCheckResult = await commissionRuleColumnCheckRequest.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = '${entityType === 'Agency' ? 'Agencies' : 'Agents'}' 
      AND COLUMN_NAME = 'CommissionRuleId' 
      AND TABLE_SCHEMA = 'oe'
    `);
    const hasCommissionRuleIdColumn = commissionRuleColumnCheckResult.recordset[0].count > 0;
    
    if (!hasCommissionRuleIdColumn) {
      return res.status(400).json({
        success: false,
        message: 'Commission rule assignment is not available. The CommissionRuleId column does not exist in the database.'
      });
    }
    
    // STEP 3: Update commission rule based on entity type
    const request = pool.request();
    request.input('CommissionRuleId', sql.UniqueIdentifier, commissionRuleId || null);
    request.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);

    try {
      if (entityType === 'Agency') {
        request.input('AgencyId', sql.UniqueIdentifier, actualAgencyId);
        
        // Check if CommissionRuleModified column exists
        const modifiedColumnCheckRequest = pool.request();
        const modifiedColumnCheckResult = await modifiedColumnCheckRequest.query(`
          SELECT COUNT(*) as count 
          FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_NAME = 'Agencies' 
          AND COLUMN_NAME = 'CommissionRuleModified' 
          AND TABLE_SCHEMA = 'oe'
        `);
        const hasModifiedColumn = modifiedColumnCheckResult.recordset[0].count > 0;
        
        const modifiedColumnUpdate = hasModifiedColumn 
          ? `CommissionRuleModified = CASE 
                WHEN @CommissionRuleId IS NOT NULL THEN GETUTCDATE()
                ELSE NULL
            END,`
          : '';
        
        await request.query(`
          UPDATE oe.Agencies 
          SET CommissionRuleId = @CommissionRuleId,
              ${modifiedColumnUpdate}
              ModifiedDate = GETUTCDATE(),
              ModifiedBy = @ModifiedBy
          WHERE AgencyId = @AgencyId
        `);
        
        logger.info('Agency commission rule updated', {
          agencyId: actualAgencyId,
          commissionRuleId,
          modifiedBy: req.user.UserId
        }, 'TenantAdmin');
      } else {
        request.input('AgentId', sql.UniqueIdentifier, actualAgentId);
        
        // Check if CommissionRuleModified column exists
        const modifiedColumnCheckRequest = pool.request();
        const modifiedColumnCheckResult = await modifiedColumnCheckRequest.query(`
          SELECT COUNT(*) as count 
          FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_NAME = 'Agents' 
          AND COLUMN_NAME = 'CommissionRuleModified' 
          AND TABLE_SCHEMA = 'oe'
        `);
        const hasModifiedColumn = modifiedColumnCheckResult.recordset[0].count > 0;
        
        const modifiedColumnUpdate = hasModifiedColumn 
          ? `CommissionRuleModified = CASE 
                WHEN @CommissionRuleId IS NOT NULL THEN GETUTCDATE()
                ELSE NULL
            END,`
          : '';
        
        await request.query(`
          UPDATE oe.Agents 
          SET CommissionRuleId = @CommissionRuleId,
              ${modifiedColumnUpdate}
              ModifiedDate = GETUTCDATE(),
              ModifiedBy = @ModifiedBy
          WHERE AgentId = @AgentId
        `);
        
        logger.info('Agent commission rule updated', {
          agentId: actualAgentId,
          commissionRuleId,
          modifiedBy: req.user.UserId
        }, 'TenantAdmin');
      }


      res.json({
        success: true,
        message: 'Commission rule updated successfully'
      });
    } catch (updateError) {
      console.error('❌ Error updating commission rule:', updateError);
      logger.error('Error updating commission rule', {
        error: updateError.message,
        agentId: actualAgentId,
        commissionRuleId,
        sqlError: updateError.originalError?.info?.message,
        stack: updateError.stack
      }, 'TenantAdmin');
      res.status(500).json({
        success: false,
        message: 'Failed to update commission rule',
        error: process.env.NODE_ENV === 'development' ? updateError.message : 'Internal server error'
      });
    }

  } catch (error) {
    console.error('❌ Error in commission rule update endpoint:', error);
    logger.error('Error in commission rule update endpoint', {
      error: error.message,
      agentId: req.params.id,
      stack: error.stack
    }, 'TenantAdmin');
    res.status(500).json({
      success: false,
      message: 'Failed to update commission rule',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @route GET /api/tenant-admin/agents/:id/bank-info
 * @desc Get bank information for agent - FIXED UserId→AgentId resolution
 * @access TenantAdmin, SysAdmin
 */
router.get('/agents/:id/bank-info', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { id } = req.params; // This could be either AgentId or UserId
    
    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    
    // STEP 1: Resolve UserId to AgentId (same logic as licenses)
    const agentIdRequest = pool.request();
    agentIdRequest.input('AgentId', sql.UniqueIdentifier, id);
    
    const agentByIdResult = await agentIdRequest.query(`
      SELECT AgentId, UserId, TenantId, Status, AgencyId FROM oe.Agents WHERE AgentId = @AgentId
    `);
    
    let agentRecord = null;
    let actualAgentId = null;
    
    if (agentByIdResult.recordset.length > 0) {
      // ID was AgentId
      agentRecord = agentByIdResult.recordset[0];
      actualAgentId = agentRecord.AgentId;
    } else {
      // Try as UserId
      const userIdRequest = pool.request();
      userIdRequest.input('UserId', sql.UniqueIdentifier, id);
      
      const agentByUserIdResult = await userIdRequest.query(`
        SELECT AgentId, UserId, TenantId, Status, AgencyId FROM oe.Agents WHERE UserId = @UserId
      `);
      
      if (agentByUserIdResult.recordset.length > 0) {
        agentRecord = agentByUserIdResult.recordset[0];
        actualAgentId = agentRecord.AgentId;
      }
    }
    
    if (!agentRecord || !actualAgentId) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }
    
    // STEP 2: For Agent role, allow if viewing own agency's bank info (as owner) OR viewing any downline agent's bank info
    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      const currentAgentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!currentAgentId) {
        return res.status(403).json({
          success: false,
          message: 'Agent profile not found'
        });
      }
      const isSelf = String(actualAgentId).toLowerCase() === String(currentAgentId).toLowerCase();
      const isDownline = await isUplineAncestor(pool, actualAgentId, currentAgentId);
      const isOwner = agentRecord.AgencyId ? await isAgencyOwner(pool, agentRecord.AgencyId, currentAgentId) : false;
      if (!isSelf && !isDownline && !isOwner) {
        return res.status(403).json({
          success: false,
          message: 'Insufficient permissions'
        });
      }
    }
    
    // STEP 3: Apply tenant isolation check
    if (!getUserRoles(req.user).includes('SysAdmin') && agentRecord.TenantId !== req.user.TenantId) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }
    
    // STEP 3: Get bank information using the resolved AgentId
    const request = pool.request();
    request.input('AgentId', sql.UniqueIdentifier, actualAgentId);
    
    try {
      const result = await request.query(`
        SELECT 
          BankInfoId,
          AgentId,
          BankName,
          AccountName,
          AccountType,
          RoutingNumber,
          AccountNumberEncrypted,
          AccountNumberLast4,
          Status,
          IsDefault,
          VerificationStatus,
          VerificationDate,
          CreatedDate,
          ModifiedDate
        FROM oe.AgentBankInfo
        WHERE AgentId = @AgentId AND Status = 'Active'
        ORDER BY IsDefault DESC, CreatedDate DESC
      `);
      
      if (result.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No bank information found for this agent'
        });
      }
      
      const bankRecord = { ...result.recordset[0] };

      // Decode the stored account number so the tenant admin can view the
      // full account number in the UI. Uses smartDecryptAccountNumber to
      // handle all three legacy storage formats (AES-256-GCM, base64,
      // plaintext) since historical rows were written inconsistently.
      if (bankRecord.AccountNumberEncrypted) {
        try {
          bankRecord.AccountNumber = encryptionService.smartDecryptAccountNumber(
            bankRecord.AccountNumberEncrypted
          ) || '';
        } catch (decodeError) {
          console.warn('⚠️ Failed to decode AccountNumberEncrypted:', decodeError.message);
          bankRecord.AccountNumber = '';
        }
      }
      delete bankRecord.AccountNumberEncrypted;

      console.log('🔍 BACKEND - Bank info query result for agent:', bankRecord.AgentId);
      console.log('🔍 BACKEND - AccountNumberLast4 value:', bankRecord.AccountNumberLast4);

      res.json({
        success: true,
        data: bankRecord
      });
      
    } catch (bankError) {
      // If table doesn't exist, return empty response
      if (bankError.message.includes('Invalid object name')) {
        return res.status(404).json({
          success: false,
          message: 'No bank information found for this agent'
        });
      }
      throw bankError;
    }
    
  } catch (error) {
    logger.error('Error fetching agent bank information', { 
      error: error.message, 
      agentId: req.params.id
    }, 'TenantAdmin');
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch bank information' 
    });
  }
});

/**
 * @route DELETE /api/tenant-admin/agents/:id/bank-info
 * @desc Delete bank information for agent - FIXED UserId→AgentId resolution
 * @access TenantAdmin, SysAdmin
 */
router.delete('/agents/:id/bank-info', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params; // This could be either AgentId or UserId
    
    const pool = await getPool();
    
    // STEP 1: Resolve UserId to AgentId (same logic as licenses)
    const agentIdRequest = pool.request();
    agentIdRequest.input('AgentId', sql.UniqueIdentifier, id);
    
    const agentByIdResult = await agentIdRequest.query(`
      SELECT AgentId, UserId, TenantId, Status FROM oe.Agents WHERE AgentId = @AgentId
    `);
    
    let agentRecord = null;
    let actualAgentId = null;
    
    if (agentByIdResult.recordset.length > 0) {
      // ID was AgentId
      agentRecord = agentByIdResult.recordset[0];
      actualAgentId = agentRecord.AgentId;
    } else {
      // Try as UserId
      const userIdRequest = pool.request();
      userIdRequest.input('UserId', sql.UniqueIdentifier, id);
      
      const agentByUserIdResult = await userIdRequest.query(`
        SELECT AgentId, UserId, TenantId, Status FROM oe.Agents WHERE UserId = @UserId
      `);
      
      if (agentByUserIdResult.recordset.length > 0) {
        agentRecord = agentByUserIdResult.recordset[0];
        actualAgentId = agentRecord.AgentId;
      }
    }
    
    if (!agentRecord || !actualAgentId) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }
    
    // STEP 2: Apply tenant isolation check
    if (!getUserRoles(req.user).includes('SysAdmin') && agentRecord.TenantId !== req.user.TenantId) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }
    
    const request = pool.request();
    request.input('AgentId', sql.UniqueIdentifier, actualAgentId);
    request.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
    
    // Soft delete by changing status to Inactive
    const result = await request.query(`
      UPDATE oe.AgentBankInfo 
      SET Status = 'Inactive',
          ModifiedDate = GETUTCDATE(),
          ModifiedBy = @ModifiedBy
      WHERE AgentId = @AgentId AND Status = 'Active'
    `);
    
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'No active bank information found for this agent'
      });
    }
    
    logger.info('Agent bank information deleted', {
      agentId: actualAgentId,
      deletedBy: req.user.UserId
    }, 'TenantAdmin');
    
    res.json({
      success: true,
      message: 'Bank information deleted successfully'
    });
    
  } catch (error) {
    logger.error('Error deleting agent bank information', { 
      error: error.message, 
      agentId: req.params.id
    }, 'TenantAdmin');
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete bank information' 
    });
  }
});

/**
 * @route GET /api/tenant-admin/agents/:id/downline-all
 * @desc Get all recursive downline agents with commission group info (for bulk apply)
 * @access TenantAdmin, SysAdmin, Agent (own or downline)
 */
router.get('/agents/:id/downline-all', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { id: idParam } = req.params;
    const pool = await getPool();
    const request = pool.request();
    const userRoles = getUserRoles(req.user);

    request.input('IdParam', sql.UniqueIdentifier, idParam);

    const agentCheck = await request.query(`
      SELECT AgentId, AgencyId FROM oe.Agents WHERE AgentId = @IdParam OR UserId = @IdParam
    `);

    if (agentCheck.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const agentId = agentCheck.recordset[0].AgentId;
    const agentAgencyId = agentCheck.recordset[0].AgencyId;

    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      const currentAgentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!currentAgentId) {
        return res.status(403).json({ success: false, message: 'Agent profile not found' });
      }
      const viewingOwnDownline = String(agentId).toLowerCase() === String(currentAgentId).toLowerCase();
      const isOwner = agentAgencyId ? await isAgencyOwner(pool, agentAgencyId, currentAgentId) : false;
      const targetIsInMyDownline = await isUplineAncestor(pool, agentId, currentAgentId);
      if (!viewingOwnDownline && !isOwner && !targetIsInMyDownline) {
        return res.status(403).json({ success: false, message: 'Insufficient permissions' });
      }
    }

    request.input('AgentId', sql.UniqueIdentifier, agentId);
    if (!userRoles.includes('SysAdmin')) {
      request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    }

    const tenantWhere = !userRoles.includes('SysAdmin') ? 'AND a.TenantId = @TenantId' : '';

    const result = await request.query(`
      WITH AgentTree AS (
        SELECT ah.AgentId, 1 as Level
        FROM oe.AgentHierarchy ah
        JOIN oe.Agents a ON ah.AgentId = a.AgentId
        WHERE ah.ParentId = @AgentId AND ah.Status = 'Active' AND a.Status IN ('Active', 'Pending') ${tenantWhere}
        UNION ALL
        SELECT ah.AgentId, at.Level + 1
        FROM oe.AgentHierarchy ah
        JOIN oe.Agents a ON ah.AgentId = a.AgentId
        JOIN AgentTree at ON ah.ParentId = at.AgentId
        WHERE ah.Status = 'Active' AND a.Status IN ('Active', 'Pending') AND at.Level < 15 ${tenantWhere}
      )
      SELECT
        a.AgentId,
        u.FirstName + ' ' + u.LastName as AgentName,
        u.Email,
        a.CommissionGroupId,
        cg.Name as CommissionGroupName,
        at.Level,
        ah_parent.ParentId
      FROM AgentTree at
      JOIN oe.Agents a ON at.AgentId = a.AgentId
      JOIN oe.Users u ON a.UserId = u.UserId
      LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
      LEFT JOIN oe.AgentHierarchy ah_parent ON ah_parent.AgentId = a.AgentId AND ah_parent.Status = 'Active'
      ORDER BY at.Level, u.FirstName, u.LastName
    `);

    const rows = (result.recordset || []).map((r) => ({
      agentId: r.AgentId,
      agentName: r.AgentName || '',
      email: r.Email || '',
      commissionGroupId: r.CommissionGroupId || null,
      commissionGroupName: r.CommissionGroupName || null,
      level: r.Level,
      parentAgentId: r.ParentId || null
    }));

    res.json({ success: true, data: rows, count: rows.length });
  } catch (error) {
    logger.error('Error fetching agent downline-all', { error: error.message, agentId: req.params.id }, 'TenantAdmin');
    res.status(500).json({ success: false, message: 'Failed to fetch downline agents' });
  }
});

/**
 * @route POST /api/tenant-admin/agents/bulk-update-commission-codes
 * @desc Bulk update CommissionGroupId on OnboardingLinkCommissionCodes for the given agent IDs
 * @access TenantAdmin, SysAdmin
 */
router.post('/agents/bulk-update-commission-codes', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { agentIds, commissionGroupId } = req.body;
    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      return res.status(400).json({ success: false, message: 'agentIds array is required' });
    }
    if (!commissionGroupId) {
      return res.status(400).json({ success: false, message: 'commissionGroupId is required' });
    }

    const pool = await getPool();
    let updatedCodeCount = 0;
    for (const agentId of agentIds) {
      const result = await pool.request()
        .input('agentId', sql.UniqueIdentifier, agentId)
        .input('commissionGroupId', sql.UniqueIdentifier, commissionGroupId)
        .query(`
          UPDATE olcc
          SET olcc.CommissionGroupId = @commissionGroupId,
              olcc.ModifiedDate = GETUTCDATE()
          FROM oe.OnboardingLinkCommissionCodes olcc
          INNER JOIN oe.AgentOnboardingLinks aol ON olcc.LinkId = aol.LinkId
          WHERE aol.AgentId = @agentId
        `);
      updatedCodeCount += result.rowsAffected[0] || 0;
    }

    res.json({
      success: true,
      data: { agentCount: agentIds.length, updatedCodeCount },
      message: `Updated commission group on ${updatedCodeCount} commission code(s) across ${agentIds.length} agent(s)`
    });
  } catch (error) {
    logger.error('Error in bulk-update-commission-codes', { error: error.message }, 'TenantAdmin');
    res.status(500).json({ success: false, message: 'Failed to bulk update commission codes' });
  }
});

/**
 * @route GET /api/tenant-admin/agents/:id/downline-count
 * @desc Get count of recursive downline agents (lightweight, for UI)
 * @access TenantAdmin, SysAdmin, Agent (own or downline)
 */
router.get('/agents/:id/downline-count', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { id: idParam } = req.params;
    const pool = await getPool();
    const request = pool.request();
    const userRoles = getUserRoles(req.user);

    request.input('IdParam', sql.UniqueIdentifier, idParam);
    const agentCheck = await request.query(`
      SELECT AgentId, AgencyId FROM oe.Agents WHERE AgentId = @IdParam OR UserId = @IdParam
    `);
    if (agentCheck.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const agentId = agentCheck.recordset[0].AgentId;
    const agentAgencyId = agentCheck.recordset[0].AgencyId;

    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      const currentAgentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!currentAgentId) {
        return res.status(403).json({ success: false, message: 'Agent profile not found' });
      }
      const viewingOwnDownline = String(agentId).toLowerCase() === String(currentAgentId).toLowerCase();
      const isOwner = agentAgencyId ? await isAgencyOwner(pool, agentAgencyId, currentAgentId) : false;
      const targetIsInMyDownline = await isUplineAncestor(pool, agentId, currentAgentId);
      if (!viewingOwnDownline && !isOwner && !targetIsInMyDownline) {
        return res.status(403).json({ success: false, message: 'Insufficient permissions' });
      }
    }

    request.input('AgentId', sql.UniqueIdentifier, agentId);
    if (!userRoles.includes('SysAdmin')) {
      request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    }
    const tenantWhere = !userRoles.includes('SysAdmin') ? 'AND a.TenantId = @TenantId' : '';

    const countResult = await request.query(`
      WITH AgentTree AS (
        SELECT ah.AgentId, 1 as Level
        FROM oe.AgentHierarchy ah
        JOIN oe.Agents a ON ah.AgentId = a.AgentId
        WHERE ah.ParentId = @AgentId AND ah.Status = 'Active' AND a.Status IN ('Active', 'Pending') ${tenantWhere}
        UNION ALL
        SELECT ah.AgentId, at.Level + 1
        FROM oe.AgentHierarchy ah
        JOIN oe.Agents a ON ah.AgentId = a.AgentId
        JOIN AgentTree at ON ah.ParentId = at.AgentId
        WHERE ah.Status = 'Active' AND a.Status IN ('Active', 'Pending') AND at.Level < 15 ${tenantWhere}
      )
      SELECT COUNT(*) as cnt FROM AgentTree
    `);
    const count = countResult.recordset[0]?.cnt ?? 0;
    res.json({ success: true, data: Number(count) });
  } catch (error) {
    logger.error('Error fetching agent downline-count', { error: error.message, agentId: req.params.id }, 'TenantAdmin');
    res.status(500).json({ success: false, message: 'Failed to fetch downline count' });
  }
});

/**
 * @route GET /api/tenant-admin/agents/:id/downline
 * @desc Get agent downline hierarchy
 * @access TenantAdmin, SysAdmin
 */
router.get('/agents/:id/downline', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { id: idParam } = req.params;
    const pool = await getPool();
    const request = pool.request();
    const userRoles = getUserRoles(req.user);
    
    request.input('IdParam', sql.UniqueIdentifier, idParam);
    
    // Resolve id to AgentId (id may be AgentId or UserId)
    const agentCheck = await request.query(`
      SELECT AgentId, AgencyId FROM oe.Agents WHERE AgentId = @IdParam OR UserId = @IdParam
    `);
    
    if (agentCheck.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }
    
    const agentId = agentCheck.recordset[0].AgentId;
    request.input('AgentId', sql.UniqueIdentifier, agentId);
    const agentAgencyId = agentCheck.recordset[0].AgencyId;
    
    // Check if agent can view this downline (for Agent role): self, agency owner of target's agency, or target is in your downline
    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      const currentAgentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!currentAgentId) {
        return res.status(403).json({
          success: false,
          message: 'Agent profile not found'
        });
      }
      const viewingOwnDownline = String(agentId).toLowerCase() === String(currentAgentId).toLowerCase();
      const isOwner = agentAgencyId ? await isAgencyOwner(pool, agentAgencyId, currentAgentId) : false;
      const targetIsInMyDownline = await isUplineAncestor(pool, agentId, currentAgentId);
      if (!viewingOwnDownline && !isOwner && !targetIsInMyDownline) {
        return res.status(403).json({
          success: false,
          message: 'Insufficient permissions'
        });
      }
    }
    
    // Check if OverridePercentage column exists
    const columnCheckRequest = pool.request();
    const columnCheckResult = await columnCheckRequest.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'AgentHierarchy' 
      AND COLUMN_NAME = 'OverridePercentage' 
      AND TABLE_SCHEMA = 'oe'
    `);
    const hasOverrideColumn = columnCheckResult.recordset[0].count > 0;
    
    // Check if OverrideType column exists
    const overrideTypeCheckRequest = pool.request();
    const overrideTypeCheckResult = await overrideTypeCheckRequest.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'AgentHierarchy' 
      AND COLUMN_NAME = 'OverrideType' 
      AND TABLE_SCHEMA = 'oe'
    `);
    const hasOverrideTypeColumn = overrideTypeCheckResult.recordset[0].count > 0;
    
    // Check if OverrideAmount column exists
    const overrideAmountCheckRequest = pool.request();
    const overrideAmountCheckResult = await overrideAmountCheckRequest.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'AgentHierarchy' 
      AND COLUMN_NAME = 'OverrideAmount' 
      AND TABLE_SCHEMA = 'oe'
    `);
    const hasOverrideAmountColumn = overrideAmountCheckResult.recordset[0].count > 0;
    
    // Check if CommissionTierLevel column exists
    const tierColumnCheckRequest = pool.request();
    const tierColumnCheckResult = await tierColumnCheckRequest.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'Agents' 
      AND COLUMN_NAME = 'CommissionTierLevel' 
      AND TABLE_SCHEMA = 'oe'
    `);
    const hasTierColumn = tierColumnCheckResult.recordset[0].count > 0;
    
    // Get downline hierarchy - find who reports to this agent
    const overrideSelect = hasOverrideColumn 
      ? 'ISNULL(ah.OverridePercentage, 0) as OverridePercentage'
      : '0 as OverridePercentage';
    
    const overrideTypeSelect = hasOverrideTypeColumn
      ? "ISNULL(ah.OverrideType, 'Percent') as OverrideType"
      : "'Percent' as OverrideType";
    
    const overrideAmountSelect = hasOverrideAmountColumn
      ? 'ah.OverrideAmount as OverrideAmount'
      : 'NULL as OverrideAmount';
    
    const tierSelect = hasTierColumn
      ? 'ISNULL(a.CommissionTierLevel, 0) as CommissionTierLevel'
      : '0 as CommissionTierLevel';
    
    const result = await request.query(`
      SELECT 
        ah.AgentId,
        ah.ParentId,
        ah.Type as ParentType,
        ${overrideSelect},
        ${overrideTypeSelect},
        ${overrideAmountSelect},
        ${tierSelect},
        ah.Status,
        ah.CreatedDate,
        ah.ModifiedDate,
        u.FirstName + ' ' + u.LastName as AgentName,
        u.Email,
        ISNULL(a.CommissionRole, 'Agent') as CommissionRole,
        1 as Level
      FROM oe.AgentHierarchy ah
      JOIN oe.Agents a ON ah.AgentId = a.AgentId
      JOIN oe.Users u ON a.UserId = u.UserId
      WHERE ah.ParentId = @AgentId 
        AND ah.Status = 'Active'
      ORDER BY AgentName
    `);
    
    res.json({
      success: true,
      data: result.recordset,
      message: result.recordset.length === 0 ? 'No downline agents found' : undefined
    });
    
  } catch (error) {
    logger.error('Error fetching agent downline', { 
      error: error.message, 
      agentId: req.params.id,
      stack: error.stack 
    }, 'TenantAdmin');
    
    res.json({ 
      success: true, 
      data: [],
      message: 'No downline data available'
    });
  }
});

/**
 * @route DELETE /api/tenant-admin/agents/:id/downline/:downlineAgentId
 * @desc Remove an agent from downline (set them to top level)
 * @access TenantAdmin, SysAdmin
 */
router.delete('/agents/:id/downline/:downlineAgentId', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id: parentAgentId, downlineAgentId } = req.params;
    const pool = await getPool();
    const transaction = pool.transaction();

    try {
      await transaction.begin();

      // Verify parent agent exists and belongs to tenant
      const parentRequest = transaction.request();
      parentRequest.input('ParentAgentId', sql.UniqueIdentifier, parentAgentId);
      parentRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);

      const parentResult = await parentRequest.query(`
        SELECT AgentId, AgencyId 
        FROM oe.Agents 
        WHERE AgentId = @ParentAgentId AND TenantId = @TenantId
      `);

      if (parentResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Parent agent not found or access denied'
        });
      }

      // Verify downline agent exists and belongs to tenant
      const downlineRequest = transaction.request();
      downlineRequest.input('DownlineAgentId', sql.UniqueIdentifier, downlineAgentId);
      downlineRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);

      const downlineResult = await downlineRequest.query(`
        SELECT AgentId, AgencyId 
        FROM oe.Agents 
        WHERE AgentId = @DownlineAgentId AND TenantId = @TenantId
      `);

      if (downlineResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Downline agent not found or access denied'
        });
      }

      const downlineAgencyId = downlineResult.recordset[0].AgencyId;

      // Verify the hierarchy relationship exists
      const hierarchyCheckRequest = transaction.request();
      hierarchyCheckRequest.input('ParentAgentId', sql.UniqueIdentifier, parentAgentId);
      hierarchyCheckRequest.input('DownlineAgentId', sql.UniqueIdentifier, downlineAgentId);

      const hierarchyCheckResult = await hierarchyCheckRequest.query(`
        SELECT HierarchyId 
        FROM oe.AgentHierarchy 
        WHERE ParentId = @ParentAgentId AND AgentId = @DownlineAgentId AND Status = 'Active'
      `);

      if (hierarchyCheckResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Hierarchy relationship not found'
        });
      }

      // Update the hierarchy relationship: change ParentId from parentAgentId to AgencyId (top level)
      if (downlineAgencyId) {
        const updateRequest = transaction.request();
        updateRequest.input('DownlineAgentId', sql.UniqueIdentifier, downlineAgentId);
        updateRequest.input('ParentAgentId', sql.UniqueIdentifier, parentAgentId);
        updateRequest.input('AgencyId', sql.UniqueIdentifier, downlineAgencyId);

        // Update the hierarchy record: change ParentId from parentAgentId to AgencyId
        await updateRequest.query(`
          UPDATE oe.AgentHierarchy 
          SET ParentId = @AgencyId, 
              AgencyId = @AgencyId,
              ModifiedDate = GETUTCDATE()
          WHERE AgentId = @DownlineAgentId 
            AND ParentId = @ParentAgentId 
            AND Status = 'Active'
        `);
      }

      await transaction.commit();

      logger.info('Agent removed from downline', {
        parentAgentId,
        downlineAgentId,
        tenantId: req.user.TenantId,
        updatedBy: req.user.UserId
      }, 'TenantAdmin');

      res.json({
        success: true,
        message: 'Agent removed from downline and set to top level'
      });

    } catch (error) {
      await transaction.rollback();
      throw error;
    }

  } catch (error) {
    logger.error('Error removing agent from downline', {
      error: error.message,
      parentAgentId: req.params.id,
      downlineAgentId: req.params.downlineAgentId,
      stack: error.stack
    }, 'TenantAdmin');

    res.status(500).json({
      success: false,
      message: 'Failed to remove agent from downline',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route PUT /api/tenant-admin/agents/:id/downline/:downlineAgentId/override
 * @desc Update override (percentage or flat rate) for a downline agent
 * @access TenantAdmin, SysAdmin, Agent (if agency owner)
 */
router.put('/agents/:id/downline/:downlineAgentId/override', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { id: parentAgentId, downlineAgentId } = req.params;
    const { overridePercentage, overrideAmount, overrideType = 'Percentage' } = req.body;
    const userRoles = getUserRoles(req.user);

    // Validate override type
    if (overrideType !== 'Percent' && overrideType !== 'Flatrate') {
      return res.status(400).json({
        success: false,
        message: 'OverrideType must be "Percent" or "Flatrate"'
      });
    }

    // Validate based on type
    if (overrideType === 'Percent') {
      if (overridePercentage === undefined || overridePercentage === null) {
        return res.status(400).json({
          success: false,
          message: 'OverridePercentage is required for Percent type'
        });
      }
      const overrideValue = parseFloat(overridePercentage);
      if (isNaN(overrideValue) || overrideValue < 0 || overrideValue > 100) {
        return res.status(400).json({
          success: false,
          message: 'OverridePercentage must be between 0 and 100'
        });
      }
    } else if (overrideType === 'Flatrate') {
      if (overrideAmount === undefined || overrideAmount === null) {
        return res.status(400).json({
          success: false,
          message: 'OverrideAmount is required for Flatrate type'
        });
      }
      const overrideValue = parseFloat(overrideAmount);
      if (isNaN(overrideValue) || overrideValue < 0) {
        return res.status(400).json({
          success: false,
          message: 'OverrideAmount must be greater than or equal to 0'
        });
      }
    }

    const pool = await getPool();
    const transaction = pool.transaction();

    try {
      await transaction.begin();

      // Verify parent agent exists and belongs to tenant
      const parentRequest = transaction.request();
      parentRequest.input('ParentAgentId', sql.UniqueIdentifier, parentAgentId);
      parentRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);

      const parentResult = await parentRequest.query(`
        SELECT AgentId FROM oe.Agents 
        WHERE AgentId = @ParentAgentId AND TenantId = @TenantId
      `);

      if (parentResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Parent agent not found or access denied'
        });
      }

      // Verify downline agent exists and belongs to tenant
      const downlineRequest = transaction.request();
      downlineRequest.input('DownlineAgentId', sql.UniqueIdentifier, downlineAgentId);
      downlineRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);

      const downlineResult = await downlineRequest.query(`
        SELECT AgentId FROM oe.Agents 
        WHERE AgentId = @DownlineAgentId AND TenantId = @TenantId
      `);

      if (downlineResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Downline agent not found or access denied'
        });
      }

      // Check if agent is owner of the agency (for Agent role)
      if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
        const parentAgentCheck = transaction.request();
        parentAgentCheck.input('ParentAgentId', sql.UniqueIdentifier, parentAgentId);
        const parentAgentResult = await parentAgentCheck.query(`
          SELECT AgencyId FROM oe.Agents WHERE AgentId = @ParentAgentId
        `);
        
        if (parentAgentResult.recordset.length > 0 && parentAgentResult.recordset[0].AgencyId) {
          const agencyId = parentAgentResult.recordset[0].AgencyId;
          const currentAgentId = await getAgentIdFromUserId(pool, req.user.UserId);
          if (!currentAgentId) {
            await transaction.rollback();
            return res.status(403).json({
              success: false,
              message: 'Agent profile not found'
            });
          }
          const isOwner = await isAgencyOwner(pool, agencyId, currentAgentId);
          if (!isOwner) {
            await transaction.rollback();
            return res.status(403).json({
              success: false,
              message: 'Insufficient permissions'
            });
          }
        }
      }

      // Verify the hierarchy relationship exists
      const hierarchyCheckRequest = transaction.request();
      hierarchyCheckRequest.input('ParentAgentId', sql.UniqueIdentifier, parentAgentId);
      hierarchyCheckRequest.input('DownlineAgentId', sql.UniqueIdentifier, downlineAgentId);

      const hierarchyCheckResult = await hierarchyCheckRequest.query(`
        SELECT HierarchyId FROM oe.AgentHierarchy 
        WHERE ParentId = @ParentAgentId AND AgentId = @DownlineAgentId AND Status = 'Active'
      `);

      if (hierarchyCheckResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Hierarchy relationship not found'
        });
      }

      // Check if OverrideType and OverrideAmount columns exist
      const overrideTypeCheckRequest = pool.request();
      const overrideTypeCheckResult = await overrideTypeCheckRequest.query(`
        SELECT COUNT(*) as count 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'AgentHierarchy' 
        AND COLUMN_NAME = 'OverrideType' 
        AND TABLE_SCHEMA = 'oe'
      `);
      const hasOverrideTypeColumn = overrideTypeCheckResult.recordset[0].count > 0;
      
      const overrideAmountCheckRequest = pool.request();
      const overrideAmountCheckResult = await overrideAmountCheckRequest.query(`
        SELECT COUNT(*) as count 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'AgentHierarchy' 
        AND COLUMN_NAME = 'OverrideAmount' 
        AND TABLE_SCHEMA = 'oe'
      `);
      const hasOverrideAmountColumn = overrideAmountCheckResult.recordset[0].count > 0;

      // Update the override
      const updateRequest = transaction.request();
      updateRequest.input('DownlineAgentId', sql.UniqueIdentifier, downlineAgentId);
      updateRequest.input('ParentAgentId', sql.UniqueIdentifier, parentAgentId);
      updateRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);

      let updateFields = [];
      
      if (overrideType === 'Percent') {
        updateRequest.input('OverridePercentage', sql.Decimal(5, 2), parseFloat(overridePercentage));
        updateFields.push('OverridePercentage = @OverridePercentage');
        if (hasOverrideAmountColumn) {
          updateFields.push('OverrideAmount = NULL');
        }
        // If OverrideType column doesn't exist, only update percentage (backward compatibility)
        if (hasOverrideTypeColumn) {
          updateRequest.input('OverrideType', sql.NVarChar(20), overrideType);
          updateFields.push('OverrideType = @OverrideType');
        }
      } else {
        // Flatrate type - only update if columns exist
        if (!hasOverrideTypeColumn || !hasOverrideAmountColumn) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: 'OverrideType and OverrideAmount columns are required for flat rate overrides. Please run the database migration first.'
          });
        }
        updateRequest.input('OverrideAmount', sql.Decimal(10, 2), parseFloat(overrideAmount));
        updateRequest.input('OverrideType', sql.NVarChar(20), overrideType);
        updateFields.push('OverrideAmount = @OverrideAmount');
        updateFields.push('OverridePercentage = NULL');
        updateFields.push('OverrideType = @OverrideType');
      }
      
      updateFields.push('ModifiedDate = GETUTCDATE()');

      await updateRequest.query(`
        UPDATE oe.AgentHierarchy 
        SET ${updateFields.join(', ')}
        WHERE AgentId = @DownlineAgentId 
          AND ParentId = @ParentAgentId 
          AND Status = 'Active'
      `);

      await transaction.commit();

      logger.info('Override updated', {
        parentAgentId,
        downlineAgentId,
        overrideType,
        overridePercentage: overrideType === 'Percentage' ? parseFloat(overridePercentage) : null,
        overrideAmount: overrideType === 'Fixed' ? parseFloat(overrideAmount) : null,
        tenantId: req.user.TenantId,
        updatedBy: req.user.UserId
      }, 'TenantAdmin');

      res.json({
        success: true,
        message: 'Override updated successfully',
        data: {
          overrideType,
          overridePercentage: overrideType === 'Percentage' ? parseFloat(overridePercentage) : null,
          overrideAmount: overrideType === 'Fixed' ? parseFloat(overrideAmount) : null
        }
      });

    } catch (error) {
      await transaction.rollback();
      throw error;
    }

  } catch (error) {
    logger.error('Error updating override percentage', {
      error: error.message,
      parentAgentId: req.params.id,
      downlineAgentId: req.params.downlineAgentId,
      stack: error.stack
    }, 'TenantAdmin');

    res.status(500).json({
      success: false,
      message: 'Failed to update override percentage',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route GET /api/tenant-admin/agents/:id/upline
 * @desc Get agent upline hierarchy
 * @access TenantAdmin, SysAdmin
 */
router.get('/agents/:id/upline', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { id: idParam } = req.params;
    const pool = await getPool();
    const request = pool.request();
    const userRoles = getUserRoles(req.user);
    
    request.input('IdParam', sql.UniqueIdentifier, idParam);
    
    // Resolve id to AgentId (id may be AgentId or UserId)
    const agentCheck = await request.query(`
      SELECT AgentId, AgencyId FROM oe.Agents 
      WHERE AgentId = @IdParam OR UserId = @IdParam
    `);
    
    if (agentCheck.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }
    
    const agentId = agentCheck.recordset[0].AgentId;
    request.input('AgentId', sql.UniqueIdentifier, agentId);
    
    const agentAgencyId = agentCheck.recordset[0].AgencyId;
    
    // Check if agent can view this agent's upline (for Agent role): owner of agency OR viewing own upline OR direct upline of this agent
    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      const currentAgentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!currentAgentId) {
        return res.status(403).json({
          success: false,
          message: 'Agent profile not found'
        });
      }
      const viewingOwnUpline = agentId === currentAgentId;
      const isUplineOfAgent = await isDirectUpline(pool, agentId, currentAgentId);
      const isOwner = agentAgencyId ? await isAgencyOwner(pool, agentAgencyId, currentAgentId) : false;
      if (!viewingOwnUpline && !isUplineOfAgent && !isOwner) {
        return res.status(403).json({
          success: false,
          message: 'Insufficient permissions'
        });
      }
    }
    
    // Get upline hierarchy - recursively find all upline agents
    const result = await request.query(`
      WITH AgentUpline AS (
        -- Start with the agent itself (to find their parent)
        SELECT 
          ah.AgentId as StartingAgentId,
          ah.ParentId as UplineAgentId,
          0 as Level,
          ah.Type as ParentType,
          ah.Status,
          ah.CreatedDate,
          ah.ModifiedDate
        FROM oe.AgentHierarchy ah
        WHERE ah.AgentId = @AgentId AND ah.Status = 'Active'
        
        UNION ALL
        
        -- Recursively get upline parents
        SELECT 
          au.StartingAgentId,
          ah.ParentId as UplineAgentId,
          au.Level + 1,
          ah.Type as ParentType,
          ah.Status,
          ah.CreatedDate,
          ah.ModifiedDate
        FROM oe.AgentHierarchy ah
        INNER JOIN AgentUpline au ON ah.AgentId = au.UplineAgentId
        WHERE ah.Status = 'Active'
          AND ah.Type = 'Agent'
          AND au.Level < 10 -- Prevent infinite recursion
          AND ah.ParentId IS NOT NULL
      )
      SELECT DISTINCT
        au.UplineAgentId as AgentId,
        au.StartingAgentId,
        au.ParentType,
        au.Status,
        au.Level,
        u.FirstName + ' ' + u.LastName as AgentName,
        u.Email,
        ISNULL(a.CommissionRole, 'Agent') as CommissionRole,
        au.UplineAgentId as ParentAgentId,
        u.FirstName + ' ' + u.LastName as ParentAgentName,
        u.Email as ParentAgentEmail,
        ISNULL(a.CommissionRole, 'Agent') as ParentAgentCommissionRole
      FROM AgentUpline au
      JOIN oe.Agents a ON au.UplineAgentId = a.AgentId
      JOIN oe.Users u ON a.UserId = u.UserId
      WHERE au.UplineAgentId IS NOT NULL
      ORDER BY au.Level ASC
    `);
    
    // Transform the result to match the expected interface
    const hierarchyData = result.recordset.map(row => ({
      HierarchyId: row.AgentId + '_' + row.Level, // Create a unique ID
      AgentId: row.StartingAgentId,
      ParentId: row.AgentId,
      ParentType: row.ParentType,
      Status: row.Status,
      Level: row.Level + 1, // Increment by 1 to match UI expectations
      AgentName: row.AgentName,
      Email: row.Email,
      CommissionRole: row.CommissionRole,
      ParentAgent: {
        AgentId: row.ParentAgentId,
        Name: row.ParentAgentName,
        Email: row.ParentAgentEmail,
        CommissionRole: row.ParentAgentCommissionRole
      }
    }));
    
    res.json({
      success: true,
      data: hierarchyData,
      message: result.recordset.length === 0 ? 'No upline agents found' : undefined
    });
    
  } catch (error) {
    logger.error('Error fetching agent upline', { 
      error: error.message, 
      agentId: req.params.id,
      stack: error.stack 
    }, 'TenantAdmin');
    
    res.json({ 
      success: true, 
      data: [],
      message: 'No upline data available'
    });
  }
});

/**
 * @route POST /api/tenant-admin/agents/:id/documents
 * @desc Upload document for agent
 * @access TenantAdmin, SysAdmin
 */
router.post('/agents/:id/documents', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    console.log('📄 POST /api/tenant-admin/agents/:id/documents - Request received');
    const { id: agentId } = req.params;
    const {
      documentType,
      fileName,
      fileUrl,
      fileSize,
      fileType,
      description
    } = req.body;
    
    console.log('📄 Document upload data:', {
      agentId,
      documentType,
      fileName,
      fileUrl,
      fileSize,
      fileType,
      description
    });
    
    // Validation
    if (!documentType || !fileName || !fileUrl) {
      return res.status(400).json({
        success: false,
        message: 'Document type, file name, and file URL are required'
      });
    }
    
    const pool = await getPool();
    const request = pool.request();
    
    // Create document record
    const documentId = uuidv4();
    
    request.input('DocumentId', sql.UniqueIdentifier, documentId);
    request.input('AgentId', sql.UniqueIdentifier, agentId);
    request.input('DocumentType', sql.NVarChar, documentType);
    request.input('FileName', sql.NVarChar, fileName);
    request.input('FileUrl', sql.NVarChar, fileUrl);
    request.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
    
    // Always declare all parameters, even if optional
    request.input('FileSize', sql.Int, fileSize || 0);
    request.input('FileType', sql.NVarChar, fileType || '');
    request.input('Description', sql.NVarChar, description || '');
    
    await request.query(`
      INSERT INTO oe.AgentDocuments (
        DocumentId, AgentId, DocumentType, FileName, FileUrl, FileSize, 
        FileType, Description, Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
      ) VALUES (
        @DocumentId, @AgentId, @DocumentType, @FileName, @FileUrl, @FileSize,
        @FileType, @Description, 'Active', GETUTCDATE(), GETUTCDATE(), @CreatedBy, @CreatedBy
      )
    `);
    
    logger.info('Agent document uploaded', {
      documentId,
      agentId,
      documentType,
      fileName,
      createdBy: req.user.UserId
    }, 'TenantAdmin');
    
    res.status(201).json({
      success: true,
      data: { documentId },
      message: 'Document uploaded successfully'
    });
    
  } catch (error) {
    console.error('❌ Error uploading agent document:', error);
    logger.error('Error uploading agent document', { 
      error: error.message, 
      agentId: req.params.id,
      sqlError: error.originalError?.info?.message,
      stack: error.stack
    }, 'TenantAdmin');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to upload document',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @route PUT /api/tenant-admin/agents/:id/upline
 * @desc Update agent's upline
 * @access TenantAdmin, SysAdmin
 */
router.put('/agents/:id/upline', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id: idParam } = req.params;
    const { uplineId } = req.body;

    const pool = await getPool();
    const transaction = pool.transaction();

    try {
      await transaction.begin();

      // Resolve id to AgentId (id may be AgentId or UserId)
      const agentRequest = transaction.request();
      agentRequest.input('IdParam', sql.UniqueIdentifier, idParam);
      agentRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);

      const agentResult = await agentRequest.query(`
        SELECT AgentId, UserId, TenantId, AgencyId 
        FROM oe.Agents 
        WHERE (AgentId = @IdParam OR UserId = @IdParam) AND TenantId = @TenantId
      `);

      if (agentResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Agent not found or access denied'
        });
      }

      const agentId = agentResult.recordset[0].AgentId;
      const agentAgencyId = agentResult.recordset[0].AgencyId;
      
      if (!agentAgencyId) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Agent must be assigned to an agency before setting upline'
        });
      }

      // Remove existing hierarchy relationships for this agent
      const removeRequest = transaction.request();
      removeRequest.input('AgentId', sql.UniqueIdentifier, agentId);

      await removeRequest.query(`
        DELETE FROM oe.AgentHierarchy 
        WHERE AgentId = @AgentId
      `);

      let parentId = null;

      // Handle "none" or empty string - set agent at top level (parent is Agency)
      if (!uplineId || uplineId === 'none' || uplineId === '') {
        // At top level: ParentId is the AgencyId
        parentId = agentAgencyId;
      } else {
        // Check if new upline agent exists and belongs to same tenant
        const uplineRequest = transaction.request();
        uplineRequest.input('UplineId', sql.UniqueIdentifier, uplineId);
        uplineRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);

        const uplineResult = await uplineRequest.query(`
          SELECT AgentId, UserId, TenantId, AgencyId 
          FROM oe.Agents 
          WHERE AgentId = @UplineId AND TenantId = @TenantId
        `);

        if (uplineResult.recordset.length === 0) {
          await transaction.rollback();
          return res.status(404).json({
            success: false,
            message: 'Upline agent not found or access denied'
          });
        }

        // Verify upline agent is in the same agency
        if (uplineResult.recordset[0].AgencyId !== agentAgencyId) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: 'Upline agent must be in the same agency'
          });
        }

        // Has upline: ParentId is the AgentId of the upline agent
        parentId = uplineId;
      }

      // Create new hierarchy relationship
      const hierarchyId = uuidv4();
      const hierarchyRequest = transaction.request();

      hierarchyRequest.input('HierarchyId', sql.UniqueIdentifier, hierarchyId);
      hierarchyRequest.input('Type', sql.NVarChar, 'Agent');
      hierarchyRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      hierarchyRequest.input('AgencyId', sql.UniqueIdentifier, agentAgencyId);
      hierarchyRequest.input('AgentId', sql.UniqueIdentifier, agentId);
      hierarchyRequest.input('ParentId', sql.UniqueIdentifier, parentId);
      hierarchyRequest.input('Status', sql.NVarChar, 'Active');

      await hierarchyRequest.query(`
        INSERT INTO oe.AgentHierarchy (
          HierarchyId, Type, TenantId, AgencyId, AgentId, ParentId, Status,
          CreatedDate, ModifiedDate
        ) VALUES (
          @HierarchyId, @Type, @TenantId, @AgencyId, @AgentId, @ParentId, @Status,
          GETUTCDATE(), GETUTCDATE()
        )
      `);

      await transaction.commit();

      logger.info('Agent upline updated', {
        agentId,
        newUplineId: uplineId,
        tenantId: req.user.TenantId,
        updatedBy: req.user.UserId
      }, 'TenantAdmin');

      res.json({
        success: true,
        message: 'Agent upline updated successfully'
      });

    } catch (error) {
      await transaction.rollback();
      throw error;
    }

  } catch (error) {
    console.error('❌ Error updating agent upline:', error);
    logger.error('Error updating agent upline', {
      error: error.message,
      agentId: req.params.id,
      stack: error.stack,
      tenantId: req.user.TenantId
    }, 'TenantAdmin');
    
    res.status(500).json({
      success: false,
      message: 'Failed to update agent upline',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * ============================================================================
 * AGENCY OVERRIDES ROUTES
 * ============================================================================
 * Routes for managing agency commission overrides
 * Supports multiple overrides per agency, for all products or specific products
 * ============================================================================
 */

/**
 * @route GET /api/tenant-admin/agencies/:id/overrides
 * @desc Get all overrides for an agency
 * @access TenantAdmin, SysAdmin, Agent (if owner of agency)
 */
router.get('/agencies/:id/overrides', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { id: agencyId } = req.params;
    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    const request = pool.request();
    
    request.input('AgencyId', sql.UniqueIdentifier, agencyId);
    request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    
    // Check if agent is owner of this agency
    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      const agentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!agentId) {
        return res.status(403).json({
          success: false,
          message: 'Agent profile not found'
        });
      }
      const isOwner = await isAgencyOwner(pool, agencyId, agentId);
      if (!isOwner) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to view overrides for this agency'
        });
      }
    }
    
    // Verify agency exists and belongs to tenant
    const agencyCheck = await request.query(`
      SELECT AgencyId FROM oe.Agencies 
      WHERE AgencyId = @AgencyId AND TenantId = @TenantId
    `);
    
    if (agencyCheck.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agency not found or access denied'
      });
    }
    
    // Get all overrides for this agency
    const result = await request.query(`
      SELECT 
        ao.OverrideId,
        ao.AgencyId,
        ao.ProductId,
        p.Name as ProductName,
        ao.OverridePercentage,
        ao.OverrideAmount,
        ao.OverrideType,
        ao.Priority,
        ao.EffectiveDate,
        ao.TerminationDate,
        ao.Status,
        ao.Description,
        ao.TenantId,
        ao.CreatedDate,
        ao.ModifiedDate,
        ao.CreatedBy,
        ao.ModifiedBy
      FROM oe.AgencyOverrides ao
      LEFT JOIN oe.Products p ON ao.ProductId = p.ProductId
      WHERE ao.AgencyId = @AgencyId 
        AND ao.TenantId = @TenantId
        AND ao.Status != 'Deleted'
      ORDER BY ao.Priority DESC, ao.CreatedDate DESC
    `);
    
    res.json({
      success: true,
      data: result.recordset
    });
    
  } catch (error) {
    logger.error('Error fetching agency overrides', {
      error: error.message,
      agencyId: req.params.id,
      stack: error.stack
    }, 'TenantAdmin');
    
    res.status(500).json({
      success: false,
      message: 'Failed to fetch agency overrides',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route POST /api/tenant-admin/agencies/:id/overrides
 * @desc Create a new override for an agency
 * @access TenantAdmin, SysAdmin
 */
router.post('/agencies/:id/overrides', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id: agencyId } = req.params;
    const {
      productId, // NULL = all products
      overridePercentage,
      overrideAmount,
      overrideType = 'Percentage', // 'Percentage' or 'Fixed'
      priority = 0,
      effectiveDate,
      terminationDate,
      description
    } = req.body;
    
    // Validation
    if (overrideType === 'Percentage' && (overridePercentage === undefined || overridePercentage === null)) {
      return res.status(400).json({
        success: false,
        message: 'OverridePercentage is required for Percentage type'
      });
    }
    
    if (overrideType === 'Fixed' && (overrideAmount === undefined || overrideAmount === null)) {
      return res.status(400).json({
        success: false,
        message: 'OverrideAmount is required for Fixed type'
      });
    }
    
    if (overrideType === 'Percentage') {
      const percentage = parseFloat(overridePercentage);
      if (isNaN(percentage) || percentage < 0 || percentage > 100) {
        return res.status(400).json({
          success: false,
          message: 'OverridePercentage must be between 0 and 100'
        });
      }
    }
    
    if (overrideType === 'Fixed' && overrideAmount < 0) {
      return res.status(400).json({
        success: false,
        message: 'OverrideAmount must be greater than or equal to 0'
      });
    }
    
    const pool = await getPool();
    const transaction = pool.transaction();
    
    try {
      await transaction.begin();
      const request = transaction.request();
      
      request.input('AgencyId', sql.UniqueIdentifier, agencyId);
      request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      
      // Verify agency exists and belongs to tenant
      const agencyCheck = await request.query(`
        SELECT AgencyId FROM oe.Agencies 
        WHERE AgencyId = @AgencyId AND TenantId = @TenantId
      `);
      
      if (agencyCheck.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Agency not found or access denied'
        });
      }
      
      // Verify product exists if specified
      if (productId) {
        const productCheckRequest = transaction.request();
        productCheckRequest.input('ProductId', sql.UniqueIdentifier, productId);
        productCheckRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
        
        const productCheck = await productCheckRequest.query(`
          SELECT ProductId FROM oe.Products 
          WHERE ProductId = @ProductId AND TenantId = @TenantId
        `);
        
        if (productCheck.recordset.length === 0) {
          await transaction.rollback();
          return res.status(404).json({
            success: false,
            message: 'Product not found or access denied'
          });
        }
      }
      
      // Create override
      const overrideId = uuidv4();
      const insertRequest = transaction.request();
      
      insertRequest.input('OverrideId', sql.UniqueIdentifier, overrideId);
      insertRequest.input('AgencyId', sql.UniqueIdentifier, agencyId);
      // Use NULL for "All Products" GUID instead of storing the GUID
      const finalProductId = (productId === '00000000-0000-0000-0000-000000000000' || !productId) ? null : productId;
      insertRequest.input('ProductId', sql.UniqueIdentifier, finalProductId);
      insertRequest.input('OverridePercentage', sql.Decimal(5, 2), overrideType === 'Percentage' ? overridePercentage : null);
      insertRequest.input('OverrideAmount', sql.Decimal(10, 2), overrideType === 'Fixed' ? overrideAmount : null);
      insertRequest.input('OverrideType', sql.NVarChar(20), overrideType);
      insertRequest.input('Priority', sql.Int, priority);
      insertRequest.input('EffectiveDate', sql.Date, effectiveDate || null);
      insertRequest.input('TerminationDate', sql.Date, terminationDate || null);
      insertRequest.input('Status', sql.NVarChar(20), 'Active');
      insertRequest.input('Description', sql.NVarChar(500), description || null);
      insertRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      insertRequest.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
      
      await insertRequest.query(`
        INSERT INTO oe.AgencyOverrides (
          OverrideId, AgencyId, ProductId, OverridePercentage, OverrideAmount,
          OverrideType, Priority, EffectiveDate, TerminationDate, Status,
          Description, TenantId, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
        ) VALUES (
          @OverrideId, @AgencyId, @ProductId, @OverridePercentage, @OverrideAmount,
          @OverrideType, @Priority, @EffectiveDate, @TerminationDate, @Status,
          @Description, @TenantId, GETUTCDATE(), GETUTCDATE(), @CreatedBy, @CreatedBy
        )
      `);
      
      await transaction.commit();
      
      logger.info('Agency override created', {
        overrideId,
        agencyId,
        productId: productId || 'All Products',
        overrideType,
        tenantId: req.user.TenantId,
        createdBy: req.user.UserId
      }, 'TenantAdmin');
      
      res.status(201).json({
        success: true,
        data: { overrideId },
        message: 'Agency override created successfully'
      });
      
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    
  } catch (error) {
    logger.error('Error creating agency override', {
      error: error.message,
      agencyId: req.params.id,
      stack: error.stack
    }, 'TenantAdmin');
    
    res.status(500).json({
      success: false,
      message: 'Failed to create agency override',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route PUT /api/tenant-admin/agencies/:id/overrides/:overrideId
 * @desc Update an agency override
 * @access TenantAdmin, SysAdmin
 */
router.put('/agencies/:id/overrides/:overrideId', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id: agencyId, overrideId } = req.params;
    const {
      productId,
      overridePercentage,
      overrideAmount,
      overrideType,
      priority,
      effectiveDate,
      terminationDate,
      status,
      description
    } = req.body;
    
    const pool = await getPool();
    const transaction = pool.transaction();
    
    try {
      await transaction.begin();
      const request = transaction.request();
      
      request.input('OverrideId', sql.UniqueIdentifier, overrideId);
      request.input('AgencyId', sql.UniqueIdentifier, agencyId);
      request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      
      // Verify override exists and belongs to agency/tenant
      const overrideCheck = await request.query(`
        SELECT OverrideId, OverrideType FROM oe.AgencyOverrides 
        WHERE OverrideId = @OverrideId 
          AND AgencyId = @AgencyId 
          AND TenantId = @TenantId
      `);
      
      if (overrideCheck.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Override not found or access denied'
        });
      }
      
      const currentOverrideType = overrideCheck.recordset[0].OverrideType;
      const finalOverrideType = overrideType || currentOverrideType;
      
      // Validation
      if (finalOverrideType === 'Percentage' && overridePercentage !== undefined) {
        const percentage = parseFloat(overridePercentage);
        if (isNaN(percentage) || percentage < 0 || percentage > 100) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: 'OverridePercentage must be between 0 and 100'
          });
        }
      }
      
      if (finalOverrideType === 'Fixed' && overrideAmount !== undefined && overrideAmount < 0) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'OverrideAmount must be greater than or equal to 0'
        });
      }
      
      // Build update query
      const updateFields = [];
      const updateRequest = transaction.request();
      updateRequest.input('OverrideId', sql.UniqueIdentifier, overrideId);
      updateRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
      
      if (productId !== undefined) {
        // Verify product exists if specified
        if (productId) {
          const productCheckRequest = transaction.request();
          productCheckRequest.input('ProductId', sql.UniqueIdentifier, productId);
          productCheckRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
          
          const productCheck = await productCheckRequest.query(`
            SELECT ProductId FROM oe.Products 
            WHERE ProductId = @ProductId AND TenantId = @TenantId
          `);
          
          if (productCheck.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({
              success: false,
              message: 'Product not found or access denied'
            });
          }
        }
        
        updateFields.push('ProductId = @ProductId');
        updateRequest.input('ProductId', sql.UniqueIdentifier, productId || null);
      }
      
      if (overrideType !== undefined) {
        updateFields.push('OverrideType = @OverrideType');
        updateRequest.input('OverrideType', sql.NVarChar(20), overrideType);
      }
      
      if (overridePercentage !== undefined) {
        updateFields.push('OverridePercentage = @OverridePercentage');
        updateRequest.input('OverridePercentage', sql.Decimal(5, 2), finalOverrideType === 'Percentage' ? overridePercentage : null);
        
        if (finalOverrideType === 'Fixed') {
          updateFields.push('OverrideAmount = @OverrideAmount');
          updateRequest.input('OverrideAmount', sql.Decimal(10, 2), null);
        }
      }
      
      if (overrideAmount !== undefined) {
        updateFields.push('OverrideAmount = @OverrideAmount');
        updateRequest.input('OverrideAmount', sql.Decimal(10, 2), finalOverrideType === 'Fixed' ? overrideAmount : null);
        
        if (finalOverrideType === 'Percentage') {
          updateFields.push('OverridePercentage = @OverridePercentage');
          updateRequest.input('OverridePercentage', sql.Decimal(5, 2), null);
        }
      }
      
      if (priority !== undefined) {
        updateFields.push('Priority = @Priority');
        updateRequest.input('Priority', sql.Int, priority);
      }
      
      if (effectiveDate !== undefined) {
        updateFields.push('EffectiveDate = @EffectiveDate');
        updateRequest.input('EffectiveDate', sql.Date, effectiveDate || null);
      }
      
      if (terminationDate !== undefined) {
        updateFields.push('TerminationDate = @TerminationDate');
        updateRequest.input('TerminationDate', sql.Date, terminationDate || null);
      }
      
      if (status !== undefined) {
        updateFields.push('Status = @Status');
        updateRequest.input('Status', sql.NVarChar(20), status);
      }
      
      if (description !== undefined) {
        updateFields.push('Description = @Description');
        updateRequest.input('Description', sql.NVarChar(500), description || null);
      }
      
      if (updateFields.length === 0) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'No fields to update'
        });
      }
      
      updateFields.push('ModifiedDate = GETUTCDATE()');
      updateFields.push('ModifiedBy = @ModifiedBy');
      
      await updateRequest.query(`
        UPDATE oe.AgencyOverrides 
        SET ${updateFields.join(', ')}
        WHERE OverrideId = @OverrideId
      `);
      
      await transaction.commit();
      
      logger.info('Agency override updated', {
        overrideId,
        agencyId,
        tenantId: req.user.TenantId,
        modifiedBy: req.user.UserId
      }, 'TenantAdmin');
      
      res.json({
        success: true,
        message: 'Agency override updated successfully'
      });
      
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    
  } catch (error) {
    logger.error('Error updating agency override', {
      error: error.message,
      agencyId: req.params.id,
      overrideId: req.params.overrideId,
      stack: error.stack
    }, 'TenantAdmin');
    
    res.status(500).json({
      success: false,
      message: 'Failed to update agency override',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route DELETE /api/tenant-admin/agencies/:id/overrides/:overrideId
 * @desc Delete an agency override (soft delete)
 * @access TenantAdmin, SysAdmin
 */
router.delete('/agencies/:id/overrides/:overrideId', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id: agencyId, overrideId } = req.params;
    const pool = await getPool();
    const request = pool.request();
    
    request.input('OverrideId', sql.UniqueIdentifier, overrideId);
    request.input('AgencyId', sql.UniqueIdentifier, agencyId);
    request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    request.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
    
    const result = await request.query(`
      UPDATE oe.AgencyOverrides 
      SET Status = 'Deleted',
          ModifiedDate = GETUTCDATE(),
          ModifiedBy = @ModifiedBy
      WHERE OverrideId = @OverrideId 
        AND AgencyId = @AgencyId 
        AND TenantId = @TenantId
        AND Status != 'Deleted'
    `);
    
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Override not found or already deleted'
      });
    }
    
    logger.info('Agency override deleted', {
      overrideId,
      agencyId,
      tenantId: req.user.TenantId,
      deletedBy: req.user.UserId
    }, 'TenantAdmin');
    
    res.json({
      success: true,
      message: 'Agency override deleted successfully'
    });
    
  } catch (error) {
    logger.error('Error deleting agency override', {
      error: error.message,
      agencyId: req.params.id,
      overrideId: req.params.overrideId,
      stack: error.stack
    }, 'TenantAdmin');
    
    res.status(500).json({
      success: false,
      message: 'Failed to delete agency override',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;
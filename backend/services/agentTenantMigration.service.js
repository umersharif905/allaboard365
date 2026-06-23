/**
 * SysAdmin: move an agent subtree from one tenant to another.
 * Only rows scoped to the source tenant and tied to the agent + downline are updated.
 */

const { getPool } = require('../config/database');
const sql = require('mssql');
const CommissionLevelService = require('./commissionLevel.service');

function toIdJson(ids) {
  return JSON.stringify((ids || []).map((id) => String(id)));
}

const columnExistsCache = new Map();

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} tableName e.g. 'AgentOnboardingLinks'
 * @param {string} columnName
 */
async function tableHasColumn(pool, tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  if (columnExistsCache.has(key)) return columnExistsCache.get(key);
  const r = await pool.request()
    .input('tableName', sql.NVarChar, tableName)
    .input('columnName', sql.NVarChar, columnName)
    .query(`
      SELECT 1 AS ok
      FROM sys.columns c
      INNER JOIN sys.tables t ON t.object_id = c.object_id
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = N'oe' AND t.name = @tableName AND c.name = @columnName
    `);
  const row = r.recordset?.[0];
  const exists = row?.ok === 1 || row?.Hit === 1;
  if (process.env.NODE_ENV !== 'test') {
    columnExistsCache.set(key, exists);
  }
  return exists;
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} rootAgentId
 * @returns {Promise<string[]>}
 */
async function getSubtreeAgentIds(pool, rootAgentId) {
  const r = await pool.request()
    .input('rootAgentId', sql.UniqueIdentifier, rootAgentId)
    .query(`
      WITH Subtree AS (
        SELECT @rootAgentId AS AgentId
        UNION ALL
        SELECT ah.AgentId
        FROM oe.AgentHierarchy ah
        INNER JOIN Subtree s ON ah.ParentId = s.AgentId
        WHERE ah.Status = N'Active'
      )
      SELECT DISTINCT s.AgentId
      FROM Subtree s
      INNER JOIN oe.Agents a ON a.AgentId = s.AgentId
    `);
  return (r.recordset || []).map((row) => String(row.AgentId));
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string[]} agentIds
 * @param {string} sourceTenantId
 */
async function getScopedMemberIds(pool, agentIds, sourceTenantId) {
  if (!agentIds.length) return [];
  const r = await pool.request()
    .input('sourceTenantId', sql.UniqueIdentifier, sourceTenantId)
    .input('agentIdsJson', sql.NVarChar(sql.MAX), toIdJson(agentIds))
    .query(`
      SELECT DISTINCT m.MemberId
      FROM oe.Members m
      WHERE m.TenantId = @sourceTenantId
        AND (
          m.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j)
          OR (
            m.HouseholdId IS NOT NULL
            AND m.HouseholdId IN (
              SELECT DISTINCT m2.HouseholdId
              FROM oe.Members m2
              WHERE m2.TenantId = @sourceTenantId
                AND m2.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j)
                AND m2.HouseholdId IS NOT NULL
            )
          )
        )
    `);
  return (r.recordset || []).map((row) => String(row.MemberId));
}

/**
 * @param {object} row
 * @param {Array<object>} targetLevels
 */
function suggestTargetCommissionLevel(row, targetLevels) {
  const levels = targetLevels || [];
  if (!levels.length) return null;

  const sourceLevelId = row.CommissionLevelId ? String(row.CommissionLevelId) : null;
  const sourceName = (row.SourceLevelDisplayName || '').trim().toLowerCase();
  const sourceCode = (row.SourceLevelCode || '').trim().toLowerCase();
  const legacyTier =
    row.SourceLegacyTierLevel != null && Number.isFinite(Number(row.SourceLegacyTierLevel))
      ? Number(row.SourceLegacyTierLevel)
      : row.CommissionTierLevel != null && Number.isFinite(Number(row.CommissionTierLevel))
        ? Number(row.CommissionTierLevel)
        : null;

  if (sourceName) {
    const byName = levels.find(
      (l) => String(l.DisplayName || '').trim().toLowerCase() === sourceName
    );
    if (byName) return String(byName.CommissionLevelId);
  }
  if (sourceCode) {
    const byCode = levels.find(
      (l) => String(l.Code || '').trim().toLowerCase() === sourceCode
    );
    if (byCode) return String(byCode.CommissionLevelId);
  }
  if (legacyTier != null) {
    const byLegacy = levels.find(
      (l) =>
        l.LegacyTierLevel != null && Number(l.LegacyTierLevel) === legacyTier
    );
    if (byLegacy) return String(byLegacy.CommissionLevelId);
    const bySort = levels.find(
      (l) => l.SortOrder != null && Number(l.SortOrder) === legacyTier
    );
    if (bySort) return String(bySort.CommissionLevelId);
  }
  if (sourceLevelId) {
    const byId = levels.find(
      (l) => String(l.CommissionLevelId).toLowerCase() === sourceLevelId.toLowerCase()
    );
    if (byId) return String(byId.CommissionLevelId);
  }
  return null;
}

async function loadSourceAgentCommissionContext(pool, agentId) {
  const r = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .query(`
      SELECT
        a.CommissionLevelId,
        a.CommissionTierLevel,
        cl.DisplayName AS SourceLevelDisplayName,
        cl.Code AS SourceLevelCode,
        cl.LegacyTierLevel AS SourceLegacyTierLevel
      FROM oe.Agents a
      LEFT JOIN oe.CommissionLevels cl ON cl.CommissionLevelId = a.CommissionLevelId
      WHERE a.AgentId = @agentId
    `);
  return r.recordset[0] || null;
}

async function validateTargetCommissionLevel(pool, targetTenantId, targetCommissionLevelId) {
  if (!targetCommissionLevelId) {
    return { ok: false, message: 'Destination agent tier (commission level) is required.' };
  }
  const level = await CommissionLevelService.getCommissionLevelById(
    targetTenantId,
    targetCommissionLevelId
  );
  if (!level) {
    return { ok: false, message: 'Selected commission level is not valid for the destination tenant.' };
  }
  return { ok: true, level };
}

async function validateTargetPlacement(pool, {
  targetTenantId,
  targetAgencyId,
  targetParentAgentId,
  migratingAgentIds
}) {
  if (!targetAgencyId) {
    return { ok: false, message: 'Destination agency is required.' };
  }
  const ar = await pool.request()
    .input('agencyId', sql.UniqueIdentifier, targetAgencyId)
    .input('tenantId', sql.UniqueIdentifier, targetTenantId)
    .query(`
      SELECT AgencyId, AgencyName
      FROM oe.Agencies
      WHERE AgencyId = @agencyId AND TenantId = @tenantId AND Status = N'Active'
    `);
  if (!ar.recordset.length) {
    return { ok: false, message: 'Target agency not found or not active in the destination tenant.' };
  }
  if (targetParentAgentId) {
    if (migratingAgentIds.some((id) => String(id).toLowerCase() === String(targetParentAgentId).toLowerCase())) {
      return { ok: false, message: 'Upline cannot be an agent included in this migration subtree.' };
    }
    const pr = await pool.request()
      .input('parentId', sql.UniqueIdentifier, targetParentAgentId)
      .input('tenantId', sql.UniqueIdentifier, targetTenantId)
      .query(`
        SELECT AgentId FROM oe.Agents
        WHERE AgentId = @parentId AND TenantId = @tenantId AND Status = N'Active'
      `);
    if (!pr.recordset.length) {
      return { ok: false, message: 'Target upline agent not found or not active in the destination tenant.' };
    }
  }
  return { ok: true, agencyName: ar.recordset[0].AgencyName };
}

/**
 * @param {object} params
 * @param {string} params.agentId
 * @param {string} params.targetTenantId
 * @param {string} params.targetAgencyId
 * @param {string|null} [params.targetParentAgentId]
 * @param {string|null} [params.targetCommissionLevelId]
 */
async function buildAgentTenantMigrationPreview({
  agentId,
  targetTenantId,
  targetAgencyId,
  targetParentAgentId = null,
  targetCommissionLevelId = null
}) {
  const pool = await getPool();
  const linkHasTenantId = await tableHasColumn(pool, 'AgentOnboardingLinks', 'TenantId');
  const hierarchyHasTenantId = await tableHasColumn(pool, 'AgentHierarchy', 'TenantId');
  const enrollmentsHasTenantId = await tableHasColumn(pool, 'Enrollments', 'TenantId');

  const agentRow = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .query(`
      SELECT a.AgentId, a.UserId, a.TenantId, a.AgencyId, a.AgentCode,
             a.CommissionRuleId, a.CommissionGroupId, a.CommissionLevelId,
             a.CommissionTierLevel,
             u.Email, u.FirstName, u.LastName,
             t.Name AS TenantName
      FROM oe.Agents a
      INNER JOIN oe.Users u ON u.UserId = a.UserId
      INNER JOIN oe.Tenants t ON t.TenantId = a.TenantId
      WHERE a.AgentId = @agentId
    `);
  const agent = agentRow.recordset[0];
  if (!agent) {
    return { ok: false, message: 'Agent not found' };
  }
  const sourceTenantId = String(agent.TenantId);
  if (sourceTenantId.toLowerCase() === String(targetTenantId).toLowerCase()) {
    return { ok: false, message: 'Agent is already in the destination tenant.' };
  }

  const targetTenantRow = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, targetTenantId)
    .query(`SELECT TenantId, Name, Status FROM oe.Tenants WHERE TenantId = @tenantId`);
  const targetTenant = targetTenantRow.recordset[0];
  if (!targetTenant || targetTenant.Status !== 'Active') {
    return { ok: false, message: 'Destination tenant not found or not active.' };
  }

  const sourceCommissionCtx = await loadSourceAgentCommissionContext(pool, agentId);
  const targetCommissionLevels = await CommissionLevelService.listTenantLevels(targetTenantId);
  const suggestedTargetCommissionLevelId = suggestTargetCommissionLevel(
    { ...agent, ...sourceCommissionCtx },
    targetCommissionLevels
  );

  const resolvedTargetLevelId = targetCommissionLevelId || suggestedTargetCommissionLevelId;
  const targetLevelMeta = resolvedTargetLevelId
    ? targetCommissionLevels.find(
        (l) => String(l.CommissionLevelId).toLowerCase() === String(resolvedTargetLevelId).toLowerCase()
      )
    : null;

  const subtreeAgentIds = await getSubtreeAgentIds(pool, agentId);

  if (targetAgencyId) {
    const placement = await validateTargetPlacement(pool, {
      targetTenantId,
      targetAgencyId,
      targetParentAgentId,
      migratingAgentIds: subtreeAgentIds
    });
    if (!placement.ok) return { ok: false, message: placement.message };
  }

  if (targetAgencyId && targetCommissionLevelId) {
    const levelCheck = await validateTargetCommissionLevel(
      pool,
      targetTenantId,
      targetCommissionLevelId
    );
    if (!levelCheck.ok) return { ok: false, message: levelCheck.message };
  }

  const memberIds = await getScopedMemberIds(pool, subtreeAgentIds, sourceTenantId);
  const agentIdsJson = toIdJson(subtreeAgentIds);
  const memberIdsJson = toIdJson(memberIds);

  const onboardingLinksSql = linkHasTenantId
    ? `(SELECT COUNT(*) FROM oe.AgentOnboardingLinks l
        WHERE l.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j)
          AND l.TenantId = @sourceTenantId)`
    : `(SELECT COUNT(*) FROM oe.AgentOnboardingLinks l
        INNER JOIN oe.Agents a ON a.AgentId = l.AgentId AND a.TenantId = @sourceTenantId
        WHERE l.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j))`;

  const enrollmentsTenantFilter = enrollmentsHasTenantId
    ? 'e.TenantId = @sourceTenantId'
    : 'm.TenantId = @sourceTenantId';

  const countsReq = pool.request()
    .input('sourceTenantId', sql.UniqueIdentifier, sourceTenantId)
    .input('targetTenantId', sql.UniqueIdentifier, targetTenantId)
    .input('agentIdsJson', sql.NVarChar(sql.MAX), agentIdsJson)
    .input('memberIdsJson', sql.NVarChar(sql.MAX), memberIdsJson);

  const countsResult = await countsReq.query(`
    SELECT
      (SELECT COUNT(*) FROM OPENJSON(@agentIdsJson)) AS agents,
      (SELECT COUNT(DISTINCT a.UserId) FROM oe.Agents a
        WHERE a.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j)) AS agentUsers,
      (SELECT COUNT(*) FROM OPENJSON(@memberIdsJson)) AS members,
      (SELECT COUNT(DISTINCT m.HouseholdId) FROM oe.Members m
        WHERE m.MemberId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@memberIdsJson) j)
          AND m.HouseholdId IS NOT NULL) AS households,
      (SELECT COUNT(*) FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.MemberId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@memberIdsJson) j)
          AND ${enrollmentsTenantFilter}
          AND (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)) AS enrollments,
      (SELECT COUNT(*) FROM oe.Groups g
        WHERE g.TenantId = @sourceTenantId
          AND g.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j)) AS groups,
      (SELECT COUNT(*) FROM oe.AgentHierarchy h
        WHERE h.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j)) AS hierarchyRows,
      ${onboardingLinksSql} AS onboardingLinks,
      (SELECT COUNT(*) FROM oe.EnrollmentLinkTemplates t
        WHERE t.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j)
          AND t.TenantId = @sourceTenantId) AS enrollmentLinkTemplates
  `);
  const counts = countsResult.recordset[0] || {};

  const blockingProductsResult = await countsReq.query(`
    SELECT DISTINCT p.ProductId, p.Name AS ProductName
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    INNER JOIN oe.Products p ON e.ProductId = p.ProductId
    WHERE m.MemberId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@memberIdsJson) j)
      AND ${enrollmentsTenantFilter}
      AND (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)
      AND e.Status = N'Active'
      AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
      AND NOT EXISTS (
        SELECT 1 FROM oe.TenantProductSubscriptions tps
        WHERE tps.TenantId = @targetTenantId
          AND tps.ProductId = e.ProductId
          AND tps.SubscriptionStatus = N'Active'
      )
    ORDER BY p.Name
  `);
  const blockingProducts = (blockingProductsResult.recordset || []).map((row) => ({
    productId: String(row.ProductId),
    productName: row.ProductName || 'Product'
  }));

  const sourceLevelName =
    sourceCommissionCtx?.SourceLevelDisplayName ||
    (agent.CommissionTierLevel != null
      ? CommissionLevelService.getLegacyLabel(Number(agent.CommissionTierLevel))
      : null);

  const warnings = [];
  if (!targetAgencyId) {
    warnings.push('Select a destination agency (required).');
  }
  if (!resolvedTargetLevelId) {
    warnings.push('Select an agent tier for the destination tenant (required).');
  } else if (!targetCommissionLevelId && suggestedTargetCommissionLevelId) {
    warnings.push(
      `Suggested destination tier: ${targetLevelMeta?.DisplayName || 'matched level'} (confirm or change).`
    );
  }
  if (agent.CommissionRuleId || agent.CommissionGroupId) {
    warnings.push('Commission group/rule on the root agent are not auto-reassigned — review after migration.');
  }
  if (subtreeAgentIds.length > 1) {
    warnings.push(
      'Downline agents keep their current commission levels; only the migrating root agent tier is updated here.'
    );
  }
  if (blockingProducts.length) {
    warnings.push(
      `${blockingProducts.length} active enrollment product(s) are not subscribed by the destination tenant. Migration is blocked.`
    );
  }
  if (Number(counts.onboardingLinks) > 0) {
    warnings.push(
      `${counts.onboardingLinks} agent onboarding link(s) will move to the destination tenant with the selected agency (root agent links). Review commission codes on those links after migration.`
    );
  }

  const placementComplete = !!(targetAgencyId && resolvedTargetLevelId);
  const canExecute =
    placementComplete &&
    blockingProducts.length === 0 &&
    (!targetCommissionLevelId || !!targetLevelMeta);

  return {
    ok: true,
    canExecute,
    agent: {
      agentId: String(agent.AgentId),
      userId: String(agent.UserId),
      email: agent.Email,
      name: `${agent.FirstName || ''} ${agent.LastName || ''}`.trim(),
      agentCode: agent.AgentCode,
      sourceTenantId,
      sourceTenantName: agent.TenantName
    },
    targetTenant: {
      tenantId: String(targetTenant.TenantId),
      name: targetTenant.Name
    },
    commission: {
      source: {
        commissionLevelId: agent.CommissionLevelId ? String(agent.CommissionLevelId) : null,
        displayName: sourceLevelName,
        legacyTierLevel:
          sourceCommissionCtx?.SourceLegacyTierLevel != null
            ? Number(sourceCommissionCtx.SourceLegacyTierLevel)
            : agent.CommissionTierLevel != null
              ? Number(agent.CommissionTierLevel)
              : null
      },
      targetLevels: targetCommissionLevels.map((l) => ({
        commissionLevelId: String(l.CommissionLevelId),
        displayName: l.DisplayName,
        code: l.Code,
        sortOrder: l.SortOrder,
        legacyTierLevel: l.LegacyTierLevel
      })),
      suggestedTargetCommissionLevelId,
      selectedTargetCommissionLevelId: resolvedTargetLevelId,
      selectedTargetDisplayName: targetLevelMeta?.DisplayName || null,
      requiresSelection: !suggestedTargetCommissionLevelId
    },
    subtreeAgentCount: subtreeAgentIds.length,
    counts: {
      agents: Number(counts.agents) || 0,
      agentUsers: Number(counts.agentUsers) || 0,
      members: Number(counts.members) || 0,
      households: Number(counts.households) || 0,
      enrollments: Number(counts.enrollments) || 0,
      groups: Number(counts.groups) || 0,
      hierarchyRows: Number(counts.hierarchyRows) || 0,
      onboardingLinks: Number(counts.onboardingLinks) || 0,
      enrollmentLinkTemplates: Number(counts.enrollmentLinkTemplates) || 0
    },
    blockingProducts,
    warnings,
    placement: {
      targetAgencyId: targetAgencyId || null,
      targetParentAgentId: targetParentAgentId || null,
      targetCommissionLevelId: resolvedTargetLevelId || null
    },
    schemaHints: {
      onboardingLinksHasTenantId: linkHasTenantId,
      hierarchyHasTenantId,
      enrollmentsHasTenantId
    }
  };
}

/**
 * @param {object} params
 * @param {string} params.agentId
 * @param {string} params.targetTenantId
 * @param {string} params.targetAgencyId
 * @param {string|null} [params.targetParentAgentId]
 * @param {string} params.targetCommissionLevelId
 * @param {string} [params.executedBy]
 */
async function executeAgentTenantMigration({
  agentId,
  targetTenantId,
  targetAgencyId,
  targetParentAgentId = null,
  targetCommissionLevelId,
  executedBy = null
}) {
  if (!targetAgencyId) {
    return { ok: false, message: 'Destination agency is required.' };
  }
  if (!targetCommissionLevelId) {
    return { ok: false, message: 'Destination agent tier (commission level) is required.' };
  }

  const preview = await buildAgentTenantMigrationPreview({
    agentId,
    targetTenantId,
    targetAgencyId,
    targetParentAgentId,
    targetCommissionLevelId
  });
  if (!preview.ok) return preview;
  if (!preview.canExecute) {
    return {
      ok: false,
      message: preview.blockingProducts?.length
        ? 'Migration blocked: destination tenant does not subscribe to one or more enrolled products.'
        : 'Migration blocked: complete placement (agency and agent tier) before executing.',
      blockingProducts: preview.blockingProducts
    };
  }

  const pool = await getPool();
  const linkHasTenantId = await tableHasColumn(pool, 'AgentOnboardingLinks', 'TenantId');
  const hierarchyHasTenantId = await tableHasColumn(pool, 'AgentHierarchy', 'TenantId');
  const enrollmentsHasTenantId = await tableHasColumn(pool, 'Enrollments', 'TenantId');

  const levelRow = await CommissionLevelService.getCommissionLevelById(
    targetTenantId,
    targetCommissionLevelId
  );
  const targetTierLevel =
    levelRow?.LegacyTierLevel != null && Number.isFinite(Number(levelRow.LegacyTierLevel))
      ? Number(levelRow.LegacyTierLevel)
      : levelRow?.SortOrder != null && Number.isFinite(Number(levelRow.SortOrder))
        ? Number(levelRow.SortOrder)
        : 0;

  const sourceTenantId = preview.agent.sourceTenantId;
  const subtreeAgentIds = await getSubtreeAgentIds(pool, agentId);
  const memberIds = await getScopedMemberIds(pool, subtreeAgentIds, sourceTenantId);
  const agentIdsJson = toIdJson(subtreeAgentIds);
  const memberIdsJson = toIdJson(memberIds);

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const req = () => new sql.Request(transaction);

    const bindCommon = (request) => request
      .input('sourceTenantId', sql.UniqueIdentifier, sourceTenantId)
      .input('targetTenantId', sql.UniqueIdentifier, targetTenantId)
      .input('agentIdsJson', sql.NVarChar(sql.MAX), agentIdsJson)
      .input('memberIdsJson', sql.NVarChar(sql.MAX), memberIdsJson)
      .input('rootAgentId', sql.UniqueIdentifier, agentId);

    await bindCommon(req()).query(`
      UPDATE u SET u.TenantId = @targetTenantId, u.ModifiedDate = SYSUTCDATETIME()
      FROM oe.Users u
      INNER JOIN oe.Agents a ON a.UserId = u.UserId
      WHERE a.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j)
    `);

    await bindCommon(req()).query(`
      UPDATE u SET u.TenantId = @targetTenantId, u.ModifiedDate = SYSUTCDATETIME()
      FROM oe.Users u
      INNER JOIN oe.Members m ON m.UserId = u.UserId
      WHERE m.MemberId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@memberIdsJson) j)
    `);

    await bindCommon(req())
      .input('targetAgencyId', sql.UniqueIdentifier, targetAgencyId)
      .input('targetCommissionLevelId', sql.UniqueIdentifier, targetCommissionLevelId)
      .input('targetTierLevel', sql.Int, targetTierLevel)
      .query(`
        UPDATE a SET
          a.TenantId = @targetTenantId,
          a.AgencyId = CASE
            WHEN a.AgentId = @rootAgentId THEN @targetAgencyId
            WHEN a.AgencyId IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM oe.Agencies ag WHERE ag.AgencyId = a.AgencyId AND ag.TenantId = @targetTenantId
            ) THEN NULL
            ELSE a.AgencyId
          END,
          a.CommissionLevelId = CASE WHEN a.AgentId = @rootAgentId THEN @targetCommissionLevelId ELSE a.CommissionLevelId END,
          a.CommissionTierLevel = CASE WHEN a.AgentId = @rootAgentId THEN @targetTierLevel ELSE a.CommissionTierLevel END,
          a.ModifiedDate = SYSUTCDATETIME()
        FROM oe.Agents a
        WHERE a.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j)
      `);

    await bindCommon(req()).query(`
      UPDATE m SET m.TenantId = @targetTenantId, m.ModifiedDate = SYSUTCDATETIME()
      FROM oe.Members m
      WHERE m.MemberId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@memberIdsJson) j)
    `);

    if (enrollmentsHasTenantId) {
      await bindCommon(req()).query(`
        UPDATE e SET e.TenantId = @targetTenantId, e.ModifiedDate = SYSUTCDATETIME()
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.MemberId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@memberIdsJson) j)
          AND e.TenantId = @sourceTenantId
      `);
    } else {
      await bindCommon(req()).query(`
        UPDATE e SET e.ModifiedDate = SYSUTCDATETIME()
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.MemberId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@memberIdsJson) j)
          AND m.TenantId = @sourceTenantId
      `);
    }

    await bindCommon(req()).query(`
      UPDATE g SET g.TenantId = @targetTenantId, g.ModifiedDate = SYSUTCDATETIME()
      FROM oe.Groups g
      WHERE g.TenantId = @sourceTenantId
        AND g.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j)
    `);

    if (hierarchyHasTenantId) {
      await bindCommon(req())
        .input('targetAgencyId', sql.UniqueIdentifier, targetAgencyId)
        .query(`
          UPDATE h SET
            h.TenantId = @targetTenantId,
            h.AgencyId = CASE
              WHEN h.AgentId = @rootAgentId THEN @targetAgencyId
              WHEN h.AgencyId IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM oe.Agencies ag WHERE ag.AgencyId = h.AgencyId AND ag.TenantId = @targetTenantId
              ) THEN NULL
              ELSE h.AgencyId
            END,
            h.ModifiedDate = SYSUTCDATETIME()
          FROM oe.AgentHierarchy h
          WHERE h.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j)
        `);
    }

    if (targetParentAgentId) {
      await bindCommon(req())
        .input('targetParentAgentId', sql.UniqueIdentifier, targetParentAgentId)
        .query(`
          UPDATE h SET h.ParentId = @targetParentAgentId, h.ModifiedDate = SYSUTCDATETIME()
          FROM oe.AgentHierarchy h
          WHERE h.AgentId = @rootAgentId
        `);
    }

    // Re-point onboarding links (TenantId + AgencyId) — same pattern as tenant-admin agency cascade.
    if (linkHasTenantId) {
      await bindCommon(req())
        .input('targetAgencyId', sql.UniqueIdentifier, targetAgencyId)
        .query(`
          UPDATE l SET
            l.TenantId = @targetTenantId,
            l.AgencyId = CASE
              WHEN l.AgentId = @rootAgentId THEN @targetAgencyId
              WHEN l.AgencyId IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM oe.Agencies ag WHERE ag.AgencyId = l.AgencyId AND ag.TenantId = @targetTenantId
              ) THEN NULL
              ELSE l.AgencyId
            END,
            l.ModifiedDate = SYSUTCDATETIME()
          FROM oe.AgentOnboardingLinks l
          WHERE l.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j)
            AND l.TenantId = @sourceTenantId
        `);
    } else {
      await bindCommon(req())
        .input('targetAgencyId', sql.UniqueIdentifier, targetAgencyId)
        .query(`
          UPDATE l SET
            l.AgencyId = CASE
              WHEN l.AgentId = @rootAgentId THEN @targetAgencyId
              WHEN l.AgencyId IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM oe.Agencies ag WHERE ag.AgencyId = l.AgencyId AND ag.TenantId = @targetTenantId
              ) THEN NULL
              ELSE l.AgencyId
            END,
            l.ModifiedDate = SYSUTCDATETIME()
          FROM oe.AgentOnboardingLinks l
          WHERE l.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j)
        `);
    }

    await bindCommon(req()).query(`
      UPDATE t SET t.TenantId = @targetTenantId, t.ModifiedDate = SYSUTCDATETIME()
      FROM oe.EnrollmentLinkTemplates t
      WHERE t.AgentId IN (SELECT CAST(j.value AS UNIQUEIDENTIFIER) FROM OPENJSON(@agentIdsJson) j)
        AND t.TenantId = @sourceTenantId
    `);

    await transaction.commit();
    return {
      ok: true,
      message: 'Agent subtree migrated successfully.',
      counts: preview.counts,
      agent: preview.agent,
      targetTenant: preview.targetTenant,
      commission: preview.commission,
      executedBy
    };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

module.exports = {
  buildAgentTenantMigrationPreview,
  executeAgentTenantMigration,
  getSubtreeAgentIds,
  getScopedMemberIds,
  suggestTargetCommissionLevel,
  tableHasColumn
};

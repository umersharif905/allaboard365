'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql, getPool } = require('../../config/database');
const migrationStatus = require('./migrationStatus.service');
const migrationInstance = require('./migrationInstance.service');
const { pickHouseholdE123BrokerId } = require('./migrationAgentResolver.service');
const sharewellAgents = require('./sharewellAgents.service');
const { resolveBrokerLabels } = require('./migrationAgentMapping.service');

function isIncludedInImport(value) {
  return value === true || value === 1;
}

async function attachE123AgentLabels(rows, instanceId = null) {
  if (!rows?.length) return rows;
  const brokerIds = rows.map((row) => pickHouseholdE123BrokerId(row));
  const labels = await resolveBrokerLabels(brokerIds, instanceId);
  return rows.map((row) => {
    const e123AgentBrokerId = pickHouseholdE123BrokerId(row);
    return {
      ...row,
      e123AgentBrokerId,
      e123AgentName: e123AgentBrokerId ? (labels.get(e123AgentBrokerId) || `Broker ${e123AgentBrokerId}`) : null
    };
  });
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function getBatch(batchId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`SELECT * FROM oe.MigrationImportBatch WHERE BatchId = @batchId`);
  return result.recordset?.[0] || null;
}

async function getBatchDetail(batchId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT b.*, t.Name AS TenantName
      FROM oe.MigrationImportBatch b
      LEFT JOIN oe.Tenants t ON t.TenantId = b.TenantId
      WHERE b.BatchId = @batchId
    `);
  const row = result.recordset?.[0];
  if (!row) return null;
  const [enriched] = await attachBatchRootLabels([row], row.InstanceId);
  return enriched;
}

async function createBatch({ rootBrokerId, rootAgentLabel, includeDownline, createdBy, instanceId = null }) {
  const pool = await getPool();
  const batchId = uuidv4();
  await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .input('rootBrokerId', sql.Int, rootBrokerId)
    .input('rootAgentLabel', sql.NVarChar, rootAgentLabel || null)
    .input('includeDownline', sql.Bit, includeDownline ? 1 : 0)
    .input('createdBy', sql.UniqueIdentifier, createdBy || null)
    .input('instanceId', sql.UniqueIdentifier, instanceId || null)
    .query(`
      INSERT INTO oe.MigrationImportBatch (
        BatchId, RootBrokerId, RootAgentLabel, IncludeDownline, Status, CreatedBy, InstanceId
      ) VALUES (
        @batchId, @rootBrokerId, @rootAgentLabel, @includeDownline, 'draft', @createdBy, @instanceId
      )
    `);
  return getBatch(batchId);
}

async function updateBatch(batchId, fields, { lockTimeoutMs = null } = {}) {
  const pool = await getPool();
  const sets = [];
  const request = pool.request().input('batchId', sql.UniqueIdentifier, batchId);

  const allowed = [
    'WizardStep', 'TenantId', 'Status', 'FetchPagesCompleted', 'FetchMembersLoaded',
    'FetchLastUserId', 'FetchError', 'ApplyProcessed', 'ApplyTotal', 'ApplyCreateCount',
    'ApplySkipCount', 'ApplyErrorCount', 'SummaryJson', 'RootAgentLabel'
  ];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      const param = `p_${key}`;
      sets.push(`${key} = @${param}`);
      if (key === 'TenantId') request.input(param, sql.UniqueIdentifier, fields[key]);
      else if (['WizardStep', 'FetchPagesCompleted', 'FetchMembersLoaded', 'FetchLastUserId',
        'ApplyProcessed', 'ApplyTotal', 'ApplyCreateCount', 'ApplySkipCount', 'ApplyErrorCount'].includes(key)) {
        request.input(param, sql.Int, fields[key]);
      } else request.input(param, sql.NVarChar(sql.MAX), fields[key] == null ? null : String(fields[key]));
    }
  }

  if (sets.length === 0) return getBatch(batchId);
  sets.push('ModifiedUtc = SYSUTCDATETIME()');
  const lockPrefix = lockTimeoutMs != null ? `SET LOCK_TIMEOUT ${Math.max(0, Number(lockTimeoutMs) || 0)};` : '';
  await request.query(`${lockPrefix} UPDATE oe.MigrationImportBatch SET ${sets.join(', ')} WHERE BatchId = @batchId`);
  return getBatch(batchId);
}

/** Retry batch row updates when another session briefly holds the row lock (common on prod Azure SQL). */
async function updateBatchWithRetry(batchId, fields, {
  retries = 10,
  delayMs = 2000,
  lockTimeoutMs = 15000
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await updateBatch(batchId, fields, { lockTimeoutMs });
    } catch (err) {
      lastError = err;
      if (!isLockTimeoutError(err) || attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function clearBatchHouseholds(batchId) {
  const pool = await getPool();
  await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`DELETE FROM oe.MigrationImportBatchHousehold WHERE BatchId = @batchId`);
}

async function insertBatchHouseholds(batchId, households, { onProgress } = {}) {
  const pool = await getPool();
  const chunkSize = 40;
  const total = households.length;

  for (let offset = 0; offset < total; offset += chunkSize) {
    const chunk = households.slice(offset, offset + chunkSize);
    const request = pool.request();
    request.input('batchId', sql.UniqueIdentifier, batchId);

    const valueRows = chunk.map((hh, idx) => {
      const p = `h${idx}`;
      request.input(`${p}Id`, sql.UniqueIdentifier, uuidv4());
      request.input(`${p}E123`, sql.Int, hh.e123UserId || null);
      request.input(`${p}Hmid`, sql.NVarChar, hh.householdMemberId);
      request.input(`${p}Json`, sql.NVarChar(sql.MAX), JSON.stringify(hh));
      return `(@${p}Id, @batchId, @${p}E123, @${p}Hmid, @${p}Json, 1)`;
    });

    await request.query(`
      INSERT INTO oe.MigrationImportBatchHousehold (
        BatchHouseholdId, BatchId, E123UserId, HouseholdMemberID, HouseholdJson, IncludedInImport
      ) VALUES ${valueRows.join(',\n')}
    `);

    if (typeof onProgress === 'function') {
      await onProgress(Math.min(offset + chunk.length, total), total);
    }
  }
}

async function countBatchHouseholds(batchId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`SELECT COUNT(*) AS cnt FROM oe.MigrationImportBatchHousehold WHERE BatchId = @batchId`);
  return result.recordset?.[0]?.cnt || 0;
}

async function listBatchHouseholds(batchId, { page = 1, pageSize = 50, includedOnly = false } = {}) {
  const pool = await getPool();
  const offset = (Math.max(1, page) - 1) * pageSize;
  const includedFilter = includedOnly ? 'AND IncludedInImport = 1' : '';
  const result = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .input('offset', sql.Int, offset)
    .input('pageSize', sql.Int, pageSize)
    .query(`
      SELECT BatchHouseholdId, E123UserId, HouseholdMemberID, HouseholdJson,
        PreviewAction, PreviewMessage, Applied, IncludedInImport
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId ${includedFilter}
      ORDER BY HouseholdMemberID
      OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
    `);
  return (result.recordset || []).map((row) => ({
    ...row,
    household: JSON.parse(row.HouseholdJson)
  }));
}

async function attachBatchRootLabels(rows, instanceId = null) {
  if (!rows?.length) return rows;
  const brokerIds = rows.map((row) => row.RootBrokerId);
  const effectiveInstanceId = instanceId || rows.find((row) => row.InstanceId)?.InstanceId || null;
  const labels = await resolveBrokerLabels(brokerIds, effectiveInstanceId);
  return rows.map((row) => {
    const stored = String(row.RootAgentLabel || '').trim();
    const brokerId = Number(row.RootBrokerId);
    const resolved = Number.isFinite(brokerId) ? labels.get(brokerId) : null;
    let displayRootAgentLabel = stored;
    if (!stored || /^Broker \d+$/i.test(stored)) {
      if (resolved && !/^Broker \d+$/i.test(resolved)) {
        displayRootAgentLabel = resolved;
      } else if (stored) {
        displayRootAgentLabel = stored;
      } else if (brokerId) {
        displayRootAgentLabel = resolved || `Broker ${brokerId}`;
      }
    }
    return { ...row, displayRootAgentLabel };
  });
}

const DISCARDABLE_BATCH_STATUSES = new Set(['draft', 'fetching', 'ready', 'failed']);

async function discardBatch(batchId, { force = false } = {}) {
  const batch = await getBatch(batchId);
  if (!batch) {
    const err = new Error('Batch not found');
    err.status = 404;
    throw err;
  }
  if (batch.Status === 'discarded') return batch;
  if (batch.Status === 'applied') {
    const err = new Error('Completed imports cannot be removed from history');
    err.status = 409;
    throw err;
  }
  if (batch.Status === 'applying') {
    if (!force) {
      const err = new Error('Import is still applying. Release the apply lock first, or confirm force remove.');
      err.status = 409;
      throw err;
    }
  } else if (!DISCARDABLE_BATCH_STATUSES.has(batch.Status)) {
    const err = new Error(`Cannot remove import in status "${batch.Status}"`);
    err.status = 409;
    throw err;
  }

  return updateBatch(batchId, { Status: 'discarded' });
}

async function listHistory(limit = 50, instanceId = null, tenantId = null) {
  const pool = await getPool();
  const result = await pool.request()
    .input('limit', sql.Int, limit)
    .input('instanceId', sql.UniqueIdentifier, instanceId || null)
    .input('tenantId', sql.UniqueIdentifier, tenantId || null)
    .query(`
      SELECT TOP (@limit) b.*, t.Name AS TenantName
      FROM oe.MigrationImportBatch b
      LEFT JOIN oe.Tenants t ON t.TenantId = b.TenantId
      WHERE (@instanceId IS NULL OR b.InstanceId = @instanceId)
        AND (@tenantId IS NULL OR b.TenantId = @tenantId)
      ORDER BY b.CreatedUtc DESC
    `);
  return attachBatchRootLabels(result.recordset || [], instanceId);
}

async function listPendingMembers(limit = 100, instanceId = null, tenantId = null) {
  const pool = await getPool();
  const result = await pool.request()
    .input('limit', sql.Int, limit)
    .input('instanceId', sql.UniqueIdentifier, instanceId || null)
    .input('tenantId', sql.UniqueIdentifier, tenantId || null)
    .query(`
      SELECT TOP (@limit)
        m.MemberId, m.HouseholdMemberID, u.FirstName, u.LastName, m.TenantId,
        t.Name AS TenantName, m.MigrationSourceSystem, m.CreatedDate
      FROM oe.Members m
      INNER JOIN oe.Users u ON u.UserId = m.UserId
      INNER JOIN oe.Tenants t ON t.TenantId = m.TenantId
      WHERE m.IsPendingMigration = 1 AND m.RelationshipType = 'P'
        AND (@tenantId IS NULL OR m.TenantId = @tenantId)
        AND (
          @instanceId IS NULL
          OR m.TenantId IN (
            SELECT TenantId FROM oe.MigrationInstanceTenant WHERE InstanceId = @instanceId
          )
        )
      ORDER BY m.CreatedDate DESC
    `);
  return result.recordset || [];
}

async function deselectAlreadyMigratedHouseholds(batchId) {
  const pool = await getPool();
  const rows = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT BatchHouseholdId, HouseholdMemberID
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId
    `);

  const memberIds = (rows.recordset || []).map((row) => row.HouseholdMemberID);
  const locked = await migrationStatus.getLockedHouseholdMemberIds(memberIds);
  if (!locked.size) return 0;

  for (const row of rows.recordset || []) {
    if (!locked.has(row.HouseholdMemberID)) continue;
    await pool.request()
      .input('id', sql.UniqueIdentifier, row.BatchHouseholdId)
      .query(`UPDATE oe.MigrationImportBatchHousehold SET IncludedInImport = 0 WHERE BatchHouseholdId = @id`);
  }

  return locked.size;
}

async function deselectPendingMigrationHouseholds(batchId) {
  const pool = await getPool();
  const rows = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT BatchHouseholdId, HouseholdMemberID
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId AND IncludedInImport = 1
    `);

  const memberIds = (rows.recordset || []).map((row) => row.HouseholdMemberID);
  if (!memberIds.length) return 0;

  const states = await migrationStatus.classifyHouseholdMigrationStates(memberIds);
  let deselectedCount = 0;

  for (const row of rows.recordset || []) {
    if (states.get(row.HouseholdMemberID)?.state !== 'pending_update') continue;
    await pool.request()
      .input('id', sql.UniqueIdentifier, row.BatchHouseholdId)
      .query(`UPDATE oe.MigrationImportBatchHousehold SET IncludedInImport = 0 WHERE BatchHouseholdId = @id`);
    deselectedCount += 1;
  }

  return deselectedCount;
}

async function releaseApplyLock(batchId) {
  return forceReleaseApplyLock(batchId, { requireApplying: true, returnBatch: true });
}

function isLockTimeoutError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('lock request time out') || msg.includes('timeout period exceeded');
}

/** Force-clear applying lock (used before retry). Retries when another session still holds the row. */
async function forceReleaseApplyLock(batchId, {
  retries = 3,
  delayMs = 500,
  requireApplying = false,
  returnBatch = false,
  lockTimeoutMs = 2000
} = {}) {
  const pool = await getPool();
  let lastError = null;
  const whereClause = requireApplying
    ? `WHERE BatchId = @batchId AND Status = N'applying'`
    : `WHERE BatchId = @batchId`;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const request = pool.request().input('batchId', sql.UniqueIdentifier, batchId);

      if (returnBatch) {
        const result = await request.query(`
          SET LOCK_TIMEOUT ${Math.max(0, Number(lockTimeoutMs) || 0)};
          UPDATE oe.MigrationImportBatch
          SET Status = N'ready',
              ApplyProcessed = 0,
              ApplyErrorCount = 0,
              ModifiedUtc = SYSUTCDATETIME()
          ${whereClause};
          SELECT * FROM oe.MigrationImportBatch WHERE BatchId = @batchId;
        `);
        const batch = result.recordset?.[0] || null;
        if (!batch) throw new Error('Batch not found');
        return batch;
      }

      await request.query(`
        SET LOCK_TIMEOUT ${Math.max(0, Number(lockTimeoutMs) || 0)};
        UPDATE oe.MigrationImportBatch
        SET Status = N'ready',
            ApplyProcessed = 0,
            ApplyErrorCount = 0,
            ModifiedUtc = SYSUTCDATETIME()
        ${whereClause};
      `);
      return undefined;
    } catch (err) {
      lastError = err;
      if (!isLockTimeoutError(err) || attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    'Could not unlock migration batch — another session is holding a database lock. '
    + 'Run sql-changes/2026-05-23-unstick-migration-batch-mcguinness.sql or kill the blocking session. '
    + `(${lastError?.message || 'lock timeout'})`
  );
}

async function getBatchSelectionSummary(batchId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT
        COUNT(*) AS totalCount,
        SUM(CASE WHEN IncludedInImport = 1 THEN 1 ELSE 0 END) AS selectedCount
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId
    `);

  const memberRows = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`SELECT HouseholdMemberID FROM oe.MigrationImportBatchHousehold WHERE BatchId = @batchId`);

  const memberIds = (memberRows.recordset || []).map((row) => row.HouseholdMemberID);
  const states = await migrationStatus.classifyHouseholdMigrationStates(memberIds);
  let lockedCount = 0;
  let pendingUpdateCount = 0;
  for (const info of states.values()) {
    if (info.state === 'locked') lockedCount += 1;
    if (info.state === 'pending_update') pendingUpdateCount += 1;
  }

  const selectedMemberRows = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT HouseholdMemberID
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId AND IncludedInImport = 1
    `);

  const selectedMemberIds = (selectedMemberRows.recordset || []).map((row) => row.HouseholdMemberID);
  let selectedNewCount = 0;
  let selectedPendingCount = 0;
  for (const id of selectedMemberIds) {
    const state = states.get(id)?.state || 'new';
    if (state === 'new') selectedNewCount += 1;
    else if (state === 'pending_update') selectedPendingCount += 1;
  }

  const row = result.recordset?.[0] || {};

  return {
    totalCount: row.totalCount || 0,
    selectedCount: selectedNewCount + selectedPendingCount,
    selectedNewCount,
    selectedPendingCount,
    alreadyMigratedCount: lockedCount,
    lockedCount,
    pendingUpdateCount
  };
}

async function updateHouseholdSelection(batchId, { batchHouseholdIds, included, all, search = '' } = {}) {
  const pool = await getPool();
  const includedBit = included ? 1 : 0;
  const searchTerm = search ? `%${String(search).trim()}%` : null;

  if (all) {
    const listReq = pool.request().input('batchId', sql.UniqueIdentifier, batchId);
    let listSql = `
      SELECT BatchHouseholdId, HouseholdMemberID
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId
    `;
    if (searchTerm) {
      listReq.input('search', sql.NVarChar, searchTerm);
      listSql += ` AND (HouseholdMemberID LIKE @search OR HouseholdJson LIKE @search)`;
    }
    const listRes = await listReq.query(listSql);
    const locked = await migrationStatus.getLockedHouseholdMemberIds(
      (listRes.recordset || []).map((row) => row.HouseholdMemberID)
    );
    const targetIds = (listRes.recordset || [])
      .filter((row) => (included ? !locked.has(row.HouseholdMemberID) : true))
      .map((row) => row.BatchHouseholdId);

    if (targetIds.length) {
      await updateHouseholdSelection(batchId, { batchHouseholdIds: targetIds, included });
    }
  } else if (batchHouseholdIds?.length) {
    for (const chunk of chunkArray(batchHouseholdIds, 400)) {
      const request = pool.request()
        .input('batchId', sql.UniqueIdentifier, batchId)
        .input('included', sql.Bit, includedBit);
      const placeholders = chunk.map((id, index) => {
        const param = `id${index}`;
        request.input(param, sql.UniqueIdentifier, id);
        return `@${param}`;
      }).join(', ');
      await request.query(`
        UPDATE oe.MigrationImportBatchHousehold
        SET IncludedInImport = @included
        WHERE BatchId = @batchId AND BatchHouseholdId IN (${placeholders})
      `);
    }
  }

  return getBatchSelectionSummary(batchId);
}

async function deselectPremiumMismatches(batchId) {
  const { compareHouseholdPremiums, clearPricingCache } = require('./householdPremiumCompare.service');
  const batch = await getBatch(batchId);
  const instanceId = await migrationInstance.resolveInstanceIdForBatch(batch);
  if (!instanceId) return { deselectedCount: 0 };

  clearPricingCache();
  const pool = await getPool();
  const rows = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT BatchHouseholdId, HouseholdJson, HouseholdMemberID
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId AND IncludedInImport = 1
    `);

  const locked = await migrationStatus.getLockedHouseholdMemberIds(
    (rows.recordset || []).map((row) => row.HouseholdMemberID)
  );

  let deselectedCount = 0;
  for (const row of rows.recordset || []) {
    if (locked.has(row.HouseholdMemberID)) continue;
    const hh = JSON.parse(row.HouseholdJson);
    const compare = await compareHouseholdPremiums(hh, instanceId);
    if (!compare.premiumMismatch) continue;
    await pool.request()
      .input('id', sql.UniqueIdentifier, row.BatchHouseholdId)
      .query(`
        UPDATE oe.MigrationImportBatchHousehold
        SET IncludedInImport = 0
        WHERE BatchHouseholdId = @id
      `);
    deselectedCount += 1;
  }

  return { deselectedCount };
}

function parseHouseholdMemberIds(input) {
  if (Array.isArray(input)) {
    return [...new Set(input.flatMap((item) => parseHouseholdMemberIds(item)))];
  }
  return [...new Set(
    String(input || '')
      .split(/[\s,;]+/)
      .map((part) => part.trim())
      .filter(Boolean)
  )];
}

/** Select only pending-migration households in this batch (CSV imports, prior staging). */
async function selectPendingMigrationHouseholds(batchId) {
  const pool = await getPool();
  const rows = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT BatchHouseholdId, HouseholdMemberID
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId
    `);

  const memberIds = (rows.recordset || []).map((row) => row.HouseholdMemberID);
  const states = await migrationStatus.classifyHouseholdMigrationStates(memberIds);

  await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      UPDATE oe.MigrationImportBatchHousehold
      SET IncludedInImport = 0
      WHERE BatchId = @batchId
    `);

  const pendingIds = (rows.recordset || [])
    .filter((row) => (states.get(row.HouseholdMemberID)?.state || 'new') === 'pending_update')
    .map((row) => row.BatchHouseholdId);

  if (pendingIds.length) {
    await updateHouseholdSelection(batchId, { batchHouseholdIds: pendingIds, included: true });
  }

  return getBatchSelectionSummary(batchId);
}

/**
 * Select batch households by HouseholdMemberID (e.g. SW0002148).
 * replaceSelection=true clears other selections first; false adds to current selection.
 */
async function selectHouseholdsByMemberIds(batchId, householdMemberIds = [], { replaceSelection = true } = {}) {
  const requestedIds = parseHouseholdMemberIds(householdMemberIds);
  if (!requestedIds.length) {
    const err = new Error('At least one household member ID is required');
    err.status = 400;
    throw err;
  }

  const pool = await getPool();
  const rows = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT BatchHouseholdId, HouseholdMemberID
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId
    `);

  const locked = await migrationStatus.getLockedHouseholdMemberIds(
    (rows.recordset || []).map((row) => row.HouseholdMemberID)
  );

  const requestedSet = new Set(requestedIds.map((id) => id.toUpperCase()));
  const matchedRows = (rows.recordset || []).filter((row) => {
    const memberId = String(row.HouseholdMemberID || '').trim();
    return memberId && requestedSet.has(memberId.toUpperCase()) && !locked.has(row.HouseholdMemberID);
  });

  if (replaceSelection) {
    await pool.request()
      .input('batchId', sql.UniqueIdentifier, batchId)
      .query(`
        UPDATE oe.MigrationImportBatchHousehold
        SET IncludedInImport = 0
        WHERE BatchId = @batchId
      `);
  }

  const matchedIds = matchedRows.map((row) => row.BatchHouseholdId);
  if (matchedIds.length) {
    await updateHouseholdSelection(batchId, { batchHouseholdIds: matchedIds, included: true });
  }

  const matchedMemberIdSet = new Set(
    matchedRows.map((row) => String(row.HouseholdMemberID).trim().toUpperCase())
  );
  const notInBatch = requestedIds.filter((id) => !matchedMemberIdSet.has(id.toUpperCase()));

  return {
    selection: await getBatchSelectionSummary(batchId),
    requestedCount: requestedIds.length,
    matchedCount: matchedIds.length,
    notInBatchCount: notInBatch.length,
    notInBatchIds: notInBatch.slice(0, 50)
  };
}

/** Select only households not yet in AB365; clear pending-migration and live members from selection. */
async function selectNewHouseholdsOnly(batchId) {
  const pool = await getPool();
  const rows = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT BatchHouseholdId, HouseholdMemberID
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId
    `);

  const memberIds = (rows.recordset || []).map((row) => row.HouseholdMemberID);
  const states = await migrationStatus.classifyHouseholdMigrationStates(memberIds);

  await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      UPDATE oe.MigrationImportBatchHousehold
      SET IncludedInImport = 0
      WHERE BatchId = @batchId
    `);

  const newIds = (rows.recordset || [])
    .filter((row) => (states.get(row.HouseholdMemberID)?.state || 'new') === 'new')
    .map((row) => row.BatchHouseholdId);

  if (newIds.length) {
    await updateHouseholdSelection(batchId, { batchHouseholdIds: newIds, included: true });
  }

  return getBatchSelectionSummary(batchId);
}

async function listBatchHouseholdSummaries(batchId, { page = 1, pageSize = 50, search = '', includePremium = false } = {}) {
  const batch = await getBatch(batchId);
  const tenantId = batch?.TenantId || null;
  const instanceId = await migrationInstance.resolveInstanceIdForBatch(batch);
  const searchTerm = search ? `%${String(search).trim()}%` : null;
  const comparePremium = includePremium && tenantId && instanceId;
  const premiumCompare = comparePremium
    ? require('./householdPremiumCompare.service')
    : null;

  if (comparePremium) premiumCompare.clearPricingCache();

  const pool = await getPool();
  const offset = (Math.max(1, page) - 1) * pageSize;

  const countReq = pool.request().input('batchId', sql.UniqueIdentifier, batchId);
  let countSql = `SELECT COUNT(*) AS cnt FROM oe.MigrationImportBatchHousehold WHERE BatchId = @batchId`;
  if (searchTerm) {
    countReq.input('search', sql.NVarChar, searchTerm);
    countSql += ` AND (HouseholdMemberID LIKE @search OR HouseholdJson LIKE @search)`;
  }
  const countRes = await countReq.query(countSql);
  const total = countRes.recordset?.[0]?.cnt || 0;

  const dataReq = pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .input('offset', sql.Int, offset)
    .input('pageSize', sql.Int, pageSize);
  let dataSql = `
    SELECT BatchHouseholdId, E123UserId, HouseholdMemberID, HouseholdJson, IncludedInImport,
      PreviewAction, PreviewMessage, Applied
    FROM oe.MigrationImportBatchHousehold
    WHERE BatchId = @batchId
  `;
  if (searchTerm) {
    dataReq.input('search', sql.NVarChar, searchTerm);
    dataSql += ` AND (HouseholdMemberID LIKE @search OR HouseholdJson LIKE @search)`;
  }
  dataSql += ` ORDER BY HouseholdMemberID OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`;

  const result = await dataReq.query(dataSql);
  const memberIds = (result.recordset || []).map((row) => row.HouseholdMemberID);
  const migrationStates = await migrationStatus.classifyHouseholdMigrationStates(memberIds);

  const rows = [];
  for (const row of result.recordset || []) {
    const hh = JSON.parse(row.HouseholdJson);
    const migrationState = migrationStates.get(row.HouseholdMemberID)?.state || 'new';
    const summary = {
      batchHouseholdId: row.BatchHouseholdId,
      e123UserId: row.E123UserId,
      householdMemberId: row.HouseholdMemberID,
      primaryName: `${hh.primary?.firstName || ''} ${hh.primary?.lastName || ''}`.trim(),
      dependentCount: hh.dependents?.length || 0,
      productCount: hh.products?.length || 0,
      brokerId: hh.brokerId || null,
      sellingAgentId: hh.sellingAgentId || null,
      email: hh.primary?.email || null,
      includedInImport: isIncludedInImport(row.IncludedInImport),
      migrationState,
      isPendingUpdate: migrationState === 'pending_update',
      alreadyMigrated: migrationState === 'locked',
      appliedInBatch: row.Applied === true || row.Applied === 1,
      previewAction: row.PreviewAction || null,
      previewMessage: row.PreviewMessage || null
    };
    if (comparePremium) {
      const premium = await premiumCompare.compareHouseholdPremiums(hh, instanceId);
      summary.e123PremiumTotal = premium.e123PremiumTotal;
      summary.ab365PremiumTotal = premium.ab365PremiumTotal;
      summary.premiumMismatch = premium.premiumMismatch;
      summary.premiumBreakdown = premium.premiumBreakdown;
    }
    rows.push(summary);
  }

  if (comparePremium) {
    rows.sort((a, b) => {
      if (a.premiumMismatch !== b.premiumMismatch) {
        return a.premiumMismatch ? -1 : 1;
      }
      return String(a.householdMemberId).localeCompare(String(b.householdMemberId));
    });
  }

  const labeledRows = await attachE123AgentLabels(rows, instanceId);
  const selection = await getBatchSelectionSummary(batchId);
  return { total, page, pageSize, rows: labeledRows, selection };
}

module.exports = {
  getBatch,
  getBatchDetail,
  createBatch,
  updateBatch,
  updateBatchWithRetry,
  clearBatchHouseholds,
  insertBatchHouseholds,
  countBatchHouseholds,
  listBatchHouseholds,
  listBatchHouseholdSummaries,
  getBatchSelectionSummary,
  updateHouseholdSelection,
  selectNewHouseholdsOnly,
  selectPendingMigrationHouseholds,
  selectHouseholdsByMemberIds,
  parseHouseholdMemberIds,
  deselectPendingMigrationHouseholds,
  deselectAlreadyMigratedHouseholds,
  deselectPremiumMismatches,
  releaseApplyLock,
  forceReleaseApplyLock,
  discardBatch,
  listHistory,
  listPendingMembers
};

'use strict';

const { sql, getPool, getConnectionInfo } = require('../../config/database');
const { aggregateProductKeys } = require('./householdNormalizer');
const { importHousehold, planMigrationEnrollmentsWithOptions, validateHouseholdMappings } = require('./memberImport.service');
const productMapService = require('./productMap.service');
const migrationBatch = require('./migrationBatch.service');
const migrationInstance = require('./migrationInstance.service');
const migrationStatus = require('./migrationStatus.service');
const { compareHouseholdPremiums, clearPricingCache } = require('./householdPremiumCompare.service');
const { resolveBrokerToAgent, pickHouseholdE123BrokerId, getAgentTenantInfo } = require('./migrationAgentResolver.service');
const { getAgentSummary } = require('./migrationAgentMapping.service');
const { getBatchImportSettings, preserveImportSettingsInSummary } = require('./migrationBatchImportSettings');

/** In-process apply jobs (cleared on server restart; DB lock + unlock handles stale batches). */
const activeApplyJobs = new Map();

/** Completed apply snapshots when DB status update is delayed by row locks. */
const completedApplySnapshots = new Map();

function setCompletedApplySnapshot(batchId, snapshot) {
  completedApplySnapshots.set(String(batchId), snapshot);
}

function clearCompletedApplySnapshot(batchId) {
  completedApplySnapshots.delete(String(batchId));
}

async function inferApplyCompletionFromHouseholds(batchId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT
        SUM(CASE WHEN IncludedInImport = 1 THEN 1 ELSE 0 END) AS total,
        SUM(CASE WHEN IncludedInImport = 1 AND (
          Applied = 1
          OR PreviewAction IN (N'imported', N'locked', N'skip', N'skipped', N'error')
        ) THEN 1 ELSE 0 END) AS processed,
        SUM(CASE WHEN IncludedInImport = 1 AND PreviewAction = N'error' THEN 1 ELSE 0 END) AS errors
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId
    `);
  const row = result.recordset?.[0] || {};
  const total = Number(row.total || 0);
  const processed = Number(row.processed || 0);
  const errors = Number(row.errors || 0);
  if (total <= 0 || processed < total) {
    return { complete: false };
  }
  return {
    complete: true,
    processed,
    status: errors > 0 && processed === errors ? 'failed' : 'applied'
  };
}

async function getApplyStatusSnapshot(batchId) {
  const key = String(batchId);
  const snapshot = completedApplySnapshots.get(key);
  if (snapshot) {
    return snapshot;
  }

  const batch = await migrationBatch.getBatch(batchId);
  if (!batch) return null;

  let status = batch.Status;
  let applyProcessed = batch.ApplyProcessed ?? 0;
  let applyCreateCount = batch.ApplyCreateCount ?? 0;
  let applySkipCount = batch.ApplySkipCount ?? 0;
  let applyErrorCount = batch.ApplyErrorCount ?? 0;

  if (status === 'applying' && !activeApplyJobs.has(key)) {
    const inferred = await inferApplyCompletionFromHouseholds(batchId);
    if (inferred.complete) {
      status = inferred.status;
      applyProcessed = inferred.processed;
    }
  }

  return {
    status,
    applyProcessed,
    applyTotal: batch.ApplyTotal ?? 0,
    applyCreateCount,
    applySkipCount,
    applyErrorCount,
    modifiedUtc: batch.ModifiedUtc || null,
    results: null
  };
}

async function persistApplyCompletion(batchId, {
  finalStatus,
  createCount,
  updateCount,
  skipCount,
  lockedCount,
  errorCount,
  processed
}) {
  const batch = await migrationBatch.getBatch(batchId);
  const summaryPayload = {
    createCount,
    updateCount,
    skipCount,
    lockedCount,
    errorCount,
    processed
  };
  await migrationBatch.updateBatchWithRetry(batchId, {
    Status: finalStatus,
    WizardStep: 5,
    ApplyProcessed: processed,
    ApplyCreateCount: createCount,
    ApplySkipCount: skipCount + lockedCount,
    ApplyErrorCount: errorCount,
    SummaryJson: preserveImportSettingsInSummary(batch?.SummaryJson, summaryPayload)
  }, { retries: 2, lockTimeoutMs: 3000, delayMs: 500 });
  // Keep in-memory snapshot — UI reads it instantly; DB is source of truth on next page load.
}

function schedulePersistApplyCompletion(batchId, payload) {
  setImmediate(() => {
    persistApplyCompletion(batchId, payload).catch((err) => {
      console.warn(`[migration-apply] batch ${batchId} deferred status persist failed:`, err.message);
    });
  });
}

function scheduleHouseholdResultUpdate(pool, batchHouseholdId, outcome) {
  setImmediate(() => {
    updateHouseholdApplyResult(pool, batchHouseholdId, outcome).catch((err) => {
      console.warn(`[migration-apply] household ${batchHouseholdId} result update skipped:`, err.message);
    });
  });
}

function scheduleBatchProgressUpdate(batchId, fields) {
  setImmediate(() => {
    migrationBatch.updateBatch(batchId, fields, { lockTimeoutMs: 2000 }).catch((err) => {
      console.warn(`[migration-apply] batch ${batchId} progress update skipped:`, err.message);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function outcomeForMigrationState(state, activeEnrollmentCount = 0) {
  if (state === 'pending_update') {
    return { action: 'imported', message: 'Already imported — pending migration' };
  }
  if (state === 'locked') {
    return {
      action: 'locked',
      message: activeEnrollmentCount > 0
        ? `Member is active in AB365 with ${activeEnrollmentCount} live enrollment(s) — not modified`
        : 'Member is active in AB365 — not modified'
    };
  }
  return null;
}

async function updateHouseholdApplyResult(pool, batchHouseholdId, outcome) {
  const applied = outcome.action === 'create'
    || outcome.action === 'update'
    || outcome.action === 'terminated';
  try {
    await pool.request()
      .input('id', sql.UniqueIdentifier, batchHouseholdId)
      .input('action', sql.NVarChar, outcome.action)
      .input('message', sql.NVarChar, outcome.message || null)
      .input('applied', sql.Bit, applied ? 1 : 0)
      .query(`
        SET LOCK_TIMEOUT 3000;
        UPDATE oe.MigrationImportBatchHousehold
        SET PreviewAction = @action, PreviewMessage = @message,
            Applied = CASE WHEN @applied = 1 THEN 1 ELSE Applied END,
            AppliedUtc = CASE WHEN @applied = 1 THEN SYSUTCDATETIME() ELSE AppliedUtc END
        WHERE BatchHouseholdId = @id
      `);
  } catch (err) {
    console.warn(`[migration-apply] household ${batchHouseholdId} result update skipped:`, err.message);
  }
}

function publishApplyProgress(batchId, {
  status,
  applyProcessed,
  applyTotal,
  applyCreateCount,
  applyUpdateCount,
  applySkipCount,
  applyErrorCount,
  results
}) {
  setCompletedApplySnapshot(batchId, {
    status,
    applyProcessed,
    applyTotal,
    applyCreateCount,
    applyUpdateCount,
    applySkipCount,
    applyErrorCount,
    modifiedUtc: new Date().toISOString(),
    results
  });
}

function resolveBatchHouseholdMemberId(row, household) {
  const fromColumn = row?.HouseholdMemberID != null ? String(row.HouseholdMemberID).trim() : '';
  const fromJson = household?.householdMemberId != null ? String(household.householdMemberId).trim() : '';
  return fromColumn || fromJson || null;
}

function collectBatchMemberIds(rows = []) {
  const ids = new Set();
  for (const row of rows) {
    try {
      const household = JSON.parse(row.HouseholdJson);
      const memberId = resolveBatchHouseholdMemberId(row, household);
      if (memberId) ids.add(memberId);
    } catch {
      const memberId = row?.HouseholdMemberID != null ? String(row.HouseholdMemberID).trim() : '';
      if (memberId) ids.add(memberId);
    }
  }
  return [...ids];
}

function partitionSelectedRows(rows, states) {
  const importableRows = [];
  const resyncRows = [];
  const skipRows = [];
  for (const row of rows) {
    const household = JSON.parse(row.HouseholdJson);
    const memberId = resolveBatchHouseholdMemberId(row, household);
    const info = memberId ? states.get(memberId) : null;
    const state = info?.state || 'new';
    const selected = row.IncludedInImport === true || row.IncludedInImport === 1;
    if (!selected) continue;
    if (state === 'locked') {
      skipRows.push({ row, state, info, memberId });
      continue;
    }
    if (state === 'pending_update') {
      resyncRows.push({ row, state, info, memberId });
      continue;
    }
    if (state === 'new') importableRows.push(row);
  }
  return { importableRows, resyncRows, skipRows };
}

function clearActiveApplyJob(batchId) {
  if (batchId) activeApplyJobs.delete(String(batchId));
}

function requestApplyCancellation(batchId) {
  const key = String(batchId);
  const job = activeApplyJobs.get(key);
  if (job) job.cancelled = true;
}

function isApplyCancelled(batchId) {
  return activeApplyJobs.get(String(batchId))?.cancelled === true;
}

async function waitForApplyJobEnd(batchId, maxMs = 15000) {
  const key = String(batchId);
  const started = Date.now();
  while (activeApplyJobs.has(key) && Date.now() - started < maxMs) {
    await sleep(300);
  }
}

const MEMBER_TIER_CODES = new Set(['EE', 'ES', 'EC', 'EF']);

function resolveHouseholdMemberTier(household) {
  const raw = String(household?.primary?.tier || 'EE').trim().toUpperCase();
  return MEMBER_TIER_CODES.has(raw) ? raw : 'EE';
}

async function getUnmappedProductsForBatch(batchId, instanceId) {
  const pool = await getPool();
  const rows = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT HouseholdJson
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId AND IncludedInImport = 1
    `);

  const households = (rows.recordset || []).map((r) => JSON.parse(r.HouseholdJson));
  const keys = aggregateProductKeys(households);
  const maps = await productMapService.listProductMaps(instanceId);
  const mapped = new Set();
  const ignored = new Set();
  for (const m of maps) {
    const key = `${m.SourceProductKey}::${m.SourceBenefitKey || ''}`;
    if (m.IgnoreImport) ignored.add(key);
    else if (m.ProductId) mapped.add(key);
  }

  return keys.map((k) => ({
    ...k,
    ignored: ignored.has(`${k.sourceProductKey}::${k.sourceBenefitKey || ''}`),
    mapped: mapped.has(`${k.sourceProductKey}::${k.sourceBenefitKey || ''}`)
      || mapped.has(`${k.sourceProductKey}::`)
      || ignored.has(`${k.sourceProductKey}::${k.sourceBenefitKey || ''}`)
      || ignored.has(`${k.sourceProductKey}::`)
  }));
}

async function buildPreviewRow(row, {
  batch,
  instanceId,
  offsetProcessingFeeForPremiumMatch,
  previewStates,
  agentResolveCache,
  agentNameCache
}) {
  const storedAction = row.PreviewAction ? String(row.PreviewAction).trim() : '';
  const storedMessage = row.PreviewMessage || '';
  const resyncPending = previewStates.get(row.HouseholdMemberID)?.state === 'pending_update';
  let outcome;
  if (storedAction === 'locked') {
    outcome = { action: storedAction, message: storedMessage };
  } else if (resyncPending) {
    outcome = await importHousehold({
      household: row.household,
      tenantId: batch.TenantId,
      instanceId,
      createdBy: batch.CreatedBy,
      dryRun: true,
      resyncPending: true
    });
  } else if (storedAction) {
    outcome = { action: storedAction, message: storedMessage };
  } else {
    outcome = await importHousehold({
      household: row.household,
      tenantId: batch.TenantId,
      instanceId,
      createdBy: batch.CreatedBy,
      dryRun: true,
      resyncPending: false
    });
  }
  if ((storedAction === 'update' || storedAction === 'terminated')
    && outcome.action !== 'update'
    && outcome.action !== 'terminated') {
    const live = await importHousehold({
      household: row.household,
      tenantId: batch.TenantId,
      instanceId,
      createdBy: batch.CreatedBy,
      dryRun: true,
      resyncPending: true
    });
    if (live.action === 'update' || live.action === 'terminated') outcome = live;
  }
  clearPricingCache();
  const premium = await compareHouseholdPremiums(row.household, instanceId);

  let premiumMismatch = premium.premiumMismatch;
  let ab365PremiumTotal = premium.ab365PremiumTotal;
  let premiumOffsetAdjustment = null;
  let premiumOffsetApplied = false;

  if (offsetProcessingFeeForPremiumMatch && batch.TenantId) {
    const validation = await validateHouseholdMappings(row.household, instanceId);
    if (validation.mappedCount > 0) {
      const { premiumOffset } = await planMigrationEnrollmentsWithOptions({
        household: row.household,
        migratableProducts: validation.migratableProducts,
        instanceId,
        tenantId: batch.TenantId,
        offsetProcessingFeeForPremiumMatch: true
      });
      if (premiumOffset.applied) {
        premiumOffsetAdjustment = premiumOffset.applied;
        premiumOffsetApplied = true;
        ab365PremiumTotal = premiumOffset.projectedTotalAdjusted;
        if (premium.e123PremiumTotal != null && premiumOffset.projectedTotalAdjusted != null) {
          premiumMismatch = Math.abs(premium.e123PremiumTotal - premiumOffset.projectedTotalAdjusted) >= 0.01;
        }
      }
    }
  }

  const e123BrokerId = pickHouseholdE123BrokerId(row.household);
  let ab365AgentId = null;
  let ab365AgentName = null;
  let ab365AgentCrossTenant = false;
  if (e123BrokerId) {
    const agentResolved = await resolveBrokerToAgent({
      tenantId: batch.TenantId,
      instanceId,
      e123BrokerId,
      cache: agentResolveCache,
      persistAutoMatch: false
    });
    if (agentResolved.crossTenant && agentResolved.crossTenantAgentId) {
      ab365AgentCrossTenant = true;
      const crossInfo = await getAgentTenantInfo(agentResolved.crossTenantAgentId);
      ab365AgentName = crossInfo
        ? `${crossInfo.displayName}${crossInfo.tenantName ? ` (${crossInfo.tenantName})` : ''}`
        : 'Agent in another tenant';
    } else {
      ab365AgentId = agentResolved.agentId || null;
      if (ab365AgentId) {
        if (agentNameCache.has(ab365AgentId)) {
          ab365AgentName = agentNameCache.get(ab365AgentId);
        } else {
          const summary = await getAgentSummary(ab365AgentId, batch.TenantId);
          ab365AgentName = summary?.displayName || null;
          agentNameCache.set(ab365AgentId, ab365AgentName);
        }
      }
    }
  }

  return {
    batchHouseholdId: row.BatchHouseholdId,
    householdMemberId: row.HouseholdMemberID,
    primaryName: `${row.household.primary?.firstName || ''} ${row.household.primary?.lastName || ''}`.trim(),
    tier: resolveHouseholdMemberTier(row.household),
    dependentCount: row.household.dependents?.length || 0,
    productCount: row.household.products?.length || 0,
    ab365AgentId,
    ab365AgentName,
    ab365AgentCrossTenant,
    action: outcome.action,
    message: outcome.message,
    e123PremiumTotal: premium.e123PremiumTotal,
    ab365PremiumTotal,
    premiumMismatch,
    premiumBreakdown: premium.premiumBreakdown,
    premiumOffsetAdjustment,
    premiumOffsetApplied
  };
}

function countPreviewAction(action, counts) {
  const normalized = String(action || '').trim();
  if (normalized === 'create') counts.createCount += 1;
  else if (normalized === 'update') counts.updateCount += 1;
  else if (normalized === 'skip') counts.skipCount += 1;
  else if (normalized === 'locked') counts.lockedCount += 1;
  else if (normalized === 'imported' || normalized === 'skipped') counts.importedCount += 1;
  else counts.errorCount += 1;
}

async function persistPreviewOutcomes(sourceRows, previewRows) {
  if (!sourceRows?.length || !previewRows?.length) return;
  const pool = await getPool();
  for (let i = 0; i < sourceRows.length; i += 1) {
    const source = sourceRows[i];
    const preview = previewRows[i];
    if (!source?.BatchHouseholdId || !preview?.action) continue;
    await pool.request()
      .input('batchHouseholdId', sql.UniqueIdentifier, source.BatchHouseholdId)
      .input('previewAction', sql.NVarChar, preview.action)
      .input('previewMessage', sql.NVarChar, preview.message || null)
      .query(`
        UPDATE oe.MigrationImportBatchHousehold
        SET PreviewAction = @previewAction, PreviewMessage = @previewMessage
        WHERE BatchHouseholdId = @batchHouseholdId
      `);
  }
}

async function previewBatch(batchId, {
  page = 1,
  pageSize = 50,
  chunkOffset = 0,
  chunkSize = null,
  includeSummary = false
} = {}) {
  const batch = await migrationBatch.getBatch(batchId);
  if (!batch) throw new Error('Batch not found');
  if (!batch.TenantId) throw new Error('TenantId is required for preview');
  const instanceId = await migrationInstance.resolveInstanceIdForBatch(batch);
  if (!instanceId) throw new Error('Migration instance is required for product mapping');
  const importSettings = getBatchImportSettings(batch);
  const offsetProcessingFeeForPremiumMatch = importSettings.offsetProcessingFeeForPremiumMatch === true;

  const households = await migrationBatch.listBatchHouseholds(batchId, { page, pageSize, includedOnly: true });
  const pageRowCount = households.length;
  const start = Math.max(0, Number(chunkOffset) || 0);
  const effectiveChunkSize = chunkSize != null ? Math.max(1, Number(chunkSize)) : pageRowCount;
  const slice = households.slice(start, start + effectiveChunkSize);

  const agentResolveCache = new Map();
  const agentNameCache = new Map();

  const previewMemberIds = slice.map((row) => row.HouseholdMemberID).filter(Boolean);
  const previewStates = previewMemberIds.length
    ? await migrationStatus.classifyHouseholdMigrationStates(previewMemberIds)
    : new Map();

  const results = [];
  const chunkStartedAt = Date.now();
  console.log(
    `[migration-preview] batch=${batchId} page=${page}`
    + ` chunk ${start + 1}-${start + slice.length} of ${pageRowCount} (${slice.length} households)`
  );
  for (const row of slice) {
    results.push(await buildPreviewRow(row, {
      batch,
      instanceId,
      offsetProcessingFeeForPremiumMatch,
      previewStates,
      agentResolveCache,
      agentNameCache
    }));
  }
  await persistPreviewOutcomes(slice, results);
  console.log(
    `[migration-preview] batch=${batchId} chunk done in ${Date.now() - chunkStartedAt}ms`
    + ` (+${results.length} rows)`
  );

  const selection = start === 0
    ? await migrationBatch.getBatchSelectionSummary(batchId)
    : null;
  const total = start === 0
    ? (selection?.selectedCount ?? 0)
    : null;
  const summary = includeSummary
    ? await summarizeBatch(batchId, batch.TenantId, instanceId)
    : null;

  return {
    batch,
    page,
    pageSize,
    total: total ?? undefined,
    pageRowCount,
    chunkOffset: start,
    chunkSize: effectiveChunkSize,
    chunkComplete: start + slice.length >= pageRowCount,
    summary,
    selection,
    rows: results,
    importSettings
  };
}

async function summarizeBatch(batchId, tenantId, instanceId) {
  if (!instanceId) throw new Error('Migration instance is required for product mapping');
  const summaryStartedAt = Date.now();
  console.log(`[migration-preview] batch=${batchId} summarize start`);
  const pool = await getPool();
  const rows = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT HouseholdJson, PreviewAction, PreviewMessage, HouseholdMemberID
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId AND IncludedInImport = 1
    `);

  const counts = {
    createCount: 0,
    updateCount: 0,
    skipCount: 0,
    lockedCount: 0,
    importedCount: 0,
    errorCount: 0
  };
  let cachedCount = 0;

  const memberIds = collectBatchMemberIds(rows.recordset || []);
  const states = memberIds.length
    ? await migrationStatus.classifyHouseholdMigrationStates(memberIds)
    : new Map();
  for (const row of rows.recordset || []) {
    const storedAction = row.PreviewAction ? String(row.PreviewAction).trim() : '';
    if (storedAction) {
      countPreviewAction(storedAction, counts);
      cachedCount += 1;
      continue;
    }

    const household = JSON.parse(row.HouseholdJson);
    const memberId = resolveBatchHouseholdMemberId(row, household);
    const resyncPending = memberId ? states.get(memberId)?.state === 'pending_update' : false;
    const outcome = await importHousehold({
      household,
      tenantId,
      instanceId,
      createdBy: null,
      dryRun: true,
      resyncPending
    });
    countPreviewAction(outcome.action, counts);
  }

  console.log(
    `[migration-preview] batch=${batchId} summarize done in ${Date.now() - summaryStartedAt}ms`
    + ` (${cachedCount}/${(rows.recordset || []).length} from cached preview)`
  );

  return {
    ...counts,
    total: (rows.recordset || []).length
  };
}

async function prepareApplyBatch(batchId, createdBy, { force = false, skipForceRelease = false } = {}) {
  const logStep = (step) => console.log(`[migration-apply] prepare ${batchId} ${step}`);

  logStep(`pool ${JSON.stringify(getConnectionInfo())}`);
  logStep('getBatch');
  let batch = await migrationBatch.getBatch(batchId);
  if (!batch) throw new Error('Batch not found');
  if (!batch.TenantId) throw new Error('TenantId is required');

  logStep('resolveInstance');
  const instanceId = await migrationInstance.resolveInstanceIdForBatch(batch);
  if (!instanceId) throw new Error('Migration instance is required for product mapping');

  let skipMarkApplying = false;

  if (batch.Status === 'applying') {
    batch = await migrationBatch.getBatch(batchId) || batch;
    if (force && !skipForceRelease) {
      logStep('force — release stale applying lock');
      await migrationBatch.forceReleaseApplyLock(batchId, {
        requireApplying: false,
        retries: 1,
        lockTimeoutMs: 500
      }).catch((err) => {
        logStep(`force release skipped: ${err.message}`);
      });
      skipMarkApplying = false;
    } else if (force && skipForceRelease) {
      logStep('force — skip lock release (already attempted in background)');
      skipMarkApplying = true;
    } else {
      const modified = batch.ModifiedUtc ? new Date(batch.ModifiedUtc) : null;
      const staleMs = 2 * 60 * 1000;
      const isStale = modified && (Date.now() - modified.getTime()) > staleMs;
      const incomplete = (batch.ApplyProcessed || 0) < (batch.ApplyTotal || 0);
      if (!isStale || !incomplete) {
        throw new Error('Batch is already applying — use force retry');
      }
      logStep('stale applying — skip unlock, reset on mark applying');
    }
  }

  logStep('load households');
  const pool = await getPool();
  const allRows = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT BatchHouseholdId, HouseholdJson, Applied, IncludedInImport
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId
      ORDER BY HouseholdMemberID
    `);

  const rows = allRows.recordset || [];
  const memberIds = collectBatchMemberIds(rows);
  const states = memberIds.length
    ? await migrationStatus.classifyHouseholdMigrationStates(memberIds)
    : new Map();
  const { importableRows, resyncRows, skipRows } = partitionSelectedRows(rows, states);
  const applyTotal = importableRows.length + resyncRows.length + skipRows.length;

  if (!applyTotal) {
    logStep('no households selected for import');
    return {
      batch,
      instanceId,
      rows: [],
      resyncRows: [],
      skipRows: [],
      applyTotal: 0,
      createdBy,
      empty: true
    };
  }

  if (resyncRows.length) {
    logStep(`${resyncRows.length} pending migration household(s) will be re-synced`);
  }
  if (skipRows.length) {
    logStep(`${skipRows.length} active household(s) will be skipped`);
  }

  if (skipMarkApplying) {
    logStep(`skip mark applying (${applyTotal} household(s)) — row already locked as applying`);
  } else {
    logStep(`mark applying (${applyTotal} household(s), ${importableRows.length} new)`);
    try {
      await migrationBatch.updateBatch(batchId, {
        Status: 'applying',
        ApplyTotal: applyTotal,
        ApplyProcessed: 0,
        ApplyCreateCount: 0,
        ApplySkipCount: 0,
        ApplyErrorCount: 0
      }, { lockTimeoutMs: 2000 });
    } catch (markErr) {
      logStep(`mark applying skipped (${markErr.message}) — continuing with in-memory progress`);
    }
  }

  logStep('ready');
  return {
    batch,
    instanceId,
    rows: importableRows,
    resyncRows,
    skipRows,
    applyTotal,
    createdBy
  };
}

async function executeApplyBatchWork(batchId, prepared) {
  const {
    batch,
    instanceId,
    rows,
    resyncRows = [],
    skipRows = [],
    applyTotal = 0,
    createdBy,
    empty = false
  } = prepared;
  const pool = await getPool();
  let processed = 0;
  let createCount = 0;
  let updateCount = 0;
  let skipCount = 0;
  let lockedCount = 0;
  let errorCount = 0;
  const agentCache = new Map();
  const results = [];
  const totalCount = applyTotal || resyncRows.length + skipRows.length + rows.length;
  const importSettings = getBatchImportSettings(batch);
  const offsetProcessingFeeForPremiumMatch = importSettings.offsetProcessingFeeForPremiumMatch === true;

  const finishApply = async (finalStatus) => {
    const completionPayload = {
      finalStatus,
      createCount,
      updateCount,
      skipCount,
      lockedCount,
      errorCount,
      processed
    };
    publishApplyProgress(batchId, {
      status: finalStatus,
      applyProcessed: processed,
      applyTotal: totalCount,
      applyCreateCount: createCount,
      applyUpdateCount: updateCount,
      applySkipCount: skipCount + lockedCount,
      applyErrorCount: errorCount,
      results
    });
    schedulePersistApplyCompletion(batchId, completionPayload);
    console.log(`[migration-apply] batch ${batchId} finished status=${finalStatus} processed=${processed}`);
    return {
      createCount,
      updateCount,
      skipCount,
      lockedCount,
      errorCount,
      processed,
      status: finalStatus,
      results
    };
  };

  const recordOutcome = (row, household, outcome) => {
    const primaryName = `${household.primary?.firstName || ''} ${household.primary?.lastName || ''}`.trim()
      || household.householdMemberId;
    processed += 1;
    if (outcome.action === 'create') createCount += 1;
    else if (outcome.action === 'update' || outcome.action === 'terminated') updateCount += 1;
    else if (outcome.action === 'skip' || outcome.action === 'imported' || outcome.action === 'skipped') skipCount += 1;
    else if (outcome.action === 'locked') lockedCount += 1;
    else errorCount += 1;

    results.push({
      batchHouseholdId: row.BatchHouseholdId,
      householdMemberId: household.householdMemberId,
      primaryName,
      action: outcome.action,
      message: outcome.message || null
    });

    publishApplyProgress(batchId, {
      status: 'applying',
      applyProcessed: processed,
      applyTotal: totalCount,
      applyCreateCount: createCount,
      applyUpdateCount: updateCount,
      applySkipCount: skipCount + lockedCount,
      applyErrorCount: errorCount,
      results: [...results]
    });

    scheduleHouseholdResultUpdate(pool, row.BatchHouseholdId, outcome);
    scheduleBatchProgressUpdate(batchId, {
      ApplyProcessed: processed,
      ApplyCreateCount: createCount,
      ApplyUpdateCount: updateCount,
      ApplySkipCount: skipCount + lockedCount,
      ApplyErrorCount: errorCount
    });

    console.log(
      `[migration-apply] ${household.householdMemberId} -> ${outcome.action}${outcome.message ? `: ${outcome.message}` : ''}`
    );
  };

  if (empty && !skipRows.length && !resyncRows.length) {
    publishApplyProgress(batchId, {
      status: 'applied',
      applyProcessed: 0,
      applyTotal: 0,
      applyCreateCount: 0,
      applyUpdateCount: 0,
      applySkipCount: 0,
      applyErrorCount: 0,
      results: []
    });
    schedulePersistApplyCompletion(batchId, {
      finalStatus: 'applied',
      createCount: 0,
      updateCount: 0,
      skipCount: 0,
      lockedCount: 0,
      errorCount: 0,
      processed: 0
    });
    console.log(`[migration-apply] batch ${batchId} finished — nothing selected`);
    return { createCount: 0, updateCount: 0, skipCount: 0, lockedCount: 0, errorCount: 0, processed: 0, status: 'applied', results: [] };
  }

  try {
    console.log(`[migration-apply] batch ${batchId} starting ${totalCount} household(s) (${rows.length} new, ${resyncRows.length} re-sync, ${skipRows.length} skip)`);

    for (const { row, state, info } of resyncRows) {
      if (isApplyCancelled(batchId)) {
        await migrationBatch.forceReleaseApplyLock(batchId).catch(() => {});
        return { cancelled: true, createCount, updateCount, skipCount, lockedCount, errorCount, processed, status: 'ready', results };
      }
      const household = JSON.parse(row.HouseholdJson);
      console.log(`[migration-apply] re-sync ${household.householdMemberId}`);
      const outcome = await importHousehold({
        household,
        tenantId: batch.TenantId,
        instanceId,
        createdBy,
        dryRun: false,
        agentCache,
        resyncPending: true,
        offsetProcessingFeeForPremiumMatch
      });
      recordOutcome(row, household, outcome);
    }

    for (const { row, state, info } of skipRows) {
      if (isApplyCancelled(batchId)) {
        await migrationBatch.forceReleaseApplyLock(batchId).catch(() => {});
        return { cancelled: true, createCount, updateCount, skipCount, lockedCount, errorCount, processed, status: 'ready', results };
      }
      const household = JSON.parse(row.HouseholdJson);
      const outcome = outcomeForMigrationState(state, info?.activeEnrollmentCount || 0);
      if (!outcome) continue;
      recordOutcome(row, household, outcome);
    }

    for (const row of rows) {
      if (isApplyCancelled(batchId)) {
        console.log(`[migration-apply] batch ${batchId} cancelled before next household`);
        await migrationBatch.forceReleaseApplyLock(batchId).catch(() => {});
        return {
          cancelled: true,
          createCount,
          updateCount,
          skipCount,
          lockedCount,
          errorCount,
          processed,
          status: 'ready',
          results
        };
      }

      const household = JSON.parse(row.HouseholdJson);
      console.log(`[migration-apply] importing ${household.householdMemberId}`);
      const outcome = await importHousehold({
        household,
        tenantId: batch.TenantId,
        instanceId,
        createdBy,
        dryRun: false,
        agentCache,
        offsetProcessingFeeForPremiumMatch
      });

      if (isApplyCancelled(batchId)) {
        await migrationBatch.forceReleaseApplyLock(batchId).catch(() => {});
        return { cancelled: true, createCount, updateCount, skipCount, lockedCount, errorCount, processed, status: 'ready', results };
      }

      recordOutcome(row, household, outcome);
    }

    const finalStatus = errorCount > 0 && createCount === 0 && updateCount === 0 ? 'failed' : 'applied';
    return finishApply(finalStatus);
  } catch (err) {
    console.error(`[migration-apply] batch ${batchId} failed:`, err.message);
    publishApplyProgress(batchId, {
      status: 'failed',
      applyProcessed: processed,
      applyTotal: totalCount,
      applyCreateCount: createCount,
      applyUpdateCount: updateCount,
      applySkipCount: skipCount + lockedCount,
      applyErrorCount: Math.max(errorCount, 1),
      results
    });
    schedulePersistApplyCompletion(batchId, {
      finalStatus: 'failed',
      createCount,
      updateCount,
      skipCount,
      lockedCount,
      errorCount: Math.max(errorCount, 1),
      processed
    });
    return {
      createCount,
      updateCount,
      skipCount,
      lockedCount,
      errorCount: Math.max(errorCount, 1),
      processed,
      status: 'failed',
      results,
      error: err.message
    };
  } finally {
    clearActiveApplyJob(batchId);
  }
}

async function startApplyBatch(batchId, createdBy, options = {}) {
  const key = String(batchId);
  console.log(`[migration-apply] startApplyBatch ${batchId}${options.force ? ' (force)' : ''}`);

  if (activeApplyJobs.has(key)) {
    if (!options.force) throw new Error('Apply is already running on this server — wait or force retry');
    requestApplyCancellation(batchId);
    await waitForApplyJobEnd(batchId, 3000);
    clearActiveApplyJob(batchId);
  }

  activeApplyJobs.set(key, { cancelled: false });
  publishApplyProgress(batchId, {
    status: 'applying',
    applyProcessed: 0,
    applyTotal: 0,
    applyCreateCount: 0,
    applyUpdateCount: 0,
    applySkipCount: 0,
    applyErrorCount: 0,
    results: []
  });

  if (options.force) {
    setImmediate(() => {
      migrationBatch.forceReleaseApplyLock(batchId, {
        requireApplying: false,
        retries: 1,
        lockTimeoutMs: 500
      }).catch((err) => {
        console.warn(`[migration-apply] background force clear lock skipped for ${batchId}:`, err.message);
      });
    });
  }

  setImmediate(() => {
    (async () => {
      try {
        const prepared = await prepareApplyBatch(batchId, createdBy, {
          ...options,
          skipForceRelease: options.force === true
        });
        console.log(`[migration-apply] prepare complete batch=${batchId} households=${prepared.applyTotal || 0}`);
        publishApplyProgress(batchId, {
          status: 'applying',
          applyProcessed: 0,
          applyTotal: prepared.applyTotal || prepared.rows.length + (prepared.skipRows?.length || 0),
          applyCreateCount: 0,
          applyUpdateCount: 0,
          applySkipCount: 0,
          applyErrorCount: 0,
          results: []
        });
        await executeApplyBatchWork(batchId, prepared);
      } catch (err) {
        console.error(`[migration-apply] background apply failed ${batchId}:`, err.message);
        publishApplyProgress(batchId, {
          status: 'failed',
          applyProcessed: 0,
          applyTotal: 0,
          applyCreateCount: 0,
          applyUpdateCount: 0,
          applySkipCount: 0,
          applyErrorCount: 1,
          results: [{
            batchHouseholdId: batchId,
            householdMemberId: '',
            primaryName: 'Apply',
            action: 'error',
            message: err.message
          }]
        });
        schedulePersistApplyCompletion(batchId, {
          finalStatus: 'failed',
          createCount: 0,
          updateCount: 0,
          skipCount: 0,
          lockedCount: 0,
          errorCount: 1,
          processed: 0
        });
        clearActiveApplyJob(batchId);
      }
    })();
  });

  return {
    started: true,
    status: 'applying',
    applyTotal: 0,
    applyProcessed: 0,
    createCount: 0,
    updateCount: 0,
    skipCount: 0,
    lockedCount: 0,
    errorCount: 0,
    processed: 0,
    results: []
  };
}

async function abortApplyJob(batchId, maxWaitMs = 20000) {
  requestApplyCancellation(batchId);
  await waitForApplyJobEnd(batchId, maxWaitMs);
  clearActiveApplyJob(batchId);
}

async function applyBatch(batchId, createdBy, options = {}) {
  const prepared = await prepareApplyBatch(batchId, createdBy, options);
  activeApplyJobs.set(String(batchId), { cancelled: false });
  try {
    return await executeApplyBatchWork(batchId, prepared);
  } finally {
    clearActiveApplyJob(batchId);
  }
}

module.exports = {
  getUnmappedProductsForBatch,
  previewBatch,
  summarizeBatch,
  applyBatch,
  startApplyBatch,
  getApplyStatusSnapshot,
  clearActiveApplyJob,
  requestApplyCancellation,
  abortApplyJob,
  resolveBatchHouseholdMemberId,
  collectBatchMemberIds,
  partitionSelectedRows
};

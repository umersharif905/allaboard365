'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql, getPool } = require('../../config/database');
const { runWithInstanceE123Config } = require('./e123Config');
const e123AgentTreeSnapshot = require('./e123AgentTreeSnapshot.service');
const { computeExcludedAgentIds } = require('./e123AgentTree/agentTreeFilters');
const {
  fetchE123BrokerHints,
  findActiveAgentByEmail,
  findActiveAgentByExactName,
  verifyAgentInTenant,
} = require('./migrationAgentResolver.service');
const agentMapService = require('./migrationAgentMap.service');
const { getAgentSummary } = require('./migrationAgentMapping.service');
const { getAgentProfileById } = require('./e123Agent.service');
const { fetchAgentAchBankInfo } = require('./e123AgentBank.service');
const {
  applyTierInferenceToPayablesAgents,
  enrichBrokerWithPayables,
  loadCommissionLevelContext
} = require('./e123PayablesDetail.service');
const {
  defaultImportSettings,
  normalizeImportSettings,
  loadDirectActiveMemberCountsByBroker,
  computeSubtreeActiveMemberCounts,
  filterScopeBrokerIdsByActiveMembers,
  filterScopeBrokerIdsWithoutEmail
} = require('./agentMigrationMemberScope.service');
const payablesSnapshot = require('./e123PayablesSnapshot.service');
const commissionRosterService = require('./agentCommissionRoster.service');
const { generateAgentCode } = require('../agentCode.service');
const UserRolesService = require('../shared/user-roles.service');
const encryptionService = require('../encryptionService');

const DEFAULT_TIER_LEVEL = 0;
const MIN_TIER_LEVEL = -1;
const E123_ENRICH_CONCURRENCY = 8;
const CLASSIFY_CONCURRENCY = 12;

function logWorkspace(batchId, message, extra = '') {
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[agent-migration-workspace ${batchId}] ${message}${suffix}`);
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker()
  );
  await Promise.all(workers);
  return results;
}

let progressThrottle = new Map();

async function mergeBatchSummaryJson(batchId, mergeFn) {
  const batch = await getBatch(batchId);
  const current = parseJsonSafe(batch?.SummaryJson, {}) || {};
  const next = typeof mergeFn === 'function' ? mergeFn(current) : { ...current, ...mergeFn };
  await patchBatch(batchId, { summaryJson: next });
  return next;
}

async function reportWorkspaceBuildProgress(batchId, progress) {
  const key = String(batchId);
  const now = Date.now();
  const prev = progressThrottle.get(key) || { at: 0, processed: -1 };
  const processed = progress.processed ?? 0;

  if (
    processed === prev.processed
    && now - prev.at < 500
    && progress.phase === prev.phase
  ) {
    return;
  }
  if (now - prev.at < 250 && processed - prev.processed < 2) {
    return;
  }

  progressThrottle.set(key, { at: now, processed, phase: progress.phase });
  logWorkspace(
    batchId,
    progress.phase || 'progress',
    `${processed}/${progress.total || '?'}${progress.currentLabel ? ` ${progress.currentLabel}` : ''}`
  );

  await mergeBatchSummaryJson(batchId, (cur) => ({
    ...cur,
    workspaceBuild: {
      ...(cur.workspaceBuild || {}),
      phase: progress.phase === 'complete' ? 'complete' : 'building',
      progress: {
        ...(cur.workspaceBuild?.progress || {}),
        ...progress,
        updatedUtc: new Date().toISOString()
      }
    }
  }));
}

function parseJsonSafe(raw, fallback = null) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function defaultTierForUpline(uplineTierLevel, { parentIsAgency = false } = {}) {
  if (parentIsAgency) {
    return 1;
  }
  if (uplineTierLevel == null || !Number.isFinite(Number(uplineTierLevel))) {
    return DEFAULT_TIER_LEVEL;
  }
  return Math.max(MIN_TIER_LEVEL, Number(uplineTierLevel) - 1);
}

function parseParentAb365Ref(raw, batch) {
  const text = String(raw || '').trim();
  if (!text && batch?.AgencyId) {
    return { type: 'agency', id: batch.AgencyId.toString() };
  }
  if (!text) return null;
  if (text.startsWith('agency:')) return { type: 'agency', id: text.slice(7) };
  if (text.startsWith('agent:')) return { type: 'agent', id: text.slice(6) };
  return { type: 'agent', id: text };
}

async function resolveLinkedUserClassification({
  tenantId,
  e123BrokerId,
  linkedUserId
}) {
  const brokerId = Number(e123BrokerId);
  const userId = String(linkedUserId || '').trim();
  if (!userId) return null;

  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT TOP 1 u.UserId, a.AgentId
      FROM oe.Users u
      LEFT JOIN oe.Agents a ON a.UserId = u.UserId AND a.TenantId = @tenantId
      WHERE u.UserId = @userId AND u.TenantId = @tenantId
    `);
  const row = result.recordset?.[0];
  if (!row) {
    return {
      e123BrokerId: brokerId,
      action: 'conflict',
      matchStatus: 'cross_tenant',
      existingAgentId: null,
      existingUserId: userId,
      conflictReason: 'manual_link_cross_tenant',
      matchMethod: 'manual_override'
    };
  }
  if (row.AgentId) {
    return resolveLinkedAgentClassification({
      tenantId,
      e123BrokerId: brokerId,
      linkedAgentId: row.AgentId
    });
  }

  return {
    e123BrokerId: brokerId,
    action: 'promote_user',
    matchStatus: 'existing_user',
    existingAgentId: null,
    existingUserId: row.UserId,
    conflictReason: null,
    matchMethod: 'manual_override'
  };
}

async function resolveLinkedAgentClassification({
  tenantId,
  e123BrokerId,
  linkedAgentId
}) {
  const brokerId = Number(e123BrokerId);
  const agentId = String(linkedAgentId || '').trim();
  if (!agentId) return null;

  const inTenant = await verifyAgentInTenant(agentId, tenantId);
  if (!inTenant) {
    return {
      e123BrokerId: brokerId,
      action: 'conflict',
      matchStatus: 'cross_tenant',
      existingAgentId: agentId,
      existingUserId: null,
      conflictReason: 'manual_link_cross_tenant',
      matchMethod: 'manual_override'
    };
  }

  return {
    e123BrokerId: brokerId,
    action: 'map_existing',
    matchStatus: 'mapped',
    existingAgentId: agentId,
    existingUserId: null,
    conflictReason: null,
    matchMethod: 'manual_override'
  };
}

async function getBatch(batchId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`SELECT * FROM oe.MigrationAgentImportBatch WHERE BatchId = @batchId`);
  return result.recordset?.[0] || null;
}

async function createBatch({
  instanceId,
  rootBrokerId,
  rootAgentLabel = null,
  includeDownline = true,
  tenantId = null,
  agencyId = null,
  createdBy = null
}) {
  const pool = await getPool();
  const batchId = uuidv4();
  const draftJson = JSON.stringify({
    nodeOverrides: {},
    importSettings: defaultImportSettings()
  });
  await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .input('rootBrokerId', sql.Int, Number(rootBrokerId))
    .input('rootAgentLabel', sql.NVarChar, rootAgentLabel || null)
    .input('includeDownline', sql.Bit, includeDownline ? 1 : 0)
    .input('tenantId', sql.UniqueIdentifier, tenantId || null)
    .input('agencyId', sql.UniqueIdentifier, agencyId || null)
    .input('createdBy', sql.UniqueIdentifier, createdBy || null)
    .input('draftJson', sql.NVarChar(sql.MAX), draftJson)
    .query(`
      INSERT INTO oe.MigrationAgentImportBatch (
        BatchId, InstanceId, RootBrokerId, RootAgentLabel, IncludeDownline,
        TenantId, AgencyId, WizardStep, Status, CreatedBy, DraftJson
      ) VALUES (
        @batchId, @instanceId, @rootBrokerId, @rootAgentLabel, @includeDownline,
        @tenantId, @agencyId, 1, 'draft', @createdBy, @draftJson
      )
    `);
  return getBatch(batchId);
}

async function patchBatch(batchId, updates = {}) {
  const pool = await getPool();
  const sets = ['ModifiedUtc = SYSUTCDATETIME()'];
  const request = pool.request().input('batchId', sql.UniqueIdentifier, batchId);

  if (updates.tenantId !== undefined) {
    sets.push('TenantId = @tenantId');
    request.input('tenantId', sql.UniqueIdentifier, updates.tenantId || null);
  }
  if (updates.agencyId !== undefined) {
    sets.push('AgencyId = @agencyId');
    request.input('agencyId', sql.UniqueIdentifier, updates.agencyId || null);
  }
  if (updates.wizardStep !== undefined) {
    sets.push('WizardStep = @wizardStep');
    request.input('wizardStep', sql.Int, Number(updates.wizardStep) || 1);
  }
  if (updates.status !== undefined) {
    sets.push('Status = @status');
    request.input('status', sql.NVarChar, updates.status);
  }
  if (updates.draftJson !== undefined) {
    sets.push('DraftJson = @draftJson');
    request.input('draftJson', sql.NVarChar(sql.MAX), JSON.stringify(updates.draftJson || {}));
  }
  if (updates.summaryJson !== undefined) {
    sets.push('SummaryJson = @summaryJson');
    request.input('summaryJson', sql.NVarChar(sql.MAX), JSON.stringify(updates.summaryJson || {}));
  }
  if (updates.rootAgentLabel !== undefined) {
    sets.push('RootAgentLabel = @rootAgentLabel');
    request.input('rootAgentLabel', sql.NVarChar, updates.rootAgentLabel || null);
  }

  await request.query(`
    UPDATE oe.MigrationAgentImportBatch
    SET ${sets.join(', ')}
    WHERE BatchId = @batchId
  `);
  return getBatch(batchId);
}

async function loadTreeRowsForInstance(instanceId) {
  const latest = await e123AgentTreeSnapshot.getLatestAgentTreeExport(instanceId);
  if (!latest) return { exportId: null, rows: [], rootBrokerId: null };

  const pool = await getPool();
  const result = await pool.request()
    .input('exportId', sql.UniqueIdentifier, latest.ExportId)
    .query(`
      SELECT AgentId, ParentAgentId, Label, Depth, SortOrder, ChildCount, IsGroup
      FROM oe.MigrationE123AgentNode
      WHERE ExportId = @exportId
      ORDER BY Depth, SortOrder, Label, AgentId
    `);

  return {
    exportId: latest.ExportId,
    rootBrokerId: latest.RootBrokerId,
    rows: result.recordset || []
  };
}

function collectSubtreeBrokerIds(rows, rootBrokerId, includeDownline) {
  const rootId = Number(rootBrokerId);
  const byParent = new Map();
  for (const row of rows) {
    const agentId = Number(row.AgentId);
    const parentId = row.ParentAgentId != null ? Number(row.ParentAgentId) : null;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(agentId);
  }

  const ids = new Set([rootId]);
  if (!includeDownline) return ids;

  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift();
    const children = byParent.get(current) || [];
    for (const childId of children) {
      if (!ids.has(childId)) {
        ids.add(childId);
        queue.push(childId);
      }
    }
  }
  return ids;
}

function detectCycle(nodes) {
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(nodes.map((n) => [n.e123BrokerId, n]));

  function dfs(id) {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    const node = byId.get(id);
    const parentId = node?.parentE123BrokerId;
    if (parentId && byId.has(parentId) && dfs(parentId)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const node of nodes) {
    if (dfs(node.e123BrokerId)) return true;
  }
  return false;
}

function topologicalSortNodes(nodes) {
  const byId = new Map(nodes.map((n) => [n.e123BrokerId, n]));
  const inDegree = new Map(nodes.map((n) => [n.e123BrokerId, 0]));

  for (const node of nodes) {
    const parentId = node.parentE123BrokerId;
    if (parentId && byId.has(parentId)) {
      inDegree.set(node.e123BrokerId, (inDegree.get(node.e123BrokerId) || 0) + 1);
    }
  }

  const queue = nodes
    .filter((n) => (inDegree.get(n.e123BrokerId) || 0) === 0)
    .sort((a, b) => a.depth - b.depth || a.e123BrokerId - b.e123BrokerId)
    .map((n) => n.e123BrokerId);

  const ordered = [];
  while (queue.length) {
    const id = queue.shift();
    const node = byId.get(id);
    if (node) ordered.push(node);
    for (const child of nodes) {
      if (child.parentE123BrokerId === id) {
        const nextDeg = (inDegree.get(child.e123BrokerId) || 0) - 1;
        inDegree.set(child.e123BrokerId, nextDeg);
        if (nextDeg === 0) queue.push(child.e123BrokerId);
      }
    }
  }

  if (ordered.length < nodes.length) {
    const remaining = nodes.filter((n) => !ordered.find((o) => o.e123BrokerId === n.e123BrokerId));
    return ordered.concat(remaining.sort((a, b) => a.depth - b.depth));
  }
  return ordered;
}

async function lookupUserByEmail(email) {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized) return [];

  const pool = await getPool();
  const result = await pool.request()
    .input('email', sql.NVarChar, normalized)
    .query(`
      SELECT
        u.UserId,
        u.TenantId,
        u.Email,
        u.FirstName,
        u.LastName,
        u.Status AS UserStatus,
        a.AgentId,
        a.Status AS AgentStatus,
        a.TenantId AS AgentTenantId
      FROM oe.Users u
      LEFT JOIN oe.Agents a ON a.UserId = u.UserId AND a.Status = N'Active'
      WHERE LOWER(LTRIM(RTRIM(u.Email))) = @email
    `);
  return result.recordset || [];
}

async function getAgentTierLevel(agentId) {
  if (!agentId) return null;
  const pool = await getPool();
  const result = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .query(`
      SELECT TOP 1
        a.CommissionTierLevel,
        cl.SortOrder AS LevelSortOrder
      FROM oe.Agents a
      LEFT JOIN oe.CommissionLevels cl ON cl.CommissionLevelId = a.CommissionLevelId
      WHERE a.AgentId = @agentId
    `);
  const row = result.recordset?.[0];
  if (!row) return null;
  if (row.LevelSortOrder != null) return Number(row.LevelSortOrder);
  if (row.CommissionTierLevel != null) return Number(row.CommissionTierLevel);
  return null;
}

async function classifyBroker({
  tenantId,
  instanceId,
  e123BrokerId,
  hints,
  draftOverrides = {}
}) {
  const brokerId = Number(e123BrokerId);
  if (draftOverrides.excluded) {
    return {
      e123BrokerId: brokerId,
      action: 'excluded',
      matchStatus: 'excluded',
      existingAgentId: null,
      existingUserId: null,
      conflictReason: null
    };
  }

  const saved = await agentMapService.getAgentMap({ instanceId, e123BrokerId: brokerId });
  if (saved?.AgentId) {
    const inTenant = await verifyAgentInTenant(saved.AgentId, tenantId);
    if (inTenant) {
      return {
        e123BrokerId: brokerId,
        action: 'map_existing',
        matchStatus: 'mapped',
        existingAgentId: saved.AgentId,
        existingUserId: null,
        conflictReason: null,
        matchMethod: saved.MatchMethod || 'saved'
      };
    }
    return {
      e123BrokerId: brokerId,
      action: 'conflict',
      matchStatus: 'cross_tenant',
      existingAgentId: saved.AgentId,
      existingUserId: null,
      conflictReason: 'saved_map_cross_tenant'
    };
  }

  let match = null;
  if (hints?.email) {
    match = await findActiveAgentByEmail(tenantId, hints.email);
  }
  if (!match?.agentId && hints?.firstName && hints?.lastName) {
    match = await findActiveAgentByExactName(tenantId, hints.firstName, hints.lastName);
  }
  if (match?.agentId) {
    return {
      e123BrokerId: brokerId,
      action: 'map_existing',
      matchStatus: 'mapped',
      existingAgentId: match.agentId,
      existingUserId: null,
      conflictReason: null,
      matchMethod: match.method
    };
  }

  if (hints?.email) {
    const users = await lookupUserByEmail(hints.email);
    const sameTenant = users.filter((u) => u.TenantId && `${u.TenantId}`.toLowerCase() === `${tenantId}`.toLowerCase());
    const otherTenant = users.filter((u) => u.TenantId && `${u.TenantId}`.toLowerCase() !== `${tenantId}`.toLowerCase());

    if (otherTenant.length > 0 && sameTenant.length === 0) {
      return {
        e123BrokerId: brokerId,
        action: 'conflict',
        matchStatus: 'cross_tenant',
        existingAgentId: otherTenant[0].AgentId || null,
        existingUserId: otherTenant[0].UserId,
        conflictReason: 'email_exists_other_tenant'
      };
    }

    if (sameTenant.length === 1) {
      const row = sameTenant[0];
      if (row.AgentId) {
        return {
          e123BrokerId: brokerId,
          action: 'map_existing',
          matchStatus: 'mapped',
          existingAgentId: row.AgentId,
          existingUserId: row.UserId,
          conflictReason: null,
          matchMethod: 'email'
        };
      }
      return {
        e123BrokerId: brokerId,
        action: 'promote_user',
        matchStatus: 'existing_user',
        existingAgentId: null,
        existingUserId: row.UserId,
        conflictReason: null,
        matchMethod: 'email'
      };
    }
  }

  return {
    e123BrokerId: brokerId,
    action: 'create_new',
    matchStatus: 'new',
    existingAgentId: null,
    existingUserId: null,
    conflictReason: null,
    matchMethod: null
  };
}

async function enrichBrokerProfile(instanceId, brokerId) {
  return runWithInstanceE123Config(instanceId, async () => {
    try {
      const profile = await getAgentProfileById(brokerId);
      return {
        e123BrokerId: brokerId,
        label: profile.label || null,
        firstName: profile.firstName || null,
        lastName: profile.lastName || null,
        email: profile.email || null,
        active: profile.active,
        parentE123BrokerId: typeof profile.parent === 'object'
          ? Number(profile.parent?.id || profile.parent?.ID) || null
          : Number(profile.parent) || null
      };
    } catch {
      const hints = await fetchE123BrokerHints(brokerId, instanceId);
      return {
        e123BrokerId: brokerId,
        label: hints?.label || `Broker ${brokerId}`,
        firstName: hints?.firstName || null,
        lastName: hints?.lastName || null,
        email: hints?.email || null,
        active: null,
        parentE123BrokerId: null
      };
    }
  });
}

function getNodeOverrides(draft, brokerId) {
  return draft?.nodeOverrides?.[brokerId]
    || draft?.nodeOverrides?.[String(brokerId)]
    || {};
}

/** Legacy workspace builds tagged migration roots as map_agency — treat as normal agents. */
function normalizeLegacyBrokerAction(node) {
  if (node.action !== 'map_agency') return node;
  return {
    ...node,
    action: 'create_new',
    matchStatus: node.matchStatus === 'agency_anchor' ? 'new' : (node.matchStatus || 'new'),
    matchMethod: node.matchMethod === 'selected_agency' ? null : node.matchMethod,
    mappedAgencyId: null,
    existingAgentId: null,
    resolvedAb365AgentId: null
  };
}

const WORKSPACE_SCHEMA_VERSION = 4;

function draftWorkspaceCacheKey(draft = {}) {
  return JSON.stringify({
    workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
    importSettings: normalizeImportSettings(draft),
    rosterKey: draft.commissionRoster
      ? `${draft.commissionRoster.fileName || ''}:${draft.commissionRoster.matchedCount || 0}:${draft.commissionRoster.rowCount || 0}`
      : null
  });
}

function normalizeWorkspaceResult(workspace) {
  if (!workspace?.brokers?.length) return workspace;

  function normalizeTreeNode(node) {
    if (!node) return node;
    const normalized = normalizeLegacyBrokerAction(node);
    return {
      ...normalized,
      children: (node.children || []).map(normalizeTreeNode)
    };
  }

  const brokers = workspace.brokers.map(normalizeLegacyBrokerAction);
  const createCount = brokers.filter((b) => b.action === 'create_new' || b.action === 'promote_user').length;
  const mapOnlyCount = brokers.filter((b) => b.action === 'map_existing' || b.action === 'map_agency').length;

  return {
    ...workspace,
    brokers,
    tree: workspace.tree
      ? {
        ...workspace.tree,
        root: normalizeTreeNode(workspace.tree.root),
        nodes: (workspace.tree.nodes || []).map(normalizeTreeNode)
      }
      : workspace.tree,
    validation: workspace.validation
      ? { ...workspace.validation, createCount, mapOnlyCount }
      : workspace.validation
  };
}

function getCachedWorkspace(batch) {
  const build = parseJsonSafe(batch?.SummaryJson, {})?.workspaceBuild;
  if (build?.phase !== 'complete' || !build?.result) return null;
  const draft = parseJsonSafe(batch?.DraftJson, {}) || {};
  const cachedKey = build.importSettingsKey;
  const currentKey = draftWorkspaceCacheKey(draft);
  if (cachedKey && cachedKey !== currentKey) return null;
  return normalizeWorkspaceResult(build.result);
}

async function loadAgencyCommissionGroupId(agencyId, tenantId) {
  if (!agencyId || !tenantId) return null;
  const pool = await getPool();
  const res = await pool.request()
    .input('AgencyId', sql.UniqueIdentifier, agencyId)
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT TOP 1 CommissionGroupId
      FROM oe.Agencies
      WHERE AgencyId = @AgencyId AND TenantId = @TenantId
    `);
  return res.recordset?.[0]?.CommissionGroupId?.toString() || null;
}

async function uploadCommissionRoster(batchId, { buffer, fileName, tenantId }) {
  const batch = await getBatch(batchId);
  if (!batch) {
    const err = new Error('Agent import batch not found');
    err.status = 404;
    throw err;
  }
  const effectiveTenantId = tenantId || batch.TenantId;
  if (!effectiveTenantId) {
    const err = new Error('TenantId is required before uploading commission roster');
    err.status = 400;
    throw err;
  }

  const parsed = commissionRosterService.parseRosterBuffer(buffer, fileName);
  const resolved = await commissionRosterService.resolveRosterForTenant(parsed.entries, effectiveTenantId);
  const draft = parseJsonSafe(batch.DraftJson, {}) || {};
  draft.commissionRoster = {
    fileName: fileName || parsed.fileName || null,
    rowCount: parsed.rowCount,
    matchedCount: resolved.matchedCount,
    warnings: (resolved.warnings || []).slice(0, 50),
    byBrokerId: resolved.byBrokerId
  };
  await patchBatch(batchId, { draftJson: draft });
  return draft.commissionRoster;
}

async function listCommissionGroupsForTenant(tenantId) {
  return commissionRosterService.listCommissionGroupsForTenant(tenantId);
}

async function buildAgentMigrationWorkspace(batchId, { enrichProfiles = true, onProgress = null } = {}) {
  const batch = await getBatch(batchId);
  if (!batch) {
    const err = new Error('Agent import batch not found');
    err.status = 404;
    throw err;
  }
  if (!batch.TenantId) {
    const err = new Error('TenantId is required');
    err.status = 400;
    throw err;
  }

  const payablesForBatch = await resolvePayablesForBatch(batch);

  if (enrichProfiles) {
    const cached = getCachedWorkspace(batch);
    if (cached) return cached;
  }

  const report = onProgress
    ? (partial) => reportWorkspaceBuildProgress(batchId, partial)
    : null;

  const draft = parseJsonSafe(batch.DraftJson, { nodeOverrides: {} }) || { nodeOverrides: {} };
  const importSettings = normalizeImportSettings(draft);
  draft.importSettings = importSettings;

  if (report) {
    await report({ phase: 'loading_tree', processed: 0, total: 0, currentLabel: null, currentBrokerId: null });
  }

  const { rows, rootBrokerId: exportRoot } = await loadTreeRowsForInstance(batch.InstanceId);
  if (!rows.length) {
    const err = new Error('Upload an E123 agent tree CSV for this migration instance first');
    err.code = 'E123_AGENT_TREE_NOT_CONFIGURED';
    err.status = 400;
    throw err;
  }

  const excluded = computeExcludedAgentIds(rows, { orgBrokerId: exportRoot });

  let scopeIdSet = collectSubtreeBrokerIds(
    rows.filter((r) => !excluded.has(Number(r.AgentId))),
    batch.RootBrokerId,
    !!batch.IncludeDownline
  );
  let noMembersExcludedCount = 0;
  let noEmailExcludedCount = 0;

  if (importSettings.excludeAgentsWithNoMembers) {
    if (report) {
      await report({
        phase: 'loading_e123_members',
        processed: 0,
        total: 0,
        currentLabel: 'Counting active E123 members…',
        currentBrokerId: null
      });
    }
    const directCounts = await loadDirectActiveMemberCountsByBroker({
      instanceId: batch.InstanceId,
      rootBrokerId: batch.RootBrokerId,
      includeDownline: !!batch.IncludeDownline,
      onPage: report
        ? async (page) => {
          await report({
            phase: 'loading_e123_members',
            processed: page.membersLoaded,
            total: page.usersTotal || page.membersLoaded,
            currentLabel: `E123 members ${page.membersLoaded}`,
            currentBrokerId: null
          });
        }
        : null
    });
    const subtreeCounts = computeSubtreeActiveMemberCounts(
      [...scopeIdSet],
      rows,
      directCounts
    );
    const filtered = filterScopeBrokerIdsByActiveMembers(
      [...scopeIdSet],
      subtreeCounts,
      { keepBrokerIds: [batch.RootBrokerId] }
    );
    scopeIdSet = new Set(filtered.scopeIds);
    noMembersExcludedCount = filtered.excludedCount;
    logWorkspace(
      batchId,
      'excluded brokers with no active members',
      `removed=${noMembersExcludedCount} remaining=${scopeIdSet.size}`
    );
  }

  let scopeIds = [...scopeIdSet];

  logWorkspace(batchId, 'scope resolved', `brokers=${scopeIds.length} enrich=${enrichProfiles}`);

  if (report) {
    await report({
      phase: 'loading_tree',
      processed: 0,
      total: scopeIds.length,
      currentLabel: null,
      currentBrokerId: null
    });
  }

  const rowById = new Map(rows.map((r) => [Number(r.AgentId), r]));

  let enrichCompleted = 0;
  const profileByBrokerId = new Map();

  const enrichTotal = scopeIds.length;

  if (enrichProfiles) {
    await runPool(scopeIds, E123_ENRICH_CONCURRENCY, async (brokerId) => {
      const treeRow = rowById.get(brokerId);
      let profile = {
        e123BrokerId: brokerId,
        label: treeRow?.Label || `Broker ${brokerId}`,
        firstName: null,
        lastName: null,
        email: null,
        active: null,
        parentE123BrokerId: treeRow?.ParentAgentId != null ? Number(treeRow.ParentAgentId) : null
      };

      const enriched = await enrichBrokerProfile(batch.InstanceId, brokerId);
      profile = { ...profile, ...enriched };
      if (treeRow?.ParentAgentId != null && !profile.parentE123BrokerId) {
        profile.parentE123BrokerId = Number(treeRow.ParentAgentId);
      }

      profileByBrokerId.set(brokerId, profile);
      enrichCompleted += 1;
      if (report) {
        await report({
          phase: 'enriching_e123',
          processed: enrichCompleted,
          total: enrichTotal,
          currentBrokerId: brokerId,
          currentLabel: profile.label
        });
      }
      return profile;
    });
  } else {
    for (const brokerId of scopeIds) {
      const treeRow = rowById.get(brokerId);
      profileByBrokerId.set(brokerId, {
        e123BrokerId: brokerId,
        label: treeRow?.Label || `Broker ${brokerId}`,
        firstName: null,
        lastName: null,
        email: null,
        active: null,
        parentE123BrokerId: treeRow?.ParentAgentId != null ? Number(treeRow.ParentAgentId) : null
      });
    }
  }

  if (importSettings.excludeAgentsWithoutEmail) {
    const emailFiltered = filterScopeBrokerIdsWithoutEmail(
      scopeIds,
      profileByBrokerId,
      { keepBrokerIds: [batch.RootBrokerId] }
    );
    scopeIds = emailFiltered.scopeIds;
    scopeIdSet = new Set(scopeIds);
    noEmailExcludedCount = emailFiltered.excludedCount;
    logWorkspace(
      batchId,
      'excluded brokers without email',
      `removed=${noEmailExcludedCount} remaining=${scopeIds.length}`
    );
  }

  let classifyCompleted = 0;
  const classifyTotal = scopeIds.length;
  const stubResults = await runPool(scopeIds, CLASSIFY_CONCURRENCY, async (brokerId) => {
    const treeRow = rowById.get(brokerId);
    const override = draft.nodeOverrides?.[brokerId] || draft.nodeOverrides?.[String(brokerId)] || {};
    const profile = profileByBrokerId.get(brokerId) || {
      e123BrokerId: brokerId,
      label: treeRow?.Label || `Broker ${brokerId}`,
      firstName: null,
      lastName: null,
      email: null,
      active: null,
      parentE123BrokerId: treeRow?.ParentAgentId != null ? Number(treeRow.ParentAgentId) : null
    };

    const hints = {
      label: profile.label,
      firstName: profile.firstName,
      lastName: profile.lastName,
      email: profile.email
    };

    let classification;
    if (override.linkedAgentId) {
      classification = await resolveLinkedAgentClassification({
        tenantId: batch.TenantId,
        e123BrokerId: brokerId,
        linkedAgentId: override.linkedAgentId
      });
    }
    if (!classification && override.linkedUserId) {
      classification = await resolveLinkedUserClassification({
        tenantId: batch.TenantId,
        e123BrokerId: brokerId,
        linkedUserId: override.linkedUserId
      });
    }
    if (!classification) {
      classification = await classifyBroker({
        tenantId: batch.TenantId,
        instanceId: batch.InstanceId,
        e123BrokerId: brokerId,
        hints,
        draftOverrides: override
      });
    }

    let existingTierLevel = null;
    let existingTierLabel = null;
    let existingAgentName = null;
    if (classification.action === 'map_existing' && classification.existingAgentId) {
      existingTierLevel = await getAgentTierLevel(classification.existingAgentId);
      const summary = await getAgentSummary(classification.existingAgentId, batch.TenantId);
      existingAgentName = summary?.displayName || null;

      const autoPersistMethods = new Set(['email', 'name', 'saved']);
      if (autoPersistMethods.has(classification.matchMethod)) {
        const saved = await agentMapService.getAgentMap({
          instanceId: batch.InstanceId,
          e123BrokerId: brokerId
        });
        if (!saved?.AgentId) {
          await agentMapService.upsertAgentMap({
            instanceId: batch.InstanceId,
            e123BrokerId: brokerId,
            agentId: classification.existingAgentId,
            matchMethod: classification.matchMethod,
            e123AgentLabel: profile.label || null
          });
        }
      }
    }

    classifyCompleted += 1;
    if (report) {
      await report({
        phase: 'classifying',
        processed: classifyCompleted,
        total: classifyTotal,
        currentBrokerId: brokerId,
        currentLabel: profile.label
      });
    }

    return {
      e123BrokerId: brokerId,
      label: profile.label,
      firstName: profile.firstName,
      lastName: profile.lastName,
      email: profile.email,
      active: profile.active,
      isGroup: treeRow?.IsGroup == null ? null : !!treeRow.IsGroup,
      depth: Number(treeRow?.Depth) || 0,
      parentE123BrokerId: profile.parentE123BrokerId,
      parentLabel: profile.parentE123BrokerId != null
        ? (rowById.get(profile.parentE123BrokerId)?.Label || null)
        : null,
      childCount: Number(treeRow?.ChildCount) || 0,
      action: classification.action,
      matchStatus: classification.matchStatus,
      matchMethod: classification.matchMethod || null,
      conflictReason: classification.conflictReason,
      existingAgentId: classification.existingAgentId,
      existingAgentName,
      existingUserId: classification.existingUserId,
      resolvedAb365AgentId: classification.existingAgentId || null,
      mappedAgencyId: classification.mappedAgencyId || null,
      uplineAb365AgentId: null,
      tierLevel: override.tierLevel != null ? Number(override.tierLevel) : DEFAULT_TIER_LEVEL,
      defaultTierLevel: DEFAULT_TIER_LEVEL,
      existingTierLevel,
      existingTierLabel,
      skipAch: !!override.skipAch,
      missingParentInScope: false,
      parentE123ForUpline: profile.parentE123BrokerId
    };
  });

  const brokerStubs = stubResults.filter(Boolean);

  if (report) {
    await report({ phase: 'computing_tiers', processed: 0, total: brokerStubs.length, currentLabel: null });
  }

  const brokers = [];
  const sortedStubs = [...brokerStubs].sort((a, b) => a.depth - b.depth || a.e123BrokerId - b.e123BrokerId);
  let tierIndex = 0;
  for (const node of sortedStubs) {
    const parentE123 = node.parentE123ForUpline;
    let uplineAb365AgentId = null;
    let uplineTierLevel = null;
    let uplineIsAgency = false;
    const isMigrationRoot = Number(node.e123BrokerId) === Number(batch.RootBrokerId);
    const override = draft.nodeOverrides?.[node.e123BrokerId]
      || draft.nodeOverrides?.[String(node.e123BrokerId)]
      || {};

    if (isMigrationRoot) {
      const parentRef = parseParentAb365Ref(override.parentAb365Id, batch);
      if (parentRef?.type === 'agency') {
        uplineAb365AgentId = parentRef.id;
        uplineIsAgency = true;
      } else if (parentRef?.type === 'agent') {
        uplineAb365AgentId = parentRef.id;
        uplineTierLevel = await getAgentTierLevel(parentRef.id);
      }
    } else if (parentE123 && Number(parentE123) === Number(batch.RootBrokerId)) {
      const rootNode = brokers.find((b) => b.e123BrokerId === parentE123)
        || sortedStubs.find((b) => b.e123BrokerId === parentE123);
      if (rootNode?.resolvedAb365AgentId) {
        uplineAb365AgentId = rootNode.resolvedAb365AgentId;
        uplineTierLevel = rootNode.tierLevel;
      } else if (rootNode?.tierLevel != null) {
        // Migration root not linked yet — still compute downline tiers from root's level.
        uplineTierLevel = rootNode.tierLevel;
      } else if (batch.AgencyId) {
        uplineAb365AgentId = batch.AgencyId;
        uplineIsAgency = true;
      }
    } else if (parentE123 && scopeIdSet.has(parentE123)) {
      const parentNode = brokers.find((b) => b.e123BrokerId === parentE123)
        || sortedStubs.find((b) => b.e123BrokerId === parentE123);
      if (parentNode?.resolvedAb365AgentId) {
        uplineAb365AgentId = parentNode.resolvedAb365AgentId;
        uplineTierLevel = parentNode.tierLevel;
      }
    } else if (parentE123) {
      const parentMap = await agentMapService.getAgentMap({
        instanceId: batch.InstanceId,
        e123BrokerId: parentE123
      });
      if (parentMap?.AgentId && await verifyAgentInTenant(parentMap.AgentId, batch.TenantId)) {
        uplineAb365AgentId = parentMap.AgentId;
        uplineTierLevel = await getAgentTierLevel(parentMap.AgentId);
      }
    }

    const defaultTier = node.existingTierLevel != null && node.action === 'map_existing'
      ? node.existingTierLevel
      : defaultTierForUpline(uplineTierLevel, { parentIsAgency: uplineIsAgency });
    const tierLevel = override.tierLevel != null ? Number(override.tierLevel) : defaultTier;

    brokers.push({
      ...node,
      uplineAb365AgentId,
      tierLevel,
      defaultTierLevel: defaultTier,
      missingParentInScope: isMigrationRoot
        ? false
        : !!(parentE123 && !scopeIdSet.has(parentE123) && !uplineAb365AgentId)
    });

    tierIndex += 1;
    if (report && (tierIndex % 25 === 0 || tierIndex === sortedStubs.length)) {
      await report({
        phase: 'computing_tiers',
        processed: tierIndex,
        total: sortedStubs.length,
        currentBrokerId: node.e123BrokerId,
        currentLabel: node.label
      });
    }
  }

  const hasCycle = detectCycle(brokers);
  const payablesAgents = payablesForBatch.agents || {};
  const { levelNameBySort } = batch.TenantId
    ? await loadCommissionLevelContext(batch.TenantId)
    : { levelNameBySort: new Map() };

  const enrichedBrokers = brokers.map((b) => {
    const existingTierLabel = b.existingTierLevel != null
      ? (levelNameBySort.get(b.existingTierLevel) || `Level ${b.existingTierLevel}`)
      : b.existingTierLabel;
    const withTierLabel = existingTierLabel != null
      ? { ...b, existingTierLabel }
      : b;
    const payRow = payablesAgents[String(withTierLabel.e123BrokerId)] || null;
    const enriched = enrichBrokerWithPayables(withTierLabel, payRow);
    const override = getNodeOverrides(draft, b.e123BrokerId);
    if (
      override.tierLevel == null
      && enriched.suggestedTierFromPayables != null
      && enriched.action !== 'map_existing'
    ) {
      return { ...enriched, tierLevel: enriched.suggestedTierFromPayables };
    }
    return enriched;
  });

  const agencyDefaultGroupId = batch.AgencyId && batch.TenantId
    ? await loadAgencyCommissionGroupId(batch.AgencyId, batch.TenantId)
    : null;
  const rosterByBroker = draft.commissionRoster?.byBrokerId || {};
  const rosterMatchedCount = Object.keys(rosterByBroker).length;

  const withRoster = enrichedBrokers.map((b) => {
    const normalized = normalizeLegacyBrokerAction(b);
    const override = getNodeOverrides(draft, b.e123BrokerId);
    const rosterEntry = rosterByBroker[String(b.e123BrokerId)] || null;
    let applied = commissionRosterService.applyRosterToBroker(
      normalized,
      rosterEntry,
      override,
      agencyDefaultGroupId
    );
    if (override.commissionGroupId) {
      applied = { ...applied, commissionGroupId: override.commissionGroupId };
    }
    if (override.tierLevel != null) {
      applied = { ...applied, tierLevel: Number(override.tierLevel) };
    }
    const payablesTierMatched = applied.tierMatchConfidence
      && applied.tierMatchConfidence !== 'none'
      && applied.suggestedTierFromPayables != null;
    return {
      ...applied,
      payablesTierMatched: !!payablesTierMatched
    };
  });

  const tierable = withRoster.filter(
    (b) => b.action === 'create_new' || b.action === 'promote_user'
  );
  const payablesTierStats = {
    tierableCount: tierable.length,
    matchedCount: tierable.filter((b) => b.payablesTierMatched).length,
    lowConfidenceCount: tierable.filter((b) => b.tierMatchConfidence === 'low').length,
    noMatchCount: tierable.filter(
      (b) => b.payablesInCsv && !b.payablesTierMatched && (b.payablesSellerLineCount ?? 0) > 0
    ).length,
    notInCsvCount: tierable.filter((b) => b.payablesInCsv === false).length,
    uplineOnlyCount: tierable.filter(
      (b) => b.payablesInCsv && (b.payablesSellerLineCount ?? 0) === 0 && (b.payablesOverrideLineCount ?? 0) > 0
    ).length
  };

  const tree = buildTreeDto(withRoster, batch.RootBrokerId);

  return {
    batch: mapBatchRow(batch),
    brokers: withRoster,
    tree,
    payables: payablesForBatch,
    payablesTierStats,
    commissionRoster: draft.commissionRoster
      ? {
        fileName: draft.commissionRoster.fileName,
        rowCount: draft.commissionRoster.rowCount,
        matchedCount: draft.commissionRoster.matchedCount,
        rosterMatchedCount
      }
      : null,
    commissionGroups: batch.TenantId
      ? await listCommissionGroupsForTenant(batch.TenantId)
      : [],
    validation: {
      hasCycle,
      orphanCount: withRoster.filter((b) => b.missingParentInScope).length,
      conflictCount: withRoster.filter((b) => b.action === 'conflict').length,
      createCount: withRoster.filter((b) => b.action === 'create_new' || b.action === 'promote_user').length,
      mapOnlyCount: withRoster.filter((b) => b.action === 'map_existing' || b.action === 'map_agency').length,
      excludedCount: withRoster.filter((b) => b.action === 'excluded').length,
      excludeAgentsWithNoMembers: importSettings.excludeAgentsWithNoMembers,
      excludeAgentsWithoutEmail: importSettings.excludeAgentsWithoutEmail,
      noMembersExcludedCount,
      noEmailExcludedCount
    }
  };
}

function buildTreeDto(brokers, rootBrokerId) {
  const byParent = new Map();
  for (const b of brokers) {
    const parentKey = b.parentE123BrokerId ?? '__root__';
    if (!byParent.has(parentKey)) byParent.set(parentKey, []);
    byParent.get(parentKey).push(b);
  }

  function buildChildren(parentId) {
    const key = parentId ?? '__root__';
    const children = (byParent.get(key) || [])
      .filter((c) => c.e123BrokerId !== rootBrokerId || parentId != null)
      .sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label));

    return children.map((node) => ({
      e123BrokerId: node.e123BrokerId,
      label: node.label,
      action: node.action,
      matchStatus: node.matchStatus,
      tierLevel: node.tierLevel,
      children: buildChildren(node.e123BrokerId)
    }));
  }

  const root = brokers.find((b) => b.e123BrokerId === Number(rootBrokerId));
  return {
    rootBrokerId: Number(rootBrokerId),
    root: root ? {
      ...root,
      children: buildChildren(root.e123BrokerId)
    } : null,
    nodes: buildChildren(null)
  };
}

function mapBatchRow(row) {
  return {
    batchId: row.BatchId,
    instanceId: row.InstanceId,
    rootBrokerId: row.RootBrokerId,
    rootAgentLabel: row.RootAgentLabel,
    includeDownline: !!row.IncludeDownline,
    tenantId: row.TenantId,
    agencyId: row.AgencyId,
    wizardStep: row.WizardStep,
    status: row.Status,
    draftJson: parseJsonSafe(row.DraftJson, {}),
    summaryJson: parseJsonSafe(row.SummaryJson, {})
  };
}

async function previewAgentMigration(batchId) {
  const batch = await getBatch(batchId);
  const cached = batch ? getCachedWorkspace(batch) : null;
  const workspace = cached || await buildAgentMigrationWorkspace(batchId, { enrichProfiles: false });
  const applicable = workspace.brokers.filter((b) => b.action !== 'excluded' && b.action !== 'conflict');

  const summary = {
    totalBrokers: workspace.brokers.length,
    mapExisting: workspace.brokers.filter((b) => b.action === 'map_existing').length,
    promoteUser: workspace.brokers.filter((b) => b.action === 'promote_user').length,
    createNew: workspace.brokers.filter((b) => b.action === 'create_new').length,
    conflicts: workspace.brokers.filter((b) => b.action === 'conflict').length,
    excluded: workspace.brokers.filter((b) => b.action === 'excluded').length,
    missingParent: workspace.brokers.filter((b) => b.missingParentInScope).length,
    hasCycle: workspace.validation.hasCycle,
    canApply: !workspace.validation.hasCycle
      && workspace.brokers.filter((b) => b.action === 'conflict').length === 0
  };

  await mergeBatchSummaryJson(batchId, (cur) => ({
    ...cur,
    preview: summary
  }));

  await patchBatch(batchId, { status: 'ready' });

  return { workspace, summary };
}

async function insertAgentBankInfo(transaction, {
  agentId,
  ach,
  accountName,
  createdBy
}) {
  if (!ach?.routingNumber || !ach?.accountNumber) return null;

  const bankInfoId = uuidv4();
  const bankRequest = transaction.request();
  bankRequest.input('BankInfoId', sql.UniqueIdentifier, bankInfoId);
  bankRequest.input('AgentId', sql.UniqueIdentifier, agentId);
  bankRequest.input('BankName', sql.NVarChar, ach.bankName || 'Bank');
  bankRequest.input('AccountName', sql.NVarChar, accountName || 'Agent');
  bankRequest.input('AccountHolderType', sql.NVarChar, 'Individual');
  bankRequest.input('AccountType', sql.NVarChar, ach.accountType || 'Checking');
  bankRequest.input('RoutingNumber', sql.NVarChar, ach.routingNumber);
  bankRequest.input('AccountNumberEncrypted', sql.NVarChar, encryptionService.encrypt(ach.accountNumber));
  bankRequest.input('AccountNumberLast4', sql.NVarChar, ach.accountNumberLast4 || ach.accountNumber.slice(-4));
  bankRequest.input('Status', sql.NVarChar, 'Active');
  bankRequest.input('IsDefault', sql.Bit, 1);
  bankRequest.input('VerificationStatus', sql.NVarChar, 'Pending');
  bankRequest.input('CreatedBy', sql.UniqueIdentifier, createdBy);

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
  return bankInfoId;
}

async function insertAgentHierarchy(transaction, {
  tenantId,
  agencyId,
  agentId,
  parentId,
  parentIsAgency = false
}) {
  const hierarchyId = uuidv4();
  const hierarchyRequest = transaction.request();
  hierarchyRequest.input('HierarchyId', sql.UniqueIdentifier, hierarchyId);
  hierarchyRequest.input('Type', sql.NVarChar, 'Agent');
  hierarchyRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
  hierarchyRequest.input('AgencyId', sql.UniqueIdentifier, agencyId || null);
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
}

async function resolveCommissionLevelId(transaction, tenantId, sortOrder, fallbackLevelId = null) {
  if (fallbackLevelId) return fallbackLevelId;
  if (sortOrder == null) return null;
  const res = await transaction.request()
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .input('SortOrder', sql.Int, Number(sortOrder))
    .query(`
      SELECT TOP 1 CommissionLevelId
      FROM oe.CommissionLevels
      WHERE TenantId = @TenantId AND SortOrder = @SortOrder AND IsActive = 1
    `);
  return res.recordset?.[0]?.CommissionLevelId?.toString() || null;
}

async function agentHasActiveBankInfo(transaction, agentId) {
  const res = await transaction.request()
    .input('AgentId', sql.UniqueIdentifier, agentId)
    .query(`
      SELECT TOP 1 BankInfoId
      FROM oe.AgentBankInfo
      WHERE AgentId = @AgentId AND Status = N'Active'
    `);
  return !!res.recordset?.[0];
}

async function updateAgentCommissionFields(transaction, {
  agentId,
  tenantId,
  commissionGroupId,
  commissionLevelId,
  tierLevel,
  modifiedBy
}) {
  const levelId = await resolveCommissionLevelId(
    transaction,
    tenantId,
    tierLevel,
    commissionLevelId
  );
  const req = transaction.request();
  req.input('AgentId', sql.UniqueIdentifier, agentId);
  req.input('ModifiedBy', sql.UniqueIdentifier, modifiedBy);
  req.input('CommissionGroupId', sql.UniqueIdentifier, commissionGroupId || null);
  req.input('CommissionLevelId', sql.UniqueIdentifier, levelId || null);
  req.input('CommissionTierLevel', sql.Decimal(9, 4), tierLevel != null ? Number(tierLevel) : null);

  const columnCheck = await transaction.request().query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Agents'
      AND COLUMN_NAME IN ('CommissionGroupId', 'CommissionLevelId', 'CommissionTierLevel')
  `);
  const cols = new Set((columnCheck.recordset || []).map((r) => r.COLUMN_NAME));
  const sets = ['ModifiedDate = GETUTCDATE()', 'ModifiedBy = @ModifiedBy'];
  if (cols.has('CommissionGroupId') && commissionGroupId) {
    sets.push('CommissionGroupId = @CommissionGroupId');
  }
  if (cols.has('CommissionLevelId') && levelId) {
    sets.push('CommissionLevelId = @CommissionLevelId');
  }
  if (cols.has('CommissionTierLevel') && tierLevel != null) {
    sets.push('CommissionTierLevel = @CommissionTierLevel');
  }
  if (sets.length <= 2) return;

  await req.query(`
    UPDATE oe.Agents
    SET ${sets.join(', ')}
    WHERE AgentId = @AgentId
  `);
}

async function insertAgentBankInfoIfMissing(transaction, params) {
  const exists = await agentHasActiveBankInfo(transaction, params.agentId);
  if (exists) return null;
  return insertAgentBankInfo(transaction, params);
}

async function createAgentForBroker(transaction, {
  tenantId,
  agencyId,
  userId,
  email,
  firstName,
  lastName,
  phone,
  tierLevel,
  commissionGroupId = null,
  commissionLevelId = null,
  createdBy
}) {
  const agentId = uuidv4();
  const agentCode = await generateAgentCode(transaction, tenantId);
  const agentRequest = transaction.request();

  agentRequest.input('AgentId', sql.UniqueIdentifier, agentId);
  agentRequest.input('UserId', sql.UniqueIdentifier, userId);
  agentRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
  agentRequest.input('Status', sql.NVarChar, 'Active');
  agentRequest.input('AgencyId', sql.UniqueIdentifier, agencyId || null);
  agentRequest.input('Email', sql.NVarChar, email);
  agentRequest.input('FirstName', sql.NVarChar, firstName);
  agentRequest.input('LastName', sql.NVarChar, lastName);
  agentRequest.input('Phone', sql.NVarChar, phone || null);
  agentRequest.input('AgentCode', sql.NVarChar(50), agentCode);
  agentRequest.input('CommissionTierLevel', sql.Decimal(9, 4), tierLevel);
  agentRequest.input('CreatedBy', sql.UniqueIdentifier, createdBy);

  const resolvedLevelId = await resolveCommissionLevelId(
    transaction,
    tenantId,
    tierLevel,
    commissionLevelId
  );

  const columnCheck = await transaction.request().query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Agents'
      AND COLUMN_NAME IN ('CommissionTierLevel', 'AgentType', 'CommissionGroupId', 'CommissionLevelId')
  `);
  const cols = new Set((columnCheck.recordset || []).map((r) => r.COLUMN_NAME));

  const insertCols = [
    'AgentId', 'UserId', 'TenantId', 'Status', 'AgencyId',
    'Email', 'FirstName', 'LastName', 'Phone', 'AgentCode',
    'CreatedDate', 'ModifiedDate', 'CreatedBy', 'ModifiedBy'
  ];
  const insertVals = [
    '@AgentId', '@UserId', '@TenantId', '@Status', '@AgencyId',
    '@Email', '@FirstName', '@LastName', '@Phone', '@AgentCode',
    'GETUTCDATE()', 'GETUTCDATE()', '@CreatedBy', '@CreatedBy'
  ];

  if (cols.has('CommissionTierLevel')) {
    insertCols.push('CommissionTierLevel');
    insertVals.push('@CommissionTierLevel');
  }
  if (cols.has('CommissionGroupId') && commissionGroupId) {
    agentRequest.input('CommissionGroupId', sql.UniqueIdentifier, commissionGroupId);
    insertCols.push('CommissionGroupId');
    insertVals.push('@CommissionGroupId');
  }
  if (cols.has('CommissionLevelId') && resolvedLevelId) {
    agentRequest.input('CommissionLevelId', sql.UniqueIdentifier, resolvedLevelId);
    insertCols.push('CommissionLevelId');
    insertVals.push('@CommissionLevelId');
  }
  if (cols.has('AgentType')) {
    agentRequest.input('AgentType', sql.NVarChar, 'Individual');
    insertCols.push('AgentType');
    insertVals.push('@AgentType');
  }

  await agentRequest.query(`
    INSERT INTO oe.Agents (${insertCols.join(', ')})
    VALUES (${insertVals.join(', ')})
  `);

  return { agentId, agentCode };
}

async function applyAgentMigration(batchId, { createdBy, achByBrokerId = {} } = {}) {
  const batch = await getBatch(batchId);
  if (!batch?.TenantId) {
    const err = new Error('TenantId and agency are required before apply');
    err.status = 400;
    throw err;
  }

  const workspace = getCachedWorkspace(batch)
    || await buildAgentMigrationWorkspace(batchId, { enrichProfiles: true });
  if (workspace.validation.hasCycle) {
    const err = new Error('Cannot apply: parent cycle detected in E123 tree');
    err.status = 400;
    throw err;
  }

  const conflicts = workspace.brokers.filter((b) => b.action === 'conflict');
  if (conflicts.length) {
    const err = new Error(`Cannot apply: ${conflicts.length} broker(s) have cross-tenant or other conflicts`);
    err.status = 400;
    throw err;
  }

  await patchBatch(batchId, { status: 'applying' });

  const draft = parseJsonSafe(batch?.DraftJson, {}) || {};
  const pool = await getPool();
  const transaction = pool.transaction();
  const e123ToAb365 = new Map();
  const results = [];

  const ordered = [...workspace.brokers.filter((b) => b.action !== 'excluded')]
    .sort((a, b) => a.depth - b.depth || a.e123BrokerId - b.e123BrokerId);

  const roleAssignments = [];

  try {
    await transaction.begin();

    for (const node of ordered) {
      const brokerId = node.e123BrokerId;

      if (node.action === 'map_agency') {
        results.push({
          e123BrokerId: brokerId,
          action: 'agency_anchor',
          agencyId: batch.AgencyId,
          mapOnly: true
        });
        continue;
      }

      if (node.action === 'map_existing' && node.existingAgentId) {
        const override = getNodeOverrides(draft, brokerId);
        const skipAch = override.skipAch ?? node.skipAch;
        e123ToAb365.set(brokerId, node.existingAgentId);

        await updateAgentCommissionFields(transaction, {
          agentId: node.existingAgentId,
          tenantId: batch.TenantId,
          commissionGroupId: override.commissionGroupId ?? node.commissionGroupId,
          commissionLevelId: node.commissionLevelId,
          tierLevel: override.tierLevel ?? node.tierLevel,
          modifiedBy: createdBy
        });

        const achPayload = achByBrokerId[brokerId] || achByBrokerId[String(brokerId)];
        if (!skipAch && achPayload?.ach) {
          await insertAgentBankInfoIfMissing(transaction, {
            agentId: node.existingAgentId,
            ach: achPayload.ach,
            accountName: `${node.firstName || ''} ${node.lastName || ''}`.trim() || node.label || 'Agent',
            createdBy
          });
        }

        results.push({
          e123BrokerId: brokerId,
          action: 'mapped',
          agentId: node.existingAgentId,
          mapOnly: true
        });
        continue;
      }

      if (node.action !== 'create_new' && node.action !== 'promote_user') {
        results.push({ e123BrokerId: brokerId, action: 'skipped', reason: node.action });
        continue;
      }

      if (!node.email || !node.firstName || !node.lastName) {
        results.push({
          e123BrokerId: brokerId,
          action: 'error',
          message: 'Missing email or name from E123 profile'
        });
        continue;
      }

      let userId = node.existingUserId;
      if (!userId) {
        userId = uuidv4();
        const userRequest = transaction.request();
        userRequest.input('UserId', sql.UniqueIdentifier, userId);
        userRequest.input('FirstName', sql.NVarChar, node.firstName);
        userRequest.input('LastName', sql.NVarChar, node.lastName);
        userRequest.input('Email', sql.NVarChar, node.email);
        userRequest.input('Status', sql.NVarChar, 'Active');
        userRequest.input('TenantId', sql.UniqueIdentifier, batch.TenantId);
        userRequest.input('CreatedBy', sql.UniqueIdentifier, createdBy);
        await userRequest.query(`
          INSERT INTO oe.Users (
            UserId, FirstName, LastName, Email, Status, TenantId,
            CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
          ) VALUES (
            @UserId, @FirstName, @LastName, @Email, @Status, @TenantId,
            GETUTCDATE(), GETUTCDATE(), @CreatedBy, @CreatedBy
          )
        `);
      }

      const override = getNodeOverrides(draft, brokerId);
      const { agentId } = await createAgentForBroker(transaction, {
        tenantId: batch.TenantId,
        agencyId: batch.AgencyId,
        userId,
        email: node.email,
        firstName: node.firstName,
        lastName: node.lastName,
        tierLevel: override.tierLevel ?? node.tierLevel,
        commissionGroupId: override.commissionGroupId ?? node.commissionGroupId,
        commissionLevelId: node.commissionLevelId,
        createdBy
      });

      e123ToAb365.set(brokerId, agentId);

      let parentId = null;
      const parentE123 = node.parentE123BrokerId;
      if (parentE123 && e123ToAb365.has(parentE123)) {
        parentId = e123ToAb365.get(parentE123);
      } else if (!parentE123 || node.missingParentInScope) {
        parentId = batch.AgencyId || null;
      }

      if (parentId) {
        await insertAgentHierarchy(transaction, {
          tenantId: batch.TenantId,
          agencyId: batch.AgencyId,
          agentId,
          parentId
        });
      }

      const achPayload = achByBrokerId[brokerId] || achByBrokerId[String(brokerId)];
      const skipAch = override.skipAch ?? node.skipAch;
      if (!skipAch && achPayload?.ach) {
        await insertAgentBankInfoIfMissing(transaction, {
          agentId,
          ach: achPayload.ach,
          accountName: `${node.firstName} ${node.lastName}`.trim(),
          createdBy
        });
      }

      roleAssignments.push({ userId, agentId });

      results.push({
        e123BrokerId: brokerId,
        action: node.action === 'promote_user' ? 'promoted' : 'created',
        agentId,
        userId,
        mapMethod: node.action === 'promote_user' ? 'migration_promote' : 'migration_create'
      });
    }

    await transaction.commit();

    for (const row of results) {
      if (row.mapOnly && row.agentId) {
        await agentMapService.upsertAgentMap({
          instanceId: batch.InstanceId,
          e123BrokerId: row.e123BrokerId,
          agentId: row.agentId,
          matchMethod: 'migration_match',
          e123AgentLabel: null
        });
      } else if (row.agentId) {
        const brokerNode = workspace.brokers.find((b) => b.e123BrokerId === row.e123BrokerId);
        await agentMapService.upsertAgentMap({
          instanceId: batch.InstanceId,
          e123BrokerId: row.e123BrokerId,
          agentId: row.agentId,
          matchMethod: row.mapMethod || 'migration_create',
          e123AgentLabel: brokerNode?.label || null
        });
      }
    }

    for (const { userId } of roleAssignments) {
      try {
        await UserRolesService.assignRoleToUser(userId, 'Agent', createdBy);
      } catch {
        // role assign best-effort after commit
      }
    }

    const summary = {
      appliedUtc: new Date().toISOString(),
      created: results.filter((r) => r.action === 'created' || r.action === 'promoted').length,
      mapped: results.filter((r) => r.action === 'mapped').length,
      errors: results.filter((r) => r.action === 'error').length,
      results
    };

    await patchBatch(batchId, { status: 'applied', summaryJson: { apply: summary } });
    return { summary, results, workspace };
  } catch (err) {
    await transaction.rollback();
    await patchBatch(batchId, { status: 'failed', summaryJson: { error: err.message } });
    throw err;
  }
}

async function listAgenciesForTenant(tenantId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT AgencyId, AgencyName, Status
      FROM oe.Agencies
      WHERE TenantId = @tenantId AND Status = N'Active'
      ORDER BY AgencyName
    `);
  return (result.recordset || []).map((row) => ({
    agencyId: row.AgencyId,
    name: row.AgencyName,
    status: row.Status
  }));
}

async function fetchAchForBroker(instanceId, e123BrokerId) {
  return runWithInstanceE123Config(instanceId, () => fetchAgentAchBankInfo(e123BrokerId));
}

async function resolvePayablesForBatch(batch) {
  const stored = await payablesSnapshot.loadPayablesIndexForInstance(batch.InstanceId);
  if (!stored?.agents || !Object.keys(stored.agents).length) {
    const err = new Error(
      'Upload the most recent full-month E123 payables detail CSV under E123 migration data on the Migration Hub first.'
    );
    err.code = 'PAYABLES_CSV_REQUIRED';
    err.status = 400;
    throw err;
  }

  const { commissionGroupId, commissionGroupName, agents } = await applyTierInferenceToPayablesAgents(
    stored.agents,
    {
      agencyId: batch.AgencyId,
      tenantId: batch.TenantId,
      instanceId: batch.InstanceId
    }
  );

  return {
    ...stored,
    agents,
    commissionGroupId,
    commissionGroupName
  };
}

function normalizeDraftImportSettings(draft = {}) {
  return normalizeImportSettings(draft);
}

module.exports = {
  getBatch,
  createBatch,
  patchBatch,
  mapBatchRow,
  parseJsonSafe,
  mergeBatchSummaryJson,
  reportWorkspaceBuildProgress,
  getCachedWorkspace,
  buildAgentMigrationWorkspace,
  previewAgentMigration,
  applyAgentMigration,
  listAgenciesForTenant,
  fetchAchForBroker,
  resolvePayablesForBatch,
  defaultTierForUpline,
  topologicalSortNodes,
  collectSubtreeBrokerIds,
  uploadCommissionRoster,
  listCommissionGroupsForTenant,
  parseParentAb365Ref,
  resolveLinkedAgentClassification,
  resolveLinkedUserClassification,
  draftWorkspaceCacheKey,
  getNodeOverrides,
  normalizeDraftImportSettings
};

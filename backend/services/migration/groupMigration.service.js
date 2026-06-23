'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql, getPool } = require('../../config/database');
const e123GroupListSnapshot = require('./e123GroupListSnapshot.service');
const e123AgentTreeSnapshot = require('./e123AgentTreeSnapshot.service');
const { runWithInstanceE123Config } = require('./e123Config');
const { fetchAllUsersForBroker } = require('./e123Api.service');
const {
  classifyEmployerGroupRow,
  getGroupMigrationExclusionMessage
} = require('./e123GroupFilters');
const {
  loadAgentTreeRowsForInstance,
  buildParentByAgentId,
  buildScopeBrokerIds,
  isGroupInBrokerScope
} = require('./e123BrokerScope.service');

const MAX_AGENT_WALK_DEPTH = 25;

function parseJsonSafe(raw, fallback = null) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Batch CRUD (mirrors agentMigration.service.js pattern)
// ---------------------------------------------------------------------------

async function getBatch(batchId) {
  if (!batchId) return null;
  const pool = await getPool();
  const result = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT BatchId, InstanceId, TenantId, RootBrokerId, RootAgentLabel, IncludeDownline,
             Status, WizardStep, DraftJson, SummaryJson,
             CreatedBy, CreatedUtc, ModifiedUtc
      FROM oe.MigrationGroupMigrationBatch
      WHERE BatchId = @batchId
    `);
  return result.recordset?.[0] || null;
}

async function createBatch({
  instanceId,
  tenantId = null,
  rootBrokerId = null,
  rootAgentLabel = null,
  includeDownline = true,
  createdBy = null
}) {
  if (!instanceId) {
    const err = new Error('instanceId is required');
    err.status = 400;
    throw err;
  }

  const brokerId = Number(rootBrokerId);
  if (!Number.isFinite(brokerId) || brokerId <= 0) {
    const err = new Error('Select an E123 import root broker before starting group migration');
    err.code = 'ROOT_BROKER_REQUIRED';
    err.status = 400;
    throw err;
  }

  // Prerequisite: groups list must be staged for this instance
  const groupsList = await e123GroupListSnapshot.loadGroupsListIndexForInstance(instanceId);
  if (!groupsList) {
    const err = new Error('Upload the E123 groups list CSV for this migration instance first');
    err.code = 'GROUPS_LIST_NOT_STAGED';
    err.status = 400;
    throw err;
  }

  // Prerequisite: agent tree must be staged
  const agentTree = await e123AgentTreeSnapshot.getLatestAgentTreeExport(instanceId);
  if (!agentTree) {
    const err = new Error('Upload the E123 agent tree CSV for this migration instance first');
    err.code = 'AGENT_TREE_NOT_STAGED';
    err.status = 400;
    throw err;
  }

  // Prerequisite: MigrationAgentMap must have rows for this instance
  const pool = await getPool();
  const agentMapCheck = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .query(`
      SELECT TOP 1 AgentMapId FROM oe.MigrationAgentMap WHERE InstanceId = @instanceId
    `);
  if (!agentMapCheck.recordset?.length) {
    const err = new Error('Complete the agent migration for this instance before importing groups');
    err.code = 'AGENT_MAP_REQUIRED';
    err.status = 400;
    throw err;
  }

  const batchId = uuidv4();
  await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .input('tenantId', sql.UniqueIdentifier, tenantId || null)
    .input('rootBrokerId', sql.Int, brokerId)
    .input('rootAgentLabel', sql.NVarChar, rootAgentLabel || null)
    .input('includeDownline', sql.Bit, includeDownline !== false ? 1 : 0)
    .input('createdBy', sql.UniqueIdentifier, createdBy || null)
    .query(`
      INSERT INTO oe.MigrationGroupMigrationBatch (
        BatchId, InstanceId, TenantId, RootBrokerId, RootAgentLabel, IncludeDownline,
        Status, WizardStep, CreatedBy
      ) VALUES (
        @batchId, @instanceId, @tenantId, @rootBrokerId, @rootAgentLabel, @includeDownline,
        N'draft', 1, @createdBy
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
  if (updates.rootBrokerId !== undefined) {
    sets.push('RootBrokerId = @rootBrokerId');
    request.input('rootBrokerId', sql.Int, updates.rootBrokerId != null ? Number(updates.rootBrokerId) : null);
  }
  if (updates.rootAgentLabel !== undefined) {
    sets.push('RootAgentLabel = @rootAgentLabel');
    request.input('rootAgentLabel', sql.NVarChar, updates.rootAgentLabel || null);
  }
  if (updates.includeDownline !== undefined) {
    sets.push('IncludeDownline = @includeDownline');
    request.input('includeDownline', sql.Bit, updates.includeDownline !== false ? 1 : 0);
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

  await request.query(`
    UPDATE oe.MigrationGroupMigrationBatch
    SET ${sets.join(', ')}
    WHERE BatchId = @batchId
  `);
  return getBatch(batchId);
}

function mapBatchRow(row) {
  if (!row) return null;
  return {
    batchId: row.BatchId,
    instanceId: row.InstanceId,
    tenantId: row.TenantId,
    rootBrokerId: row.RootBrokerId != null ? Number(row.RootBrokerId) : null,
    rootAgentLabel: row.RootAgentLabel || null,
    includeDownline: row.IncludeDownline == null ? true : !!row.IncludeDownline,
    status: row.Status,
    wizardStep: row.WizardStep,
    draftJson: parseJsonSafe(row.DraftJson, {}),
    summaryJson: parseJsonSafe(row.SummaryJson, {}),
    createdBy: row.CreatedBy,
    createdUtc: row.CreatedUtc,
    modifiedUtc: row.ModifiedUtc
  };
}

// ---------------------------------------------------------------------------
// Group map (MigrationGroupMap)
// ---------------------------------------------------------------------------

async function getGroupMap({ instanceId, e123BrokerId }) {
  if (!instanceId || !e123BrokerId) return null;
  const pool = await getPool();
  const result = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .input('e123BrokerId', sql.Int, Number(e123BrokerId))
    .query(`
      SELECT TOP 1 GroupMapId, InstanceId, E123BrokerId, GroupId, E123GroupLabel, MatchMethod
      FROM oe.MigrationGroupMap
      WHERE InstanceId = @instanceId AND E123BrokerId = @e123BrokerId
    `);
  return result.recordset?.[0] || null;
}

async function upsertGroupMap({ instanceId, e123BrokerId, groupId, e123GroupLabel = null, matchMethod = null }) {
  if (!instanceId || !e123BrokerId || !groupId) return null;
  const pool = await getPool();
  const mapId = uuidv4();
  await pool.request()
    .input('mapId', sql.UniqueIdentifier, mapId)
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .input('e123BrokerId', sql.Int, Number(e123BrokerId))
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('e123GroupLabel', sql.NVarChar, e123GroupLabel || null)
    .input('matchMethod', sql.NVarChar, matchMethod || null)
    .query(`
      MERGE oe.MigrationGroupMap AS target
      USING (
        SELECT @instanceId AS InstanceId, @e123BrokerId AS E123BrokerId
      ) AS source
      ON target.InstanceId = source.InstanceId AND target.E123BrokerId = source.E123BrokerId
      WHEN MATCHED THEN
        UPDATE SET
          GroupId = @groupId,
          E123GroupLabel = @e123GroupLabel,
          MatchMethod = @matchMethod,
          ModifiedUtc = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (GroupMapId, InstanceId, E123BrokerId, GroupId, E123GroupLabel, MatchMethod)
        VALUES (@mapId, @instanceId, @e123BrokerId, @groupId, @e123GroupLabel, @matchMethod);
    `);
  return { instanceId, e123BrokerId, groupId, matchMethod };
}

// ---------------------------------------------------------------------------
// Agent ID resolution for group nodes
// Walk MigrationAgentMap (direct) then parent chain in MigrationE123AgentNode
// using the latest agent tree export (max MAX_AGENT_WALK_DEPTH hops).
// ---------------------------------------------------------------------------

async function resolveAgentIdForGroup(instanceId, e123BrokerId) {
  const pool = await getPool();
  const brokerId = Number(e123BrokerId);

  // Direct lookup
  const directResult = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .input('e123BrokerId', sql.Int, brokerId)
    .query(`
      SELECT TOP 1 AgentId FROM oe.MigrationAgentMap
      WHERE InstanceId = @instanceId AND E123BrokerId = @e123BrokerId
    `);
  if (directResult.recordset?.[0]?.AgentId) {
    return directResult.recordset[0].AgentId;
  }

  // Walk parent chain using latest agent tree export
  const latestTree = await e123AgentTreeSnapshot.getLatestAgentTreeExport(instanceId);
  if (!latestTree?.ExportId) return null;

  let currentId = brokerId;
  for (let depth = 0; depth < MAX_AGENT_WALK_DEPTH; depth++) {
    const nodeResult = await pool.request()
      .input('exportId', sql.UniqueIdentifier, latestTree.ExportId)
      .input('agentId', sql.Int, currentId)
      .query(`
        SELECT TOP 1 ParentAgentId FROM oe.MigrationE123AgentNode
        WHERE ExportId = @exportId AND AgentId = @agentId
      `);
    const parentId = nodeResult.recordset?.[0]?.ParentAgentId;
    if (parentId == null) break;

    const parentCheck = await pool.request()
      .input('instanceId', sql.UniqueIdentifier, instanceId)
      .input('e123BrokerId', sql.Int, Number(parentId))
      .query(`
        SELECT TOP 1 AgentId FROM oe.MigrationAgentMap
        WHERE InstanceId = @instanceId AND E123BrokerId = @e123BrokerId
      `);
    if (parentCheck.recordset?.[0]?.AgentId) {
      return parentCheck.recordset[0].AgentId;
    }
    currentId = Number(parentId);
  }

  return null;
}

async function getPrerequisites(instanceId) {
  if (!instanceId) {
    return {
      groupsListReady: false,
      agentTreeReady: false,
      agentMapReady: false,
      agentMapCount: 0
    };
  }

  const groupsList = await e123GroupListSnapshot.loadGroupsListIndexForInstance(instanceId);
  const agentTree = await e123AgentTreeSnapshot.getLatestAgentTreeExport(instanceId);
  const pool = await getPool();
  const agentMapResult = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .query(`
      SELECT COUNT(*) AS AgentMapCount FROM oe.MigrationAgentMap WHERE InstanceId = @instanceId
    `);
  const agentMapCount = Number(agentMapResult.recordset?.[0]?.AgentMapCount || 0);

  return {
    groupsListReady: Boolean(groupsList?.groupCount),
    agentTreeReady: Boolean(agentTree),
    agentMapReady: agentMapCount > 0,
    agentMapCount
  };
}

async function lookupAgentName(agentId) {
  if (!agentId) return null;
  const pool = await getPool();
  const result = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .query(`
      SELECT TOP 1 u.FirstName, u.LastName, u.Email
      FROM oe.Agents a
      INNER JOIN oe.Users u ON u.UserId = a.UserId
      WHERE a.AgentId = @agentId
    `);
  const row = result.recordset?.[0];
  if (!row) return null;
  const name = [row.FirstName, row.LastName].filter(Boolean).join(' ').trim();
  return name || row.Email || null;
}

// ---------------------------------------------------------------------------
// Detect groups: load from groupsListSnapshot, resolve agents, tag alreadyMapped
// ---------------------------------------------------------------------------

async function detectGroups({ instanceId, batchId = null }) {
  const snapshot = await e123GroupListSnapshot.loadGroupsListIndexForInstance(instanceId);
  if (!snapshot) {
    const err = new Error('Groups list not staged for this instance');
    err.code = 'GROUPS_LIST_NOT_STAGED';
    err.status = 400;
    throw err;
  }

  let batch = null;
  if (batchId) {
    batch = await getBatch(batchId);
    if (!batch) {
      const err = new Error('Group migration batch not found');
      err.status = 404;
      throw err;
    }
  }

  const rootBrokerId = Number(batch?.RootBrokerId);
  if (!Number.isFinite(rootBrokerId) || rootBrokerId <= 0) {
    const err = new Error('Select an E123 import root broker on this batch before detecting groups');
    err.code = 'ROOT_BROKER_REQUIRED';
    err.status = 400;
    throw err;
  }
  const includeDownline = batch?.IncludeDownline == null ? true : !!batch.IncludeDownline;
  const rootAgentLabel = batch?.RootAgentLabel || null;

  const { rows: treeRows } = await loadAgentTreeRowsForInstance(instanceId);
  const parentByAgentId = buildParentByAgentId(treeRows);
  const scopeBrokerIds = buildScopeBrokerIds(treeRows, rootBrokerId, includeDownline);

  const pool = await getPool();
  const existingMaps = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .query(`
      SELECT E123BrokerId, GroupId FROM oe.MigrationGroupMap WHERE InstanceId = @instanceId
    `);
  const mappedByBrokerId = new Map(
    (existingMaps.recordset || []).map((r) => [Number(r.E123BrokerId), r.GroupId])
  );

  const rawGroups = Object.values(snapshot.groups || {}).map((g) => ({
    e123BrokerId: Number(g.e123BrokerId || g.brokerId || g.BrokerId),
    label: g.label || g.name || `Group ${g.e123BrokerId || g.brokerId}`,
    email: g.email || g.contactEmail || null,
    contactName: g.contactName || null,
    contactEmail: g.email || g.contactEmail || null,
    contactPhone: g.phone || g.contactPhone || null,
    memberCount: Number(g.memberCount || 0),
    parentAgentId: g.parentAgentId != null ? Number(g.parentAgentId) : null,
    taxId: g.taxId || g.tax_id || null,
    address: g.address1 || g.address || null,
    city: g.city || null,
    state: g.state || null,
    zip: g.zip || null
  })).filter((g) => Number.isFinite(g.e123BrokerId) && g.e123BrokerId > 0);

  let outsideDownlineCount = 0;
  const groups = [];
  for (const raw of rawGroups) {
    if (!isGroupInBrokerScope(raw, scopeBrokerIds, parentByAgentId)) {
      outsideDownlineCount += 1;
      continue;
    }

    const alreadyMapped = mappedByBrokerId.has(raw.e123BrokerId);
    const existingGroupId = mappedByBrokerId.get(raw.e123BrokerId) || null;
    const employerClassification = classifyEmployerGroupRow({
      label: raw.label,
      memberCount: raw.memberCount,
      bgroup: raw.bgroup ?? null,
      bgrouplistbill: raw.bgrouplistbill ?? null
    });
    const isEmployerGroup = employerClassification.include;

    let resolvedAgentId = null;
    let agentMapped = false;
    let agentName = null;
    if (!alreadyMapped && isEmployerGroup) {
      resolvedAgentId = await resolveAgentIdForGroup(instanceId, raw.e123BrokerId);
      agentMapped = Boolean(resolvedAgentId);
      agentName = agentMapped ? await lookupAgentName(resolvedAgentId) : null;
    }

    let action = 'create_new';
    let excludeReason = null;
    if (alreadyMapped) {
      action = 'already_mapped';
    } else if (!isEmployerGroup) {
      action = 'excluded';
      excludeReason = employerClassification.reason;
    } else if (!agentMapped) {
      action = 'excluded';
      excludeReason = 'agent_unmapped';
    }

    groups.push({
      ...raw,
      alreadyMapped,
      existingGroupId,
      action,
      excludeReason,
      exclusionMessage: excludeReason ? getGroupMigrationExclusionMessage(excludeReason) : null,
      isEmployerGroup,
      matchStatus: alreadyMapped
        ? 'already_mapped'
        : !isEmployerGroup
          ? 'not_employer_group'
          : (agentMapped ? 'ready' : 'agent_unmapped'),
      conflictReason: null,
      existingGroupName: null,
      agentMapped,
      agentId: resolvedAgentId,
      agentName,
      agentMatchStatus: agentMapped ? 'mapped' : 'unmapped',
      resolvedAgentId
    });
  }

  const summary = {
    total: rawGroups.length,
    inScopeTotal: groups.length,
    outsideDownlineCount,
    rootBrokerId,
    rootAgentLabel,
    includeDownline,
    employerGroups: groups.filter((g) => g.isEmployerGroup).length,
    createNew: groups.filter((g) => g.action === 'create_new').length,
    mapExisting: 0,
    alreadyMapped: groups.filter((g) => g.action === 'already_mapped').length,
    conflicts: 0,
    excluded: groups.filter((g) => g.action === 'excluded').length,
    excludedNonEmployer: groups.filter((g) => g.action === 'excluded' && g.excludeReason !== 'agent_unmapped').length,
    excludedAgentUnmapped: groups.filter((g) => g.excludeReason === 'agent_unmapped').length,
    agentMappedCount: groups.filter((g) => g.agentMapped).length,
    agentUnmappedCount: groups.filter((g) => g.excludeReason === 'agent_unmapped').length
  };

  if (batchId) {
    await patchBatch(batchId, {
      summaryJson: {
        detect: {
          ...summary,
          detectedGroups: groups,
          detectedUtc: new Date().toISOString()
        }
      }
    });
  }

  return { groups, totalGroups: groups.length, summary };
}

// ---------------------------------------------------------------------------
// Preview members for a group node (direct broker query via E123 user.getall)
// ---------------------------------------------------------------------------

async function previewMembers({ instanceId, e123BrokerId, tenantId = null }) {
  const brokerId = Number(e123BrokerId);

  if (!tenantId) {
    const err = new Error('TenantId is required for member preview');
    err.status = 400;
    throw err;
  }

  const e123Members = await runWithInstanceE123Config(instanceId, () =>
    fetchAllUsersForBroker({ brokerId, includeDownline: false })
  );

  const users = e123Members?.users || [];
  if (!users.length) {
    return { e123Members: [], oeMembers: [], conflicts: [], totalE123: 0 };
  }

  const pool = await getPool();
  const sourceIds = users
    .map((u) => u.userId || u.user_id || u.id)
    .filter(Boolean)
    .map(String);

  if (!sourceIds.length) {
    return { e123Members: users, oeMembers: [], conflicts: [], totalE123: users.length };
  }

  const request = pool.request();
  const idParams = sourceIds.map((id, index) => {
    request.input(`sourceId${index}`, sql.NVarChar, id);
    return `@sourceId${index}`;
  });
  request.input('tenantId', sql.UniqueIdentifier, tenantId);
  const memberResult = await request.query(`
    SELECT MemberId, TenantId, GroupId, MigrationSourceRecordId, FirstName, LastName, Email
    FROM oe.Members
    WHERE MigrationSourceRecordId IN (${idParams.join(', ')})
      AND TenantId = @tenantId
  `);

  const oeMembers = memberResult.recordset || [];

  const conflicts = oeMembers
    .filter((m) => m.GroupId != null)
    .map((m) => ({
      memberId: m.MemberId,
      memberName: [m.FirstName, m.LastName].filter(Boolean).join(' ').trim() || m.Email || m.MemberId,
      firstName: m.FirstName,
      lastName: m.LastName,
      email: m.Email,
      currentGroupId: m.GroupId,
      migrationSourceRecordId: m.MigrationSourceRecordId,
      reason: 'member_has_group',
      conflict: 'member_has_group'
    }));

  return {
    e123Members: users,
    oeMembers,
    conflicts,
    totalE123: users.length,
    matchedCount: oeMembers.length,
    conflictCount: conflicts.length
  };
}

async function previewGroupMigrationBatch({ batchId }) {
  const batch = await getBatch(batchId);
  if (!batch) {
    const err = new Error('Group migration batch not found');
    err.status = 404;
    throw err;
  }
  if (!batch.TenantId) {
    const err = new Error('TenantId is required on the batch before preview');
    err.status = 400;
    throw err;
  }

  let detectedGroups = parseJsonSafe(batch.SummaryJson, {})?.detect?.detectedGroups;
  if (!Array.isArray(detectedGroups) || !detectedGroups.length) {
    const detectResult = await detectGroups({ instanceId: batch.InstanceId, batchId });
    detectedGroups = detectResult.groups;
  }

  const rows = [];
  let conflictCount = 0;

  for (const group of detectedGroups) {
    if (group.isEmployerGroup === false) continue;

    let memberPreview = { conflictCount: 0, conflicts: [] };
    if (group.action === 'create_new') {
      memberPreview = await previewMembers({
        instanceId: batch.InstanceId,
        e123BrokerId: group.e123BrokerId,
        tenantId: batch.TenantId
      });
    }

    const rowConflictCount = memberPreview.conflictCount || 0;
    conflictCount += rowConflictCount;

    rows.push({
      e123BrokerId: group.e123BrokerId,
      label: group.label,
      action: group.action,
      message: group.action === 'excluded'
        ? (group.exclusionMessage || getGroupMigrationExclusionMessage(group.excludeReason))
        : group.action === 'already_mapped'
          ? 'Already migrated'
          : rowConflictCount > 0
            ? `${rowConflictCount} member conflict(s)`
            : 'Ready to create',
      memberCount: group.memberCount || memberPreview.totalE123 || 0,
      conflictCount: rowConflictCount,
      conflictDetails: (memberPreview.conflicts || []).slice(0, 50).map((c) => ({
        memberId: c.memberId,
        memberName: c.memberName,
        reason: c.reason || c.conflict
      }))
    });
  }

  const summary = {
    createCount: detectedGroups.filter((g) => g.action === 'create_new').length,
    mapCount: 0,
    skipCount: detectedGroups.filter((g) => g.action === 'already_mapped' || g.action === 'excluded').length,
    conflictCount,
    errorCount: 0
  };

  const result = {
    rows,
    total: rows.length,
    summary,
    canApply: summary.createCount > 0
  };

  await patchBatch(batchId, {
    summaryJson: {
      ...(parseJsonSafe(batch.SummaryJson, {}) || {}),
      preview: { ...result, previewUtc: new Date().toISOString() }
    }
  });

  return result;
}

// ---------------------------------------------------------------------------
// Apply group migration — per-group mssql transaction
// ---------------------------------------------------------------------------

async function applyGroupMigration({ batchId, groups = [], createdBy = null }) {
  const batch = await getBatch(batchId);
  if (!batch) {
    const err = new Error('Group migration batch not found');
    err.status = 404;
    throw err;
  }
  if (!batch.TenantId) {
    const err = new Error('TenantId is required on the batch before applying');
    err.status = 400;
    throw err;
  }

  if (!groups.length) {
    const err = new Error('No groups provided for apply');
    err.status = 400;
    throw err;
  }

  await patchBatch(batchId, { status: 'applying' });

  const pool = await getPool();
  const results = [];

  for (const groupEntry of groups) {
    const e123BrokerId = Number(groupEntry.e123BrokerId);
    const employerClassification = classifyEmployerGroupRow({
      label: groupEntry.label,
      memberCount: groupEntry.memberCount,
      bgroup: groupEntry.bgroup ?? null,
      bgrouplistbill: groupEntry.bgrouplistbill ?? null
    });
    if (!employerClassification.include) {
      results.push({
        e123BrokerId,
        label: groupEntry.label || null,
        action: 'skipped',
        reason: employerClassification.reason,
        message: getGroupMigrationExclusionMessage(employerClassification.reason)
      });
      continue;
    }

    // Skip if already mapped
    const existing = await getGroupMap({ instanceId: batch.InstanceId, e123BrokerId });
    if (existing?.GroupId) {
      results.push({
        e123BrokerId,
        label: groupEntry.label || null,
        action: 'skipped',
        reason: 'already_mapped',
        groupId: existing.GroupId
      });
      continue;
    }

    const transaction = pool.transaction();
    try {
      await transaction.begin();

      const groupId = uuidv4();
      const resolvedAgentId = await resolveAgentIdForGroup(batch.InstanceId, e123BrokerId);

      const grpRequest = transaction.request();
      grpRequest.input('groupId', sql.UniqueIdentifier, groupId);
      grpRequest.input('tenantId', sql.UniqueIdentifier, batch.TenantId);
      grpRequest.input('name', sql.NVarChar, groupEntry.label || `Group ${e123BrokerId}`);
      grpRequest.input('primaryContact', sql.NVarChar, groupEntry.contactName || null);
      grpRequest.input('contactEmail', sql.NVarChar, groupEntry.contactEmail || null);
      grpRequest.input('contactPhone', sql.NVarChar, groupEntry.contactPhone || null);
      grpRequest.input('address', sql.NVarChar, groupEntry.address || null);
      grpRequest.input('address2', sql.NVarChar, groupEntry.address2 || null);
      grpRequest.input('city', sql.NVarChar, groupEntry.city || null);
      grpRequest.input('state', sql.NVarChar, groupEntry.state || null);
      grpRequest.input('zip', sql.NVarChar, groupEntry.zip || null);
      // taxId from CSV only — no v2 enrichment in v1
      grpRequest.input('taxIdNumber', sql.NVarChar, groupEntry.taxId || null);
      grpRequest.input('agentId', sql.UniqueIdentifier, resolvedAgentId || null);
      grpRequest.input('createdBy', sql.UniqueIdentifier, createdBy || null);

      await grpRequest.query(`
        INSERT INTO oe.Groups (
          GroupId, TenantId, Name, Status, PrimaryContact, ContactEmail,
          ContactPhone, Address, Address2, City, State, Zip,
          TaxIdNumber, AgentId, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
        ) VALUES (
          @groupId, @tenantId, @name, N'Active', @primaryContact, @contactEmail,
          @contactPhone, @address, @address2, @city, @state, @zip,
          @taxIdNumber, @agentId, GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy
        )
      `);

      // Primary location
      const locationId = uuidv4();
      const locRequest = transaction.request();
      locRequest.input('locationId', sql.UniqueIdentifier, locationId);
      locRequest.input('groupId', sql.UniqueIdentifier, groupId);
      locRequest.input('address', sql.NVarChar, groupEntry.address || '');
      locRequest.input('address2', sql.NVarChar, groupEntry.address2 || null);
      locRequest.input('city', sql.NVarChar, groupEntry.city || '');
      locRequest.input('state', sql.NVarChar, groupEntry.state || '');
      locRequest.input('zip', sql.NVarChar, groupEntry.zip || '');
      locRequest.input('contactName', sql.NVarChar, groupEntry.contactName || null);
      locRequest.input('contactPhone', sql.NVarChar, groupEntry.contactPhone || null);
      locRequest.input('contactEmail', sql.NVarChar, groupEntry.contactEmail || null);
      locRequest.input('createdBy', sql.UniqueIdentifier, createdBy || null);

      await locRequest.query(`
        INSERT INTO oe.GroupLocations (
          LocationId, GroupId, Name, Address, Address2, City, State, Zip,
          ContactName, ContactPhone, ContactEmail, UseLocationACH, IsPrimary, Status,
          CreatedDate, ModifiedDate, CreatedBy
        ) VALUES (
          @locationId, @groupId, N'Primary Location', @address, @address2, @city, @state, @zip,
          @contactName, @contactPhone, @contactEmail, 0, 1, N'Active',
          GETUTCDATE(), GETUTCDATE(), @createdBy
        )
      `);

      // Group admin via email match in oe.Users
      if (groupEntry.contactEmail) {
        const adminUserResult = await transaction.request()
          .input('email', sql.NVarChar, groupEntry.contactEmail.trim().toLowerCase())
          .input('tenantId', sql.UniqueIdentifier, batch.TenantId)
          .query(`
            SELECT TOP 1 UserId FROM oe.Users
            WHERE LOWER(LTRIM(RTRIM(Email))) = @email AND TenantId = @tenantId AND Status = N'Active'
          `);
        const adminUserId = adminUserResult.recordset?.[0]?.UserId;
        if (adminUserId) {
          const adminId = uuidv4();
          const adminRequest = transaction.request();
          adminRequest.input('groupAdminId', sql.UniqueIdentifier, adminId);
          adminRequest.input('groupId', sql.UniqueIdentifier, groupId);
          adminRequest.input('userId', sql.UniqueIdentifier, adminUserId);
          adminRequest.input('createdBy', sql.UniqueIdentifier, createdBy || null);
          await adminRequest.query(`
            INSERT INTO oe.GroupAdmins (GroupAdminId, GroupId, UserId, Status, CreatedDate, ModifiedDate, CreatedBy)
            VALUES (@groupAdminId, @groupId, @userId, N'Active', GETUTCDATE(), GETUTCDATE(), @createdBy)
          `);
        }
      }

      await transaction.commit();

      // Record group map outside transaction (same as agentMigration pattern)
      await upsertGroupMap({
        instanceId: batch.InstanceId,
        e123BrokerId,
        groupId,
        e123GroupLabel: groupEntry.label || null,
        matchMethod: 'migration_create'
      });

      results.push({ e123BrokerId, label: groupEntry.label || null, action: 'created', groupId, resolvedAgentId });
    } catch (err) {
      await transaction.rollback();
      results.push({ e123BrokerId, action: 'error', message: err.message });
    }
  }

  const summary = {
    appliedUtc: new Date().toISOString(),
    created: results.filter((r) => r.action === 'created').length,
    mapped: 0,
    skipped: results.filter((r) => r.action === 'skipped').length,
    errors: results.filter((r) => r.action === 'error').length,
    results
  };

  const finalStatus = summary.errors > 0 && summary.created === 0 ? 'failed' : 'applied';
  await patchBatch(batchId, { status: finalStatus, summaryJson: { apply: summary } });

  return { summary, results };
}

module.exports = {
  getBatch,
  createBatch,
  patchBatch,
  mapBatchRow,
  parseJsonSafe,
  getGroupMap,
  upsertGroupMap,
  getPrerequisites,
  detectGroups,
  resolveAgentIdForGroup,
  previewMembers,
  previewGroupMigrationBatch,
  applyGroupMigration
};

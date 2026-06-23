'use strict';

const { sql, getPool } = require('../../config/database');
const sharewellAgents = require('./sharewellAgents.service');
const agentMapService = require('./migrationAgentMap.service');
const {
  pickHouseholdE123BrokerId,
  resolveBrokerToAgent,
  fetchE123BrokerHints,
  verifyAgentInTenant,
  getAgentTenantInfo
} = require('./migrationAgentResolver.service');

const WORKSPACE_CACHE_TTL_MS = 15 * 60 * 1000;
const workspaceCache = new Map();

function invalidateAgentMappingWorkspaceCache(batchId = null) {
  if (!batchId) {
    workspaceCache.clear();
    return;
  }
  for (const key of workspaceCache.keys()) {
    if (key.startsWith(`${batchId}:`)) workspaceCache.delete(key);
  }
}

async function resolveBrokerLabels(brokerIds = [], instanceId = null) {
  const ids = [...new Set(
    (brokerIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
  )];
  const labels = new Map();
  if (!ids.length) return labels;

  const sharewellLabels = await sharewellAgents.lookupBrokerLabelsByIds(ids);
  const foundInSharewell = new Set();
  for (const [id, label] of sharewellLabels.entries()) {
    if (label && !/^Broker \d+$/.test(label)) {
      labels.set(id, label);
      foundInSharewell.add(id);
    }
  }

  const missing = ids.filter((id) => !foundInSharewell.has(id));
  if (instanceId && missing.length) {
    await Promise.all(missing.map(async (id) => {
      try {
        const hints = await fetchE123BrokerHints(id, instanceId);
        if (hints?.label && !/^Broker \d+$/.test(hints.label)) {
          labels.set(id, hints.label);
        } else if (hints?.firstName && hints?.lastName) {
          labels.set(id, `${hints.firstName} ${hints.lastName}`.trim());
        }
      } catch {
        // ignore per-broker lookup failures
      }
    }));
  }

  ids.forEach((id) => {
    if (!labels.has(id)) labels.set(id, `Broker ${id}`);
  });
  return labels;
}

async function getAgentSummary(agentId, tenantId) {
  if (!agentId || !tenantId) return null;
  const pool = await getPool();
  const result = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT TOP 1 a.AgentId, a.AgentCode, u.FirstName, u.LastName, u.Email
      FROM oe.Agents a
      INNER JOIN oe.Users u ON u.UserId = a.UserId
      WHERE a.AgentId = @agentId AND a.TenantId = @tenantId
    `);
  const row = result.recordset?.[0];
  if (!row) return null;
  return {
    agentId: row.AgentId,
    agentCode: row.AgentCode || null,
    displayName: `${row.FirstName || ''} ${row.LastName || ''}`.trim() || row.Email || 'Agent',
    email: row.Email || null
  };
}

async function searchTenantAgents(tenantId, { search = '', limit = 30 } = {}) {
  if (!tenantId) return [];
  const pool = await getPool();
  const cap = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const trimmed = String(search || '').trim();
  const agentLimit = trimmed ? cap : cap;
  const userLimit = trimmed ? Math.max(cap - Math.floor(cap / 2), 10) : cap;

  const agentRequest = pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, agentLimit);
  let agentWhere = `a.TenantId = @tenantId AND a.Status IN (N'Active', N'Pending')`;
  if (trimmed) {
    agentRequest.input('search', sql.NVarChar, `%${trimmed}%`);
    agentWhere += ` AND (
      u.FirstName + ' ' + u.LastName LIKE @search
      OR u.Email LIKE @search
      OR a.AgentCode LIKE @search
    )`;
  }
  const agentResult = await agentRequest.query(`
    SELECT TOP (@limit)
      a.AgentId,
      a.AgentCode,
      u.FirstName,
      u.LastName,
      u.Email
    FROM oe.Agents a
    INNER JOIN oe.Users u ON u.UserId = a.UserId
    WHERE ${agentWhere}
    ORDER BY u.LastName, u.FirstName
  `);

  const userRequest = pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, userLimit);
  let userWhere = `u.TenantId = @tenantId AND a.AgentId IS NULL`;
  if (trimmed) {
    userRequest.input('search', sql.NVarChar, `%${trimmed}%`);
    userWhere += ` AND (
      u.FirstName + ' ' + u.LastName LIKE @search
      OR u.Email LIKE @search
    )`;
  } else {
    userWhere += ` AND u.Status = N'Active'`;
  }
  const userResult = await userRequest.query(`
    SELECT TOP (@limit)
      u.UserId,
      u.FirstName,
      u.LastName,
      u.Email
    FROM oe.Users u
    LEFT JOIN oe.Agents a ON a.UserId = u.UserId AND a.TenantId = @tenantId
    WHERE ${userWhere}
    ORDER BY u.LastName, u.FirstName
  `);

  const agents = (agentResult.recordset || []).map((row) => ({
    linkType: 'agent',
    agentId: row.AgentId,
    userId: null,
    agentCode: row.AgentCode || null,
    displayName: `${row.FirstName || ''} ${row.LastName || ''}`.trim() || row.Email || 'Agent',
    email: row.Email || null,
    hint: null
  }));

  const users = (userResult.recordset || []).map((row) => ({
    linkType: 'user',
    agentId: null,
    userId: row.UserId,
    agentCode: null,
    displayName: `${row.FirstName || ''} ${row.LastName || ''}`.trim() || row.Email || 'User',
    email: row.Email || null,
    hint: 'Existing user — will add agent role'
  }));

  return [...agents, ...users].slice(0, cap);
}

async function buildAgentMappingWorkspace(batchId, instanceId, tenantId) {
  const cacheKey = `${batchId}:${tenantId}:v2`;
  const cached = workspaceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const pool = await getPool();
  const rows = await pool.request()
    .input('batchId', sql.UniqueIdentifier, batchId)
    .query(`
      SELECT HouseholdJson
      FROM oe.MigrationImportBatchHousehold
      WHERE BatchId = @batchId AND IncludedInImport = 1
    `);

  const memberCounts = new Map();
  for (const row of rows.recordset || []) {
    const hh = JSON.parse(row.HouseholdJson);
    const brokerId = pickHouseholdE123BrokerId(hh);
    if (!brokerId) continue;
    memberCounts.set(brokerId, (memberCounts.get(brokerId) || 0) + 1);
  }

  const brokerIds = [...memberCounts.keys()];
  const labels = await resolveBrokerLabels(brokerIds, instanceId);
  const savedMaps = await agentMapService.listAgentMapsForInstance(instanceId);
  const savedByBroker = new Map(savedMaps.map((map) => [map.E123BrokerId, map]));
  const resolveCache = new Map();
  const summaryCache = new Map();

  async function getSummaryCached(agentId) {
    if (!agentId) return null;
    const key = `${tenantId}:${agentId}`;
    if (summaryCache.has(key)) return summaryCache.get(key);
    const summary = await getAgentSummary(agentId, tenantId);
    summaryCache.set(key, summary);
    return summary;
  }

  const brokers = await Promise.all(brokerIds.map(async (e123BrokerId) => {
    const saved = savedByBroker.get(e123BrokerId);
    const e123AgentLabel = labels.get(e123BrokerId) || `Broker ${e123BrokerId}`;
    let agentId = saved?.AgentId || null;
    let agentName = null;
    let agentEmail = null;
    let matchMethod = saved?.MatchMethod || null;
    let matchStatus = 'unmapped';
    let e123Email = null;
    let e123FirstName = null;
    let e123LastName = null;
    let agentTenantName = null;

    const hints = await fetchE123BrokerHints(e123BrokerId, instanceId);
    e123Email = hints?.email || null;
    e123FirstName = hints?.firstName || null;
    e123LastName = hints?.lastName || null;

    if (agentId) {
      const summary = await getSummaryCached(agentId);
      if (summary) {
        agentName = summary.displayName;
        agentEmail = summary.email;
        matchStatus = matchMethod === 'manual' ? 'manual' : 'mapped';
      } else {
        const crossInfo = await getAgentTenantInfo(agentId);
        if (crossInfo) {
          agentName = crossInfo.displayName;
          agentEmail = crossInfo.email;
          agentTenantName = crossInfo.tenantName;
          matchStatus = 'cross_tenant';
        } else {
          agentId = null;
          matchMethod = null;
        }
      }
    } else if (tenantId) {
      const auto = await resolveBrokerToAgent({
        tenantId,
        instanceId,
        e123BrokerId,
        cache: resolveCache,
        persistAutoMatch: false
      });
      e123Email = auto.e123Email ?? e123Email;
      e123FirstName = auto.e123FirstName ?? e123FirstName;
      e123LastName = auto.e123LastName ?? e123LastName;
      if (auto.agentId) {
        agentId = auto.agentId;
        matchMethod = auto.method;
        const summary = await getSummaryCached(agentId);
        agentName = summary?.displayName || null;
        agentEmail = summary?.email || null;
        matchStatus = 'suggested';
      } else if (auto.hadHints) {
        matchStatus = 'needs_manual';
      }
    }

    return {
      e123BrokerId,
      e123AgentLabel,
      e123Email,
      e123FirstName,
      e123LastName,
      memberCount: memberCounts.get(e123BrokerId) || 0,
      agentId,
      agentName,
      agentEmail,
      agentTenantName,
      matchMethod,
      matchStatus
    };
  }));

  brokers.sort((a, b) => b.memberCount - a.memberCount || a.e123AgentLabel.localeCompare(b.e123AgentLabel));

  const crossTenantBrokers = brokers.filter((row) => row.matchStatus === 'cross_tenant');
  const crossTenantMemberCount = crossTenantBrokers.reduce((sum, row) => sum + (row.memberCount || 0), 0);

  const result = {
    brokers,
    mappedCount: brokers.filter((row) => row.matchStatus === 'mapped' || row.matchStatus === 'manual').length,
    suggestedCount: brokers.filter((row) => row.matchStatus === 'suggested').length,
    unmappedCount: brokers.filter((row) => row.matchStatus === 'unmapped').length,
    needsManualCount: brokers.filter((row) => row.matchStatus === 'needs_manual').length,
    crossTenantCount: crossTenantBrokers.length,
    crossTenantMemberCount,
    totalBrokers: brokers.length
  };

  workspaceCache.set(cacheKey, { data: result, expiresAt: Date.now() + WORKSPACE_CACHE_TTL_MS });
  return result;
}

async function saveManualAgentMap({
  instanceId,
  e123BrokerId,
  agentId,
  e123AgentLabel = null,
  tenantId = null
}) {
  if (tenantId) {
    const inTenant = await verifyAgentInTenant(agentId, tenantId);
    if (!inTenant) {
      const err = new Error('Selected agent does not belong to the migration tenant');
      err.status = 400;
      throw err;
    }
  }
  const result = await agentMapService.upsertAgentMap({
    instanceId,
    e123BrokerId,
    agentId,
    matchMethod: 'manual',
    e123AgentLabel
  });
  invalidateAgentMappingWorkspaceCache();
  return result;
}

module.exports = {
  resolveBrokerLabels,
  searchTenantAgents,
  buildAgentMappingWorkspace,
  saveManualAgentMap,
  getAgentSummary,
  invalidateAgentMappingWorkspaceCache
};

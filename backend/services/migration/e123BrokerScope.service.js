'use strict';

const { sql, getPool } = require('../../config/database');
const { collectSubtreeBrokerIds } = require('./agentMigration.service');

async function loadAgentTreeRowsForInstance(instanceId) {
  const e123AgentTreeSnapshot = require('./e123AgentTreeSnapshot.service');
  const latest = await e123AgentTreeSnapshot.getLatestAgentTreeExport(instanceId);
  if (!latest?.ExportId) return { exportId: null, rows: [], rootBrokerId: latest?.RootBrokerId ?? null };

  const pool = await getPool();
  const result = await pool.request()
    .input('exportId', sql.UniqueIdentifier, latest.ExportId)
    .query(`
      SELECT AgentId, ParentAgentId, Label, IsGroup
      FROM oe.MigrationE123AgentNode
      WHERE ExportId = @exportId
    `);

  return {
    exportId: latest.ExportId,
    rootBrokerId: latest.RootBrokerId,
    rows: result.recordset || []
  };
}

function buildParentByAgentId(rows) {
  const parentByAgentId = new Map();
  for (const row of rows || []) {
    const agentId = Number(row.AgentId);
    if (!Number.isFinite(agentId) || agentId <= 0) continue;
    const parentRaw = row.ParentAgentId;
    parentByAgentId.set(
      agentId,
      parentRaw != null && String(parentRaw).trim() !== '' ? Number(parentRaw) : null
    );
  }
  return parentByAgentId;
}

function buildScopeBrokerIds(rows, rootBrokerId, includeDownline = true) {
  return collectSubtreeBrokerIds(rows || [], rootBrokerId, includeDownline);
}

/**
 * Group is in scope when its E123 broker id, CSV parent agent, or any tree ancestor
 * falls under the selected import root (direct or full downline).
 */
function isGroupInBrokerScope(group, scopeBrokerIds, parentByAgentId) {
  if (!scopeBrokerIds?.size) return false;

  const candidates = [];
  const groupId = Number(group?.e123BrokerId ?? group?.brokerId);
  if (Number.isFinite(groupId) && groupId > 0) candidates.push(groupId);

  const parentId = Number(group?.parentAgentId ?? group?.ParentAgentId);
  if (Number.isFinite(parentId) && parentId > 0) candidates.push(parentId);

  for (const startId of candidates) {
    let current = startId;
    const visited = new Set();
    while (current != null && !visited.has(current)) {
      if (scopeBrokerIds.has(current)) return true;
      visited.add(current);
      current = parentByAgentId.get(current) ?? null;
    }
  }

  return false;
}

module.exports = {
  loadAgentTreeRowsForInstance,
  buildParentByAgentId,
  buildScopeBrokerIds,
  isGroupInBrokerScope
};

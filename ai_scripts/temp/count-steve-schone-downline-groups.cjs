#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const backendRoot = path.join(__dirname, '../../backend');
require(path.join(backendRoot, 'node_modules/dotenv')).config({ path: path.join(backendRoot, '.env') });

const { sql, getPool } = require(path.join(backendRoot, 'config/database'));
const { collectSubtreeBrokerIds } = require(path.join(backendRoot, 'services/migration/agentMigration.service'));
const { classifyEmployerGroupRow } = require(path.join(backendRoot, 'services/migration/e123GroupFilters'));
const {
  buildParentByAgentId,
  isGroupInBrokerScope
} = require(path.join(backendRoot, 'services/migration/e123BrokerScope.service'));
const e123GroupListSnapshot = require(path.join(backendRoot, 'services/migration/e123GroupListSnapshot.service'));

const STEVE_SCHONE_ID = 785508;
const SHAREWELL_INSTANCE = 'C4188882-6A65-4CB5-9D08-43BC6B6189EE';

async function main() {
  const pool = await getPool();
  const treeReq = pool.request();
  treeReq.input('instanceId', sql.UniqueIdentifier, SHAREWELL_INSTANCE);
  const tree = await treeReq.query(`
    SELECT TOP 1 e.ExportId, e.InstanceId
    FROM oe.MigrationE123AgentTreeExport e
    WHERE e.InstanceId = @instanceId
    ORDER BY e.CreatedUtc DESC
  `);
  const exportId = tree.recordset?.[0]?.ExportId;
  if (!exportId) throw new Error('No agent tree export for ShareWELL instance');

  const nodes = await pool.request()
    .input('exportId', sql.UniqueIdentifier, exportId)
    .query(`
      SELECT AgentId, ParentAgentId, Label, IsGroup
      FROM oe.MigrationE123AgentNode
      WHERE ExportId = @exportId
    `);
  const rows = nodes.recordset || [];
  const parentByAgentId = buildParentByAgentId(rows);
  const scopeIds = collectSubtreeBrokerIds(rows, STEVE_SCHONE_ID, true);

  const snapshot = await e123GroupListSnapshot.loadGroupsListIndexForInstance(SHAREWELL_INSTANCE);
  if (!snapshot?.groups) throw new Error('No groups list staged');

  const allGroups = Object.values(snapshot.groups);
  const inScope = [];
  const inScopeEmployer = [];
  const outsideDownline = [];

  for (const g of allGroups) {
    const raw = {
      e123BrokerId: Number(g.e123BrokerId),
      label: g.label,
      memberCount: Number(g.memberCount || 0),
      parentAgentId: g.parentAgentId != null ? Number(g.parentAgentId) : null
    };
    if (!isGroupInBrokerScope(raw, scopeIds, parentByAgentId)) {
      outsideDownline.push(raw);
      continue;
    }
    inScope.push(raw);
    const { include } = classifyEmployerGroupRow(raw);
    if (include) inScopeEmployer.push(raw);
  }

  inScopeEmployer.sort((a, b) => b.memberCount - a.memberCount || a.label.localeCompare(b.label));

  console.log(JSON.stringify({
    rootBrokerId: STEVE_SCHONE_ID,
    includeDownline: true,
    scopeBrokerCount: scopeIds.size,
    viewGroupsTotal: allGroups.length,
    inScopeGroups: inScope.length,
    inScopeEmployerGroups: inScopeEmployer.length,
    outsideDownline: outsideDownline.length,
    employerGroups: inScopeEmployer.map((g) => ({
      id: g.e123BrokerId,
      label: g.label,
      members: g.memberCount,
      parentAgentId: g.parentAgentId
    }))
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

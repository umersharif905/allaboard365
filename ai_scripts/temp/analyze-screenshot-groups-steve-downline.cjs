#!/usr/bin/env node
'use strict';

const path = require('path');
const backendRoot = path.join(__dirname, '../../backend');
require(path.join(backendRoot, 'node_modules/dotenv')).config({ path: path.join(backendRoot, '.env') });

const { sql, getPool } = require(path.join(backendRoot, 'config/database'));
const { collectSubtreeBrokerIds } = require(path.join(backendRoot, 'services/migration/agentMigration.service'));
const { classifyEmployerGroupRow } = require(path.join(backendRoot, 'services/migration/e123GroupFilters'));
const { buildParentByAgentId, isGroupInBrokerScope } = require(path.join(backendRoot, 'services/migration/e123BrokerScope.service'));
const e123GroupListSnapshot = require(path.join(backendRoot, 'services/migration/e123GroupListSnapshot.service'));

const STEVE = 785508;
const SHAREWELL = 'C4188882-6A65-4CB5-9D08-43BC6B6189EE';

const screenshotIds = [
  799097,814804,816004,816005,816006,819681,856848,
  799753,806345,807026,816677,817103,863685,877325,878520,940262,943153,967450,970169,972598,
  936409,938717,943650,948988,952966,953602,
  815995,816133,816720,881072,946150,947532,
  807604,807949,814072,817021,817030,819410,820057,841248,939980,
  884391,887133,893486,893722,930371,955423,961757,961873,961913
];

function analyze(g, scopeIds, parentByAgentId) {
  const raw = {
    e123BrokerId: Number(g.e123BrokerId),
    label: g.label,
    memberCount: Number(g.memberCount || 0),
    parentAgentId: g.parentAgentId != null ? Number(g.parentAgentId) : null,
    bgroup: g.bgroup,
    bgrouplistbill: g.bgrouplistbill
  };
  const inScope = isGroupInBrokerScope(raw, scopeIds, parentByAgentId);
  const cls = classifyEmployerGroupRow(raw);
  return {
    raw,
    inScope,
    wizardInclude: inScope && cls.include,
    excludeReason: cls.reason
  };
}

async function main() {
  const pool = await getPool();
  const treeReq = pool.request();
  treeReq.input('instanceId', sql.UniqueIdentifier, SHAREWELL);
  const tree = await treeReq.query(`
    SELECT TOP 1 ExportId FROM oe.MigrationE123AgentTreeExport
    WHERE InstanceId = @instanceId ORDER BY CreatedUtc DESC
  `);
  const exportId = tree.recordset[0].ExportId;
  const nodes = await pool.request()
    .input('exportId', sql.UniqueIdentifier, exportId)
    .query(`SELECT AgentId, ParentAgentId, Label, IsGroup FROM oe.MigrationE123AgentNode WHERE ExportId = @exportId`);
  const rows = nodes.recordset;
  const parentByAgentId = buildParentByAgentId(rows);
  const scopeIds = collectSubtreeBrokerIds(rows, STEVE, true);
  const snapshot = await e123GroupListSnapshot.loadGroupsListIndexForInstance(SHAREWELL);
  const byId = snapshot.groups || {};

  const allInScope = [];
  for (const g of Object.values(byId)) {
    const r = analyze(g, scopeIds, parentByAgentId);
    if (r.inScope) allInScope.push(r);
  }

  const buckets = {
    wizard: [],
    inScopeExcluded: [],
    notInViewGroups: [],
    outsideDownline: []
  };

  for (const id of screenshotIds) {
    const g = byId[id];
    if (!g) {
      buckets.notInViewGroups.push({ id });
      continue;
    }
    const r = analyze(g, scopeIds, parentByAgentId);
    const item = {
      id,
      label: r.raw.label,
      members: r.raw.memberCount,
      parent: r.raw.parentAgentId,
      excludeReason: r.excludeReason
    };
    if (!r.inScope) buckets.outsideDownline.push(item);
    else if (r.wizardInclude) buckets.wizard.push(item);
    else buckets.inScopeExcluded.push(item);
  }

  console.log(JSON.stringify({
    steveDownline: {
      viewGroupsInScope: allInScope.length,
      wizardEmployerGroups: allInScope.filter((r) => r.wizardInclude).length
    },
    screenshotGroups: {
      total: screenshotIds.length,
      inWizard: buckets.wizard.length,
      inDownlineButExcluded: buckets.inScopeExcluded.length,
      outsideDownline: buckets.outsideDownline.length,
      notInViewGroups: buckets.notInViewGroups.length
    },
    screenshotInWizard: buckets.wizard,
    screenshotInDownlineButExcluded: buckets.inScopeExcluded,
    screenshotOutsideDownline: buckets.outsideDownline,
    screenshotNotInViewGroups: buckets.notInViewGroups,
    allInScopeViewGroups: allInScope.map((r) => ({
      include: r.wizardInclude,
      id: r.raw.e123BrokerId,
      members: r.raw.memberCount,
      label: r.raw.label,
      excludeReason: r.excludeReason
    })).sort((a, b) => b.members - a.members || a.label.localeCompare(b.label))
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });

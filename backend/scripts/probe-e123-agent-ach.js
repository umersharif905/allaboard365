#!/usr/bin/env node
'use strict';

/**
 * Live probe: does E123 Admin v2 return full ACH for agents?
 * Usage: node scripts/probe-e123-agent-ach.js [e123BrokerId ...]
 * Does not print full account/routing numbers — only lengths and yes/no.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const migrationInstance = require('../services/migration/migrationInstance.service');
const { runWithInstanceE123Config } = require('../services/migration/e123Config');
const { fetchAgentAchBankInfo } = require('../services/migration/e123AgentBank.service');

function summarize(brokerId, result, profileMeta) {
  const ach = result?.ach;
  const routingLen = ach?.routingNumber ? String(ach.routingNumber).length : 0;
  const accountLen = ach?.accountNumber ? String(ach.accountNumber).length : 0;
  const fullAch =
    result?.available === true
    && routingLen >= 9
    && accountLen > 4
    && ach.payType === 'ACH';

  return {
    brokerId,
    available: !!result?.available,
    reason: result?.reason || null,
    bankAccountId: result?.bankAccountId ?? null,
    routingLen,
    accountLen,
    accountLast4: ach?.accountNumberLast4 || null,
    bankName: ach?.bankName ? '(present)' : null,
    fullAch,
    profileBankIds: profileMeta?.discoveredIds || []
  };
}

async function probeBroker(instanceId, brokerId) {
  return runWithInstanceE123Config(instanceId, () => fetchAgentAchBankInfo(brokerId))
    .then((result) => summarize(brokerId, result, {}));
}

async function main() {
  const instances = await migrationInstance.listInstances();
  const active = instances.filter((i) => !i.isArchived);
  if (!active.length) {
    console.error('NO_MIGRATION_INSTANCES');
    process.exit(1);
  }

  const inst = active[0];
  const cliIds = process.argv.slice(2).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  const brokerIds = [
    ...cliIds,
    inst.orgBrokerId,
    897554
  ].filter((id, idx, arr) => id && arr.indexOf(id) === idx);

  console.log(JSON.stringify({
    instance: inst.label,
    instanceId: inst.instanceId,
    orgBrokerId: inst.orgBrokerId,
    probing: brokerIds
  }));

  const rows = [];
  for (const brokerId of brokerIds) {
    try {
      rows.push(await probeBroker(inst.instanceId, brokerId));
    } catch (err) {
      rows.push({
        brokerId,
        available: false,
        reason: err.message,
        fullAch: false
      });
    }
  }

  const anyFull = rows.some((r) => r.fullAch);
  console.log(JSON.stringify({ results: rows, anyFullAch: anyFull }, null, 2));
  process.exit(anyFull ? 0 : 2);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

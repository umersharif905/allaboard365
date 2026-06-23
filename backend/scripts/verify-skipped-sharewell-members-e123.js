#!/usr/bin/env node
'use strict';

/**
 * Verify skipped Sharewell share-request members against E123 API + OE prod.
 * Usage: node scripts/verify-skipped-sharewell-members-e123.js [jsonPath] [instanceId]
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const { getPool, sql } = require('../config/database');
const { userGetAllPage } = require('../services/migration/e123Api.service');
const { runWithInstanceE123Config } = require('../services/migration/e123Config');
const migrationInstance = require('../services/migration/migrationInstance.service');

const JSON_PATH = process.argv[2] || '/tmp/skipped-share-requests.json';
const INSTANCE_ID = process.argv[3] || 'C4188882-6A65-4CB5-9D08-43BC6B6189EE';

const BROKER_TENANT = {
  785508: { label: 'Steve Schone', tenant: 'ShareWELL Health', tenantId: 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6' },
  788190: { label: 'MightyWELL', tenant: 'MightyWELL Health', tenantId: '1CD92AF7-B6F2-4E48-A8F3-EC6316158826' },
  783390: { label: 'ShareWELL Partners', tenant: 'ShareWELL Health', tenantId: 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6' },
  782721: { label: 'Global Benefits Individual', tenant: 'ShareWELL Health', tenantId: 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6' },
  792515: { label: 'Global Benefits Individual', tenant: 'ShareWELL Health', tenantId: 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6' },
  887431: { label: 'eBenefits', tenant: 'ShareWELL Health', tenantId: 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6' },
};

async function findMemberInE123(memberId) {
  const filters = [
    { MEMBERID: memberId, RETURN_DEPENDENTS: 0, RETURN_PRODUCTS: 0, RETURN_TRANSACTIONS: 0 },
    { MEMBER_ID: memberId, RETURN_DEPENDENTS: 0, RETURN_PRODUCTS: 0, RETURN_TRANSACTIONS: 0 },
  ];
  for (const f of filters) {
    try {
      const page = await userGetAllPage(f, { lightweight: true });
      const match = (page.users || []).find((u) => String(u.memberid || '').trim() === memberId);
      if (match) return { user: match, filter: f };
    } catch {
      // try next filter
    }
  }
  return null;
}

async function loadOeState(memberKeys) {
  const pool = await getPool();
  const keys = memberKeys.map((k) => String(k).trim()).filter(Boolean);
  const placeholders = keys.map((_, i) => `@k${i}`).join(',');

  const bindKeys = (req) => keys.forEach((k, i) => req.input(`k${i}`, sql.NVarChar, k));

  const req = pool.request();
  bindKeys(req);
  const hmidRows = await req.query(`
    SELECT m.HouseholdMemberID, m.MemberId, m.Status, t.Name AS TenantName, t.TenantId
    FROM oe.Members m
    LEFT JOIN oe.Tenants t ON t.TenantId = m.TenantId
    WHERE m.HouseholdMemberID IN (${placeholders})
  `);

  const srcReq = pool.request();
  bindKeys(srcReq);
  const srcRows = await srcReq.query(`
    SELECT SourceKey, MemberId
    FROM oe.MemberSourceKeys
    WHERE SourceSystem = 'sharewell' AND SourceKey IN (${placeholders})
  `);

  const batchReq = pool.request();
  bindKeys(batchReq);
  const batchRows = await batchReq.query(`
    SELECT bh.HouseholdMemberID, b.RootBrokerId, b.RootAgentLabel, b.Status, b.TenantId, t.Name AS TenantName
    FROM oe.MigrationImportBatchHousehold bh
    JOIN oe.MigrationImportBatch b ON b.BatchId = bh.BatchId
    LEFT JOIN oe.Tenants t ON t.TenantId = b.TenantId
    WHERE bh.HouseholdMemberID IN (${placeholders})
  `);

  const hmidMap = new Map(hmidRows.recordset.map((r) => [String(r.HouseholdMemberID).trim(), r]));
  const srcMap = new Map(srcRows.recordset.map((r) => [String(r.SourceKey).trim(), r]));
  const batchMap = new Map();
  for (const r of batchRows.recordset) {
    const k = String(r.HouseholdMemberID).trim();
    if (!batchMap.has(k)) batchMap.set(k, []);
    batchMap.get(k).push(r);
  }
  return { hmidMap, srcMap, batchMap };
}

async function resolveBrokerUpline(brokerIds) {
  const ids = [...new Set(brokerIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const pool = await getPool();
  const placeholders = ids.map((_, i) => `@b${i}`).join(',');
  const r = pool.request();
  ids.forEach((id, i) => r.input(`b${i}`, sql.Int, id));
  const rows = await r.query(`
    SELECT n.BrokerId, n.ParentBrokerId, n.Label, n.Depth
    FROM oe.MigrationE123AgentNode n
    WHERE n.BrokerId IN (${placeholders})
  `);
  return new Map(rows.recordset.map((row) => [Number(row.BrokerId), row]));
}

function classifyRootBroker(brokerId, nodeMap) {
  let cur = Number(brokerId);
  const chain = [];
  for (let i = 0; i < 20 && cur; i++) {
    chain.push(cur);
    const node = nodeMap.get(cur);
    if (!node?.ParentBrokerId) break;
    cur = Number(node.ParentBrokerId);
  }
  for (const root of [785508, 788190, 783390, 782721, 792515, 887431]) {
    if (chain.includes(root)) return root;
  }
  return chain[chain.length - 1] || brokerId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const creds = await migrationInstance.resolveCredentials(INSTANCE_ID);
  if (!creds?.corpid || !creds?.username || !creds?.password) {
    console.error(`E123 credentials missing for instance ${INSTANCE_ID}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const byKey = new Map();
  for (const d of data.details) {
    if (!d.memberKey) continue;
    if (!byKey.has(d.memberKey)) {
      byKey.set(d.memberKey, {
        memberKey: d.memberKey,
        memberName: d.memberName,
        accounts: new Set(),
        requestCount: 0,
      });
    }
    const row = byKey.get(d.memberKey);
    row.accounts.add(d.accountName);
    row.requestCount += 1;
    if (d.memberName && !row.memberName) row.memberName = d.memberName;
  }

  const memberKeys = [...byKey.keys()];
  console.log(`Verifying ${memberKeys.length} unique member keys (${data.details.length} skipped share requests)`);
  console.log(`E123 instance: ${INSTANCE_ID} (${creds.username})`);

  const oe = await loadOeState(memberKeys);
  const results = [];

  await runWithInstanceE123Config(INSTANCE_ID, async () => {
    for (let i = 0; i < memberKeys.length; i++) {
      const key = memberKeys[i];
      const meta = byKey.get(key);
      process.stdout.write(`[${i + 1}/${memberKeys.length}] ${key}... `);
      const found = await findMemberInE123(key);
      if (found) {
        const u = found.user;
        console.log(`E123 userid=${u.userid} broker=${u.brokerid} name=${u.firstname} ${u.lastname} e123MemberId=${u.memberid}`);
        results.push({
          memberKey: key,
          accounts: [...meta.accounts],
          requestCount: meta.requestCount,
          e123: {
            found: true,
            userid: u.userid,
            brokerid: Number(u.brokerid),
            memberid: String(u.memberid || '').trim(),
            firstName: u.firstname,
            lastName: u.lastname,
          },
        });
      } else {
        console.log('NOT IN E123');
        results.push({
          memberKey: key,
          accounts: [...meta.accounts],
          requestCount: meta.requestCount,
          e123: { found: false },
        });
      }
      await sleep(150);
    }
  });

  const brokerIds = results.filter((r) => r.e123.found).map((r) => r.e123.brokerid);
  const nodeMap = await resolveBrokerUpline(brokerIds);

  for (const r of results) {
    if (!r.e123.found) {
      r.rootBrokerId = null;
      r.importBrokerId = null;
      r.importLabel = 'NOT IN E123';
      continue;
    }
    r.rootBrokerId = classifyRootBroker(r.e123.brokerid, nodeMap);
    r.importBrokerId = r.rootBrokerId;
    const bt = BROKER_TENANT[r.rootBrokerId];
    r.importLabel = bt?.label || `Broker ${r.rootBrokerId}`;
    r.tenantName = bt?.tenant || '(resolve tenant)';
    r.tenantId = bt?.tenantId || null;

    const oeH = oe.hmidMap.get(r.memberKey);
    const oeBatch = oe.batchMap.get(r.memberKey) || [];
    const oeSrc = oe.srcMap.get(r.memberKey);
    r.oe = {
      hmidMatch: !!oeH,
      oeHmid: oeH?.HouseholdMemberID || null,
      oeMemberId: oeH?.MemberId || oeSrc?.MemberId || null,
      oeTenant: oeH?.TenantName || null,
      inMigrationBatch: oeBatch.length > 0,
      batchBrokers: [...new Set(oeBatch.map((b) => b.RootBrokerId))],
    };

    if (r.e123.found && oeH && String(oeH.HouseholdMemberID).trim() !== r.memberKey) {
      r.sharewellKeyMismatch = {
        sharewellKey: r.memberKey,
        oeHmid: oeH.HouseholdMemberID,
        e123MemberId: r.e123.memberid,
      };
    } else if (r.e123.found && !oeH && r.e123.memberid !== r.memberKey) {
      const altH = oe.hmidMap.get(r.e123.memberid);
      if (altH) {
        r.sharewellKeyMismatch = {
          sharewellKey: r.memberKey,
          oeHmid: altH.HouseholdMemberID,
          e123MemberId: r.e123.memberid,
        };
      }
    }
  }

  const summary = {
    totalKeys: memberKeys.length,
    inE123: results.filter((r) => r.e123.found).length,
    notInE123: results.filter((r) => !r.e123.found).length,
    oeHmidMatch: results.filter((r) => r.oe?.hmidMatch).length,
    inMigrationBatch: results.filter((r) => r.oe?.inMigrationBatch).length,
    keyMismatch: results.filter((r) => r.sharewellKeyMismatch).length,
    byImportBroker: {},
  };

  for (const r of results) {
    const bucket = r.importBrokerId ? String(r.importBrokerId) : 'not_in_e123';
    if (!summary.byImportBroker[bucket]) {
      summary.byImportBroker[bucket] = {
        importBrokerId: r.importBrokerId,
        label: r.importLabel,
        tenantName: r.tenantName,
        tenantId: r.tenantId,
        count: 0,
        members: [],
      };
    }
    summary.byImportBroker[bucket].count += 1;
    summary.byImportBroker[bucket].members.push({
      memberKey: r.memberKey,
      e123MemberId: r.e123.memberid || null,
      e123BrokerId: r.e123.brokerid || null,
      name: r.e123.found ? `${r.e123.firstName} ${r.e123.lastName}` : null,
      accounts: r.accounts,
      oeHmidMatch: r.oe?.hmidMatch || false,
      inMigrationBatch: r.oe?.inMigrationBatch || false,
      sharewellKeyMismatch: r.sharewellKeyMismatch || null,
    });
  }

  const outPath = '/tmp/skipped-members-e123-verify.json';
  fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nFull report: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

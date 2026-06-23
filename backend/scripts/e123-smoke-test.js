#!/usr/bin/env node
'use strict';

/**
 * E123 API smoke test — run from backend/: node scripts/e123-smoke-test.js [brokerId]
 * Requires E123_CORPID, E123_USERNAME, E123_PASSWORD in backend/.env
 * (Admin v2 agent lookup uses the same credentials)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { getE123MemberSearchConfig, getE123AdminV2Config } = require('../services/migration/e123Config');
const { userGetAllPage, fetchAllUsersForBroker } = require('../services/migration/e123Api.service');
const { buildHouseholdsFromE123Pages } = require('../services/migration/householdNormalizer');
const { getAgentWithParentChain } = require('../services/migration/e123Agent.service');

async function main() {
  const brokerId = Number(process.argv[2]) || Number(process.env.E123_SMOKE_BROKER_ID);
  const memberCfg = getE123MemberSearchConfig();
  const adminCfg = getE123AdminV2Config();

  console.log('=== E123 Smoke Test ===');
  console.log('Member search configured:', !!(memberCfg.corpid && memberCfg.username && memberCfg.password));
  console.log('Admin v2 configured:', !!(adminCfg.username && adminCfg.password));

  if (!memberCfg.corpid || !memberCfg.username || !memberCfg.password) {
    console.error('\nSKIP live API tests — set E123_CORPID, E123_USERNAME, E123_PASSWORD in backend/.env');
    process.exit(0);
  }

  console.log('\n1) Single page user.getall (no broker filter)...');
  const page1 = await userGetAllPage({ USER_IS_LEAD: 0 });
  console.log(`   users on page: ${page1.users.length}, usersTotal attr: ${page1.usersTotal}`);

  if (brokerId) {
    console.log(`\n2) Agent lookup ${brokerId}...`);
    if (adminCfg.username && adminCfg.password) {
      try {
        const chain = await getAgentWithParentChain(brokerId);
        console.log('   agent:', chain.agent?.label, 'parent chain depth:', chain.parentChain.length);
      } catch (err) {
        console.warn('   agent lookup failed:', err.message);
      }
    } else {
      console.log('   skipped — admin v2 creds not set');
    }

    console.log(`\n3) Fetch broker ${brokerId} WITHOUT tree...`);
    const direct = await fetchAllUsersForBroker({ brokerId, includeDownline: false });
    const directHouseholds = buildHouseholdsFromE123Pages(direct);
    console.log(`   raw users: ${direct.membersLoaded}, eligible households: ${directHouseholds.length}`);

    console.log(`\n4) Fetch broker ${brokerId} WITH SHOW_TREE...`);
    const tree = await fetchAllUsersForBroker({ brokerId, includeDownline: true });
    const treeHouseholds = buildHouseholdsFromE123Pages(tree);
    console.log(`   pages: ${tree.pagesCompleted}, raw users: ${tree.membersLoaded}, eligible households: ${treeHouseholds.length}`);

    if (treeHouseholds[0]) {
      const sample = treeHouseholds[0];
      console.log('\n5) Sample household:');
      console.log(`   memberid: ${sample.householdMemberId}, deps: ${sample.dependents.length}, products: ${sample.products.length}`);
    }
  } else {
    console.log('\nPass brokerId arg to test BROKERID + SHOW_TREE, e.g.: node scripts/e123-smoke-test.js 21478');
  }

  console.log('\nSmoke test complete.');
}

main().catch((err) => {
  console.error('Smoke test failed:', err.message);
  process.exit(1);
});

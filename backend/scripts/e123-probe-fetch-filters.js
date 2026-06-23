#!/usr/bin/env node
'use strict';

/**
 * Probe E123 user.getall with many filter combinations to diagnose 0-user responses.
 * Usage:
 *   DB_NAME=allaboard-prod node scripts/e123-probe-fetch-filters.js [brokerId]
 *   DB_NAME=allaboard-prod node scripts/e123-probe-fetch-filters.js 785508 --instance
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true });
if (process.env.OE_PROBE_DB) process.env.DB_NAME = process.env.OE_PROBE_DB;
process.env.NODE_ENV = 'production';

const axios = require('axios');
const { runWithE123Config } = require('../services/migration/e123Config');
const { userGetAllPage, fetchAllUsersForBroker } = require('../services/migration/e123Api.service');
const { parseUserGetAllResponse } = require('../services/migration/e123XmlParser');
const migrationInstance = require('../services/migration/migrationInstance.service');
const { getAgentWithParentChain } = require('../services/migration/e123Agent.service');

const INSTANCE_ID = 'C4188882-6A65-4CB5-9D08-43BC6B6189EE';
const BROKERS = [785508, 788190, 783390, 775982];

async function rawPost(cfg, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') body.set(k, String(v));
  }
  const response = await axios.post(cfg.url, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    responseType: 'text',
    timeout: 120000,
    validateStatus: (s) => s >= 200 && s < 500
  });
  const xml = String(response.data || '');
  const snippet = xml.slice(0, 500).replace(/\s+/g, ' ');
  const parsed = parseUserGetAllResponse(xml);
  return {
    httpStatus: response.status,
    xmlLen: xml.length,
    snippet,
    parsed
  };
}

async function probeFilter(cfg, label, params) {
  try {
    const r = await rawPost(cfg, {
      CORPID: cfg.corpid,
      USERNAME: cfg.username,
      PASSWORD: cfg.password,
      USER_IS_LEAD: 0,
      RETURN_DEPENDENTS: 0,
      RETURN_PRODUCTS: 0,
      RETURN_TRANSACTIONS: 0,
      ...params
    });
    const p = r.parsed;
    console.log(`  [${label}] http=${r.httpStatus} xmlLen=${r.xmlLen} users=${p.users.length} total=${p.usersTotal} authFail=${p.authFailed}`);
    if (p.users.length === 0 && r.xmlLen < 800) {
      console.log(`    snippet: ${r.snippet}`);
    } else if (p.users[0]) {
      console.log(`    first: userid=${p.users[0].userid} memberid=${p.users[0].memberid} broker=${p.users[0].brokerid}`);
    }
    return p.users.length;
  } catch (err) {
    console.log(`  [${label}] ERROR: ${err.message}`);
    return -1;
  }
}

async function main() {
  const useInstance = process.argv.includes('--instance');
  const brokerArg = Number(process.argv.find((a) => /^\d+$/.test(a)));

  let creds;
  if (useInstance) {
    creds = await migrationInstance.resolveCredentials(INSTANCE_ID);
    console.log('Using migration instance credentials:', {
      corpid: creds?.corpid,
      username: creds?.username,
      hasPassword: !!creds?.password
    });
  } else {
    creds = {
      corpid: process.env.E123_CORPID,
      username: process.env.E123_USERNAME,
      password: process.env.E123_PASSWORD
    };
    console.log('Using .env credentials:', {
      corpid: creds.corpid,
      username: creds.username,
      hasPassword: !!creds.password
    });
  }

  if (!creds?.corpid || !creds?.username || !creds?.password) {
    console.error('Missing E123 credentials');
    process.exit(1);
  }

  const cfg = {
    url: process.env.E123_USER_GETALL_URL || 'https://www.enrollment123.com/api/user.getall/',
    corpid: creds.corpid,
    username: creds.username,
    password: creds.password
  };

  await runWithE123Config({ ...creds, instanceId: INSTANCE_ID }, async () => {
    console.log('\n=== Admin v2 agent check ===');
    for (const id of [785508, 788190]) {
      try {
        const chain = await getAgentWithParentChain(id);
        console.log(`  ${id}: ${chain.agent?.label} (parents: ${chain.parentChain.length})`);
      } catch (err) {
        console.log(`  ${id}: lookup failed — ${err.message}`);
      }
    }

    console.log('\n=== user.getall filter matrix ===');
    const brokers = brokerArg ? [brokerArg] : BROKERS;

    await probeFilter(cfg, 'no broker filter', {});
    await probeFilter(cfg, 'USER_IS_LEAD=1', { USER_IS_LEAD: 1 });

    for (const brokerId of brokers) {
      console.log(`\n--- broker ${brokerId} ---`);
      await probeFilter(cfg, 'BROKERID only', { BROKERID: brokerId });
      await probeFilter(cfg, 'BROKERID+SHOW_TREE', { BROKERID: brokerId, SHOW_TREE: 1 });
      await probeFilter(cfg, 'BROKERID+SHOW_TREE=0', { BROKERID: brokerId, SHOW_TREE: 0 });
      await probeFilter(cfg, 'BROKERID+full payload', {
        BROKERID: brokerId,
        SHOW_TREE: 1,
        RETURN_DEPENDENTS: 1,
        RETURN_PRODUCTS: 1,
        RETURN_TRANSACTIONS: 1
      });
      await probeFilter(cfg, 'BROKER_ID alias', { BROKER_ID: brokerId, SHOW_TREE: 1 });
      await probeFilter(cfg, 'SELLINGAGENTID', { SELLINGAGENTID: brokerId, SHOW_TREE: 1 });
    }

    await probeFilter(cfg, 'MEMBERID SW3057692', { MEMBERID: 'SW3057692', RETURN_PRODUCTS: 1 });
    await probeFilter(cfg, 'MEMBERID SW3132459', { MEMBERID: 'SW3132459', RETURN_PRODUCTS: 1 });

    console.log('\n=== fetchAllUsersForBroker (our wizard path) ===');
    for (const brokerId of brokers.slice(0, 2)) {
      const r = await fetchAllUsersForBroker({ brokerId, includeDownline: true, logPrefix: `[probe ${brokerId}]` });
      console.log(`  broker ${brokerId}: pages=${r.pagesCompleted} users=${r.membersLoaded}`);
    }
  });

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

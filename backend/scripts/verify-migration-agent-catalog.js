#!/usr/bin/env node
'use strict';

/**
 * Verify migration agent catalog populates without a saved org broker ID (auto-discovery path).
 *
 * Usage:
 *   node scripts/verify-migration-agent-catalog.js [instanceId] [--prod-readonly-db]
 *
 * Loads backend/.env for ENCRYPTION_KEY + DB. Uses prod migration instance by default.
 */
const path = require('path');
const fs = require('fs');

const backendEnv = path.join(__dirname, '../.env');
if (fs.existsSync(backendEnv)) {
  require('dotenv').config({ path: backendEnv });
}

const aiEnv = path.join(__dirname, '../../ai_scripts/.env');
if (fs.existsSync(aiEnv)) {
  const raw = fs.readFileSync(aiEnv, 'utf8').replace(/^\uFEFF/, '');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

const useProdReadonlyDb = process.argv.includes('--prod-readonly-db');
if (useProdReadonlyDb) {
  process.env.DB_NAME = 'allaboard-prod';
  if (process.env.DB_USER_PROD_READONLY) {
    process.env.DB_USER = process.env.DB_USER_PROD_READONLY;
  } else if (!process.env.DB_USER || process.env.DB_USER === 'allaboardadmin') {
    process.env.DB_USER = 'oe_ai_readonly';
  }
  if (process.env.DB_PASSWORD_PROD_READONLY) {
    process.env.DB_PASSWORD = process.env.DB_PASSWORD_PROD_READONLY;
  }
}

// Prevent config/database.js from reloading .env and overwriting prod target.
process.env.NODE_ENV = 'production';

const DEFAULT_INSTANCE_ID = 'C4188882-6A65-4CB5-9D08-43BC6B6189EE';
const instanceId = process.argv.find((a) => /^[0-9a-f-]{36}$/i.test(a)) || DEFAULT_INSTANCE_ID;
const MAX_ATTEMPTS = 30;
const POLL_MS = 5000;
const MIN_AGENTS = 1;

const migrationInstance = require('../services/migration/migrationInstance.service');
const { runWithE123Config } = require('../services/migration/e123Config');
const migrationAgentCatalog = require('../services/migration/migrationAgentCatalog.service');
const orgBrokerDiscovery = require('../services/migration/orgBrokerDiscovery.service');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countAgents(result) {
  const presets = result?.presets || [];
  const agents = result?.agents || [];
  return presets.length + agents.length;
}

async function loadOptionsSimulatingProd() {
  const creds = await migrationInstance.resolveCredentials(instanceId);
  if (!creds?.username || !creds?.password) {
    throw new Error('Migration instance credentials missing or could not decrypt password');
  }

  // Prod state: org broker not saved on instance
  const { orgBrokerId: _saved, orgBrokerLabel: _label, ...rest } = creds;

  return runWithE123Config({ ...rest, instanceId }, async () => {
    orgBrokerDiscovery.ensureOrgBrokerDiscovery(instanceId);
    return migrationAgentCatalog.getMigrationAgentOptions({
      search: '',
      limit: 500,
      topLevelOnly: true
    });
  });
}

async function main() {
  console.log('=== Migration agent catalog verification ===');
  console.log('Instance:', instanceId);
  console.log('DB:', process.env.DB_SERVER, '/', process.env.DB_NAME);
  console.log('Simulating: no OrgBrokerId saved on instance\n');

  const creds = await migrationInstance.resolveCredentials(instanceId);
  console.log('Credentials:', {
    corpid: creds?.corpid || null,
    username: creds?.username || null,
    hasPassword: !!(creds?.password),
    savedOrgBrokerId: creds?.orgBrokerId || null
  });

  let lastResult = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    lastResult = await loadOptionsSimulatingProd();
    const total = countAgents(lastResult);
    const sample = [...(lastResult.presets || []), ...(lastResult.agents || [])]
      .slice(0, 5)
      .map((a) => ({ id: a.rootBrokerId, label: a.label || a.rootAgentLabel, isOrgRoot: !!a.isOrgRoot }));

    console.log(JSON.stringify({
      attempt,
      ms: Date.now() - started,
      totalAgents: total,
      agentsTotalCount: lastResult.agentsTotalCount,
      source: lastResult.source,
      indexBuilding: lastResult.indexBuilding,
      orgBrokerDiscovering: lastResult.diagnostics?.orgBrokerDiscovering,
      resolvedOrgBrokerId: lastResult.resolvedOrgBrokerId,
      issues: lastResult.diagnostics?.issues || [],
      notes: lastResult.diagnostics?.notes || [],
      sample
    }, null, 2));

    if (total >= MIN_AGENTS && !lastResult.indexBuilding && !lastResult.diagnostics?.orgBrokerDiscovering) {
      console.log('\n✅ PASS — agent dropdown would be populated');
      process.exit(0);
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(POLL_MS);
    }
  }

  console.error('\n❌ FAIL — dropdown still empty after polling');
  console.error('Discovery error:', orgBrokerDiscovery.getOrgBrokerDiscoveryError(instanceId));
  console.error('Last diagnostics:', lastResult?.diagnostics);
  process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

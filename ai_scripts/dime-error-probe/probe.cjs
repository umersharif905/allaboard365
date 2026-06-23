#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * DIME sandbox error probe.
 *
 * Goal: make real HTTP calls against the DIME sandbox for each scenario in
 * scenarios.json so we can verify (and extend) the classification catalog in
 * `backend/services/dimeService.js`. Captures the raw response shape — NOT a
 * sanitized version — so we can see exactly what fields DIME returns on each
 * failure mode.
 *
 * Credentials are pulled from the allaboard-testing DB for the configured
 * tenant (default: MightyWell). We reuse the backend's encryptionService so
 * the apiToken/webhookSecret decrypt matches what the app does at runtime.
 *
 * Usage:
 *   node ai_scripts/dime-error-probe/probe.cjs
 *   node ai_scripts/dime-error-probe/probe.cjs --tenant "MightyWell Health"
 *   node ai_scripts/dime-error-probe/probe.cjs --scenario cc.decline.insufficient-funds
 *   node ai_scripts/dime-error-probe/probe.cjs --skip-ach
 *   node ai_scripts/dime-error-probe/probe.cjs --skip-cc
 *
 * Env (loaded from ai_scripts/.env, falls back to backend/.env for ENCRYPTION_KEY):
 *   DB_SERVER, DB_NAME, DB_USER, DB_PASSWORD — testing DB credentials
 *   ENCRYPTION_KEY — same key backend uses (required to decrypt DIME apiToken)
 *
 * Hard safety guard: refuses to run if the tenant's DIME environment setting
 * isn't `demo`. We never want this script hitting live DIME from a devbox.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadDotEnv(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (_) { /* ignore missing */ }
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
loadDotEnv(path.join(REPO_ROOT, 'ai_scripts', '.env'));
loadDotEnv(path.join(REPO_ROOT, 'backend', '.env'));

const argv = process.argv.slice(2);
function arg(name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1] || null;
}
const flag = (name) => argv.includes(name);

const tenantNameArg = arg('--tenant') || 'MightyWell Health';
const scenarioFilter = arg('--scenario');
const skipAch = flag('--skip-ach');
const skipCc = flag('--skip-cc');

const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenarios.json'), 'utf8'));

// Use backend's node_modules so we don't duplicate mssql/axios locally.
const backendNodeModules = path.join(REPO_ROOT, 'backend', 'node_modules');
function loadBackendModule(id) {
  const resolved = require.resolve(id, { paths: [backendNodeModules] });
  return require(resolved);
}
const mssql = loadBackendModule('mssql');
const axios = loadBackendModule('axios');

const encryptionService = require(path.join(REPO_ROOT, 'backend', 'services', 'encryptionService'));
const dimeCardBrand = require(path.join(REPO_ROOT, 'backend', 'services', 'dimeCardBrand'));

async function loadTenantConfig(tenantName) {
  // Hard-pin the testing DB. Probing prod DIME credentials is a safety hazard even though
  // the environment check below would still catch it — skip the footgun entirely.
  const dbName = 'allaboard-testing';
  const pool = await mssql.connect({
    server: process.env.DB_SERVER || 'allboard-prod.database.windows.net',
    database: dbName,
    user: process.env.DB_USER || 'oe-sqladmin',
    password: process.env.DB_PASSWORD,
    options: { encrypt: true, trustServerCertificate: false }
  });
  const res = await pool
    .request()
    .input('name', mssql.NVarChar(200), tenantName)
    .query(`
      SELECT TOP 1 TenantId, Name, PaymentProcessorSettings
      FROM oe.Tenants
      WHERE Name = @name
    `);
  await pool.close();
  if (res.recordset.length === 0) {
    throw new Error(`Tenant not found in ${dbName}: "${tenantName}"`);
  }
  const row = res.recordset[0];
  if (!row.PaymentProcessorSettings) {
    throw new Error(`Tenant "${tenantName}" has no PaymentProcessorSettings in the testing DB.`);
  }
  const settings = JSON.parse(row.PaymentProcessorSettings);
  const dime = settings?.processors?.openenroll?.dime;
  if (!dime) {
    throw new Error(`Tenant "${tenantName}" has no DIME block in PaymentProcessorSettings.`);
  }
  const environment = dime.environment || 'production';
  if (environment !== 'demo') {
    throw new Error(
      `REFUSING TO RUN: tenant "${tenantName}" is configured for DIME environment="${environment}". ` +
      `This probe only runs against the DIME sandbox (environment="demo"). Point it at a testing tenant instead.`
    );
  }
  const apiToken = dime.apiTokenEncrypted
    ? encryptionService.decrypt(dime.apiTokenEncrypted)
    : dime.apiToken;
  if (!apiToken) throw new Error('Failed to decrypt DIME apiToken for tenant.');
  return {
    tenantId: row.TenantId,
    tenantName: row.Name,
    apiToken,
    sid: dime.sid,
    baseUrl: 'https://demo.dimepayments.com'
  };
}

function headers(config) {
  return {
    Authorization: `Bearer ${config.apiToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

async function createProbeCustomer(config, label) {
  const payload = {
    data: {
      sid: config.sid,
      first_name: 'Probe',
      last_name: `Test ${label.slice(0, 32)}`,
      email: `probe+${Date.now()}+${Math.random().toString(36).slice(2, 6)}@allaboard365.com`,
      phone: '8002691451',
      addr1: '123 Main St',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      country: 'USA'
    }
  };
  try {
    const res = await axios.post(`${config.baseUrl}/api/customer/create`, payload, { headers: headers(config) });
    return {
      ok: true,
      customerId: res.data?.customer_id || res.data?.data?.customer_id || res.data?.data?.uuid,
      rawResponse: res.data
    };
  } catch (err) {
    return {
      ok: false,
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    };
  }
}

async function runCreditCardScenario(config, customerId, scenario) {
  // Mirror the backend's brand inference so DIME doesn't reject us for missing cc_brand.
  // For invalid-number scenarios we intentionally leave it null so DIME can surface its real error.
  const brand = dimeCardBrand.getCardBrandOrNull(String(scenario.card.number));
  const payload = {
    filters: { uuid: customerId },
    data: {
      sid: config.sid,
      type: 'cc',
      uuid: customerId,
      cc_number: scenario.card.number,
      cc_cvv: scenario.card.cvv,
      cc_name_on_card: 'Probe Test',
      cc_last_four: String(scenario.card.number).slice(-4),
      cc_expiration_date: `${String(scenario.card.expiryMonth).padStart(2, '0')}/${scenario.card.expiryYear}`,
      cc_brand: brand || undefined,
      addr1: '123 Main St',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      default: true
    }
  };
  try {
    const res = await axios.post(`${config.baseUrl}/api/payment-method/create`, payload, { headers: headers(config) });
    return { status: res.status, body: res.data };
  } catch (err) {
    return {
      status: err.response?.status ?? null,
      body: err.response?.data ?? null,
      axiosMessage: err.message
    };
  }
}

async function runBankAccountScenario(config, customerId, scenario) {
  const payload = {
    filters: { uuid: customerId },
    data: {
      sid: config.sid,
      type: 'ach',
      uuid: customerId,
      ach_bank_account_name: scenario.bank.nameOnAccount,
      ach_routing_number: scenario.bank.routingNumber,
      ach_account_number: scenario.bank.accountNumber,
      ach_ownership_type: 'Personal',
      ach_account_type: scenario.bank.accountType,
      ach_bank_name: 'Probe Test Bank',
      default: true,
      addr1: '123 Main St',
      city: 'Austin',
      state: 'TX',
      zip: '78701'
    }
  };
  try {
    const res = await axios.post(`${config.baseUrl}/api/payment-method/create`, payload, { headers: headers(config) });
    return { status: res.status, body: res.data };
  } catch (err) {
    return {
      status: err.response?.status ?? null,
      body: err.response?.data ?? null,
      axiosMessage: err.message
    };
  }
}

function classify(result) {
  const status = result.status;
  const body = result.body;
  if (status && status >= 200 && status < 300) return 'success';
  if (status === 500 || status === 502 || status === 503 || status === 504) return 'server_error';
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 400 || status === 422) {
    const errors = body?.errors;
    if (errors && typeof errors === 'object' && Object.keys(errors).length > 0) return 'validation';
    const msg = String(body?.message || body?.data?.message || body?.error?.message || '').toLowerCase();
    if (/decline|do not honor|not approved|insufficient|expired|restricted|cvv|invalid card|invalid number|avs|invalid routing|invalid account|nsf|r\d{2}|closed account|no account|unable to locate/.test(msg)) {
      return 'known_decline';
    }
    return 'unclassified_4xx';
  }
  return 'other';
}

async function main() {
  console.log(`\nDIME error probe — tenant=${tenantNameArg}`);
  const config = await loadTenantConfig(tenantNameArg);
  console.log(`Loaded DIME demo config · sid=${config.sid} · baseUrl=${config.baseUrl}\n`);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${ts}.json`);
  const mdPath = path.join(outDir, `${ts}.md`);

  const results = [];
  const mdLines = [
    `# DIME probe — ${ts}`,
    `Tenant: ${config.tenantName} (${config.tenantId})`,
    `SID: ${config.sid} · baseUrl: ${config.baseUrl}`,
    '',
    '| scenario | expect | http | classify | message |',
    '| --- | --- | --- | --- | --- |'
  ];

  const scenariosToRun = [
    ...(skipCc ? [] : scenarios.creditCardScenarios.map((s) => ({ kind: 'cc', s }))),
    ...(skipAch ? [] : scenarios.bankAccountScenarios.map((s) => ({ kind: 'ach', s })))
  ].filter(({ s }) => (scenarioFilter ? s.id === scenarioFilter : true));

  for (const { kind, s } of scenariosToRun) {
    console.log(`→ ${s.id} · ${s.label}`);

    const customer = await createProbeCustomer(config, s.id);
    if (!customer.ok) {
      console.log(`  ! customer create failed (status=${customer.status}); skipping`);
      results.push({ id: s.id, kind, label: s.label, expect: s.expect, customerCreateError: customer });
      mdLines.push(`| ${s.id} | ${s.expect} | — | customer_create_failed | ${JSON.stringify(customer.data || customer.message).slice(0, 120)} |`);
      continue;
    }

    const customerId = customer.customerId;
    const result = kind === 'cc'
      ? await runCreditCardScenario(config, customerId, s)
      : await runBankAccountScenario(config, customerId, s);
    const bucket = classify(result);
    const msg = String(
      result.body?.message
        || result.body?.data?.message
        || result.body?.error?.message
        || (result.body?.errors ? JSON.stringify(result.body.errors) : '')
        || result.axiosMessage
        || ''
    ).replace(/\|/g, '/').slice(0, 200);
    console.log(`  ← http=${result.status ?? '—'} classify=${bucket} msg="${msg.slice(0, 80)}"`);
    results.push({ id: s.id, kind, label: s.label, expect: s.expect, customerId, request: { kind }, response: result, classify: bucket });
    mdLines.push(`| ${s.id} | ${s.expect} | ${result.status ?? '—'} | ${bucket} | ${msg} |`);
  }

  fs.writeFileSync(jsonPath, JSON.stringify({ tenant: config.tenantName, results }, null, 2));
  fs.writeFileSync(mdPath, mdLines.join('\n') + '\n');

  console.log(`\nWrote:\n  ${jsonPath}\n  ${mdPath}\n`);
  console.log('Cross-check against the catalog in `docs/billing/dime-payments.md` — any');
  console.log('scenario that landed in `unclassified_4xx` or `server_error` is a candidate');
  console.log('for adding to the decline regex in backend/services/dimeService.js.');
}

main().catch((err) => {
  console.error('\nProbe failed:', err && err.message ? err.message : err);
  process.exit(1);
});

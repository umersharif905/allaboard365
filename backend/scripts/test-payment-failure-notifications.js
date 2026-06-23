#!/usr/bin/env node
'use strict';

/**
 * Queue payment-failure emails (same internal route the DIME webhook uses).
 *
 * Prerequisites:
 *   - Backend API running (`npm run dev` or equivalent) so /api/internal/* is reachable
 *   - backend/.env: INTERNAL_API_TOKEN must match what you send
 *
 * Usage (from backend/):
 *   node scripts/test-payment-failure-notifications.js you@example.com
 *   node scripts/test-payment-failure-notifications.js you@example.com group
 *
 * Env overrides:
 *   PAYMENT_FAILURE_TEST_URL     API base URL (default http://127.0.0.1:${PORT||3001})
 *   PAYMENT_FAILURE_TEST_TENANT_ID   Tenant GUID (otherwise first row from oe.Tenants)
 *   INTERNAL_API_TOKEN               header auth (omit if server has PAYMENT_FAILURE_NOTIFICATION_TEST_BYPASS=true and NODE_ENV != production)
 *   PAYMENT_FAILURE_NOTIFICATION_TEST_BYPASS   when true + non-production Node, route skips internal token — local smoke only
 *
 * Arguments:
 *   email              recipient for test messages
 *   [scenario]        member | group   (default: member → member + agent copy both to email)
 */

const path = require('path');
const axios = require('axios');

if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
}

const { getPool, sql } = require('../config/database');

async function resolveTenantId() {
  const fromEnv = process.env.PAYMENT_FAILURE_TEST_TENANT_ID;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();

  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT TOP (1) CAST(TenantId AS NVARCHAR(36)) AS TenantId
    FROM oe.Tenants
    ORDER BY ModifiedDate DESC
  `);
  const id = r.recordset?.[0]?.TenantId;
  if (!id) throw new Error('No tenants in oe.Tenants — set PAYMENT_FAILURE_TEST_TENANT_ID');
  console.warn(`Using first tenant by ModifiedDate: ${id} (set PAYMENT_FAILURE_TEST_TENANT_ID to pin)`);
  return id;
}

function buildPayload(tenantId, scenario, email) {
  const base = {
    tenantId,
    paymentAmount: 101.01,
    paymentDate: new Date().toISOString(),
    paymentMethod: 'Credit Card',
    transactionId: `TEST-PAYFAIL-${Date.now()}`,
    failureReason: 'Smoke test — safe to ignore. Synthetic decline message.',
    createdBy: null
  };

  if (scenario === 'group') {
    return {
      ...base,
      paymentMethod: 'Recurring',
      memberEmail: email,
      memberDisplayName: 'Benefits billing contact',
      groupBillingContact: true,
      groupName: 'Test Group LLC (smoke)',
      agentEmail: email,
      agentDisplayName: 'Test Agent',
      agentScope: 'group'
    };
  }

  /* member enrollment-style: same inbox gets member letter + agent letter */
  return {
    ...base,
    memberEmail: email,
    memberDisplayName: 'Smoke Test Member',
    groupName: 'Test Group LLC (smoke)',
    groupBillingContact: false,
    agentEmail: email,
    agentDisplayName: 'Smoke Test Agent',
    agentScope: 'member',
    memberDisplayNameForAgent: 'Smoke Test Member'
  };
}

async function main() {
  const email = (process.argv[2] || process.env.PAYMENT_FAILURE_TEST_EMAIL || '').trim();
  const scenarioRaw = (process.argv[3] || 'member').toLowerCase();
  const scenario = scenarioRaw === 'group' ? 'group' : 'member';

  if (!email) {
    console.error(
      'Usage: node scripts/test-payment-failure-notifications.js <email> [member|group]\n' +
        'Example: node scripts/test-payment-failure-notifications.js you@company.com member'
    );
    process.exit(1);
  }

  const token = process.env.INTERNAL_API_TOKEN;
  const usingBypass =
    process.env.PAYMENT_FAILURE_NOTIFICATION_TEST_BYPASS === 'true' &&
    process.env.NODE_ENV !== 'production';
  if (!token && !usingBypass) {
    console.error(
      'Set INTERNAL_API_TOKEN in .env, or for local smoke only set PAYMENT_FAILURE_NOTIFICATION_TEST_BYPASS=true with NODE_ENV != production.'
    );
    process.exit(1);
  }
  if (!token && usingBypass) {
    console.warn('No INTERNAL_API_TOKEN — using PAYMENT_FAILURE_NOTIFICATION_TEST_BYPASS (server must load same from .env and be non-production)');
  }

  const port = process.env.PORT || 3001;
  const baseUrl = (
    process.env.PAYMENT_FAILURE_TEST_URL ||
    process.env.API_BASE_URL ||
    `http://127.0.0.1:${port}`
  )
    .replace(/\/$/, '')
    .trim();

  const tenantId = await resolveTenantId();
  const payload = buildPayload(tenantId, scenario, email);

  const url = `${baseUrl}/api/internal/payment-failure-notifications/queue`;

  console.log(`POST ${url}`);
  console.log(`Scenario: ${scenario} → memberQueued + agentQueued (same address unless you edit payload)`);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['x-internal-token'] = token;

    const res = await axios.post(url, payload, {
      headers,
      timeout: 60000,
      validateStatus: () => true
    });

    console.log(`HTTP ${res.status}`, JSON.stringify(res.data, null, 2));

    if (res.status !== 200 || !res.data?.success) {
      process.exit(1);
    }

    console.log('\n✅ Queued. Check MessageQueue / SendGrid — two subjects for member scenario:');
    console.log('   • Payment failed — …');
    console.log('   • Member payment declined — …');
  } catch (err) {
    console.error(err.response?.data || err.message);
    console.error('\nTip: Start the API on this machine, or set PAYMENT_FAILURE_TEST_URL to your API base.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

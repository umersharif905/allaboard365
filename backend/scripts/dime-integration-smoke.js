/**
 * Real DIME API smoke test (not Jest — hits demo.dimepayments.com).
 *
 * Uses the same credential path as production code: oe.Tenants PaymentProcessorSettings
 * via DimeService.getConfigForTenant. Refuses to run unless the tenant's DIME
 * environment is "demo".
 *
 * Prerequisites:
 * - backend/.env with DB connection (same as local API)
 * - Tenant configured in Admin with Open Enroll + DIME demo SID/token
 * - A group with ProcessorCustomerId (DIME customer UUID) OR set DIME_INTEGRATION_CUSTOMER_UUID
 *
 * Usage (from repo root or backend):
 *   cd backend && node scripts/dime-integration-smoke.js
 *
 * Env:
 *   DIME_INTEGRATION_TENANT_ID   (required) tenant UUID
 *   DIME_INTEGRATION_GROUP_ID    (optional) group UUID — loads ProcessorCustomerId
 *   DIME_INTEGRATION_CUSTOMER_UUID (optional) if no group; DIME customer_uuid
 *   DIME_INTEGRATION_AMOUNT      (optional) default 1.00
 *   DIME_INTEGRATION_TEST_CARD   (optional) PAN; default sandbox-style test number
 */

const path = require('path');
if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
}

const { getPool, sql } = require('../config/database');
const DimeService = require('../services/dimeService');

async function assertTenantDimeIsDemo(pool, tenantId) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT Name, PaymentProcessorSettings
      FROM oe.Tenants
      WHERE TenantId = @tenantId
    `);
  if (r.recordset.length === 0) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }
  const row = r.recordset[0];
  if (!row.PaymentProcessorSettings) {
    throw new Error(`Tenant "${row.Name}" has no PaymentProcessorSettings`);
  }
  const settings = JSON.parse(row.PaymentProcessorSettings);
  const env = settings.processors?.openenroll?.dime?.environment;
  if (env !== 'demo') {
    throw new Error(
      `Refusing to run: tenant "${row.Name}" DIME environment is "${env || 'unknown'}", not "demo". ` +
        'Set DIME to demo in tenant payment settings before using this script.'
    );
  }
  return row.Name;
}

async function main() {
  const tenantId = process.env.DIME_INTEGRATION_TENANT_ID;
  const groupId = process.env.DIME_INTEGRATION_GROUP_ID;
  let customerUuid = process.env.DIME_INTEGRATION_CUSTOMER_UUID;
  const amount = Number.parseFloat(String(process.env.DIME_INTEGRATION_AMOUNT ?? '1')) || 1;

  if (!tenantId) {
    console.error('Set DIME_INTEGRATION_TENANT_ID to your tenant UUID.');
    process.exit(1);
  }

  const pool = await getPool();
  const tenantName = await assertTenantDimeIsDemo(pool, tenantId);

  if (!customerUuid && groupId) {
    const gr = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`SELECT ProcessorCustomerId FROM oe.Groups WHERE GroupId = @groupId`);
    if (!gr.recordset.length || !gr.recordset[0].ProcessorCustomerId) {
      throw new Error(`Group ${groupId} not found or ProcessorCustomerId is null`);
    }
    customerUuid = String(gr.recordset[0].ProcessorCustomerId);
  }

  if (!customerUuid) {
    console.error('Provide DIME_INTEGRATION_GROUP_ID (with ProcessorCustomerId) or DIME_INTEGRATION_CUSTOMER_UUID.');
    process.exit(1);
  }

  const cardNumber = (process.env.DIME_INTEGRATION_TEST_CARD || '4242424242424242').replace(/\s/g, '');

  console.log('DIME integration smoke');
  console.log({ tenantName, tenantId, customerUuid: `${customerUuid.slice(0, 8)}…`, amount });

  const result = await DimeService.processPayment(
    {
      customerId: customerUuid,
      paymentMethodId: 'RAW_CARD',
      amount,
      description: 'Local DIME integration smoke (backend/scripts)',
      paymentMethodType: 'Card',
      invoiceNumber: `SMOKE-${Date.now()}`,
      idempotencyKey: `dime_smoke_${Date.now()}`,
      cardNumber,
      expiryDate: '12/2029',
      cvv: '123',
      cardholderName: 'Integration Test',
      billingAddress: '123 Test St',
      billingCity: 'Atlanta',
      billingState: 'GA',
      billingZip: '30301'
    },
    tenantId
  );

  console.log('processPayment result:', JSON.stringify(result, null, 2));
  if (!result.success) {
    process.exit(1);
  }
  console.log('OK — recordStatus:', result.recordStatus, 'transactionId:', result.transactionId);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

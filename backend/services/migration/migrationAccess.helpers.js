'use strict';

const migrationBatch = require('./migrationBatch.service');
const migrationInstance = require('./migrationInstance.service');

function effectiveInstanceId(req) {
  if (req.migrationContext?.instanceId) return req.migrationContext.instanceId;
  return req.query.instanceId || req.body?.instanceId || null;
}

function effectiveTenantId(req) {
  if (req.migrationContext?.isTenantPortal) return req.migrationContext.tenantId;
  return null;
}

function assertTenantInScope(req, tenantId) {
  if (!req.migrationContext?.isTenantPortal) return;
  const scoped = String(req.migrationContext.tenantId || '').toLowerCase();
  const requested = String(tenantId || '').toLowerCase();
  if (!scoped || scoped !== requested) {
    const err = new Error('Tenant not in scope for this migration portal');
    err.status = 403;
    throw err;
  }
}

async function assertBatchInScope(req, batchId) {
  const batch = await migrationBatch.getBatch(batchId);
  if (!batch) return null;
  assertMigrationBatchRowInScope(req, batch);
  return batch;
}

async function assertGroupBatchInScope(req, batchId) {
  const groupMigration = require('./groupMigration.service');
  const batch = await groupMigration.getBatch(batchId);
  if (!batch) return null;
  assertMigrationBatchRowInScope(req, batch);
  return batch;
}

function assertMigrationBatchRowInScope(req, batch) {
  if (!req.migrationContext?.isTenantPortal) return;
  const { instanceId, tenantId } = req.migrationContext;
  if (batch.InstanceId && String(batch.InstanceId).toLowerCase() !== String(instanceId).toLowerCase()) {
    const err = new Error('Batch not in scope for this migration portal');
    err.status = 403;
    throw err;
  }
  if (batch.TenantId && String(batch.TenantId).toLowerCase() !== String(tenantId).toLowerCase()) {
    const err = new Error('Batch not in scope for this migration portal');
    err.status = 403;
    throw err;
  }
}

function assertInstanceInScope(req, instanceId) {
  if (!req.migrationContext?.isTenantPortal) return;
  const scoped = String(req.migrationContext.instanceId || '').toLowerCase();
  const requested = String(instanceId || '').toLowerCase();
  if (!scoped || scoped !== requested) {
    const err = new Error('Migration instance not in scope for this portal');
    err.status = 403;
    throw err;
  }
}

async function resolveScopedTenants(req, instanceId) {
  if (req.migrationContext?.isTenantPortal) {
    const tenants = await migrationInstance.getInstanceTenants(instanceId);
    return tenants.filter(
      (row) => String(row.TenantId).toLowerCase() === String(req.migrationContext.tenantId).toLowerCase()
    );
  }
  if (instanceId) {
    return migrationInstance.getInstanceTenants(instanceId);
  }
  const pool = await require('../../config/database').getPool();
  const result = await pool.request().query(`
    SELECT TenantId, Name, Status
    FROM oe.Tenants
    WHERE Status = 'Active'
      AND TenantId <> '00000000-0000-0000-0000-000000000000'
    ORDER BY Name
  `);
  return result.recordset || [];
}

module.exports = {
  effectiveInstanceId,
  effectiveTenantId,
  assertTenantInScope,
  assertInstanceInScope,
  assertBatchInScope,
  assertGroupBatchInScope,
  resolveScopedTenants
};

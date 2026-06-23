'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql, getPool } = require('../../config/database');
const encryptionService = require('../encryptionService');

function mapInstanceRow(row) {
  if (!row) return null;
  return {
    instanceId: row.InstanceId,
    label: row.Label,
    e123CorpId: row.E123CorpId,
    e123Username: row.E123Username,
    hasPassword: !!row.E123PasswordEncrypted,
    orgBrokerId: row.OrgBrokerId,
    orgBrokerLabel: row.OrgBrokerLabel,
    isArchived: row.IsArchived === true || row.IsArchived === 1,
    enableTenantPortal: row.EnableTenantPortal === true || row.EnableTenantPortal === 1,
    tenantCount: row.TenantCount ?? 0,
    createdUtc: row.CreatedUtc,
    modifiedUtc: row.ModifiedUtc
  };
}

async function listInstances({ includeArchived = false } = {}) {
  const pool = await getPool();
  const result = await pool.request()
    .input('includeArchived', sql.Bit, includeArchived ? 1 : 0)
    .query(`
      SELECT i.*,
        (SELECT COUNT(*) FROM oe.MigrationInstanceTenant it WHERE it.InstanceId = i.InstanceId) AS TenantCount
      FROM oe.MigrationInstance i
      WHERE (@includeArchived = 1 OR i.IsArchived = 0)
      ORDER BY i.IsArchived ASC, i.Label ASC
    `);
  return (result.recordset || []).map(mapInstanceRow);
}

async function getInstance(instanceId, { includeSecrets = false } = {}) {
  const pool = await getPool();
  const result = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .query(`
      SELECT i.*,
        (SELECT COUNT(*) FROM oe.MigrationInstanceTenant it WHERE it.InstanceId = i.InstanceId) AS TenantCount
      FROM oe.MigrationInstance i
      WHERE i.InstanceId = @instanceId
    `);
  const mapped = mapInstanceRow(result.recordset?.[0]);
  if (!mapped || !includeSecrets) return mapped;

  const creds = await resolveCredentials(instanceId);
  return {
    ...mapped,
    e123Password: creds?.password || ''
  };
}

async function getInstanceTenants(instanceId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .query(`
      SELECT it.TenantId, t.Name AS TenantName
      FROM oe.MigrationInstanceTenant it
      INNER JOIN oe.Tenants t ON t.TenantId = it.TenantId
      WHERE it.InstanceId = @instanceId
      ORDER BY t.Name
    `);
  return result.recordset || [];
}

async function resolveCredentials(instanceId) {
  if (!instanceId) return null;
  const pool = await getPool();
  const result = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .query(`
      SELECT E123CorpId, E123Username, E123PasswordEncrypted, OrgBrokerId, OrgBrokerLabel
      FROM oe.MigrationInstance
      WHERE InstanceId = @instanceId AND IsArchived = 0
    `);
  const row = result.recordset?.[0];
  if (!row) return null;

  let password = '';
  if (row.E123PasswordEncrypted) {
    try {
      password = encryptionService.decrypt(row.E123PasswordEncrypted);
    } catch (err) {
      console.error('[migration] Failed to decrypt E123 password for instance', instanceId, err.message);
      password = '';
    }
  }

  return {
    corpid: row.E123CorpId || '',
    username: row.E123Username || '',
    password,
    orgBrokerId: row.OrgBrokerId || null,
    orgBrokerLabel: row.OrgBrokerLabel || null
  };
}

async function getTenantPortalContext(tenantId) {
  if (!tenantId) return { enabled: false, instanceId: null, label: null };
  const pool = await getPool();
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT i.InstanceId, i.Label, i.EnableTenantPortal, i.IsArchived
      FROM oe.MigrationInstanceTenant it
      INNER JOIN oe.MigrationInstance i ON i.InstanceId = it.InstanceId
      WHERE it.TenantId = @tenantId AND i.IsArchived = 0
    `);
  const row = result.recordset?.[0];
  if (!row) return { enabled: false, instanceId: null, label: null };
  return {
    enabled: row.EnableTenantPortal === true || row.EnableTenantPortal === 1,
    instanceId: row.InstanceId,
    label: row.Label
  };
}

async function createInstance({
  label,
  e123CorpId,
  e123Username,
  e123Password,
  orgBrokerId = null,
  orgBrokerLabel = null,
  enableTenantPortal = false,
  tenantIds = [],
  createdBy = null
}) {
  const pool = await getPool();
  const instanceId = uuidv4();
  const passwordEncrypted = e123Password
    ? encryptionService.encrypt(String(e123Password))
    : null;

  const transaction = pool.transaction();
  await transaction.begin();
  try {
    await transaction.request()
      .input('instanceId', sql.UniqueIdentifier, instanceId)
      .input('label', sql.NVarChar, String(label || '').trim())
      .input('corpId', sql.NVarChar, e123CorpId || null)
      .input('username', sql.NVarChar, e123Username || null)
      .input('passwordEncrypted', sql.NVarChar(sql.MAX), passwordEncrypted)
      .input('orgBrokerId', sql.Int, orgBrokerId || null)
      .input('orgBrokerLabel', sql.NVarChar, orgBrokerLabel || null)
      .input('enableTenantPortal', sql.Bit, enableTenantPortal ? 1 : 0)
      .input('createdBy', sql.UniqueIdentifier, createdBy || null)
      .query(`
        INSERT INTO oe.MigrationInstance (
          InstanceId, Label, E123CorpId, E123Username, E123PasswordEncrypted,
          OrgBrokerId, OrgBrokerLabel, EnableTenantPortal, CreatedBy
        ) VALUES (
          @instanceId, @label, @corpId, @username, @passwordEncrypted,
          @orgBrokerId, @orgBrokerLabel, @enableTenantPortal, @createdBy
        )
      `);

    await assignTenants(instanceId, tenantIds, transaction);
    await transaction.commit();
    return getInstance(instanceId);
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function assignTenants(instanceId, tenantIds = [], transaction = null) {
  const pool = transaction || await getPool();
  const uniqueTenantIds = [...new Set((tenantIds || []).filter(Boolean))];

  for (const tenantId of uniqueTenantIds) {
    const existing = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT InstanceId FROM oe.MigrationInstanceTenant WHERE TenantId = @tenantId
      `);
    const otherInstanceId = existing.recordset?.[0]?.InstanceId;
    if (otherInstanceId && String(otherInstanceId) !== String(instanceId)) {
      const err = new Error('Tenant is already assigned to another migration instance');
      err.code = 'TENANT_ALREADY_ASSIGNED';
      throw err;
    }
  }

  const req = pool.request().input('instanceId', sql.UniqueIdentifier, instanceId);
  await req.query(`DELETE FROM oe.MigrationInstanceTenant WHERE InstanceId = @instanceId`);

  for (const tenantId of uniqueTenantIds) {
    await pool.request()
      .input('instanceId', sql.UniqueIdentifier, instanceId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        INSERT INTO oe.MigrationInstanceTenant (InstanceId, TenantId)
        VALUES (@instanceId, @tenantId)
      `);
  }
}

async function updateInstance(instanceId, fields = {}) {
  const pool = await getPool();
  const sets = [];
  const request = pool.request().input('instanceId', sql.UniqueIdentifier, instanceId);

  if (fields.label !== undefined) {
    sets.push('Label = @label');
    request.input('label', sql.NVarChar, fields.label);
  }
  if (fields.e123CorpId !== undefined) {
    sets.push('E123CorpId = @corpId');
    request.input('corpId', sql.NVarChar, fields.e123CorpId || null);
  }
  if (fields.e123Username !== undefined) {
    sets.push('E123Username = @username');
    request.input('username', sql.NVarChar, fields.e123Username || null);
  }
  if (fields.e123Password) {
    sets.push('E123PasswordEncrypted = @passwordEncrypted');
    request.input('passwordEncrypted', sql.NVarChar(sql.MAX), encryptionService.encrypt(String(fields.e123Password)));
  }
  if (fields.orgBrokerId !== undefined) {
    sets.push('OrgBrokerId = @orgBrokerId');
    request.input('orgBrokerId', sql.Int, fields.orgBrokerId || null);
  }
  if (fields.orgBrokerLabel !== undefined) {
    sets.push('OrgBrokerLabel = @orgBrokerLabel');
    request.input('orgBrokerLabel', sql.NVarChar, fields.orgBrokerLabel || null);
  }
  if (fields.isArchived !== undefined) {
    sets.push('IsArchived = @isArchived');
    request.input('isArchived', sql.Bit, fields.isArchived ? 1 : 0);
  }
  if (fields.enableTenantPortal !== undefined) {
    sets.push('EnableTenantPortal = @enableTenantPortal');
    request.input('enableTenantPortal', sql.Bit, fields.enableTenantPortal ? 1 : 0);
  }

  if (sets.length) {
    sets.push('ModifiedUtc = SYSUTCDATETIME()');
    await request.query(`
      UPDATE oe.MigrationInstance SET ${sets.join(', ')} WHERE InstanceId = @instanceId
    `);
  }

  if (fields.tenantIds !== undefined) {
    await assignTenants(instanceId, fields.tenantIds);
  }

  return getInstance(instanceId);
}

async function listTenantsForInstance(instanceId) {
  if (!instanceId) return [];
  return getInstanceTenants(instanceId);
}

async function resolveInstanceIdForTenant(tenantId) {
  if (!tenantId) return null;
  const pool = await getPool();
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT InstanceId
      FROM oe.MigrationInstanceTenant
      WHERE TenantId = @tenantId
    `);
  return result.recordset?.[0]?.InstanceId || null;
}

async function resolveInstanceIdForBatch(batch) {
  if (!batch) return null;
  if (batch.InstanceId) return batch.InstanceId;
  if (batch.TenantId) return resolveInstanceIdForTenant(batch.TenantId);
  return null;
}

async function listAvailableTenantsForAssignment(excludeInstanceId = null) {
  const pool = await getPool();
  const result = await pool.request()
    .input('excludeInstanceId', sql.UniqueIdentifier, excludeInstanceId || null)
    .query(`
      SELECT t.TenantId, t.Name, t.Status
      FROM oe.Tenants t
      WHERE t.Status = 'Active'
        AND t.TenantId <> '00000000-0000-0000-0000-000000000000'
        AND NOT EXISTS (
          SELECT 1 FROM oe.MigrationInstanceTenant it
          WHERE it.TenantId = t.TenantId
            AND (@excludeInstanceId IS NULL OR it.InstanceId <> @excludeInstanceId)
        )
      ORDER BY t.Name
    `);
  return result.recordset || [];
}

module.exports = {
  listInstances,
  getInstance,
  getInstanceTenants,
  getTenantPortalContext,
  resolveCredentials,
  resolveInstanceIdForTenant,
  resolveInstanceIdForBatch,
  createInstance,
  updateInstance,
  assignTenants,
  listTenantsForInstance,
  listAvailableTenantsForAssignment
};

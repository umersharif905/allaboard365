'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql, getPool } = require('../../config/database');

async function listAgentMappings() {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT m.*, t.Name AS TenantName
    FROM oe.MigrationAgentTenantMap m
    INNER JOIN oe.Tenants t ON t.TenantId = m.TenantId
    WHERE m.IsActive = 1
    ORDER BY m.RootAgentLabel, m.RootBrokerId
  `);
  return result.recordset || [];
}

async function upsertAgentMapping({ rootBrokerId, rootAgentLabel, includeDownline, tenantId }) {
  const pool = await getPool();
  const mapId = uuidv4();
  await pool.request()
    .input('mapId', sql.UniqueIdentifier, mapId)
    .input('rootBrokerId', sql.Int, rootBrokerId)
    .input('rootAgentLabel', sql.NVarChar, rootAgentLabel || null)
    .input('includeDownline', sql.Bit, includeDownline ? 1 : 0)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      MERGE oe.MigrationAgentTenantMap AS target
      USING (SELECT @rootBrokerId AS RootBrokerId, @includeDownline AS IncludeDownline) AS source
      ON target.RootBrokerId = source.RootBrokerId AND target.IncludeDownline = source.IncludeDownline
      WHEN MATCHED THEN
        UPDATE SET RootAgentLabel = @rootAgentLabel, TenantId = @tenantId, IsActive = 1, ModifiedUtc = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (AgentTenantMapId, RootBrokerId, RootAgentLabel, IncludeDownline, TenantId)
        VALUES (@mapId, @rootBrokerId, @rootAgentLabel, @includeDownline, @tenantId);
    `);
  return { rootBrokerId, includeDownline, tenantId };
}

module.exports = {
  listAgentMappings,
  upsertAgentMapping
};

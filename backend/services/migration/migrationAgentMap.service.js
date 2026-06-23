'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql, getPool } = require('../../config/database');

async function getAgentMap({ instanceId, e123BrokerId }) {
  if (!instanceId || !e123BrokerId) return null;
  const pool = await getPool();
  const result = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .input('e123BrokerId', sql.Int, Number(e123BrokerId))
    .query(`
      SELECT TOP 1 AgentMapId, InstanceId, E123BrokerId, AgentId, MatchMethod, E123AgentLabel
      FROM oe.MigrationAgentMap
      WHERE InstanceId = @instanceId AND E123BrokerId = @e123BrokerId
    `);
  return result.recordset?.[0] || null;
}

async function upsertAgentMap({
  instanceId,
  e123BrokerId,
  agentId,
  matchMethod = null,
  e123AgentLabel = null
}) {
  if (!instanceId || !e123BrokerId || !agentId) return null;
  const pool = await getPool();
  const mapId = uuidv4();
  await pool.request()
    .input('mapId', sql.UniqueIdentifier, mapId)
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .input('e123BrokerId', sql.Int, Number(e123BrokerId))
    .input('agentId', sql.UniqueIdentifier, agentId)
    .input('matchMethod', sql.NVarChar, matchMethod || null)
    .input('e123AgentLabel', sql.NVarChar, e123AgentLabel || null)
    .query(`
      MERGE oe.MigrationAgentMap AS target
      USING (
        SELECT @instanceId AS InstanceId, @e123BrokerId AS E123BrokerId
      ) AS source
      ON target.InstanceId = source.InstanceId AND target.E123BrokerId = source.E123BrokerId
      WHEN MATCHED THEN
        UPDATE SET
          AgentId = @agentId,
          MatchMethod = @matchMethod,
          E123AgentLabel = @e123AgentLabel,
          ModifiedUtc = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (AgentMapId, InstanceId, E123BrokerId, AgentId, MatchMethod, E123AgentLabel)
        VALUES (@mapId, @instanceId, @e123BrokerId, @agentId, @matchMethod, @e123AgentLabel);
    `);
  return { instanceId, e123BrokerId, agentId, matchMethod };
}

async function listAgentMapsForInstance(instanceId) {
  if (!instanceId) return [];
  const pool = await getPool();
  const result = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .query(`
      SELECT AgentMapId, InstanceId, E123BrokerId, AgentId, MatchMethod, E123AgentLabel
      FROM oe.MigrationAgentMap
      WHERE InstanceId = @instanceId
      ORDER BY E123AgentLabel, E123BrokerId
    `);
  return result.recordset || [];
}

module.exports = {
  getAgentMap,
  upsertAgentMap,
  listAgentMapsForInstance
};

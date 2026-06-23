'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql, getPool } = require('../../config/database');
const {
  parsePayablesCsvBuffer,
  buildPayablesAgentsBase,
  buildPayablesIndexShell
} = require('./e123PayablesDetail.service');

function parseJsonSafe(raw, fallback = null) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function getLatestPayablesExport(instanceId) {
  if (!instanceId) return null;
  const pool = await getPool();
  const result = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .query(`
      SELECT TOP 1 ExportId, InstanceId, FileName, CsvRowCount, AgentCount, DominantMonth,
             MinPostedDate, MaxPostedDate, SummaryJson, CreatedUtc
      FROM oe.MigrationE123PayablesExport
      WHERE InstanceId = @instanceId
      ORDER BY CreatedUtc DESC
    `);
  return result.recordset?.[0] || null;
}

async function getPayablesStatus(instanceId) {
  if (!instanceId) {
    return { configured: false, instanceId: null, latestExport: null, agentCount: 0 };
  }

  const latest = await getLatestPayablesExport(instanceId);
  if (!latest) {
    return { configured: false, instanceId, latestExport: null, agentCount: 0 };
  }

  const summary = parseJsonSafe(latest.SummaryJson, {}) || {};
  return {
    configured: true,
    instanceId,
    latestExport: {
      exportId: latest.ExportId,
      fileName: latest.FileName,
      rowCount: latest.CsvRowCount,
      agentCount: latest.AgentCount,
      dominantMonth: latest.DominantMonth,
      minPostedDate: latest.MinPostedDate,
      maxPostedDate: latest.MaxPostedDate,
      warnings: summary.warnings || [],
      createdUtc: latest.CreatedUtc
    },
    agentCount: latest.AgentCount || 0
  };
}

async function loadPayablesIndexForInstance(instanceId) {
  const latest = await getLatestPayablesExport(instanceId);
  if (!latest) return null;

  const summary = parseJsonSafe(latest.SummaryJson, {}) || {};
  if (!summary.agents || !Object.keys(summary.agents).length) return null;

  return {
    exportId: latest.ExportId,
    fileName: latest.FileName,
    rowCount: latest.CsvRowCount,
    commProductRowCount: summary.commProductRowCount,
    dominantMonth: latest.DominantMonth,
    dominantCount: summary.dominantCount,
    monthCount: summary.monthCount,
    minPostedDate: latest.MinPostedDate,
    maxPostedDate: latest.MaxPostedDate,
    warnings: summary.warnings || [],
    agentCount: latest.AgentCount,
    agents: summary.agents,
    uploadedUtc: latest.CreatedUtc
  };
}

async function importPayablesFromUpload({ instanceId, buffer, fileName, uploadedBy = null }) {
  if (!instanceId) {
    const err = new Error('instanceId is required');
    err.status = 400;
    throw err;
  }

  const parsed = parsePayablesCsvBuffer(buffer, { fileName });
  const agents = buildPayablesAgentsBase(parsed);
  const indexShell = buildPayablesIndexShell(parsed, agents);

  const exportId = uuidv4();
  const pool = await getPool();
  await pool.request()
    .input('exportId', sql.UniqueIdentifier, exportId)
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .input('fileName', sql.NVarChar(400), fileName || parsed.fileName || null)
    .input('rowCount', sql.Int, indexShell.rowCount)
    .input('agentCount', sql.Int, indexShell.agentCount)
    .input('dominantMonth', sql.NVarChar(20), indexShell.dominantMonth || null)
    .input('minPostedDate', sql.Date, indexShell.minPostedDate || null)
    .input('maxPostedDate', sql.Date, indexShell.maxPostedDate || null)
    .input('summaryJson', sql.NVarChar(sql.MAX), JSON.stringify(indexShell))
    .input('uploadedBy', sql.UniqueIdentifier, uploadedBy)
    .query(`
      INSERT INTO oe.MigrationE123PayablesExport (
        ExportId, InstanceId, FileName, CsvRowCount, AgentCount, DominantMonth,
        MinPostedDate, MaxPostedDate, SummaryJson, UploadedBy
      )
      VALUES (
        @exportId, @instanceId, @fileName, @rowCount, @agentCount, @dominantMonth,
        @minPostedDate, @maxPostedDate, @summaryJson, @uploadedBy
      )
    `);

  return {
    exportId,
    ...indexShell,
    uploadedUtc: new Date().toISOString()
  };
}

module.exports = {
  getPayablesStatus,
  loadPayablesIndexForInstance,
  importPayablesFromUpload
};

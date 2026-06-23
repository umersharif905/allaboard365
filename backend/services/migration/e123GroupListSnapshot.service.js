'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql, getPool } = require('../../config/database');
const { parseGroupsCsvBuffer, buildGroupsIndexShell } = require('./e123GroupsList.service');

function parseJsonSafe(raw, fallback = null) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function getLatestGroupsListExport(instanceId) {
  if (!instanceId) return null;
  const pool = await getPool();
  const result = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .query(`
      SELECT TOP 1 ExportId, InstanceId, FileName, CsvRowCount, GroupCount, SummaryJson, CreatedUtc
      FROM oe.MigrationE123GroupsListExport
      WHERE InstanceId = @instanceId
      ORDER BY CreatedUtc DESC
    `);
  return result.recordset?.[0] || null;
}

async function getGroupsListStatus(instanceId) {
  if (!instanceId) {
    return { configured: false, instanceId: null, latestExport: null, groupCount: 0 };
  }

  const latest = await getLatestGroupsListExport(instanceId);
  if (!latest) {
    return { configured: false, instanceId, latestExport: null, groupCount: 0 };
  }

  const summary = parseJsonSafe(latest.SummaryJson, {}) || {};
  return {
    configured: true,
    instanceId,
    latestExport: {
      exportId: latest.ExportId,
      fileName: latest.FileName,
      rowCount: latest.CsvRowCount,
      groupCount: latest.GroupCount,
      warnings: summary.warnings || [],
      createdUtc: latest.CreatedUtc
    },
    groupCount: latest.GroupCount || 0
  };
}

async function loadGroupsListIndexForInstance(instanceId) {
  const latest = await getLatestGroupsListExport(instanceId);
  if (!latest) return null;

  const summary = parseJsonSafe(latest.SummaryJson, {}) || {};
  if (!summary.groups || !Object.keys(summary.groups).length) return null;

  return {
    exportId: latest.ExportId,
    fileName: latest.FileName,
    rowCount: latest.CsvRowCount,
    groupCount: latest.GroupCount,
    warnings: summary.warnings || [],
    groups: summary.groups,
    uploadedUtc: latest.CreatedUtc
  };
}

async function importGroupsListFromUpload({ instanceId, buffer, fileName, uploadedBy = null }) {
  if (!instanceId) {
    const err = new Error('instanceId is required');
    err.status = 400;
    throw err;
  }

  const parsed = parseGroupsCsvBuffer(buffer, { fileName });
  const indexShell = buildGroupsIndexShell(parsed);
  const exportId = uuidv4();
  const pool = await getPool();

  await pool.request()
    .input('exportId', sql.UniqueIdentifier, exportId)
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .input('fileName', sql.NVarChar(400), fileName || parsed.fileName || null)
    .input('rowCount', sql.Int, indexShell.rowCount)
    .input('groupCount', sql.Int, indexShell.groupCount)
    .input('summaryJson', sql.NVarChar(sql.MAX), JSON.stringify(indexShell))
    .input('uploadedBy', sql.UniqueIdentifier, uploadedBy)
    .query(`
      INSERT INTO oe.MigrationE123GroupsListExport (
        ExportId, InstanceId, FileName, CsvRowCount, GroupCount, SummaryJson, UploadedBy
      )
      VALUES (
        @exportId, @instanceId, @fileName, @rowCount, @groupCount, @summaryJson, @uploadedBy
      )
    `);

  return {
    exportId,
    ...indexShell,
    uploadedUtc: new Date().toISOString()
  };
}

module.exports = {
  getGroupsListStatus,
  loadGroupsListIndexForInstance,
  importGroupsListFromUpload
};

'use strict';

const { getPool, sql } = require('../config/database');
const cronParser = require('cron-parser');
const vendorImportTenants = require('./vendorImportTenants.service');
const vendorImportFormatPresetService = require('./vendorImportFormatPreset.service');

function sanitizeJob(row) {
  if (!row) return null;
  return {
    jobId: row.JobId,
    vendorId: row.VendorId,
    connectionId: row.ConnectionId,
    tenantId: row.TenantId,
    jobName: row.JobName || '',
    subFolderPath: row.SubFolderPath || null,
    formatSlug: row.FormatSlug,
    cronScheduleUtc: row.CronScheduleUtc,
    archiveFolder: row.ArchiveFolder,
    notifyEmails: (() => {
      try { return JSON.parse(row.NotifyEmails); } catch { return []; }
    })(),
    notifyOnSuccess: row.NotifyOnSuccess === 1 || row.NotifyOnSuccess === true,
    notifyOnFailure: row.NotifyOnFailure === 1 || row.NotifyOnFailure === true,
    notifyOnNoFiles: row.NotifyOnNoFiles === 1 || row.NotifyOnNoFiles === true,
    allowTenantMove: row.AllowTenantMove === 1 || row.AllowTenantMove === true,
    skipHouseholdWithUnmappedPlans: row.SkipHouseholdWithUnmappedPlans == null
      ? true
      : (row.SkipHouseholdWithUnmappedPlans === 1 || row.SkipHouseholdWithUnmappedPlans === true),
    legacyProcessorKey: row.LegacyProcessorKey || null,
    isEnabled: row.IsEnabled === 1 || row.IsEnabled === true,
    isRunning: row.IsRunning === 1 || row.IsRunning === true,
    lastRunAtUtc: row.LastRunAtUtc || null,
    createdBy: row.CreatedBy || null,
    createdUtc: row.CreatedUtc,
    modifiedUtc: row.ModifiedUtc,
  };
}

function validateCron(expr) {
  try {
    cronParser.parseExpression(expr, { utc: true });
    return true;
  } catch {
    return false;
  }
}

function validateEmails(emails) {
  if (!Array.isArray(emails) || emails.length === 0) return false;
  return emails.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e).trim()));
}

async function resolveDefaultJobName(pool, tenantId, subFolderPath) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`SELECT Name FROM oe.Tenants WHERE TenantId = @tenantId`);
  const tenantName = r.recordset?.[0]?.Name;
  if (tenantName && subFolderPath) return `${tenantName} · ${subFolderPath}`;
  if (tenantName) return tenantName;
  if (subFolderPath) return String(subFolderPath);
  return 'Import job';
}

async function listJobs(vendorId) {
  const vendorImportJobRunService = require('./vendorImportJobRunService');
  await vendorImportJobRunService.releaseStaleRuns().catch((e) =>
    console.error('[vendorImportJobService] releaseStaleRuns:', e.message)
  );

  const pool = await getPool();
  const result = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT j.*,
             c.DisplayName AS ConnectionDisplayName,
             c.Host AS ConnectionHost,
             t.Name AS TenantName,
             (
               SELECT TOP 1 r.Status
               FROM oe.VendorImportJobRuns r
               WHERE r.JobId = j.JobId
               ORDER BY r.StartedUtc DESC
             ) AS LastRunStatus
      FROM oe.VendorImportJobs j
      LEFT JOIN oe.VendorSftpConnections c ON c.ConnectionId = j.ConnectionId
      LEFT JOIN oe.Tenants t ON t.TenantId = j.TenantId
      WHERE j.VendorId = @vendorId
      ORDER BY j.ModifiedUtc DESC
    `);
  return result.recordset.map((row) => ({
    ...sanitizeJob(row),
    connectionDisplayName: row.ConnectionDisplayName || null,
    connectionHost: row.ConnectionHost || null,
    tenantName: row.TenantName || null,
    lastRunStatus: row.LastRunStatus || null,
  }));
}

async function getJob(jobId, vendorId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT j.*,
             c.DisplayName AS ConnectionDisplayName,
             c.Host AS ConnectionHost,
             t.Name AS TenantName
      FROM oe.VendorImportJobs j
      LEFT JOIN oe.VendorSftpConnections c ON c.ConnectionId = j.ConnectionId
      LEFT JOIN oe.Tenants t ON t.TenantId = j.TenantId
      WHERE j.JobId = @jobId AND j.VendorId = @vendorId
    `);
  const row = result.recordset?.[0];
  if (!row) return null;
  return {
    ...sanitizeJob(row),
    connectionDisplayName: row.ConnectionDisplayName || null,
    connectionHost: row.ConnectionHost || null,
    tenantName: row.TenantName || null,
  };
}

async function createJob({
  vendorId,
  connectionId,
  tenantId,
  jobName,
  subFolderPath,
  formatSlug,
  cronScheduleUtc,
  archiveFolder,
  notifyEmails,
  notifyOnSuccess,
  notifyOnFailure,
  notifyOnNoFiles,
  allowTenantMove,
  skipHouseholdWithUnmappedPlans,
  createdBy,
}) {
  if (!connectionId) throw new Error('connectionId required');
  if (!tenantId) throw new Error('tenantId required');
  if (!formatSlug) throw new Error('formatSlug required');
  if (!cronScheduleUtc) throw new Error('cronScheduleUtc required');
  if (!notifyEmails || !notifyEmails.length) throw new Error('At least one notifyEmails address required');

  if (!validateCron(cronScheduleUtc)) {
    throw new Error(`Invalid cron expression: ${cronScheduleUtc}`);
  }
  const slugOk = await vendorImportFormatPresetService.isValidFormatSlug(vendorId, formatSlug);
  if (!slugOk) throw new Error(`Unknown format slug: ${formatSlug}`);
  if (!validateEmails(notifyEmails)) {
    throw new Error('One or more notification email addresses are invalid');
  }

  // Validate connection belongs to this vendor
  const pool = await getPool();
  const connCheck = await pool.request()
    .input('connectionId', sql.UniqueIdentifier, connectionId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT 1 AS Found FROM oe.VendorSftpConnections
      WHERE ConnectionId = @connectionId AND VendorId = @vendorId AND IsActive = 1
    `);
  if (!connCheck.recordset?.length) {
    throw new Error('SFTP connection not found or does not belong to this vendor');
  }

  // Validate tenant eligibility
  await vendorImportTenants.assertTenantEligibleForVendorImport(vendorId, tenantId);

  const resolvedJobName = (jobName && String(jobName).trim())
    ? String(jobName).trim()
    : await resolveDefaultJobName(pool, tenantId, subFolderPath);

  let result;
  try {
    result = await pool.request()
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .input('connectionId', sql.UniqueIdentifier, connectionId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('jobName', sql.NVarChar(150), resolvedJobName)
      .input('subFolderPath', sql.NVarChar(500), subFolderPath || null)
      .input('formatSlug', sql.NVarChar(50), formatSlug)
      .input('cronScheduleUtc', sql.NVarChar(100), cronScheduleUtc)
      .input('archiveFolder', sql.NVarChar(255), archiveFolder || 'archived')
      .input('notifyEmails', sql.NVarChar(sql.MAX), JSON.stringify(notifyEmails))
      .input('notifyOnSuccess', sql.Bit, notifyOnSuccess !== false ? 1 : 0)
      .input('notifyOnFailure', sql.Bit, notifyOnFailure !== false ? 1 : 0)
      .input('notifyOnNoFiles', sql.Bit, notifyOnNoFiles === true ? 1 : 0)
      .input('allowTenantMove', sql.Bit, allowTenantMove === true ? 1 : 0)
      .input('skipHouseholdWithUnmappedPlans', sql.Bit, skipHouseholdWithUnmappedPlans !== false ? 1 : 0)
      .input('createdBy', sql.UniqueIdentifier, createdBy || null)
      .query(`
        INSERT INTO oe.VendorImportJobs
          (VendorId, ConnectionId, TenantId, JobName, SubFolderPath, FormatSlug,
           CronScheduleUtc, ArchiveFolder, NotifyEmails, NotifyOnSuccess, NotifyOnFailure,
           NotifyOnNoFiles, AllowTenantMove, SkipHouseholdWithUnmappedPlans,
           IsEnabled, IsRunning, CreatedBy)
        OUTPUT INSERTED.*
        VALUES
          (@vendorId, @connectionId, @tenantId, @jobName, @subFolderPath, @formatSlug,
           @cronScheduleUtc, @archiveFolder, @notifyEmails, @notifyOnSuccess, @notifyOnFailure,
           @notifyOnNoFiles, @allowTenantMove, @skipHouseholdWithUnmappedPlans,
           0, 0, @createdBy)
      `);
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    if (!msg.includes('allowtenantmove') && !msg.includes('skiphousehold')) throw err;
    result = await pool.request()
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .input('connectionId', sql.UniqueIdentifier, connectionId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('jobName', sql.NVarChar(150), resolvedJobName)
      .input('subFolderPath', sql.NVarChar(500), subFolderPath || null)
      .input('formatSlug', sql.NVarChar(50), formatSlug)
      .input('cronScheduleUtc', sql.NVarChar(100), cronScheduleUtc)
      .input('archiveFolder', sql.NVarChar(255), archiveFolder || 'archived')
      .input('notifyEmails', sql.NVarChar(sql.MAX), JSON.stringify(notifyEmails))
      .input('notifyOnSuccess', sql.Bit, notifyOnSuccess !== false ? 1 : 0)
      .input('notifyOnFailure', sql.Bit, notifyOnFailure !== false ? 1 : 0)
      .input('notifyOnNoFiles', sql.Bit, notifyOnNoFiles === true ? 1 : 0)
      .input('createdBy', sql.UniqueIdentifier, createdBy || null)
      .query(`
        INSERT INTO oe.VendorImportJobs
          (VendorId, ConnectionId, TenantId, JobName, SubFolderPath, FormatSlug,
           CronScheduleUtc, ArchiveFolder, NotifyEmails, NotifyOnSuccess, NotifyOnFailure,
           NotifyOnNoFiles, IsEnabled, IsRunning, CreatedBy)
        OUTPUT INSERTED.*
        VALUES
          (@vendorId, @connectionId, @tenantId, @jobName, @subFolderPath, @formatSlug,
           @cronScheduleUtc, @archiveFolder, @notifyEmails, @notifyOnSuccess, @notifyOnFailure,
           @notifyOnNoFiles, 0, 0, @createdBy)
      `);
  }
  return sanitizeJob(result.recordset?.[0]);
}

async function updateJob(jobId, vendorId, updates) {
  const {
    connectionId,
    tenantId,
    jobName,
    subFolderPath,
    formatSlug,
    cronScheduleUtc,
    archiveFolder,
    notifyEmails,
    notifyOnSuccess,
    notifyOnFailure,
    notifyOnNoFiles,
    allowTenantMove,
    skipHouseholdWithUnmappedPlans,
  } = updates;

  if (cronScheduleUtc !== undefined && !validateCron(cronScheduleUtc)) {
    throw new Error(`Invalid cron expression: ${cronScheduleUtc}`);
  }
  if (formatSlug !== undefined) {
    const slugOk = await vendorImportFormatPresetService.isValidFormatSlug(vendorId, formatSlug);
    if (!slugOk) throw new Error(`Unknown format slug: ${formatSlug}`);
  }
  if (notifyEmails !== undefined && !validateEmails(notifyEmails)) {
    throw new Error('One or more notification email addresses are invalid');
  }

  const pool = await getPool();

  if (connectionId !== undefined) {
    const connCheck = await pool.request()
      .input('connectionId', sql.UniqueIdentifier, connectionId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .query(`
        SELECT 1 AS Found FROM oe.VendorSftpConnections
        WHERE ConnectionId = @connectionId AND VendorId = @vendorId AND IsActive = 1
      `);
    if (!connCheck.recordset?.length) {
      throw new Error('SFTP connection not found or does not belong to this vendor');
    }
  }

  if (tenantId !== undefined) {
    await vendorImportTenants.assertTenantEligibleForVendorImport(vendorId, tenantId);
  }

  const req = pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('vendorId', sql.UniqueIdentifier, vendorId);
  const sets = ['ModifiedUtc = SYSUTCDATETIME()'];

  if (connectionId !== undefined) { req.input('connectionId', sql.UniqueIdentifier, connectionId); sets.push('ConnectionId = @connectionId'); }
  if (tenantId !== undefined) { req.input('tenantId', sql.UniqueIdentifier, tenantId); sets.push('TenantId = @tenantId'); }
  if (jobName !== undefined) { req.input('jobName', sql.NVarChar(150), jobName); sets.push('JobName = @jobName'); }
  if (subFolderPath !== undefined) { req.input('subFolderPath', sql.NVarChar(500), subFolderPath || null); sets.push('SubFolderPath = @subFolderPath'); }
  if (formatSlug !== undefined) { req.input('formatSlug', sql.NVarChar(50), formatSlug); sets.push('FormatSlug = @formatSlug'); }
  if (cronScheduleUtc !== undefined) { req.input('cronScheduleUtc', sql.NVarChar(100), cronScheduleUtc); sets.push('CronScheduleUtc = @cronScheduleUtc'); }
  if (archiveFolder !== undefined) { req.input('archiveFolder', sql.NVarChar(255), archiveFolder); sets.push('ArchiveFolder = @archiveFolder'); }
  if (notifyEmails !== undefined) { req.input('notifyEmails', sql.NVarChar(sql.MAX), JSON.stringify(notifyEmails)); sets.push('NotifyEmails = @notifyEmails'); }
  if (notifyOnSuccess !== undefined) { req.input('notifyOnSuccess', sql.Bit, notifyOnSuccess ? 1 : 0); sets.push('NotifyOnSuccess = @notifyOnSuccess'); }
  if (notifyOnFailure !== undefined) { req.input('notifyOnFailure', sql.Bit, notifyOnFailure ? 1 : 0); sets.push('NotifyOnFailure = @notifyOnFailure'); }
  if (notifyOnNoFiles !== undefined) { req.input('notifyOnNoFiles', sql.Bit, notifyOnNoFiles ? 1 : 0); sets.push('NotifyOnNoFiles = @notifyOnNoFiles'); }
  if (allowTenantMove !== undefined) { req.input('allowTenantMove', sql.Bit, allowTenantMove ? 1 : 0); sets.push('AllowTenantMove = @allowTenantMove'); }
  if (skipHouseholdWithUnmappedPlans !== undefined) {
    req.input('skipHouseholdWithUnmappedPlans', sql.Bit, skipHouseholdWithUnmappedPlans ? 1 : 0);
    sets.push('SkipHouseholdWithUnmappedPlans = @skipHouseholdWithUnmappedPlans');
  }

  const result = await req.query(`
    UPDATE oe.VendorImportJobs
    SET ${sets.join(', ')}
    OUTPUT INSERTED.*
    WHERE JobId = @jobId AND VendorId = @vendorId
  `);
  return sanitizeJob(result.recordset?.[0]);
}

async function deleteJob(jobId, vendorId) {
  const pool = await getPool();
  const runningCheck = await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT IsRunning FROM oe.VendorImportJobs
      WHERE JobId = @jobId AND VendorId = @vendorId
    `);
  const row = runningCheck.recordset?.[0];
  if (!row) return false;
  if (row.IsRunning) {
    const err = new Error('Cannot delete a job that is currently running');
    err.statusCode = 409;
    throw err;
  }

  await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`DELETE FROM oe.VendorImportJobs WHERE JobId = @jobId AND VendorId = @vendorId`);
  return true;
}

async function setEnabled(jobId, vendorId, enabled) {
  const pool = await getPool();
  const result = await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('isEnabled', sql.Bit, enabled ? 1 : 0)
    .query(`
      UPDATE oe.VendorImportJobs
      SET IsEnabled = @isEnabled, ModifiedUtc = SYSUTCDATETIME()
      OUTPUT INSERTED.JobId, INSERTED.IsEnabled
      WHERE JobId = @jobId AND VendorId = @vendorId
    `);
  const updated = result.recordset?.[0];
  if (!updated) return null;
  return { jobId: updated.JobId, isEnabled: updated.IsEnabled === 1 };
}

/**
 * Returns all enabled jobs with their full config for the scheduler.
 * No VendorId scope — scheduler runs across all vendors.
 */
async function listEnabledJobs() {
  const pool = await getPool();
  const result = await pool.request()
    .query(`
      SELECT j.*,
             c.Host, c.Port, c.Username, c.AuthType,
             c.PasswordEncrypted, c.PrivateKeyEncrypted, c.PassphraseEncrypted,
             c.BaseDirectory
      FROM oe.VendorImportJobs j
      INNER JOIN oe.VendorSftpConnections c ON c.ConnectionId = j.ConnectionId AND c.IsActive = 1
      WHERE j.IsEnabled = 1 AND j.IsRunning = 0
    `);
  return result.recordset;
}

module.exports = {
  listJobs,
  getJob,
  createJob,
  updateJob,
  deleteJob,
  setEnabled,
  listEnabledJobs,
  validateCron,
};

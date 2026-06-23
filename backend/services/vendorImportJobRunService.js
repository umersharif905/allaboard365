'use strict';

const { getPool, sql } = require('../config/database');

function sanitizeRun(row) {
  if (!row) return null;
  return {
    runId: row.RunId,
    jobId: row.JobId,
    vendorId: row.VendorId,
    tenantId: row.TenantId,
    triggerType: row.TriggerType,
    status: row.Status,
    filesFound: row.FilesFound || 0,
    filesImported: row.FilesImported || 0,
    filesFailed: row.FilesFailed || 0,
    householdsCreated: row.HouseholdsCreated || 0,
    householdsUpdated: row.HouseholdsUpdated || 0,
    householdsTerminated: row.HouseholdsTerminated || 0,
    householdsSkipped: row.HouseholdsSkipped || 0,
    errorSummary: row.ErrorSummary || null,
    startedUtc: row.StartedUtc,
    completedUtc: row.CompletedUtc || null,
  };
}

function sanitizeFile(row) {
  if (!row) return null;
  let rowErrors = null;
  let importSummary = null;
  try { rowErrors = row.RowErrors ? JSON.parse(row.RowErrors) : null; } catch { rowErrors = null; }
  try { importSummary = row.ImportSummary ? JSON.parse(row.ImportSummary) : null; } catch { importSummary = null; }
  return {
    fileId: row.FileId,
    runId: row.RunId,
    jobId: row.JobId,
    vendorId: row.VendorId,
    fileName: row.FileName,
    remotePath: row.RemotePath,
    status: row.Status,
    householdsCreated: row.HouseholdsCreated || 0,
    householdsUpdated: row.HouseholdsUpdated || 0,
    householdsTerminated: row.HouseholdsTerminated || 0,
    householdsSkipped: row.HouseholdsSkipped || 0,
    rowErrors,
    importSummary,
    archivePath: row.ArchivePath || null,
    processedUtc: row.ProcessedUtc,
  };
}

/**
 * Atomically acquire the IsRunning lock and insert a run record.
 * Returns { run, acquired } — acquired=false means the job was already running (skip).
 */
async function createRun({ jobId, vendorId, tenantId, triggerType }) {
  const pool = await getPool();

  // Atomic concurrency lock
  const lockResult = await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .query(`
      UPDATE oe.VendorImportJobs
      SET IsRunning = 1, LastRunAtUtc = SYSUTCDATETIME(), ModifiedUtc = SYSUTCDATETIME()
      WHERE JobId = @jobId AND IsRunning = 0;
      SELECT @@ROWCOUNT AS Acquired;
    `);
  const acquired = (lockResult.recordset?.[0]?.Acquired || 0) > 0;
  if (!acquired) return { run: null, acquired: false };

  const insertResult = await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('triggerType', sql.NVarChar(20), triggerType || 'scheduled')
    .query(`
      INSERT INTO oe.VendorImportJobRuns
        (JobId, VendorId, TenantId, TriggerType, Status)
      OUTPUT INSERTED.*
      VALUES (@jobId, @vendorId, @tenantId, @triggerType, 'running')
    `);
  return { run: sanitizeRun(insertResult.recordset?.[0]), acquired: true };
}

/**
 * Insert a skipped run record (no lock acquired — already running).
 */
async function createSkippedRun({ jobId, vendorId, tenantId, triggerType }) {
  const pool = await getPool();
  const result = await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('triggerType', sql.NVarChar(20), triggerType || 'scheduled')
    .query(`
      INSERT INTO oe.VendorImportJobRuns
        (JobId, VendorId, TenantId, TriggerType, Status, CompletedUtc)
      OUTPUT INSERTED.*
      VALUES (@jobId, @vendorId, @tenantId, @triggerType, 'skipped', SYSUTCDATETIME())
    `);
  return sanitizeRun(result.recordset?.[0]);
}

async function completeRun(runId, jobId, { status, filesFound, filesImported, filesFailed, householdsCreated, householdsUpdated, householdsTerminated, householdsSkipped, errorSummary }) {
  const pool = await getPool();
  await pool.request()
    .input('runId', sql.UniqueIdentifier, runId)
    .input('status', sql.NVarChar(20), status)
    .input('filesFound', sql.Int, filesFound || 0)
    .input('filesImported', sql.Int, filesImported || 0)
    .input('filesFailed', sql.Int, filesFailed || 0)
    .input('householdsCreated', sql.Int, householdsCreated || 0)
    .input('householdsUpdated', sql.Int, householdsUpdated || 0)
    .input('householdsTerminated', sql.Int, householdsTerminated || 0)
    .input('householdsSkipped', sql.Int, householdsSkipped || 0)
    .input('errorSummary', sql.NVarChar(sql.MAX), errorSummary || null)
    .query(`
      UPDATE oe.VendorImportJobRuns
      SET Status = @status,
          FilesFound = @filesFound,
          FilesImported = @filesImported,
          FilesFailed = @filesFailed,
          HouseholdsCreated = @householdsCreated,
          HouseholdsUpdated = @householdsUpdated,
          HouseholdsTerminated = @householdsTerminated,
          HouseholdsSkipped = @householdsSkipped,
          ErrorSummary = @errorSummary,
          CompletedUtc = SYSUTCDATETIME()
      WHERE RunId = @runId
    `);

  // Release IsRunning lock
  await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .query(`
      UPDATE oe.VendorImportJobs
      SET IsRunning = 0, ModifiedUtc = SYSUTCDATETIME()
      WHERE JobId = @jobId
    `);
}

async function failRun(runId, jobId, errorMessage) {
  return completeRun(runId, jobId, {
    status: 'failed',
    filesFound: 0,
    filesImported: 0,
    filesFailed: 0,
    householdsCreated: 0,
    householdsUpdated: 0,
    householdsTerminated: 0,
    householdsSkipped: 0,
    errorSummary: errorMessage,
  });
}

/**
 * Update a running job for live UI feedback (counts + status line in ErrorSummary).
 */
async function patchRunProgress(runId, {
  message,
  filesFound,
  filesImported,
  filesFailed,
  householdsCreated,
  householdsUpdated,
  householdsTerminated,
  householdsSkipped,
} = {}) {
  const pool = await getPool();
  const req = pool.request().input('runId', sql.UniqueIdentifier, runId);
  const sets = [];
  if (message !== undefined) {
    req.input('message', sql.NVarChar(sql.MAX), message);
    sets.push('ErrorSummary = @message');
  }
  if (filesFound !== undefined) {
    req.input('filesFound', sql.Int, filesFound);
    sets.push('FilesFound = @filesFound');
  }
  if (filesImported !== undefined) {
    req.input('filesImported', sql.Int, filesImported);
    sets.push('FilesImported = @filesImported');
  }
  if (filesFailed !== undefined) {
    req.input('filesFailed', sql.Int, filesFailed);
    sets.push('FilesFailed = @filesFailed');
  }
  if (householdsCreated !== undefined) {
    req.input('householdsCreated', sql.Int, householdsCreated);
    sets.push('HouseholdsCreated = @householdsCreated');
  }
  if (householdsUpdated !== undefined) {
    req.input('householdsUpdated', sql.Int, householdsUpdated);
    sets.push('HouseholdsUpdated = @householdsUpdated');
  }
  if (householdsTerminated !== undefined) {
    req.input('householdsTerminated', sql.Int, householdsTerminated);
    sets.push('HouseholdsTerminated = @householdsTerminated');
  }
  if (householdsSkipped !== undefined) {
    req.input('householdsSkipped', sql.Int, householdsSkipped);
    sets.push('HouseholdsSkipped = @householdsSkipped');
  }
  if (!sets.length) return;
  await req.query(`
    UPDATE oe.VendorImportJobRuns
    SET ${sets.join(', ')}
    WHERE RunId = @runId AND Status = 'running'
  `);
}

/**
 * Fail runs stuck in "running" and release orphaned IsRunning locks.
 * @returns {number} stale runs cleared
 */
async function releaseStaleRuns(maxAgeMinutes) {
  const maxAge = maxAgeMinutes
    ?? parseInt(process.env.SFTP_IMPORT_STALE_RUN_MINUTES || '120', 10);
  const pool = await getPool();

  const staleResult = await pool.request()
    .input('maxAge', sql.Int, maxAge)
    .query(`
      SELECT RunId, JobId
      FROM oe.VendorImportJobRuns
      WHERE Status = 'running'
        AND StartedUtc < DATEADD(MINUTE, -@maxAge, SYSUTCDATETIME())
    `);

  const stale = staleResult.recordset || [];
  for (const row of stale) {
    await failRun(
      row.RunId,
      row.JobId,
      `Run timed out after ${maxAge} minutes with no completion (stale lock cleared)`
    ).catch((e) => console.error('[vendorImportJobRunService] releaseStaleRuns:', e.message));
  }

  await pool.request().query(`
    UPDATE oe.VendorImportJobs
    SET IsRunning = 0, ModifiedUtc = SYSUTCDATETIME()
    WHERE IsRunning = 1
      AND NOT EXISTS (
        SELECT 1 FROM oe.VendorImportJobRuns r
        WHERE r.JobId = oe.VendorImportJobs.JobId AND r.Status = 'running'
      )
  `);

  return stale.length;
}

/**
 * Stop a stuck job: fail all in-flight runs and release IsRunning (manual operator action).
 */
async function cancelJobRuns(jobId, vendorId, { reason } = {}) {
  const pool = await getPool();
  const jobResult = await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT JobId FROM oe.VendorImportJobs
      WHERE JobId = @jobId AND VendorId = @vendorId
    `);
  if (!jobResult.recordset?.[0]) return { found: false, cancelledRuns: 0 };

  const message = reason || 'Cancelled by user';

  const runningResult = await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT RunId FROM oe.VendorImportJobRuns
      WHERE JobId = @jobId AND VendorId = @vendorId AND Status = 'running'
    `);

  const running = runningResult.recordset || [];
  for (const row of running) {
    await failRun(row.RunId, jobId, message).catch((e) =>
      console.error('[vendorImportJobRunService] cancelJobRuns failRun:', e.message)
    );
  }

  await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      UPDATE oe.VendorImportJobs
      SET IsRunning = 0, ModifiedUtc = SYSUTCDATETIME()
      WHERE JobId = @jobId AND VendorId = @vendorId
    `);

  return { found: true, cancelledRuns: running.length };
}

async function recordFile({
  runId,
  jobId,
  vendorId,
  fileName,
  remotePath,
  status,
  householdsCreated,
  householdsUpdated,
  householdsTerminated,
  householdsSkipped,
  rowErrors,
  importSummary,
  archivePath,
}) {
  const pool = await getPool();
  const importSummaryJson = importSummary ? JSON.stringify(importSummary) : null;
  const req = pool.request()
    .input('runId', sql.UniqueIdentifier, runId)
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('fileName', sql.NVarChar(500), fileName)
    .input('remotePath', sql.NVarChar(1000), remotePath)
    .input('status', sql.NVarChar(20), status)
    .input('householdsCreated', sql.Int, householdsCreated || 0)
    .input('householdsUpdated', sql.Int, householdsUpdated || 0)
    .input('householdsTerminated', sql.Int, householdsTerminated || 0)
    .input('householdsSkipped', sql.Int, householdsSkipped || 0)
    .input('rowErrors', sql.NVarChar(sql.MAX), rowErrors ? JSON.stringify(rowErrors) : null)
    .input('importSummary', sql.NVarChar(sql.MAX), importSummaryJson)
    .input('archivePath', sql.NVarChar(1000), archivePath || null);

  let result;
  try {
    result = await req.query(`
      INSERT INTO oe.VendorImportJobRunFiles
        (RunId, JobId, VendorId, FileName, RemotePath, Status,
         HouseholdsCreated, HouseholdsUpdated, HouseholdsTerminated, HouseholdsSkipped,
         RowErrors, ImportSummary, ArchivePath)
      OUTPUT INSERTED.*
      VALUES
        (@runId, @jobId, @vendorId, @fileName, @remotePath, @status,
         @householdsCreated, @householdsUpdated, @householdsTerminated, @householdsSkipped,
         @rowErrors, @importSummary, @archivePath)
    `);
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    if (!msg.includes('importsummary')) throw err;
    result = await pool.request()
      .input('runId', sql.UniqueIdentifier, runId)
      .input('jobId', sql.UniqueIdentifier, jobId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .input('fileName', sql.NVarChar(500), fileName)
      .input('remotePath', sql.NVarChar(1000), remotePath)
      .input('status', sql.NVarChar(20), status)
      .input('householdsCreated', sql.Int, householdsCreated || 0)
      .input('householdsUpdated', sql.Int, householdsUpdated || 0)
      .input('householdsTerminated', sql.Int, householdsTerminated || 0)
      .input('householdsSkipped', sql.Int, householdsSkipped || 0)
      .input('rowErrors', sql.NVarChar(sql.MAX), rowErrors ? JSON.stringify(rowErrors) : null)
      .input('archivePath', sql.NVarChar(1000), archivePath || null)
      .query(`
        INSERT INTO oe.VendorImportJobRunFiles
          (RunId, JobId, VendorId, FileName, RemotePath, Status,
           HouseholdsCreated, HouseholdsUpdated, HouseholdsTerminated, HouseholdsSkipped,
           RowErrors, ArchivePath)
        OUTPUT INSERTED.*
        VALUES
          (@runId, @jobId, @vendorId, @fileName, @remotePath, @status,
           @householdsCreated, @householdsUpdated, @householdsTerminated, @householdsSkipped,
           @rowErrors, @archivePath)
      `);
  }
  return sanitizeFile(result.recordset?.[0]);
}

async function listRuns(vendorId, { jobId, status, fromDate, toDate, page, limit } = {}) {
  const pageNum = Math.max(1, parseInt(page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 25));
  const offset = (pageNum - 1) * pageSize;

  const pool = await getPool();
  const req = pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('offset', sql.Int, offset)
    .input('limit', sql.Int, pageSize);

  const wheres = ['r.VendorId = @vendorId'];

  if (jobId) {
    req.input('jobId', sql.UniqueIdentifier, jobId);
    wheres.push('r.JobId = @jobId');
  }
  if (status) {
    req.input('status', sql.NVarChar(20), status);
    wheres.push('r.Status = @status');
  }
  if (fromDate) {
    req.input('fromDate', sql.DateTime2, new Date(fromDate));
    wheres.push('r.StartedUtc >= @fromDate');
  }
  if (toDate) {
    req.input('toDate', sql.DateTime2, new Date(toDate));
    wheres.push('r.StartedUtc <= @toDate');
  }

  const whereClause = wheres.join(' AND ');

  const countResult = await req.query(`
    SELECT COUNT(*) AS Total FROM oe.VendorImportJobRuns r WHERE ${whereClause}
  `);
  const total = countResult.recordset?.[0]?.Total || 0;

  const dataResult = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('offset', sql.Int, offset)
    .input('limit', sql.Int, pageSize)
    .input('jobId', sql.UniqueIdentifier, jobId || null)
    .input('status', sql.NVarChar(20), status || null)
    .input('fromDate', sql.DateTime2, fromDate ? new Date(fromDate) : null)
    .input('toDate', sql.DateTime2, toDate ? new Date(toDate) : null)
    .query(`
      SELECT r.*,
             j.JobName,
             j.FormatSlug,
             j.CronScheduleUtc
      FROM oe.VendorImportJobRuns r
      LEFT JOIN oe.VendorImportJobs j ON j.JobId = r.JobId
      WHERE r.VendorId = @vendorId
        AND (@jobId IS NULL OR r.JobId = @jobId)
        AND (@status IS NULL OR r.Status = @status)
        AND (@fromDate IS NULL OR r.StartedUtc >= @fromDate)
        AND (@toDate IS NULL OR r.StartedUtc <= @toDate)
      ORDER BY r.StartedUtc DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

  return {
    runs: dataResult.recordset.map((r) => ({
      ...sanitizeRun(r),
      jobName: r.JobName || null,
      formatSlug: r.FormatSlug || null,
      cronScheduleUtc: r.CronScheduleUtc || null,
    })),
    pagination: {
      page: pageNum,
      limit: pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

async function getRunWithFiles(runId, vendorId) {
  const pool = await getPool();
  const runResult = await pool.request()
    .input('runId', sql.UniqueIdentifier, runId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT r.*, j.JobName, j.FormatSlug
      FROM oe.VendorImportJobRuns r
      LEFT JOIN oe.VendorImportJobs j ON j.JobId = r.JobId
      WHERE r.RunId = @runId AND r.VendorId = @vendorId
    `);
  const runRow = runResult.recordset?.[0];
  if (!runRow) return null;

  const filesResult = await pool.request()
    .input('runId', sql.UniqueIdentifier, runId)
    .query(`
      SELECT * FROM oe.VendorImportJobRunFiles
      WHERE RunId = @runId
      ORDER BY ProcessedUtc
    `);

  return {
    ...sanitizeRun(runRow),
    jobName: runRow.JobName || null,
    formatSlug: runRow.FormatSlug || null,
    files: filesResult.recordset.map(sanitizeFile),
  };
}

module.exports = {
  createRun,
  createSkippedRun,
  completeRun,
  failRun,
  patchRunProgress,
  releaseStaleRuns,
  recordFile,
  cancelJobRuns,
  listRuns,
  getRunWithFiles,
};

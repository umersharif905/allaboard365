'use strict';

const cronParser = require('cron-parser');
const { getPool, sql } = require('../config/database');
const encryptionService = require('./encryptionService');
const sftpClientWrapper = require('./sftpClientWrapper');
const vendorImportJobRunService = require('./vendorImportJobRunService');
const sftpImportEmailService = require('./sftpImportEmailService');
const eligibilityImport = require('./eligibilityImportService');

const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.SFTP_IMPORT_DOWNLOAD_TIMEOUT_MS || String(15 * 60 * 1000), 10);
const FILE_IMPORT_TIMEOUT_MS = parseInt(process.env.SFTP_IMPORT_FILE_TIMEOUT_MS || String(90 * 60 * 1000), 10);

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${Math.round(ms / 60000)} minutes`)),
        ms
      );
    }),
  ]);
}

/**
 * Evaluate whether a cron expression was due within the last 5 minutes (one tick window).
 */
function isJobDue(cronExpr, now) {
  try {
    const interval = cronParser.parseExpression(cronExpr, { utc: true, currentDate: now });
    const prev = interval.prev();
    const diffMs = now - prev.toDate();
    return diffMs <= 5 * 60 * 1000;
  } catch {
    return false;
  }
}

/**
 * Decrypt SFTP credentials from raw DB row (PasswordEncrypted etc.).
 */
function decryptRowCreds(row) {
  const creds = {};
  const authType = row.AuthType || 'password';
  if (authType === 'password') {
    if (!row.PasswordEncrypted) throw new Error('SFTP password not configured for this connection');
    creds.password = encryptionService.decrypt(row.PasswordEncrypted);
  } else if (authType === 'privateKey') {
    if (!row.PrivateKeyEncrypted) throw new Error('SFTP private key not configured for this connection');
    creds.privateKey = encryptionService.decrypt(row.PrivateKeyEncrypted);
    if (row.PassphraseEncrypted) {
      creds.passphrase = encryptionService.decrypt(row.PassphraseEncrypted);
    }
  }
  return creds;
}

/**
 * Evaluate all enabled jobs and fire those whose cron is due.
 * Called by the scheduled trigger endpoint.
 * @returns {{ jobsEvaluated, jobsFired, jobsSkipped }}
 */
async function runDueJobs() {
  const pool = await getPool();
  const now = new Date();

  const result = await pool.request()
    .query(`
      SELECT j.*,
             c.Host, c.Port, c.Username, c.AuthType,
             c.PasswordEncrypted, c.PrivateKeyEncrypted, c.PassphraseEncrypted,
             c.BaseDirectory
      FROM oe.VendorImportJobs j
      INNER JOIN oe.VendorSftpConnections c
        ON c.ConnectionId = j.ConnectionId AND c.IsActive = 1
      WHERE j.IsEnabled = 1
    `);

  const allJobs = result.recordset;
  let jobsFired = 0;
  let jobsSkipped = 0;

  for (const jobRow of allJobs) {
    if (!isJobDue(jobRow.CronScheduleUtc, now)) continue;

    if (jobRow.IsRunning) {
      // Already running — record a skipped entry and continue
      await vendorImportJobRunService.createSkippedRun({
        jobId: jobRow.JobId,
        vendorId: jobRow.VendorId,
        tenantId: jobRow.TenantId,
        triggerType: 'scheduled',
      }).catch((e) => console.error('[sftp-orchestrator] createSkippedRun failed:', e.message));
      jobsSkipped++;
      continue;
    }

    // Fire async — do not await; the trigger endpoint returns immediately
    setImmediate(() => {
      runJob(jobRow, { triggerType: 'scheduled' }).catch((e) =>
        console.error(`[sftp-orchestrator] runJob ${jobRow.JobId} error:`, e.message)
      );
    });
    jobsFired++;
  }

  return { jobsEvaluated: allJobs.length, jobsFired, jobsSkipped };
}

/**
 * Run a specific job by ID on demand (Run Now).
 * Async fire-and-forget; returns runId immediately after lock acquisition.
 * Works on disabled jobs (isEnabled is a scheduling gate, not a security gate).
 */
async function runJobById(jobId, vendorId) {
  await vendorImportJobRunService.releaseStaleRuns().catch(() => {});

  const pool = await getPool();
  const result = await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT j.*,
             c.Host, c.Port, c.Username, c.AuthType,
             c.PasswordEncrypted, c.PrivateKeyEncrypted, c.PassphraseEncrypted,
             c.BaseDirectory
      FROM oe.VendorImportJobs j
      INNER JOIN oe.VendorSftpConnections c
        ON c.ConnectionId = j.ConnectionId AND c.IsActive = 1
      WHERE j.JobId = @jobId AND j.VendorId = @vendorId
    `);
  const jobRow = result.recordset?.[0];
  if (!jobRow) throw new Error('Import job not found');

  const { run, acquired } = await vendorImportJobRunService.createRun({
    jobId: jobRow.JobId,
    vendorId: jobRow.VendorId,
    tenantId: jobRow.TenantId,
    triggerType: 'manual',
  });

  if (!acquired) {
    throw new Error('Job is already running');
  }

  // Fire async
  setImmediate(() => {
    _executeJob(jobRow, run.runId, { alreadyLocked: true }).catch((e) =>
      console.error(`[sftp-orchestrator] runJobById ${jobId} error:`, e.message)
    );
  });

  return run.runId;
}

/**
 * Main job runner — called with a raw DB row (includes SFTP connection columns).
 * Acquires lock, executes, completes/fails, sends email.
 */
async function runJob(jobRow, { triggerType = 'scheduled' } = {}) {
  const { run, acquired } = await vendorImportJobRunService.createRun({
    jobId: jobRow.JobId,
    vendorId: jobRow.VendorId,
    tenantId: jobRow.TenantId,
    triggerType,
  });

  if (!acquired) {
    // Race — another process beat us; log a skipped record
    await vendorImportJobRunService.createSkippedRun({
      jobId: jobRow.JobId,
      vendorId: jobRow.VendorId,
      tenantId: jobRow.TenantId,
      triggerType,
    }).catch(() => {});
    return;
  }

  await _executeJob(jobRow, run.runId, { alreadyLocked: false });
}

/**
 * Internal: do the actual SFTP work, write per-file rows, complete the run.
 */
async function _executeJob(jobRow, runId, { alreadyLocked }) {
  const client = sftpClientWrapper.create();
  const creds = decryptRowCreds(jobRow);

  const remoteFolderParts = [
    (jobRow.BaseDirectory || '').replace(/\/$/, ''),
    (jobRow.SubFolderPath || '').replace(/^\//, ''),
  ].filter(Boolean);
  const remoteFolder = remoteFolderParts.length ? '/' + remoteFolderParts.join('/') : '/';
  const archiveDir = remoteFolder.replace(/\/$/, '') + '/' + (jobRow.ArchiveFolder || 'archived');

  const counts = {
    filesFound: 0,
    filesImported: 0,
    filesFailed: 0,
    householdsCreated: 0,
    householdsUpdated: 0,
    householdsTerminated: 0,
    householdsSkipped: 0,
  };
  const errors = [];

  const reportProgress = (message, extra = {}) => {
    vendorImportJobRunService.patchRunProgress(runId, {
      message,
      filesFound: counts.filesFound,
      filesImported: counts.filesImported,
      filesFailed: counts.filesFailed,
      householdsCreated: counts.householdsCreated,
      householdsUpdated: counts.householdsUpdated,
      householdsTerminated: counts.householdsTerminated,
      householdsSkipped: counts.householdsSkipped,
      ...extra,
    }).catch(() => {});
  };

  try {
    await reportProgress('Connecting to SFTP…');

    // Connect
    await withTimeout(
      client.connect({
        host: jobRow.Host,
        port: jobRow.Port,
        username: jobRow.Username,
        ...creds,
      }),
      30_000,
      'SFTP connect'
    );

    await reportProgress(`Listing CSV files in ${remoteFolder}…`);

    // List CSV files
    const files = await withTimeout(
      client.listCsvFiles(remoteFolder),
      60_000,
      'SFTP list'
    );
    counts.filesFound = files.length;
    await reportProgress(
      files.length ? `Found ${files.length} file(s); starting import…` : 'No CSV files found',
      { filesFound: files.length }
    );

    if (files.length === 0) {
      await client.disconnect().catch(() => {});
      await vendorImportJobRunService.completeRun(runId, jobRow.JobId, {
        status: 'no-files',
        ...counts,
      });
      await _sendEmail(jobRow, runId, 'no-files', counts, []).catch((e) =>
        console.error('[sftp-orchestrator] email error:', e.message)
      );
      return;
    }

    // Ensure archive folder exists once (recursive mkdir per path segment)
    try {
      await client.ensureDirectory(archiveDir);
    } catch (mkdirErr) {
      console.warn(`[sftp-orchestrator] could not create archive dir ${archiveDir}:`, mkdirErr.message);
    }

    // Process each file
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      let importResult = null;
      let archivePath = null;
      let fileStatus = 'success';
      let rowErrors = null;

      try {
        await reportProgress(`Downloading ${file.name} (${fileIndex + 1}/${files.length})…`);

        const buffer = await withTimeout(
          client.downloadFile(file.remotePath),
          DOWNLOAD_TIMEOUT_MS,
          `Download ${file.name}`
        );
        const csvText = buffer.toString('utf8');

        await reportProgress(`Importing ${file.name} (${fileIndex + 1}/${files.length})…`);

        importResult = await withTimeout(
          eligibilityImport.commitEligibilityImport({
            vendorId: jobRow.VendorId,
            tenantId: jobRow.TenantId,
            csvText,
            formatSlug: jobRow.FormatSlug,
            importFileName: file.name,
            createdBy: null,
            allowTenantMove: jobRow.AllowTenantMove === 1 || jobRow.AllowTenantMove === true,
            skipHouseholdWithUnmappedPlans: jobRow.SkipHouseholdWithUnmappedPlans == null
              ? true
              : (jobRow.SkipHouseholdWithUnmappedPlans !== 0 && jobRow.SkipHouseholdWithUnmappedPlans !== false),
            onProgress: (event) => {
              if (event?.message) reportProgress(`${file.name}: ${event.message}`);
            },
          }),
          FILE_IMPORT_TIMEOUT_MS,
          `Import ${file.name}`
        );

        const importedCount =
          (importResult?.created || 0)
          + (importResult?.updated || 0)
          + (importResult?.terminated || 0)
          + (importResult?.skipped || 0);
        const commitErrors = importResult?.errors || [];

        if (commitErrors.length && importedCount === 0) {
          fileStatus = 'failed';
          rowErrors = commitErrors.slice(0, 50).map((e) => ({
            row: e.row || 0,
            message: e.message || String(e),
          }));
          errors.push(`${file.name}: ${rowErrors[0]?.message || 'import failed'}`);
          counts.filesFailed++;
        } else {
          counts.householdsCreated += importResult?.created || 0;
          counts.householdsUpdated += importResult?.updated || 0;
          counts.householdsTerminated += importResult?.terminated || 0;
          counts.householdsSkipped += importResult?.skipped || 0;

          if (commitErrors.length) {
            rowErrors = commitErrors.slice(0, 50).map((e) => ({
              row: e.row || 0,
              message: e.message || String(e),
            }));
          }

          await reportProgress(`Archiving ${file.name}…`);

          try {
            archivePath = await withTimeout(
              client.archiveFile(file.remotePath, archiveDir),
              60_000,
              `Archive ${file.name}`
            );
          } catch (archiveErr) {
            console.error(
              `[sftp-orchestrator] archive failed for ${file.name} (${file.remotePath} → ${archiveDir}):`,
              archiveErr.message,
            );
            const archiveMsg = `Archive failed (${file.remotePath} → ${archiveDir}): ${archiveErr.message}`;
            errors.push(`${file.name}: ${archiveMsg}`);
            rowErrors = [...(rowErrors || []), { row: 0, message: archiveMsg }];
          }

          counts.filesImported++;
          await reportProgress(
            `Finished ${file.name} (${fileIndex + 1}/${files.length})`,
            {
              filesImported: counts.filesImported,
              filesFailed: counts.filesFailed,
              householdsCreated: counts.householdsCreated,
              householdsUpdated: counts.householdsUpdated,
            }
          );
        }
      } catch (fileErr) {
        fileStatus = 'failed';
        rowErrors = [{ row: 0, message: fileErr.message }];
        errors.push(`${file.name}: ${fileErr.message}`);
        counts.filesFailed++;
      }

      const householdSummaries = importResult?.householdSummaries?.slice(0, 400) || [];
      await vendorImportJobRunService.recordFile({
        runId,
        jobId: jobRow.JobId,
        vendorId: jobRow.VendorId,
        fileName: file.name,
        remotePath: file.remotePath,
        status: fileStatus,
        householdsCreated: importResult?.created || 0,
        householdsUpdated: importResult?.updated || 0,
        householdsTerminated: importResult?.terminated || 0,
        householdsSkipped: importResult?.skipped || 0,
        rowErrors,
        importSummary: householdSummaries.length
          ? { households: householdSummaries, archivePath: archivePath || null }
          : archivePath
            ? { households: [], archivePath }
            : null,
        archivePath,
      }).catch((e) => console.error('[sftp-orchestrator] recordFile error:', e.message));
    }

    await client.disconnect().catch(() => {});

    // Determine aggregate status
    let finalStatus = 'success';
    if (counts.filesFailed > 0 && counts.filesImported > 0) finalStatus = 'partial';
    else if (counts.filesFailed > 0 && counts.filesImported === 0) finalStatus = 'failed';
    else if (errors.length > 0 && counts.filesImported > 0) finalStatus = 'partial';

    await vendorImportJobRunService.completeRun(runId, jobRow.JobId, {
      status: finalStatus,
      ...counts,
      errorSummary: errors.length ? errors.slice(0, 20).join('\n') : null,
    });

    await _sendEmail(jobRow, runId, finalStatus, counts, errors).catch((e) =>
      console.error('[sftp-orchestrator] email error:', e.message)
    );
  } catch (fatalErr) {
    console.error(`[sftp-orchestrator] fatal error for job ${jobRow.JobId}:`, fatalErr.message);
    await client.disconnect().catch(() => {});
    await vendorImportJobRunService.failRun(runId, jobRow.JobId, fatalErr.message).catch(() => {});
    await _sendEmail(jobRow, runId, 'failed', counts, [fatalErr.message]).catch(() => {});
  }
}

async function _sendEmail(jobRow, runId, status, counts, errors) {
  const notifyEmails = (() => {
    try { return JSON.parse(jobRow.NotifyEmails || '[]'); } catch { return []; }
  })();
  if (!notifyEmails.length) return;

  const shouldSend =
    (status === 'no-files' && jobRow.NotifyOnNoFiles) ||
    (['success', 'partial'].includes(status) && jobRow.NotifyOnSuccess) ||
    (['failed', 'partial'].includes(status) && jobRow.NotifyOnFailure);

  if (!shouldSend) return;

  await sftpImportEmailService.sendRunReport({
    to: notifyEmails,
    jobId: jobRow.JobId,
    jobName: jobRow.JobName || jobRow.JobId,
    tenantId: jobRow.TenantId,
    runId,
    status,
    counts,
    errors,
  });
}

module.exports = { runDueJobs, runJob, runJobById, isJobDue };

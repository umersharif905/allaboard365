#!/usr/bin/env node
'use strict';

/**
 * Download latest CSV from each ShareWELL SFTP import folder and run eligibility preview.
 *
 *   node backend/scripts/verify-sftp-manual-import.cjs
 *   node backend/scripts/verify-sftp-manual-import.cjs --save-dir /tmp/sftp-csv
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const { getPool, sql } = require('../config/database');
const encryptionService = require('../services/encryptionService');
const sftpClientWrapper = require('../services/sftpClientWrapper');
const eligibilityImport = require('../services/eligibilityImportService');

const SHAREWELL_VENDOR = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

function credsFromRow(row) {
  const out = { host: row.Host, port: row.Port || 22, username: row.Username };
  if (row.AuthType === 'key' && row.PrivateKeyEncrypted) {
    out.privateKey = encryptionService.decrypt(row.PrivateKeyEncrypted);
    if (row.PassphraseEncrypted) out.passphrase = encryptionService.decrypt(row.PassphraseEncrypted);
  } else if (row.PasswordEncrypted) {
    out.password = encryptionService.decrypt(row.PasswordEncrypted);
  }
  return out;
}

function pickLatestCsv(files) {
  if (!files.length) return null;
  return [...files].sort((a, b) => {
    const ta = a.modifyTime || 0;
    const tb = b.modifyTime || 0;
    return tb - ta || String(b.name).localeCompare(String(a.name));
  })[0];
}

async function activePrimaryCount(pool, tenantId) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT COUNT(DISTINCT m.HouseholdId) AS households,
             COUNT(DISTINCT m.MemberId) AS primaries
      FROM oe.Members m
      WHERE m.TenantId = @tenantId
        AND m.RelationshipType = N'P'
        AND m.Status = N'Active'
    `);
  return r.recordset[0] || { households: 0, primaries: 0 };
}

async function main() {
  const saveIdx = process.argv.indexOf('--save-dir');
  const saveDir = saveIdx >= 0 ? process.argv[saveIdx + 1] : null;
  if (saveDir) fs.mkdirSync(saveDir, { recursive: true });

  const pool = await getPool();
  const jobsRes = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, SHAREWELL_VENDOR)
    .query(`
      SELECT j.JobName, j.SubFolderPath, j.FormatSlug, j.TenantId, t.Name AS TenantName,
             c.Host, c.Port, c.Username, c.AuthType,
             c.PasswordEncrypted, c.PrivateKeyEncrypted, c.PassphraseEncrypted
      FROM oe.VendorImportJobs j
      INNER JOIN oe.VendorSftpConnections c ON c.ConnectionId = j.ConnectionId AND c.IsActive = 1
      LEFT JOIN oe.Tenants t ON t.TenantId = j.TenantId
      WHERE j.VendorId = @vendorId
        AND j.SubFolderPath IN (N'/ALIGN', N'/ALIGN/SHA', N'/MBP')
      ORDER BY j.SubFolderPath
    `);

  const jobs = jobsRes.recordset;
  if (!jobs.length) {
    console.error('No import jobs found for /ALIGN, /ALIGN/SHA, /MBP');
    process.exit(1);
  }

  const creds = credsFromRow(jobs[0]);
  if (!creds.password && !creds.privateKey) {
    console.error('SFTP connection has no password/key in DB');
    process.exit(1);
  }

  const client = sftpClientWrapper.create();
  console.log('Connecting SFTP', creds.host, 'as', creds.username);
  await client.connect(creds);

  const summaries = [];

  for (const job of jobs) {
    const folder = job.SubFolderPath;
    console.log('\n' + '='.repeat(72));
    console.log('JOB:', job.JobName, '|', folder, '| tenant:', job.TenantName);
    console.log('Format:', job.FormatSlug, '|', job.TenantId);

    const dbCounts = await activePrimaryCount(pool, job.TenantId);
    console.log('DB active primaries:', dbCounts.primaries, '| households:', dbCounts.households);

    const archiveCandidates = [
      `${folder}/archive`,
      `${folder}/Archive`,
      `${folder}/ARCHIVE`,
    ];

    let files = [];
    let listFolder = folder;
    try {
      files = await client.listCsvFiles(folder);
    } catch (err) {
      console.log('LIST FAILED:', err.message);
      summaries.push({ job: job.JobName, error: err.message });
      continue;
    }

    if (!files.length) {
      for (const arch of archiveCandidates) {
        try {
          const archived = await client.listCsvFiles(arch);
          if (archived.length) {
            files = archived;
            listFolder = arch;
            break;
          }
        } catch (_) { /* folder may not exist */ }
      }
    }

    console.log('CSV files:', files.length, listFolder === folder ? '(inbox)' : `(archive: ${listFolder})`);
    if (!files.length) {
      summaries.push({ job: job.JobName, folder, error: 'no_csv_files' });
      continue;
    }

    const latest = pickLatestCsv(files);
    console.log('Latest file:', latest.name, latest.remotePath);

    const buf = await client.downloadFile(latest.remotePath);
    const csvText = buf.toString('utf8');
    const lineCount = csvText.split(/\r?\n/).filter((l) => l.trim()).length - 1;

    if (saveDir) {
      const outPath = path.join(saveDir, `${job.JobName}-${latest.name}`);
      fs.writeFileSync(outPath, csvText);
      console.log('Saved:', outPath);
    }

    const preview = await eligibilityImport.previewEligibilityImport({
      vendorId: SHAREWELL_VENDOR,
      tenantId: job.TenantId,
      csvText,
      formatSlug: job.FormatSlug,
    });

    const stats = preview.statistics;
    const unmapped = preview.validation?.unmappedProducts || [];
    console.log('CSV data rows (approx):', lineCount);
    console.log('Preview rows:', stats.totalRows, '| households:', stats.households);
    console.log('Actions — create:', stats.creates, 'update:', stats.updates,
      'terminate:', stats.terminates, 'skip:', stats.skips);
    console.log('Unmapped plan keys:', stats.unmappedPlanCodes,
      '| households w/ unmapped:', stats.householdsWithUnmappedPlans);
    if (unmapped.length) {
      console.log('Unmapped sample:', unmapped.slice(0, 15).join(', '));
    }
    if (preview.validation?.formatIssues?.length) {
      console.log('Format issues:', preview.validation.formatIssues.map((f) => f.message).join(' | '));
    }

    summaries.push({
      job: job.JobName,
      folder,
      tenant: job.TenantName,
      file: latest.name,
      dbHouseholds: dbCounts.households,
      dbPrimaries: dbCounts.primaries,
      csvRows: stats.totalRows,
      previewHouseholds: stats.households,
      creates: stats.creates,
      updates: stats.updates,
      unmappedPlanCodes: stats.unmappedPlanCodes,
      householdsWithUnmappedPlans: stats.householdsWithUnmappedPlans,
    });
  }

  await client.disconnect();
  await pool.close();

  console.log('\n' + '='.repeat(72));
  console.log('SUMMARY');
  console.table(summaries);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(99);
});

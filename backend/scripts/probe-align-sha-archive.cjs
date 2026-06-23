#!/usr/bin/env node
'use strict';

/**
 * Probe Align SHA SFTP archive paths (stat + optional archive test).
 *
 *   node backend/scripts/probe-align-sha-archive.cjs
 *   node backend/scripts/probe-align-sha-archive.cjs --archive
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { getPool, sql } = require('../config/database');
const { decrypt } = require('../services/encryptionService');
const sftpClientWrapper = require('../services/sftpClientWrapper');

const SHAREWELL_VENDOR = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
const SHA_FOLDER = '/ALIGN/SHA';
const ARCHIVE_DIR = '/ALIGN/SHA/Archive';
const TEST_FILE = 'SHA-Sharewell-05282026_20260604_150028.csv';

function credsFromRow(row) {
  const out = { host: row.Host, port: row.Port || 22, username: row.Username };
  if (row.AuthType === 'key' && row.PrivateKeyEncrypted) {
    out.privateKey = decrypt(row.PrivateKeyEncrypted);
    if (row.PassphraseEncrypted) out.passphrase = decrypt(row.PassphraseEncrypted);
  } else if (row.PasswordEncrypted) {
    out.password = decrypt(row.PasswordEncrypted);
  }
  return out;
}

async function statPath(client, remotePath) {
  try {
    const stats = await client.statRemote(remotePath);
    const isDir = typeof stats.isDirectory === 'function' ? stats.isDirectory() : null;
    return { path: remotePath, ok: true, isDirectory: isDir, mode: stats.mode, size: stats.size };
  } catch (err) {
    return { path: remotePath, ok: false, error: err.message || String(err), code: err.code };
  }
}

async function main() {
  const doArchive = process.argv.includes('--archive');
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, SHAREWELL_VENDOR)
    .query(`
      SELECT TOP 1 j.JobName, j.SubFolderPath, j.ArchiveFolder,
             c.Host, c.Port, c.Username, c.AuthType,
             c.PasswordEncrypted, c.PrivateKeyEncrypted, c.PassphraseEncrypted, c.BaseDirectory
      FROM oe.VendorImportJobs j
      INNER JOIN oe.VendorSftpConnections c ON c.ConnectionId = j.ConnectionId AND c.IsActive = 1
      WHERE j.VendorId = @vendorId
        AND (j.JobName LIKE '%Align%SHA%' OR j.SubFolderPath LIKE '%ALIGN/SHA%')
      ORDER BY j.JobName
    `);

  const job = r.recordset[0];
  if (!job) {
    console.error('No Align SHA import job found');
    process.exit(1);
  }

  console.log('Job:', job.JobName);
  console.log('SubFolderPath:', job.SubFolderPath, 'ArchiveFolder:', job.ArchiveFolder);

  const client = sftpClientWrapper.create();
  const creds = credsFromRow(job);
  console.log('Connecting to', creds.host, 'as', creds.username);
  await client.connect(creds);

  for (const p of ['/', '/ALIGN', '/ALIGN/SHA', ARCHIVE_DIR, `${SHA_FOLDER}/${TEST_FILE}`]) {
    const s = await statPath(client, p);
    console.log(JSON.stringify(s));
  }

  const files = await client.listCsvFiles(SHA_FOLDER);
  console.log('CSV in', SHA_FOLDER, ':', files.map((f) => f.name));

  if (doArchive) {
    const target = files.find((f) => f.name === TEST_FILE);
    if (!target) {
      console.log('Test file not in folder — skip --archive');
    } else {
      console.log('Archiving', target.remotePath, '→', ARCHIVE_DIR);
      const dest = await client.archiveFile(target.remotePath, ARCHIVE_DIR);
      console.log('Archive OK:', dest);
    }
  }

  await client.disconnect();
  await pool.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(99);
});

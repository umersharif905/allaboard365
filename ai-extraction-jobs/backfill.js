#!/usr/bin/env node
// Backfill: enqueue every document in oe.ProductDocuments that has no ExtractionStatus.
// Generates fresh 24h SAS URLs so the Function can download via axios.get.
//
// Usage:
//   DB_USER=... DB_PASSWORD=... DB_SERVER=... DB_NAME=allaboard-testing \
//   SERVICE_BUS_CONNECTION='Endpoint=sb://...' \
//   AZURE_STORAGE_CONNECTION_STRING='DefaultEndpointsProtocol=...' \
//   node backfill.js
//
// Add --dry-run to list what would be enqueued without sending anything.

const sql = require('mssql');
const { ServiceBusClient } = require('@azure/service-bus');
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
} = require('@azure/storage-blob');

const dryRun = process.argv.includes('--dry-run');

function parseStorageConnString(conn) {
  const parts = Object.fromEntries(
    conn
      .split(';')
      .filter(Boolean)
      .map((kv) => {
        const idx = kv.indexOf('=');
        return [kv.slice(0, idx), kv.slice(idx + 1)];
      }),
  );
  return {
    accountName: parts.AccountName,
    accountKey: parts.AccountKey,
  };
}

// Given a stored DocumentUrl (which may include an expired SAS token), produce a
// fresh SAS URL valid for 24 hours so the Function can download the blob.
function freshSasFor(documentUrl, credential) {
  const u = new URL(documentUrl);
  // Path looks like /container/blob.pdf — strip leading slash, split first segment.
  const path = u.pathname.replace(/^\/+/, '');
  const slash = path.indexOf('/');
  if (slash < 0) throw new Error(`Cannot parse container from ${documentUrl}`);
  const containerName = path.slice(0, slash);
  const blobName = path.slice(slash + 1);

  const expiresOn = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn: new Date(Date.now() - 5 * 60 * 1000),
      expiresOn,
      protocol: 'https',
    },
    credential,
  ).toString();

  return `${u.origin}/${containerName}/${encodeURI(blobName)}?${sas}`;
}

async function main() {
  for (const v of ['DB_USER', 'DB_PASSWORD', 'DB_SERVER', 'DB_NAME', 'AZURE_STORAGE_CONNECTION_STRING', 'SERVICE_BUS_CONNECTION']) {
    if (!process.env[v]) {
      console.error(`Missing env: ${v}`);
      process.exit(1);
    }
  }

  console.log(`Target DB: ${process.env.DB_NAME} on ${process.env.DB_SERVER}`);
  if (process.env.DB_NAME && process.env.DB_NAME.toLowerCase().includes('prod')) {
    console.error('SAFETY: refusing to run against a "prod"-named DB. Edit script to override.');
    process.exit(1);
  }

  const pool = await sql.connect({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 4 },
  });

  const result = await pool.request().query(`
    SELECT
      pd.ProductDocumentId,
      pd.ProductId,
      pd.DocumentUrl,
      pd.DisplayName,
      p.ProductOwnerId AS TenantId,
      pd.ExtractionStatus
    FROM oe.ProductDocuments pd
    LEFT JOIN oe.Products p ON pd.ProductId = p.ProductId
    WHERE pd.ExtractionStatus IS NULL
       OR pd.ExtractionStatus = 'failed'
  `);
  const rows = result.recordset;
  console.log(`Found ${rows.length} document(s) to enqueue.`);

  if (rows.length === 0) {
    await pool.close();
    return;
  }

  const { accountName, accountKey } = parseStorageConnString(process.env.AZURE_STORAGE_CONNECTION_STRING);
  const credential = new StorageSharedKeyCredential(accountName, accountKey);

  if (dryRun) {
    rows.slice(0, 5).forEach((r) => console.log(`  - ${r.ProductDocumentId} ${r.DisplayName || ''}`));
    console.log(`(dry run — first 5 of ${rows.length} listed; nothing enqueued)`);
    await pool.close();
    return;
  }

  const sbClient = new ServiceBusClient(process.env.SERVICE_BUS_CONNECTION);
  const sender = sbClient.createSender('ai-extract-queue');

  let okCount = 0;
  let failCount = 0;
  for (const r of rows) {
    try {
      const freshUrl = freshSasFor(r.DocumentUrl, credential);
      await pool.request()
        .input('ProductDocumentId', sql.UniqueIdentifier, r.ProductDocumentId)
        .query(`UPDATE oe.ProductDocuments
                SET ExtractionStatus='queued',
                    ExtractionError = NULL
                WHERE ProductDocumentId=@ProductDocumentId`);
      await sender.sendMessages({
        body: {
          productDocumentId: r.ProductDocumentId,
          productId: r.ProductId,
          tenantId: r.TenantId,
          blobUrl: freshUrl,
          fileName: r.DisplayName || 'document.pdf',
        },
      });
      console.log(`✓ enqueued ${r.ProductDocumentId} (${r.DisplayName || 'unnamed'})`);
      okCount++;
    } catch (err) {
      console.error(`✗ ${r.ProductDocumentId}: ${err.message}`);
      failCount++;
    }
  }

  await sender.close();
  await sbClient.close();
  await pool.close();
  console.log(`\nDone. ${okCount} enqueued, ${failCount} failed.`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

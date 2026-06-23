// Smoke test: enqueue exactly ONE document.
const sql = require('mssql');
const { ServiceBusClient } = require('@azure/service-bus');
const {
  StorageSharedKeyCredential,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
} = require('@azure/storage-blob');

function parseStorageConnString(conn) {
  const parts = Object.fromEntries(
    conn.split(';').filter(Boolean).map((kv) => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx), kv.slice(idx + 1)];
    }),
  );
  return { accountName: parts.AccountName, accountKey: parts.AccountKey };
}

function freshSasFor(documentUrl, credential) {
  const u = new URL(documentUrl);
  const path = u.pathname.replace(/^\/+/, '');
  const slash = path.indexOf('/');
  const containerName = path.slice(0, slash);
  const blobName = path.slice(slash + 1);
  const expiresOn = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const sas = generateBlobSASQueryParameters(
    {
      containerName, blobName,
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
  const pool = await sql.connect({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER, database: process.env.DB_NAME,
    options: { encrypt: true, trustServerCertificate: false },
  });
  // Use the named PDF (MEC Preventative) for a clear test
  const r = (await pool.request().query(`
    SELECT TOP 1 pd.ProductDocumentId, pd.ProductId, pd.DocumentUrl, pd.DisplayName, p.ProductOwnerId AS TenantId
    FROM oe.ProductDocuments pd LEFT JOIN oe.Products p ON pd.ProductId = p.ProductId
    WHERE pd.DisplayName LIKE '%MEC Preventative%'
  `)).recordset[0];
  if (!r) { console.error('No matching doc'); process.exit(1); }
  console.log('Enqueueing:', r.DisplayName, '(', r.ProductDocumentId, ')');
  const { accountName, accountKey } = parseStorageConnString(process.env.AZURE_STORAGE_CONNECTION_STRING);
  const cred = new StorageSharedKeyCredential(accountName, accountKey);
  const freshUrl = freshSasFor(r.DocumentUrl, cred);
  await pool.request()
    .input('ProductDocumentId', sql.UniqueIdentifier, r.ProductDocumentId)
    .query(`UPDATE oe.ProductDocuments SET ExtractionStatus='queued', ExtractionError=NULL WHERE ProductDocumentId=@ProductDocumentId`);
  const sb = new ServiceBusClient(process.env.SERVICE_BUS_CONNECTION);
  const sender = sb.createSender('ai-extract-queue');
  await sender.sendMessages({
    body: {
      productDocumentId: r.ProductDocumentId,
      productId: r.ProductId,
      tenantId: r.TenantId,
      blobUrl: freshUrl,
      fileName: r.DisplayName,
    },
  });
  console.log('Sent. Watch Application Insights or query oe.AIChunks.');
  await sender.close(); await sb.close(); await pool.close();
}

main().catch((e) => { console.error(e); process.exit(1); });

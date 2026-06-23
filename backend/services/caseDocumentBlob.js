// backend/services/caseDocumentBlob.js
// Download an Azure blob (by full URL) to a Buffer. Returns null on failure.
const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const blobServiceClient = connectionString
  ? BlobServiceClient.fromConnectionString(connectionString)
  : null;

function parseBlobUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/^\//, '').split('/');
    const containerName = parts.shift();
    const blobName = decodeURIComponent(parts.join('/'));
    return containerName && blobName ? { containerName, blobName } : null;
  } catch (_e) { return null; }
}

function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (d) => chunks.push(d instanceof Buffer ? d : Buffer.from(d)));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

async function downloadBlobBuffer(blobUrl) {
  if (!blobServiceClient || !blobUrl) return null;
  const parsed = parseBlobUrl(blobUrl);
  if (!parsed) return null;
  try {
    const containerClient = blobServiceClient.getContainerClient(parsed.containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(parsed.blobName);
    const dl = await blockBlobClient.download(0);
    return await streamToBuffer(dl.readableStreamBody);
  } catch (e) {
    console.warn('downloadBlobBuffer failed:', e.message);
    return null;
  }
}

module.exports = { downloadBlobBuffer };

const axios = require('axios');
const db = require('../lib/db');
const { extractText } = require('../lib/extractText');
const { extractChunks } = require('../lib/extractChunks');

module.exports = async function (context, message) {
  const { productDocumentId, productId, tenantId, blobUrl, fileName } = message || {};

  if (!productDocumentId) {
    context.log.error('Missing productDocumentId in message:', message);
    return;
  }

  const status = await db.getDocStatus(productDocumentId);
  if (!status) {
    context.log(`Doc ${productDocumentId} no longer exists, dropping`);
    return;
  }
  if (status.ExtractionStatus === 'running' || status.ExtractionStatus === 'completed') {
    context.log(`Doc ${productDocumentId} already ${status.ExtractionStatus}, dropping`);
    return;
  }

  await db.markRunning(productDocumentId);

  try {
    const response = await axios.get(blobUrl, { responseType: 'arraybuffer', timeout: 60_000 });
    const buf = Buffer.from(response.data);
    const mime = response.headers['content-type']
                  || inferMimeFromName(fileName)
                  || 'application/octet-stream';

    const text = await extractText(buf, mime);
    if (!text.trim()) {
      throw new Error('No extractable text in document');
    }

    const { prose, faqs } = await extractChunks(text);
    await db.insertChunks({ productId, tenantId, documentId: productDocumentId, prose, faqs });
    await db.markCompleted(productDocumentId, prose.length + faqs.length);
    context.log(`Doc ${productDocumentId}: extracted ${prose.length} prose + ${faqs.length} faqs`);
  } catch (err) {
    context.log.error(`Doc ${productDocumentId} failed:`, err);
    await db.markFailed(productDocumentId, err);
    throw err;
  }
};

function inferMimeFromName(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.txt')) return 'text/plain';
  return null;
}

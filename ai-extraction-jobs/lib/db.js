const sql = require('mssql');
const crypto = require('crypto');

// CreatedBy on oe.AIChunks has a FK to oe.Users(UserId), so we can't use a synthetic
// sentinel GUID. Set AI_EXTRACTION_USER_ID to a real UserId (typically a system /
// service-account user). Fallback below is the testing-DB TenantAdmin.
const SYSTEM_USER_ID = process.env.AI_EXTRACTION_USER_ID
  || 'BBC6BEC3-0D20-4FD5-B0C3-7E9E82AF124C';

let poolPromise = null;

const getPool = () => {
  if (poolPromise) return poolPromise;
  const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  };
  poolPromise = new sql.ConnectionPool(config).connect();
  return poolPromise;
};

async function getDocStatus(productDocumentId) {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.UniqueIdentifier, productDocumentId)
    .query(`SELECT ExtractionStatus FROM oe.ProductDocuments WHERE ProductDocumentId=@id`);
  return r.recordset[0] || null;
}

async function markRunning(productDocumentId) {
  const pool = await getPool();
  await pool.request()
    .input('id', sql.UniqueIdentifier, productDocumentId)
    .query(`UPDATE oe.ProductDocuments
            SET ExtractionStatus='running',
                ExtractionStartedAt=GETUTCDATE(),
                ExtractionError=NULL
            WHERE ProductDocumentId=@id`);
}

async function markCompleted(productDocumentId, chunkCount) {
  const pool = await getPool();
  await pool.request()
    .input('id', sql.UniqueIdentifier, productDocumentId)
    .input('count', sql.Int, chunkCount)
    .query(`UPDATE oe.ProductDocuments
            SET ExtractionStatus='completed',
                ExtractionCompletedAt=GETUTCDATE(),
                ExtractionChunkCount=@count,
                ExtractionError=NULL
            WHERE ProductDocumentId=@id`);
}

async function markFailed(productDocumentId, err) {
  const pool = await getPool();
  await pool.request()
    .input('id', sql.UniqueIdentifier, productDocumentId)
    .input('err', sql.NVarChar, String(err).slice(0, 2000))
    .query(`UPDATE oe.ProductDocuments
            SET ExtractionStatus='failed',
                ExtractionCompletedAt=GETUTCDATE(),
                ExtractionError=@err
            WHERE ProductDocumentId=@id`);
}

async function insertChunks({ productId, tenantId, documentId, prose, faqs }) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx)
      .input('docId', sql.UniqueIdentifier, documentId)
      .query(`UPDATE oe.AIChunks SET IsActive=0, Status='Inactive'
              WHERE SourceDocumentId=@docId AND Source='ai' AND IsActive=1`);

    for (const p of prose) {
      await new sql.Request(tx)
        .input('id', sql.UniqueIdentifier, crypto.randomUUID())
        .input('productId', sql.UniqueIdentifier, productId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('docId', sql.UniqueIdentifier, documentId)
        .input('text', sql.NVarChar, p.text)
        .input('title', sql.NVarChar, p.title)
        .input('createdBy', sql.UniqueIdentifier, SYSTEM_USER_ID)
        .query(`INSERT INTO oe.AIChunks
                  (AIChunkId, ProductId, TenantId, SystemArea,
                   ChunkText, ChunkType, Source, SourceDocumentId,
                   Title, IsActive, Status, CreatedDate, CreatedBy)
                VALUES
                  (@id, @productId, @tenantId, 'Product',
                   @text, 'prose', 'ai', @docId,
                   @title, 1, 'Active', GETUTCDATE(), @createdBy)`);
    }
    for (const f of faqs) {
      await new sql.Request(tx)
        .input('id', sql.UniqueIdentifier, crypto.randomUUID())
        .input('productId', sql.UniqueIdentifier, productId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('docId', sql.UniqueIdentifier, documentId)
        .input('answer', sql.NVarChar, f.answer)
        .input('question', sql.NVarChar, f.question)
        .input('createdBy', sql.UniqueIdentifier, SYSTEM_USER_ID)
        .query(`INSERT INTO oe.AIChunks
                  (AIChunkId, ProductId, TenantId, SystemArea,
                   ChunkText, ChunkType, Source, SourceDocumentId,
                   Question, IsActive, Status, CreatedDate, CreatedBy)
                VALUES
                  (@id, @productId, @tenantId, 'Product',
                   @answer, 'faq', 'ai', @docId,
                   @question, 1, 'Active', GETUTCDATE(), @createdBy)`);
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

module.exports = { getPool, getDocStatus, markRunning, markCompleted, markFailed, insertChunks };

const express = require('express');
const { getPool, sql } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const router = express.Router({ mergeParams: true });

router.use(authenticate);

const ALLOWED_CHUNK_TYPES = new Set(['prose', 'faq']);

router.post('/:productId/chunks', async (req, res) => {
  try {
    const { productId } = req.params;
    const { chunkType, chunkText, question, title, systemArea = 'Product' } = req.body;
    const { TenantId, UserId } = req.user;

    if (!ALLOWED_CHUNK_TYPES.has(chunkType)) {
      return res.status(400).json({ success: false, message: 'Invalid chunkType' });
    }
    if (chunkType === 'faq' && !question) {
      return res.status(400).json({ success: false, message: 'FAQ chunk requires a question' });
    }
    if (!chunkText || !chunkText.trim()) {
      return res.status(400).json({ success: false, message: 'chunkText is required' });
    }

    const aiChunkId = require('crypto').randomUUID();
    const pool = await getPool();
    await pool.request()
      .input('AIChunkId', sql.UniqueIdentifier, aiChunkId)
      .input('ProductId', sql.UniqueIdentifier, productId)
      .input('TenantId', sql.UniqueIdentifier, TenantId)
      .input('SystemArea', sql.NVarChar, systemArea)
      .input('ChunkText', sql.NVarChar, chunkText)
      .input('ChunkType', sql.NVarChar, chunkType)
      .input('Question', sql.NVarChar, question || null)
      .input('Title', sql.NVarChar, title || null)
      .input('CreatedBy', sql.UniqueIdentifier, UserId)
      .query(`
        INSERT INTO oe.AIChunks
          (AIChunkId, ProductId, TenantId, SystemArea,
           ChunkText, ChunkType, Source, SourceDocumentId,
           Question, Title, IsActive, Status, CreatedDate, CreatedBy)
        VALUES
          (@AIChunkId, @ProductId, @TenantId, @SystemArea,
           @ChunkText, @ChunkType, 'manual', NULL,
           @Question, @Title, 1, 'Active', GETUTCDATE(), @CreatedBy)
      `);

    return res.status(201).json({
      success: true,
      chunk: {
        AIChunkId: aiChunkId,
        ProductId: productId,
        TenantId,
        SystemArea: systemArea,
        ChunkType: chunkType,
        Source: 'manual',
        SourceDocumentId: null,
        Question: question || null,
        Title: title || null,
        ChunkText: chunkText,
      },
    });
  } catch (err) {
    console.error('POST chunk error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/:productId/chunks/:chunkId', async (req, res) => {
  try {
    const { productId, chunkId } = req.params;
    const { chunkText, question, title } = req.body;
    const { TenantId, UserId } = req.user;
    const pool = await getPool();

    const existing = await pool.request()
      .input('AIChunkId', sql.UniqueIdentifier, chunkId)
      .input('ProductId', sql.UniqueIdentifier, productId)
      .input('TenantId', sql.UniqueIdentifier, TenantId)
      .query(`
        SELECT AIChunkId, ProductId, TenantId, SystemArea,
               ChunkType, Source, SourceDocumentId, Question, Title, ChunkText
        FROM oe.AIChunks
        WHERE AIChunkId=@AIChunkId AND ProductId=@ProductId
              AND TenantId=@TenantId AND IsActive=1
      `);
    if (!existing.recordset.length) {
      return res.status(404).json({ success: false, message: 'Chunk not found' });
    }
    const row = existing.recordset[0];

    if (row.Source === 'ai') {
      // Soft-delete the original AI chunk
      await pool.request()
        .input('AIChunkId', sql.UniqueIdentifier, chunkId)
        .query(`UPDATE oe.AIChunks SET IsActive=0, Status='Inactive', ModifiedDate=GETUTCDATE() WHERE AIChunkId=@AIChunkId`);

      // Insert a fresh manual chunk with the edited content
      const newId = require('crypto').randomUUID();
      await pool.request()
        .input('AIChunkId', sql.UniqueIdentifier, newId)
        .input('ProductId', sql.UniqueIdentifier, productId)
        .input('TenantId', sql.UniqueIdentifier, TenantId)
        .input('SystemArea', sql.NVarChar, row.SystemArea)
        .input('ChunkText', sql.NVarChar, chunkText ?? row.ChunkText)
        .input('ChunkType', sql.NVarChar, row.ChunkType)
        .input('Question', sql.NVarChar, question ?? row.Question)
        .input('Title', sql.NVarChar, title ?? row.Title)
        .input('CreatedBy', sql.UniqueIdentifier, UserId)
        .query(`
          INSERT INTO oe.AIChunks
            (AIChunkId, ProductId, TenantId, SystemArea,
             ChunkText, ChunkType, Source, SourceDocumentId,
             Question, Title, IsActive, Status, CreatedDate, CreatedBy)
          VALUES
            (@AIChunkId, @ProductId, @TenantId, @SystemArea,
             @ChunkText, @ChunkType, 'manual', NULL,
             @Question, @Title, 1, 'Active', GETUTCDATE(), @CreatedBy)
        `);

      return res.json({
        success: true,
        chunk: {
          AIChunkId: newId, ProductId: productId, TenantId,
          SystemArea: row.SystemArea, ChunkType: row.ChunkType, Source: 'manual',
          SourceDocumentId: null,
          Question: question ?? row.Question, Title: title ?? row.Title,
          ChunkText: chunkText ?? row.ChunkText,
        },
      });
    }

    // Manual chunk — update in place
    await pool.request()
      .input('AIChunkId', sql.UniqueIdentifier, chunkId)
      .input('ChunkText', sql.NVarChar, chunkText ?? row.ChunkText)
      .input('Question', sql.NVarChar, question ?? row.Question)
      .input('Title', sql.NVarChar, title ?? row.Title)
      .input('ModifiedBy', sql.UniqueIdentifier, UserId)
      .query(`
        UPDATE oe.AIChunks
        SET ChunkText=@ChunkText, Question=@Question, Title=@Title,
            ModifiedBy=@ModifiedBy, ModifiedDate=GETUTCDATE()
        WHERE AIChunkId=@AIChunkId
      `);

    return res.json({
      success: true,
      chunk: {
        AIChunkId: chunkId, ProductId: productId, TenantId,
        SystemArea: row.SystemArea, ChunkType: row.ChunkType, Source: 'manual',
        SourceDocumentId: null,
        Question: question ?? row.Question, Title: title ?? row.Title,
        ChunkText: chunkText ?? row.ChunkText,
      },
    });
  } catch (err) {
    console.error('PUT chunk error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/:productId/chunks/:chunkId', async (req, res) => {
  try {
    const { productId, chunkId } = req.params;
    const { TenantId } = req.user;
    const pool = await getPool();
    await pool.request()
      .input('AIChunkId', sql.UniqueIdentifier, chunkId)
      .input('ProductId', sql.UniqueIdentifier, productId)
      .input('TenantId', sql.UniqueIdentifier, TenantId)
      .query(`UPDATE oe.AIChunks SET IsActive=0, Status='Deleted', ModifiedDate=GETUTCDATE()
              WHERE AIChunkId=@AIChunkId AND ProductId=@ProductId AND TenantId=@TenantId`);
    return res.status(204).end();
  } catch (err) {
    console.error('DELETE chunk error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

const { enqueueExtraction } = require('../services/extractionQueue');

/** Fire-and-forget Service Bus enqueue; marks ProductDocuments failed if send fails. */
async function enqueueExtractionInBackground(pool, opts) {
  try {
    await enqueueExtraction(opts);
  } catch (queueErr) {
    console.warn('[product-chunks] enqueue extraction failed:', queueErr.message);
    try {
      await pool.request()
        .input('ProductDocumentId', sql.UniqueIdentifier, opts.productDocumentId)
        .input('Err', sql.NVarChar, String(queueErr.message || queueErr).slice(0, 2000))
        .query(`UPDATE oe.ProductDocuments
                SET ExtractionStatus='failed', ExtractionError=@Err
                WHERE ProductDocumentId=@ProductDocumentId`);
    } catch (markErr) {
      console.warn('[product-chunks] failed to mark extraction failed:', markErr.message);
    }
  }
}

router.post('/:productId/documents/:documentId/regenerate-chunks', async (req, res) => {
  try {
    const { productId, documentId } = req.params;
    const { TenantId } = req.user;
    const pool = await getPool();

    const docResult = await pool.request()
      .input('ProductDocumentId', sql.UniqueIdentifier, documentId)
      .input('ProductId', sql.UniqueIdentifier, productId)
      .query(`
        SELECT ProductDocumentId, ProductId, DocumentUrl, DisplayName
        FROM oe.ProductDocuments
        WHERE ProductDocumentId=@ProductDocumentId AND ProductId=@ProductId
      `);
    if (!docResult.recordset.length) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }
    const doc = docResult.recordset[0];

    await pool.request()
      .input('ProductDocumentId', sql.UniqueIdentifier, documentId)
      .query(`UPDATE oe.AIChunks SET IsActive=0, Status='Inactive'
              WHERE SourceDocumentId=@ProductDocumentId AND Source='ai' AND IsActive=1`);

    await pool.request()
      .input('ProductDocumentId', sql.UniqueIdentifier, documentId)
      .query(`UPDATE oe.ProductDocuments
              SET ExtractionStatus='queued', ExtractionStartedAt=NULL,
                  ExtractionCompletedAt=NULL, ExtractionError=NULL
              WHERE ProductDocumentId=@ProductDocumentId`);

    void enqueueExtractionInBackground(pool, {
      productDocumentId: documentId,
      productId,
      tenantId: TenantId,
      blobUrl: doc.DocumentUrl,
      fileName: doc.DisplayName,
    });

    return res.status(202).json({ success: true, status: 'queued' });
  } catch (err) {
    console.error('regenerate-chunks error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/:productId/chunks/regenerate-all', async (req, res) => {
  try {
    const { productId } = req.params;
    const { TenantId } = req.user;
    const pool = await getPool();

    await pool.request()
      .input('ProductId', sql.UniqueIdentifier, productId)
      .input('TenantId', sql.UniqueIdentifier, TenantId)
      .query(`UPDATE oe.AIChunks SET IsActive=0, Status='Inactive'
              WHERE ProductId=@ProductId AND TenantId=@TenantId
                    AND Source='ai' AND IsActive=1`);

    const docs = await pool.request()
      .input('ProductId', sql.UniqueIdentifier, productId)
      .query(`SELECT ProductDocumentId, ProductId, DocumentUrl, DisplayName
              FROM oe.ProductDocuments
              WHERE ProductId=@ProductId`);

    for (const doc of docs.recordset) {
      await pool.request()
        .input('ProductDocumentId', sql.UniqueIdentifier, doc.ProductDocumentId)
        .query(`UPDATE oe.ProductDocuments
                SET ExtractionStatus='queued', ExtractionStartedAt=NULL,
                    ExtractionCompletedAt=NULL, ExtractionError=NULL
                WHERE ProductDocumentId=@ProductDocumentId`);
      void enqueueExtractionInBackground(pool, {
        productDocumentId: doc.ProductDocumentId,
        productId,
        tenantId: TenantId,
        blobUrl: doc.DocumentUrl,
        fileName: doc.DisplayName,
      });
    }

    return res.status(202).json({ success: true, queued: docs.recordset.length });
  } catch (err) {
    console.error('regenerate-all error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

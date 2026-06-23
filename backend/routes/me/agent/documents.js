// backend/routes/me/agent/documents.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { v4: uuidv4 } = require('uuid');
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const logger = require('../../../config/logger');
const { generateAuthenticatedUrl, isBlobUrl } = require('../../uploads');

/**
 * @route   GET /api/me/agent/documents
 * @desc    List the current agent's documents (optionally filtered by documentType)
 * @access  Private (Agent only)
 *
 * Query:
 * - documentType (optional) e.g. "W9"
 */
router.get('/', authorize(['Agent']), async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication error: User information is missing.' });
    }

    const requestedType = (req.query.documentType ?? '').toString().trim();
    const normalizedType = requestedType ? requestedType.toUpperCase() : '';

    const pool = await getPool();

    // Resolve current agentId from userId
    const agentResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, req.user.UserId)
      .query(`
        SELECT AgentId
        FROM oe.Agents
        WHERE UserId = @userId
      `);

    if (agentResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const agentId = agentResult.recordset[0].AgentId;

    const request = pool.request();
    request.input('agentId', sql.UniqueIdentifier, agentId);
    if (normalizedType) request.input('docType', sql.NVarChar, normalizedType);

    const docsResult = await request.query(`
      SELECT
        DocumentId,
        AgentId,
        DocumentType,
        FileName,
        FileUrl,
        FileSize,
        FileType,
        Description,
        Status,
        CreatedDate,
        ModifiedDate
      FROM oe.AgentDocuments
      WHERE AgentId = @agentId
        AND Status = 'Active'
        ${normalizedType ? "AND DocumentType = @docType" : ""}
      ORDER BY CreatedDate DESC
    `);

    const docs = await Promise.all((docsResult.recordset || []).map(async (d) => {
      let url = d.FileUrl;
      if (url && isBlobUrl(url)) {
        try {
          url = await generateAuthenticatedUrl(url);
        } catch (e) {
          // fall back to stored URL if SAS generation fails
        }
      }
      return {
        documentId: d.DocumentId,
        documentType: d.DocumentType,
        fileName: d.FileName,
        fileUrl: url,
        fileSize: d.FileSize,
        fileType: d.FileType,
        description: d.Description,
        createdDate: d.CreatedDate,
        modifiedDate: d.ModifiedDate
      };
    }));

    return res.json({ success: true, data: docs });
  } catch (error) {
    logger.error('[AGENT-ME-DOCUMENTS] Error listing documents', { error: error.message, stack: error.stack });
    return res.status(500).json({ success: false, message: 'Failed to fetch documents' });
  }
});

/**
 * @route   POST /api/me/agent/documents
 * @desc    Create/update an agent document record (file upload handled via /api/uploads)
 * @access  Private (Agent only)
 *
 * Body:
 * - documentType (required) e.g. "W9"
 * - fileName (required)
 * - fileUrl (required)
 * - fileSize (optional)
 * - fileType (optional)
 * - description (optional)
 */
router.post('/', authorize(['Agent']), async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication error: User information is missing.' });
    }

    const { documentType, fileName, fileUrl, fileSize, fileType, description } = req.body || {};

    if (!documentType || !fileName || !fileUrl) {
      return res.status(400).json({
        success: false,
        message: 'documentType, fileName, and fileUrl are required'
      });
    }

    const pool = await getPool();

    // Resolve current agentId from userId
    const agentResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, req.user.UserId)
      .query(`
        SELECT AgentId
        FROM oe.Agents
        WHERE UserId = @userId
      `);

    if (agentResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const agentId = agentResult.recordset[0].AgentId;
    const normalizedType = String(documentType).trim().toUpperCase();
    const docId = uuidv4();

    const tx = pool.transaction();
    await tx.begin();
    try {
      // For single-slot docs like W9, inactivate any existing active docs first
      if (normalizedType === 'W9') {
        await tx.request()
          .input('agentId', sql.UniqueIdentifier, agentId)
          .input('docType', sql.NVarChar, normalizedType)
          .input('modifiedBy', sql.UniqueIdentifier, req.user.UserId)
          .query(`
            UPDATE oe.AgentDocuments
            SET Status = 'Inactive',
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @modifiedBy
            WHERE AgentId = @agentId
              AND DocumentType = @docType
              AND Status = 'Active'
          `);
      }

      await tx.request()
        .input('DocumentId', sql.UniqueIdentifier, docId)
        .input('AgentId', sql.UniqueIdentifier, agentId)
        .input('DocumentType', sql.NVarChar, normalizedType)
        .input('FileName', sql.NVarChar, String(fileName))
        .input('FileUrl', sql.NVarChar, String(fileUrl))
        .input('FileSize', sql.Int, Number(fileSize) || 0)
        .input('FileType', sql.NVarChar, String(fileType || ''))
        .input('Description', sql.NVarChar, String(description || ''))
        .input('CreatedBy', sql.UniqueIdentifier, req.user.UserId)
        .query(`
          INSERT INTO oe.AgentDocuments (
            DocumentId, AgentId, DocumentType, FileName, FileUrl,
            FileSize, FileType, Description,
            Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
          ) VALUES (
            @DocumentId, @AgentId, @DocumentType, @FileName, @FileUrl,
            @FileSize, @FileType, @Description,
            'Active', GETUTCDATE(), GETUTCDATE(), @CreatedBy, @CreatedBy
          )
        `);

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    logger.info('[AGENT-ME-DOCUMENTS] Document saved', {
      documentId: docId,
      agentId,
      documentType: normalizedType,
      fileName
    });

    return res.status(201).json({
      success: true,
      data: { documentId: docId },
      message: 'Document saved successfully'
    });
  } catch (error) {
    logger.error('[AGENT-ME-DOCUMENTS] Error saving document', {
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({ success: false, message: 'Failed to save document' });
  }
});

/**
 * @route   DELETE /api/me/agent/documents/w9/:documentId
 * @desc    Soft-delete (inactivate) the current agent's active W9 document
 * @access  Private (Agent only)
 */
router.delete('/w9/:documentId', authorize(['Agent']), async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication error: User information is missing.' });
    }

    const { documentId } = req.params;
    if (!documentId) {
      return res.status(400).json({ success: false, message: 'documentId is required' });
    }

    const pool = await getPool();

    // Resolve current agentId from userId
    const agentResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, req.user.UserId)
      .query(`
        SELECT AgentId
        FROM oe.Agents
        WHERE UserId = @userId
      `);

    if (agentResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const agentId = agentResult.recordset[0].AgentId;

    const deleteResult = await pool.request()
      .input('documentId', sql.UniqueIdentifier, documentId)
      .input('agentId', sql.UniqueIdentifier, agentId)
      .input('modifiedBy', sql.UniqueIdentifier, req.user.UserId)
      .query(`
        UPDATE oe.AgentDocuments
        SET Status = 'Inactive',
            ModifiedDate = GETUTCDATE(),
            ModifiedBy = @modifiedBy
        WHERE DocumentId = @documentId
          AND AgentId = @agentId
          AND DocumentType = 'W9'
          AND Status = 'Active'
      `);

    if (!deleteResult.rowsAffected || deleteResult.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, message: 'Active W9 document not found' });
    }

    logger.info('[AGENT-ME-DOCUMENTS] W9 document inactivated', {
      documentId,
      agentId
    });

    return res.json({ success: true, message: 'W9 document deleted' });
  } catch (error) {
    logger.error('[AGENT-ME-DOCUMENTS] Error deleting W9 document', {
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({ success: false, message: 'Failed to delete W9 document' });
  }
});

module.exports = router;


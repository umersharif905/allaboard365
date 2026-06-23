// backend/routes/ai-commission-rule-assistant.js
// Authenticated AI assistant for tiered commission rule configuration.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { authenticate, getUserRoles } = require('../middleware/auth');
const aiCommissionRuleAssistant = require('../services/aiCommissionRuleAssistant.service');
const { getPool } = require('../config/database');
const sql = require('mssql');
const { MAX_UPLOAD_FILE_BYTES } = require('../constants/uploadLimits');
const {
  wantsAiAssistantStream,
  createAiAssistantSseWriter,
} = require('../utils/aiAssistantSse');

const authorize = (allowedRoles) => {
  return (req, res, next) => {
    const userRoles = getUserRoles(req.user);
    if (!allowedRoles.some((role) => userRoles.includes(role))) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
        required: allowedRoles,
        current: userRoles,
      });
    }
    next();
  };
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/ai-temp');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_FILE_BYTES,
    files: 5,
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'text/plain',
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not supported.`));
    }
  },
});

async function unlinkSafe(filePath) {
  try {
    await fsPromises.unlink(filePath);
  } catch {
    // ignore
  }
}

/**
 * GET /api/ai/commission-rule-assistant/status
 */
router.get('/commission-rule-assistant/status', authenticate, (req, res) => {
  return res.json({
    success: true,
    available: Boolean(process.env.OPENAI_API_KEY),
  });
});

/**
 * POST /api/ai/commission-rule-assistant/turn
 */
router.post(
  '/commission-rule-assistant/turn',
  authenticate,
  authorize(['SysAdmin', 'TenantAdmin', 'Agent']),
  upload.array('files', 5),
  async (req, res) => {
    const uploadedPaths = (req.files || []).map((f) => f.path);

    try {
      let history = [];
      try {
        history = req.body.history ? JSON.parse(req.body.history) : [];
      } catch {
        history = [];
      }

      let formSnapshot = {};
      try {
        formSnapshot = req.body.formSnapshot ? JSON.parse(req.body.formSnapshot) : {};
      } catch {
        formSnapshot = {};
      }

      let tenantTierLevels = [];
      try {
        tenantTierLevels = req.body.tenantTierLevels ? JSON.parse(req.body.tenantTierLevels) : [];
      } catch {
        tenantTierLevels = [];
      }

      const prompt = typeof req.body.prompt === 'string' ? req.body.prompt : '';
      const sessionGridExtract =
        typeof req.body.sessionGridExtract === 'string' ? req.body.sessionGridExtract : '';
      const refreshGridExtract = req.body.refreshGridExtract === '1' || req.body.refreshGridExtract === 'true';

      if (!prompt.trim() && uploadedPaths.length === 0 && !sessionGridExtract.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Provide a prompt and/or at least one file.',
        });
      }

      if (!process.env.OPENAI_API_KEY) {
        return res.status(503).json({
          success: false,
          message: 'AI assist is not configured (missing OPENAI_API_KEY).',
        });
      }

      const turnParams = {
        messages: history,
        formSnapshot,
        tenantTierLevels,
        attachmentPaths: uploadedPaths,
        prompt,
        sessionGridExtract,
        refreshGridExtract,
      };

      if (wantsAiAssistantStream(req)) {
        const sse = createAiAssistantSseWriter(res);
        try {
          const { reply, attachmentSummaries, sessionGridExtract: gridOut } =
            await aiCommissionRuleAssistant.runTurn({
              ...turnParams,
              onStreamDelta: (text) => sse.delta(text),
            });
          sse.complete({
            success: true,
            reply,
            attachmentSummaries,
            sessionGridExtract: gridOut,
          });
        } catch (err) {
          console.error('[commission-rule-assistant] turn stream error:', err);
          sse.error(err.message || 'Assistant request failed');
        }
        return;
      }

      const { reply, attachmentSummaries, sessionGridExtract: gridOut } =
        await aiCommissionRuleAssistant.runTurn(turnParams);

      return res.json({
        success: true,
        reply,
        attachmentSummaries,
        sessionGridExtract: gridOut,
      });
    } catch (err) {
      console.error('[commission-rule-assistant] turn error:', err);
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: err.message || 'Assistant request failed',
        });
      }
    } finally {
      for (const p of uploadedPaths) {
        await unlinkSafe(p);
      }
    }
  }
);

/**
 * POST /api/ai/commission-rule-assistant/group-turn
 * Multi-rule proposals for one commission group (validated server-side).
 */
router.post(
  '/commission-rule-assistant/group-turn',
  authenticate,
  authorize(['SysAdmin', 'TenantAdmin']),
  upload.array('files', 5),
  async (req, res) => {
    const uploadedPaths = (req.files || []).map((f) => f.path);

    try {
      let history = [];
      try {
        history = req.body.history ? JSON.parse(req.body.history) : [];
      } catch {
        history = [];
      }

      let tenantTierLevels = [];
      try {
        tenantTierLevels = req.body.tenantTierLevels ? JSON.parse(req.body.tenantTierLevels) : [];
      } catch {
        tenantTierLevels = [];
      }

      let rulesCatalog = [];
      try {
        rulesCatalog = req.body.rulesCatalog ? JSON.parse(req.body.rulesCatalog) : [];
      } catch {
        rulesCatalog = [];
      }

      const commissionGroupId =
        typeof req.body.commissionGroupId === 'string' ? req.body.commissionGroupId.trim() : '';
      const prompt = typeof req.body.prompt === 'string' ? req.body.prompt : '';
      const sessionGridExtract =
        typeof req.body.sessionGridExtract === 'string' ? req.body.sessionGridExtract : '';
      const refreshGridExtract = req.body.refreshGridExtract === '1' || req.body.refreshGridExtract === 'true';

      if (!commissionGroupId) {
        return res.status(400).json({ success: false, message: 'commissionGroupId is required.' });
      }
      if (!Array.isArray(rulesCatalog) || rulesCatalog.length === 0) {
        return res.status(400).json({ success: false, message: 'rulesCatalog must be a non-empty array.' });
      }

      const tenantId = req.tenantId || req.user?.TenantId;
      if (!tenantId) {
        return res.status(400).json({ success: false, message: 'tenantId not found for request.' });
      }

      const pool = await getPool();
      const gc = await pool
        .request()
        .input('CommissionGroupId', sql.UniqueIdentifier, commissionGroupId)
        .input('TenantId', sql.UniqueIdentifier, tenantId)
        .query(
          `SELECT CommissionGroupId FROM oe.CommissionGroups WHERE CommissionGroupId = @CommissionGroupId AND TenantId = @TenantId`
        );

      if (gc.recordset.length === 0) {
        return res.status(404).json({ success: false, message: 'Commission group not found or access denied.' });
      }

      const inGroupRes = await pool
        .request()
        .input('CommissionGroupId', sql.UniqueIdentifier, commissionGroupId)
        .query(`SELECT RuleId FROM oe.CommissionGroupRules WHERE CommissionGroupId = @CommissionGroupId`);

      const inGroup = new Set(inGroupRes.recordset.map((r) => String(r.RuleId).toLowerCase()));

      for (const row of rulesCatalog) {
        const rid = typeof row.ruleId === 'string' ? row.ruleId.trim().toLowerCase() : '';
        if (!rid || !inGroup.has(rid)) {
          return res.status(400).json({
            success: false,
            message: 'rulesCatalog contains a rule that is not in this commission group.',
          });
        }
      }

      const patchable = rulesCatalog.filter((r) => r.commissionType === 'Tiered');
      if (patchable.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No Tiered rules in catalog.',
        });
      }

      if (!prompt.trim() && uploadedPaths.length === 0 && !sessionGridExtract.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Provide a prompt and/or at least one file.',
        });
      }

      if (!process.env.OPENAI_API_KEY) {
        return res.status(503).json({
          success: false,
          message: 'AI assist is not configured (missing OPENAI_API_KEY).',
        });
      }

      const turnParams = {
        messages: history,
        rulesCatalog,
        tenantTierLevels,
        attachmentPaths: uploadedPaths,
        prompt,
        sessionGridExtract,
        refreshGridExtract,
      };

      if (wantsAiAssistantStream(req)) {
        const sse = createAiAssistantSseWriter(res);
        try {
          const { reply, attachmentSummaries, sessionGridExtract: gridOut } =
            await aiCommissionRuleAssistant.runGroupTurn({
              ...turnParams,
              onStreamDelta: (text) => sse.delta(text),
            });
          sse.complete({
            success: true,
            reply,
            attachmentSummaries,
            sessionGridExtract: gridOut,
          });
        } catch (err) {
          console.error('[commission-rule-assistant] group-turn stream error:', err);
          sse.error(err.message || 'Assistant request failed');
        }
        return;
      }

      const { reply, attachmentSummaries, sessionGridExtract: gridOut } =
        await aiCommissionRuleAssistant.runGroupTurn(turnParams);

      return res.json({
        success: true,
        reply,
        attachmentSummaries,
        sessionGridExtract: gridOut,
      });
    } catch (err) {
      console.error('[commission-rule-assistant] group-turn error:', err);
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: err.message || 'Assistant request failed',
        });
      }
    } finally {
      for (const p of uploadedPaths) {
        await unlinkSafe(p);
      }
    }
  }
);

module.exports = router;

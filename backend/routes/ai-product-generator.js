// backend/routes/ai-product-generator.js
// API endpoint for AI-powered product generation

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticate, getUserRoles } = require('../middleware/auth');
const requireTenantAccess = require('../middleware/requireTenantAccess');
const aiProductGenerator = require('../services/aiProductGenerator.service');
const aiProductAssistant = require('../services/aiProductAssistant.service');
const aiEligibilityFormatAssistant = require('../services/aiEligibilityFormatAssistant.service');
const aiProductLogoGenerator = require('../services/aiProductLogoGenerator.service');
const aiPlanDetailsGenerator = require('../services/aiPlanDetailsGenerator.service');
const { MAX_UPLOAD_FILE_BYTES } = require('../constants/uploadLimits');
const fsPromises = require('fs').promises;
const {
  wantsAiAssistantStream,
  createAiAssistantSseWriter,
} = require('../utils/aiAssistantSse');

// Authorization middleware
const authorize = (allowedRoles) => {
  return (req, res, next) => {
    const userRoles = getUserRoles(req.user);
    if (!allowedRoles.some(role => userRoles.includes(role))) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
        required: allowedRoles,
        current: userRoles
      });
    }
    next();
  };
};

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/ai-temp');
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_UPLOAD_FILE_BYTES,
    files: 20 // Maximum 20 files
  },
  fileFilter: (req, file, cb) => {
    // Allowed file types
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
      'text/plain'
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not supported. Allowed types: PDF, Excel, CSV, Word, Images, Text`));
    }
  }
});

/**
 * GET /api/ai/temp-file/:filename
 * Serve temporary AI files for preview
 * No authentication required for temporary files during product creation
 */
router.get('/temp-file/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, '../uploads/ai-temp', filename);
    
    console.log('🔍 Looking for temp file:', {
      filename,
      filePath,
      exists: fs.existsSync(filePath)
    });
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      // List available files for debugging
      const tempDir = path.join(__dirname, '../uploads/ai-temp');
      const files = fs.existsSync(tempDir) ? fs.readdirSync(tempDir) : [];
      console.log('📁 Available temp files:', files);
      
      return res.status(404).json({ 
        success: false, 
        message: 'File not found',
        availableFiles: files
      });
    }
    
    // Set appropriate headers
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.csv': 'text/csv'
    };
    
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', 'inline');
    
    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    
  } catch (error) {
    console.error('Error serving temp file:', error);
    res.status(500).json({ success: false, message: 'Error serving file' });
  }
});

/**
 * POST /api/ai/generate-product
 * Generate product data using AI from text and/or documents
 */
router.post(
  '/generate-product',
  authenticate,
  authorize(['SysAdmin', 'TenantAdmin']),
  upload.array('files', 20),
  async (req, res) => {
    try {
      console.log('📥 AI Product Generation Request Received');
      console.log('User:', req.user.UserId, req.user.Email);
      console.log('Text Input:', req.body.textInput ? 'Yes' : 'No');
      console.log('Files:', req.files ? req.files.length : 0);

      const { textInput, vendorId, productOwnerId } = req.body;
      const files = req.files;

      // Validate required fields
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: 'vendorId is required'
        });
      }

      if (!productOwnerId) {
        return res.status(400).json({
          success: false,
          message: 'productOwnerId is required'
        });
      }

      if (!textInput && (!files || files.length === 0)) {
        return res.status(400).json({
          success: false,
          message: 'Either text input or files must be provided'
        });
      }

      // Generate product using AI
      const result = await aiProductGenerator.generateProduct({
        textInput,
        files,
        vendorId,
        productOwnerId
      });

      if (!result.success) {
        return res.status(400).json({
          success: false,
          message: result.error || 'Failed to generate product',
          validationErrors: result.validationErrors,
          attempts: result.attempts
        });
      }

      console.log(`✅ Product generated successfully in ${result.attempts} attempt(s)`);

      res.json({
        success: true,
        data: result.data,
        attempts: result.attempts,
        message: `Product generated successfully in ${result.attempts} attempt(s)`
      });

    } catch (error) {
      console.error('❌ Error in AI product generation endpoint:', error);
      
      // Clean up any uploaded files
      if (req.files) {
        req.files.forEach(file => {
          try {
            fs.unlinkSync(file.path);
          } catch (err) {
            console.error('Error deleting file:', err);
          }
        });
      }

      res.status(500).json({
        success: false,
        message: 'Failed to generate product',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      });
    }
  }
);

async function unlinkSafe(filePath) {
  try {
    await fsPromises.unlink(filePath);
  } catch {
    // ignore
  }
}

/**
 * GET /api/ai/product-assistant/status
 */
router.get(
  '/product-assistant/status',
  authenticate,
  authorize(['SysAdmin', 'TenantAdmin']),
  (req, res) => {
    res.json({
      success: true,
      available: Boolean(process.env.OPENAI_API_KEY),
    });
  }
);

/**
 * POST /api/ai/product-assistant/turn
 */
router.post(
  '/product-assistant/turn',
  authenticate,
  authorize(['SysAdmin', 'TenantAdmin']),
  requireTenantAccess,
  upload.array('files', 20),
  async (req, res) => {
    const uploadedPaths = (req.files || []).map((f) => f.path);
    req.setTimeout(180000);
    res.setTimeout(180000);

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

      const prompt = req.body.prompt || '';
      const sessionDocExtract = req.body.sessionDocExtract || '';
      const refreshDocExtract =
        req.body.refreshDocExtract === '1' || req.body.refreshDocExtract === 'true';

      const userRoles = getUserRoles(req.user);
      const isTenantAdmin = userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin');
      const activeTenantId = req.tenantId || req.user.TenantId;
      if (isTenantAdmin && activeTenantId) {
        const ownerId = formSnapshot.productOwnerId;
        if (ownerId && String(ownerId).toLowerCase() !== String(activeTenantId).toLowerCase()) {
          return res.status(403).json({
            success: false,
            message: 'Product owner does not match your tenant',
          });
        }
      }

      const turnParams = {
        messages: history,
        formSnapshot,
        attachmentPaths: uploadedPaths,
        prompt,
        sessionDocExtract,
        refreshDocExtract,
      };

      if (wantsAiAssistantStream(req)) {
        const sse = createAiAssistantSseWriter(res);
        try {
          const result = await aiProductAssistant.runTurn({
            ...turnParams,
            onStreamDelta: (text) => sse.delta(text),
          });
          sse.complete({
            success: true,
            reply: result.reply,
            sessionDocExtract: result.sessionDocExtract,
            attachmentSummaries: result.attachmentSummaries,
          });
        } catch (error) {
          console.error('❌ product-assistant/turn (stream):', error);
          sse.error(error.message || 'Assistant turn failed');
        }
        return;
      }

      const result = await aiProductAssistant.runTurn(turnParams);

      res.json({
        success: true,
        reply: result.reply,
        sessionDocExtract: result.sessionDocExtract,
        attachmentSummaries: result.attachmentSummaries,
      });
    } catch (error) {
      console.error('❌ product-assistant/turn:', error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: error.message || 'Assistant turn failed',
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
 * GET /api/ai/eligibility-format-assistant/status
 */
router.get(
  '/eligibility-format-assistant/status',
  authenticate,
  authorize(['SysAdmin', 'TenantAdmin', 'VendorAdmin']),
  (req, res) => {
    res.json({
      success: true,
      available: Boolean(process.env.OPENAI_API_KEY),
    });
  }
);

/**
 * POST /api/ai/eligibility-format-assistant/turn
 */
router.post(
  '/eligibility-format-assistant/turn',
  authenticate,
  authorize(['SysAdmin', 'TenantAdmin', 'VendorAdmin']),
  upload.array('files', 20),
  async (req, res) => {
    const uploadedPaths = (req.files || []).map((f) => f.path);
    req.setTimeout(180000);
    res.setTimeout(180000);

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

      const vendorId = req.body.vendorId || formSnapshot.vendorId;
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: 'vendorId is required',
        });
      }

      const userRoles = getUserRoles(req.user);
      if (userRoles.includes('VendorAdmin') && !userRoles.includes('SysAdmin')) {
        const userVendorId = req.user?.VendorId ? String(req.user.VendorId).toLowerCase() : null;
        if (!userVendorId || String(vendorId).toLowerCase() !== userVendorId) {
          return res.status(403).json({ success: false, message: 'Cannot edit another vendor\'s format' });
        }
      }

      const prompt = req.body.prompt || '';
      const sessionDocExtract = req.body.sessionDocExtract || '';
      const refreshDocExtract =
        req.body.refreshDocExtract === '1' || req.body.refreshDocExtract === 'true';

      const turnParams = {
        messages: history,
        formSnapshot: { ...formSnapshot, vendorId },
        attachmentPaths: uploadedPaths,
        prompt,
        sessionDocExtract,
        refreshDocExtract,
      };

      if (wantsAiAssistantStream(req)) {
        const sse = createAiAssistantSseWriter(res);
        try {
          const result = await aiEligibilityFormatAssistant.runTurn({
            ...turnParams,
            onStreamDelta: (text) => sse.delta(text),
          });
          sse.complete({
            success: true,
            reply: result.reply,
            sessionDocExtract: result.sessionDocExtract,
            attachmentSummaries: result.attachmentSummaries,
          });
        } catch (error) {
          console.error('❌ eligibility-format-assistant/turn (stream):', error);
          sse.error(error.message || 'Assistant turn failed');
        }
        return;
      }

      const result = await aiEligibilityFormatAssistant.runTurn(turnParams);

      res.json({
        success: true,
        reply: result.reply,
        sessionDocExtract: result.sessionDocExtract,
        attachmentSummaries: result.attachmentSummaries,
      });
    } catch (error) {
      console.error('❌ eligibility-format-assistant/turn:', error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: error.message || 'Assistant turn failed',
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
 * GET /api/ai/generate-product-logo/status
 */
router.get(
  '/generate-product-logo/status',
  authenticate,
  authorize(['SysAdmin', 'TenantAdmin', 'VendorAdmin']),
  (req, res) => {
    res.json({
      success: true,
      available: aiProductLogoGenerator.isAvailable(),
    });
  }
);

/**
 * POST /api/ai/generate-product-logo
 */
router.post(
  '/generate-product-logo',
  authenticate,
  authorize(['SysAdmin', 'TenantAdmin', 'VendorAdmin']),
  async (req, res) => {
    req.setTimeout(120000);
    res.setTimeout(120000);

    try {
      if (!aiProductLogoGenerator.isAvailable()) {
        return res.status(503).json({
          success: false,
          message: 'AI image generation is not configured',
        });
      }

      const { prompt, productName, productType, description } = req.body || {};

      const result = await aiProductLogoGenerator.generateLogo({
        prompt,
        productName,
        productType,
        description,
      });

      res.json({
        success: true,
        imageUrl: result.imageUrl,
        imageBase64: result.imageBase64,
        filename: result.filename,
        mimeType: result.mimeType,
      });
    } catch (error) {
      console.error('❌ generate-product-logo:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to generate logo',
      });
    }
  }
);

/**
 * GET /api/ai/generate-plan-details/status
 */
router.get(
  '/generate-plan-details/status',
  authenticate,
  authorize(['SysAdmin', 'TenantAdmin']),
  (req, res) => {
    res.json({
      success: true,
      available: aiPlanDetailsGenerator.isAvailable(),
    });
  }
);

/**
 * POST /api/ai/generate-plan-details
 * Multipart: files[] (existing/pending/generation-only docs). Body: productName, productType, description, existingPlanDetails (JSON string)
 */
router.post(
  '/generate-plan-details',
  authenticate,
  authorize(['SysAdmin', 'TenantAdmin']),
  upload.array('files', 10),
  async (req, res) => {
    req.setTimeout(300000);
    res.setTimeout(300000);
    const uploadedPaths = (req.files || []).map((f) => f.path);

    try {
      if (!aiPlanDetailsGenerator.isAvailable()) {
        return res.status(503).json({
          success: false,
          message: 'AI plan details generation is not configured',
        });
      }

      const files = req.files || [];
      if (!files.length) {
        return res.status(400).json({
          success: false,
          message: 'Select at least one document',
        });
      }

      let existingPlanDetails = null;
      if (req.body.existingPlanDetails) {
        try {
          existingPlanDetails = JSON.parse(req.body.existingPlanDetails);
        } catch {
          existingPlanDetails = null;
        }
      }

      const result = await aiPlanDetailsGenerator.generateFromDocuments({
        files,
        productName: req.body.productName || '',
        productType: req.body.productType || '',
        description: req.body.description || '',
        existingPlanDetails,
      });

      res.json({
        success: true,
        planDetailsData: result.planDetailsData,
        sectionCount: result.sectionCount,
        sourceFiles: result.sourceFiles,
      });
    } catch (error) {
      console.error('❌ generate-plan-details:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to generate plan details',
      });
    } finally {
      for (const p of uploadedPaths) {
        await unlinkSafe(p);
      }
    }
  }
);

/**
 * GET /api/ai/generation-status
 * Check if AI generation is available (OpenAI configured)
 */
router.get('/generation-status', authenticate, async (req, res) => {
  try {
    const isConfigured = !!process.env.OPENAI_API_KEY;
    
    res.json({
      success: true,
      available: isConfigured,
      message: isConfigured 
        ? 'AI product generation is available' 
        : 'OpenAI API key not configured'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to check AI status'
    });
  }
});

/**
 * POST /api/ai/cleanup-temp-files
 * Clean up temporary AI files after product creation
 */
router.post('/cleanup-temp-files', authenticate, (req, res) => {
  try {
    const tempDir = path.join(__dirname, '../uploads/ai-temp');
    
    if (!fs.existsSync(tempDir)) {
      return res.json({ success: true, message: 'No temp directory to clean' });
    }
    
    const files = fs.readdirSync(tempDir);
    let cleanedCount = 0;
    
    files.forEach(file => {
      try {
        const filePath = path.join(tempDir, file);
        fs.unlinkSync(filePath);
        cleanedCount++;
        console.log(`🗑️ Cleaned up temp file: ${file}`);
      } catch (error) {
        console.error(`Failed to delete temp file ${file}:`, error);
      }
    });
    
    res.json({ 
      success: true, 
      message: `Cleaned up ${cleanedCount} temporary files`,
      cleanedCount 
    });
    
  } catch (error) {
    console.error('Error cleaning up temp files:', error);
    res.status(500).json({ success: false, message: 'Error cleaning up files' });
  }
});

module.exports = router;


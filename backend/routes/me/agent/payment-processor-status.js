// backend/routes/me/agent/payment-processor-status.js
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');

/**
 * @route   GET /api/me/agent/payment-processor-status
 * @desc    Check if tenant has payment processor API token configured
 * @access  Private (Agent)
 */
router.get('/', authorize(['Agent']), async (req, res) => {
  try {
    const userId = req.user?.UserId;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    const pool = await getPool();

    // Get agent's tenant ID
    const agentRequest = pool.request();
    agentRequest.input('UserId', sql.UniqueIdentifier, userId);
    const agentResult = await agentRequest.query(`
      SELECT a.TenantId
      FROM oe.Agents a
      WHERE a.UserId = @UserId AND a.Status = 'Active'
    `);

    if (agentResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }

    const tenantId = agentResult.recordset[0].TenantId;
    if (!tenantId) {
      return res.json({
        success: true,
        data: { hasApiToken: false }
      });
    }

    // Check if tenant has payment processor API token configured
    // PaymentProcessorSettings is stored as JSON in oe.Tenants table
    const checkRequest = pool.request();
    checkRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
    const checkResult = await checkRequest.query(`
      SELECT 
        t.PaymentProcessorSettings,
        t.Name as TenantName
      FROM oe.Tenants t
      WHERE t.TenantId = @TenantId
    `);

    if (checkResult.recordset.length === 0) {
      return res.json({
        success: true,
        data: { hasApiToken: false }
      });
    }

    const paymentSettingsJson = checkResult.recordset[0].PaymentProcessorSettings;
    let hasApiToken = false;
    let processorName = null;

    if (paymentSettingsJson) {
      try {
        const paymentSettings = JSON.parse(paymentSettingsJson);
        processorName = paymentSettings.activeProcessor || null;
        
        // Check if there's an active processor with credentials
        if (paymentSettings.activeProcessor && paymentSettings.processors) {
          const activeProcessor = paymentSettings.processors[paymentSettings.activeProcessor];
          
          if (activeProcessor) {
            // Check for DIME (OpenEnroll) processor
            if (paymentSettings.activeProcessor === 'openenroll' && activeProcessor.dime) {
              const dime = activeProcessor.dime;
              // Check if API token exists and is not empty
              hasApiToken = !!(dime.apiTokenEncrypted && dime.apiTokenEncrypted.trim() !== '') || 
                           !!(dime.apiToken && dime.apiToken.trim() !== '');
            }
            // Add checks for other processors here if needed
            // For example: Stripe, PayPal, etc.
          }
        }
      } catch (parseError) {
        console.error('Error parsing PaymentProcessorSettings:', parseError);
        hasApiToken = false;
      }
    }

    return res.json({
      success: true,
      data: {
        hasApiToken,
        processorName: processorName || undefined
      }
    });
  } catch (error) {
    console.error('Error checking payment processor status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to check payment processor status'
    });
  }
});

module.exports = router;


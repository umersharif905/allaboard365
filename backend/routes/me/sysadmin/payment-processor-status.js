// backend/routes/me/sysadmin/payment-processor-status.js
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');

/**
 * @route   GET /api/me/sysadmin/payment-processor-status
 * @desc    Check if tenant has payment processor API token configured
 * @access  Private (SysAdmin)
 */
router.get('/', authorize(['SysAdmin']), async (req, res) => {
  try {
    const tenantId = req.query.tenantId;
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'Tenant ID is required'
      });
    }

    const pool = await getPool();

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


// backend/routes/me/agent/commission-rules.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const logger = require('../../../config/logger');

/**
 * @route   GET /api/me/agent/commission-rules
 * @desc    Get tier-based commission rules for agents (filtered to EntityType = 'Tier')
 * @access  Private (Agent only)
 */
router.get('/', authorize(['Agent']), async (req, res) => {
  try {
    const { productId, status } = req.query;
    
    const pool = await getPool();
    const request = pool.request();
    
    let whereClause = 'WHERE cr.EntityType = \'Tier\''; // Only tier-based rules for agents
    
    // Apply tenant filter
    request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    whereClause += ' AND (cr.TenantId = @TenantId OR cr.TenantId IS NULL)';
    
    if (status) {
      request.input('Status', sql.NVarChar(20), status);
      whereClause += ' AND cr.Status = @Status';
    } else {
      // Default to active rules only
      whereClause += ' AND cr.Status = \'Active\'';
    }
    
    if (productId) {
      request.input('ProductId', sql.UniqueIdentifier, productId);
      whereClause += ' AND cr.ProductId = @ProductId';
    }
    
    const result = await request.query(`
      SELECT 
        cr.RuleId,
        cr.RuleName,
        cr.ProductId,
        p.Name as ProductName,
        cr.EntityType,
        cr.EntityId,
        cr.TierLevel,
        cr.CommissionType,
        cr.CommissionRate,
        cr.FlatAmount,
        cr.TieredRates,
        cr.CommissionJson,
        cr.PaymentTiming,
        cr.YearlySchedule,
        cr.MinimumPremium,
        cr.MaximumPremium,
        cr.EffectiveDate,
        cr.TerminationDate,
        cr.Priority,
        cr.Status,
        cr.TenantId,
        CASE 
          WHEN cr.TenantId IS NULL THEN 'Global'
          ELSE t.Name
        END as TenantName,
        CASE 
          WHEN cr.TenantId IS NULL THEN 1
          ELSE 0
        END as IsGlobal,
        cr.CreatedDate,
        cr.ModifiedDate,
        cr.CreatedBy,
        cr.ModifiedBy
      FROM oe.CommissionRules cr
      LEFT JOIN oe.Products p ON cr.ProductId = p.ProductId
      LEFT JOIN oe.Tenants t ON cr.TenantId = t.TenantId
      ${whereClause}
      ORDER BY cr.Priority, cr.EffectiveDate DESC
    `);
    
    logger.info(`[AGENT-COMMISSION-RULES] Found ${result.recordset.length} tier-based rules for agent`);
    
    res.json({
      success: true,
      rules: result.recordset
    });
    
  } catch (error) {
    logger.error('[AGENT-COMMISSION-RULES] Error fetching commission rules:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch commission rules' 
    });
  }
});

module.exports = router;


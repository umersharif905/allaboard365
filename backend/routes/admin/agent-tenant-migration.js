const express = require('express');
const router = express.Router({ mergeParams: true });
const { getUserRoles } = require('../../middleware/auth');
const {
  buildAgentTenantMigrationPreview,
  executeAgentTenantMigration
} = require('../../services/agentTenantMigration.service');

const authorizeSysAdmin = (req, res, next) => {
  const roles = getUserRoles(req.user);
  if (!roles.includes('SysAdmin')) {
    return res.status(403).json({ success: false, message: 'SysAdmin access required' });
  }
  next();
};

router.use(authorizeSysAdmin);

/**
 * POST /api/admin/agents/:agentId/tenant-migration/preview
 */
router.post('/:agentId/tenant-migration/preview', async (req, res) => {
  try {
    const {
      targetTenantId,
      targetAgencyId,
      targetParentAgentId,
      targetCommissionLevelId
    } = req.body || {};
    if (!targetTenantId) {
      return res.status(400).json({ success: false, message: 'targetTenantId is required' });
    }
    const result = await buildAgentTenantMigrationPreview({
      agentId: req.params.agentId,
      targetTenantId,
      targetAgencyId: targetAgencyId || null,
      targetParentAgentId: targetParentAgentId || null,
      targetCommissionLevelId: targetCommissionLevelId || null
    });
    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.message });
    }
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('agent tenant migration preview:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to build migration preview'
    });
  }
});

/**
 * POST /api/admin/agents/:agentId/tenant-migration/execute
 */
router.post('/:agentId/tenant-migration/execute', async (req, res) => {
  try {
    const {
      targetTenantId,
      targetAgencyId,
      targetParentAgentId,
      targetCommissionLevelId
    } = req.body || {};
    if (!targetTenantId) {
      return res.status(400).json({ success: false, message: 'targetTenantId is required' });
    }
    if (!targetAgencyId) {
      return res.status(400).json({ success: false, message: 'targetAgencyId is required' });
    }
    if (!targetCommissionLevelId) {
      return res.status(400).json({ success: false, message: 'targetCommissionLevelId is required' });
    }
    const result = await executeAgentTenantMigration({
      agentId: req.params.agentId,
      targetTenantId,
      targetAgencyId,
      targetParentAgentId: targetParentAgentId || null,
      targetCommissionLevelId,
      executedBy: req.user?.UserId || null
    });
    if (!result.ok) {
      return res.status(400).json({
        success: false,
        message: result.message,
        blockingProducts: result.blockingProducts,
        data: result
      });
    }
    return res.json({ success: true, data: result, message: result.message });
  } catch (error) {
    console.error('agent tenant migration execute:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to execute migration'
    });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const requireTenantAccess = require('../../middleware/requireTenantAccess');
const { getUserRoles } = require('../../middleware/auth');
const clawbackBalances = require('../../services/clawbackBalances.service');

const authorize = (allowedRoles) => (req, res, next) => {
  const userRoles = getUserRoles(req.user);
  if (!allowedRoles.some((role) => userRoles.includes(role))) {
    return res.status(403).json({
      success: false,
      message: 'Insufficient permissions',
      required: allowedRoles,
      current: userRoles
    });
  }
  next();
};

/**
 * GET /api/accounting/clawback-balances/commissions
 * Query: entityType=Agent|Agency, entityId
 *
 * Returns the pending negative oe.Commissions rows that make up this
 * recipient's commission clawback balance, paired with the source refund.
 */
router.get(
  '/clawback-balances/commissions',
  authorize(['SysAdmin', 'TenantAdmin']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const tenantId = req.tenantId || req.user?.TenantId;
      if (!tenantId) {
        return res.status(400).json({ success: false, message: 'Tenant context missing' });
      }
      const { entityType, entityId } = req.query;
      if (!entityType || !entityId) {
        return res
          .status(400)
          .json({ success: false, message: 'entityType and entityId are required' });
      }
      if (entityType !== 'Agent' && entityType !== 'Agency') {
        return res
          .status(400)
          .json({ success: false, message: "entityType must be 'Agent' or 'Agency'" });
      }

      const items = await clawbackBalances.getCommissionClawbackDetails({
        tenantId,
        entityType,
        entityId
      });
      const total = items.reduce((s, i) => s + Number(i.amount || 0), 0);
      return res.json({
        success: true,
        data: {
          totalPending: Math.round(total * 100) / 100,
          count: items.length,
          items
        }
      });
    } catch (e) {
      console.error('clawback-balances/commissions failed:', e);
      return res
        .status(500)
        .json({ success: false, message: e.message || 'Failed to load commission clawback details' });
    }
  }
);

/**
 * GET /api/accounting/clawback-balances/payouts
 * Query: payoutType=Vendor|TenantOverride, recipientEntityId
 *
 * Returns the pending oe.PayoutClawbacks rows (Available / PartiallyApplied
 * with RemainingAmount > 0) for this recipient, paired with the source
 * refund.
 */
router.get(
  '/clawback-balances/payouts',
  authorize(['SysAdmin', 'TenantAdmin']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const tenantId = req.tenantId || req.user?.TenantId;
      if (!tenantId) {
        return res.status(400).json({ success: false, message: 'Tenant context missing' });
      }
      const { payoutType, recipientEntityId } = req.query;
      if (!payoutType || !recipientEntityId) {
        return res
          .status(400)
          .json({ success: false, message: 'payoutType and recipientEntityId are required' });
      }
      if (payoutType !== 'Vendor' && payoutType !== 'TenantOverride') {
        return res
          .status(400)
          .json({ success: false, message: "payoutType must be 'Vendor' or 'TenantOverride'" });
      }

      const items = await clawbackBalances.getPayoutClawbackDetails({
        tenantId,
        payoutType,
        recipientEntityId
      });
      const total = items.reduce((s, i) => s + Number(i.remainingAmount || 0), 0);
      return res.json({
        success: true,
        data: {
          totalPending: Math.round(total * 100) / 100,
          count: items.length,
          items
        }
      });
    } catch (e) {
      console.error('clawback-balances/payouts failed:', e);
      return res
        .status(500)
        .json({ success: false, message: e.message || 'Failed to load payout clawback details' });
    }
  }
);

module.exports = router;

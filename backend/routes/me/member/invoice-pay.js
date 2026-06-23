/**
 * POST /api/me/member/invoices/pay-balance
 * Member self-serve: pay full BalanceDue on one household invoice (individual billing only).
 */
const express = require('express');
const { validate: uuidValidate } = require('uuid');
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const {
  getEffectiveUserId,
  getHouseholdId,
} = require('../../../middleware/attachMemberHouseholdContext');
const { executeHouseholdManualCharge } = require('../../../services/householdManualCharge.service');
const { requireShared } = require('../../../config/shared-modules');
const { isSuccessfulPaymentRecordStatus } = requireShared('payment-status');
const { PENDING_BANK_APPROVAL_MESSAGE } = requireShared('payment-messages');

const router = express.Router();

const PAYABLE_STATUSES = new Set(['unpaid', 'partial', 'overdue']);

function isUuid(s) {
  return typeof s === 'string' && uuidValidate(s);
}

router.post('/pay-balance', authorize(['Member']), async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const requesterTenantId = req.user?.TenantId;
    const householdId = getHouseholdId(req);
    if (!userId || !requesterTenantId) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }
    if (!householdId) {
      return res.status(400).json({
        success: false,
        message: 'No household found for this account.',
      });
    }

    const invoiceIdRaw = req.body?.invoiceId;
    if (!isUuid(invoiceIdRaw)) {
      return res.status(400).json({ success: false, message: 'Valid invoiceId is required' });
    }

    const pool = await getPool();

    const primaryReq = pool.request();
    primaryReq.input('userId', sql.UniqueIdentifier, userId);
    primaryReq.input('tenantId', sql.UniqueIdentifier, requesterTenantId);
    const primaryResult = await primaryReq.query(`
      SELECT m.HouseholdId, m.GroupId, m.TenantId AS MemberTenantId
      FROM oe.Members m
      INNER JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.UserId = @userId
        AND m.RelationshipType = 'P'
        AND u.TenantId = @tenantId
    `);

    const primaryRow = primaryResult.recordset?.[0];
    if (!primaryRow?.HouseholdId) {
      return res.status(400).json({
        success: false,
        message: 'No household found for this account.',
      });
    }

    if (primaryRow.GroupId) {
      return res.status(400).json({
        success: false,
        message: 'Online invoice payment is not available for group-billed members. Contact your employer or administrator.',
      });
    }

    if (!primaryRow.MemberTenantId || String(primaryRow.MemberTenantId) !== String(requesterTenantId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    if (String(primaryRow.HouseholdId) !== String(householdId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const invReq = pool.request();
    invReq.input('invoiceId', sql.UniqueIdentifier, invoiceIdRaw);
    invReq.input('householdId', sql.UniqueIdentifier, householdId);
    invReq.input('tenantId', sql.UniqueIdentifier, requesterTenantId);
    const invResult = await invReq.query(`
      SELECT
        i.InvoiceId,
        i.HouseholdId,
        i.TenantId,
        i.InvoiceType,
        i.Status,
        i.BalanceDue,
        i.InvoiceNumber,
        i.BillingPeriodStart,
        i.BillingPeriodEnd
      FROM oe.Invoices i
      WHERE i.InvoiceId = @invoiceId
        AND i.HouseholdId = @householdId
        AND i.TenantId = @tenantId
        AND i.InvoiceType = N'Individual'
    `);

    const inv = invResult.recordset?.[0];
    if (!inv) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found or you do not have access to pay it.',
      });
    }

    const statusLower = String(inv.Status || '').trim().toLowerCase();
    if (!PAYABLE_STATUSES.has(statusLower)) {
      return res.status(400).json({
        success: false,
        message: 'This invoice cannot be paid online. It may already be paid or closed.',
      });
    }

    const balanceRaw = Number(inv.BalanceDue);
    if (!Number.isFinite(balanceRaw) || balanceRaw <= 0.005) {
      return res.status(400).json({
        success: false,
        message: 'Nothing is due on this invoice.',
      });
    }

    const chargeAmount = Math.round(balanceRaw * 100) / 100;

    const manualResult = await executeHouseholdManualCharge(pool, {
      householdId,
      tenantId: requesterTenantId,
      chargeAmount,
      actingUserId: userId,
      fallbackAgentId: null,
      billingPeriodStart: null,
      billingPeriodEnd: null,
      targetInvoiceId: inv.InvoiceId,
      mode: 'member-pay',
      prefillInvoiceNumber: inv.InvoiceNumber,
      prefillBillingPeriodStart: inv.BillingPeriodStart,
      prefillBillingPeriodEnd: inv.BillingPeriodEnd,
      failClosedOnFulfillError: true,
    });

    if (!manualResult.ok) {
      return res.status(manualResult.statusCode).json(manualResult.body);
    }

    return res.json({
      success: true,
      message: isSuccessfulPaymentRecordStatus(String(manualResult.data?.paymentRecordStatus ?? ''))
        ? 'Payment processed successfully'
        : PENDING_BANK_APPROVAL_MESSAGE,
      data: manualResult.data,
    });
  } catch (err) {
    console.error('POST /api/me/member/invoices/pay-balance error:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to process payment',
    });
  }
});

module.exports = router;

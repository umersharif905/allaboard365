'use strict';

/**
 * RefundService - Unified entry point for ALL refund processing.
 *
 * Replaces divergent logic in:
 *   - backend/routes/accounting.js POST /payments/:paymentId/refund (manual)
 *   - oe_payment_manager/WebhookProcessor handleCreditCardRefund / handleACHRefund
 *
 * Single function processRefund() owns one DB transaction and all side-effect ordering:
 *   1. Tenant guard (SysAdmin / webhook bypass)
 *   2. Idempotency (cumulative refund + processorTxnId dedupe)
 *   3. Insert oe.Refunds row
 *   4. Insert refund oe.Payments row (TransactionType='Refund', negative amount, hydrated HouseholdId/EnrollmentId/InvoiceId)
 *   5. Update original oe.Payments status (full vs partial derived from cumulative refund amounts)
 *   6. unfulfillInvoice for the linked invoice
 *   7. Reverse applied member credits + cascade commission clawback for credit-paid invoices
 *      (no-op until Phase 1 ships; wired up in Phase 0.5 finalize)
 *   8. Clawback orchestrator for the directly refunded payment
 *      (no-op until Phase 2/3 ship; wired up incrementally)
 *
 * Manual POST /api/accounting/payments/:id/refund calls DIME first; Refunded is only set after DIME succeeds (DB can still fail after — see Phase 11 replay).
 */

const sql = require('mssql');
const { getPool } = require('../config/database');
const invoiceService = require('./invoiceService');

const STATUS_REFUNDED = 'Refunded';
const STATUS_COMPLETED = 'Completed';

// Fallback "system" user UUID for refunds initiated outside an interactive
// user session (webhook, internal CLI, automated retries). oe.Refunds.RefundBy
// is NOT NULL, so without this fallback any refund where processedBy is not a
// real user UUID — including every webhook refund — would fail to insert.
// Same UUID is used for system-attributed writes elsewhere in the codebase
// (e.g. backend/routes/public/sign-acknowledgements.js).
const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID || '25E60878-F294-47D5-8C0F-D1674E4893AE';

function nz(v, fallback = null) {
  return v == null ? fallback : v;
}

function getUserRolesArray(user) {
  if (!user) return [];
  const roles = user.Roles || user.roles || [];
  if (Array.isArray(roles)) return roles;
  if (typeof roles === 'string') return [roles];
  return [];
}

function isSysAdmin(user) {
  if (!user) return false;
  if (String(user.userType || user.UserType || '').toLowerCase() === 'sysadmin') return true;
  const roles = getUserRolesArray(user).map(r => String(r).toLowerCase());
  return roles.includes('sysadmin');
}

/**
 * Process a refund end-to-end.
 *
 * @param {Object} args
 * @param {string} args.paymentId               - Original payment being refunded
 * @param {number} args.refundAmount            - Positive amount to refund (partial supported)
 * @param {string} [args.reason]                - Free-form refund reason
 * @param {string} [args.processedBy]           - userId or 'webhook'
 * @param {string} [args.processorTxnId]        - Pass-through processor transaction id (idempotency key)
 * @param {('manual'|'webhook')} args.source    - Caller path
 * @param {boolean} [args.bypassTenantGuard]    - Set true for webhook (no req.user) or other system calls
 * @param {Object} [args.user]                  - req.user; required when source='manual' and bypassTenantGuard=false
 * @param {string} [args.paymentMethodHint]     - 'CreditCard'|'ACH' override; otherwise derived from payment row
 * @returns {Promise<{
 *   success: boolean,
 *   refundPaymentId?: string,
 *   refundsRowId?: string,
 *   partial?: boolean,
 *   alreadyProcessed?: boolean,
 *   message?: string,
 *   code?: string,
 *   clawbackResults?: Object
 * }>}
 */
async function processRefund(args) {
  const {
    paymentId,
    refundAmount,
    reason,
    processedBy,
    processorTxnId,
    source,
    bypassTenantGuard = false,
    user,
    paymentMethodHint,
    /** Manual UI only: skip commission + vendor/tenant payout clawbacks (step 8). Default false. */
    skipClawbacks = false
  } = args || {};

  if (!paymentId) return { success: false, message: 'paymentId is required', code: 'INVALID_INPUT' };
  const amt = Number(refundAmount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { success: false, message: 'refundAmount must be > 0', code: 'INVALID_AMOUNT' };
  }
  if (source !== 'manual' && source !== 'webhook') {
    return { success: false, message: "source must be 'manual' or 'webhook'", code: 'INVALID_INPUT' };
  }

  const pool = await getPool();

  // ---------------------------------------------------------------------
  // Pre-transaction lookups (read-only)
  // ---------------------------------------------------------------------
  const paymentRes = await pool.request()
    .input('paymentId', sql.UniqueIdentifier, paymentId)
    .query(`
      SELECT PaymentId, TenantId, Amount, Status, ProcessorTransactionId, Processor,
             PaymentMethod, InvoiceId, HouseholdId, EnrollmentId, GroupId
      FROM oe.Payments
      WHERE PaymentId = @paymentId
    `);

  const payment = paymentRes.recordset?.[0];
  if (!payment) return { success: false, message: 'Payment not found', code: 'NOT_FOUND' };

  const completedStatuses = ['completed', 'charged', 'paid', 'approval', 'success'];
  const currentStatus = String(payment.Status || '').toLowerCase();
  if (currentStatus === 'refunded') {
    // Could be a follow-up partial after the full was already taken; surface explicitly
    // (the cumulative check below handles partial refunds correctly)
  } else if (!completedStatuses.includes(currentStatus)) {
    return {
      success: false,
      message: `Only completed payments can be refunded. Current status: ${payment.Status || 'Unknown'}`,
      code: 'INVALID_STATUS'
    };
  }

  // 1. Tenant guard
  if (!bypassTenantGuard && source === 'manual') {
    if (!isSysAdmin(user)) {
      const userTenantId = user?.TenantId || user?.tenantId;
      if (!userTenantId || String(userTenantId) !== String(payment.TenantId)) {
        return { success: false, message: 'You can only refund payments for your tenant', code: 'FORBIDDEN' };
      }
    }
  }

  // 2. Idempotency
  // 2a. processorTxnId dedupe — webhook retry safety
  if (processorTxnId) {
    const dup = await pool.request()
      .input('processorTxnId', sql.NVarChar(255), String(processorTxnId))
      .input('originalPaymentId', sql.UniqueIdentifier, paymentId)
      .query(`
        SELECT TOP 1 PaymentId
        FROM oe.Payments
        WHERE TransactionType = N'Refund'
          AND OriginalPaymentId = @originalPaymentId
          AND ProcessorTransactionId = @processorTxnId
      `);
    if (dup.recordset.length > 0) {
      return {
        success: true,
        alreadyProcessed: true,
        refundPaymentId: dup.recordset[0].PaymentId,
        message: 'Refund already recorded (processorTxnId dedupe)'
      };
    }
  }

  // 2b. Cumulative refund check
  const cumulativeRes = await pool.request()
    .input('originalPaymentId', sql.UniqueIdentifier, paymentId)
    .query(`
      SELECT COALESCE(SUM(ABS(Amount)), 0) AS TotalRefunded
      FROM oe.Payments
      WHERE TransactionType = N'Refund'
        AND OriginalPaymentId = @originalPaymentId
    `);
  const cumulativeRefundedBefore = Number(cumulativeRes.recordset?.[0]?.TotalRefunded || 0);
  const paymentAmount = Number(payment.Amount) || 0;
  const cumulativeAfter = cumulativeRefundedBefore + amt;
  if (cumulativeAfter > paymentAmount + 0.005) {
    return {
      success: false,
      message: `Refund would exceed payment amount. Already refunded $${cumulativeRefundedBefore.toFixed(2)} of $${paymentAmount.toFixed(2)}.`,
      code: 'EXCEEDS_AMOUNT'
    };
  }

  // 2c. Full-refund-only rule.
  // Refunds always reverse exactly one payment in full. No proration of
  // commissions, vendor payouts, or tenant overrides — too error-prone and
  // not how the business actually operates. If a single line item should be
  // adjusted, refund the entire payment and re-bill the customer for what
  // remains active. The invoice's Status auto-derives from PaidAmount, so
  // refunding 1 of N payments on the same invoice is supported (it flips the
  // invoice from Paid → Partial without any explicit "refunded" flag).
  if (cumulativeRefundedBefore > 0.005) {
    return {
      success: false,
      message: 'This payment has already been partially refunded. Partial refunds are not supported.',
      code: 'PARTIAL_REFUND_NOT_ALLOWED'
    };
  }
  if (Math.abs(amt - paymentAmount) > 0.005) {
    return {
      success: false,
      message: `Partial refunds are not supported. Refund must equal the full payment amount of $${paymentAmount.toFixed(2)}. Re-bill the customer for any line items that should remain active.`,
      code: 'PARTIAL_REFUND_NOT_ALLOWED'
    };
  }
  const isPartialAfter = false;

  // ---------------------------------------------------------------------
  // Transaction
  // ---------------------------------------------------------------------
  const transaction = pool.transaction();
  await transaction.begin();

  let refundPaymentId;
  let refundsRowId = null;

  try {
    refundPaymentId = require('crypto').randomUUID();

    const reasonText = (typeof reason === 'string' && reason.trim()) ? reason.trim() : null;

    // 3. Insert oe.Refunds row (refund history table for manual UI compat)
    try {
      const refundsReq = transaction.request();
      refundsReq.input('paymentId', sql.UniqueIdentifier, paymentId);
      refundsReq.input('amount', sql.Decimal(10, 2), amt);
      refundsReq.input('refundBy', sql.UniqueIdentifier, isUuid(processedBy) ? processedBy : SYSTEM_USER_ID);
      refundsReq.input('refundReason', sql.NVarChar(500), reasonText);
      refundsReq.input('refundDate', sql.DateTime2, new Date());
      try {
        const ins = await refundsReq.query(`
          INSERT INTO oe.Refunds (PaymentId, Amount, RefundBy, Status, RefundReason, RefundDate)
          OUTPUT INSERTED.RefundId
          VALUES (@paymentId, @amount, @refundBy, N'Processed', @refundReason, @refundDate)
        `);
        refundsRowId = ins.recordset?.[0]?.RefundId || null;
      } catch (insertErr) {
        const msg = insertErr.message || '';
        if (msg.includes('RefundReason') || msg.includes('RefundDate') || msg.includes('Invalid column name')) {
          // Schema fallback for older deployments
          const fb = transaction.request();
          fb.input('paymentId', sql.UniqueIdentifier, paymentId);
          fb.input('amount', sql.Decimal(10, 2), amt);
          fb.input('refundBy', sql.UniqueIdentifier, isUuid(processedBy) ? processedBy : SYSTEM_USER_ID);
          const fbRes = await fb.query(`
            INSERT INTO oe.Refunds (PaymentId, Amount, RefundBy, Status)
            OUTPUT INSERTED.RefundId
            VALUES (@paymentId, @amount, @refundBy, N'Processed')
          `);
          refundsRowId = fbRes.recordset?.[0]?.RefundId || null;
        } else {
          throw insertErr;
        }
      }
    } catch (refundsErr) {
      // oe.Refunds is the older history table. Failing here is fatal — accounting reports rely on it.
      throw refundsErr;
    }

    // 4. Insert refund oe.Payments row (TransactionType='Refund', negative Amount, hydrated linkage)
    const paymentMethod = paymentMethodHint
      || (() => {
        const pm = String(payment.PaymentMethod || '').toLowerCase();
        if (pm.includes('ach') || pm.includes('bank')) return 'ACH';
        if (pm.includes('credit') || pm.includes('cc') || pm.includes('card')) return 'CreditCard';
        return payment.PaymentMethod || 'CreditCard';
      })();

    const refundPayReq = transaction.request();
    refundPayReq.input('paymentId', sql.UniqueIdentifier, refundPaymentId);
    refundPayReq.input('originalPaymentId', sql.UniqueIdentifier, paymentId);
    refundPayReq.input('tenantId', sql.UniqueIdentifier, payment.TenantId);
    refundPayReq.input('householdId', sql.UniqueIdentifier, nz(payment.HouseholdId));
    refundPayReq.input('enrollmentId', sql.UniqueIdentifier, nz(payment.EnrollmentId));
    refundPayReq.input('groupId', sql.UniqueIdentifier, nz(payment.GroupId));
    refundPayReq.input('invoiceId', sql.UniqueIdentifier, nz(payment.InvoiceId));
    refundPayReq.input('amount', sql.Decimal(10, 2), -amt);
    refundPayReq.input('processor', sql.NVarChar(50), payment.Processor || 'DIME');
    refundPayReq.input('processorTxnId', sql.NVarChar(255), processorTxnId ? String(processorTxnId) : null);
    refundPayReq.input('paymentMethod', sql.NVarChar(50), paymentMethod);
    refundPayReq.input('paymentDate', sql.DateTime2, new Date());

    await refundPayReq.query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, GroupId, TenantId, InvoiceId,
        TransactionType, Amount, Status, Processor, ProcessorTransactionId, PaymentMethod,
        OriginalPaymentId, PaymentDate, CreatedDate, ModifiedDate
      ) VALUES (
        @paymentId, @enrollmentId, @householdId, @groupId, @tenantId, @invoiceId,
        N'Refund', @amount, N'Completed', @processor, @processorTxnId, @paymentMethod,
        @originalPaymentId, @paymentDate, GETUTCDATE(), GETUTCDATE()
      )
    `);

    // 5. Update original payment status
    if (!isPartialAfter) {
      const updReq = transaction.request();
      updReq.input('paymentId', sql.UniqueIdentifier, paymentId);
      await updReq.query(`
        UPDATE oe.Payments
        SET Status = N'Refunded', RefundDate = GETUTCDATE(), ModifiedDate = GETUTCDATE()
        WHERE PaymentId = @paymentId
      `);
    } else {
      // Partial: leave Status='Completed', do not set RefundDate.
      // UI derives partial-refund display from cumulative refund amount via SUM(refund rows).
      const touchReq = transaction.request();
      touchReq.input('paymentId', sql.UniqueIdentifier, paymentId);
      await touchReq.query(`
        UPDATE oe.Payments SET ModifiedDate = GETUTCDATE() WHERE PaymentId = @paymentId
      `);
    }

    // 6. unfulfillInvoice — inside the transaction so it rolls back together.
    //    Re-fetch InvoiceId in case selfHeal/tryLinkPaymentToInvoice backfilled
    //    it after the original payment row was created (DIME webhooks often
    //    insert with InvoiceId NULL and rely on later self-heal). Without this
    //    the invoice's PaidAmount/Status would never reflect the refund.
    let resolvedInvoiceId = payment.InvoiceId;
    if (!resolvedInvoiceId) {
      const lookup = await transaction.request()
        .input('paymentId', sql.UniqueIdentifier, paymentId)
        .query('SELECT InvoiceId FROM oe.Payments WHERE PaymentId = @paymentId');
      resolvedInvoiceId = lookup.recordset?.[0]?.InvoiceId || null;
      if (resolvedInvoiceId) {
        // Backfill the in-memory copy so other steps see it.
        payment.InvoiceId = resolvedInvoiceId;
      }
    }
    if (resolvedInvoiceId) {
      await invoiceService.unfulfillInvoiceInTxn(transaction, sql, resolvedInvoiceId, amt);
    } else {
      console.warn(`[RefundService] Refund ${refundPaymentId} for payment ${paymentId}: no InvoiceId on the original payment; invoice ledger not unfulfilled. Run "Resync" on the corresponding invoice to reconcile.`);
    }

    // 7. Reverse applied member credits + cascade commission clawback
    //    Phase 0.5 finalize: now blocking. If the credit service is present, any failure
    //    during reversal must roll back the entire refund so we never end up with a
    //    refunded payment that still has its credit applied to a downstream invoice.
    let creditReversalResult = null;
    const householdCredits = safeRequire('./householdCredits.service');
    if (householdCredits && typeof householdCredits.reverseEntriesForPayment === 'function') {
      creditReversalResult = await householdCredits.reverseEntriesForPayment(paymentId, transaction);
    }

    // Cascade commission clawback for credit-paid invoices that were just unwound.
    // Stays non-blocking until Phase 2 ships clawBackForCreditReversal — at that point,
    // the same hardening as step 7 should apply.
    let cascadeResult = null;
    try {
      if (creditReversalResult && Array.isArray(creditReversalResult.reversedApplications) && creditReversalResult.reversedApplications.length > 0) {
        const commissionService = safeRequire('./commissionService.advances');
        if (commissionService && typeof commissionService.clawBackForCreditReversal === 'function') {
          cascadeResult = await commissionService.clawBackForCreditReversal(creditReversalResult.reversedApplications, transaction);
        }
      }
    } catch (cascadeErr) {
      console.warn('[RefundService] credit-paid commission cascade failed (non-blocking until Phase 2):', cascadeErr?.message);
    }

    // 8. Clawback orchestrator for the directly refunded payment
    let clawbackResults = null;
    if (skipClawbacks) {
      console.warn('[RefundService] skipClawbacks=true — step 8 commission/vendor/tenant clawbacks not run', {
        paymentId,
        source,
        userId: user?.UserId || processedBy
      });
    } else {
      try {
        const refundClawbackService = safeRequire('./refundClawbackService');
        if (refundClawbackService && typeof refundClawbackService.processClawbacks === 'function') {
          clawbackResults = await refundClawbackService.processClawbacks(paymentId, amt, transaction, { refundId: refundsRowId });
        }
      } catch (clawErr) {
        console.warn('[RefundService] clawback orchestrator failed (non-blocking until Phase 2/3):', clawErr?.message);
      }
    }

    await transaction.commit();

    return {
      success: true,
      refundPaymentId,
      refundsRowId,
      partial: isPartialAfter,
      clawbackResults: { creditReversal: creditReversalResult, cascade: cascadeResult, direct: clawbackResults }
    };
  } catch (txnErr) {
    try { await transaction.rollback(); } catch (_) { /* ignore */ }
    console.error('[RefundService] transaction rolled back:', txnErr?.message, { paymentId, amt });
    return { success: false, message: txnErr.message || 'Refund DB transaction failed', code: 'TXN_FAILED' };
  }
}

function isUuid(v) {
  if (!v || typeof v !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function safeRequire(modulePath) {
  try {
    return require(modulePath);
  } catch (_) {
    return null;
  }
}

module.exports = {
  processRefund
};

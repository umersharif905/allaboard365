const { getPool, sql } = require('../shared/db');
const { buildProductSnapshotForPayment } = require('../shared/payment-product-snapshots');

/**
 * POST /api/mark-payment-completed
 * Manually mark a payment as Completed, backfill ProductCommissions/ProductVendorAmounts/ProductOwnerAmounts (same as webhook), and set linked invoice to Paid.
 * Use when DIME did not send a webhook (e.g. one-time charge retry) and you want to sync our DB.
 *
 * Body (one of):
 *   { "processorTransactionId": "6281" }   - our DB ProcessorTransactionId
 *   { "paymentId": "uuid" }                 - our DB PaymentId
 *
 * Optional body fields:
 *   { "dimeTransactionId": "6494" }         - store DIME's transaction id for audit (updates ProcessorTransactionId if you want to align)
 *   { "amount": 1891.30 }                   - amount to set on Invoice.PaidAmount (default: from payment)
 *   { "backfillBreakdown": true }          - (default true) populate ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts from group/household enrollments
 *
 * Headers: x-api-key (ADMIN_API_KEY)
 */
module.exports = async function (context, req) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
      context.res = {
        status: 401,
        body: { success: false, error: 'Unauthorized' }
      };
      return;
    }

    const body = req.body || {};
    const processorTransactionId = body.processorTransactionId ? String(body.processorTransactionId).trim() : null;
    const paymentIdParam = body.paymentId ? String(body.paymentId).trim() : null;
    const dimeTransactionId = body.dimeTransactionId ? String(body.dimeTransactionId).trim() : null;
    const amountOverride = body.amount != null ? parseFloat(body.amount) : null;
    const backfillBreakdown = body.backfillBreakdown !== false; // default true

    if (!processorTransactionId && !paymentIdParam) {
      context.res = {
        status: 400,
        body: {
          success: false,
          error: 'Provide either processorTransactionId or paymentId in the body'
        }
      };
      return;
    }

    const pool = await getPool();

    let payment;
    if (paymentIdParam) {
      const byId = await pool.request()
        .input('paymentId', sql.UniqueIdentifier, paymentIdParam)
        .query(`
          SELECT PaymentId, GroupId, HouseholdId, InvoiceId, EnrollmentId, RecurringScheduleId,
                 ProcessorTransactionId, Status, Amount, PaymentDate
          FROM oe.Payments
          WHERE PaymentId = @paymentId
        `);
      payment = byId.recordset[0] || null;
    } else {
      const byTx = await pool.request()
        .input('processorTransactionId', sql.NVarChar(255), processorTransactionId)
        .query(`
          SELECT PaymentId, GroupId, HouseholdId, InvoiceId, EnrollmentId, RecurringScheduleId,
                 ProcessorTransactionId, Status, Amount, PaymentDate
          FROM oe.Payments
          WHERE ProcessorTransactionId = @processorTransactionId
        `);
      payment = byTx.recordset[0] || null;
    }

    if (!payment) {
      context.res = {
        status: 404,
        body: {
          success: false,
          error: 'Payment not found',
          processorTransactionId: processorTransactionId || undefined,
          paymentId: paymentIdParam || undefined
        }
      };
      return;
    }

    const amount = amountOverride != null && !isNaN(amountOverride) ? amountOverride : (payment.Amount ?? 0);
    const newProcessorTxId = dimeTransactionId || payment.ProcessorTransactionId;

    const logger = { info: (m) => context.log(m), warn: (m) => context.log.warn(m), error: (m) => context.log.error(m) };

    let productCommissionsJSON = null;
    let productVendorAmountsJSON = null;
    let productOwnerAmountsJSON = null;
    if (backfillBreakdown && (payment.GroupId || payment.HouseholdId)) {
      try {
        const paymentDate = payment.PaymentDate || null;
        const oneOffEnrollment =
          payment.HouseholdId &&
          payment.EnrollmentId &&
          !payment.InvoiceId &&
          !payment.RecurringScheduleId;
        const snap = await buildProductSnapshotForPayment(
          pool,
          {
            householdId: payment.HouseholdId,
            groupId: payment.GroupId,
            paymentDate,
            invoiceId: payment.InvoiceId || null,
            enrollmentId: payment.EnrollmentId || null,
            productSnapshotScope: oneOffEnrollment ? 'enrollment' : undefined
          },
          logger
        );
        if (snap) {
          productCommissionsJSON = snap.productCommissionsJSON;
          productVendorAmountsJSON = snap.productVendorAmountsJSON;
          productOwnerAmountsJSON = snap.productOwnerAmountsJSON;
        }
      } catch (breakdownErr) {
        context.log.warn('Backfill breakdown build failed:', breakdownErr.message);
      }
    }

    // Update payment: status, ProcessorTransactionId, and optionally product JSON (same as webhook)
    const updateReq = pool.request()
      .input('paymentId', sql.UniqueIdentifier, payment.PaymentId)
      .input('processorTransactionId', sql.NVarChar(255), newProcessorTxId);
    if (productCommissionsJSON != null) {
      updateReq.input('productCommissions', sql.NVarChar(sql.MAX), productCommissionsJSON);
      updateReq.input('productVendorAmounts', sql.NVarChar(sql.MAX), productVendorAmountsJSON);
      updateReq.input('productOwnerAmounts', sql.NVarChar(sql.MAX), productOwnerAmountsJSON);
    }
    const setClause = productCommissionsJSON != null
      ? `SET Status = 'Completed', ModifiedDate = GETUTCDATE(), ProcessorTransactionId = @processorTransactionId,
         ProductCommissions = @productCommissions, ProductVendorAmounts = @productVendorAmounts, ProductOwnerAmounts = @productOwnerAmounts`
      : `SET Status = 'Completed', ModifiedDate = GETUTCDATE(), ProcessorTransactionId = @processorTransactionId`;
    await updateReq.query(`
      UPDATE oe.Payments
      ${setClause}
      WHERE PaymentId = @paymentId
    `);
    const breakdownUpdated = productCommissionsJSON != null;

    let invoiceUpdated = false;
    let invoiceError = null;
    if (payment.InvoiceId) {
      try {
        await pool.request()
          .input('invoiceId', sql.UniqueIdentifier, payment.InvoiceId)
          .input('amount', sql.Decimal(12, 2), amount)
          .query(`
            UPDATE oe.Invoices
            SET Status = 'Paid',
                PaidAmount = @amount,
                PaymentReceivedDate = GETUTCDATE(),
                ModifiedDate = GETUTCDATE()
            WHERE InvoiceId = @invoiceId
          `);
        invoiceUpdated = true;
      } catch (invErr) {
        const msg = invErr.originalError?.info?.message || invErr.message || String(invErr);
        context.log.warn('Invoice update failed (trigger or constraint):', msg);
        invoiceError = msg;
      }
    }

    const msgParts = ['Payment marked as Completed'];
    if (breakdownUpdated) msgParts.push('breakdown backfilled');
    if (invoiceUpdated) msgParts.push('invoice marked as Paid');
    if (invoiceError) msgParts.push('invoice update failed');

    context.res = {
      status: 200,
      body: {
        success: true,
        message: msgParts.join(', '),
        data: {
          paymentId: payment.PaymentId,
          groupId: payment.GroupId,
          processorTransactionId: newProcessorTxId,
          amount,
          breakdownUpdated,
          invoiceId: payment.InvoiceId || null,
          invoiceUpdated,
          invoiceError: invoiceError || undefined
        }
      }
    };
  } catch (error) {
    context.log.error('MarkPaymentCompleted error:', error);
    const triggerMsg = error.originalError?.info?.message || error.message;
    context.res = {
      status: 500,
      body: {
        success: false,
        error: triggerMsg,
        hint: error.originalError?.info?.message ? 'Database trigger or constraint failed (see error).' : undefined
      }
    };
  }
};

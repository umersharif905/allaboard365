const { getPool, sql } = require('../shared/db');

/**
 * POST /api/mark-payment-completed
 * Manually mark a payment as Completed and its linked invoice as Paid.
 * Use when you've confirmed success in DIME (e.g. different merchant) and want to sync our DB.
 *
 * Body (one of):
 *   { "processorTransactionId": "6281" }   - our DB ProcessorTransactionId
 *   { "paymentId": "uuid" }                 - our DB PaymentId
 *
 * Optional body fields:
 *   { "dimeTransactionId": "6494" }         - store DIME's transaction id for audit (updates ProcessorTransactionId if you want to align)
 *   { "amount": 1891.30 }                   - amount to set on Invoice.PaidAmount (default: from payment)
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
          SELECT PaymentId, GroupId, InvoiceId, ProcessorTransactionId, Status, Amount
          FROM oe.Payments
          WHERE PaymentId = @paymentId
        `);
      payment = byId.recordset[0] || null;
    } else {
      const byTx = await pool.request()
        .input('processorTransactionId', sql.NVarChar(255), processorTransactionId)
        .query(`
          SELECT PaymentId, GroupId, InvoiceId, ProcessorTransactionId, Status, Amount
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

    // Update payment first (trigger on Payments may fire here)
    await pool.request()
      .input('paymentId', sql.UniqueIdentifier, payment.PaymentId)
      .input('processorTransactionId', sql.NVarChar(255), newProcessorTxId)
      .query(`
        UPDATE oe.Payments
        SET Status = 'Completed',
            ModifiedDate = GETUTCDATE(),
            ProcessorTransactionId = @processorTransactionId
        WHERE PaymentId = @paymentId
      `);

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

    context.res = {
      status: 200,
      body: {
        success: true,
        message: 'Payment marked as Completed' + (invoiceUpdated ? ' and invoice marked as Paid' : (invoiceError ? '; invoice update failed' : '')),
        data: {
          paymentId: payment.PaymentId,
          groupId: payment.GroupId,
          processorTransactionId: newProcessorTxId,
          amount,
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

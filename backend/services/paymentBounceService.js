'use strict';

/**
 * PaymentBounceService - unified processor for ACH returns and credit-card chargebacks.
 *
 * Single transaction:
 *   1. Find original Payment by ProcessorTransactionId (or paymentId)
 *   2. Idempotency: if original is already Failed with the same ACHReturnCode / ChargebackReason,
 *      return alreadyProcessed
 *   3. Update original oe.Payments — Status='Failed', set ACHReturnCode/Reason or ChargebackReason,
 *      stamp BounceWebhookEventId / LastFailureDate
 *   4. If original.InvoiceId set, unfulfillInvoiceInTxn to recompute invoice status
 *
 * No separate negative-amount ledger row is inserted — the flipped original carries all
 * bounce metadata and double-entry adds UI noise without informational value.
 */

const sql = require('mssql');
const { getPool } = require('../config/database');
const invoiceService = require('./invoiceService');

const RETURN_TYPE_ACH = 'ACH_Return';
const RETURN_TYPE_CHARGEBACK = 'Chargeback';

/**
 * @param {Object} args
 * @param {string} [args.originalPaymentId]
 * @param {string} [args.originalProcessorTransactionId]
 * @param {string} args.returnType - 'ACH_Return' | 'Chargeback'
 * @param {number} args.amount - Positive amount that was returned/charged-back
 * @param {string} [args.returnCode] - ACH NACHA return code (R01..R85)
 * @param {string} [args.returnReason] - ACH return description
 * @param {string} [args.chargebackReason] - Chargeback reason text
 * @param {number} [args.webhookEventId]
 * @param {string} [args.customerUuid] - DIME customer_uuid; tightens lookup against
 *   ProcessorTransactionId collisions (DIME recurring txn numbers are small sequentials).
 * @returns {Promise<{success:boolean, alreadyProcessed?:boolean, code?:string, message?:string,
 *   originalPaymentId?:string, invoiceId?:string|null, invoiceUnfulfilled?:object}>}
 */
async function processBounce(args) {
  const {
    originalPaymentId,
    originalProcessorTransactionId,
    returnType,
    amount,
    returnCode = null,
    returnReason = null,
    chargebackReason = null,
    webhookEventId = null,
    customerUuid = null
  } = args || {};

  if (returnType !== RETURN_TYPE_ACH && returnType !== RETURN_TYPE_CHARGEBACK) {
    return { success: false, code: 'BAD_RETURN_TYPE', message: `Unsupported returnType: ${returnType}` };
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { success: false, code: 'BAD_AMOUNT', message: 'amount must be a positive number' };
  }
  if (!originalPaymentId && !originalProcessorTransactionId) {
    return { success: false, code: 'MISSING_LOOKUP', message: 'originalPaymentId or originalProcessorTransactionId required' };
  }

  const pool = await getPool();

  // Resolve customerUuid → HouseholdId outside the transaction so we can constrain lookup
  // (DIME recurring transaction_number is a small sequential like "393" / "401" — without
  // a household constraint the lookup-by-txnId could flip a wrong household's payment).
  let householdIdGuard = null;
  if (!originalPaymentId && customerUuid) {
    try {
      const hh = await pool
        .request()
        .input('customerUuid', sql.NVarChar(255), String(customerUuid))
        .query(`
          SELECT TOP 1 HouseholdId
          FROM oe.Members
          WHERE LTRIM(RTRIM(ISNULL(ProcessorCustomerId, N''))) = LTRIM(RTRIM(@customerUuid))
            AND HouseholdId IS NOT NULL
          ORDER BY ModifiedDate DESC
        `);
      if (hh.recordset?.length) {
        householdIdGuard = hh.recordset[0].HouseholdId;
      }
    } catch (_e) {
      /* non-fatal — fall through with broader lookup */
    }
  }

  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    let lookupResult;
    if (originalPaymentId) {
      lookupResult = await transaction
        .request()
        .input('paymentId', sql.UniqueIdentifier, originalPaymentId)
        .query(`
          SELECT TOP 1 PaymentId, EnrollmentId, HouseholdId, GroupId, TenantId,
                 InvoiceId, Amount, PaymentMethod, ProcessorTransactionId, Status,
                 ACHReturnCode, ChargebackReason
          FROM oe.Payments
          WHERE PaymentId = @paymentId
            AND TransactionType = N'Payment'
        `);
    } else {
      const req = transaction
        .request()
        .input('processorTxnId', sql.NVarChar(255), String(originalProcessorTransactionId))
        .input('amount', sql.Decimal(10, 2), amt);
      let amountAndHouseholdGuard =
        ' AND Amount = @amount';
      if (householdIdGuard) {
        req.input('householdId', sql.UniqueIdentifier, householdIdGuard);
        amountAndHouseholdGuard += ' AND HouseholdId = @householdId';
      }
      lookupResult = await req.query(`
        SELECT TOP 1 PaymentId, EnrollmentId, HouseholdId, GroupId, TenantId,
               InvoiceId, Amount, PaymentMethod, ProcessorTransactionId, Status,
               ACHReturnCode, ChargebackReason
        FROM oe.Payments
        WHERE LTRIM(RTRIM(ISNULL(ProcessorTransactionId, N''))) = LTRIM(RTRIM(@processorTxnId))
          AND TransactionType = N'Payment'
          ${amountAndHouseholdGuard}
        ORDER BY CreatedDate DESC
      `);
    }

    const original = lookupResult.recordset?.[0];
    if (!original) {
      await transaction.rollback();
      return {
        success: false,
        code: 'ORIGINAL_NOT_FOUND',
        message: `Original payment not found (lookup by ${originalPaymentId ? 'paymentId' : 'processorTxnId'})`
      };
    }

    // Idempotency: if this original is already Failed with the same ACHReturnCode (or
    // ChargebackReason for chargeback), the bounce already landed. Return alreadyProcessed
    // so DIME retries don't double-unfulfill the invoice.
    if (original.Status === 'Failed') {
      const alreadyHasCode = returnType === RETURN_TYPE_ACH
        ? (returnCode && original.ACHReturnCode && String(original.ACHReturnCode).trim() === String(returnCode).trim())
        : (chargebackReason && original.ChargebackReason && String(original.ChargebackReason).trim() === String(chargebackReason).trim());
      if (alreadyHasCode) {
        await transaction.rollback();
        return {
          success: true,
          alreadyProcessed: true,
          originalPaymentId: String(original.PaymentId),
          invoiceId: original.InvoiceId ? String(original.InvoiceId) : null
        };
      }
    }

    await transaction
      .request()
      .input('paymentId', sql.UniqueIdentifier, original.PaymentId)
      .input('achReturnCode', sql.NVarChar(50), returnType === RETURN_TYPE_ACH ? returnCode : null)
      .input('achReturnReason', sql.NVarChar(sql.MAX), returnType === RETURN_TYPE_ACH ? returnReason : null)
      .input('chargebackReason', sql.NVarChar(sql.MAX), returnType === RETURN_TYPE_CHARGEBACK ? chargebackReason : null)
      .input('failureReason', sql.NVarChar(sql.MAX),
        returnType === RETURN_TYPE_ACH
          ? `ACH Return ${returnCode || ''}${returnReason ? ` - ${returnReason}` : ''}`.trim()
          : `Chargeback${chargebackReason ? ` - ${chargebackReason}` : ''}`)
      .query(`
        UPDATE oe.Payments
        SET Status = N'Failed',
            ACHReturnCode = COALESCE(@achReturnCode, ACHReturnCode),
            ACHReturnReason = COALESCE(@achReturnReason, ACHReturnReason),
            ChargebackReason = COALESCE(@chargebackReason, ChargebackReason),
            FailureReason = COALESCE(FailureReason, @failureReason),
            LastFailureDate = GETUTCDATE(),
            ModifiedDate = GETUTCDATE()
        WHERE PaymentId = @paymentId
      `);

    let invoiceUnfulfilled = { applied: false, reason: 'no_invoice' };
    if (original.InvoiceId && original.Status !== 'Failed') {
      invoiceUnfulfilled = await invoiceService.unfulfillInvoiceInTxn(
        transaction,
        sql,
        original.InvoiceId,
        Math.abs(Number(original.Amount) || amt)
      );
    }

    await transaction.commit();

    return {
      success: true,
      alreadyProcessed: false,
      originalPaymentId: String(original.PaymentId),
      invoiceId: original.InvoiceId ? String(original.InvoiceId) : null,
      invoiceUnfulfilled
    };
  } catch (err) {
    try { await transaction.rollback(); } catch (_e) { /* swallow */ }
    return {
      success: false,
      code: 'BOUNCE_PROCESS_ERROR',
      message: err && err.message ? err.message : String(err)
    };
  }
}

module.exports = {
  processBounce,
  RETURN_TYPE_ACH,
  RETURN_TYPE_CHARGEBACK
};

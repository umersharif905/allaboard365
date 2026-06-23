/**
 * Shared manual household charge (admin charge-now + member pay-invoice).
 * Resolves primary member PMs, calls DIME, stores payment, optionally fulfills invoice.
 */
const { sql } = require('../config/database');
const PaymentDatabaseService = require('./paymentDatabaseService');
const DimeService = require('./dimeService');
const encryptionService = require('./encryptionService');
const { resolveAchRoutingForCharge } = require('../utils/achRouting');
const { requireShared } = require('../config/shared-modules');
const { isSuccessfulPaymentRecordStatus } = requireShared('payment-status');
const { PENDING_BANK_APPROVAL_MESSAGE } = requireShared('payment-messages');

/**
 * Map DIME sync charge result to oe.Payments.Status. Default Pending when unknown —
 * never assume Completed without settlement evidence.
 * @param {{ recordStatus?: string, status?: string }|null|undefined} paymentResult
 * @returns {string}
 */
function resolveManualChargeRecordStatus(paymentResult) {
  const raw = paymentResult?.recordStatus ?? paymentResult?.status;
  if (raw != null && String(raw).trim() !== '') {
    return String(raw).trim();
  }
  return 'Pending';
}

/**
 * Normalize a Date / ISO string / 'YYYY-MM-DD' to UTC-midnight epoch ms for the
 * calendar date it represents (drops time + timezone so date-only comparisons
 * don't drift). Returns null when not parseable.
 * @param {Date|string|null|undefined} v
 * @returns {number|null}
 */
function toUtcDateMs(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
  }
  const s = String(v).trim();
  if (!s) return null;
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Last calendar day (UTC-midnight ms) of the month containing startMs. */
function endOfMonthUtcMs(startMs) {
  const d = new Date(startMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
}

/**
 * Decide whether a successful manual invoice payment should trigger a DIME
 * recurring sync (which advances/skips the next scheduled cycle).
 *
 * Returns TRUE only when the invoice that was just paid is the SAME billing
 * cycle the active recurring schedule is about to charge — i.e. the schedule's
 * NextBillingDate falls inside the paid invoice's billing period.
 *
 * This guards against:
 *  - Overdue / back payments: schedule's next charge is a LATER period than the
 *    invoice paid → must NOT bump (would skip a still-owed month).
 *  - Pre-paying a FUTURE invoice while a nearer charge is still due → must NOT
 *    bump the nearer charge.
 *
 * @param {object} p
 * @param {Date|string|null} p.scheduleNextBillingDate - active schedule's next charge date
 * @param {Date|string|null} p.invoiceBillingPeriodStart - paid invoice period start
 * @param {Date|string|null} [p.invoiceBillingPeriodEnd] - paid invoice period end (falls back to end-of-month of start)
 * @returns {boolean}
 */
function shouldSyncRecurringAfterManualInvoicePayment({
  scheduleNextBillingDate,
  invoiceBillingPeriodStart,
  invoiceBillingPeriodEnd,
} = {}) {
  const nextMs = toUtcDateMs(scheduleNextBillingDate);
  const startMs = toUtcDateMs(invoiceBillingPeriodStart);
  // No active schedule next-charge, or no invoice period to align against → do nothing.
  if (nextMs == null || startMs == null) return false;
  let endMs = toUtcDateMs(invoiceBillingPeriodEnd);
  if (endMs == null || endMs < startMs) endMs = endOfMonthUtcMs(startMs);
  return nextMs >= startMs && nextMs <= endMs;
}

function isDimeStoredTokenLookupFailure(paymentResult) {
  const err = paymentResult?.error;
  if (!err) return false;
  const details = err.details;
  const d = details?.data?.data || details?.data || details;
  const code = d?.status_code ?? d?.data?.status_code;
  const text = String(d?.status_text || d?.data?.status_text || '').toLowerCase();
  return code === '23' || code === 23 || text.includes('lookup on the supplied token') || text.includes('token failed');
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {object} opts
 * @param {string} opts.householdId - UUID
 * @param {string} opts.tenantId - UUID
 * @param {number} opts.chargeAmount - positive, rounded to cents
 * @param {string} opts.actingUserId - UserId for ModifiedBy on token updates
 * @param {string|null} [opts.fallbackAgentId] - AgentId if primary has none
 * @param {string|null} [opts.billingPeriodStart] - ISO date for getOrCreate (admin)
 * @param {string|null} [opts.billingPeriodEnd]
 * @param {string|null} [opts.targetInvoiceId] - if set, skip getOrCreate; use this invoice id for payment + fulfill
 * @param {'charge-now'|'member-pay'} opts.mode
 * @param {string|null} [opts.prefillInvoiceNumber] - for targetInvoiceId responses
 * @param {string|null} [opts.prefillBillingPeriodStart]
 * @param {string|null} [opts.prefillBillingPeriodEnd]
 * @param {boolean} [opts.failClosedOnFulfillError] - If true, return 500 when fulfillInvoice fails after DIME success (member pay). Default false (admin: log warning only).
 * @returns {Promise<{ ok: true, data: object } | { ok: false, statusCode: number, body: object }>}
 */
async function executeHouseholdManualCharge(pool, opts) {
  const {
    householdId,
    tenantId,
    chargeAmount,
    actingUserId,
    fallbackAgentId = null,
    billingPeriodStart = null,
    billingPeriodEnd = null,
    targetInvoiceId = null,
    mode,
    prefillInvoiceNumber = null,
    prefillBillingPeriodStart = null,
    prefillBillingPeriodEnd = null,
    failClosedOnFulfillError = false,
  } = opts;

  const primaryResult = await pool
    .request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT m.MemberId, m.ProcessorCustomerId, m.AgentId
      FROM oe.Members m
      WHERE m.HouseholdId = @householdId AND m.RelationshipType = 'P'
    `);
  const primary = primaryResult.recordset?.[0];
  if (!primary) {
    return { ok: false, statusCode: 404, body: { success: false, message: 'Primary member not found' } };
  }

  let dimeCustomerId = primary.ProcessorCustomerId;
  if (!dimeCustomerId) {
    const pmResult = await pool
      .request()
      .input('memberId', sql.UniqueIdentifier, primary.MemberId)
      .query(`
        SELECT TOP 1 ProcessorCustomerId, ProcessorPaymentMethodId, PaymentMethodType,
          ProcessorToken, CardholderName, BillingAddress, BillingAddress2, BillingCity, BillingState, BillingZip
        FROM oe.MemberPaymentMethods
        WHERE MemberId = @memberId AND Status = 'Active'
      `);
    const pmRow = pmResult.recordset?.[0];
    dimeCustomerId = pmRow?.ProcessorCustomerId;
  }

  if (!dimeCustomerId) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        success: false,
        message: 'No DIME customer or payment method on file. Add a payment method first.',
      },
    };
  }

  const mpmResult = await pool
    .request()
    .input('memberId', sql.UniqueIdentifier, primary.MemberId)
    .query(`
      SELECT PaymentMethodId, ProcessorPaymentMethodId, PaymentMethodType,
        ProcessorToken, CardholderName, AccountHolderName, AccountType, BankName,
        BillingAddress, BillingAddress2, BillingCity, BillingState, BillingZip,
        RoutingNumber, RoutingNumberEncrypted, AccountNumberEncrypted,
        CardNumberEncrypted, ExpiryMonth, ExpiryYear
      FROM oe.MemberPaymentMethods
      WHERE MemberId = @memberId AND Status = 'Active'
      ORDER BY IsDefault DESC
    `);
  const mpm = mpmResult.recordset?.[0];
  if (!mpm?.ProcessorPaymentMethodId) {
    return {
      ok: false,
      statusCode: 400,
      body: { success: false, message: 'No active payment method found. Add a payment method first.' },
    };
  }

  const paymentMethodType = (mpm.PaymentMethodType || 'Card') === 'ACH' ? 'ACH' : 'Card';
  const nowUtc = new Date();
  const todayUtc = nowUtc.toISOString().slice(0, 10);
  const amountKeyPart = Number(chargeAmount).toFixed(2);
  const hhmm = nowUtc.toISOString().slice(11, 16).replace(':', '');

  let idempotencyKey;
  let invoiceNumber;
  const chargeDesc =
    mode === 'member-pay'
      ? `Member payment household ${householdId}`
      : `Manual charge for household ${householdId}`;

  if (targetInvoiceId) {
    idempotencyKey = `member-pay_${targetInvoiceId}_${householdId}_${amountKeyPart}_${todayUtc}`;
    invoiceNumber = `MEMBER-PAY-${targetInvoiceId}-${todayUtc}-${amountKeyPart}-${hhmm}`;
  } else {
    const periodPart =
      billingPeriodStart && billingPeriodEnd
        ? `${String(billingPeriodStart).slice(0, 10)}_${String(billingPeriodEnd).slice(0, 10)}`
        : 'no_period';
    idempotencyKey = `charge-now_${householdId}_${amountKeyPart}_${todayUtc}_${periodPart}`;
    invoiceNumber = `MANUAL-${householdId}-${todayUtc}-${amountKeyPart}-${hhmm}`;
  }

  const paymentPayload = {
    customerId: dimeCustomerId,
    amount: chargeAmount,
    description: chargeDesc,
    invoiceNumber,
    paymentMethodType,
    idempotencyKey,
    tenantId,
    billingAddress: (mpm.BillingAddress && String(mpm.BillingAddress).trim()) || undefined,
    billingCity: (mpm.BillingCity && String(mpm.BillingCity).trim()) || undefined,
    billingState: (mpm.BillingState && String(mpm.BillingState).trim()) || undefined,
    billingZip: (mpm.BillingZip && String(mpm.BillingZip).trim()) || undefined,
  };

  if (paymentMethodType === 'ACH') {
    const routingNumber = resolveAchRoutingForCharge(mpm.RoutingNumber, mpm.RoutingNumberEncrypted);
    let accountNumber = null;
    if (mpm.AccountNumberEncrypted) {
      try {
        const decryptedAcct = encryptionService.decryptPaymentData({
          accountNumberEncrypted: mpm.AccountNumberEncrypted,
        });
        if (decryptedAcct.accountNumber) {
          accountNumber = String(decryptedAcct.accountNumber).replace(/\D/g, '');
        }
      } catch (decryptErr) {
        console.error('❌ Failed to decrypt ACH account for manual charge:', decryptErr);
        return {
          ok: false,
          statusCode: 400,
          body: {
            success: false,
            message:
              'Failed to decrypt payment method for charge. The payment method may need to be re-added.',
          },
        };
      }
    }
    if (!routingNumber || !accountNumber) {
      return {
        ok: false,
        statusCode: 400,
        body: {
          success: false,
          message:
            'ACH payment method is missing stored account data. Please remove and re-add the payment method.',
        },
      };
    }
    const holderName = (mpm.AccountHolderName && String(mpm.AccountHolderName).trim()) || 'Account Holder';
    const nameParts = holderName.split(' ');
    paymentPayload.routingNumber = routingNumber;
    paymentPayload.accountNumber = accountNumber;
    paymentPayload.accountType = mpm.AccountType || 'Checking';
    paymentPayload.accountHolderName = holderName;
    paymentPayload.bankName = mpm.BankName || 'Bank';
    paymentPayload.billingFirstName = nameParts[0] || '';
    paymentPayload.billingLastName = (nameParts.slice(1).join(' ') || '').trim();
  } else {
    paymentPayload.paymentMethodId = mpm.ProcessorPaymentMethodId;
    paymentPayload.paymentMethodToken = mpm.ProcessorToken ? String(mpm.ProcessorToken).trim() : undefined;
    paymentPayload.cardholderName = (mpm.CardholderName && String(mpm.CardholderName).trim()) || undefined;
  }

  let paymentResult = await DimeService.processPayment(paymentPayload, tenantId);
  const tokenLookupFailure = isDimeStoredTokenLookupFailure(paymentResult);
  const hasEncryptedPan = !!mpm.CardNumberEncrypted;

  if (paymentMethodType === 'Card' && (!paymentResult.success || !paymentResult.transactionId) && tokenLookupFailure && mpm.CardNumberEncrypted) {
    try {
      const decrypted = encryptionService.decryptPaymentData({
        cardNumberEncrypted: mpm.CardNumberEncrypted,
      });
      if (decrypted.cardNumber && String(decrypted.cardNumber).replace(/\D/g, '').length >= 13) {
        const em = mpm.ExpiryMonth != null ? Number(mpm.ExpiryMonth) : null;
        const ey = mpm.ExpiryYear != null ? Number(mpm.ExpiryYear) : null;
        const expiryDate = em && ey ? `${String(em).padStart(2, '0')}/${ey}` : '12/2030';
        const holder = (mpm.CardholderName && String(mpm.CardholderName).trim()) || 'Cardholder';
        const namePartsPan = holder.split(/\s+/);
        const retryPayload = {
          customerId: dimeCustomerId,
          amount: chargeAmount,
          description: chargeDesc,
          invoiceNumber,
          paymentMethodType: 'Card',
          idempotencyKey: `${idempotencyKey}_pan_retry`,
          cardNumber: String(decrypted.cardNumber).replace(/\s/g, ''),
          expiryDate,
          cvv: '',
          cardholderName: holder,
          billingFirstName: namePartsPan[0] || '',
          billingLastName: namePartsPan.slice(1).join(' ') || '',
          billingAddress: (mpm.BillingAddress && String(mpm.BillingAddress).trim()) || undefined,
          billingAddress2: (mpm.BillingAddress2 && String(mpm.BillingAddress2).trim()) || undefined,
          billingCity: (mpm.BillingCity && String(mpm.BillingCity).trim()) || undefined,
          billingState: (mpm.BillingState && String(mpm.BillingState).trim()) || undefined,
          billingZip: (mpm.BillingZip && String(mpm.BillingZip).trim()) || undefined,
        };
        console.log('🔁 manual charge: retrying with decrypted PAN after DIME token lookup failure');
        paymentResult = await DimeService.processPayment(retryPayload, tenantId);
        if (paymentResult.success && paymentResult.transactionId) {
          const newToken =
            paymentResult.multiUseToken ||
            paymentResult.rawResponse?.data?.data?.multi_use_token ||
            paymentResult.rawResponse?.data?.multi_use_token;
          if (newToken && mpm.PaymentMethodId && actingUserId) {
            try {
              const upd = pool.request();
              upd.input('paymentMethodId', sql.UniqueIdentifier, mpm.PaymentMethodId);
              upd.input('token', sql.NVarChar, String(newToken).trim());
              upd.input('modifiedBy', sql.UniqueIdentifier, actingUserId);
              await upd.query(`
                UPDATE oe.MemberPaymentMethods
                SET ProcessorToken = @token,
                    ModifiedDate = GETUTCDATE(),
                    ModifiedBy = @modifiedBy
                WHERE PaymentMethodId = @paymentMethodId
              `);
              console.log('✅ manual charge: updated ProcessorToken from DIME multi_use_token after PAN retry');
            } catch (updErr) {
              console.error(
                '⚠️ manual charge: payment succeeded but failed to save new token:',
                updErr?.message || updErr
              );
            }
          }
        }
      }
    } catch (panErr) {
      console.error('❌ manual charge: PAN retry failed:', panErr?.message || panErr);
    }
  } else if (
    paymentMethodType === 'Card' &&
    (!paymentResult.success || !paymentResult.transactionId) &&
    tokenLookupFailure &&
    !hasEncryptedPan
  ) {
    try {
      const listRes = await DimeService.getCustomerPaymentMethods(dimeCustomerId, tenantId);
      const methods = listRes.paymentMethods || [];
      const matchPm =
        methods.find((p) => String(p.id) === String(mpm.ProcessorPaymentMethodId)) ||
        methods.find((p) => {
          const t = (p.type || '').toLowerCase();
          return t.includes('cc') || t.includes('card') || t === 'credit';
        }) ||
        methods[0];
      const freshToken = matchPm?.token;
      const oldTok = mpm.ProcessorToken ? String(mpm.ProcessorToken).trim() : '';
      if (freshToken && String(freshToken).trim() !== oldTok) {
        console.log('🔁 manual charge: retrying with token from DIME payment-method/list');
        const updTok = pool.request();
        updTok.input('paymentMethodId', sql.UniqueIdentifier, mpm.PaymentMethodId);
        updTok.input('token', sql.NVarChar, String(freshToken).trim());
        updTok.input('modifiedBy', sql.UniqueIdentifier, actingUserId);
        await updTok.query(`
          UPDATE oe.MemberPaymentMethods
          SET ProcessorToken = @token,
              ModifiedDate = GETUTCDATE(),
              ModifiedBy = @modifiedBy
          WHERE PaymentMethodId = @paymentMethodId
        `);
        mpm.ProcessorToken = String(freshToken).trim();
        const retryFromList = {
          ...paymentPayload,
          paymentMethodToken: String(freshToken).trim(),
          idempotencyKey: `${idempotencyKey}_dime_list_token`,
        };
        paymentResult = await DimeService.processPayment(retryFromList, tenantId);
      } else {
        console.warn(
          '⚠️ manual charge: token lookup failed; no encrypted PAN and no new token from DIME list.'
        );
      }
    } catch (listErr) {
      console.warn('⚠️ manual charge: DIME list refresh attempt failed:', listErr?.message || listErr);
    }
  }

  if (!paymentResult.success || !paymentResult.transactionId) {
    const noPanAfterList =
      paymentMethodType === 'Card' && tokenLookupFailure && !hasEncryptedPan;
    return {
      ok: false,
      statusCode: 400,
      body: {
        success: false,
        message: noPanAfterList
          ? 'DIME rejected the stored card token, and we could not obtain a fresh token from DIME or retry with a saved card number. Ask the member to re-add their payment method in Billing, then try again.'
          : paymentResult.error?.message || 'Payment processing failed',
        error: noPanAfterList ? { code: 'DIME_TOKEN_NO_LOCAL_PAN' } : undefined,
      },
    };
  }

  const agentId = primary.AgentId || fallbackAgentId;
  const recordStatus = resolveManualChargeRecordStatus(paymentResult);

  let chargeNowInvoiceId = targetInvoiceId || null;
  let chargeNowInvoiceInfo = null;

  if (targetInvoiceId) {
    chargeNowInvoiceInfo = {
      invoiceId: targetInvoiceId,
      invoiceNumber: prefillInvoiceNumber,
      billingPeriodStart: prefillBillingPeriodStart,
      billingPeriodEnd: prefillBillingPeriodEnd,
      created: false,
    };
  } else {
    try {
      const invoiceService = require('./invoiceService');
      let invResult;
      if (billingPeriodStart && billingPeriodEnd) {
        invResult = await invoiceService.getOrCreateInvoiceForPeriod(
          householdId,
          tenantId,
          new Date(billingPeriodStart),
          new Date(billingPeriodEnd)
        );
      } else {
        invResult = await invoiceService.getOrCreateInvoiceForPayment(householdId, tenantId, new Date());
      }
      chargeNowInvoiceId = invResult?.invoiceId || null;
      if (invResult) {
        chargeNowInvoiceInfo = {
          invoiceId: invResult.invoiceId,
          invoiceNumber: invResult.invoiceNumber || null,
          billingPeriodStart: invResult.billingPeriodStart || null,
          billingPeriodEnd: invResult.billingPeriodEnd || null,
          created: invResult.created || false,
        };
      }
    } catch (invErr) {
      console.warn('⚠️ manual charge: invoice resolve failed (non-blocking):', invErr?.message || invErr);
    }
  }

  let stored;
  try {
    stored = await PaymentDatabaseService.storePaymentRecord({
      enrollmentId: null,
      householdId,
      amount: chargeAmount,
      status: recordStatus,
      paymentMethod: paymentMethodType,
      processorTransactionId: paymentResult.transactionId,
      processorResponse: paymentResult.processorResponse
        ? JSON.stringify(paymentResult.processorResponse)
        : null,
      paymentDate: new Date(),
      agentId,
      tenantId,
      invoiceId: chargeNowInvoiceId,
      createdBy: actingUserId || null,
    });
  } catch (storeErr) {
    console.error('❌ manual charge: storePaymentRecord failed after DIME success:', storeErr?.message || storeErr);
    return {
      ok: false,
      statusCode: 500,
      body: {
        success: false,
        message:
          'Payment was approved by the processor but we could not save the payment record. Contact support with your bank statement if a charge appears.',
      },
    };
  }

  const invoiceService = require('./invoiceService');
  let dimeRecurringSynced = false;
  if (chargeNowInvoiceId && isSuccessfulPaymentRecordStatus(recordStatus)) {
    try {
      const fulfillResult = await invoiceService.fulfillInvoice(chargeNowInvoiceId, chargeAmount);
      if (fulfillResult?.applied && householdId && tenantId) {
        try {
          // Only advance/skip the recurring schedule when the invoice just paid
          // is the SAME cycle the schedule is about to charge. Paying an overdue
          // (older) invoice — or pre-paying a future one — must NOT bump a
          // still-owed upcoming charge to the next month.
          const schedRes = await pool
            .request()
            .input('householdId', sql.UniqueIdentifier, householdId)
            .query(`
              SELECT TOP 1 NextBillingDate
              FROM oe.IndividualRecurringSchedules
              WHERE HouseholdId = @householdId AND IsActive = 1
              ORDER BY CreatedDate DESC
            `);
          const scheduleNextBillingDate = schedRes.recordset?.[0]?.NextBillingDate ?? null;

          let invoiceBillingPeriodStart = chargeNowInvoiceInfo?.billingPeriodStart ?? null;
          let invoiceBillingPeriodEnd = chargeNowInvoiceInfo?.billingPeriodEnd ?? null;
          if (!invoiceBillingPeriodStart) {
            const invRes = await pool
              .request()
              .input('invoiceId', sql.UniqueIdentifier, chargeNowInvoiceId)
              .query(`
                SELECT BillingPeriodStart, BillingPeriodEnd
                FROM oe.Invoices
                WHERE InvoiceId = @invoiceId
              `);
            invoiceBillingPeriodStart = invRes.recordset?.[0]?.BillingPeriodStart ?? null;
            invoiceBillingPeriodEnd = invRes.recordset?.[0]?.BillingPeriodEnd ?? null;
          }

          const shouldSync = shouldSyncRecurringAfterManualInvoicePayment({
            scheduleNextBillingDate,
            invoiceBillingPeriodStart,
            invoiceBillingPeriodEnd,
          });

          if (shouldSync) {
            dimeRecurringSynced = await invoiceService.syncDimeRecurringForHousehold(
              pool,
              householdId,
              tenantId,
              chargeNowInvoiceId
            );
            if (dimeRecurringSynced) {
              console.log('✅ manual charge: DIME recurring aligned after invoice fulfillment', {
                mode,
                householdId,
                invoiceId: chargeNowInvoiceId,
                paymentId: stored.PaymentId,
              });
            }
          } else {
            console.log('ℹ️ manual charge: left DIME recurring intact (paid invoice is not the upcoming cycle — overdue/back or pre-paid future)', {
              mode,
              householdId,
              invoiceId: chargeNowInvoiceId,
              paymentId: stored.PaymentId,
              scheduleNextBillingDate,
              invoiceBillingPeriodStart,
              invoiceBillingPeriodEnd,
            });
          }
        } catch (dimeSyncErr) {
          console.error(
            '⚠️ manual charge: DIME recurring sync failed after invoice fulfillment (duplicate recurring charge risk):',
            dimeSyncErr?.message || dimeSyncErr,
            { mode, householdId, chargeNowInvoiceId, paymentId: stored.PaymentId }
          );
        }
      }
    } catch (e) {
      console.error(
        '⚠️ manual charge: invoice fulfillment failed (non-blocking if admin):',
        e?.message || e,
        { householdId, chargeNowInvoiceId, paymentId: stored?.PaymentId }
      );
      if (failClosedOnFulfillError) {
        return {
          ok: false,
          statusCode: 500,
          body: {
            success: false,
            message:
              'Payment was processed but we could not update your invoice. Contact support; reference payment ID.',
            data: {
              paymentId: stored.PaymentId,
              amount: chargeAmount,
              transactionId: paymentResult.transactionId,
              invoice: chargeNowInvoiceInfo,
              paymentRecordStatus: recordStatus,
            },
          },
        };
      }
    }
  }

  console.log('✅ manual charge', {
    mode,
    householdId,
    tenantId,
    userId: actingUserId,
    invoiceId: chargeNowInvoiceId,
    paymentId: stored.PaymentId,
    amount: chargeAmount,
    transactionId: paymentResult.transactionId,
    recordStatus,
  });

  return {
    ok: true,
    data: {
      paymentId: stored.PaymentId,
      amount: chargeAmount,
      transactionId: paymentResult.transactionId,
      invoice: chargeNowInvoiceInfo,
      paymentRecordStatus: recordStatus,
      dimeRecurringSynced,
    },
  };
}

module.exports = {
  executeHouseholdManualCharge,
  shouldSyncRecurringAfterManualInvoicePayment,
  resolveManualChargeRecordStatus,
};

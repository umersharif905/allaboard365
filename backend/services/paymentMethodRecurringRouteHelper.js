'use strict';

const { sql } = require('../config/database');
const invoiceService = require('./invoiceService');

/**
 * Processor PM id for the member's current default (before a PM change).
 */
async function fetchPreviousDefaultProcessorPmId(pool, memberId) {
  if (!memberId) return null;
  const r = await pool.request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .query(`
      SELECT TOP 1 ProcessorPaymentMethodId
      FROM oe.MemberPaymentMethods
      WHERE MemberId = @memberId AND Status = 'Active' AND IsDefault = 1
      ORDER BY ModifiedDate DESC
    `);
  const id = r.recordset?.[0]?.ProcessorPaymentMethodId;
  return id ? String(id).trim() : null;
}

/**
 * Non-fatal DIME recurring recreation + outstanding-invoice payload for PM-save responses.
 */
async function runPaymentMethodRecurringSync(pool, {
  householdId,
  tenantId,
  paymentMethodId,
  previousProcessorPaymentMethodId = null,
  forceRecreate = false,
}) {
  if (!householdId || !tenantId || !paymentMethodId) {
    return {};
  }
  return invoiceService.syncRecurringAfterPaymentMethodChange(pool, {
    householdId,
    tenantId,
    newPaymentMethodId: paymentMethodId,
    previousProcessorPaymentMethodId,
    forceRecreate: !!forceRecreate,
  });
}

module.exports = {
  fetchPreviousDefaultProcessorPmId,
  runPaymentMethodRecurringSync,
};

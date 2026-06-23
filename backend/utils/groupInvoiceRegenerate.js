/**
 * Snapshot / restore group invoices around payment-manager regenerate.
 * Prevents losing the invoice when manual-run fails after DELETE.
 */

const axios = require('axios');
const { sql } = require('../config/database');

/** Production payment manager (allaboard); override with PAYMENT_MANAGER_URL. */
const PROD_PAYMENT_MANAGER_FALLBACK =
  'https://allaboard-payment-manager-aebfesgwffcnafb3.centralus-01.azurewebsites.net';

function resolvePaymentManagerUrl() {
  const configured = (process.env.PAYMENT_MANAGER_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') return PROD_PAYMENT_MANAGER_FALLBACK;
  return 'http://localhost:7071';
}

function resolvePaymentManagerApiKey() {
  return process.env.PAYMENT_MANAGER_ADMIN_API_KEY || process.env.ADMIN_API_KEY || null;
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} invoiceId
 * @param {string} groupId
 */
async function loadGroupInvoiceRegenerateSnapshot(pool, invoiceId, groupId) {
  const invoiceResult = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`SELECT * FROM oe.Invoices WHERE InvoiceId = @invoiceId AND GroupId = @groupId`);

  if (!invoiceResult.recordset.length) {
    return null;
  }

  const lineItemsResult = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`SELECT * FROM oe.InvoiceLineItems WHERE InvoiceId = @invoiceId ORDER BY LineNumber`);

  const plansResult = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`
      SELECT PlanId, InvoiceId
      FROM oe.GroupRecurringPaymentPlans
      WHERE InvoiceId = @invoiceId
    `);

  return {
    invoice: invoiceResult.recordset[0],
    lineItems: lineItemsResult.recordset || [],
    recurringPlans: plansResult.recordset || []
  };
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {{ invoice: object, lineItems: object[], recurringPlans: object[] }} snapshot
 */
async function restoreGroupInvoiceSnapshot(pool, snapshot) {
  const inv = snapshot.invoice;
  const existing = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, inv.InvoiceId)
    .query(`SELECT 1 AS n FROM oe.Invoices WHERE InvoiceId = @invoiceId`);

  if (existing.recordset.length > 0) {
    return { restored: false, reason: 'invoice_already_exists' };
  }

  await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, inv.InvoiceId)
    .input('groupId', sql.UniqueIdentifier, inv.GroupId)
    .input('locationId', sql.UniqueIdentifier, inv.LocationId)
    .input('householdId', sql.UniqueIdentifier, inv.HouseholdId)
    .input('tenantId', sql.UniqueIdentifier, inv.TenantId)
    .input('invoiceNumber', sql.NVarChar(50), inv.InvoiceNumber)
    .input('invoiceDate', sql.Date, inv.InvoiceDate)
    .input('dueDate', sql.Date, inv.DueDate)
    .input('billingPeriodStart', sql.Date, inv.BillingPeriodStart)
    .input('billingPeriodEnd', sql.Date, inv.BillingPeriodEnd)
    .input('subTotal', sql.Decimal(12, 2), inv.SubTotal)
    .input('taxAmount', sql.Decimal(12, 2), inv.TaxAmount)
    .input('totalAmount', sql.Decimal(12, 2), inv.TotalAmount)
    .input('paidAmount', sql.Decimal(12, 2), inv.PaidAmount)
    .input('status', sql.NVarChar(50), inv.Status)
    .input('paymentDueDate', sql.Date, inv.PaymentDueDate)
    .input('invoiceType', sql.NVarChar(20), inv.InvoiceType)
    .input('pdfUrl', sql.NVarChar(500), inv.PdfUrl)
    .input('paymentDate', sql.DateTime2, inv.PaymentDate)
    .input('paymentMethod', sql.NVarChar(100), inv.PaymentMethod)
    .input('paymentReceivedDate', sql.DateTime2, inv.PaymentReceivedDate)
    .input('creditAmount', sql.Decimal(12, 2), inv.CreditAmount)
    .input('netRate', sql.Decimal(18, 6), inv.NetRate)
    .input('overrideRate', sql.Decimal(18, 6), inv.OverrideRate)
    .input('commission', sql.Decimal(18, 6), inv.Commission)
    .input('systemFees', sql.Decimal(18, 6), inv.SystemFees)
    .input('processingFeeAmount', sql.Decimal(18, 6), inv.ProcessingFeeAmount)
    .input('setupFee', sql.Decimal(18, 6), inv.SetupFee)
    .input('productCommissions', sql.NVarChar(sql.MAX), inv.ProductCommissions)
    .input('productVendorAmounts', sql.NVarChar(sql.MAX), inv.ProductVendorAmounts)
    .input('productOwnerAmounts', sql.NVarChar(sql.MAX), inv.ProductOwnerAmounts)
    .input('createdDate', sql.DateTime2, inv.CreatedDate)
    .input('modifiedDate', sql.DateTime2, inv.ModifiedDate)
    .input('createdBy', sql.UniqueIdentifier, inv.CreatedBy)
    .input('modifiedBy', sql.UniqueIdentifier, inv.ModifiedBy)
    .query(`
      INSERT INTO oe.Invoices (
        InvoiceId, GroupId, LocationId, HouseholdId, TenantId, InvoiceNumber,
        InvoiceDate, DueDate, BillingPeriodStart, BillingPeriodEnd,
        SubTotal, TaxAmount, TotalAmount, PaidAmount, Status, PaymentDueDate,
        InvoiceType, PdfUrl, PaymentDate, PaymentMethod, PaymentReceivedDate,
        CreditAmount, NetRate, OverrideRate, Commission, SystemFees,
        ProcessingFeeAmount, SetupFee, ProductCommissions, ProductVendorAmounts,
        ProductOwnerAmounts, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
      ) VALUES (
        @invoiceId, @groupId, @locationId, @householdId, @tenantId, @invoiceNumber,
        @invoiceDate, @dueDate, @billingPeriodStart, @billingPeriodEnd,
        @subTotal, @taxAmount, @totalAmount, @paidAmount, @status, @paymentDueDate,
        @invoiceType, @pdfUrl, @paymentDate, @paymentMethod, @paymentReceivedDate,
        @creditAmount, @netRate, @overrideRate, @commission, @systemFees,
        @processingFeeAmount, @setupFee, @productCommissions, @productVendorAmounts,
        @productOwnerAmounts, @createdDate, @modifiedDate, @createdBy, @modifiedBy
      )
    `);

  for (const line of snapshot.lineItems) {
    await pool.request()
      .input('lineItemId', sql.UniqueIdentifier, line.LineItemId)
      .input('invoiceId', sql.UniqueIdentifier, line.InvoiceId)
      .input('lineNumber', sql.Int, line.LineNumber)
      .input('productId', sql.UniqueIdentifier, line.ProductId)
      .input('description', sql.NVarChar(500), line.Description)
      .input('quantity', sql.Decimal(10, 2), line.Quantity)
      .input('unitPrice', sql.Decimal(12, 2), line.UnitPrice)
      .input('discountAmount', sql.Decimal(12, 2), line.DiscountAmount)
      .input('taxAmount', sql.Decimal(12, 2), line.TaxAmount)
      .input('lineTotal', sql.Decimal(12, 2), line.LineTotal)
      .input('memberId', sql.UniqueIdentifier, line.MemberId)
      .input('createdDate', sql.DateTime2, line.CreatedDate)
      .query(`
        INSERT INTO oe.InvoiceLineItems (
          LineItemId, InvoiceId, LineNumber, ProductId, Description,
          Quantity, UnitPrice, DiscountAmount, TaxAmount, LineTotal, MemberId, CreatedDate
        ) VALUES (
          @lineItemId, @invoiceId, @lineNumber, @productId, @description,
          @quantity, @unitPrice, @discountAmount, @taxAmount, @lineTotal, @memberId, @createdDate
        )
      `);
  }

  for (const plan of snapshot.recurringPlans) {
    await pool.request()
      .input('planId', sql.UniqueIdentifier, plan.PlanId)
      .input('invoiceId', sql.UniqueIdentifier, plan.InvoiceId)
      .query(`
        UPDATE oe.GroupRecurringPaymentPlans
        SET InvoiceId = @invoiceId, ModifiedDate = GETUTCDATE()
        WHERE PlanId = @planId
      `);
  }

  return { restored: true, invoiceId: inv.InvoiceId, invoiceNumber: inv.InvoiceNumber };
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} invoiceId
 */
async function deleteGroupInvoiceForRegenerate(pool, invoiceId) {
  await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`UPDATE oe.GroupRecurringPaymentPlans SET InvoiceId = NULL WHERE InvoiceId = @invoiceId`);

  await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`DELETE FROM oe.InvoiceLineItems WHERE InvoiceId = @invoiceId`);

  await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`DELETE FROM oe.Invoices WHERE InvoiceId = @invoiceId`);
}

/**
 * @param {string} groupId
 * @param {string} billingDateStr YYYY-MM-DD
 */
async function callPaymentManagerManualRun(groupId, billingDateStr) {
  const paymentManagerUrl = resolvePaymentManagerUrl();
  const apiKey = resolvePaymentManagerApiKey();
  const manualRunUrl = `${paymentManagerUrl}/api/manual-run?groupId=${encodeURIComponent(groupId)}&billingDate=${encodeURIComponent(billingDateStr)}`;

  try {
    const response = await axios.post(manualRunUrl, {}, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
      timeout: 120000
    });
    return { ok: true, response, paymentManagerUrl };
  } catch (pmError) {
    const isConnRefused = pmError.code === 'ECONNREFUSED' || pmError.cause?.code === 'ECONNREFUSED';
    const isDns = pmError.code === 'ENOTFOUND' || pmError.cause?.code === 'ENOTFOUND';
    let hint = '';
    if (isConnRefused) {
      hint = ' Payment manager (oe_payment_manager) is not running. Locally: run `func start` in oe_payment_manager.';
    } else if (isDns) {
      hint = ' PAYMENT_MANAGER_URL hostname does not resolve — use allaboard-payment-manager or localhost:7071.';
    } else if (!apiKey) {
      hint = ' PAYMENT_MANAGER_ADMIN_API_KEY is not configured on the API.';
    }
    return {
      ok: false,
      error: pmError,
      message: `Payment manager unreachable: ${pmError.message || pmError.code || 'Unknown error'}.${hint}`,
      paymentManagerUrl,
      isConnRefused,
      isDns
    };
  }
}

function paymentManagerRunFailed(manualRunResponse) {
  return manualRunResponse.status !== 200 || !manualRunResponse.data?.success;
}

module.exports = {
  PROD_PAYMENT_MANAGER_FALLBACK,
  resolvePaymentManagerUrl,
  resolvePaymentManagerApiKey,
  loadGroupInvoiceRegenerateSnapshot,
  restoreGroupInvoiceSnapshot,
  deleteGroupInvoiceForRegenerate,
  callPaymentManagerManualRun,
  paymentManagerRunFailed
};

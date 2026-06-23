'use strict';

const sql = require('mssql');
const crypto = require('crypto');
const { getPool } = require('../config/database');
const {
  invoiceDueDateBeforeTenantLocalTodayPredicate,
  invoiceDueDateOnOrAfterTenantLocalTodayPredicate
} = require('../utils/invoiceTenantCalendarSql');
const { requireShared } = require('../config/shared-modules');
const { isSuccessfulPaymentRecordStatus } = requireShared('payment-status');
const { resolveProcessingFeeTotalFromParts } = requireShared('payment-product-snapshots');
const DimeService = require('./dimeService');
const { getCohortFromDate, getBillingPeriodForCohort } = require('../utils/billingCohort');
const { recalcStatusFromAmounts } = require('./householdCredits.service');
const { SHOW_INVOICE_PROCESSING_FEES_LINE_ITEM } = require('../config/invoiceDisplayFlags');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spread invoice PDF processing fee across premium lines (proportional; last line absorbs rounding). */
function mergeProcessingFeesIntoPremiumLines(lines, feeTotal) {
  const fee = parseFloat(feeTotal) || 0;
  if (!lines.length || fee <= 0.005) return;
  const originals = lines.map((l) => parseFloat(l.amount) || 0);
  const base = originals.reduce((s, a) => s + a, 0);
  if (base <= 0.005) return;
  let distributed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1) {
      lines[i].amount = Math.round((originals[i] + fee - distributed) * 100) / 100;
    } else {
      const add = Math.round(fee * (originals[i] / base) * 100) / 100;
      lines[i].amount = Math.round((originals[i] + add) * 100) / 100;
      distributed += add;
    }
  }
}

function endOfMonth(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

function startOfMonth(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function sameDayNextMonth(baseDay, year, month) {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(baseDay, lastDay);
  return new Date(Date.UTC(year, month, day));
}

/** Advance a calendar date by one month (UTC), preserving day-of-month with clamping. */
function addOneMonthUtc(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return sameDayNextMonth(d.getUTCDate(), d.getUTCFullYear(), d.getUTCMonth() + 1);
}

/**
 * Compute the billing period for a member's first invoice given their
 * effective date. Period depends on cohort (1st vs 15th). Used by
 * `createInvoiceForEnrollment` where the first invoice's window must align
 * with the cohort's billing cycle (5/15-6/14 for FIFTEENTH cohort).
 * @param {Date} effectiveDate
 * @returns {{ start: Date, end: Date }}
 */
function computeBillingPeriodFromEffectiveDate(effectiveDate) {
  const cohort = getCohortFromDate(effectiveDate);
  return getBillingPeriodForCohort(cohort, effectiveDate);
}

/**
 * Earliest unified billing anchor for individual-billed households: active Product/Bundle,
 * non-terminated, no group (same filter as nightly + billing integrity).
 * @returns {Promise<{ anchorDate: Date, anchorDay: number } | null>}
 */
async function getHouseholdBillingAnchor(pool, householdId) {
  const enrollResult = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('allProductsGuid', sql.NVarChar(36), ALL_PRODUCTS_GUID)
    .query(`
      SELECT TOP 1 e.EffectiveDate
      FROM oe.Enrollments e
      WHERE e.HouseholdId = @householdId
        AND e.Status = N'Active'
        AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        AND e.EnrollmentType IN (N'Product', N'Bundle')
        AND (e.GroupID IS NULL OR CAST(e.GroupID AS NVARCHAR(36)) = @allProductsGuid)
      ORDER BY e.EffectiveDate ASC
    `);
  const eff = enrollResult.recordset?.[0]?.EffectiveDate;
  if (!eff) return null;
  const anchorDate = new Date(eff);
  const anchorDay = anchorDate.getUTCDate();
  return { anchorDate, anchorDay };
}

/**
 * Individual invoice period containing refDate: anchor-day start in UTC through end of that calendar month.
 * If refDate is before this month's anchor, period is previous month's anchor … EOM.
 * @returns {{ bpStart: Date, bpEnd: Date }}
 */
function anchorPeriodContainingReferenceDate(anchorDay, refDate) {
  const r = new Date(refDate);
  const y = r.getUTCFullYear();
  const m = r.getUTCMonth();
  const bpStartThis = sameDayNextMonth(anchorDay, y, m);
  const rDayStartMs = Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate());
  let bpStart;
  if (rDayStartMs >= bpStartThis.getTime()) {
    bpStart = bpStartThis;
  } else {
    let py = y;
    let pm = m - 1;
    if (pm < 0) {
      pm = 11;
      py -= 1;
    }
    bpStart = sameDayNextMonth(anchorDay, py, pm);
  }
  return { bpStart, bpEnd: endOfMonth(bpStart) };
}

async function getNextInvoiceNumber(pool) {
  try {
    const result = await pool.request()
      .output('InvoiceNumber', sql.NVarChar(50))
      .execute('oe.sp_GetNextInvoiceNumber');
    return result.output.InvoiceNumber || `INV-${Date.now()}`;
  } catch {
    return `INV-${Date.now()}`;
  }
}

// ---------------------------------------------------------------------------
// computeTotalFromEnrollments
// ---------------------------------------------------------------------------

/**
 * Monthly due = SUM(oe.Enrollments.PremiumAmount). IncludedPaymentProcessingFeeAmount
 * is display-only metadata and must not be added to totals.
 */
function monthlyDueFromEnrollmentSums({ premiumSum }) {
  return Math.round((parseFloat(premiumSum) || 0) * 100) / 100;
}

async function computeTotalFromEnrollments(pool, householdId, billingPeriodStart, billingPeriodEnd) {
  const result = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('bpStart', sql.DateTime, billingPeriodStart)
    .input('bpEnd', sql.DateTime, billingPeriodEnd)
    .query(`
      SELECT COALESCE(SUM(COALESCE(e.PremiumAmount, 0)), 0) AS PremiumSum
      FROM oe.Enrollments e
      WHERE e.HouseholdId = @householdId
        AND e.EffectiveDate <= @bpEnd
        AND (e.TerminationDate IS NULL OR e.TerminationDate > @bpStart)
        AND e.Status NOT IN ('Cancelled', 'Declined')
    `);
  const row = result.recordset[0] || {};
  const totalAmount = monthlyDueFromEnrollmentSums({ premiumSum: row.PremiumSum });
  return { totalAmount };
}

const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * @deprecated PDF/display helper only. Billing authority is PremiumAmount alone
 * (see monthlyDueFromEnrollmentSums / includedFeeDeprecation.js).
 */
function displayPremiumFromEnrollmentRow(row) {
  return (
    (parseFloat(row.PremiumAmount) || 0) +
    (parseFloat(row.IncludedPaymentProcessingFeeAmount) || 0) +
    (parseFloat(row.IncludedSystemFeeAmount) || 0)
  );
}

/**
 * Line items for Individual invoice PDF — aligns with Plans tab grouping:
 * bundles → one row with bundle product name + combined premium (incl. rolled-in fees on components);
 * standalone products aggregated by ProductId; Contribution excluded (same as plan wizard);
 * fee enrollments → Processing Fees / Setup Fees buckets like premium summary on Plans tab.
 */
async function getIndividualInvoicePdfLineItems(pool, householdId, billingPeriodStart, billingPeriodEnd) {
  const result = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('bpStart', sql.DateTime, billingPeriodStart)
    .input('bpEnd', sql.DateTime, billingPeriodEnd)
    .query(`
      SELECT
        e.EnrollmentId,
        e.EnrollmentType,
        e.Status,
        e.PremiumAmount,
        e.IncludedPaymentProcessingFeeAmount,
        e.IncludedSystemFeeAmount,
        e.ProductId,
        e.ProductBundleID,
        p.Name AS ProductName,
        pb.Name AS BundleProductName
      FROM oe.Enrollments e
      LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
      LEFT JOIN oe.Products pb ON e.ProductBundleID = pb.ProductId
      WHERE e.HouseholdId = @householdId
        AND e.EffectiveDate <= @bpEnd
        AND (e.TerminationDate IS NULL OR e.TerminationDate > @bpStart)
        AND e.Status NOT IN ('Cancelled', 'Declined')
      ORDER BY e.EnrollmentType, pb.Name, p.Name
    `);

  const rows = result.recordset || [];
  const lines = [];

  const feeTypesProcessing = new Set(['PaymentProcessingFee', 'ProcessingFee', 'SystemFee']);
  let processingFeesTotal = 0;
  let setupFeesTotal = 0;

  const includedOnProducts = rows.reduce((sum, r) => {
    const t = r.EnrollmentType;
    if (t && t !== 'Product') return sum;
    const pid = r.ProductId ? String(r.ProductId) : '';
    if (!pid || pid.toLowerCase() === ALL_PRODUCTS_GUID) return sum;
    return sum + (parseFloat(r.IncludedPaymentProcessingFeeAmount) || 0);
  }, 0);
  let ppfOnFeeRow = 0;
  for (const r of rows) {
    if (r.EnrollmentType === 'PaymentProcessingFee') {
      ppfOnFeeRow += parseFloat(r.PremiumAmount) || 0;
    }
  }
  const { isLegacyFullPpfRow } = resolveProcessingFeeTotalFromParts(includedOnProducts, ppfOnFeeRow);

  const productRows = rows.filter((r) => {
    const t = r.EnrollmentType;
    if (t === 'Contribution') return false;
    if (feeTypesProcessing.has(t) || t === 'SetupFee') {
      const amt = displayPremiumFromEnrollmentRow(r);
      if (t === 'SetupFee') setupFeesTotal += amt;
      else processingFeesTotal += amt;
      return false;
    }
    if (t && t !== 'Product') return false;
    const pid = r.ProductId ? String(r.ProductId) : '';
    if (!pid || pid.toLowerCase() === ALL_PRODUCTS_GUID) return false;
    return true;
  });

  const bundleAccum = new Map();
  const individualAccum = new Map();

  for (const r of productRows) {
    const premium = isLegacyFullPpfRow
      ? (parseFloat(r.PremiumAmount) || 0) + (parseFloat(r.IncludedSystemFeeAmount) || 0)
      : displayPremiumFromEnrollmentRow(r);
    const bundleId = r.ProductBundleID ? String(r.ProductBundleID) : '';
    if (bundleId && bundleId.toLowerCase() !== ALL_PRODUCTS_GUID) {
      const prev = bundleAccum.get(bundleId) || {
        description: r.BundleProductName || 'Bundle',
        amount: 0
      };
      prev.amount += premium;
      if (r.BundleProductName) prev.description = r.BundleProductName;
      bundleAccum.set(bundleId, prev);
    } else {
      const pid = String(r.ProductId);
      const name = r.ProductName || 'Product';
      const prev = individualAccum.get(pid) || { description: name, amount: 0 };
      prev.amount += premium;
      prev.description = name;
      individualAccum.set(pid, prev);
    }
  }

  const bundleLines = [...bundleAccum.values()]
    .filter((x) => x.amount > 0)
    .sort((a, b) => a.description.localeCompare(b.description))
    .map((x) => ({
      description: `${x.description} (Bundle)`,
      quantity: 1,
      amount: Math.round(x.amount * 100) / 100
    }));

  const individualLines = [...individualAccum.values()]
    .filter((x) => x.amount > 0)
    .sort((a, b) => a.description.localeCompare(b.description))
    .map((x) => ({
      description: x.description,
      quantity: 1,
      amount: Math.round(x.amount * 100) / 100
    }));

  lines.push(...bundleLines, ...individualLines);

  if (
    !SHOW_INVOICE_PROCESSING_FEES_LINE_ITEM &&
    processingFeesTotal > 0.005 &&
    lines.length > 0
  ) {
    mergeProcessingFeesIntoPremiumLines(lines, processingFeesTotal);
  } else if (
    !SHOW_INVOICE_PROCESSING_FEES_LINE_ITEM &&
    processingFeesTotal > 0.005 &&
    lines.length === 0
  ) {
    lines.push({
      description: 'Monthly Premium',
      quantity: 1,
      amount: Math.round(processingFeesTotal * 100) / 100
    });
  }

  if (SHOW_INVOICE_PROCESSING_FEES_LINE_ITEM && processingFeesTotal > 0.005) {
    lines.push({
      description: 'Processing Fees',
      quantity: 1,
      amount: Math.round(processingFeesTotal * 100) / 100
    });
  }
  if (setupFeesTotal > 0.005) {
    lines.push({
      description: 'Setup Fees (One-time)',
      quantity: 1,
      amount: Math.round(setupFeesTotal * 100) / 100
    });
  }

  const subtotalFromLines = lines.reduce((s, l) => s + l.amount, 0);
  return { lines, subtotalFromLines };
}

// ---------------------------------------------------------------------------
// computeInvoiceBreakdowns – populate Phase 2 financial breakdown columns
// Uses the same shared helpers that write breakdowns onto oe.Payments at
// charge time. Returns the 9 column values or null if context is missing.
// ---------------------------------------------------------------------------

async function computeInvoiceBreakdowns(pool, { householdId, groupId, periodStart, periodEnd }) {
  const snapshots = requireShared('payment-product-snapshots');
  try {
    if (householdId) {
      const asOf = periodEnd || new Date();
      const built = await snapshots.buildHouseholdProductSnapshots(pool, householdId, asOf, null);
      const pricing = await snapshots.getPricingFields(pool, null, householdId, null, asOf);
      const fees = await snapshots.getHouseholdFeeBucketsAsOf(pool, householdId, asOf);
      return {
        netRate: pricing.netRate,
        overrideRate: pricing.overrideRate,
        commission: pricing.commission,
        systemFees: fees.systemFees,
        processingFeeAmount: fees.processingFeeAmount,
        setupFee: fees.setupFee,
        productCommissions: built?.productCommissionsJSON || null,
        productVendorAmounts: built?.productVendorAmountsJSON || null,
        productOwnerAmounts: built?.productOwnerAmountsJSON || null,
      };
    }
    if (groupId && periodStart && periodEnd) {
      const built = await snapshots.buildGroupProductSnapshotsForPeriod(pool, groupId, periodStart, periodEnd, null);
      const pricing = await snapshots.getPricingFields(pool, groupId, null, null, null, { periodStart, periodEnd });
      const fees = await snapshots.getGroupFeeBucketsForPeriod(pool, groupId, periodStart, periodEnd);
      return {
        netRate: pricing.netRate,
        overrideRate: pricing.overrideRate,
        commission: pricing.commission,
        systemFees: fees.systemFees,
        processingFeeAmount: fees.processingFeeAmount,
        setupFee: fees.setupFee,
        productCommissions: built?.productCommissionsJSON || null,
        productVendorAmounts: built?.productVendorAmountsJSON || null,
        productOwnerAmounts: built?.productOwnerAmountsJSON || null,
      };
    }
  } catch (e) {
    console.warn('[computeInvoiceBreakdowns] Failed:', e.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Self-healing: link orphaned payments to an invoice
// ---------------------------------------------------------------------------

// Prepay orphan-matching window (days BEFORE BillingPeriodStart). Guarded by
// SELF_HEAL_PREPAY_ENABLED env flag so the behavior can be rolled back instantly.
const PREPAY_WINDOW_DAYS = 45;
const PREPAY_AMOUNT_TOLERANCE = 0.50;

async function selfHealInvoice(pool, invoiceId, householdId, billingPeriodStart, billingPeriodEnd) {
  // In-period matches (payment date falls inside the invoice's billing window,
  // with a 15-day grace after BillingPeriodEnd). This is the original behavior.
  const orphaned = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('bpStart', sql.DateTime, billingPeriodStart)
    .input('bpEnd', sql.DateTime, billingPeriodEnd)
    .query(`
      SELECT PaymentId, Amount
      FROM oe.Payments
      WHERE InvoiceId IS NULL
        AND HouseholdId = @householdId
        AND GroupId IS NULL
        AND PaymentDate >= @bpStart
        AND PaymentDate <= DATEADD(day, 15, @bpEnd)
        AND Status IN ('Completed', 'succeeded', 'Success')
    `);

  const rows = [...orphaned.recordset];

  // Optional prepay window — payments made up to PREPAY_WINDOW_DAYS BEFORE
  // BillingPeriodStart (e.g., sign-up on March 25 for April 1 coverage).
  // Requires: unambiguous invoice match for the payment, and amount within
  // tolerance of the invoice remaining balance.
  if (process.env.SELF_HEAL_PREPAY_ENABLED === 'true') {
    try {
      const remaining = await pool.request()
        .input('invoiceId', sql.UniqueIdentifier, invoiceId)
        .query(`
          SELECT TotalAmount - COALESCE(PaidAmount, 0) AS RemainingBalance,
                 Status
          FROM oe.Invoices WHERE InvoiceId = @invoiceId
        `);
      const invRow = remaining.recordset[0];
      const invStatus = invRow?.Status;
      const remainingBalance = parseFloat(invRow?.RemainingBalance) || 0;

      if (invStatus && ['Unpaid', 'Partial', 'Overdue'].includes(invStatus) && remainingBalance > 0) {
        const prepay = await pool.request()
          .input('householdId', sql.UniqueIdentifier, householdId)
          .input('bpStart', sql.DateTime, billingPeriodStart)
          .input('windowDays', sql.Int, PREPAY_WINDOW_DAYS)
          .input('remaining', sql.Decimal(12, 2), remainingBalance)
          .input('tolerance', sql.Decimal(12, 2), PREPAY_AMOUNT_TOLERANCE)
          .query(`
            SELECT p.PaymentId, p.Amount
            FROM oe.Payments p
            WHERE p.InvoiceId IS NULL
              AND p.HouseholdId = @householdId
              AND p.GroupId IS NULL
              AND p.Status IN ('Completed', 'succeeded', 'Success')
              AND (p.TransactionType IS NULL OR p.TransactionType = 'Payment')
              AND DATEDIFF(day, p.PaymentDate, @bpStart) BETWEEN 0 AND @windowDays
              AND ABS(p.Amount - @remaining) <= @tolerance
              -- Unambiguous: this payment must have exactly ONE candidate
              -- invoice for the same household in the prepay window.
              AND (
                SELECT COUNT(*) FROM oe.Invoices i2
                WHERE i2.HouseholdId = p.HouseholdId
                  AND i2.InvoiceType = N'Individual'
                  AND i2.Status IN (N'Unpaid', N'Partial', N'Overdue')
                  AND DATEDIFF(day, p.PaymentDate, i2.BillingPeriodStart) BETWEEN 0 AND @windowDays
                  AND ABS(p.Amount - (i2.TotalAmount - COALESCE(i2.PaidAmount, 0))) <= @tolerance
              ) = 1
          `);
        // De-dup against in-period matches (shouldn't overlap, but be safe).
        const seen = new Set(rows.map(r => r.PaymentId.toString()));
        for (const r of prepay.recordset) {
          if (!seen.has(r.PaymentId.toString())) rows.push(r);
        }
      }
    } catch (err) {
      console.warn('[selfHealInvoice] prepay-match query failed (non-blocking):', err.message);
    }
  }

  if (!rows.length) return { linked: 0, paidAmount: 0 };

  let linkedTotal = 0;
  for (const row of rows) {
    await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('paymentId', sql.UniqueIdentifier, row.PaymentId)
      .query(`UPDATE oe.Payments SET InvoiceId = @invoiceId WHERE PaymentId = @paymentId AND InvoiceId IS NULL`);
    linkedTotal += parseFloat(row.Amount) || 0;
  }

  if (linkedTotal > 0) {
    // Cap PaidAmount at TotalAmount (matches fulfillInvoice). Surplus is
    // captured by the credits detector (Phase 1) as OverpaymentRecognized
    // entries on oe.HouseholdCreditEntries — never lost.
    const snap = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .query(`
        SELECT TotalAmount, PaidAmount, CreditAmount, Status
        FROM oe.Invoices WHERE InvoiceId = @invoiceId
      `);
    const s = snap.recordset[0];
    const totalAmt = parseFloat(s?.TotalAmount) || 0;
    const prevPaidAmt = parseFloat(s?.PaidAmount) || 0;
    const creditAmt = parseFloat(s?.CreditAmount) || 0;
    const newPaidAmt = Math.min(totalAmt, prevPaidAmt + linkedTotal);
    const newInvoiceStatus = recalcStatusFromAmounts(totalAmt, newPaidAmt, creditAmt, s?.Status);

    await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('paidAmount', sql.Decimal(12, 2), newPaidAmt)
      .input('status', sql.NVarChar(50), newInvoiceStatus)
      .query(`
        UPDATE oe.Invoices
        SET PaidAmount = @paidAmount,
            Status = @status,
            PaymentReceivedDate = CASE WHEN @status = N'Paid' THEN GETUTCDATE() ELSE PaymentReceivedDate END,
            ModifiedDate = GETUTCDATE()
        WHERE InvoiceId = @invoiceId
      `);
  }

  return { linked: rows.length, paidAmount: linkedTotal };
}

// ---------------------------------------------------------------------------
// createInvoiceForEnrollment
// ---------------------------------------------------------------------------

async function createInvoiceForEnrollment(householdId, tenantId, effectiveDate) {
  const pool = await getPool();
  const bpStart = new Date(effectiveDate);
  // Cohort-aware period: 1st → 1st–EOM, 15th → 15th–14th-of-next-month.
  // Legacy effective dates that are not exactly day 1 or 15 fall back to
  // calendar month-end so old data still produces a sensible invoice.
  let bpEnd;
  try {
    bpEnd = computeBillingPeriodFromEffectiveDate(bpStart).end;
  } catch {
    bpEnd = endOfMonth(bpStart);
  }

  const existing = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('bpStart', sql.DateTime, bpStart)
    .input('bpEnd', sql.DateTime, bpEnd)
    .query(`
      SELECT InvoiceId, InvoiceNumber, Status, PaidAmount, TotalAmount
      FROM oe.Invoices
      WHERE HouseholdId = @householdId
        AND InvoiceType = N'Individual'
        AND BillingPeriodStart = @bpStart
        AND BillingPeriodEnd = @bpEnd
    `);

  if (existing.recordset.length > 0) {
    const inv = existing.recordset[0];
    await selfHealInvoice(pool, inv.InvoiceId, householdId, bpStart, bpEnd);
    return { invoiceId: inv.InvoiceId, invoiceNumber: inv.InvoiceNumber || null, alreadyFulfilled: inv.Status === 'Paid' };
  }

  const { totalAmount } = await computeTotalFromEnrollments(pool, householdId, bpStart, bpEnd);
  const breakdowns = await computeInvoiceBreakdowns(pool, { householdId, periodStart: bpStart, periodEnd: bpEnd });
  const invoiceId = crypto.randomUUID();
  const invoiceNumber = await getNextInvoiceNumber(pool);

  await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('invoiceNumber', sql.NVarChar(50), invoiceNumber)
    .input('invoiceDate', sql.Date, bpStart)
    .input('dueDate', sql.Date, bpStart)
    .input('bpStart', sql.Date, bpStart)
    .input('bpEnd', sql.Date, bpEnd)
    .input('totalAmount', sql.Decimal(12, 2), totalAmount)
    .input('netRate', sql.Decimal(18, 6), breakdowns?.netRate ?? null)
    .input('overrideRate', sql.Decimal(18, 6), breakdowns?.overrideRate ?? null)
    .input('commission', sql.Decimal(18, 6), breakdowns?.commission ?? null)
    .input('systemFees', sql.Decimal(18, 6), breakdowns?.systemFees ?? null)
    .input('processingFeeAmount', sql.Decimal(18, 6), breakdowns?.processingFeeAmount ?? null)
    .input('setupFee', sql.Decimal(18, 6), breakdowns?.setupFee ?? null)
    .input('productCommissions', sql.NVarChar(sql.MAX), breakdowns?.productCommissions ?? null)
    .input('productVendorAmounts', sql.NVarChar(sql.MAX), breakdowns?.productVendorAmounts ?? null)
    .input('productOwnerAmounts', sql.NVarChar(sql.MAX), breakdowns?.productOwnerAmounts ?? null)
    .query(`
      INSERT INTO oe.Invoices
        (InvoiceId, HouseholdId, TenantId, InvoiceType, InvoiceNumber, InvoiceDate,
         DueDate, BillingPeriodStart, BillingPeriodEnd, SubTotal, TaxAmount,
         TotalAmount, PaidAmount, Status, PaymentDueDate,
         NetRate, OverrideRate, Commission, SystemFees, ProcessingFeeAmount, SetupFee,
         ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts,
         CreatedDate, ModifiedDate)
      VALUES
        (@invoiceId, @householdId, @tenantId, N'Individual', @invoiceNumber, @invoiceDate,
         @dueDate, @bpStart, @bpEnd, @totalAmount, 0,
         @totalAmount, 0, N'Unpaid', @dueDate,
         @netRate, @overrideRate, @commission, @systemFees, @processingFeeAmount, @setupFee,
         @productCommissions, @productVendorAmounts, @productOwnerAmounts,
         GETUTCDATE(), GETUTCDATE())
    `);

  const healResult = await selfHealInvoice(pool, invoiceId, householdId, bpStart, bpEnd);

  return { invoiceId, invoiceNumber, alreadyFulfilled: healResult.paidAmount >= totalAmount && totalAmount > 0 };
}

// ---------------------------------------------------------------------------
// createNextMonthInvoice
// ---------------------------------------------------------------------------

async function createNextMonthInvoice(householdId, tenantId, originalEffectiveDay) {
  const pool = await getPool();

  const lastInv = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT TOP 1 InvoiceId, BillingPeriodStart, BillingPeriodEnd, Status
      FROM oe.Invoices
      WHERE HouseholdId = @householdId AND InvoiceType = N'Individual'
      ORDER BY BillingPeriodEnd DESC
    `);

  if (!lastInv.recordset.length) return null;
  const last = lastInv.recordset[0];

  // Forward billing continues even when prior periods are Unpaid/Partial/Overdue;
  // duplicate guard is existingCheck for the computed next period below.

  const lastEnd = new Date(last.BillingPeriodEnd);
  const nextYear = lastEnd.getUTCMonth() === 11 ? lastEnd.getUTCFullYear() + 1 : lastEnd.getUTCFullYear();
  const nextMonth = lastEnd.getUTCMonth() === 11 ? 0 : lastEnd.getUTCMonth() + 1;

  let bpStart;
  let bpEnd;
  try {
    // Derive cohort from the prior invoice's BillingPeriodStart and advance one
    // full cohort period. This keeps 15th-cohort members on a 15→14 schedule.
    const priorPeriodStart = new Date(last.BillingPeriodStart);
    const cohort = getCohortFromDate(priorPeriodStart);
    const advance = new Date(Date.UTC(
      priorPeriodStart.getUTCFullYear(),
      priorPeriodStart.getUTCMonth() + 1,
      priorPeriodStart.getUTCDate()
    ));
    const period = getBillingPeriodForCohort(cohort, advance);
    bpStart = period.start;
    bpEnd = period.end;
  } catch {
    // Legacy/grandfathered invoices whose BillingPeriodStart isn't on day 1 or 15:
    // fall back to the original calendar-aligned advancement.
    bpStart = sameDayNextMonth(originalEffectiveDay, nextYear, nextMonth);
    bpEnd = endOfMonth(bpStart);
  }

  const existingCheck = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('bpStart', sql.DateTime, bpStart)
    .input('bpEnd', sql.DateTime, bpEnd)
    .query(`
      SELECT InvoiceId FROM oe.Invoices
      WHERE HouseholdId = @householdId AND InvoiceType = N'Individual'
        AND BillingPeriodStart = @bpStart AND BillingPeriodEnd = @bpEnd
    `);

  if (existingCheck.recordset.length > 0) return null;

  const { totalAmount } = await computeTotalFromEnrollments(pool, householdId, bpStart, bpEnd);
  if (totalAmount <= 0) return null;

  const breakdowns = await computeInvoiceBreakdowns(pool, { householdId, periodStart: bpStart, periodEnd: bpEnd });
  const invoiceId = crypto.randomUUID();
  const invoiceNumber = await getNextInvoiceNumber(pool);

  await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('invoiceNumber', sql.NVarChar(50), invoiceNumber)
    .input('invoiceDate', sql.Date, bpStart)
    .input('dueDate', sql.Date, bpStart)
    .input('bpStart', sql.Date, bpStart)
    .input('bpEnd', sql.Date, bpEnd)
    .input('totalAmount', sql.Decimal(12, 2), totalAmount)
    .input('netRate', sql.Decimal(18, 6), breakdowns?.netRate ?? null)
    .input('overrideRate', sql.Decimal(18, 6), breakdowns?.overrideRate ?? null)
    .input('commission', sql.Decimal(18, 6), breakdowns?.commission ?? null)
    .input('systemFees', sql.Decimal(18, 6), breakdowns?.systemFees ?? null)
    .input('processingFeeAmount', sql.Decimal(18, 6), breakdowns?.processingFeeAmount ?? null)
    .input('setupFee', sql.Decimal(18, 6), breakdowns?.setupFee ?? null)
    .input('productCommissions', sql.NVarChar(sql.MAX), breakdowns?.productCommissions ?? null)
    .input('productVendorAmounts', sql.NVarChar(sql.MAX), breakdowns?.productVendorAmounts ?? null)
    .input('productOwnerAmounts', sql.NVarChar(sql.MAX), breakdowns?.productOwnerAmounts ?? null)
    .query(`
      INSERT INTO oe.Invoices
        (InvoiceId, HouseholdId, TenantId, InvoiceType, InvoiceNumber, InvoiceDate,
         DueDate, BillingPeriodStart, BillingPeriodEnd, SubTotal, TaxAmount,
         TotalAmount, PaidAmount, Status, PaymentDueDate,
         NetRate, OverrideRate, Commission, SystemFees, ProcessingFeeAmount, SetupFee,
         ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts,
         CreatedDate, ModifiedDate)
      VALUES
        (@invoiceId, @householdId, @tenantId, N'Individual', @invoiceNumber, @invoiceDate,
         @dueDate, @bpStart, @bpEnd, @totalAmount, 0,
         @totalAmount, 0, N'Unpaid', @dueDate,
         @netRate, @overrideRate, @commission, @systemFees, @processingFeeAmount, @setupFee,
         @productCommissions, @productVendorAmounts, @productOwnerAmounts,
         GETUTCDATE(), GETUTCDATE())
    `);

  await selfHealInvoice(pool, invoiceId, householdId, bpStart, bpEnd);
  return { invoiceId, invoiceNumber, billingPeriodStart: bpStart, billingPeriodEnd: bpEnd };
}

// ---------------------------------------------------------------------------
// fulfillInvoice
// ---------------------------------------------------------------------------

async function fulfillInvoice(invoiceId, paymentAmount) {
  if (!invoiceId) return { applied: false, reason: 'no_invoice_id' };
  const pool = await getPool();
  const amt = parseFloat(paymentAmount) || 0;
  if (amt <= 0) return { applied: false, reason: 'invalid_amount' };

  const inv = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(
      `SELECT TotalAmount, PaidAmount, CreditAmount, Status FROM oe.Invoices WHERE InvoiceId = @invoiceId`
    );

  if (!inv.recordset.length) return { applied: false, reason: 'invoice_not_found' };

  const total = parseFloat(inv.recordset[0].TotalAmount) || 0;
  const prevPaid = parseFloat(inv.recordset[0].PaidAmount) || 0;
  const credit = parseFloat(inv.recordset[0].CreditAmount) || 0;
  const newPaid = Math.min(total, prevPaid + amt);
  const newStatus = recalcStatusFromAmounts(total, newPaid, credit, inv.recordset[0].Status);

  await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('paidAmount', sql.Decimal(12, 2), newPaid)
    .input('status', sql.NVarChar(50), newStatus)
    .query(`
      UPDATE oe.Invoices
      SET PaidAmount = @paidAmount,
          Status = @status,
          PaymentReceivedDate = CASE WHEN @status = N'Paid' THEN GETUTCDATE() ELSE PaymentReceivedDate END,
          ModifiedDate = GETUTCDATE()
      WHERE InvoiceId = @invoiceId
    `);

  return { applied: true, newPaidAmount: newPaid, invoiceStatus: newStatus };
}

/**
 * Same as fulfillInvoice but uses an open mssql transaction (atomic with payment InvoiceId updates).
 * @param {import('mssql').Transaction} transaction
 * @param {typeof import('mssql')} sql
 */
async function fulfillInvoiceInTxn(transaction, sqlMod, invoiceId, paymentAmount) {
  if (!invoiceId) return { applied: false, reason: 'no_invoice_id' };
  const amt = parseFloat(paymentAmount) || 0;
  if (amt <= 0) return { applied: false, reason: 'invalid_amount' };

  const inv = await transaction
    .request()
    .input('invoiceId', sqlMod.UniqueIdentifier, invoiceId)
    .query(`SELECT TotalAmount, PaidAmount, CreditAmount, Status FROM oe.Invoices WHERE InvoiceId = @invoiceId`);

  if (!inv.recordset.length) return { applied: false, reason: 'invoice_not_found' };

  const total = parseFloat(inv.recordset[0].TotalAmount) || 0;
  const prevPaid = parseFloat(inv.recordset[0].PaidAmount) || 0;
  const credit = parseFloat(inv.recordset[0].CreditAmount) || 0;
  const newPaid = Math.min(total, prevPaid + amt);
  const newStatus = recalcStatusFromAmounts(total, newPaid, credit, inv.recordset[0].Status);

  await transaction
    .request()
    .input('invoiceId', sqlMod.UniqueIdentifier, invoiceId)
    .input('paidAmount', sqlMod.Decimal(12, 2), newPaid)
    .input('status', sqlMod.NVarChar(50), newStatus)
    .query(`
      UPDATE oe.Invoices
      SET PaidAmount = @paidAmount,
          Status = @status,
          PaymentReceivedDate = CASE WHEN @status = N'Paid' THEN GETUTCDATE() ELSE PaymentReceivedDate END,
          ModifiedDate = GETUTCDATE()
      WHERE InvoiceId = @invoiceId
    `);

  return { applied: true, newPaidAmount: newPaid, invoiceStatus: newStatus };
}

/**
 * Admin: move a household individual payment to another invoice (or unlink). Adjusts PaidAmount/Status
 * on the previous and new invoices when the payment is in a successful collected state — same math as
 * unfulfillInvoice / fulfillInvoice.
 *
 * @param {object} opts
 * @param {string} opts.paymentId
 * @param {string|null|undefined} opts.invoiceId — target Individual invoice for the same household/tenant, or null to unlink
 * @returns {Promise<{ ok: boolean; previousInvoiceId?: string|null; newInvoiceId?: string|null; warnings?: string[]; noOp?: boolean; error?: string }>}
 */
async function reassignPaymentInvoiceLink({ paymentId, invoiceId: newInvoiceIdRaw }) {
  const pool = await getPool();
  const warnings = [];

  const payRes = await pool
    .request()
    .input('paymentId', sql.UniqueIdentifier, paymentId)
    .query(`
      SELECT PaymentId, HouseholdId, GroupId, TenantId, Amount, Status, InvoiceId, TransactionType, OriginalPaymentId
      FROM oe.Payments
      WHERE PaymentId = @paymentId
    `);

  if (!payRes.recordset?.length) {
    return { ok: false, error: 'payment_not_found' };
  }

  const p = payRes.recordset[0];
  if (p.GroupId != null && String(p.GroupId).replace(/-/g, '').toLowerCase() !== '00000000000000000000000000000000') {
    return { ok: false, error: 'group_payments_use_group_billing_tools' };
  }
  if (!p.HouseholdId) {
    return { ok: false, error: 'payment_has_no_household' };
  }

  const ttRaw = p.TransactionType != null ? String(p.TransactionType).trim() : '';
  if (ttRaw && ttRaw.toLowerCase() !== 'payment') {
    return { ok: false, error: 'only_transaction_type_payment_can_be_relinked' };
  }
  if (p.OriginalPaymentId != null && String(p.OriginalPaymentId).trim() !== '') {
    return { ok: false, error: 'refund_or_child_payment_cannot_be_relinked' };
  }

  const newInvoiceId =
    newInvoiceIdRaw != null && String(newInvoiceIdRaw).trim() !== '' ? String(newInvoiceIdRaw).trim() : null;
  const prevInvoiceId = p.InvoiceId ? String(p.InvoiceId) : null;

  const norm = (x) => (x ? String(x).replace(/-/g, '').toLowerCase() : '');
  if (norm(prevInvoiceId) === norm(newInvoiceId)) {
    return { ok: true, noOp: true, previousInvoiceId: prevInvoiceId, newInvoiceId };
  }

  if (newInvoiceId) {
    const invRes = await pool
      .request()
      .input('invoiceId', sql.UniqueIdentifier, newInvoiceId)
      .query(`
        SELECT InvoiceId, HouseholdId, TenantId, InvoiceType, Status
        FROM oe.Invoices
        WHERE InvoiceId = @invoiceId
      `);
    if (!invRes.recordset?.length) {
      return { ok: false, error: 'invoice_not_found' };
    }
    const inv = invRes.recordset[0];
    if (String(inv.InvoiceType || '') !== 'Individual') {
      return { ok: false, error: 'only_individual_invoices_allowed' };
    }
    if (norm(inv.HouseholdId) !== norm(p.HouseholdId)) {
      return { ok: false, error: 'invoice_household_mismatch' };
    }
    if (norm(inv.TenantId) !== norm(p.TenantId)) {
      return { ok: false, error: 'invoice_tenant_mismatch' };
    }
    const st = String(inv.Status || '');
    if (st === 'Cancelled') {
      return { ok: false, error: 'cannot_link_to_cancelled_invoice' };
    }
  }

  const comRes = await pool
    .request()
    .input('paymentId', sql.UniqueIdentifier, paymentId)
    .query(`
      SELECT TOP 1 1 AS Ok FROM oe.Commissions c
      WHERE c.PaymentId = @paymentId AND ISNULL(c.Status, N'') <> N'Deleted'
    `);
  if (comRes.recordset?.length) {
    warnings.push('commissions_exist_review_after_relink');
  }

  const amount = parseFloat(p.Amount) || 0;
  const paymentOk = isSuccessfulPaymentRecordStatus(String(p.Status ?? ''));

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    if (prevInvoiceId && paymentOk && norm(prevInvoiceId) !== norm(newInvoiceId)) {
      await unfulfillInvoiceInTxn(transaction, sql, prevInvoiceId, amount);
    }

    const upd = transaction.request().input('paymentId', sql.UniqueIdentifier, paymentId);
    if (newInvoiceId) {
      upd.input('invoiceId', sql.UniqueIdentifier, newInvoiceId);
      await upd.query(`
        UPDATE oe.Payments SET InvoiceId = @invoiceId, ModifiedDate = GETUTCDATE() WHERE PaymentId = @paymentId
      `);
    } else {
      await upd.query(`
        UPDATE oe.Payments SET InvoiceId = NULL, ModifiedDate = GETUTCDATE() WHERE PaymentId = @paymentId
      `);
    }

    if (newInvoiceId && paymentOk) {
      await fulfillInvoiceInTxn(transaction, sql, newInvoiceId, amount);
    }

    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    return { ok: false, error: err.message || String(err) };
  }

  return {
    ok: true,
    previousInvoiceId: prevInvoiceId,
    newInvoiceId,
    warnings: warnings.length ? warnings : undefined
  };
}

// ---------------------------------------------------------------------------
// unfulfillInvoice
// ---------------------------------------------------------------------------

async function unfulfillInvoice(invoiceId, refundAmount) {
  if (!invoiceId) return { applied: false, reason: 'no_invoice_id' };
  const pool = await getPool();
  const amt = parseFloat(refundAmount) || 0;
  if (amt <= 0) return { applied: false, reason: 'invalid_amount' };

  const inv = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(
      `SELECT TotalAmount, PaidAmount, CreditAmount, Status FROM oe.Invoices WHERE InvoiceId = @invoiceId`
    );

  if (!inv.recordset.length) return { applied: false, reason: 'invoice_not_found' };

  const total = parseFloat(inv.recordset[0].TotalAmount) || 0;
  const prevPaid = parseFloat(inv.recordset[0].PaidAmount) || 0;
  const credit = parseFloat(inv.recordset[0].CreditAmount) || 0;
  const newPaid = Math.max(0, prevPaid - amt);
  const newStatus = recalcStatusFromAmounts(total, newPaid, credit, inv.recordset[0].Status);

  await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('paidAmount', sql.Decimal(12, 2), newPaid)
    .input('status', sql.NVarChar(50), newStatus)
    .query(`
      UPDATE oe.Invoices
      SET PaidAmount = @paidAmount,
          Status = @status,
          PaymentReceivedDate = CASE WHEN @status <> N'Paid' THEN NULL ELSE PaymentReceivedDate END,
          ModifiedDate = GETUTCDATE()
      WHERE InvoiceId = @invoiceId
    `);

  return { applied: true, newPaidAmount: newPaid, invoiceStatus: newStatus };
}

/**
 * Same as unfulfillInvoice but uses an open mssql transaction (atomic with other writes).
 * @param {import('mssql').Transaction} transaction
 * @param {typeof import('mssql')} sql
 */
async function unfulfillInvoiceInTxn(transaction, sql, invoiceId, refundAmount) {
  if (!invoiceId) return { applied: false, reason: 'no_invoice_id' };
  const amt = parseFloat(refundAmount) || 0;
  if (amt <= 0) return { applied: false, reason: 'invalid_amount' };

  const inv = await transaction
    .request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(
      `SELECT TotalAmount, PaidAmount, CreditAmount, Status FROM oe.Invoices WHERE InvoiceId = @invoiceId`
    );

  if (!inv.recordset.length) return { applied: false, reason: 'invoice_not_found' };

  const total = parseFloat(inv.recordset[0].TotalAmount) || 0;
  const prevPaid = parseFloat(inv.recordset[0].PaidAmount) || 0;
  const credit = parseFloat(inv.recordset[0].CreditAmount) || 0;
  const newPaid = Math.max(0, prevPaid - amt);
  const newStatus = recalcStatusFromAmounts(total, newPaid, credit, inv.recordset[0].Status);

  await transaction
    .request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('paidAmount', sql.Decimal(12, 2), newPaid)
    .input('status', sql.NVarChar(50), newStatus)
    .query(`
      UPDATE oe.Invoices
      SET PaidAmount = @paidAmount,
          Status = @status,
          PaymentReceivedDate = CASE WHEN @status <> N'Paid' THEN NULL ELSE PaymentReceivedDate END,
          ModifiedDate = GETUTCDATE()
      WHERE InvoiceId = @invoiceId
    `);

  return { applied: true, newPaidAmount: newPaid, invoiceStatus: newStatus };
}

// ---------------------------------------------------------------------------
// reconcileUnfulfilledInvoice
// ---------------------------------------------------------------------------

async function reconcileUnfulfilledInvoice(invoiceId) {
  const pool = await getPool();

  const inv = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`
      SELECT HouseholdId, BillingPeriodStart, BillingPeriodEnd, TotalAmount, Status
      FROM oe.Invoices WHERE InvoiceId = @invoiceId
    `);

  if (!inv.recordset.length) return { updated: false };
  const row = inv.recordset[0];

  if (['Paid', 'Cancelled'].includes(row.Status)) return { updated: false, reason: 'immutable_status' };

  const { totalAmount } = await computeTotalFromEnrollments(pool, row.HouseholdId, row.BillingPeriodStart, row.BillingPeriodEnd);
  if (Math.abs(totalAmount - parseFloat(row.TotalAmount)) < 0.01) return { updated: false, reason: 'no_change' };

  const breakdowns = await computeInvoiceBreakdowns(pool, { householdId: row.HouseholdId, periodStart: row.BillingPeriodStart, periodEnd: row.BillingPeriodEnd });

  await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('totalAmount', sql.Decimal(12, 2), totalAmount)
    .input('subTotal', sql.Decimal(12, 2), totalAmount)
    .input('netRate', sql.Decimal(18, 6), breakdowns?.netRate ?? null)
    .input('overrideRate', sql.Decimal(18, 6), breakdowns?.overrideRate ?? null)
    .input('commission', sql.Decimal(18, 6), breakdowns?.commission ?? null)
    .input('systemFees', sql.Decimal(18, 6), breakdowns?.systemFees ?? null)
    .input('processingFeeAmount', sql.Decimal(18, 6), breakdowns?.processingFeeAmount ?? null)
    .input('setupFee', sql.Decimal(18, 6), breakdowns?.setupFee ?? null)
    .input('productCommissions', sql.NVarChar(sql.MAX), breakdowns?.productCommissions ?? null)
    .input('productVendorAmounts', sql.NVarChar(sql.MAX), breakdowns?.productVendorAmounts ?? null)
    .input('productOwnerAmounts', sql.NVarChar(sql.MAX), breakdowns?.productOwnerAmounts ?? null)
    .query(`
      UPDATE oe.Invoices
      SET TotalAmount = @totalAmount, SubTotal = @subTotal,
          NetRate = @netRate, OverrideRate = @overrideRate, Commission = @commission,
          SystemFees = @systemFees, ProcessingFeeAmount = @processingFeeAmount, SetupFee = @setupFee,
          ProductCommissions = @productCommissions, ProductVendorAmounts = @productVendorAmounts, ProductOwnerAmounts = @productOwnerAmounts,
          ModifiedDate = GETUTCDATE()
      WHERE InvoiceId = @invoiceId
    `);

  const after = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`
      SELECT TotalAmount, PaidAmount, COALESCE(CreditAmount, 0) AS CreditAmount, Status,
             PaymentReceivedDate
      FROM oe.Invoices WHERE InvoiceId = @invoiceId
    `);
  const ar = after.recordset[0];
  const tAmt = parseFloat(ar.TotalAmount) || 0;
  const paidAmt = parseFloat(ar.PaidAmount) || 0;
  const creditAmt = parseFloat(ar.CreditAmount) || 0;
  const statusFromAmounts = recalcStatusFromAmounts(tAmt, paidAmt, creditAmt, ar.Status);
  if (ar.Status !== statusFromAmounts) {
    await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('status', sql.NVarChar(50), statusFromAmounts)
      .query(`
        UPDATE oe.Invoices
        SET Status = @status,
            PaymentReceivedDate = CASE
              WHEN @status = N'Paid' AND PaymentReceivedDate IS NULL THEN GETUTCDATE()
              ELSE PaymentReceivedDate
            END,
            ModifiedDate = GETUTCDATE()
        WHERE InvoiceId = @invoiceId
      `);
  }

  return { updated: true, newTotalAmount: totalAmount, invoiceStatus: statusFromAmounts };
}

/**
 * Paid Individual invoices skip reconcileUnfulfilledInvoice, so TotalAmount can stay stale after a
 * mid-period enrollment change even when the member already paid the enrollment-derived amount.
 * When PaidAmount matches current oe.Enrollments sum for the billing window but TotalAmount does not,
 * align header totals + Phase-2 breakdown columns to enrollments (no change to PaidAmount).
 */
async function reconcilePaidIndividualInvoiceTotalsWhenEligible(invoiceId) {
  const pool = await getPool();
  const inv = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`
      SELECT HouseholdId, BillingPeriodStart, BillingPeriodEnd, TotalAmount, PaidAmount, Status, InvoiceType
      FROM oe.Invoices WHERE InvoiceId = @invoiceId
    `);

  if (!inv.recordset.length) return { updated: false, reason: 'invoice_not_found' };
  const row = inv.recordset[0];
  if ((row.Status || '').toString() !== 'Paid') return { updated: false, reason: 'not_paid' };
  if ((row.InvoiceType || '').toString() !== 'Individual') return { updated: false, reason: 'not_individual' };

  const { totalAmount } = await computeTotalFromEnrollments(
    pool,
    row.HouseholdId,
    row.BillingPeriodStart,
    row.BillingPeriodEnd
  );
  const enrolledTotal = parseFloat(totalAmount) || 0;
  const storedTotal = parseFloat(row.TotalAmount) || 0;
  const paidAmt = parseFloat(row.PaidAmount) || 0;

  if (Math.abs(enrolledTotal - storedTotal) < 0.01) {
    return { updated: false, reason: 'totals_already_match_enrollments' };
  }
  // Only heal when payments already match what enrollments say — avoids rewriting closed invoices that are legitimately partial/overpaid.
  if (Math.abs(enrolledTotal - paidAmt) >= 0.02) {
    return {
      updated: false,
      reason: 'paid_amount_mismatch_enrollments',
      enrolledTotal,
      paidAmount: paidAmt,
      storedTotal
    };
  }

  const breakdowns = await computeInvoiceBreakdowns(pool, {
    householdId: row.HouseholdId,
    periodStart: row.BillingPeriodStart,
    periodEnd: row.BillingPeriodEnd
  });

  await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('totalAmount', sql.Decimal(12, 2), enrolledTotal)
    .input('subTotal', sql.Decimal(12, 2), enrolledTotal)
    .input('netRate', sql.Decimal(18, 6), breakdowns?.netRate ?? null)
    .input('overrideRate', sql.Decimal(18, 6), breakdowns?.overrideRate ?? null)
    .input('commission', sql.Decimal(18, 6), breakdowns?.commission ?? null)
    .input('systemFees', sql.Decimal(18, 6), breakdowns?.systemFees ?? null)
    .input('processingFeeAmount', sql.Decimal(18, 6), breakdowns?.processingFeeAmount ?? null)
    .input('setupFee', sql.Decimal(18, 6), breakdowns?.setupFee ?? null)
    .input('productCommissions', sql.NVarChar(sql.MAX), breakdowns?.productCommissions ?? null)
    .input('productVendorAmounts', sql.NVarChar(sql.MAX), breakdowns?.productVendorAmounts ?? null)
    .input('productOwnerAmounts', sql.NVarChar(sql.MAX), breakdowns?.productOwnerAmounts ?? null)
    .query(`
      UPDATE oe.Invoices
      SET TotalAmount = @totalAmount, SubTotal = @subTotal,
          NetRate = @netRate, OverrideRate = @overrideRate, Commission = @commission,
          SystemFees = @systemFees, ProcessingFeeAmount = @processingFeeAmount, SetupFee = @setupFee,
          ProductCommissions = @productCommissions, ProductVendorAmounts = @productVendorAmounts, ProductOwnerAmounts = @productOwnerAmounts,
          ModifiedDate = GETUTCDATE()
      WHERE InvoiceId = @invoiceId
    `);

  return { updated: true, newTotalAmount: enrolledTotal, previousTotalAmount: storedTotal };
}

const PAID_ALIGN_TOLERANCE = 0.02;

function enrollmentOverlapsBillingPeriodRow(e, billingPeriodStart, billingPeriodEnd) {
  const eff = e.EffectiveDate ? new Date(e.EffectiveDate) : null;
  if (!eff || Number.isNaN(eff.getTime())) return false;
  const bpS = new Date(billingPeriodStart);
  const bpE = new Date(billingPeriodEnd);
  if (eff > bpE) return false;
  const term = e.TerminationDate ? new Date(e.TerminationDate) : null;
  if (term && !Number.isNaN(term.getTime()) && term <= bpS) return false;
  return true;
}

function sumPremiumForProjectedRows(rows, billingPeriodStart, billingPeriodEnd) {
  let sum = 0;
  for (const e of rows) {
    if (!enrollmentOverlapsBillingPeriodRow(e, billingPeriodStart, billingPeriodEnd)) continue;
    sum += Number(e.PremiumAmount) || 0;
  }
  return Math.round(sum * 100) / 100;
}

/** UTC YYYY-MM-DD for overlap filters (matches calendar-day intent for billing periods). */
function dateOnlyUtc(isoOrDate) {
  const x = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (!isoOrDate || Number.isNaN(x.getTime())) return null;
  return x.toISOString().slice(0, 10);
}

/**
 * Invoice billing period contains effective date (UTC calendar day).
 */
function invoiceOverlapsEffectiveDate(invRow, effectiveDateInput) {
  if (effectiveDateInput === undefined || effectiveDateInput === null || effectiveDateInput === '') return true;
  const raw =
    typeof effectiveDateInput === 'string'
      ? effectiveDateInput
      : effectiveDateInput instanceof Date
        ? effectiveDateInput.toISOString()
        : String(effectiveDateInput);
  const needle = raw.includes('T') ? raw.slice(0, 10) : raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(needle)) return true;
  const startStr = dateOnlyUtc(invRow.BillingPeriodStart);
  const endStr = dateOnlyUtc(invRow.BillingPeriodEnd);
  if (!startStr || !endStr) return true;
  return needle >= startStr && needle <= endStr;
}

async function loadProjectedEnrollmentRows(pool, householdId, terminatedEnrollmentIds = [], addedEnrollments = []) {
  const enrRes = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT e.EnrollmentId, e.PremiumAmount, e.EffectiveDate, e.TerminationDate,
             e.EnrollmentType, e.Status
      FROM oe.Enrollments e
      WHERE e.HouseholdId = @householdId
        AND e.Status NOT IN (N'Cancelled', N'Declined')
    `);
  const termSet = new Set((terminatedEnrollmentIds || []).map((id) => String(id).toLowerCase()));
  const baseRows = (enrRes.recordset || []).filter(
    (r) => !termSet.has(String(r.EnrollmentId).toLowerCase())
  );
  const addedRows = (addedEnrollments || []).map((e, idx) => ({
    EnrollmentId: `__planned__${idx}`,
    PremiumAmount: Number(e.premiumAmount) || 0,
    EffectiveDate: e.effectiveDate ? new Date(e.effectiveDate) : null,
    TerminationDate: e.terminationDate ? new Date(e.terminationDate) : null,
    EnrollmentType: e.enrollmentType || 'Product',
    Status: 'Active'
  }));
  return [...baseRows, ...addedRows];
}

/**
 * Dry-run / docs: paid Individual invoices where projected enrollment premium sum vs stored totals differ,
 * with eligibility aligned to reconcilePaidIndividualInvoiceTotalsWhenEligible.
 */
async function previewPaidInvoiceAlignmentAfterPlanChange({
  tenantId,
  householdId,
  terminatedEnrollmentIds = [],
  addedEnrollments = [],
  effectiveDate = null
} = {}) {
  const empty = { candidates: [], summary: { count: 0, alignEligibleCount: 0, potentialUnderbillCount: 0 } };
  if (!householdId) return empty;

  const pool = await getPool();
  const projectedRows = await loadProjectedEnrollmentRows(pool, householdId, terminatedEnrollmentIds, addedEnrollments);

  const req = pool.request().input('householdId', sql.UniqueIdentifier, householdId);
  let tenantClause = '';
  if (tenantId) {
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    tenantClause = 'AND TenantId = @tenantId';
  }

  const invRes = await req.query(`
    SELECT InvoiceId, InvoiceNumber, BillingPeriodStart, BillingPeriodEnd,
           TotalAmount, PaidAmount, COALESCE(BalanceDue, 0) AS BalanceDue, Status
    FROM oe.Invoices
    WHERE HouseholdId = @householdId
      AND InvoiceType = N'Individual'
      AND Status = N'Paid'
      ${tenantClause}
    ORDER BY BillingPeriodStart DESC
  `);

  const invoices = invRes.recordset || [];
  const candidates = [];
  let alignEligibleCount = 0;
  let potentialUnderbillCount = 0;

  for (const inv of invoices) {
    if (!invoiceOverlapsEffectiveDate(inv, effectiveDate)) continue;

    const bpStart = inv.BillingPeriodStart;
    const bpEnd = inv.BillingPeriodEnd;
    const enrollmentSum = sumPremiumForProjectedRows(projectedRows, bpStart, bpEnd);
    const storedTotal = Math.round((parseFloat(inv.TotalAmount) || 0) * 100) / 100;
    const paidAmt = Math.round((parseFloat(inv.PaidAmount) || 0) * 100) / 100;
    const balanceDue = Math.round((parseFloat(inv.BalanceDue) || 0) * 100) / 100;

    const totalMatches = Math.abs(enrollmentSum - storedTotal) < 0.01;
    const paidMatchesEnrolled = Math.abs(enrollmentSum - paidAmt) < PAID_ALIGN_TOLERANCE;
    const alignEligible = paidMatchesEnrolled && !totalMatches;

    const underbillDelta =
      enrollmentSum > storedTotal + 0.01 ? Math.round((enrollmentSum - storedTotal) * 100) / 100 : 0;
    const potentialUnderbill = underbillDelta > 0.01;

    let reasonIfNotEligible = null;
    if (alignEligible) reasonIfNotEligible = null;
    else if (totalMatches) reasonIfNotEligible = 'totals_already_match_enrollments';
    else if (!paidMatchesEnrolled) reasonIfNotEligible = 'paid_amount_mismatch_enrollments';
    else reasonIfNotEligible = 'not_eligible';

    if (totalMatches) continue;

    if (alignEligible) alignEligibleCount += 1;
    if (potentialUnderbill) potentialUnderbillCount += 1;

    candidates.push({
      invoiceId: inv.InvoiceId,
      invoiceNumber: inv.InvoiceNumber,
      billingPeriodStart: inv.BillingPeriodStart,
      billingPeriodEnd: inv.BillingPeriodEnd,
      storedTotal,
      paidAmount: paidAmt,
      balanceDue,
      enrollmentSum,
      alignEligible,
      reasonIfNotEligible,
      potentialUnderbill,
      underbillDelta: potentialUnderbill ? underbillDelta : null
    });
  }

  return {
    candidates,
    summary: {
      count: candidates.length,
      alignEligibleCount,
      potentialUnderbillCount
    }
  };
}

/**
 * After plan apply: optionally align paid invoice headers when PaidAmount matches enrollment-derived totals.
 */
async function applyPaidInvoiceAlignmentForHousehold({ tenantId, householdId, effectiveDate = null } = {}) {
  const results = { updated: [], skipped: [] };
  if (!householdId) return results;

  const pool = await getPool();
  const req = pool.request().input('householdId', sql.UniqueIdentifier, householdId);
  let tenantClause = '';
  if (tenantId) {
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    tenantClause = 'AND TenantId = @tenantId';
  }

  const invRes = await req.query(`
    SELECT InvoiceId, InvoiceNumber, BillingPeriodStart, BillingPeriodEnd, TotalAmount, PaidAmount, Status
    FROM oe.Invoices
    WHERE HouseholdId = @householdId
      AND InvoiceType = N'Individual'
      AND Status = N'Paid'
      ${tenantClause}
    ORDER BY BillingPeriodStart DESC
  `);

  for (const inv of invRes.recordset || []) {
    if (!invoiceOverlapsEffectiveDate(inv, effectiveDate)) continue;

    try {
      const r = await reconcilePaidIndividualInvoiceTotalsWhenEligible(inv.InvoiceId);
      const entry = {
        invoiceId: inv.InvoiceId,
        invoiceNumber: inv.InvoiceNumber,
        ...r
      };
      if (r.updated) results.updated.push(entry);
      else results.skipped.push(entry);
    } catch (err) {
      results.skipped.push({
        invoiceId: inv.InvoiceId,
        invoiceNumber: inv.InvoiceNumber,
        updated: false,
        reason: 'error',
        error: err.message
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// previewOpenInvoiceReconcileForHousehold
// Read-only sibling of reconcileUnfulfilledInvoice. Returns the deltas the
// nightly job's reconcile pass would apply to every open (Unpaid/Partial/
// Overdue) individual invoice for a household, without writing anything.
// Used by the tenant-admin plan modification dry-run so the wizard can show
// the admin which open invoice totals will change post-apply.
// ---------------------------------------------------------------------------

async function previewOpenInvoiceReconcileForHousehold({ tenantId, householdId }) {
  const empty = { candidates: [], summary: { count: 0, totalDelta: 0 } };
  if (!householdId) return empty;

  const pool = await getPool();

  const request = pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId);
  let tenantClause = '';
  if (tenantId) {
    request.input('tenantId', sql.UniqueIdentifier, tenantId);
    tenantClause = 'AND TenantId = @tenantId';
  }

  const open = await request.query(`
    SELECT InvoiceId, InvoiceNumber, BillingPeriodStart, BillingPeriodEnd,
           TotalAmount, Status
    FROM oe.Invoices
    WHERE HouseholdId = @householdId
      AND InvoiceType = 'Individual'
      AND Status IN ('Unpaid', 'Partial', 'Overdue')
      ${tenantClause}
    ORDER BY BillingPeriodStart ASC
  `);

  const candidates = [];
  let totalDelta = 0;

  for (const row of open.recordset) {
    try {
      const { totalAmount } = await computeTotalFromEnrollments(
        pool,
        householdId,
        row.BillingPeriodStart,
        row.BillingPeriodEnd
      );
      const currentTotal = parseFloat(row.TotalAmount) || 0;
      const projectedTotal = parseFloat(totalAmount) || 0;
      const delta = projectedTotal - currentTotal;
      if (Math.abs(delta) >= 0.01) {
        candidates.push({
          invoiceId: row.InvoiceId,
          invoiceNumber: row.InvoiceNumber,
          periodStart: row.BillingPeriodStart,
          periodEnd: row.BillingPeriodEnd,
          status: row.Status,
          currentTotal,
          projectedTotal,
          delta
        });
        totalDelta += delta;
      }
    } catch (err) {
      console.warn(`⚠️ previewOpenInvoiceReconcileForHousehold: skipped invoice ${row.InvoiceId}: ${err.message}`);
    }
  }

  return {
    candidates,
    summary: { count: candidates.length, totalDelta }
  };
}

// ---------------------------------------------------------------------------
// reconcileOpenInvoicesForHousehold
// Calls reconcileUnfulfilledInvoice (the nightly-job code path) for every open
// individual invoice on a household. Used post-commit by the tenant-admin
// plan modification apply so open invoice totals are immediately in sync with
// the new enrollment state instead of waiting for the nightly job.
// ---------------------------------------------------------------------------

async function reconcileOpenInvoicesForHousehold({ tenantId, householdId }) {
  const empty = { updated: [], skipped: [] };
  if (!householdId) return empty;

  const pool = await getPool();

  const request = pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId);
  let tenantClause = '';
  if (tenantId) {
    request.input('tenantId', sql.UniqueIdentifier, tenantId);
    tenantClause = 'AND TenantId = @tenantId';
  }

  const open = await request.query(`
    SELECT InvoiceId, InvoiceNumber, BillingPeriodStart, BillingPeriodEnd,
           TotalAmount, Status
    FROM oe.Invoices
    WHERE HouseholdId = @householdId
      AND InvoiceType = 'Individual'
      AND Status IN ('Unpaid', 'Partial', 'Overdue')
      ${tenantClause}
    ORDER BY BillingPeriodStart ASC
  `);

  const updated = [];
  const skipped = [];

  for (const row of open.recordset) {
    try {
      const previousTotal = parseFloat(row.TotalAmount) || 0;
      const result = await reconcileUnfulfilledInvoice(row.InvoiceId);
      if (result.updated) {
        updated.push({
          invoiceId: row.InvoiceId,
          invoiceNumber: row.InvoiceNumber,
          periodStart: row.BillingPeriodStart,
          periodEnd: row.BillingPeriodEnd,
          status: row.Status,
          previousTotal,
          newTotal: result.newTotalAmount,
          delta: (result.newTotalAmount || 0) - previousTotal
        });
      } else {
        skipped.push({
          invoiceId: row.InvoiceId,
          invoiceNumber: row.InvoiceNumber,
          reason: result.reason || 'no_change'
        });
      }
    } catch (err) {
      console.warn(`⚠️ reconcileOpenInvoicesForHousehold: failed ${row.InvoiceId}: ${err.message}`);
      skipped.push({
        invoiceId: row.InvoiceId,
        invoiceNumber: row.InvoiceNumber,
        reason: 'error',
        error: err.message
      });
    }
  }

  return { updated, skipped };
}

// ---------------------------------------------------------------------------
// getOrCreateInvoiceForPeriod
// Accepts explicit billing period dates instead of deriving from a payment date.
// ---------------------------------------------------------------------------

async function getOrCreateInvoiceForPeriod(householdId, tenantId, bpStart, bpEnd) {
  const pool = await getPool();

  const existing = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('bpStart', sql.DateTime, bpStart)
    .input('bpEnd', sql.DateTime, bpEnd)
    .query(`
      SELECT TOP 1 InvoiceId, Status, InvoiceNumber, BillingPeriodStart, BillingPeriodEnd
      FROM oe.Invoices
      WHERE HouseholdId = @householdId
        AND InvoiceType = N'Individual'
        AND BillingPeriodStart <= @bpEnd
        AND BillingPeriodEnd >= @bpStart
        AND Status NOT IN ('Cancelled')
      ORDER BY CreatedDate DESC
    `);

  if (existing.recordset.length > 0) {
    const row = existing.recordset[0];
    return {
      invoiceId: row.InvoiceId,
      invoiceNumber: row.InvoiceNumber,
      billingPeriodStart: row.BillingPeriodStart,
      billingPeriodEnd: row.BillingPeriodEnd,
      created: false,
    };
  }

  const result = await createInvoiceForEnrollment(householdId, tenantId, bpStart);
  return {
    invoiceId: result.invoiceId,
    invoiceNumber: result.invoiceNumber || null,
    billingPeriodStart: bpStart,
    // Honor the caller's bpEnd — `createInvoiceForEnrollment` derives the
    // same period from bpStart's cohort, so these stay in sync for 15th-of-month
    // periods (15th–14th) instead of being snapped back to EOM.
    billingPeriodEnd: bpEnd,
    created: true,
  };
}

// ---------------------------------------------------------------------------
// getOrCreateInvoiceForPayment
// ---------------------------------------------------------------------------

async function getOrCreateInvoiceForPayment(householdId, tenantId, paymentDate) {
  const pool = await getPool();
  const pDate = new Date(paymentDate);
  // Individual-billed households: derive billing period from the household's billing anchor
  // (earliest active Product/Bundle effective date). This function is only used for individual
  // billing; group cohort periods (1st/15th cycles) are handled in `createInvoiceForEnrollment`
  // via `computeBillingPeriodFromEffectiveDate`.
  /** @type {Date} */
  let bpStart;
  /** @type {Date} */
  let bpEnd;
  const billingAnchor = await getHouseholdBillingAnchor(pool, householdId);
  if (billingAnchor) {
    const period = anchorPeriodContainingReferenceDate(billingAnchor.anchorDay, pDate);
    bpStart = period.bpStart;
    bpEnd = period.bpEnd;
  } else {
    bpStart = startOfMonth(pDate);
    bpEnd = endOfMonth(pDate);
  }

  const existing = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('bpStart', sql.DateTime, bpStart)
    .input('bpEnd', sql.DateTime, bpEnd)
    .query(`
      SELECT TOP 1 InvoiceId, InvoiceNumber, Status, BillingPeriodStart, BillingPeriodEnd
      FROM oe.Invoices
      WHERE HouseholdId = @householdId
        AND InvoiceType = N'Individual'
        AND BillingPeriodStart <= @bpEnd
        AND BillingPeriodEnd >= @bpStart
        AND Status NOT IN ('Cancelled')
      ORDER BY CreatedDate DESC
    `);

  if (existing.recordset.length > 0) {
    const row = existing.recordset[0];
    return {
      invoiceId: row.InvoiceId,
      invoiceNumber: row.InvoiceNumber || null,
      billingPeriodStart: row.BillingPeriodStart,
      billingPeriodEnd: row.BillingPeriodEnd,
      created: false,
    };
  }

  const effectiveDate = bpStart;
  const result = await createInvoiceForEnrollment(householdId, tenantId, effectiveDate);
  return {
    invoiceId: result.invoiceId,
    invoiceNumber: result.invoiceNumber || null,
    billingPeriodStart: bpStart,
    billingPeriodEnd: bpEnd,
    created: true,
  };
}

// ---------------------------------------------------------------------------
// tryLinkPaymentToInvoice (best-effort, never throws)
// ---------------------------------------------------------------------------

async function tryLinkPaymentToInvoice(paymentId, householdId, tenantId, paymentDate, paymentAmount) {
  try {
    if (!householdId) return { linked: false, reason: 'no_household' };

    let invoiceId = null;
    let matchedViaPrepay = false;

    // Prepay-first match: when enabled, look for an existing Unpaid/Partial/Overdue
    // invoice whose BillingPeriodStart is within the prepay window AFTER paymentDate,
    // and whose remaining balance is within tolerance of the payment amount.
    // This avoids creating a bogus same-month invoice when the payment is actually
    // intended for the next billing period.
    if (process.env.SELF_HEAL_PREPAY_ENABLED === 'true' && paymentAmount != null) {
      const pool = await getPool();
      const prepayMatch = await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .input('paymentDate', sql.DateTime, paymentDate)
        .input('windowDays', sql.Int, PREPAY_WINDOW_DAYS)
        .input('paymentAmount', sql.Decimal(12, 2), paymentAmount)
        .input('tolerance', sql.Decimal(12, 2), PREPAY_AMOUNT_TOLERANCE)
        .query(`
          SELECT i.InvoiceId
          FROM oe.Invoices i
          WHERE i.HouseholdId = @householdId
            AND i.InvoiceType = N'Individual'
            AND i.Status IN (N'Unpaid', N'Partial', N'Overdue')
            AND DATEDIFF(day, @paymentDate, i.BillingPeriodStart) BETWEEN 0 AND @windowDays
            AND ABS(@paymentAmount - (i.TotalAmount - COALESCE(i.PaidAmount, 0))) <= @tolerance
            AND (
              SELECT COUNT(*) FROM oe.Invoices i2
              WHERE i2.HouseholdId = @householdId
                AND i2.InvoiceType = N'Individual'
                AND i2.Status IN (N'Unpaid', N'Partial', N'Overdue')
                AND DATEDIFF(day, @paymentDate, i2.BillingPeriodStart) BETWEEN 0 AND @windowDays
                AND ABS(@paymentAmount - (i2.TotalAmount - COALESCE(i2.PaidAmount, 0))) <= @tolerance
            ) = 1
        `);
      if (prepayMatch.recordset.length === 1) {
        invoiceId = prepayMatch.recordset[0].InvoiceId;
        matchedViaPrepay = true;
      }
    }

    if (!invoiceId) {
      const res = await getOrCreateInvoiceForPayment(householdId, tenantId, paymentDate);
      invoiceId = res.invoiceId;
    }
    if (!invoiceId) return { linked: false, reason: 'no_invoice' };

    const pool = await getPool();
    await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('paymentId', sql.UniqueIdentifier, paymentId)
      .query(`UPDATE oe.Payments SET InvoiceId = @invoiceId WHERE PaymentId = @paymentId AND InvoiceId IS NULL`);

    const fulfillResult = await fulfillInvoice(invoiceId, paymentAmount);
    return { linked: true, invoiceId, fulfillResult, matchedViaPrepay };
  } catch (err) {
    console.error('⚠️ tryLinkPaymentToInvoice failed (non-blocking):', err.message);
    return { linked: false, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// getInvoiceFinancialSummary
// ---------------------------------------------------------------------------

async function getInvoiceFinancialSummary(invoiceId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`
      SELECT
        i.InvoiceId, i.InvoiceNumber, i.TotalAmount, i.PaidAmount, i.Status,
        i.BillingPeriodStart, i.BillingPeriodEnd, i.HouseholdId, i.GroupId,
        i.InvoiceType, i.DueDate,
        (SELECT COUNT(*) FROM oe.Payments p WHERE p.InvoiceId = i.InvoiceId) AS PaymentCount,
        (SELECT COALESCE(SUM(p.Amount), 0) FROM oe.Payments p WHERE p.InvoiceId = i.InvoiceId AND p.Status IN ('Completed', 'succeeded', 'Success')) AS ActualCollected
      FROM oe.Invoices i
      WHERE i.InvoiceId = @invoiceId
    `);
  return result.recordset[0] || null;
}

// ---------------------------------------------------------------------------
// runNightlyIndividualInvoices
// ---------------------------------------------------------------------------
// Runs daily. Rough flow:
//   1. Generate next-period invoices (advance window before billing anchor)
//   2. Self-heal orphan payments onto open Individual invoices (fulfill amounts + status)
//   3. Reconcile TotalAmount vs enrollments; refresh Status vs paid + credits
//   4. Detect household overpayment credits
//   5. Apply credits (FIFO); sets Status via recalcStatusFromAmounts
//   5b. Align Status = Paid wherever paid+credit fully covers Total (fixes legacy mismatches), before overdue sweep
//   6. Sync Overdue status vs tenant-calendar due date (Individual + Group; Unpaid/Partial → Overdue)
// ---------------------------------------------------------------------------

const ADVANCE_DAYS = 5;

/**
 * Align oe.Invoices.Status with tenant-local due dates:
 * - Past-due open invoices (Unpaid/Partial) → Overdue (all invoice types)
 * - Overdue rows whose due date is still today or in the future → Unpaid/Partial/Paid from amounts
 */
async function syncInvoiceOverdueStatuses(pool) {
  const overduePred = invoiceDueDateBeforeTenantLocalTodayPredicate('inv', 't');
  const notYetDuePred = invoiceDueDateOnOrAfterTenantLocalTodayPredicate('inv', 't');

  const overdueResult = await pool.request().query(`
    UPDATE inv
    SET Status = N'Overdue', ModifiedDate = GETUTCDATE()
    FROM oe.Invoices inv
    INNER JOIN oe.Tenants t ON t.TenantId = inv.TenantId
    WHERE inv.Status IN (N'Unpaid', N'Partial')
      AND inv.BalanceDue > 0.005
      AND ${overduePred}
  `);

  const resetResult = await pool.request().query(`
    UPDATE inv
    SET Status = CASE
          WHEN COALESCE(inv.PaidAmount, 0) + COALESCE(inv.CreditAmount, 0) >= inv.TotalAmount - 0.005 THEN N'Paid'
          WHEN COALESCE(inv.PaidAmount, 0) + COALESCE(inv.CreditAmount, 0) > 0.005 THEN N'Partial'
          ELSE N'Unpaid'
        END,
        ModifiedDate = GETUTCDATE()
    FROM oe.Invoices inv
    INNER JOIN oe.Tenants t ON t.TenantId = inv.TenantId
    WHERE inv.Status = N'Overdue'
      AND ${notYetDuePred}
  `);

  return {
    markedOverdue: overdueResult.rowsAffected?.[0] || 0,
    resetPrematureOverdue: resetResult.rowsAffected?.[0] || 0
  };
}

async function runNightlyIndividualInvoices() {
  const pool = await getPool();
  const stats = {
    generated: 0,
    healed: 0,
    reconciled: 0,
    markedOverdue: 0,
    resetPrematureOverdue: 0,
    dimeSynced: 0,
    dimeSyncedAfterCredits: 0,
    creditsRecognized: 0,
    creditsApplied: 0,
    statusAlignedPaid: 0,
    errors: []
  };

  // 1. Generate next-period invoices 5 days before the billing period starts.
  //    Candidates: latest individual invoice period ending within ADVANCE_DAYS.
  //    Past-due / open older invoices do not block forward generation (duplicate
  //    guard is createNextMonthInvoice existingCheck for the next period).
  try {
    const candidates = await pool.request().query(`
      SELECT
        inv.HouseholdId, inv.TenantId, inv.BillingPeriodEnd,
        (SELECT TOP 1 DAY(e.EffectiveDate)
         FROM oe.Enrollments e
         WHERE e.HouseholdId = inv.HouseholdId
           AND e.Status = N'Active'
           AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
           AND e.EnrollmentType IN (N'Product', N'Bundle')
           AND (e.GroupID IS NULL OR CAST(e.GroupID AS NVARCHAR(36)) = N'00000000-0000-0000-0000-000000000000')
         ORDER BY e.EffectiveDate ASC
        ) AS OriginalDay
      FROM oe.Invoices inv
      WHERE inv.InvoiceType = N'Individual'
        AND inv.Status <> N'Cancelled'
        AND inv.BillingPeriodEnd <= DATEADD(day, ${ADVANCE_DAYS}, GETUTCDATE())
        AND inv.InvoiceId = (
          SELECT TOP 1 i2.InvoiceId FROM oe.Invoices i2
          WHERE i2.HouseholdId = inv.HouseholdId AND i2.InvoiceType = N'Individual'
          ORDER BY i2.BillingPeriodEnd DESC
        )
        AND EXISTS (
          SELECT 1 FROM oe.Enrollments e
          WHERE e.HouseholdId = inv.HouseholdId
            AND e.Status NOT IN ('Cancelled', 'Declined', 'Terminated')
            AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        )
    `);

    for (const row of candidates.recordset) {
      try {
        const result = await createNextMonthInvoice(row.HouseholdId, row.TenantId, row.OriginalDay || 1);
        if (result) {
          stats.generated++;
          // After generating, ensure DIME recurring matches the new invoice
          try {
            const synced = await syncDimeRecurringForHousehold(pool, row.HouseholdId, row.TenantId, result.invoiceId);
            if (synced) stats.dimeSynced++;
          } catch (dimeErr) {
            stats.errors.push({ step: 'dime_sync_new', householdId: row.HouseholdId, error: dimeErr.message });
          }
        }
      } catch (err) {
        stats.errors.push({ step: 'generate', householdId: row.HouseholdId, error: err.message });
      }
    }
  } catch (err) {
    stats.errors.push({ step: 'generate_query', error: err.message });
  }

  // 2. Self-heal all unfulfilled individual invoices (link orphan payments)
  try {
    const unfulfilled = await pool.request().query(`
      SELECT InvoiceId, HouseholdId, BillingPeriodStart, BillingPeriodEnd
      FROM oe.Invoices
      WHERE InvoiceType = N'Individual' AND Status IN ('Unpaid', 'Partial', 'Overdue')
    `);

    for (const row of unfulfilled.recordset) {
      try {
        const result = await selfHealInvoice(pool, row.InvoiceId, row.HouseholdId, row.BillingPeriodStart, row.BillingPeriodEnd);
        if (result.linked > 0) stats.healed++;
      } catch (err) {
        stats.errors.push({ step: 'heal', invoiceId: row.InvoiceId, error: err.message });
      }
    }
  } catch (err) {
    stats.errors.push({ step: 'heal_query', error: err.message });
  }

  // 3. Reconcile unfulfilled invoices (plan changes update TotalAmount)
  //    If amount changed, also sync DIME recurring to match the new amount.
  try {
    const toReconcile = await pool.request().query(`
      SELECT i.InvoiceId, i.HouseholdId, i.TenantId
      FROM oe.Invoices i
      WHERE i.InvoiceType = N'Individual' AND i.Status IN ('Unpaid', 'Partial', 'Overdue')
    `);

    for (const row of toReconcile.recordset) {
      try {
        const result = await reconcileUnfulfilledInvoice(row.InvoiceId);
        if (result.updated) {
          stats.reconciled++;
          try {
            const synced = await syncDimeRecurringForHousehold(pool, row.HouseholdId, row.TenantId, row.InvoiceId);
            if (synced) stats.dimeSynced++;
          } catch (dimeErr) {
            stats.errors.push({ step: 'dime_sync_reconcile', invoiceId: row.InvoiceId, error: dimeErr.message });
          }
        }
      } catch (err) {
        stats.errors.push({ step: 'reconcile', invoiceId: row.InvoiceId, error: err.message });
      }
    }
  } catch (err) {
    stats.errors.push({ step: 'reconcile_query', error: err.message });
  }

  // 4. Detect overpayment credits (Phase 1d)
  try {
    const householdCredits = require('./householdCredits.service');
    const detected = await householdCredits.detectOverpayments();
    stats.creditsRecognized = detected.recognized || 0;
  } catch (err) {
    stats.errors.push({ step: 'detect_credits', error: err.message });
  }

  // 5. Apply available credits to oldest unpaid invoices (Phase 1d)
  //    Note: only writes oe.Invoices.CreditAmount; never PaidAmount or breakdown columns.
  let creditApplyResult = { applications: [] };
  try {
    const householdCredits = require('./householdCredits.service');
    creditApplyResult = await householdCredits.applyAvailableCredits();
    stats.creditsApplied = (creditApplyResult.applications || []).reduce((acc, app) => acc + (app.applied?.length || 0), 0);
  } catch (err) {
    stats.errors.push({ step: 'apply_credits', error: err.message });
  }

  // 5b. Align Status with PaidAmount + CreditAmount (legacy rows, or paths that skipped credit in status math).
  try {
    const alignRes = await pool.request().query(`
      UPDATE oe.Invoices
      SET Status = N'Paid',
          PaymentReceivedDate = COALESCE(PaymentReceivedDate, GETUTCDATE()),
          ModifiedDate = GETUTCDATE()
      WHERE InvoiceType = N'Individual'
        AND Status IN (N'Unpaid', N'Partial', N'Overdue')
        AND TotalAmount > 0
        AND COALESCE(PaidAmount, 0) + COALESCE(CreditAmount, 0) >= TotalAmount - 0.005
    `);
    stats.statusAlignedPaid = alignRes.rowsAffected?.[0] || 0;
  } catch (err) {
    stats.errors.push({ step: 'align_invoice_status_paid', error: err.message });
  }

  // 5c. Re-sync DIME after credits so recurring charge reflects post-credit BalanceDue (skip or reduced amount).
  const syncedAfterCreditHouseholds = new Set();
  try {
    for (const app of creditApplyResult.applications || []) {
      if (!app.householdId || syncedAfterCreditHouseholds.has(app.householdId)) continue;
      const appliedRows = app.applied || [];
      if (!appliedRows.length) continue;
      const targetInvoiceId = appliedRows[appliedRows.length - 1].invoiceId;
      if (!targetInvoiceId) continue;
      const meta = await pool.request()
        .input('invoiceId', sql.UniqueIdentifier, targetInvoiceId)
        .query(`
          SELECT TenantId, HouseholdId
          FROM oe.Invoices
          WHERE InvoiceId = @invoiceId
        `);
      const invRow = meta.recordset?.[0];
      if (!invRow?.TenantId || !invRow?.HouseholdId) continue;
      try {
        const synced = await syncDimeRecurringForHousehold(
          pool,
          invRow.HouseholdId,
          invRow.TenantId,
          targetInvoiceId
        );
        if (synced) stats.dimeSyncedAfterCredits += 1;
        syncedAfterCreditHouseholds.add(app.householdId);
      } catch (dimeErr) {
        stats.errors.push({
          step: 'dime_sync_after_credits',
          householdId: app.householdId,
          error: dimeErr.message
        });
      }
    }
  } catch (err) {
    stats.errors.push({ step: 'dime_sync_after_credits', error: err.message });
  }

  // 6. Sync Overdue status (Individual + Group; runs after paid alignment in 5b)
  try {
    const overdueStats = await syncInvoiceOverdueStatuses(pool);
    stats.markedOverdue = overdueStats.markedOverdue;
    stats.resetPrematureOverdue = overdueStats.resetPrematureOverdue;
  } catch (err) {
    stats.errors.push({ step: 'overdue', error: err.message });
  }

  return stats;
}

// ---------------------------------------------------------------------------
// syncDimeRecurringForHousehold
// Ensures the DIME recurring schedule matches the invoice amount and date.
// If amount differs, cancels existing and creates a new schedule.
// If no schedule exists but payment method is on file, creates one.
// Never leaves more than one active schedule per household.
// When credit fully covers the invoice, skips one billing cycle (recreate at
// full amount with startDate = next month) instead of cancelling outright.
// ---------------------------------------------------------------------------

function isDimeRecurringSetupRejected(result) {
  if (!result || result.success) return false;
  const msg = String(result.error?.message || result.error || '').toLowerCase();
  const code = String(result.error?.code || '').toLowerCase();
  return (
    msg.includes('amount') ||
    msg.includes('zero') ||
    msg.includes('minimum') ||
    code.includes('amount')
  );
}

async function householdHasActiveIndividualEnrollments(pool, householdId) {
  const r = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT TOP 1 1 AS x
      FROM oe.Enrollments e
      WHERE e.HouseholdId = @householdId
        AND e.Status NOT IN ('Cancelled', 'Declined', 'Terminated')
        AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        AND e.EnrollmentType IN (N'Product', N'Bundle')
        AND (e.GroupID IS NULL OR CAST(e.GroupID AS NVARCHAR(36)) = N'00000000-0000-0000-0000-000000000000')
    `);
  return (r.recordset || []).length > 0;
}

async function getActiveIndividualRecurringSchedule(pool, householdId) {
  try {
    const existing = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        SELECT TOP 1 DimeScheduleId, MonthlyAmount, NextBillingDate
        FROM oe.IndividualRecurringSchedules
        WHERE HouseholdId = @householdId AND IsActive = 1
        ORDER BY CreatedDate DESC
      `);
    return existing.recordset?.[0] || null;
  } catch {
    return null;
  }
}

async function deactivateDimeScheduleInDb(pool, dimeScheduleId) {
  await pool.request()
    .input('scheduleId', sql.NVarChar(255), dimeScheduleId)
    .query(`
      UPDATE oe.IndividualRecurringSchedules
      SET IsActive = 0, CancelledDate = GETUTCDATE(), ModifiedDate = GETUTCDATE()
      WHERE DimeScheduleId = @scheduleId
    `);
}

async function persistIndividualRecurringScheduleRow(pool, {
  householdId,
  tenantId,
  scheduleId,
  amount,
  nextBilling
}) {
  await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('scheduleId', sql.NVarChar(255), scheduleId)
    .input('amount', sql.Decimal(12, 2), amount)
    .input('nextBilling', sql.Date, nextBilling)
    .query(`
      MERGE oe.IndividualRecurringSchedules AS t
      USING (SELECT @householdId AS HouseholdId) AS s ON t.HouseholdId = s.HouseholdId AND t.DimeScheduleId = @scheduleId
      WHEN NOT MATCHED THEN INSERT (HouseholdId, TenantId, DimeScheduleId, MonthlyAmount, NextBillingDate, IsActive, CreatedDate, ModifiedDate)
        VALUES (@householdId, @tenantId, @scheduleId, @amount, @nextBilling, 1, GETUTCDATE(), GETUTCDATE());
    `);
}

/**
 * Cancel every Active DIME schedule for this customer EXCEPT the one we just
 * created. DIME is the source of truth — the DB-only cancel (one active IRS row)
 * misses orphan schedules that were created without a DB row, which has caused
 * real double-charges (e.g. two $362.69 pulls per month for one household).
 */
async function cancelOtherActiveDimeSchedules(pool, { processorCustomerId, tenantId, keepScheduleId }) {
  try {
    const listResult = await DimeService.listRecurringPaymentsForCustomer(
      String(processorCustomerId).trim(),
      tenantId,
      { status: 'Active' }
    );
    if (!listResult.success) return;
    for (const sch of listResult.schedules || []) {
      const st = String(sch.status || '').trim().toLowerCase();
      if (st !== 'active') continue;
      const sid = String(sch.id ?? sch.schedule_id ?? '').trim();
      if (!sid || sid === String(keepScheduleId).trim()) continue;
      try {
        await DimeService.cancelRecurringPayment(sid, tenantId);
        await deactivateDimeScheduleInDb(pool, sid);
        console.warn(`[invoice-dime-sync] Cancelled stray active DIME schedule ${sid} (kept ${keepScheduleId})`);
      } catch (cancelErr) {
        console.error(`[invoice-dime-sync] Failed to cancel stray DIME schedule ${sid}:`, cancelErr.message);
      }
    }
  } catch (e) {
    console.warn('[invoice-dime-sync] Stray-schedule sweep failed:', e.message);
  }
}

/**
 * Skip one DIME billing cycle: cancel current schedule and recreate at full monthly
 * amount with startDate one month after the current next billing date.
 */
async function skipDimeRecurringCycleForHousehold(pool, {
  householdId,
  tenantId,
  pm,
  existingSchedule,
  fullAmount,
  anchorDate
}) {
  const skipStart = addOneMonthUtc(existingSchedule?.NextBillingDate || anchorDate);
  if (!skipStart) return false;
  const roundedFull = Math.round((parseFloat(fullAmount) || 0) * 100) / 100;
  if (roundedFull < 0.01) return false;

  if (existingSchedule?.DimeScheduleId) {
    try {
      await DimeService.cancelRecurringPayment(existingSchedule.DimeScheduleId, tenantId);
      await deactivateDimeScheduleInDb(pool, existingSchedule.DimeScheduleId);
    } catch (cancelErr) {
      console.warn(`[invoice-dime-sync] Skip-cycle cancel failed:`, cancelErr.message);
    }
  }

  const result = await DimeService.setupRecurringPayment({
    customerId: pm.ProcessorCustomerId,
    paymentMethodId: pm.ProcessorPaymentMethodId,
    amount: roundedFull,
    description: 'Monthly Payment',
    householdId,
    startDate: skipStart
  }, tenantId);

  if (result.success && result.scheduleId) {
    try {
      await persistIndividualRecurringScheduleRow(pool, {
        householdId,
        tenantId,
        scheduleId: result.scheduleId,
        amount: roundedFull,
        nextBilling: skipStart
      });
    } catch (dbErr) {
      console.warn('[invoice-dime-sync] Could not save skip-cycle schedule:', dbErr.message);
    }
    await cancelOtherActiveDimeSchedules(pool, {
      processorCustomerId: pm.ProcessorCustomerId,
      tenantId,
      keepScheduleId: result.scheduleId
    });
    console.log(
      `[invoice-dime-sync] Skip-cycle: household ${householdId}, next charge ${skipStart.toISOString().slice(0, 10)}, amount=$${roundedFull}`
    );
    return true;
  }
  console.warn(
    `[invoice-dime-sync] Skip-cycle setup failed for household ${householdId}:`,
    result.error?.message || 'unknown'
  );
  return false;
}

async function syncDimeRecurringForHousehold(pool, householdId, tenantId, invoiceId) {
  // Phase 12 — read BalanceDue (post-credit) instead of TotalAmount so member
  // credit auto-reduces the next DIME charge. CreditAmount is tolerated for
  // back-compat with deployments that haven't run the Phase 1a migration yet.
  const inv = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`
      SELECT TotalAmount,
             COALESCE(PaidAmount, 0) AS PaidAmount,
             COALESCE(CreditAmount, 0) AS CreditAmount,
             BalanceDue,
             DueDate,
             BillingPeriodStart
      FROM oe.Invoices
      WHERE InvoiceId = @invoiceId
    `);
  if (!inv.recordset.length) return false;

  const row = inv.recordset[0];
  const total = parseFloat(row.TotalAmount) || 0;
  const paid = parseFloat(row.PaidAmount) || 0;
  const credit = parseFloat(row.CreditAmount) || 0;

  const bpsRaw = row.BillingPeriodStart;
  if (bpsRaw) {
    const bps = new Date(bpsRaw);
    const billingAnchorHint = await getHouseholdBillingAnchor(pool, householdId);
    if (
      billingAnchorHint &&
      bps.getUTCDate() !== billingAnchorHint.anchorDay
    ) {
      console.warn(
        `[invoice-dime-sync] BillingPeriodStart day-of-month (${bps.getUTCDate()}) differs from unified enrollment anchor (${billingAnchorHint.anchorDay}); household=${householdId}, invoice=${invoiceId}`
      );
    }
  }
  // Prefer the persisted BalanceDue computed column when present, otherwise
  // recompute from the parts above.
  const computedBalance = Number.isFinite(parseFloat(row.BalanceDue))
    ? parseFloat(row.BalanceDue)
    : Math.max(0, total - paid - credit);
  const invoiceAmount = Math.max(0, computedBalance);
  const dueDate = row.DueDate || row.BillingPeriodStart;
  const bps = row.BillingPeriodStart ? new Date(row.BillingPeriodStart) : new Date();
  const bpe = new Date(bps);
  bpe.setUTCMonth(bpe.getUTCMonth() + 1);
  const { totalAmount: enrollmentMonthly } = await computeTotalFromEnrollments(
    pool,
    householdId,
    bps,
    bpe
  );
  const fullMonthlyAmount = Math.round(enrollmentMonthly * 100) / 100;
  const creditReducesRecurring = credit > 0.005;
  const targetRecurringAmount = creditReducesRecurring
    ? Math.round(invoiceAmount * 100) / 100
    : fullMonthlyAmount;

  // Get the household's DIME payment method (needed for skip-cycle and amount updates)
  const pmResult = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT TOP 1 mpm.ProcessorCustomerId, mpm.ProcessorPaymentMethodId
      FROM oe.MemberPaymentMethods mpm
      INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
      WHERE m.HouseholdId = @householdId AND m.RelationshipType = 'P'
        AND mpm.Status = 'Active'
        AND mpm.ProcessorCustomerId IS NOT NULL AND mpm.ProcessorPaymentMethodId IS NOT NULL
      ORDER BY mpm.IsDefault DESC, mpm.CreatedDate DESC
    `);
  const pm = pmResult.recordset?.[0];
  if (!pm?.ProcessorCustomerId || !pm?.ProcessorPaymentMethodId) return false;

  const existingSchedule = await getActiveIndividualRecurringSchedule(pool, householdId);

  if (invoiceAmount <= 0) {
    const hasEnrollments = await householdHasActiveIndividualEnrollments(pool, householdId);
    const scheduleFullAmount = Math.round(
      (parseFloat(existingSchedule?.MonthlyAmount) || fullMonthlyAmount) * 100
    ) / 100;
    if (hasEnrollments && scheduleFullAmount >= 0.01) {
      return skipDimeRecurringCycleForHousehold(pool, {
        householdId,
        tenantId,
        pm,
        existingSchedule,
        fullAmount: scheduleFullAmount,
        anchorDate: dueDate
      });
    }
    if (existingSchedule?.DimeScheduleId) {
      try {
        await DimeService.cancelRecurringPayment(existingSchedule.DimeScheduleId, tenantId);
        await deactivateDimeScheduleInDb(pool, existingSchedule.DimeScheduleId);
        console.log(`[invoice-dime-sync] Cancelled DIME schedule for household ${householdId} — no active enrollments`);
      } catch (cancelErr) {
        console.warn(`[invoice-dime-sync] Could not cancel zero-balance schedule:`, cancelErr.message);
      }
    }
    return false;
  }

  const roundedInvoice = Math.round(targetRecurringAmount * 100) / 100;
  const scheduleFullAmount = Math.round(
    (parseFloat(existingSchedule?.MonthlyAmount) || fullMonthlyAmount) * 100
  ) / 100;

  if (existingSchedule) {
    const existingAmount = Math.round((parseFloat(existingSchedule.MonthlyAmount) || 0) * 100) / 100;
    if (Math.abs(existingAmount - roundedInvoice) < 0.01) {
      return false; // Already correct
    }

    // Amount mismatch — cancel existing, create new
    console.log(`[invoice-dime-sync] Amount mismatch for household ${householdId}: schedule=$${existingAmount}, target=$${roundedInvoice}. Updating.`);
    try {
      await DimeService.cancelRecurringPayment(existingSchedule.DimeScheduleId, tenantId);
      await deactivateDimeScheduleInDb(pool, existingSchedule.DimeScheduleId);
    } catch (cancelErr) {
      console.error(`[invoice-dime-sync] Failed to cancel old schedule ${existingSchedule.DimeScheduleId}:`, cancelErr.message);
    }
  }

  // Create new schedule with correct amount (post-credit BalanceDue)
  const startDate = new Date(dueDate);
  let result = await DimeService.setupRecurringPayment({
    customerId: pm.ProcessorCustomerId,
    paymentMethodId: pm.ProcessorPaymentMethodId,
    amount: roundedInvoice,
    description: 'Monthly Payment',
    householdId,
    startDate
  }, tenantId);

  if (
    !result.success &&
    (isDimeRecurringSetupRejected(result) || roundedInvoice < 0.01) &&
    scheduleFullAmount >= 0.01
  ) {
    return skipDimeRecurringCycleForHousehold(pool, {
      householdId,
      tenantId,
      pm,
      existingSchedule,
      fullAmount: scheduleFullAmount,
      anchorDate: dueDate
    });
  }

  if (result.success && result.scheduleId) {
    try {
      await persistIndividualRecurringScheduleRow(pool, {
        householdId,
        tenantId,
        scheduleId: result.scheduleId,
        amount: roundedInvoice,
        nextBilling: startDate
      });
    } catch (dbErr) {
      console.warn('[invoice-dime-sync] Could not save schedule to IndividualRecurringSchedules:', dbErr.message);
    }
    await cancelOtherActiveDimeSchedules(pool, {
      processorCustomerId: pm.ProcessorCustomerId,
      tenantId,
      keepScheduleId: result.scheduleId
    });
    console.log(`[invoice-dime-sync] Created recurring schedule ${result.scheduleId} for household ${householdId}, amount=$${roundedInvoice}`);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// runIndividualInvoiceOpenMaintenanceNow
// Runs the same per-invoice sequence as nightly for one open Individual
// invoice: selfHealInvoice → reconcileUnfulfilledInvoice →
// syncDimeRecurringForHousehold when reconcile updated totals (matches
// runNightlyIndividualInvoices steps 2–3 ordering for that invoice).
// ---------------------------------------------------------------------------

async function runIndividualInvoiceOpenMaintenanceNow(invoiceId) {
  const pool = await getPool();
  const invRes = await pool
    .request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`
      SELECT InvoiceId, HouseholdId, TenantId, BillingPeriodStart, BillingPeriodEnd,
             InvoiceType, Status
      FROM oe.Invoices
      WHERE InvoiceId = @invoiceId
    `);

  if (!invRes.recordset?.length) {
    return { ok: false, message: 'Invoice not found' };
  }

  const row = invRes.recordset[0];
  const invoiceType = (row.InvoiceType || '').toString();
  if (invoiceType !== 'Individual' || !row.HouseholdId) {
    return {
      ok: false,
      message: 'Resync applies to individual (household) invoices only.'
    };
  }

  const openStatuses = ['Unpaid', 'Partial', 'Overdue'];
  const st = (row.Status || '').toString();

  // Resync also reconciles PaidAmount/Status drift on closed invoices
  // (Paid / Cancelled). Use case: a refund or chargeback came through but
  // (for any reason) the invoice ledger wasn't unfulfilled at the time, so
  // PaidAmount is stuck high. Recompute from the actual oe.Payments truth
  // and re-derive Status from the same rules unfulfillInvoiceInTxn uses.
  if (!openStatuses.includes(st)) {
    const enrollmentTotalsSync = await reconcilePaidIndividualInvoiceTotalsWhenEligible(invoiceId);
    const ledgerSync = await reconcilePaidAmountFromLedger(pool, invoiceId);
    if (ledgerSync.updated || enrollmentTotalsSync.updated) {
      return {
        ok: true,
        data: {
          enrollmentTotalsSync,
          ledgerSync,
          reconcile: { updated: false, reason: 'invoice_was_closed' },
          dimeRecurringSynced: false,
          dimeSyncError: null
        }
      };
    }
    return {
      ok: true,
      skipped: true,
      reason: 'nightly_skips_non_open_invoice',
      status: row.Status,
      message:
        'The nightly job only self-heals and reconciles open invoices (Unpaid, Partial, Overdue). This invoice was not modified.'
    };
  }

  // Open invoice path: also do a ledger reconcile in case prior refunds left
  // PaidAmount > what oe.Payments actually nets out to.
  const ledgerSync = await reconcilePaidAmountFromLedger(pool, invoiceId);

  const heal = await selfHealInvoice(
    pool,
    invoiceId,
    row.HouseholdId,
    row.BillingPeriodStart,
    row.BillingPeriodEnd
  );
  const reconcile = await reconcileUnfulfilledInvoice(invoiceId);

  let dimeRecurringSynced = false;
  /** @type {string|null} */
  let dimeSyncError = null;
  if (reconcile.updated) {
    try {
      dimeRecurringSynced = await syncDimeRecurringForHousehold(
        pool,
        row.HouseholdId,
        row.TenantId,
        invoiceId
      );
    } catch (e) {
      dimeSyncError = e.message || String(e);
    }
  }

  return {
    ok: true,
    data: {
      ledgerSync,
      selfHeal: { linkedPayments: heal.linked, paidAmountApplied: heal.paidAmount },
      reconcile: reconcile.updated
        ? { updated: true, newTotalAmount: reconcile.newTotalAmount }
        : { updated: false, reason: reconcile.reason || 'no_change' },
      dimeRecurringSynced,
      dimeSyncError
    }
  };
}

/**
 * Recompute oe.Invoices.PaidAmount from the oe.Payments truth (settled
 * payments minus completed refunds linked to this invoice) and re-derive
 * Status using the same rules as unfulfillInvoiceInTxn. Idempotent — a no-op
 * when the recomputed PaidAmount + Status already match what's stored.
 *
 * Counts:
 *   • Positive: TransactionType IN ('Payment', 'Recurring') AND Status IN
 *     ('Completed', 'Refunded'). Refunded counts because the original money
 *     did land; the refund row below subtracts it.
 *   • Negative: TransactionType = 'Refund' AND Status = 'Completed'. Stored
 *     as negative Amount, so we subtract ABS(amount) explicitly to be safe
 *     against rows that were inserted with a positive sign by mistake.
 */
async function reconcilePaidAmountFromLedger(pool, invoiceId) {
  const sumRes = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`
      SELECT
        COALESCE(SUM(CASE
          WHEN TransactionType IN (N'Payment', N'Recurring')
            AND Status IN (N'Completed', N'Refunded')
          THEN Amount
          ELSE 0
        END), 0) AS PositiveSum,
        COALESCE(SUM(CASE
          WHEN TransactionType = N'Refund' AND Status = N'Completed'
          THEN ABS(Amount)
          ELSE 0
        END), 0) AS RefundSum
      FROM oe.Payments
      WHERE InvoiceId = @invoiceId
    `);

  const positive = Number(sumRes.recordset?.[0]?.PositiveSum) || 0;
  const refunded = Number(sumRes.recordset?.[0]?.RefundSum) || 0;
  const recomputedPaid = Math.max(0, Math.round((positive - refunded) * 100) / 100);

  const invRes = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`
      SELECT TotalAmount, PaidAmount, CreditAmount, Status
      FROM oe.Invoices
      WHERE InvoiceId = @invoiceId
    `);
  if (!invRes.recordset?.length) return { updated: false, reason: 'invoice_not_found' };

  const total = Number(invRes.recordset[0].TotalAmount) || 0;
  const credit = Number(invRes.recordset[0].CreditAmount) || 0;
  const currentPaid = Number(invRes.recordset[0].PaidAmount) || 0;
  const currentStatus = String(invRes.recordset[0].Status || '');

  const totalCovered = recomputedPaid + credit;
  let newStatus;
  if (currentStatus === 'Cancelled') {
    // Don't auto-resurrect a manually cancelled invoice.
    newStatus = 'Cancelled';
  } else if (totalCovered <= 0) {
    newStatus = 'Unpaid';
  } else if (totalCovered < total - 0.005) {
    newStatus = 'Partial';
  } else {
    newStatus = 'Paid';
  }

  const paidChanged = Math.abs(recomputedPaid - currentPaid) > 0.005;
  const statusChanged = newStatus !== currentStatus;
  if (!paidChanged && !statusChanged) {
    return { updated: false, reason: 'already_in_sync', recomputedPaid, status: currentStatus };
  }

  await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('paidAmount', sql.Decimal(12, 2), recomputedPaid)
    .input('status', sql.NVarChar(50), newStatus)
    .query(`
      UPDATE oe.Invoices
      SET PaidAmount = @paidAmount,
          Status = @status,
          PaymentReceivedDate = CASE WHEN @status <> N'Paid' THEN NULL ELSE PaymentReceivedDate END,
          ModifiedDate = GETUTCDATE()
      WHERE InvoiceId = @invoiceId
    `);

  return {
    updated: true,
    previousPaid: currentPaid,
    newPaidAmount: recomputedPaid,
    previousStatus: currentStatus,
    newStatus
  };
}

async function fetchHouseholdEnrollmentBillingDom(pool, householdId) {
  const anchor = await getHouseholdBillingAnchor(pool, householdId);
  return anchor ? anchor.anchorDay : 1;
}

function noonUtcOnBillingDom(year, monthIndex0To11, dayOfMonth) {
  const lastDay = new Date(Date.UTC(year, monthIndex0To11 + 1, 0)).getUTCDate();
  const dom = Math.min(dayOfMonth, lastDay);
  return new Date(Date.UTC(year, monthIndex0To11, dom, 12, 0, 0, 0));
}

/**
 * After a manual accounting payment retry succeeds (charge-card/charge-ach toward an Individual
 * invoice), DIME recurring may otherwise pull again for the same period. Create a replacement
 * Monthly schedule whose first debit is strictly after this invoice BillingPeriodEnd, then cancel
 * the prior schedule (matches create-then-cancel pattern in payments/setup-recurring).
 *
 * Safe no-ops when there is no active Individual row, no Individual invoice linkage, groups, etc.
 */
async function rescheduleDimeRecurringAfterAccountingPaymentRetry(
  pool,
  householdId,
  tenantId,
  invoiceId
) {
  if (!householdId || !tenantId || !invoiceId) {
    return { skipped: true, reason: 'missing_params' };
  }

  const invRes = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`
      SELECT InvoiceId, HouseholdId, TenantId, InvoiceType,
             CAST(BillingPeriodEnd AS DATE) AS BillingPeriodEnd
      FROM oe.Invoices
      WHERE InvoiceId = @invoiceId
    `);
  const invRow = invRes.recordset?.[0];
  if (!invRow) return { skipped: true, reason: 'invoice_not_found' };
  if ((invRow.InvoiceType || '').toString() !== 'Individual') {
    return { skipped: true, reason: 'not_individual_invoice' };
  }
  if (String(invRow.HouseholdId || '') !== String(householdId)) {
    return { skipped: true, reason: 'household_invoice_mismatch' };
  }

  let existingSchedule = null;
  try {
    const existing = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        SELECT TOP 1 DimeScheduleId, MonthlyAmount
        FROM oe.IndividualRecurringSchedules
        WHERE HouseholdId = @householdId AND IsActive = 1
        ORDER BY CreatedDate DESC
      `);
    existingSchedule = existing.recordset?.[0] || null;
  } catch (e) {
    return {
      skipped: true,
      reason: 'individual_recurring_table_unreadable',
      error: e.message
    };
  }
  const oldSid = existingSchedule?.DimeScheduleId
    ? String(existingSchedule.DimeScheduleId).trim()
    : '';
  if (!oldSid) return { skipped: true, reason: 'no_active_dime_schedule' };

  const monthlyAmount =
    Math.round((parseFloat(existingSchedule.MonthlyAmount) || 0) * 100) / 100;
  if (!(monthlyAmount > 0)) {
    return { skipped: true, reason: 'schedule_monthly_amount_zero' };
  }

  const dom = await fetchHouseholdEnrollmentBillingDom(pool, householdId);
  const bpe = invRow.BillingPeriodEnd
    ? invRow.BillingPeriodEnd instanceof Date
      ? invRow.BillingPeriodEnd
      : new Date(invRow.BillingPeriodEnd)
    : null;

  if (!bpe || Number.isNaN(bpe.getTime())) {
    return { skipped: true, reason: 'missing_billing_period_end' };
  }

  /** First calendar month strictly after BillingPeriodEnd (UTC). */
  let y = bpe.getUTCFullYear();
  let m = bpe.getUTCMonth() + 1;
  if (m > 11) {
    m = 0;
    y += 1;
  }

  const nowMs = Date.now();
  /** @type {Date|null} */
  let picked = null;

  const maxAttempts = 36;
  let attempt = 0;
  while (attempt < maxAttempts) {
    const cand = noonUtcOnBillingDom(y, m, dom);
    if (cand.getTime() > nowMs) {
      picked = cand;
      break;
    }

    attempt += 1;
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }

  if (!picked) {
    return { skipped: false, recreated: false, error: 'Could not derive future recurring start date' };
  }

  const pmResult = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT TOP 1 mpm.ProcessorCustomerId, mpm.ProcessorPaymentMethodId
      FROM oe.MemberPaymentMethods mpm
      INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
      WHERE m.HouseholdId = @householdId AND m.RelationshipType = 'P'
        AND mpm.Status = 'Active'
        AND mpm.ProcessorCustomerId IS NOT NULL AND mpm.ProcessorPaymentMethodId IS NOT NULL
      ORDER BY mpm.IsDefault DESC, mpm.CreatedDate DESC
    `);

  const pm = pmResult.recordset?.[0];
  if (!pm?.ProcessorCustomerId || !pm?.ProcessorPaymentMethodId) {
    return { skipped: true, reason: 'no_primary_payment_method_for_recurring' };
  }

  const createResult = await DimeService.setupRecurringPayment(
    {
      customerId: pm.ProcessorCustomerId,
      paymentMethodId: pm.ProcessorPaymentMethodId,
      amount: monthlyAmount,
      description: 'Monthly Payment',
      householdId,
      startDate: picked
    },
    tenantId
  );

  if (!createResult.success || !createResult.scheduleId) {
    return {
      skipped: false,
      recreated: false,
      error: createResult.error?.message || 'DIME recurring create failed during reschedule'
    };
  }

  const newSid = String(createResult.scheduleId);

  let cancelSucceeded = false;
  let cancelWarn = null;

  try {
    const cancelOld = await DimeService.cancelRecurringPayment(oldSid, tenantId);
    cancelSucceeded = !!cancelOld.success;
    if (!cancelOld.success) {
      cancelWarn =
        cancelOld.error?.message || String(cancelOld.error || '') || 'DIME cancel old recurring failed';
      console.warn(
        '[retry-dime-recurring] New schedule exists but cancel of old recurring may have failed — duplicate recurring risk:',
        oldSid,
        cancelWarn
      );
    }

    await pool
      .request()
      .input('scheduleIdOld', sql.NVarChar(255), oldSid)
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        UPDATE oe.IndividualRecurringSchedules
        SET IsActive = 0, ModifiedDate = GETUTCDATE()
        WHERE DimeScheduleId = @scheduleIdOld AND HouseholdId = @householdId
      `);

    await pool
      .request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('scheduleIdKeep', sql.NVarChar(255), newSid)
      .query(`
        UPDATE oe.IndividualRecurringSchedules
        SET IsActive = 0, ModifiedDate = GETUTCDATE()
        WHERE HouseholdId = @householdId
          AND IsActive = 1
          AND DimeScheduleId <> @scheduleIdKeep
      `);

    await pool
      .request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('scheduleId', sql.NVarChar(255), newSid)
      .input('amount', sql.Decimal(12, 2), monthlyAmount)
      .input('nextBilling', sql.DateTime2, picked)
      .query(`
        MERGE oe.IndividualRecurringSchedules AS t
        USING (SELECT @householdId AS HouseholdId) AS s ON t.HouseholdId = s.HouseholdId AND t.DimeScheduleId = @scheduleId
        WHEN NOT MATCHED THEN INSERT (HouseholdId, TenantId, DimeScheduleId, MonthlyAmount, NextBillingDate, IsActive, CreatedDate, ModifiedDate)
          VALUES (@householdId, @tenantId, @scheduleId, @amount, @nextBilling, 1, GETUTCDATE(), GETUTCDATE());
      `);

    await pool
      .request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('scheduleIdKeep', sql.NVarChar(255), newSid)
      .query(`
        UPDATE oe.IndividualRecurringSchedules
        SET IsActive = 1, ModifiedDate = GETUTCDATE()
        WHERE HouseholdId = @householdId AND DimeScheduleId = @scheduleIdKeep
      `);
  } catch (e) {
    console.error('[retry-dime-recurring] Post-create bookkeeping error:', e.message || e);
    return {
      skipped: false,
      recreated: true,
      partialDbSync: true,
      newScheduleId: newSid,
      previousScheduleId: oldSid,
      startDate: picked.toISOString(),
      warning: cancelWarn || e.message,
      duplicateRecurringRisk: !cancelSucceeded
    };
  }

  return {
    skipped: false,
    recreated: true,
    newScheduleId: newSid,
    previousScheduleId: oldSid,
    startDate: picked.toISOString(),
    cancelOldSucceeded: cancelSucceeded,
    ...(cancelWarn || !cancelSucceeded
      ? { duplicateRecurringRisk: !cancelSucceeded, warning: cancelWarn }
      : {})
  };
}

const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

async function isGroupBillingHousehold(pool, householdId) {
  const r = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT TOP 1 m.GroupId
      FROM oe.Members m
      WHERE m.HouseholdId = @householdId AND m.RelationshipType = 'P'
    `);
  const groupId = r.recordset?.[0]?.GroupId;
  if (!groupId) return false;
  return String(groupId).toLowerCase() !== EMPTY_GUID;
}

async function getAllActiveIndividualRecurringSchedules(pool, householdId) {
  try {
    const existing = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        SELECT DimeScheduleId, MonthlyAmount, NextBillingDate
        FROM oe.IndividualRecurringSchedules
        WHERE HouseholdId = @householdId AND IsActive = 1
        ORDER BY CreatedDate ASC
      `);
    return existing.recordset || [];
  } catch {
    return [];
  }
}

async function loadPaymentMethodForRecurringSync(pool, paymentMethodId, householdId) {
  const r = await pool.request()
    .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT mpm.PaymentMethodId, mpm.IsDefault, mpm.ProcessorCustomerId, mpm.ProcessorPaymentMethodId
      FROM oe.MemberPaymentMethods mpm
      INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
      WHERE mpm.PaymentMethodId = @paymentMethodId
        AND m.HouseholdId = @householdId
        AND mpm.Status = 'Active'
    `);
  return r.recordset?.[0] || null;
}

/**
 * Next recurring start for PM-change recreation: keep a future NextBillingDate;
 * otherwise next billing-anchor-day strictly after now.
 */
function computeFutureRecurringStartDateForPmChange(storedNextBilling, dom, nowMs = Date.now()) {
  if (storedNextBilling) {
    const nbd = storedNextBilling instanceof Date ? storedNextBilling : new Date(storedNextBilling);
    if (!Number.isNaN(nbd.getTime()) && nbd.getTime() > nowMs) {
      return nbd;
    }
  }

  const now = new Date(nowMs);
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  const maxAttempts = 36;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const cand = noonUtcOnBillingDom(y, m, dom);
    if (cand.getTime() > nowMs) {
      return cand;
    }
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }

  return null;
}

async function recreateSingleDimeScheduleForPmChange(pool, {
  householdId,
  tenantId,
  pm,
  existingSchedule,
  dom,
}) {
  const oldSid = existingSchedule?.DimeScheduleId
    ? String(existingSchedule.DimeScheduleId).trim()
    : '';
  if (!oldSid) {
    return { skipped: true, reason: 'missing_schedule_id' };
  }

  const monthlyAmount = Math.round((parseFloat(existingSchedule.MonthlyAmount) || 0) * 100) / 100;
  if (!(monthlyAmount > 0)) {
    return { skipped: true, reason: 'schedule_monthly_amount_zero' };
  }

  const picked = computeFutureRecurringStartDateForPmChange(
    existingSchedule.NextBillingDate,
    dom
  );
  if (!picked) {
    return { skipped: false, recreated: false, error: 'Could not derive future recurring start date' };
  }

  const createResult = await DimeService.setupRecurringPayment(
    {
      customerId: pm.ProcessorCustomerId,
      paymentMethodId: pm.ProcessorPaymentMethodId,
      amount: monthlyAmount,
      description: 'Monthly Payment',
      householdId,
      startDate: picked,
    },
    tenantId
  );

  if (!createResult.success || !createResult.scheduleId) {
    return {
      skipped: false,
      recreated: false,
      error: createResult.error?.message || 'DIME recurring create failed during PM-change recreation',
    };
  }

  const newSid = String(createResult.scheduleId);
  let cancelSucceeded = false;
  let cancelWarn = null;

  try {
    const cancelOld = await DimeService.cancelRecurringPayment(oldSid, tenantId);
    cancelSucceeded = !!cancelOld.success;
    if (!cancelOld.success) {
      cancelWarn =
        cancelOld.error?.message || String(cancelOld.error || '') || 'DIME cancel old recurring failed';
      console.warn(
        '[pm-change-dime-recurring] New schedule exists but cancel of old recurring may have failed — duplicate recurring risk:',
        oldSid,
        cancelWarn
      );
    }

    await pool
      .request()
      .input('scheduleIdOld', sql.NVarChar(255), oldSid)
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        UPDATE oe.IndividualRecurringSchedules
        SET IsActive = 0, ModifiedDate = GETUTCDATE()
        WHERE DimeScheduleId = @scheduleIdOld AND HouseholdId = @householdId
      `);

    await pool
      .request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('scheduleIdKeep', sql.NVarChar(255), newSid)
      .query(`
        UPDATE oe.IndividualRecurringSchedules
        SET IsActive = 0, ModifiedDate = GETUTCDATE()
        WHERE HouseholdId = @householdId
          AND IsActive = 1
          AND DimeScheduleId <> @scheduleIdKeep
      `);

    await pool
      .request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('scheduleId', sql.NVarChar(255), newSid)
      .input('amount', sql.Decimal(12, 2), monthlyAmount)
      .input('nextBilling', sql.DateTime2, picked)
      .query(`
        MERGE oe.IndividualRecurringSchedules AS t
        USING (SELECT @householdId AS HouseholdId) AS s ON t.HouseholdId = s.HouseholdId AND t.DimeScheduleId = @scheduleId
        WHEN NOT MATCHED THEN INSERT (HouseholdId, TenantId, DimeScheduleId, MonthlyAmount, NextBillingDate, IsActive, CreatedDate, ModifiedDate)
          VALUES (@householdId, @tenantId, @scheduleId, @amount, @nextBilling, 1, GETUTCDATE(), GETUTCDATE());
      `);

    await pool
      .request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('scheduleIdKeep', sql.NVarChar(255), newSid)
      .query(`
        UPDATE oe.IndividualRecurringSchedules
        SET IsActive = 1, ModifiedDate = GETUTCDATE()
        WHERE HouseholdId = @householdId AND DimeScheduleId = @scheduleIdKeep
      `);
  } catch (e) {
    console.error('[pm-change-dime-recurring] Post-create bookkeeping error:', e.message || e);
    return {
      skipped: false,
      recreated: true,
      partialDbSync: true,
      newScheduleId: newSid,
      previousScheduleId: oldSid,
      startDate: picked.toISOString(),
      warning: cancelWarn || e.message,
      duplicateRecurringRisk: !cancelSucceeded,
    };
  }

  return {
    skipped: false,
    recreated: true,
    newScheduleId: newSid,
    previousScheduleId: oldSid,
    startDate: picked.toISOString(),
    cancelOldSucceeded: cancelSucceeded,
    ...(cancelWarn || !cancelSucceeded
      ? { duplicateRecurringRisk: !cancelSucceeded, warning: cancelWarn }
      : {}),
  };
}

/**
 * When a default vaulted payment method changes, cancel+recreate DIME recurring on the new PM.
 * Individual billing only; preserves schedule amount; create-then-cancel per schedule.
 */
async function recreateRecurringForPaymentMethodChange(
  pool,
  {
    householdId,
    tenantId,
    newPaymentMethodId,
    previousProcessorPaymentMethodId = null,
    forceRecreate = false,
  }
) {
  if (!householdId || !tenantId || !newPaymentMethodId) {
    return { skipped: true, reason: 'missing_params', recurringRecreated: false };
  }

  if (await isGroupBillingHousehold(pool, householdId)) {
    return { skipped: true, reason: 'group_household', recurringRecreated: false };
  }

  const pm = await loadPaymentMethodForRecurringSync(pool, newPaymentMethodId, householdId);
  if (!pm) {
    return { skipped: true, reason: 'payment_method_not_found', recurringRecreated: false };
  }
  if (!pm.IsDefault) {
    return { skipped: true, reason: 'not_default_payment_method', recurringRecreated: false };
  }
  if (!pm.ProcessorCustomerId || !pm.ProcessorPaymentMethodId) {
    return { skipped: true, reason: 'payment_method_not_vaulted', recurringRecreated: false };
  }

  const processorPmId = String(pm.ProcessorPaymentMethodId).trim();
  if (
    !forceRecreate &&
    previousProcessorPaymentMethodId &&
    processorPmId === String(previousProcessorPaymentMethodId).trim()
  ) {
    return { skipped: true, reason: 'same_payment_method', recurringRecreated: false };
  }

  const activeSchedules = await getAllActiveIndividualRecurringSchedules(pool, householdId);
  if (!activeSchedules.length) {
    return { skipped: true, reason: 'no_active_dime_schedule', recurringRecreated: false };
  }

  for (const schedule of activeSchedules) {
    const amt = Math.round((parseFloat(schedule.MonthlyAmount) || 0) * 100) / 100;
    if (!(amt > 0)) {
      return {
        skipped: true,
        reason: 'schedule_monthly_amount_zero',
        recurringRecreated: false,
        recurringWarning: 'Could not recreate recurring: one or more active schedules have zero amount',
      };
    }
  }

  const dom = await fetchHouseholdEnrollmentBillingDom(pool, householdId);
  const results = [];
  let latestStartDate = null;

  for (const schedule of activeSchedules) {
    const result = await recreateSingleDimeScheduleForPmChange(pool, {
      householdId,
      tenantId,
      pm,
      existingSchedule: schedule,
      dom,
    });
    results.push(result);
    if (result.startDate) {
      latestStartDate = result.startDate;
    }
    if (result.recreated === false && result.error) {
      return {
        skipped: false,
        recurringRecreated: false,
        recurringWarning: result.error,
        scheduleResults: results,
      };
    }
  }

  const anyRecreated = results.some((r) => r.recreated);
  const anyDuplicateRisk = results.some((r) => r.duplicateRecurringRisk);
  const warnings = results.map((r) => r.warning).filter(Boolean);

  return {
    skipped: false,
    recurringRecreated: anyRecreated,
    newRecurringStartDate: latestStartDate || undefined,
    scheduleResults: results,
    ...(warnings.length ? { recurringWarning: warnings.join('; ') } : {}),
    ...(anyDuplicateRisk ? { duplicateRecurringRisk: true } : {}),
  };
}

/**
 * Oldest payable individual invoice with no Pending payment — drives pay-now prompt after PM save.
 */
async function findOutstandingInvoiceForPaymentMethodPrompt(pool, householdId) {
  if (!householdId) return null;
  if (await isGroupBillingHousehold(pool, householdId)) return null;

  const r = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT TOP 1
        i.InvoiceId,
        i.InvoiceNumber,
        i.BillingPeriodStart,
        i.BillingPeriodEnd,
        COALESCE(
          i.BalanceDue,
          i.TotalAmount - COALESCE(i.PaidAmount, 0) - COALESCE(i.CreditAmount, 0)
        ) AS BalanceDue,
        i.Status
      FROM oe.Invoices i
      WHERE i.HouseholdId = @householdId
        AND i.InvoiceType = N'Individual'
        AND LOWER(i.Status) IN (N'unpaid', N'partial', N'overdue')
        AND COALESCE(
          i.BalanceDue,
          i.TotalAmount - COALESCE(i.PaidAmount, 0) - COALESCE(i.CreditAmount, 0)
        ) > 0.005
        AND NOT EXISTS (
          SELECT 1 FROM oe.Payments p
          WHERE p.InvoiceId = i.InvoiceId
            AND LOWER(p.Status) = N'pending'
        )
      ORDER BY i.BillingPeriodStart ASC, i.CreatedDate ASC
    `);

  const row = r.recordset?.[0];
  if (!row) return null;

  const balanceDue = Math.round((parseFloat(row.BalanceDue) || 0) * 100) / 100;
  if (balanceDue <= 0.005) return null;

  const bps = row.BillingPeriodStart
    ? (row.BillingPeriodStart instanceof Date
      ? row.BillingPeriodStart.toISOString().slice(0, 10)
      : String(row.BillingPeriodStart).slice(0, 10))
    : null;
  const bpe = row.BillingPeriodEnd
    ? (row.BillingPeriodEnd instanceof Date
      ? row.BillingPeriodEnd.toISOString().slice(0, 10)
      : String(row.BillingPeriodEnd).slice(0, 10))
    : null;

  return {
    invoiceId: String(row.InvoiceId),
    invoiceNumber: row.InvoiceNumber ? String(row.InvoiceNumber) : null,
    billingPeriodStart: bps,
    billingPeriodEnd: bpe,
    balanceDue,
    status: String(row.Status || ''),
  };
}

/**
 * Route helper: recreate recurring (non-fatal) then detect outstanding invoice for UI prompt.
 */
async function syncRecurringAfterPaymentMethodChange(pool, options) {
  let recurringRecreated = false;
  let newRecurringStartDate;
  let recurringWarning;
  let duplicateRecurringRisk;

  try {
    const recreateResult = await recreateRecurringForPaymentMethodChange(pool, options);
    recurringRecreated = !!recreateResult.recurringRecreated;
    newRecurringStartDate = recreateResult.newRecurringStartDate;
    recurringWarning = recreateResult.recurringWarning
      || (recreateResult.skipped && recreateResult.reason && !['same_payment_method', 'no_active_dime_schedule'].includes(recreateResult.reason)
        ? recreateResult.reason
        : undefined);
    duplicateRecurringRisk = recreateResult.duplicateRecurringRisk;
    if (recreateResult.error) {
      recurringWarning = recreateResult.error;
    }
  } catch (e) {
    console.error('[pm-change-dime-recurring] Non-fatal recreation error:', e.message || e);
    recurringWarning = e.message || 'Failed to update recurring payment schedule';
  }

  let outstandingInvoice;
  try {
    outstandingInvoice = await findOutstandingInvoiceForPaymentMethodPrompt(
      pool,
      options.householdId
    );
  } catch (e) {
    console.error('[pm-change-dime-recurring] Outstanding invoice lookup failed:', e.message || e);
  }

  return {
    recurringRecreated,
    ...(newRecurringStartDate ? { newRecurringStartDate } : {}),
    ...(recurringWarning ? { recurringWarning } : {}),
    ...(duplicateRecurringRisk ? { duplicateRecurringRisk } : {}),
    ...(outstandingInvoice ? { outstandingInvoice } : {}),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  computeTotalFromEnrollments,
  monthlyDueFromEnrollmentSums,
  getIndividualInvoicePdfLineItems,
  computeInvoiceBreakdowns,
  createInvoiceForEnrollment,
  createNextMonthInvoice,
  fulfillInvoice,
  unfulfillInvoice,
  unfulfillInvoiceInTxn,
  reconcileUnfulfilledInvoice,
  reconcilePaidIndividualInvoiceTotalsWhenEligible,
  previewOpenInvoiceReconcileForHousehold,
  previewPaidInvoiceAlignmentAfterPlanChange,
  applyPaidInvoiceAlignmentForHousehold,
  reconcileOpenInvoicesForHousehold,
  getOrCreateInvoiceForPayment,
  getOrCreateInvoiceForPeriod,
  tryLinkPaymentToInvoice,
  reassignPaymentInvoiceLink,
  selfHealInvoice,
  getInvoiceFinancialSummary,
  runNightlyIndividualInvoices,
  syncInvoiceOverdueStatuses,
  syncDimeRecurringForHousehold,
  rescheduleDimeRecurringAfterAccountingPaymentRetry,
  recreateRecurringForPaymentMethodChange,
  findOutstandingInvoiceForPaymentMethodPrompt,
  syncRecurringAfterPaymentMethodChange,
  computeFutureRecurringStartDateForPmChange,
  noonUtcOnBillingDom,
  runIndividualInvoiceOpenMaintenanceNow,
  getHouseholdBillingAnchor,
  anchorPeriodContainingReferenceDate,
  // pure date helpers (exported for testability + Phase 2 cohort refactor)
  endOfMonth,
  sameDayNextMonth,
  addOneMonthUtc,
  startOfMonth,
  computeBillingPeriodFromEffectiveDate,
  isDimeRecurringSetupRejected,
};

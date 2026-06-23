const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const requireTenantAccess = require('../../middleware/requireTenantAccess');
const { getUserRoles } = require('../../middleware/auth');
const clawbackBalances = require('../../services/clawbackBalances.service');
const PayoutClawbacks = require('../../services/payoutClawbacks.service');
const {
  PAID_PAYMENT_STATUSES_SQL,
  PAID_INVOICE_STATUS,
} = require('../../constants/paymentStatuses');
const {
  paymentInWindowSql,
  invoiceCoversWindowSql,
  invoiceFulfillmentInWindowSql,
} = require('../../services/payoutFunding.service');

async function getOverridePayoutBasis(tenantId) {
  try {
    const pool = await getPool();
    const req = pool.request();
    req.input('TenantId', sql.UniqueIdentifier, tenantId);
    const r = await req.query('SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId = @TenantId');
    if (r.recordset.length) {
      const raw = r.recordset[0].AdvancedSettings;
      const adv = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
      return adv?.payouts?.overrideBasis || 'paymentReceived';
    }
  } catch (e) { /* ignore */ }
  return 'paymentReceived';
}

/** Aligned with NACHA / vendor-breakdown when start+end provided (requires inv join). */
function paymentsPayoutWindowClause(payoutBasis, startDate, endDate) {
  if (startDate && endDate) {
    return ` AND (${paymentInWindowSql({ payoutBasis }).replace(/\s+/g, ' ')})`;
  }
  return `${startDate ? ' AND p.PaymentDate >= @StartDate' : ''}${endDate ? ' AND p.PaymentDate < DATEADD(day, 1, @EndDate)' : ''}`;
}

const authorize = (allowedRoles) => {
  return (req, res, next) => {
    const userRoles = getUserRoles(req.user);
    if (!allowedRoles.some(role => userRoles.includes(role))) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
        required: allowedRoles,
        current: userRoles
      });
    }
    next();
  };
};

function parseJsonSafe(value) {
  if (!value) return null;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (e) {
    return null;
  }
}

/**
 * GET /api/accounting/product-overrides
 * Query params: startDate (YYYY-MM-DD), endDate (YYYY-MM-DD)
 *
 * Expected amounts are calculated from oe.ProductOverrides for Completed payments in the date range,
 * grouped by OverrideId + OverrideACHId (individual override recipients with their ACH accounts).
 *
 * Notes:
 * - Enrollment "active at payment date" uses EffectiveDate/TerminationDate only (not Status), per paymentAudit.service / paymentDatabaseService.
 * - For household payments (Payments.HouseholdId IS NOT NULL), we join to enrollments effective at PaymentDate for that household.
 * - For group payments (Payments.GroupId IS NOT NULL), we join to enrollments effective during the payment month
 *   (EffectiveDate within month, TerminationDate null or after month end), same as vendor-breakdown/GroupMembersTab.
 * - Expected amount = COUNT(enrollments matching override) × po.OverrideAmount
 * - Each override recipient is shown as a separate row with their ACH account details.
 *
 * Paid amounts come from oe.NACHAPaymentDetails joined to oe.NACHAGenerations with Status='Sent'
 * and PayoutType='Product Override Distributions' for RecipientEntityType='Tenant'.
 */
router.get('/product-overrides', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }

    const { startDate, endDate } = req.query;
    const pool = await getPool();
    const overridePayoutBasis = await getOverridePayoutBasis(tenantId);

    // 1) Completed payments for tenant in range
    const paymentsReq = pool.request();
    paymentsReq.input('TenantId', sql.UniqueIdentifier, tenantId);

    // Status + funding-gate aligned with NACHAService.getUnpaidPayments so the
    // override breakdown row matches what the NACHA preview will actually disburse.
    let paymentsWhere = `WHERE p.TenantId = @TenantId
      AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
      AND (p.InvoiceId IS NULL OR inv.Status = N'${PAID_INVOICE_STATUS}')`;
    if (startDate) {
      paymentsReq.input('StartDate', sql.Date, startDate);
    }
    if (endDate) {
      paymentsReq.input('EndDate', sql.Date, endDate);
    }
    paymentsWhere += paymentsPayoutWindowClause(overridePayoutBasis, startDate, endDate);

    const paymentsResult = await paymentsReq.query(`
      SELECT
        p.PaymentId,
        p.InvoiceId,
        p.PaymentDate,
        p.HouseholdId,
        p.GroupId
      FROM oe.Payments p
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      ${paymentsWhere}
    `);

    const payments = paymentsResult.recordset || [];
    const paymentIds = payments.map(p => p.PaymentId?.toString()).filter(Boolean);
    // Collect invoice ids backing these payments so the paid-totals query can
    // match NACHA details that were stamped only with InvoiceId (credit-funded
    // payouts where npd.PaymentId IS NULL).
    const invoiceIdsForPaid = payments
      .map(p => p.InvoiceId ? p.InvoiceId.toString() : null)
      .filter(Boolean);

    // 2) Expected: Calculate from enrollments matching to each override, then aggregate by OverrideACHId
    // First pass: Calculate per-override amounts
    // Second pass: Aggregate by OverrideACHId (or TenantId if no ACH) for UI display
    const overrideAmounts = new Map(); // overrideId -> { overrideId, overrideACHId, recipientTenantId, expectedAmount }
    const achTotals = new Map(); // overrideACHId_or_tenantId -> { overrideACHId, tenantId, tenantName, achAccountName, accountHolderName, bankName, accountNumberLast4, expectedAmount, paidAmount }
    
    if (payments.length > 0) {
      const expectedReq = pool.request();
      expectedReq.input('TenantId', sql.UniqueIdentifier, tenantId);
      if (startDate) expectedReq.input('StartDate', sql.Date, startDate);
      if (endDate) expectedReq.input('EndDate', sql.Date, endDate);

      // Household payments: match enrollments to overrides
      const householdExpectedWhere = `
        WHERE p.TenantId = @TenantId
          AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
          AND (
            p.InvoiceId IS NULL
            OR EXISTS (SELECT 1 FROM oe.Invoices invFG WHERE invFG.InvoiceId = p.InvoiceId AND invFG.Status = N'${PAID_INVOICE_STATUS}')
          )
          ${paymentsPayoutWindowClause(overridePayoutBasis, startDate, endDate)}
          AND p.HouseholdId IS NOT NULL
      `;

      // Same logic as breakdown: primary members only, exclude $0 overrides
      const householdExpectedResult = await expectedReq.query(`
        SELECT
          po.OverrideId,
          po.OverrideACHId,
          po.TenantId as RecipientTenantId,
          po.ProductId,
          pr.Name as ProductName,
          po.ProductPricingId,
          pp.Label as PricingTier,
          po.OverrideAmount,
          COUNT(*) as EnrollmentCount,
          SUM(po.OverrideAmount) as ExpectedAmount
        FROM oe.Payments p
        LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
        INNER JOIN oe.Enrollments e ON e.HouseholdId = p.HouseholdId
          AND e.EffectiveDate <= p.PaymentDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate)
          AND e.ProductId IS NOT NULL
          AND e.ProductId != '00000000-0000-0000-0000-000000000000'
          AND e.ProductId NOT IN (
            SELECT DISTINCT BundleProductId
            FROM oe.ProductBundles
            WHERE BundleProductId IS NOT NULL
          )
          AND e.ProductPricingId IS NOT NULL
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          AND m.HouseholdId = p.HouseholdId
          AND m.RelationshipType = 'P'
        INNER JOIN oe.ProductOverrides po ON po.ProductId = e.ProductId
          AND po.ProductPricingId = e.ProductPricingId
          AND po.IsActive = 1
          AND po.EffectiveDate <= p.PaymentDate
          AND (po.ExpirationDate IS NULL OR po.ExpirationDate > p.PaymentDate)
          AND ISNULL(po.OverrideAmount, 0) > 0
        LEFT JOIN oe.Products pr ON pr.ProductId = po.ProductId
        LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = po.ProductPricingId
        ${householdExpectedWhere}
        GROUP BY po.OverrideId, po.OverrideACHId, po.TenantId, po.ProductId, pr.Name, po.ProductPricingId, pp.Label, po.OverrideAmount
      `);

      (householdExpectedResult.recordset || []).forEach(r => {
        const overrideId = r.OverrideId ? r.OverrideId.toString() : null;
        const overrideACHId = r.OverrideACHId ? r.OverrideACHId.toString() : null;
        const tenantId = r.RecipientTenantId ? r.RecipientTenantId.toString() : null;
        const expectedAmount = Number(r.ExpectedAmount || 0);
        
        if (!overrideId) return;
        
        // Store per-override for reference
        if (!overrideAmounts.has(overrideId)) {
          overrideAmounts.set(overrideId, {
            overrideId: overrideId,
            overrideACHId: overrideACHId,
            recipientTenantId: tenantId,
            expectedAmount: 0
          });
        }
        overrideAmounts.get(overrideId).expectedAmount += expectedAmount;
        
        // Aggregate by ACH account (or tenant if no ACH)
        const achKey = overrideACHId || `tenant_${tenantId}`;
        if (!achTotals.has(achKey)) {
          achTotals.set(achKey, {
            overrideACHId: overrideACHId,
            tenantId: tenantId,
            tenantName: 'Unknown Tenant',
            achAccountName: null,
            accountHolderName: null,
            bankName: null,
            accountNumberLast4: null,
            expectedAmount: 0,
            paidAmount: 0
          });
        }
        achTotals.get(achKey).expectedAmount += expectedAmount;
      });

      // Group payments: match enrollments to overrides
      const groupExpectedWhere = `
        WHERE p.TenantId = @TenantId
          AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
          AND (
            p.InvoiceId IS NULL
            OR EXISTS (SELECT 1 FROM oe.Invoices invFG WHERE invFG.InvoiceId = p.InvoiceId AND invFG.Status = N'${PAID_INVOICE_STATUS}')
          )
          ${paymentsPayoutWindowClause(overridePayoutBasis, startDate, endDate)}
          AND p.GroupId IS NOT NULL
      `;

      // Same logic as breakdown: primary members only, exclude $0 overrides
      const groupExpectedResult = await expectedReq.query(`
        SELECT
          po.OverrideId,
          po.OverrideACHId,
          po.TenantId as RecipientTenantId,
          po.ProductId,
          pr.Name as ProductName,
          po.ProductPricingId,
          pp.Label as PricingTier,
          po.OverrideAmount,
          COUNT(*) as EnrollmentCount,
          SUM(po.OverrideAmount) as ExpectedAmount
        FROM oe.Payments p
        LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
        INNER JOIN oe.Members m ON m.GroupId = p.GroupId
          AND m.TenantId = p.TenantId
          AND m.RelationshipType = 'P'
        INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          -- Cohort-aware: prefer invoice billing period (supports 15th-14th periods);
          -- fall back to calendar-month derivation from PaymentDate for legacy payments.
          AND e.EffectiveDate <= COALESCE(inv.BillingPeriodEnd, EOMONTH(p.PaymentDate))
          AND (e.TerminationDate IS NULL OR e.TerminationDate > COALESCE(inv.BillingPeriodStart, DATEADD(day, 1, EOMONTH(p.PaymentDate, -1))))
          AND e.ProductId IS NOT NULL
          AND e.ProductId != '00000000-0000-0000-0000-000000000000'
          AND e.ProductId NOT IN (
            SELECT DISTINCT BundleProductId
            FROM oe.ProductBundles
            WHERE BundleProductId IS NOT NULL
          )
          AND e.ProductPricingId IS NOT NULL
        INNER JOIN oe.ProductOverrides po ON po.ProductId = e.ProductId
          AND po.ProductPricingId = e.ProductPricingId
          AND po.IsActive = 1
          AND po.EffectiveDate <= p.PaymentDate
          AND (po.ExpirationDate IS NULL OR po.ExpirationDate > p.PaymentDate)
          AND ISNULL(po.OverrideAmount, 0) > 0
        LEFT JOIN oe.Products pr ON pr.ProductId = po.ProductId
        LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = po.ProductPricingId
        ${groupExpectedWhere}
        GROUP BY po.OverrideId, po.OverrideACHId, po.TenantId, po.ProductId, pr.Name, po.ProductPricingId, pp.Label, po.OverrideAmount
      `);

      (groupExpectedResult.recordset || []).forEach(r => {
        const overrideId = r.OverrideId ? r.OverrideId.toString() : null;
        const overrideACHId = r.OverrideACHId ? r.OverrideACHId.toString() : null;
        const tenantId = r.RecipientTenantId ? r.RecipientTenantId.toString() : null;
        const expectedAmount = Number(r.ExpectedAmount || 0);
        
        if (!overrideId) return;
        
        // Store per-override for reference
        if (!overrideAmounts.has(overrideId)) {
          overrideAmounts.set(overrideId, {
            overrideId: overrideId,
            overrideACHId: overrideACHId,
            recipientTenantId: tenantId,
            expectedAmount: 0
          });
        }
        overrideAmounts.get(overrideId).expectedAmount += expectedAmount;
        
        // Aggregate by ACH account (or tenant if no ACH)
        const achKey = overrideACHId || `tenant_${tenantId}`;
        if (!achTotals.has(achKey)) {
          achTotals.set(achKey, {
            overrideACHId: overrideACHId,
            tenantId: tenantId,
            tenantName: 'Unknown Tenant',
            achAccountName: null,
            accountHolderName: null,
            bankName: null,
            accountNumberLast4: null,
            expectedAmount: 0,
            paidAmount: 0
          });
        }
        achTotals.get(achKey).expectedAmount += expectedAmount;
      });

      // 2b) Override dollars from ProductPricing.OverrideRate on enrollments that have NO
      // applicable oe.ProductOverrides row (wizard "pricing" override without distribution rules).
      // NACHA allocates these to the product owner tenant — merge into achTotals by ProductOwnerId
      // so paid/unpaid stay aligned with recipient-level NACHA totals.
      const uncategorizedNotExistsSql = `
        AND pr.ProductOwnerId IS NOT NULL
        AND ISNULL(pp.OverrideRate, 0) > 0
        AND NOT EXISTS (
          SELECT 1 FROM oe.ProductOverrides po
          WHERE po.ProductId = e.ProductId
            AND po.IsActive = 1
            AND ISNULL(po.OverrideAmount, 0) > 0
            AND po.EffectiveDate <= p.PaymentDate
            AND (po.ExpirationDate IS NULL OR po.ExpirationDate > p.PaymentDate)
            AND (
              po.ProductPricingId = e.ProductPricingId
              OR po.ProductPricingId IS NULL
            )
        )`;

      const householdUncatResult = await expectedReq.query(`
        SELECT
          pr.ProductOwnerId AS OwnerTenantId,
          SUM(pp.OverrideRate) AS ExpectedAmount
        FROM oe.Payments p
        LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
        INNER JOIN oe.Enrollments e ON e.HouseholdId = p.HouseholdId
          AND e.EffectiveDate <= p.PaymentDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate)
          AND e.ProductId IS NOT NULL
          AND e.ProductId != '00000000-0000-0000-0000-000000000000'
          AND e.ProductId NOT IN (
            SELECT DISTINCT BundleProductId
            FROM oe.ProductBundles
            WHERE BundleProductId IS NOT NULL
          )
          AND e.ProductPricingId IS NOT NULL
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          AND m.HouseholdId = p.HouseholdId
          AND m.RelationshipType = 'P'
        INNER JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId AND pp.Status = 'Active'
        INNER JOIN oe.Products pr ON pr.ProductId = e.ProductId
        ${householdExpectedWhere}
        ${uncategorizedNotExistsSql}
        GROUP BY pr.ProductOwnerId
      `);

      const groupUncatResult = await expectedReq.query(`
        SELECT
          pr.ProductOwnerId AS OwnerTenantId,
          SUM(pp.OverrideRate) AS ExpectedAmount
        FROM oe.Payments p
        LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
        INNER JOIN oe.Members m ON m.GroupId = p.GroupId
          AND m.TenantId = p.TenantId
          AND m.RelationshipType = 'P'
        INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND e.EffectiveDate <= COALESCE(inv.BillingPeriodEnd, EOMONTH(p.PaymentDate))
          AND (e.TerminationDate IS NULL OR e.TerminationDate > COALESCE(inv.BillingPeriodStart, DATEADD(day, 1, EOMONTH(p.PaymentDate, -1))))
          AND e.ProductId IS NOT NULL
          AND e.ProductId != '00000000-0000-0000-0000-000000000000'
          AND e.ProductId NOT IN (
            SELECT DISTINCT BundleProductId
            FROM oe.ProductBundles
            WHERE BundleProductId IS NOT NULL
          )
          AND e.ProductPricingId IS NOT NULL
        INNER JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId AND pp.Status = 'Active'
        INNER JOIN oe.Products pr ON pr.ProductId = e.ProductId
        ${groupExpectedWhere}
        ${uncategorizedNotExistsSql}
        GROUP BY pr.ProductOwnerId
      `);

      const mergeUncategorizedByOwner = (recordset) => {
        (recordset || []).forEach((r) => {
          const ownerId = r.OwnerTenantId ? r.OwnerTenantId.toString() : null;
          if (!ownerId) return;
          const amt = Math.round(Number(r.ExpectedAmount || 0) * 100) / 100;
          if (amt <= 0) return;
          const key = `uncat_owner_${ownerId}`;
          if (!achTotals.has(key)) {
            achTotals.set(key, {
              overrideACHId: null,
              tenantId: ownerId,
              tenantName: 'Unknown Tenant',
              achAccountName: 'Uncategorized — pricing without distribution rules',
              accountHolderName: null,
              bankName: null,
              accountNumberLast4: null,
              expectedAmount: 0,
              paidAmount: 0,
              uncategorizedPricingGap: true
            });
          }
          achTotals.get(key).expectedAmount += amt;
        });
      };
      mergeUncategorizedByOwner(householdUncatResult.recordset);
      mergeUncategorizedByOwner(groupUncatResult.recordset);
    }

    // 3) Paid: sum NACHAPaymentDetails for tenant recipients from Sent NACHAs (Product Override Distributions only),
    // grouped by OverrideId if available, otherwise by TenantId (fallback)
    // Note: NACHA files may not have OverrideId, so we'll need to match by TenantId + ProductId + ProductPricingId if possible
    // For now, we'll match by TenantId and allocate proportionally based on expected amounts
    if (paymentIds.length > 0 || invoiceIdsForPaid.length > 0) {
      const anchorClauses = [];
      if (paymentIds.length > 0) {
        const paymentIdsStr = paymentIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
        anchorClauses.push(`npd.PaymentId IN (${paymentIdsStr})`);
      }
      if (invoiceIdsForPaid.length > 0) {
        const invoiceIdsStr = invoiceIdsForPaid.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
        anchorClauses.push(`npd.InvoiceId IN (${invoiceIdsStr})`);
      }

      // Get paid amounts by tenant (we'll allocate proportionally to overrides).
      // Pre-shift this only matched by PaymentId; invoice-anchored credit-funded
      // payouts (npd.PaymentId IS NULL, npd.InvoiceId set) silently dropped and
      // showed as still owed.
      const paidResult = await pool.request().query(`
        SELECT
          npd.RecipientEntityId as TenantId,
          SUM(COALESCE(npd.Amount, 0)) as PaidAmount
        FROM oe.NACHAPaymentDetails npd
        INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
        WHERE npd.RecipientEntityType = 'Tenant'
          AND ng.Status = 'Sent'
          AND ng.PayoutType = 'Product Override Distributions'
          AND (${anchorClauses.join(' OR ')})
        GROUP BY npd.RecipientEntityId
      `);

      // Allocate paid amounts proportionally to overrides by tenant
      const paidByTenant = new Map();
      (paidResult.recordset || []).forEach(r => {
        const tenantId = r.TenantId ? r.TenantId.toString() : null;
        if (!tenantId) return;
        paidByTenant.set(tenantId, Number(r.PaidAmount || 0));
      });

      // Allocate paid amounts to ACH accounts proportionally by tenant
      // Group ACH accounts by tenant first
      const expectedByTenant = new Map();
      achTotals.forEach((ach, key) => {
        const tenantId = ach.tenantId;
        if (!tenantId) return;
        if (!expectedByTenant.has(tenantId)) {
          expectedByTenant.set(tenantId, 0);
        }
        expectedByTenant.set(tenantId, expectedByTenant.get(tenantId) + ach.expectedAmount);
      });

      // Allocate paid amounts to ACH accounts proportionally
      achTotals.forEach((ach, key) => {
        const tenantId = ach.tenantId;
        if (!tenantId) return;
        const totalPaid = paidByTenant.get(tenantId) || 0;
        const totalExpected = expectedByTenant.get(tenantId) || 0;
        if (totalExpected > 0) {
          const proportion = ach.expectedAmount / totalExpected;
          ach.paidAmount = totalPaid * proportion;
        }
      });
    }

    // 4) Fill in tenant names and ACH details
    const tenantIds = Array.from(new Set(Array.from(achTotals.values()).map(a => a.tenantId).filter(Boolean)));
    /** Active ProductOverrideACH rows for ids referenced on distribution rules (IsActive = 1). */
    let achDetailsMap = new Map();
    if (tenantIds.length > 0) {
      const tenantIdsStr = tenantIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
      const namesResult = await pool.request().query(`
        SELECT TenantId, Name
        FROM oe.Tenants
        WHERE TenantId IN (${tenantIdsStr})
      `);
      const tenantNames = new Map();
      (namesResult.recordset || []).forEach(t => {
        const id = t.TenantId ? t.TenantId.toString() : null;
        if (id) tenantNames.set(id, t.Name || 'Unknown Tenant');
      });

      // Get ACH details for each ACH account (with decrypted account numbers for last 4)
      const overrideACHIds = Array.from(new Set(Array.from(achTotals.values()).map(a => a.overrideACHId).filter(Boolean)));
      achDetailsMap = new Map();
      if (overrideACHIds.length > 0) {
        const achIdsStr = overrideACHIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
        const achResult = await pool.request().query(`
          SELECT
            OverrideACHId,
            TenantId,
            AccountName,
            AccountHolderName,
            BankName,
            BankAccountType,
            AccountNumberEncrypted,
            IsActive,
            IsDefault
          FROM oe.ProductOverrideACH
          WHERE OverrideACHId IN (${achIdsStr})
            AND IsActive = 1
        `);
        
        const encryptionService = require('../../services/encryptionService');
        for (const ach of achResult.recordset || []) {
          const achId = ach.OverrideACHId ? ach.OverrideACHId.toString() : null;
          if (!achId) continue;
          
          // Decrypt account number to get last 4 digits
          let accountNumberLast4 = null;
          if (ach.AccountNumberEncrypted) {
            try {
              const decrypted = encryptionService.decrypt(ach.AccountNumberEncrypted);
              if (decrypted && decrypted.length >= 4) {
                accountNumberLast4 = decrypted.slice(-4);
              }
            } catch (e) {
              console.error('Failed to decrypt account number for ACH', achId, e);
            }
          }
          
          achDetailsMap.set(achId, {
            overrideACHId: achId,
            tenantId: ach.TenantId ? ach.TenantId.toString() : null,
            accountName: ach.AccountName || null,
            accountHolderName: ach.AccountHolderName || null,
            bankName: ach.BankName || null,
            bankAccountType: ach.BankAccountType || null,
            accountNumberLast4: accountNumberLast4,
            isActive: ach.IsActive === true || ach.IsActive === 1,
            isDefault: ach.IsDefault === true || ach.IsDefault === 1
          });
        }
      }

      // Update ACH totals with tenant names and ACH details
      achTotals.forEach((ach, key) => {
        if (ach.tenantId && tenantNames.has(ach.tenantId)) {
          ach.tenantName = tenantNames.get(ach.tenantId);
        }
        if (ach.overrideACHId && achDetailsMap.has(ach.overrideACHId)) {
          const achDetails = achDetailsMap.get(ach.overrideACHId);
          ach.achAccountName = achDetails.accountName;
          ach.accountHolderName = achDetails.accountHolderName;
          ach.bankName = achDetails.bankName;
          ach.accountNumberLast4 = achDetails.accountNumberLast4;
        }
      });
    }

    // Pending tenant-override clawbacks (oe.PayoutClawbacks). RecipientEntityId
    // for TenantOverride payouts is the recipient TenantId. We attach the
    // tenant-level pending balance to every ACH row that belongs to that
    // tenant so admins see the same number regardless of which ACH they look
    // at — the netting actually happens once per tenant at NACHA gen.
    const recipientTenantIds = Array.from(
      new Set(
        Array.from(achTotals.values())
          .map((a) => a.tenantId)
          .filter(Boolean)
      )
    );
    let overrideClawbackMap = new Map();
    try {
      overrideClawbackMap = await clawbackBalances.getPayoutClawbackBalances({
        tenantId,
        payoutType: PayoutClawbacks.PAYOUT_TYPES.TENANT_OVERRIDE,
        recipientEntityIds: recipientTenantIds
      });
    } catch (e) {
      console.warn('product-overrides: clawback lookup failed', e.message);
    }

    const data = Array.from(achTotals.values())
      .map(a => {
        const expected = Math.round((a.expectedAmount || 0) * 100) / 100;
        const paid = Math.round((a.paidAmount || 0) * 100) / 100;
        const unpaid = Math.round(Math.max(0, expected - paid) * 100) / 100;
        const cb = a.tenantId ? overrideClawbackMap.get(a.tenantId) : null;
        const pendingClawback = cb ? Math.round((cb.amount || 0) * 100) / 100 : 0;
        const netNextPayout = Math.round(Math.max(0, unpaid - pendingClawback) * 100) / 100;

        // Determine display name: ACH Account Name or Account Holder Name, fallback to tenant name
        const displayName = a.achAccountName || a.accountHolderName || a.tenantName || 'Unknown Account';
        const overrideAchKey = a.overrideACHId ? a.overrideACHId.toString() : null;
        const hasRoutableAch = !!(overrideAchKey && achDetailsMap.has(overrideAchKey));

        return {
          overrideACHId: a.overrideACHId,
          tenantId: a.tenantId,
          tenantName: a.tenantName,
          accountName: displayName,
          accountHolderName: a.accountHolderName,
          bankName: a.bankName,
          accountNumberLast4: a.accountNumberLast4,
          expectedAmount: expected,
          paidAmount: paid,
          unpaidAmount: unpaid,
          pendingClawbackAmount: pendingClawback,
          pendingClawbackCount: cb ? Number(cb.count || 0) : 0,
          netNextPayoutAmount: netNextPayout,
          hasActiveAch: hasRoutableAch,
          uncategorizedPricingGap: !!a.uncategorizedPricingGap
        };
      })
      .sort((a, b) => {
        // Sort by account name, then tenant name
        if (a.accountName !== b.accountName) {
          return (a.accountName || '').localeCompare(b.accountName || '');
        }
        return (a.tenantName || '').localeCompare(b.tenantName || '');
      });

    /** Compare table scope (funded payments in payout window) vs raw invoice OverrideRate sums. */
    let reconciliation = null;
    if (startDate && endDate) {
      const bsq = invoiceCoversWindowSql('inv').replace(/\s+/g, ' ');
      const fsq = invoiceFulfillmentInWindowSql('inv').replace(/\s+/g, ' ');
      const baseWhere = `
        inv.TenantId = @TenantId
        AND inv.Status = N'${PAID_INVOICE_STATUS}'`;
      const mkInvReq = () => {
        const r = pool.request();
        r.input('TenantId', sql.UniqueIdentifier, tenantId);
        r.input('StartDate', sql.Date, startDate);
        r.input('EndDate', sql.Date, endDate);
        return r;
      };
      const sumSelect = `
        SELECT COALESCE(SUM(CAST(ISNULL(inv.OverrideRate, 0) AS DECIMAL(18, 2))), 0) AS SumVal
        FROM oe.Invoices inv`;
      const [billingRes, fulfillRes, creditRes] = await Promise.all([
        mkInvReq().query(`${sumSelect} WHERE ${baseWhere} AND (${bsq})`),
        mkInvReq().query(`${sumSelect} WHERE ${baseWhere} AND (${fsq})`),
        mkInvReq().query(`
          ${sumSelect}
          WHERE ${baseWhere}
            AND (${bsq})
            AND NOT EXISTS (SELECT 1 FROM oe.Payments p WHERE p.InvoiceId = inv.InvoiceId)
        `),
      ]);
      const reportExpectedTotal =
        Math.round(data.reduce((s, r) => s + Number(r.expectedAmount || 0), 0) * 100) / 100;
      reconciliation = {
        payoutBasis: overridePayoutBasis,
        fundedPaymentsInWindow: payments.length,
        reportExpectedTotal,
        invoicePaidOverrideBillingPeriodOverlap: Number(
          billingRes.recordset[0]?.SumVal || 0
        ),
        invoicePaidOverrideFulfillmentInWindow: Number(
          fulfillRes.recordset[0]?.SumVal || 0
        ),
        creditFundedPaidInvoiceOverrideBillingOverlap: Number(
          creditRes.recordset[0]?.SumVal || 0
        ),
      };
    }

    res.json({ success: true, data, reconciliation });
  } catch (error) {
    console.error('Error building product overrides:', error);
    res.status(500).json({ success: false, message: 'Failed to build product overrides' });
  }
});

/**
 * GET /api/accounting/product-overrides/filter-options
 * Query params: overrideACHId (nullable), tenantId, startDate, endDate
 *
 * Returns groups and members that have payments with overrides in the date range.
 */
router.get('/product-overrides/filter-options', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }

    const { overrideACHId, tenantId: recipientTenantId, startDate, endDate } = req.query;
    
    if (!recipientTenantId) {
      return res.status(400).json({ success: false, message: 'tenantId is required' });
    }

    const pool = await getPool();
    const overridePayoutBasis = await getOverridePayoutBasis(tenantId);
    const filterReq = pool.request();
    filterReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    filterReq.input('RecipientTenantId', sql.UniqueIdentifier, recipientTenantId);
    if (startDate) filterReq.input('StartDate', sql.Date, startDate);
    if (endDate) filterReq.input('EndDate', sql.Date, endDate);
    if (overrideACHId && overrideACHId !== '') {
      filterReq.input('OverrideACHId', sql.UniqueIdentifier, overrideACHId);
    }

    const overrideACHFilter = overrideACHId && overrideACHId !== '' 
      ? 'AND po.OverrideACHId = @OverrideACHId'
      : 'AND po.OverrideACHId IS NULL';

    const filterWhere = `
      WHERE p.TenantId = @TenantId
        AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        AND (
          p.InvoiceId IS NULL
          OR EXISTS (SELECT 1 FROM oe.Invoices invFG WHERE invFG.InvoiceId = p.InvoiceId AND invFG.Status = N'${PAID_INVOICE_STATUS}')
        )
        ${paymentsPayoutWindowClause(overridePayoutBasis, startDate, endDate)}
        AND po.TenantId = @RecipientTenantId
        AND po.IsActive = 1
        ${overrideACHFilter}
    `;

    // Get groups with payments
    const groupsResult = await filterReq.query(`
      SELECT DISTINCT
        p.GroupId as id,
        g.Name as label,
        'group' as type
      FROM oe.Payments p
      LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
      INNER JOIN oe.Members m ON m.GroupId = p.GroupId AND m.TenantId = p.TenantId
      INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        -- Cohort-aware: prefer invoice billing period (supports 15th-14th periods);
        -- fall back to calendar-month derivation from PaymentDate for legacy payments.
        AND e.EffectiveDate <= COALESCE(inv.BillingPeriodEnd, EOMONTH(p.PaymentDate))
        AND (e.TerminationDate IS NULL OR e.TerminationDate > COALESCE(inv.BillingPeriodStart, DATEADD(day, 1, EOMONTH(p.PaymentDate, -1))))
        AND e.ProductId IS NOT NULL
        AND e.ProductPricingId IS NOT NULL
      INNER JOIN oe.ProductOverrides po ON po.ProductId = e.ProductId
        AND po.ProductPricingId = e.ProductPricingId
        AND po.IsActive = 1
        AND po.EffectiveDate <= p.PaymentDate
        AND (po.ExpirationDate IS NULL OR po.ExpirationDate > p.PaymentDate)
      LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
      ${filterWhere}
        AND p.GroupId IS NOT NULL
        AND g.Name IS NOT NULL
      ORDER BY g.Name
    `);

    // Get members (households) with payments
    const membersResult = await filterReq.query(`
      SELECT DISTINCT
        m.HouseholdId as id,
        ISNULL(u.FirstName + ' ' + u.LastName, 'Unknown Member') as label,
        'member' as type
      FROM oe.Payments p
      LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
      INNER JOIN oe.Enrollments e ON e.HouseholdId = p.HouseholdId
        AND e.EffectiveDate <= p.PaymentDate
        AND (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate)
        AND e.ProductId IS NOT NULL
        AND e.ProductPricingId IS NOT NULL
      INNER JOIN oe.ProductOverrides po ON po.ProductId = e.ProductId
        AND po.ProductPricingId = e.ProductPricingId
        AND po.IsActive = 1
        AND po.EffectiveDate <= p.PaymentDate
        AND (po.ExpirationDate IS NULL OR po.ExpirationDate > p.PaymentDate)
      INNER JOIN oe.Members m ON m.HouseholdId = p.HouseholdId AND m.RelationshipType = 'P'
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      ${filterWhere}
        AND p.HouseholdId IS NOT NULL
      ORDER BY ISNULL(u.FirstName + ' ' + u.LastName, 'Unknown Member')
    `);

    const options = [
      { id: 'all', label: 'All Group & Member Payments', type: 'all', value: 'all' },
      ...(groupsResult.recordset || []).map(g => ({ ...g, value: `group_${g.id}` })),
      ...(membersResult.recordset || []).map(m => ({ ...m, value: `member_${m.id}` }))
    ];

    res.json({ success: true, data: options });
  } catch (error) {
    console.error('Error getting filter options:', error);
    res.status(500).json({ success: false, message: 'Failed to get filter options' });
  }
});

/**
 * GET /api/accounting/product-overrides/breakdown
 * Query params: overrideACHId (nullable), tenantId, startDate, endDate, groupId (optional), householdId (optional)
 *
 * Returns a detailed breakdown by product and pricing tier for a specific override ACH account.
 */
router.get('/product-overrides/breakdown', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }

    const { overrideACHId, tenantId: recipientTenantId, startDate, endDate, groupId, householdId } = req.query;
    
    if (!recipientTenantId) {
      return res.status(400).json({ success: false, message: 'tenantId is required' });
    }

    const pool = await getPool();
    const overridePayoutBasis = await getOverridePayoutBasis(tenantId);
    const breakdownReq = pool.request();
    breakdownReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    breakdownReq.input('RecipientTenantId', sql.UniqueIdentifier, recipientTenantId);
    if (startDate) breakdownReq.input('StartDate', sql.Date, startDate);
    if (endDate) breakdownReq.input('EndDate', sql.Date, endDate);
    if (overrideACHId && overrideACHId !== '') {
      breakdownReq.input('OverrideACHId', sql.UniqueIdentifier, overrideACHId);
    }
    if (groupId && groupId !== 'all') breakdownReq.input('GroupId', sql.UniqueIdentifier, groupId);
    if (householdId && householdId !== 'all') breakdownReq.input('HouseholdId', sql.UniqueIdentifier, householdId);

    // Build WHERE clause for override ACH filter
    const overrideACHFilter = overrideACHId && overrideACHId !== '' 
      ? 'AND po.OverrideACHId = @OverrideACHId'
      : 'AND po.OverrideACHId IS NULL';

    const breakdownWhere = `
      WHERE p.TenantId = @TenantId
        AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        AND (
          p.InvoiceId IS NULL
          OR EXISTS (SELECT 1 FROM oe.Invoices invFG WHERE invFG.InvoiceId = p.InvoiceId AND invFG.Status = N'${PAID_INVOICE_STATUS}')
        )
        ${paymentsPayoutWindowClause(overridePayoutBasis, startDate, endDate)}
        AND po.TenantId = @RecipientTenantId
        AND po.IsActive = 1
        ${overrideACHFilter}
        ${groupId && groupId !== 'all' ? 'AND p.GroupId = @GroupId' : ''}
        ${householdId && householdId !== 'all' ? 'AND p.HouseholdId = @HouseholdId' : ''}
    `;

    // Get breakdown for household payments
    // Same logic as main list: primary members only, exclude $0 overrides.
    const householdBreakdownResult = await breakdownReq.query(`
      SELECT
        po.ProductId,
        pr.Name as ProductName,
        po.ProductPricingId,
        pp.Label as PricingTier,
        pp.MinAge,
        pp.MaxAge,
        po.OverrideAmount,
        COUNT(*) as EnrollmentCount,
        SUM(po.OverrideAmount) as TotalOverride
      FROM oe.Payments p
      LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
      INNER JOIN oe.Enrollments e ON e.HouseholdId = p.HouseholdId
        AND e.EffectiveDate <= p.PaymentDate
        AND (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate)
        AND e.ProductId IS NOT NULL
        AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        AND e.ProductId NOT IN (
          SELECT DISTINCT BundleProductId
          FROM oe.ProductBundles
          WHERE BundleProductId IS NOT NULL
        )
        AND e.ProductPricingId IS NOT NULL
      INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        AND m.HouseholdId = p.HouseholdId
        AND m.RelationshipType = 'P'
      INNER JOIN oe.ProductOverrides po ON po.ProductId = e.ProductId
        AND po.ProductPricingId = e.ProductPricingId
        AND po.IsActive = 1
        AND po.EffectiveDate <= p.PaymentDate
        AND (po.ExpirationDate IS NULL OR po.ExpirationDate > p.PaymentDate)
        AND ISNULL(po.OverrideAmount, 0) > 0
      LEFT JOIN oe.Products pr ON pr.ProductId = po.ProductId
      LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = po.ProductPricingId
      ${breakdownWhere}
        AND p.HouseholdId IS NOT NULL
      GROUP BY po.ProductId, pr.Name, po.ProductPricingId, pp.Label, pp.MinAge, pp.MaxAge, po.OverrideAmount
    `);

    // Get breakdown for group payments
    // Only primary members (RelationshipType = 'P') — one enrollment per household for override count.
    // Exclude $0 override enrollments (only apply overrides where OverrideAmount > 0).
    const groupBreakdownResult = await breakdownReq.query(`
      SELECT
        po.ProductId,
        pr.Name as ProductName,
        po.ProductPricingId,
        pp.Label as PricingTier,
        pp.MinAge,
        pp.MaxAge,
        po.OverrideAmount,
        COUNT(*) as EnrollmentCount,
        SUM(po.OverrideAmount) as TotalOverride
      FROM oe.Payments p
      LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
      INNER JOIN oe.Members m ON m.GroupId = p.GroupId
        AND m.TenantId = p.TenantId
        AND m.RelationshipType = 'P'
      INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        -- Cohort-aware: prefer invoice billing period (supports 15th-14th periods);
        -- fall back to calendar-month derivation from PaymentDate for legacy payments.
        AND e.EffectiveDate <= COALESCE(inv.BillingPeriodEnd, EOMONTH(p.PaymentDate))
        AND (e.TerminationDate IS NULL OR e.TerminationDate > COALESCE(inv.BillingPeriodStart, DATEADD(day, 1, EOMONTH(p.PaymentDate, -1))))
        AND e.ProductId IS NOT NULL
        AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        AND e.ProductId NOT IN (
          SELECT DISTINCT BundleProductId
          FROM oe.ProductBundles
          WHERE BundleProductId IS NOT NULL
        )
        AND e.ProductPricingId IS NOT NULL
      INNER JOIN oe.ProductOverrides po ON po.ProductId = e.ProductId
        AND po.ProductPricingId = e.ProductPricingId
        AND po.IsActive = 1
        AND po.EffectiveDate <= p.PaymentDate
        AND (po.ExpirationDate IS NULL OR po.ExpirationDate > p.PaymentDate)
        AND ISNULL(po.OverrideAmount, 0) > 0
      LEFT JOIN oe.Products pr ON pr.ProductId = po.ProductId
      LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = po.ProductPricingId
      ${breakdownWhere}
        AND p.GroupId IS NOT NULL
      GROUP BY po.ProductId, pr.Name, po.ProductPricingId, pp.Label, pp.MinAge, pp.MaxAge, po.OverrideAmount
    `);

    // Combine and aggregate by product and tier
    const productMap = new Map();
    
    [...(householdBreakdownResult.recordset || []), ...(groupBreakdownResult.recordset || [])].forEach(r => {
      const productId = r.ProductId ? r.ProductId.toString() : null;
      const productPricingId = r.ProductPricingId ? r.ProductPricingId.toString() : null;
      if (!productId || !productPricingId) return;

      const productKey = productId;
      const tierKey = `${productId}_${productPricingId}`;

      if (!productMap.has(productKey)) {
        productMap.set(productKey, {
          productId: productId,
          productName: r.ProductName || 'Unknown Product',
          tiers: new Map(),
          totalOverride: 0
        });
      }

      const product = productMap.get(productKey);
      
      if (!product.tiers.has(tierKey)) {
        // Format tier label with age band if available
        let tierLabel = r.PricingTier || 'Unknown Tier';
        if (r.MinAge !== null && r.MinAge !== undefined && r.MaxAge !== null && r.MaxAge !== undefined) {
          tierLabel = `${tierLabel} (Age ${r.MinAge}-${r.MaxAge})`;
        } else if (r.MinAge !== null && r.MinAge !== undefined) {
          tierLabel = `${tierLabel} (Age ${r.MinAge}+)`;
        }
        
        product.tiers.set(tierKey, {
          productPricingId: productPricingId,
          pricingTier: tierLabel,
          enrollmentCount: 0,
          overrideAmount: Number(r.OverrideAmount || 0),
          totalOverride: 0
        });
      }

      const tier = product.tiers.get(tierKey);
      tier.enrollmentCount += Number(r.EnrollmentCount || 0);
      tier.totalOverride += Number(r.TotalOverride || 0);
      product.totalOverride += Number(r.TotalOverride || 0);
    });

    // Convert to array format
    const data = Array.from(productMap.values()).map(product => ({
      productId: product.productId,
      productName: product.productName,
      tiers: Array.from(product.tiers.values()).sort((a, b) => 
        (a.pricingTier || '').localeCompare(b.pricingTier || '')
      ),
      totalOverride: Math.round(product.totalOverride * 100) / 100
    })).sort((a, b) => (a.productName || '').localeCompare(b.productName || ''));

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error building override breakdown:', error);
    res.status(500).json({ success: false, message: 'Failed to build override breakdown' });
  }
});

module.exports = router;



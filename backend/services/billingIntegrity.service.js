'use strict';

/**
 * Billing Integrity Service
 *
 * SysAdmin-facing audit + repair utilities to keep oe.Invoices and oe.Payments
 * consistent with oe.Enrollments. Three classes of issues are addressed:
 *
 *  1. Invoices below the minimum SystemFee floor ($3.50/month per household).
 *     These get re-audited via PaymentAuditService.computeInvoiceAllocation
 *     and corrected via PaymentAuditService.applyInvoiceCorrection. When a
 *     linked Paid payment exists for a corrected invoice, the same canonical
 *     breakdown values are also written back onto oe.Payments so both sources
 *     agree (the reader cutover already prefers oe.Invoices via COALESCE).
 *
 *  2. Individually-billed households with one or more missing monthly invoices
 *     between FirstActive and current month. These are created month-by-month
 *     using invoiceService.getOrCreateInvoiceForPeriod which is idempotent
 *     and will self-heal linkage with any matching payments.
 *
 *  3. Orphan completed payments (InvoiceId IS NULL with Status in
 *     Success/Completed/succeeded). These are run through
 *     invoiceService.tryLinkPaymentToInvoice, which handles prepay and
 *     same-period matching, falling back to creating an invoice for the
 *     payment's billing period when no match exists.
 *
 * All "fix" methods are idempotent and safe to re-run.
 */

const { getPool, sql, rawSql } = require('../config/database');
const PaymentAuditService = require('./paymentAudit.service');
const invoiceService = require('./invoiceService');

// Note: there is intentionally no hard-coded system fee floor. Each tenant
// configures its own enabled system fees in oe.Tenants.SystemFees (a JSON
// blob with platformFee / mobileAppFee / aiAssistantFee, each with `enabled`,
// `MemberPaid`, and `MemberPaidAmount`/`amount`). The per-invoice floor is
// the sum of MemberPaid + enabled fees for the invoice's tenant.
const MATH_TOLERANCE = 0.01;

const COMPLETED_PAYMENT_STATUSES = ['Success', 'Completed', 'succeeded'];

function n2(val) {
  const num = Number(val);
  if (Number.isNaN(num) || !Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

function sumBreakdowns(row) {
  return n2(
    Number(row.NetRate || 0) +
    Number(row.OverrideRate || 0) +
    Number(row.Commission || 0) +
    Number(row.SystemFees || 0) +
    Number(row.ProcessingFeeAmount || 0) +
    Number(row.SetupFee || 0)
  );
}

function startOfMonthUTC(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfMonthUTC(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

function addMonthsUTC(date, months) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
}

function ymKey(date) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Tenant display names for Billing Integrity missing-invoice rows.
 * @returns {Promise<Map<string, string|null>>}
 */
async function fetchTenantNamesById(pool, tenantIds) {
  const map = new Map();
  const unique = [...new Set(tenantIds.map((id) => String(id)))];
  if (unique.length === 0) return map;
  for (const slice of chunkArray(unique, 40)) {
    const req = pool.request();
    slice.forEach((id, idx) => {
      req.input(`tid${idx}`, sql.UniqueIdentifier, id);
    });
    const placeholders = slice.map((_, idx) => `@tid${idx}`).join(', ');
    const result = await req.query(`
      SELECT CAST(TenantId AS NVARCHAR(36)) AS TenantId, Name
      FROM oe.Tenants
      WHERE TenantId IN (${placeholders})
    `);
    for (const row of result.recordset || []) {
      const nm = row.Name != null ? String(row.Name).trim() : '';
      map.set(String(row.TenantId), nm || null);
    }
  }
  return map;
}

/**
 * Primary member (RelationshipType P) per household — id + display label.
 * @returns {Promise<Map<string, { PrimaryMemberName: string|null, PrimaryMemberId: string|null }>>}
 */
async function fetchPrimaryMemberByHousehold(pool, householdIds) {
  const map = new Map();
  const unique = [...new Set(householdIds.map((id) => String(id)))];
  if (unique.length === 0) return map;
  for (const slice of chunkArray(unique, 40)) {
    const req = pool.request();
    slice.forEach((id, idx) => {
      req.input(`hid${idx}`, sql.UniqueIdentifier, id);
    });
    const placeholders = slice.map((_, idx) => `@hid${idx}`).join(', ');
    const result = await req.query(`
      WITH prim AS (
        SELECT
          m.HouseholdId,
          m.MemberId,
          LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, N''), N' ', ISNULL(u.LastName, N'')))) AS FullName,
          u.Email AS Email,
          ROW_NUMBER() OVER (
            PARTITION BY m.HouseholdId
            ORDER BY m.CreatedDate, m.MemberId
          ) AS rn
        FROM oe.Members m
        INNER JOIN oe.Users u ON u.UserId = m.UserId
        WHERE m.RelationshipType = N'P'
          AND m.HouseholdId IN (${placeholders})
      )
      SELECT
        CAST(HouseholdId AS NVARCHAR(36)) AS HouseholdId,
        CAST(MemberId AS NVARCHAR(36)) AS MemberId,
        FullName,
        Email
      FROM prim
      WHERE rn = 1
    `);
    for (const row of result.recordset || []) {
      const trimmed = row.FullName != null ? String(row.FullName).trim() : '';
      const email = row.Email != null ? String(row.Email).trim() : '';
      const label = trimmed || (email ? email : null);
      map.set(String(row.HouseholdId), {
        PrimaryMemberName: label,
        PrimaryMemberId: row.MemberId != null ? String(row.MemberId).trim() || null : null
      });
    }
  }
  return map;
}

/**
 * Resolve a tenant's per-invoice MemberPaid system-fee floor from the JSON
 * blob stored in oe.Tenants.SystemFees. Mirrors the shape used by
 * UnifiedTenantSettingsModal: { platformFee, mobileAppFee, aiAssistantFee }
 * each with `enabled`, `MemberPaid`, `MemberPaidAmount`, `amount`.
 *
 * Only fees where `enabled === true` AND `MemberPaid === true` count toward
 * the per-invoice floor. Returns 0 when no JSON is configured (which means
 * "no floor to enforce" for that tenant).
 */
function resolveTenantFeeFloor(systemFeesJson) {
  if (!systemFeesJson) return 0;
  let parsed = systemFeesJson;
  if (typeof systemFeesJson === 'string') {
    try { parsed = JSON.parse(systemFeesJson); } catch (_e) { return 0; }
  }
  if (!parsed || typeof parsed !== 'object') return 0;
  let total = 0;
  for (const key of Object.keys(parsed)) {
    const fee = parsed[key];
    if (!fee || typeof fee !== 'object') continue;
    if (fee.enabled !== true) continue;
    if (fee.MemberPaid !== true) continue;
    const amt = Number(fee.MemberPaidAmount ?? fee.amount ?? 0);
    if (Number.isFinite(amt) && amt > 0) total += amt;
  }
  return n2(total);
}

class BillingIntegrityService {
  // ---------------------------------------------------------------------------
  // DETECTORS
  // ---------------------------------------------------------------------------

  /**
   * Find HOUSEHOLD-billed invoices whose SystemFees fall below the invoice's
   * tenant-configured per-invoice fee floor (sum of enabled MemberPaid
   * fees from oe.Tenants.SystemFees), and categorize by the math relationship
   * between TotalAmount and the breakdown columns.
   *
   * Note: Group invoices are intentionally excluded from this detector.
   * Group fees are derived per-member from oe.Enrollments and may legitimately
   * be $0 for products with the fee bundled into NetRate by design. Genuine
   * breakdown drift on group invoices is caught by the existing
   * `payment_json_fees` audit on the TenantBilling page.
   *
   * Buckets (relative to the invoice's tenant fee floor):
   *   - safe_to_split: TotalAmount = BreakdownSum + tenantFeeFloor. Customer
   *     already paid the fee, just not categorized into SystemFees. Safe to
   *     auto-correct (rebalances the existing total).
   *   - undercharged: BreakdownSum = TotalAmount and SystemFees = 0. The fee
   *     was never billed. Needs human review (fix enrollment first).
   *   - other_mismatch: Any other math discrepancy.
   */
  static async findLowSystemFeeInvoices() {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        i.InvoiceId,
        i.TenantId,
        i.InvoiceNumber,
        i.InvoiceType,
        i.HouseholdId,
        i.GroupId,
        i.BillingPeriodStart,
        i.BillingPeriodEnd,
        i.Status,
        i.TotalAmount,
        i.PaidAmount,
        ISNULL(i.NetRate, 0) AS NetRate,
        ISNULL(i.OverrideRate, 0) AS OverrideRate,
        ISNULL(i.Commission, 0) AS Commission,
        ISNULL(i.SystemFees, 0) AS SystemFees,
        ISNULL(i.ProcessingFeeAmount, 0) AS ProcessingFeeAmount,
        ISNULL(i.SetupFee, 0) AS SetupFee,
        g.Name AS GroupName,
        prim.MemberId AS PrimaryMemberId,
        prim.UserId AS PrimaryUserId,
        u.FirstName AS PrimaryFirstName,
        u.LastName AS PrimaryLastName,
        u.Email AS PrimaryEmail,
        t.SystemFees AS TenantSystemFeesJson,
        t.Name AS TenantName,
        (
          SELECT COUNT(*) FROM oe.Payments p
          WHERE p.InvoiceId = i.InvoiceId
            AND p.Status IN ('Success','Completed','succeeded')
        ) AS LinkedSuccessPayments
      FROM oe.Invoices i
      LEFT JOIN oe.Tenants t ON t.TenantId = i.TenantId
      LEFT JOIN oe.Groups g ON g.GroupId = i.GroupId
      OUTER APPLY (
        SELECT TOP 1 m.MemberId, m.UserId
        FROM oe.Members m
        WHERE m.HouseholdId = i.HouseholdId
        ORDER BY ISNULL(m.MemberSequence, 99), m.CreatedDate
      ) prim
      LEFT JOIN oe.Users u ON u.UserId = prim.UserId
      WHERE i.Status NOT IN ('Cancelled','Voided')
        -- Group invoices use a per-member fee model (can be $0 by product
        -- design); they are audited separately via payment_json_fees.
        AND i.HouseholdId IS NOT NULL
        AND i.GroupId IS NULL
      ORDER BY i.BillingPeriodStart DESC, i.InvoiceNumber
    `);

    const rows = result.recordset || [];
    const tenantFloorCache = new Map();
    const enriched = [];

    for (const r of rows) {
      const tenantId = r.TenantId;
      let floor = tenantFloorCache.get(tenantId);
      if (floor === undefined) {
        floor = resolveTenantFeeFloor(r.TenantSystemFeesJson);
        tenantFloorCache.set(tenantId, floor);
      }

      // No configured floor → don't flag this tenant's invoices.
      if (!(floor > 0)) continue;
      if (n2(r.SystemFees) >= floor - MATH_TOLERANCE) continue;

      const breakdownSum = sumBreakdowns(r);
      const total = n2(r.TotalAmount);
      const diff = n2(total - breakdownSum);
      let bucket;
      if (Math.abs(diff - floor) < MATH_TOLERANCE) {
        bucket = 'safe_to_split';
      } else if (Math.abs(diff) < MATH_TOLERANCE && n2(r.SystemFees) < MATH_TOLERANCE) {
        bucket = 'undercharged';
      } else {
        bucket = 'other_mismatch';
      }

      const { TenantSystemFeesJson, ...rest } = r;
      enriched.push({
        ...rest,
        BreakdownSum: breakdownSum,
        MathDiff: diff,
        Bucket: bucket,
        TenantFeeFloor: floor
      });
    }

    return enriched;
  }

  /**
   * Find individually-billed households (have at least one Product enrollment
   * with no GroupID) that are missing one or more monthly invoices between
   * the first effective month and the current month.
   * Returns one row per missing month so the caller can iterate.
   */
  static async findMissingMonthlyInvoices() {
    const pool = await getPool();
    const result = await pool.request().query(`
      WITH individual_households AS (
        SELECT DISTINCT e.HouseholdId
        FROM oe.Enrollments e
        WHERE e.EnrollmentType = N'Product'
          AND e.HouseholdId IS NOT NULL
          AND (e.GroupID IS NULL OR e.GroupID = N'00000000-0000-0000-0000-000000000000')
      ),
      first_active AS (
        SELECT
          e.HouseholdId,
          MIN(e.EffectiveDate) AS FirstActive,
          MAX(CASE
            WHEN e.Status = N'Active' AND e.TerminationDate IS NULL THEN CAST(GETUTCDATE() AS DATE)
            WHEN e.TerminationDate IS NOT NULL THEN e.TerminationDate
            ELSE e.EffectiveDate
          END) AS LastActive
        FROM oe.Enrollments e
        INNER JOIN individual_households ih ON e.HouseholdId = ih.HouseholdId
        WHERE e.EnrollmentType = N'Product'
          AND e.Status IN (N'Active', N'Terminated', N'Inactive')
          AND (e.GroupID IS NULL OR e.GroupID = N'00000000-0000-0000-0000-000000000000')
        GROUP BY e.HouseholdId
      ),
      anchor AS (
        SELECT
          e.HouseholdId,
          MIN(e.EffectiveDate) AS AnchorEffectiveDate
        FROM oe.Enrollments e
        INNER JOIN individual_households ih ON e.HouseholdId = ih.HouseholdId
        WHERE e.Status = N'Active'
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
          AND e.EnrollmentType IN (N'Product', N'Bundle')
          AND (e.GroupID IS NULL OR CAST(e.GroupID AS NVARCHAR(36)) = N'00000000-0000-0000-0000-000000000000')
        GROUP BY e.HouseholdId
      )
      SELECT
        fa.HouseholdId,
        m.TenantId,
        fa.FirstActive,
        fa.LastActive,
        a.AnchorEffectiveDate
      FROM first_active fa
      OUTER APPLY (
        SELECT TOP 1 mem.TenantId
        FROM oe.Members mem
        WHERE mem.HouseholdId = fa.HouseholdId
        ORDER BY mem.CreatedDate
      ) m
      LEFT JOIN anchor a ON a.HouseholdId = fa.HouseholdId
      WHERE m.TenantId IS NOT NULL
    `);

    const householdRows = result.recordset || [];

    const missing = [];
    for (const hh of householdRows) {
      const firstStart = startOfMonthUTC(hh.FirstActive);
      const lastYm = ymKey(hh.LastActive);

      const invResult = await pool.request()
        .input('householdId', sql.UniqueIdentifier, hh.HouseholdId)
        .query(`
          SELECT BillingPeriodStart
          FROM oe.Invoices
          WHERE HouseholdId = @householdId
            AND InvoiceType = N'Individual'
            AND Status NOT IN (N'Cancelled', N'Voided')
        `);
      const existingMonths = new Set(
        (invResult.recordset || []).map((r) => ymKey(r.BillingPeriodStart))
      );

      const anchorDom = hh.AnchorEffectiveDate
        ? new Date(hh.AnchorEffectiveDate).getUTCDate()
        : null;

      let cursor = new Date(firstStart);
      while (ymKey(cursor) <= lastYm) {
        const y = cursor.getUTCFullYear();
        const mo = cursor.getUTCMonth();
        const key = ymKey(cursor);

        let billingPeriodStart;
        let billingPeriodEnd;
        if (anchorDom != null) {
          billingPeriodStart = invoiceService.sameDayNextMonth(anchorDom, y, mo);
          billingPeriodEnd = invoiceService.endOfMonth(billingPeriodStart);
        } else {
          billingPeriodStart = new Date(cursor);
          billingPeriodEnd = endOfMonthUTC(cursor);
        }

        if (!existingMonths.has(key)) {
          missing.push({
            HouseholdId: hh.HouseholdId,
            TenantId: hh.TenantId,
            BillingPeriodStart: billingPeriodStart,
            BillingPeriodEnd: billingPeriodEnd,
            MonthKey: key
          });
        }

        cursor = addMonthsUTC(cursor, 1);
      }
    }

    const tenantNames = await fetchTenantNamesById(
      pool,
      missing.map((r) => r.TenantId)
    );
    const primaryByHh = await fetchPrimaryMemberByHousehold(
      pool,
      missing.map((r) => r.HouseholdId)
    );
    return missing.map((row) => {
      const pm = primaryByHh.get(String(row.HouseholdId));
      return {
        ...row,
        TenantName: tenantNames.get(String(row.TenantId)) ?? null,
        PrimaryMemberName: pm?.PrimaryMemberName ?? null,
        PrimaryMemberId: pm?.PrimaryMemberId ?? null
      };
    });
  }

  /**
   * Read-only audit: households where open individual invoices or the active DIME
   * recurring NextBillingDate do not align with DAY(unified enrollment anchor).
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  static async findAnchorDriftHouseholds() {
    const pool = await getPool();
    const result = await pool.request().query(`
      WITH individual_households AS (
        SELECT DISTINCT e.HouseholdId
        FROM oe.Enrollments e
        WHERE e.EnrollmentType = N'Product'
          AND e.HouseholdId IS NOT NULL
          AND (e.GroupID IS NULL OR e.GroupID = N'00000000-0000-0000-0000-000000000000')
      ),
      anchor AS (
        SELECT
          e.HouseholdId,
          MIN(e.EffectiveDate) AS AnchorEffectiveDate
        FROM oe.Enrollments e
        INNER JOIN individual_households ih ON e.HouseholdId = ih.HouseholdId
        WHERE e.Status = N'Active'
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
          AND e.EnrollmentType IN (N'Product', N'Bundle')
          AND (e.GroupID IS NULL OR CAST(e.GroupID AS NVARCHAR(36)) = N'00000000-0000-0000-0000-000000000000')
        GROUP BY e.HouseholdId
      ),
      primary_mem AS (
        SELECT
          m.HouseholdId,
          CAST(m.MemberId AS NVARCHAR(36)) AS PrimaryMemberId,
          NULLIF(LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, N''), N' ', ISNULL(u.LastName, N'')))), N'') AS PrimaryMemberName,
          ROW_NUMBER() OVER (
            PARTITION BY m.HouseholdId
            ORDER BY m.CreatedDate ASC, m.MemberId ASC
          ) AS rn
        FROM oe.Members m
        INNER JOIN oe.Users u ON u.UserId = m.UserId
        INNER JOIN anchor a ON a.HouseholdId = m.HouseholdId
        WHERE m.RelationshipType = N'P'
      )
      SELECT
        CAST(a.HouseholdId AS NVARCHAR(36)) AS HouseholdId,
        p.PrimaryMemberId,
        NULLIF(LTRIM(RTRIM(p.PrimaryMemberName)), N'') AS PrimaryMemberName,
        a.AnchorEffectiveDate,
        DAY(a.AnchorEffectiveDate) AS AnchorDay,
        ISNULL(wrong.WrongOpenInvoiceCount, 0) AS WrongOpenInvoiceCount,
        rs.NextBillingDate,
        CASE
          WHEN rs.NextBillingDate IS NULL THEN 0
          WHEN DAY(rs.NextBillingDate) <> DAY(a.AnchorEffectiveDate) THEN 1
          ELSE 0
        END AS DimeScheduleDayMismatch
      FROM anchor a
      LEFT JOIN primary_mem p ON p.HouseholdId = a.HouseholdId AND p.rn = 1
      OUTER APPLY (
        SELECT COUNT(*) AS WrongOpenInvoiceCount
        FROM oe.Invoices i
        WHERE i.HouseholdId = a.HouseholdId
          AND i.InvoiceType = N'Individual'
          AND i.Status NOT IN (N'Cancelled', N'Voided', N'Paid')
          AND DAY(i.BillingPeriodStart) <> DAY(a.AnchorEffectiveDate)
      ) wrong
      OUTER APPLY (
        SELECT TOP 1 irs.NextBillingDate
        FROM oe.IndividualRecurringSchedules irs
        WHERE irs.HouseholdId = a.HouseholdId
          AND irs.IsActive = 1
        ORDER BY irs.CreatedDate DESC
      ) rs
      WHERE ISNULL(wrong.WrongOpenInvoiceCount, 0) > 0
         OR (
           rs.NextBillingDate IS NOT NULL
           AND DAY(rs.NextBillingDate) <> DAY(a.AnchorEffectiveDate)
         )
      ORDER BY p.PrimaryMemberName, a.HouseholdId
    `);
    return result.recordset || [];
  }

  /**
   * Find orphan payments (InvoiceId IS NULL) categorized by status. Returns
   * a single recordset where Category indicates how the payment is treated.
   */
  static async findOrphanPayments() {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        p.PaymentId,
        p.TenantId,
        p.HouseholdId,
        p.GroupId,
        CAST(pm.MemberId AS NVARCHAR(36)) AS PrimaryMemberId,
        p.Amount,
        p.Status,
        p.PaymentDate,
        p.CreatedDate,
        p.Processor,
        p.PaymentMethod,
        CASE
          WHEN p.Status IN ('Success','Completed','succeeded') THEN 'completed'
          WHEN p.Status IN ('Refunded','PartiallyRefunded') THEN 'refunded'
          WHEN p.Status IN ('Failed','failed','Declined','declined') THEN 'failed'
          WHEN p.Status IN ('Pending','pending','Processing','processing') THEN 'pending'
          WHEN p.Status IN ('RecurringScheduled','Scheduled') THEN 'scheduled'
          ELSE 'other'
        END AS Category
      FROM oe.Payments p
      OUTER APPLY (
        SELECT TOP 1 m.MemberId
        FROM oe.Members m
        WHERE p.HouseholdId IS NOT NULL
          AND m.HouseholdId = p.HouseholdId
          AND m.RelationshipType = N'P'
        ORDER BY m.CreatedDate, m.MemberId
      ) pm
      WHERE p.InvoiceId IS NULL
      ORDER BY p.PaymentDate DESC
    `);
    return result.recordset || [];
  }

  /**
   * Total SystemFees actually collected from Paid invoices linked to
   * Success/Completed payments. Returns aggregate plus a YYYY-MM breakdown.
   */
  static async getSystemFeeCollections() {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        FORMAT(i.BillingPeriodStart, 'yyyy-MM') AS Month,
        SUM(ISNULL(i.SystemFees, 0)) AS TotalSystemFees,
        COUNT(*) AS InvoiceCount
      FROM oe.Invoices i
      WHERE i.Status = 'Paid'
      GROUP BY FORMAT(i.BillingPeriodStart, 'yyyy-MM')
      ORDER BY Month
    `);
    const byMonth = result.recordset || [];
    const total = byMonth.reduce((sum, r) => sum + Number(r.TotalSystemFees || 0), 0);
    return {
      totalCollected: Math.round(total * 100) / 100,
      byMonth: byMonth.map((r) => ({
        month: r.Month,
        invoiceCount: Number(r.InvoiceCount || 0),
        systemFees: Math.round(Number(r.TotalSystemFees || 0) * 100) / 100
      }))
    };
  }

  /**
   * Find $0 "phantom" invoices that have at least one payment linked AND a
   * real "twin" invoice for the same household within a 45-day prepay
   * window of the linked payment's date, where the payment amount equals
   * the twin's outstanding balance (within $0.50 tolerance).
   *
   * Root cause: when a payment settles outside the prepay-match path
   * (e.g., DIME webhook firing before linker can prepay-match), the fallback
   * `getOrCreateInvoiceForPayment(paymentDate)` creates a $0 invoice for
   * the payment's calendar month (because no enrollments exist that month)
   * and links the payment to it. The real intended next-month invoice
   * sits Unpaid. This auditor finds these pairs.
   */
  static async findPhantomZeroInvoices() {
    const pool = await getPool();
    const result = await pool.request().query(`
      WITH phantom AS (
        SELECT
          i.InvoiceId          AS PhantomInvoiceId,
          i.InvoiceNumber      AS PhantomInvoiceNumber,
          i.HouseholdId,
          i.TenantId,
          i.BillingPeriodStart AS PhantomPeriodStart,
          i.BillingPeriodEnd   AS PhantomPeriodEnd,
          p.PaymentId,
          p.PaymentDate,
          p.Amount             AS PaymentAmount,
          p.Status             AS PaymentStatus
        FROM oe.Invoices i
        INNER JOIN oe.Payments p ON p.InvoiceId = i.InvoiceId
        WHERE i.TotalAmount = 0
          AND ISNULL(i.HouseholdId, '00000000-0000-0000-0000-000000000000') <> '00000000-0000-0000-0000-000000000000'
          AND i.Status NOT IN ('Cancelled','Voided')
      )
      SELECT
        phantom.*,
        twin.InvoiceId          AS TwinInvoiceId,
        twin.InvoiceNumber      AS TwinInvoiceNumber,
        twin.BillingPeriodStart AS TwinPeriodStart,
        twin.BillingPeriodEnd   AS TwinPeriodEnd,
        twin.TotalAmount        AS TwinTotalAmount,
        twin.PaidAmount         AS TwinPaidAmount,
        twin.Status             AS TwinStatus,
        prim.MemberId           AS PrimaryMemberId,
        u.FirstName             AS PrimaryFirstName,
        u.LastName              AS PrimaryLastName,
        u.Email                 AS PrimaryEmail
      FROM phantom
      OUTER APPLY (
        -- A "twin" is the real invoice the payment was meant for. Two
        -- shapes qualify:
        --  (1) Outstanding balance matches the payment amount within $0.50
        --      (the typical Unpaid/Partial/Overdue case).
        --  (2) Twin is already Paid AND has no payments currently linked AND
        --      its TotalAmount matches the payment amount within $0.50
        --      (stale-Paid case — payment was originally here, got moved
        --      onto a phantom, but the twin's PaidAmount was never reversed).
        SELECT TOP 1 i2.InvoiceId, i2.InvoiceNumber, i2.BillingPeriodStart,
                     i2.BillingPeriodEnd, i2.TotalAmount, i2.PaidAmount, i2.Status
        FROM oe.Invoices i2
        WHERE i2.HouseholdId = phantom.HouseholdId
          AND i2.InvoiceId <> phantom.PhantomInvoiceId
          AND i2.InvoiceType = N'Individual'
          AND i2.Status IN (N'Unpaid', N'Partial', N'Overdue', N'Paid')
          AND DATEDIFF(day, phantom.PaymentDate, i2.BillingPeriodStart) BETWEEN 0 AND 45
          AND (
            ABS(phantom.PaymentAmount - (i2.TotalAmount - COALESCE(i2.PaidAmount, 0))) <= 0.50
            OR (
              i2.Status = N'Paid'
              AND ABS(phantom.PaymentAmount - i2.TotalAmount) <= 0.50
              AND NOT EXISTS (
                SELECT 1 FROM oe.Payments p2 WHERE p2.InvoiceId = i2.InvoiceId
              )
            )
          )
        ORDER BY i2.BillingPeriodStart ASC
      ) twin
      OUTER APPLY (
        SELECT TOP 1 m.MemberId, m.UserId
        FROM oe.Members m
        WHERE m.HouseholdId = phantom.HouseholdId
        ORDER BY ISNULL(m.MemberSequence, 99), m.CreatedDate
      ) prim
      LEFT JOIN oe.Users u ON u.UserId = prim.UserId
      ORDER BY phantom.PaymentDate DESC
    `);
    return result.recordset || [];
  }

  /**
   * Repair $0 phantom invoices by re-pointing their payment(s) to the
   * matching real twin invoice and deleting the phantom row. Only operates
   * on phantoms where a clear twin was found (TwinInvoiceId IS NOT NULL).
   *
   * Idempotent: re-running has no effect once phantoms are gone.
   */
  static async fixPhantomZeroInvoices({ dryRun = false } = {}) {
    const phantoms = await BillingIntegrityService.findPhantomZeroInvoices();
    const eligible = phantoms.filter((r) => r.TwinInvoiceId);

    let repaired = 0;
    let skipped = phantoms.length - eligible.length;
    const errors = [];
    const samples = [];

    if (dryRun) {
      return {
        scanned: phantoms.length,
        eligible: eligible.length,
        skipped,
        samples: eligible.slice(0, 100).map((r) => ({
          phantomInvoiceId: r.PhantomInvoiceId,
          phantomInvoiceNumber: r.PhantomInvoiceNumber,
          paymentId: r.PaymentId,
          paymentAmount: Number(r.PaymentAmount || 0),
          twinInvoiceId: r.TwinInvoiceId,
          twinInvoiceNumber: r.TwinInvoiceNumber,
          householdId: r.HouseholdId,
          primaryEmail: r.PrimaryEmail
        }))
      };
    }

    const pool = await getPool();
    for (const r of eligible) {
      const txn = pool.transaction();
      try {
        await txn.begin();

        // 1. Re-point ALL payments currently on the phantom to the twin.
        await txn.request()
          .input('twinId', require('mssql').UniqueIdentifier, r.TwinInvoiceId)
          .input('phantomId', require('mssql').UniqueIdentifier, r.PhantomInvoiceId)
          .query(`
            UPDATE oe.Payments
               SET InvoiceId = @twinId
             WHERE InvoiceId = @phantomId
          `);

        // 2. Delete the phantom (it has no real charges, no other payments,
        //    and TotalAmount = 0 so there is nothing to refund or reverse).
        await txn.request()
          .input('phantomId', require('mssql').UniqueIdentifier, r.PhantomInvoiceId)
          .query(`
            DELETE FROM oe.Invoices
            WHERE InvoiceId = @phantomId AND TotalAmount = 0
          `);

        await txn.commit();

        // 3. Fulfill the twin: caps PaidAmount at TotalAmount and flips
        //    Status to 'Paid' / 'Partial' as appropriate. Idempotent if the
        //    twin's PaidAmount already covers the payment.
        try {
          await invoiceService.fulfillInvoice(r.TwinInvoiceId, Number(r.PaymentAmount || 0));
        } catch (_e) { /* fulfill is best-effort */ }

        repaired += 1;
        samples.push({
          phantomInvoiceId: r.PhantomInvoiceId,
          phantomInvoiceNumber: r.PhantomInvoiceNumber,
          paymentId: r.PaymentId,
          twinInvoiceId: r.TwinInvoiceId,
          twinInvoiceNumber: r.TwinInvoiceNumber,
          householdId: r.HouseholdId,
          primaryEmail: r.PrimaryEmail
        });
      } catch (err) {
        try { await txn.rollback(); } catch (_e) { /* noop */ }
        errors.push({
          phantomInvoiceId: r.PhantomInvoiceId,
          paymentId: r.PaymentId,
          error: err.message
        });
      }
    }

    return {
      scanned: phantoms.length,
      eligible: eligible.length,
      repaired,
      skipped,
      errors,
      samples: samples.slice(0, 100)
    };
  }

  /**
   * Composite issue summary used by the diagnostic endpoint.
   */
  static async getIssuesSummary() {
    const [lowFeeInvoices, missing, orphans, fees, phantoms, anchorDriftRows] = await Promise.all([
      BillingIntegrityService.findLowSystemFeeInvoices(),
      BillingIntegrityService.findMissingMonthlyInvoices(),
      BillingIntegrityService.findOrphanPayments(),
      BillingIntegrityService.getSystemFeeCollections(),
      BillingIntegrityService.findPhantomZeroInvoices(),
      BillingIntegrityService.findAnchorDriftHouseholds()
    ]);

    const orphansByCategory = orphans.reduce((acc, row) => {
      acc[row.Category] = (acc[row.Category] || 0) + 1;
      return acc;
    }, {});

    const missingByHousehold = missing.reduce((acc, row) => {
      acc[row.HouseholdId] = (acc[row.HouseholdId] || 0) + 1;
      return acc;
    }, {});

    // Distinct tenant floors observed in the result, for UI display.
    const floorsByTenant = {};
    for (const r of lowFeeInvoices) {
      if (r.TenantId && r.TenantFeeFloor != null) {
        floorsByTenant[r.TenantId] = {
          tenantName: r.TenantName || null,
          tenantFeeFloor: r.TenantFeeFloor
        };
      }
    }

    const phantomEligible = phantoms.filter((r) => r.TwinInvoiceId);

    return {
      tenantFeeFloors: floorsByTenant,
      phantomZeroInvoices: {
        count: phantoms.length,
        eligible: phantomEligible.length,
        rows: phantoms
      },
      lowSystemFeeInvoices: {
        count: lowFeeInvoices.length,
        rows: lowFeeInvoices
      },
      missingMonthlyInvoices: {
        count: missing.length,
        householdCount: Object.keys(missingByHousehold).length,
        rows: missing
      },
      orphanPayments: {
        count: orphans.length,
        byCategory: orphansByCategory,
        rows: orphans
      },
      systemFeeCollections: fees,
      anchorBillingDrift: {
        count: anchorDriftRows.length,
        rows: anchorDriftRows
      }
    };
  }

  // ---------------------------------------------------------------------------
  // FIXES
  // ---------------------------------------------------------------------------

  /**
   * Recompute every breakdown column on each low-fee invoice from oe.Enrollments
   * (the same Audit + Correct flow used in TenantBilling). The fix touches ALL
   * breakdown fields — NetRate, OverrideRate, Commission, SystemFees,
   * ProcessingFeeAmount, SetupFee, plus the three JSON allocation columns —
   * not just SystemFees.
   *
   * Hard safety rule: we only apply the correction when the recomputed
   * breakdown sum equals the existing TotalAmount (within $0.01). That
   * guarantees the customer's charge does not change — we are only
   * re-categorizing the stored breakdown.
   *
   * Rows where the recomputed sum DIFFERS from TotalAmount are reported as
   * `skippedTotalDrift` for human review (e.g. an undercharge that requires
   * adding a SystemFee enrollment, or a stale TotalAmount).
   *
   * Linked Paid payments are aligned to the canonical invoice values so
   * oe.Payments and oe.Invoices agree.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.dryRun=false] When true, only computes deltas.
   * @returns {Promise<{ scanned, eligible, corrected, paymentsAligned, skippedTotalDrift, errors, samples }>}
   */
  static async recomputeLowSystemFeeInvoices({ dryRun = false } = {}) {
    const lowFee = await BillingIntegrityService.findLowSystemFeeInvoices();
    // Every low-fee invoice is eligible for the totals-match safety check.
    // The check itself decides whether the recomputed breakdowns can be
    // applied without changing the customer's TotalAmount.
    const eligible = lowFee;

    let corrected = 0;
    let paymentsAligned = 0;
    let skippedTotalDrift = 0;
    const errors = [];
    const samples = [];

    for (const inv of eligible) {
      try {
        const audit = await PaymentAuditService.computeInvoiceAllocation({
          invoiceId: inv.InvoiceId,
          tenantId: inv.TenantId
        });
        if (!audit) continue;

        const computedSum = n2(
          Number(audit.computed.netRate || 0) +
          Number(audit.computed.overrideRate || 0) +
          Number(audit.computed.commission || 0) +
          Number(audit.computed.systemFees || 0) +
          Number(audit.computed.processingFeeAmount || 0) +
          Number(audit.computed.setupFee || 0)
        );
        const total = n2(inv.TotalAmount);
        const totalsMatch = Math.abs(computedSum - total) < MATH_TOLERANCE;

        const sample = {
          invoiceId: inv.InvoiceId,
          invoiceNumber: inv.InvoiceNumber,
          totalAmount: total,
          before: {
            systemFees: n2(inv.SystemFees),
            netRate: n2(inv.NetRate),
            commission: n2(inv.Commission),
            breakdownSum: n2(inv.BreakdownSum)
          },
          computed: {
            systemFees: n2(audit.computed.systemFees),
            netRate: n2(audit.computed.netRate),
            commission: n2(audit.computed.commission),
            breakdownSum: computedSum
          },
          totalsMatch
        };

        if (!totalsMatch) {
          skippedTotalDrift += 1;
          sample.skippedReason = 'computed_breakdown_sum_does_not_match_total';
          samples.push(sample);
          continue;
        }

        if (dryRun) {
          samples.push(sample);
          continue;
        }

        await PaymentAuditService.applyInvoiceCorrection({
          invoiceId: inv.InvoiceId,
          tenantId: inv.TenantId,
          computed: audit.computed
        });
        corrected += 1;

        const aligned = await BillingIntegrityService._alignLinkedPaymentBreakdowns({
          invoiceId: inv.InvoiceId,
          tenantId: inv.TenantId,
          computed: audit.computed
        });
        paymentsAligned += aligned;

        samples.push(sample);
      } catch (err) {
        errors.push({ invoiceId: inv.InvoiceId, error: err.message });
      }
    }

    return {
      scanned: lowFee.length,
      eligible: eligible.length,
      corrected,
      paymentsAligned,
      skippedTotalDrift,
      errors,
      samples: samples.slice(0, 50)
    };
  }

  /**
   * Internal: write canonical breakdown values onto Success/Completed payments
   * linked to an invoice. Amount is never modified.
   */
  static async _alignLinkedPaymentBreakdowns({ invoiceId, tenantId, computed }) {
    const pool = await getPool();
    const result = await pool.request()
      .input('invoiceId', require('mssql').UniqueIdentifier, invoiceId)
      .input('tenantId', require('mssql').UniqueIdentifier, tenantId)
      .input('netRate', require('mssql').Decimal(18, 6), computed.netRate)
      .input('overrideRate', require('mssql').Decimal(18, 6), computed.overrideRate)
      .input('commission', require('mssql').Decimal(18, 6), computed.commission)
      .input('systemFees', require('mssql').Decimal(18, 6), computed.systemFees)
      .input('processingFeeAmount', require('mssql').Decimal(18, 6), computed.processingFeeAmount)
      .input('setupFee', require('mssql').Decimal(18, 6), computed.setupFee)
      .input('productCommissions', require('mssql').NVarChar(require('mssql').MAX), computed.productCommissionsJSON)
      .input('productVendorAmounts', require('mssql').NVarChar(require('mssql').MAX), computed.productVendorAmountsJSON)
      .input('productOwnerAmounts', require('mssql').NVarChar(require('mssql').MAX), computed.productOwnerAmountsJSON)
      .query(`
        UPDATE oe.Payments
        SET NetRate = @netRate,
            OverrideRate = @overrideRate,
            Commission = @commission,
            SystemFees = @systemFees,
            ProcessingFeeAmount = @processingFeeAmount,
            SetupFee = @setupFee,
            ProductCommissions = @productCommissions,
            ProductVendorAmounts = @productVendorAmounts,
            ProductOwnerAmounts = @productOwnerAmounts,
            ModifiedDate = GETUTCDATE()
        WHERE InvoiceId = @invoiceId
          AND TenantId = @tenantId
          AND Status IN ('Success','Completed','succeeded')
      `);
    return result?.rowsAffected?.[0] || 0;
  }

  /**
   * Walk every individually-billed household, find missing monthly invoices,
   * and create them via invoiceService.getOrCreateInvoiceForPeriod (idempotent).
   * Newly created invoices auto self-heal linkage with prepay payments via
   * the standard tryLinkPaymentToInvoice path inside selfHealInvoice.
   */
  static async createMissingMonthlyInvoices({ dryRun = false } = {}) {
    const pool = await getPool();
    const missing = await BillingIntegrityService.findMissingMonthlyInvoices();

    let created = 0;
    let skipped = 0;
    const errors = [];
    const samples = [];

    for (const row of missing) {
      try {
        if (dryRun) {
          // Preview the projected total from enrollments without writing.
          // The actual createInvoiceForEnrollment derives TotalAmount from
          // these same enrollment rows, so this is what the new invoice
          // will charge.
          const previewResult = await pool.request()
            .input('householdId', sql.UniqueIdentifier, row.HouseholdId)
            .input('bpStart', rawSql.DateTime, row.BillingPeriodStart)
            .input('bpEnd', rawSql.DateTime, row.BillingPeriodEnd)
            .query(`
              SELECT
                COALESCE(SUM(COALESCE(e.PremiumAmount, 0)), 0) AS ProjectedTotal,
                COUNT(*) AS ActiveEnrollmentCount,
                SUM(CASE WHEN e.EnrollmentType = 'SystemFee'
                         THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) AS ProjectedSystemFee
              FROM oe.Enrollments e
              WHERE e.HouseholdId = @householdId
                AND e.EffectiveDate <= @bpEnd
                AND (e.TerminationDate IS NULL OR e.TerminationDate > @bpStart)
                AND e.Status NOT IN ('Cancelled', 'Declined')
            `);
          const preview = previewResult.recordset?.[0] || {};
          samples.push({
            householdId: row.HouseholdId,
            month: row.MonthKey,
            billingPeriodStart: row.BillingPeriodStart,
            billingPeriodEnd: row.BillingPeriodEnd,
            projectedTotal: n2(preview.ProjectedTotal),
            projectedSystemFee: n2(preview.ProjectedSystemFee),
            activeEnrollmentCount: Number(preview.ActiveEnrollmentCount || 0)
          });
          continue;
        }

        const result = await invoiceService.getOrCreateInvoiceForPeriod(
          row.HouseholdId,
          row.TenantId,
          row.BillingPeriodStart,
          row.BillingPeriodEnd
        );

        if (result.created) {
          created += 1;
          samples.push({
            householdId: row.HouseholdId,
            month: row.MonthKey,
            invoiceId: result.invoiceId,
            invoiceNumber: result.invoiceNumber
          });
        } else {
          skipped += 1;
        }
      } catch (err) {
        errors.push({ householdId: row.HouseholdId, month: row.MonthKey, error: err.message });
      }
    }

    return {
      scanned: missing.length,
      created,
      skipped,
      errors,
      samples: samples.slice(0, 100)
    };
  }

  /**
   * For every orphan payment (InvoiceId IS NULL), attempt to link via the
   * shared tryLinkPaymentToInvoice flow which:
   *   - prefers a prepay match (existing future Unpaid/Partial/Overdue invoice)
   *   - else matches an invoice for the payment's billing period
   *   - else creates an invoice for that period and links to it
   *
   * @param {object} [opts]
   * @param {string[]} [opts.statuses] Limit by Status. Defaults to completed.
   */
  static async linkOrphanPayments({ statuses = COMPLETED_PAYMENT_STATUSES, dryRun = false } = {}) {
    const orphans = await BillingIntegrityService.findOrphanPayments();
    const eligible = orphans.filter((p) => statuses.includes(p.Status));

    let linked = 0;
    let unlinked = 0;
    const errors = [];
    const samples = [];

    for (const p of eligible) {
      try {
        if (dryRun) {
          samples.push({
            paymentId: p.PaymentId,
            householdId: p.HouseholdId,
            paymentDate: p.PaymentDate,
            amount: Number(p.Amount || 0),
            status: p.Status
          });
          continue;
        }

        if (!p.HouseholdId) {
          unlinked += 1;
          continue;
        }

        const result = await invoiceService.tryLinkPaymentToInvoice(
          p.PaymentId,
          p.HouseholdId,
          p.TenantId,
          p.PaymentDate,
          Number(p.Amount || 0)
        );

        if (result?.linked) {
          linked += 1;
          samples.push({
            paymentId: p.PaymentId,
            householdId: p.HouseholdId,
            invoiceId: result.invoiceId,
            via: result.matchedViaPrepay ? 'prepay' : 'period'
          });
        } else {
          unlinked += 1;
        }
      } catch (err) {
        errors.push({ paymentId: p.PaymentId, error: err.message });
      }
    }

    return {
      eligibleScanned: eligible.length,
      totalOrphans: orphans.length,
      linked,
      unlinked,
      errors,
      samples: samples.slice(0, 100)
    };
  }
}

module.exports = BillingIntegrityService;
module.exports.resolveTenantFeeFloor = resolveTenantFeeFloor;

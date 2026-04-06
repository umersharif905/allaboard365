#!/usr/bin/env node
/**
 * Resolve default webhook test IDs from allaboard-testing (same credentials as ai_scripts/db-query.sh).
 *
 * Usage:
 *   node resolve-defaults.cjs --export
 *   node resolve-defaults.cjs --export --mode=group|individual|enrollment|all
 *   WEBHOOK_TEST_RESOLVE_MODE=individual node resolve-defaults.cjs --export
 *
 * Modes:
 *   group       — group recurring (GROUP_SCHEDULE_ID) only
 *   individual  — individual recurring: schedule from a payment row tied to primary member + plan amount
 *   enrollment  — one-off ACH/CC (ENROLLMENT_ID + PremiumAmount) only
 *   all         — all three (default)
 *
 * Enrollment pick (WEBHOOK_TEST_ENROLLMENT_SCOPE, set by webhook-test.sh ach-success-*):
 *   group|individual — filter members with GroupId set vs null (direct/indirect book of business)
 *   group — **first** a completed **invoice payment** template (Amount ~17k + InvoiceId, e.g. Cramerton); else largest
 *           group line-charge total then largest enrollment line. Exports WEBHOOK_TEST_TEMPLATE_INVOICE_ID for ach_charge.
 *   group recurring (GROUP_SCHEDULE_ID) — ranked by same group volume aggregate
 *   individual — not-on-a-group members only; default billing tenant = MightyWELL (WEBHOOK_TEST_INDIVIDUAL_BILLING_TENANT_ID)
 *                so local ACH matches Tenant Billing when logged into MightyWELL (COALESCE(Group.TenantId, Product.ProductOwnerId)).
 */
const path = require('path');
const sql = require(path.join(__dirname, '../../backend/node_modules/mssql'));
require(path.join(__dirname, '../../backend/node_modules/dotenv')).config({
  path: path.join(__dirname, '../../ai_scripts/.env'),
});

function shSingleQuoted(s) {
  if (s == null || s === '') return "''";
  return "'" + String(s).replace(/'/g, "'\"'\"'") + "'";
}

function parseMode() {
  const arg = process.argv.find((a) => a.startsWith('--mode='));
  let mode = (arg ? arg.slice('--mode='.length) : process.env.WEBHOOK_TEST_RESOLVE_MODE || 'all').toLowerCase().trim();
  if (!['group', 'individual', 'enrollment', 'all'].includes(mode)) mode = 'all';
  return mode;
}

async function main() {
  const exportShell = process.argv.includes('--export');
  const mode = parseMode();

  const config = {
    server: process.env.DB_SERVER || 'oe-sql-srvr.database.windows.net',
    database: process.env.WEBHOOK_TEST_DB_NAME || 'allaboard-testing',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
  };

  if (!config.user || !config.password) {
    console.error('Missing DB_USER or DB_PASSWORD (load ai_scripts/.env).');
    process.exit(1);
  }

  const pool = await sql.connect(config);

  const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

  /** Matches individualQ PlanChargeAmount / invoice row logic: use PremiumAmount when set, else component sum. */
  const lineChargeExpr = (alias) => `CASE
        WHEN COALESCE(${alias}.PremiumAmount, 0) > 0 THEN COALESCE(${alias}.PremiumAmount, 0)
        ELSE COALESCE(${alias}.NetRate, 0) + COALESCE(${alias}.Commission, 0) + COALESCE(${alias}.OverrideRate, 0) + COALESCE(${alias}.SystemFees, 0)
      END`;

  const runGroup = mode === 'all' || mode === 'group';
  const runIndividual = mode === 'all' || mode === 'individual';
  const runEnrollment = mode === 'all' || mode === 'enrollment';

  const groupVolumeSubquery = `
      SELECT
        m2.GroupId,
        SUM(${lineChargeExpr('e2')}) AS GroupTotalLineCharge
      FROM oe.Members m2
      INNER JOIN oe.Enrollments e2 ON e2.MemberId = m2.MemberId
      WHERE m2.GroupId IS NOT NULL
        AND e2.ProductId IS NOT NULL
        AND e2.ProductId <> '${ZERO_GUID}'
        AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL)
        AND e2.Status = 'Active'
        AND CAST(e2.EffectiveDate AS DATE) <= CAST(GETUTCDATE() AS DATE)
        AND (e2.TerminationDate IS NULL OR e2.TerminationDate > GETUTCDATE())
        AND (
          COALESCE(e2.PremiumAmount, 0) > 0
          OR COALESCE(e2.NetRate, 0) + COALESCE(e2.Commission, 0) + COALESCE(e2.OverrideRate, 0) + COALESCE(e2.SystemFees, 0) > 0
        )
      GROUP BY m2.GroupId`;

  const groupQ = `
    SELECT TOP 1
      g.Name AS GroupName,
      g.ProcessorCustomerId,
      grp.DimeScheduleId
    FROM oe.GroupRecurringPaymentPlans grp
    INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
    WHERE grp.DimeScheduleId IS NOT NULL AND grp.DimeScheduleId <> ''
      AND EXISTS (
        SELECT 1
        FROM oe.Members m2
        INNER JOIN oe.Enrollments e2 ON e2.MemberId = m2.MemberId
        WHERE m2.GroupId = g.GroupId
          AND e2.ProductId IS NOT NULL
          AND e2.ProductId <> '${ZERO_GUID}'
          AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL)
          AND e2.Status = 'Active'
          AND CAST(e2.EffectiveDate AS DATE) <= CAST(GETUTCDATE() AS DATE)
          AND (e2.TerminationDate IS NULL OR e2.TerminationDate > GETUTCDATE())
      )
    ORDER BY vol.GroupTotalLineCharge DESC, grp.ModifiedDate DESC
  `;

  const groupFallbackQ = `
    SELECT TOP 1
      g.Name AS GroupName,
      g.ProcessorCustomerId,
      grp.DimeScheduleId
    FROM oe.GroupRecurringPaymentPlans grp
    INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
    WHERE grp.DimeScheduleId IS NOT NULL AND grp.DimeScheduleId <> ''
    ORDER BY grp.ModifiedDate DESC
  `;

  // Individual recurring: same household as payment + primary member's active product enrollments → premium (or component sum).
  const individualQ = `
    SELECT TOP 1
      p.RecurringScheduleId,
      COALESCE(
        NULLIF(LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, ''), ' ', ISNULL(u.LastName, '')))), ''),
        'Primary member'
      ) AS MemberName,
      CASE
        WHEN agg.PremiumSum > 0 THEN agg.PremiumSum
        ELSE agg.ComponentsSum
      END AS PlanChargeAmount
    FROM oe.Payments p
    INNER JOIN oe.Members m ON m.HouseholdId = p.HouseholdId AND m.RelationshipType = 'P'
    INNER JOIN oe.Users u ON m.UserId = u.UserId
    CROSS APPLY (
      SELECT
        SUM(COALESCE(e.PremiumAmount, 0)) AS PremiumSum,
        SUM(
          COALESCE(e.NetRate, 0) + COALESCE(e.Commission, 0) + COALESCE(e.OverrideRate, 0) + COALESCE(e.SystemFees, 0)
        ) AS ComponentsSum
      FROM oe.Enrollments e
      WHERE e.MemberId = m.MemberId
        AND e.ProductId IS NOT NULL
        AND e.ProductId <> '${ZERO_GUID}'
        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        AND e.Status = 'Active'
        AND CAST(e.EffectiveDate AS DATE) <= CAST(GETUTCDATE() AS DATE)
        AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
    ) agg
    WHERE p.RecurringScheduleId IS NOT NULL AND p.RecurringScheduleId <> ''
      AND p.TransactionType = 'Payment'
      AND (agg.PremiumSum > 0 OR agg.ComponentsSum > 0)
    ORDER BY p.CreatedDate DESC
  `;

  const enrollScope = (process.env.WEBHOOK_TEST_ENROLLMENT_SCOPE || '').toLowerCase().trim();
  /** Default MightyWELL (allaboard-testing); override for other tenants. Matches webhook payment TenantId for non-group enrollments. */
  const individualBillingTenantId = (
    process.env.WEBHOOK_TEST_INDIVIDUAL_BILLING_TENANT_ID || '1CD92AF7-B6F2-4E48-A8F3-EC6316158826'
  )
    .replace(/[^0-9A-Fa-f-]/g, '')
    .toUpperCase();

  let enrollmentMemberFilter = '';
  if (enrollScope === 'group') {
    enrollmentMemberFilter = '\n      AND m.GroupId IS NOT NULL';
  } else if (enrollScope === 'individual') {
    enrollmentMemberFilter = '\n      AND m.GroupId IS NULL';
  }

  const enrollmentProductJoinsForIndividualTenant =
    enrollScope === 'individual' && individualBillingTenantId.length === 36
      ? `
    INNER JOIN oe.Products pr ON e.ProductId = pr.ProductId
    LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId`
      : '';

  const individualBillingTenantSql =
    enrollScope === 'individual' && individualBillingTenantId.length === 36
      ? `
      AND COALESCE(g.TenantId, pr.ProductOwnerId) = '${individualBillingTenantId}'`
      : '';

  const enrollmentSelectList = `
      e.EnrollmentId,
      e.PremiumAmount,
      ${lineChargeExpr('e')} AS LineCharge,
      COALESCE(
        NULLIF(LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, ''), ' ', ISNULL(u.LastName, '')))), ''),
        'Enrolled member'
      ) AS MemberName`;

  const enrollmentProductFilters = `
      AND e.ProductId IS NOT NULL
      AND e.ProductId <> '${ZERO_GUID}'
      AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
      AND e.Status = 'Active'
      AND CAST(e.EffectiveDate AS DATE) <= CAST(GETUTCDATE() AS DATE)
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
      AND (
        COALESCE(e.PremiumAmount, 0) > 0
        OR COALESCE(e.NetRate, 0) + COALESCE(e.Commission, 0) + COALESCE(e.OverrideRate, 0) + COALESCE(e.SystemFees, 0) > 0
      )`;

  /** Prefer largest **billing-like** group total, then largest single enrollment line (avoids $3 ancillary rows). */
  const enrollmentQGroupPreferDense = `
    SELECT TOP 1 ${enrollmentSelectList}
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    LEFT JOIN oe.Users u ON m.UserId = u.UserId
    INNER JOIN (
      SELECT
        m2.GroupId,
        COUNT(DISTINCT m2.MemberId) AS MemberCnt,
        COUNT(DISTINCT e2.EnrollmentId) AS EnrCnt,
        SUM(${lineChargeExpr('e2')}) AS GroupTotalLineCharge
      FROM oe.Members m2
      INNER JOIN oe.Enrollments e2 ON e2.MemberId = m2.MemberId
      WHERE m2.GroupId IS NOT NULL
        AND e2.ProductId IS NOT NULL
        AND e2.ProductId <> '${ZERO_GUID}'
        AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL)
        AND e2.Status = 'Active'
        AND CAST(e2.EffectiveDate AS DATE) <= CAST(GETUTCDATE() AS DATE)
        AND (e2.TerminationDate IS NULL OR e2.TerminationDate > GETUTCDATE())
        AND (
          COALESCE(e2.PremiumAmount, 0) > 0
          OR COALESCE(e2.NetRate, 0) + COALESCE(e2.Commission, 0) + COALESCE(e2.OverrideRate, 0) + COALESCE(e2.SystemFees, 0) > 0
        )
      GROUP BY m2.GroupId
    ) gs ON gs.GroupId = m.GroupId
    WHERE m.GroupId IS NOT NULL
    ${enrollmentProductFilters}
    ORDER BY gs.GroupTotalLineCharge DESC, gs.MemberCnt DESC, gs.EnrCnt DESC, ${lineChargeExpr('e')} DESC, e.ModifiedDate DESC
  `;

  const enrollmentQ = `
    SELECT TOP 1 ${enrollmentSelectList}
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    LEFT JOIN oe.Users u ON m.UserId = u.UserId${enrollmentProductJoinsForIndividualTenant}
    WHERE 1 = 1
    ${enrollmentProductFilters}${enrollmentMemberFilter}${individualBillingTenantSql}
    ORDER BY ${lineChargeExpr('e')} DESC, e.ModifiedDate DESC
  `;

  /** Completed group invoice payment (Cramerton-style ~17k): drives WEBHOOK_TEST_TEMPLATE_INVOICE_ID + ACH amount. */
  const groupInvoiceTemplateQ = `
    SELECT TOP 1
      p.EnrollmentId,
      p.InvoiceId,
      p.Amount AS PaymentAmount,
      p.GroupId,
      COALESCE(
        NULLIF(LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, ''), ' ', ISNULL(u.LastName, '')))), ''),
        'Enrolled member'
      ) AS MemberName,
      e.PremiumAmount,
      ${lineChargeExpr('e')} AS LineCharge
    FROM oe.Payments p
    INNER JOIN (${groupVolumeSubquery}) vol ON vol.GroupId = p.GroupId
    LEFT JOIN oe.Enrollments e ON e.EnrollmentId = p.EnrollmentId
    LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
    LEFT JOIN oe.Users u ON m.UserId = u.UserId
    WHERE p.InvoiceId IS NOT NULL
      AND p.InvoiceId <> '${ZERO_GUID}'
      AND p.GroupId IS NOT NULL
      AND p.TransactionType = 'Payment'
      AND p.Status IN ('Completed', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'PAID', 'Approved')
      AND COALESCE(p.Amount, 0) >= 1000
    ORDER BY vol.GroupTotalLineCharge DESC, p.Amount DESC, p.CreatedDate DESC
  `;

  const enrollmentQForGroupId = (groupId) => `
    SELECT TOP 1 ${enrollmentSelectList}
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    LEFT JOIN oe.Users u ON m.UserId = u.UserId
    WHERE m.GroupId = '${groupId}'
    ${enrollmentProductFilters}
    ORDER BY ${lineChargeExpr('e')} DESC, e.ModifiedDate DESC
  `;

  let gr = { recordset: [] };
  let ind = { recordset: [] };
  let enr = { recordset: [] };

  if (runGroup) {
    gr = await pool.request().query(groupQ);
    if (!gr.recordset || !gr.recordset.length) {
      gr = await pool.request().query(groupFallbackQ);
    }
  }
  if (runIndividual) {
    ind = await pool.request().query(individualQ);
  }
  if (runEnrollment) {
    if (enrollScope === 'group') {
      const invTpl = await pool.request().query(groupInvoiceTemplateQ);
      if (invTpl.recordset && invTpl.recordset.length) {
        let row = invTpl.recordset[0];
        if (!row.EnrollmentId && row.GroupId) {
          const fb = await pool.request().query(enrollmentQForGroupId(String(row.GroupId).toUpperCase()));
          if (fb.recordset && fb.recordset[0]) {
            const f = fb.recordset[0];
            row = {
              ...row,
              EnrollmentId: f.EnrollmentId,
              MemberName: f.MemberName || row.MemberName,
              PremiumAmount: f.PremiumAmount,
              LineCharge: f.LineCharge,
            };
          }
        }
        enr = { recordset: [row] };
      } else {
        enr = await pool.request().query(enrollmentQGroupPreferDense);
        if (!enr.recordset || !enr.recordset.length) {
          enr = await pool.request().query(enrollmentQ);
        }
      }
    } else {
      enr = await pool.request().query(enrollmentQ);
      if (enrollScope === 'individual' && (!enr.recordset || !enr.recordset.length) && individualBillingTenantSql) {
        const enrollmentQFallback = `
    SELECT TOP 1 ${enrollmentSelectList}
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    LEFT JOIN oe.Users u ON m.UserId = u.UserId
    WHERE 1 = 1
    ${enrollmentProductFilters}${enrollmentMemberFilter}
    ORDER BY ${lineChargeExpr('e')} DESC, e.ModifiedDate DESC
  `;
        enr = await pool.request().query(enrollmentQFallback);
      }
    }
  }

  await pool.close();

  const groupRow = gr.recordset && gr.recordset[0];
  const indRow = ind.recordset && ind.recordset[0];
  const enrRow = enr.recordset && enr.recordset[0];

  const planCharge = indRow && indRow.PlanChargeAmount != null ? Number(indRow.PlanChargeAmount) : null;

  const enrollmentEffectiveCharge =
    enrRow != null
      ? (() => {
          if (enrRow.PaymentAmount != null && !Number.isNaN(Number(enrRow.PaymentAmount))) {
            return Number(enrRow.PaymentAmount);
          }
          const p = Number(enrRow.PremiumAmount);
          if (!Number.isNaN(p) && p > 0) return p;
          const lc = Number(enrRow.LineCharge);
          if (!Number.isNaN(lc) && lc > 0) return lc;
          return null;
        })()
      : null;

  const templateInvoiceId =
    enrRow && enrRow.InvoiceId && String(enrRow.InvoiceId) !== ZERO_GUID ? String(enrRow.InvoiceId) : null;

  const payload = {
    ok: true,
    mode,
    group: groupRow
      ? {
          scheduleId: groupRow.DimeScheduleId,
          customerUuid: groupRow.ProcessorCustomerId || null,
          groupName: groupRow.GroupName || '',
        }
      : null,
    individual: indRow
      ? {
          scheduleId: indRow.RecurringScheduleId,
          memberName: indRow.MemberName || '',
          planChargeAmount: planCharge != null && !Number.isNaN(planCharge) ? planCharge : null,
        }
      : null,
    enrollment: enrRow
      ? {
          enrollmentId: enrRow.EnrollmentId,
          memberName: enrRow.MemberName || '',
          premiumAmount: enrRow.PremiumAmount != null ? Number(enrRow.PremiumAmount) : null,
          mockAmount: enrollmentEffectiveCharge != null && !Number.isNaN(enrollmentEffectiveCharge) ? enrollmentEffectiveCharge : null,
          invoiceId: templateInvoiceId,
        }
      : null,
  };

  if (exportShell) {
    if (payload.group) {
      console.log('export GROUP_SCHEDULE_ID=' + shSingleQuoted(payload.group.scheduleId));
      if (payload.group.customerUuid) {
        console.log('export CUSTOMER_UUID=' + shSingleQuoted(payload.group.customerUuid));
      }
      console.log('export WEBHOOK_TEST_GROUP_NAME=' + shSingleQuoted(payload.group.groupName));
    }
    if (payload.individual) {
      console.log('export INDIVIDUAL_SCHEDULE_ID=' + shSingleQuoted(payload.individual.scheduleId));
      console.log('export WEBHOOK_TEST_INDIVIDUAL_NAME=' + shSingleQuoted(payload.individual.memberName));
      if (payload.individual.planChargeAmount != null && !Number.isNaN(payload.individual.planChargeAmount)) {
        console.log(
          'export WEBHOOK_TEST_INDIVIDUAL_PLAN_PREMIUM_AMOUNT=' + shSingleQuoted(String(payload.individual.planChargeAmount))
        );
      }
    }
    if (payload.enrollment) {
      console.log('export ENROLLMENT_ID=' + shSingleQuoted(payload.enrollment.enrollmentId));
      console.log('export WEBHOOK_TEST_ENROLLMENT_MEMBER_NAME=' + shSingleQuoted(payload.enrollment.memberName));
      if (payload.enrollment.mockAmount != null && !Number.isNaN(payload.enrollment.mockAmount)) {
        console.log('export WEBHOOK_TEST_ENROLLMENT_PREMIUM_AMOUNT=' + shSingleQuoted(String(payload.enrollment.mockAmount)));
      }
      if (payload.enrollment.invoiceId) {
        console.log('export WEBHOOK_TEST_TEMPLATE_INVOICE_ID=' + shSingleQuoted(payload.enrollment.invoiceId));
      }
    }
    return;
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

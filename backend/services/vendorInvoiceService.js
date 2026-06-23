'use strict';

const XLSX = require('xlsx');

const { isArchiverAvailable, createZipArchive } = require('../utils/zipArchive');

const { getPool, sql } = require('../config/database');
const vendorImportTenants = require('./vendorImportTenants.service');

const PRODUCT_ENROLLMENT_FILTER = `(
  e.EnrollmentType = N'Product'
  OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)
)`;

function parseIsoDate(value, label) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${label} is required (YYYY-MM-DD)`);
  }
  const d = new Date(`${value.trim()}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${label} must be a valid date (YYYY-MM-DD)`);
  }
  return value.trim().slice(0, 10);
}

function validatePeriod(periodStart, periodEnd) {
  const start = parseIsoDate(periodStart, 'periodStart');
  const end = parseIsoDate(periodEnd, 'periodEnd');
  if (end < start) {
    throw new Error('periodEnd must be on or after periodStart');
  }
  return { periodStart: start, periodEnd: end };
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function tobaccoLabel(tobaccoUse) {
  return tobaccoUse === 'Y' ? 'Yes' : 'No';
}

function safeFilenamePart(name) {
  return String(name || 'tenant')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
}

/**
 * Active product enrollments for vendor external tenants in [periodStart, periodEnd].
 * periodEnd: effective on or before; periodStart: not terminated on or before start.
 */
async function fetchInvoiceEnrollmentLines(pool, vendorId, periodStart, periodEnd, tenantIdFilter = null) {
  const req = pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('periodStart', sql.Date, periodStart)
    .input('periodEnd', sql.Date, periodEnd);

  let tenantClause = '';
  if (tenantIdFilter) {
    req.input('tenantId', sql.UniqueIdentifier, tenantIdFilter);
    tenantClause = 'AND m.TenantId = @tenantId';
  }

  const r = await req.query(`
    WITH VendorProducts AS (
      SELECT p.ProductId, p.Name AS ProductName
      FROM oe.Products p
      WHERE p.VendorId = @vendorId
        AND p.Status NOT IN (N'Deleted')
        AND ISNULL(p.IsBundle, 0) = 0
    ),
    Lines AS (
      SELECT
        m.TenantId,
        t.Name AS TenantName,
        m.HouseholdMemberID AS MemberId,
        u.FirstName,
        u.LastName,
        e.EffectiveDate,
        e.TerminationDate,
        vp.ProductName,
        pp.TierType AS Tier,
        LTRIM(RTRIM(REPLACE(REPLACE(CAST(pp.ConfigValue1 AS NVARCHAR(32)), N'$', N''), N',', N''))) AS UA,
        pp.NetRate,
        e.ProductPricingId,
        m.TobaccoUse
      FROM oe.Enrollments e
      INNER JOIN VendorProducts vp ON vp.ProductId = e.ProductId
      INNER JOIN oe.Members m ON m.MemberId = e.MemberId
      INNER JOIN oe.Users u ON u.UserId = m.UserId
      INNER JOIN oe.Tenants t ON t.TenantId = m.TenantId
      LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
      WHERE ISNULL(t.IsExternal, 0) = 1
        AND e.Status = N'Active'
        AND ISNULL(e.IsPendingMigration, 0) = 0
        AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
        AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) > @periodStart)
        AND ${PRODUCT_ENROLLMENT_FILTER}
        ${tenantClause}

      UNION ALL

      SELECT
        m.TenantId,
        t.Name AS TenantName,
        m.HouseholdMemberID AS MemberId,
        u.FirstName,
        u.LastName,
        e.EffectiveDate,
        e.TerminationDate,
        vp.ProductName,
        pp.TierType AS Tier,
        LTRIM(RTRIM(REPLACE(REPLACE(CAST(pp.ConfigValue1 AS NVARCHAR(32)), N'$', N''), N',', N''))) AS UA,
        pp.NetRate,
        e.ProductPricingId,
        m.TobaccoUse
      FROM oe.Enrollments e
      INNER JOIN oe.Products bundle ON bundle.ProductId = e.ProductId AND ISNULL(bundle.IsBundle, 0) = 1
      INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = e.ProductId
      INNER JOIN VendorProducts vp ON vp.ProductId = pb.IncludedProductId
      INNER JOIN oe.Members m ON m.MemberId = e.MemberId
      INNER JOIN oe.Users u ON u.UserId = m.UserId
      INNER JOIN oe.Tenants t ON t.TenantId = m.TenantId
      LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
      WHERE ISNULL(t.IsExternal, 0) = 1
        AND e.Status = N'Active'
        AND ISNULL(e.IsPendingMigration, 0) = 0
        AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
        AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) > @periodStart)
        AND ${PRODUCT_ENROLLMENT_FILTER}
        ${tenantClause}
    )
    SELECT * FROM Lines
    ORDER BY TenantName, LastName, FirstName, ProductName
  `);

  return r.recordset || [];
}

/**
 * Active vendor-product enrollments per external tenant (no period effective-date filter).
 * Used to warn when historical periods exclude members imported with future EffectiveDate.
 */
async function fetchActiveRosterStats(pool, vendorId) {
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      WITH VendorProducts AS (
        SELECT p.ProductId
        FROM oe.Products p
        WHERE p.VendorId = @vendorId
          AND p.Status NOT IN (N'Deleted')
          AND ISNULL(p.IsBundle, 0) = 0
      ),
      Roster AS (
        SELECT m.TenantId, pp.NetRate, e.ProductPricingId
        FROM oe.Enrollments e
        INNER JOIN VendorProducts vp ON vp.ProductId = e.ProductId
        INNER JOIN oe.Members m ON m.MemberId = e.MemberId
        INNER JOIN oe.Tenants t ON t.TenantId = m.TenantId
        LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
        WHERE ISNULL(t.IsExternal, 0) = 1
          AND e.Status = N'Active'
          AND ISNULL(e.IsPendingMigration, 0) = 0
          AND ${PRODUCT_ENROLLMENT_FILTER}

        UNION ALL

        SELECT m.TenantId, pp.NetRate, e.ProductPricingId
        FROM oe.Enrollments e
        INNER JOIN oe.Products bundle ON bundle.ProductId = e.ProductId AND ISNULL(bundle.IsBundle, 0) = 1
        INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = e.ProductId
        INNER JOIN VendorProducts vp ON vp.ProductId = pb.IncludedProductId
        INNER JOIN oe.Members m ON m.MemberId = e.MemberId
        INNER JOIN oe.Tenants t ON t.TenantId = m.TenantId
        LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
        WHERE ISNULL(t.IsExternal, 0) = 1
          AND e.Status = N'Active'
          AND ISNULL(e.IsPendingMigration, 0) = 0
          AND ${PRODUCT_ENROLLMENT_FILTER}
      )
      SELECT
        TenantId,
        COUNT(*) AS activeLineCount,
        SUM(CASE WHEN ProductPricingId IS NULL THEN 0 ELSE ISNULL(NetRate, 0) END) AS activeRosterAmount
      FROM Roster
      GROUP BY TenantId
    `);

  const map = new Map();
  for (const row of r.recordset || []) {
    map.set(String(row.TenantId), {
      activeLineCount: Number(row.activeLineCount) || 0,
      activeRosterAmount: roundMoney(row.activeRosterAmount),
    });
  }
  return map;
}

function mapRawRow(row) {
  const netRate = row.NetRate != null ? roundMoney(row.NetRate) : null;
  const excluded = !row.ProductPricingId;
  const zeroRate = !excluded && (netRate == null || netRate === 0);
  const billable = !excluded;
  const total = billable ? (netRate || 0) : 0;

  return {
    tenantId: String(row.TenantId),
    tenantName: row.TenantName || '',
    memberId: row.MemberId || '',
    firstName: row.FirstName || '',
    lastName: row.LastName || '',
    effectiveDate: row.EffectiveDate
      ? new Date(row.EffectiveDate).toISOString().slice(0, 10)
      : '',
    terminationDate: row.TerminationDate
      ? new Date(row.TerminationDate).toISOString().slice(0, 10)
      : '',
    productName: row.ProductName || '',
    tier: row.Tier || '',
    ua: row.UA || '',
    netRate: netRate ?? 0,
    tobacco: tobaccoLabel(row.TobaccoUse),
    total,
    excluded,
    zeroRate,
  };
}

function buildWarnings(rows, excludedCount, zeroRateCount) {
  const warnings = [];
  if (excludedCount > 0) {
    warnings.push(
      `${excludedCount} enrollment(s) excluded (no ProductPricingId on file).`
    );
  }
  if (zeroRateCount > 0) {
    warnings.push(
      `${zeroRateCount} enrollment(s) have NetRate $0 — included at $0.`
    );
  }
  return warnings;
}

function aggregateTenants(rows, eligibleTenants, rosterByTenant = new Map()) {
  const byTenant = new Map();
  for (const row of rows) {
    if (row.excluded) continue;
    const key = row.tenantId;
    if (!byTenant.has(key)) {
      byTenant.set(key, { tenantId: key, tenantName: row.tenantName, expectedAmount: 0, lineCount: 0 });
    }
    const t = byTenant.get(key);
    t.expectedAmount = roundMoney(t.expectedAmount + row.total);
    t.lineCount += 1;
  }

  const external = eligibleTenants.filter((t) => t.isExternal);
  const tenants = external.map((t) => {
    const agg = byTenant.get(t.tenantId);
    const roster = rosterByTenant.get(t.tenantId);
    const activeLineCount = roster?.activeLineCount ?? 0;
    const activeRosterAmount = roster?.activeRosterAmount ?? 0;
    const lineCount = agg ? agg.lineCount : 0;
    const excludedByEffectiveDate = Math.max(0, activeLineCount - lineCount);
    return {
      tenantId: t.tenantId,
      tenantName: t.tenantName,
      isExternal: true,
      expectedAmount: agg ? agg.expectedAmount : 0,
      lineCount,
      activeLineCount,
      activeRosterAmount,
      excludedByEffectiveDate,
    };
  });

  return {
    tenants,
    excludedEffectiveAfterPeriodEnd: tenants.reduce((s, t) => s + t.excludedByEffectiveDate, 0),
  };
}

async function getVendorIdForUser(pool, userId) {
  const r = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query('SELECT VendorId FROM oe.Users WHERE UserId = @userId');
  return r.recordset?.[0]?.VendorId || null;
}

async function buildPreview(vendorId, periodStart, periodEnd) {
  const pool = await getPool();
  const eligible = await vendorImportTenants.getImportEligibleTenantsForVendor(vendorId);
  const [raw, rosterByTenant] = await Promise.all([
    fetchInvoiceEnrollmentLines(pool, vendorId, periodStart, periodEnd),
    fetchActiveRosterStats(pool, vendorId),
  ]);
  const rows = raw.map(mapRawRow);
  const billable = rows.filter((r) => !r.excluded);
  const excludedCount = rows.length - billable.length;
  const zeroRateCount = billable.filter((r) => r.zeroRate).length;
  const { tenants } = aggregateTenants(rows, eligible, rosterByTenant);
  const grandTotal = roundMoney(tenants.reduce((s, t) => s + t.expectedAmount, 0));

  const warnings = buildWarnings(rows, excludedCount, zeroRateCount);

  return {
    periodStart,
    periodEnd,
    tenants,
    summary: {
      tenantCount: tenants.length,
      lineCount: billable.length,
      grandTotal,
    },
    warnings,
    lines: billable,
  };
}

function buildTenantWorkbook(rows, tenantName, periodStart, periodEnd) {
  const headers = [
    'Member ID',
    'First Name',
    'Last Name',
    'Effective Date',
    'Termination Date',
    'Tier',
    'UA',
    'Product',
    'Net Rate',
    'Tobacco',
    'Total',
  ];
  const data = rows.map((r) => [
    r.memberId,
    r.firstName,
    r.lastName,
    r.effectiveDate,
    r.terminationDate,
    r.tier,
    r.ua,
    r.productName,
    r.netRate,
    r.tobacco,
    r.total,
  ]);
  const total = roundMoney(rows.reduce((s, r) => s + r.total, 0));
  data.push([]);
  data.push(['', '', '', '', '', '', '', 'Grand Total:', '', '', total]);

  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Invoice');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const safeName = safeFilenamePart(tenantName);
  const filename = `${safeName}_Invoice_${periodStart}_thru_${periodEnd}.xlsx`;
  return { buffer: buf, filename, total };
}

async function buildGenerateZip(vendorId, periodStart, periodEnd, tenantIds) {
  if (!isArchiverAvailable()) {
    throw new Error('ZIP support requires the archiver package (npm install archiver in backend/)');
  }
  if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
    throw new Error('Select at least one tenant');
  }

  const pool = await getPool();
  const preview = await buildPreview(vendorId, periodStart, periodEnd);
  const previewByTenant = new Map(preview.tenants.map((t) => [t.tenantId, t]));

  for (const id of tenantIds) {
    await vendorImportTenants.assertTenantEligibleForVendorImport(vendorId, id);
  }

  const warnings = [...preview.warnings];
  const mismatchTenants = [];
  const files = [];

  for (const tenantId of tenantIds) {
    const raw = await fetchInvoiceEnrollmentLines(pool, vendorId, periodStart, periodEnd, tenantId);
    const lines = raw.map(mapRawRow).filter((r) => !r.excluded);
    const tenantName = lines[0]?.tenantName
      || preview.tenants.find((t) => t.tenantId === tenantId)?.tenantName
      || tenantId;
    const { buffer, filename, total } = buildTenantWorkbook(lines, tenantName, periodStart, periodEnd);
    const expected = previewByTenant.get(tenantId)?.expectedAmount ?? 0;
    if (roundMoney(total) !== roundMoney(expected)) {
      mismatchTenants.push({
        tenantId,
        tenantName,
        previewTotal: expected,
        fileTotal: total,
      });
    }
    files.push({ filename, buffer });
  }

  if (mismatchTenants.length > 0) {
    warnings.push(
      ...mismatchTenants.map(
        (m) =>
          `${m.tenantName}: preview $${m.previewTotal.toFixed(2)} vs file $${m.fileTotal.toFixed(2)}`
      )
    );
  }

  const zipBuffer = await new Promise((resolve, reject) => {
    const archive = createZipArchive({ zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const f of files) {
      archive.append(f.buffer, { name: f.filename });
    }
    if (warnings.length) {
      archive.append(JSON.stringify({ warnings, mismatchTenants }, null, 2), {
        name: 'warnings.json',
      });
    }
    archive.finalize();
  });

  const zipName = `vendor_invoices_${periodStart}_thru_${periodEnd}.zip`;
  return { zipBuffer, zipName, warnings, mismatchTenants };
}

module.exports = {
  parseIsoDate,
  validatePeriod,
  getVendorIdForUser,
  buildPreview,
  buildGenerateZip,
  fetchInvoiceEnrollmentLines,
  fetchActiveRosterStats,
  mapRawRow,
  roundMoney,
};

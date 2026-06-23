'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool, sql, rawSql } = require('../config/database');
const TenantIdentificationService = require('./tenantIdentification.service');
const { MEMBER_STATS_PREMIUM_ENROLLMENT_WHERE_SQL } = require('../utils/memberEnrollmentStatusSql');

const DEFAULT_SYSTEM_FEES = JSON.stringify({
  platformFee: {
    name: 'Platform Fee',
    amount: 3.5,
    type: 'fixed',
    description: 'Platform usage and maintenance fee',
    enabled: true,
  },
  mobileAppFee: {
    name: 'Mobile App Fee',
    amount: 2.5,
    type: 'fixed',
    description: 'Mobile application access fee',
    enabled: false,
  },
  aiAssistantFee: {
    name: 'AI Assistant Fee',
    amount: 1.5,
    type: 'fixed',
    description: 'AI-powered assistant and automation fee',
    enabled: false,
  },
});

/** Non-bundle catalog products owned by this vendor. */
const VENDOR_PRODUCTS_CTE = `
  VendorProducts AS (
    SELECT p.ProductId, p.Name AS ProductName, p.ProductOwnerId
    FROM oe.Products p
    WHERE p.VendorId = @vendorId
      AND p.Status NOT IN (N'Deleted')
      AND ISNULL(p.IsBundle, 0) = 0
  )`;

const VENDOR_PRODUCTS_ID_CTE = `
  VendorProducts AS (
    SELECT p.ProductId
    FROM oe.Products p
    WHERE p.VendorId = @vendorId
      AND p.Status NOT IN (N'Deleted')
      AND ISNULL(p.IsBundle, 0) = 0
  )`;

const ACTIVE_TENANT_SUBSCRIPTION_WHERE = `(tps.SubscriptionStatus IS NULL OR tps.SubscriptionStatus <> N'Cancelled')`;

const TENANT_PRODUCT_LINKS_CTE = `
  TenantProductLinks AS (
    SELECT vp.ProductId, vp.ProductName, tps.TenantId, N'subscription' AS LinkType
    FROM oe.TenantProductSubscriptions tps
    INNER JOIN VendorProducts vp ON vp.ProductId = tps.ProductId
    WHERE ${ACTIVE_TENANT_SUBSCRIPTION_WHERE}
    UNION
    SELECT vp.ProductId, vp.ProductName, tps.TenantId, N'subscription' AS LinkType
    FROM oe.TenantProductSubscriptions tps
    INNER JOIN oe.Products bundle ON bundle.ProductId = tps.ProductId AND ISNULL(bundle.IsBundle, 0) = 1
    INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = tps.ProductId
    INNER JOIN VendorProducts vp ON vp.ProductId = pb.IncludedProductId
    WHERE ${ACTIVE_TENANT_SUBSCRIPTION_WHERE}
    UNION
    SELECT vp.ProductId, vp.ProductName, COALESCE(g.TenantId, m.TenantId) AS TenantId, N'enrollment' AS LinkType
    FROM oe.Enrollments e
    INNER JOIN VendorProducts vp ON e.ProductId = vp.ProductId
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
    WHERE COALESCE(g.TenantId, m.TenantId) IS NOT NULL
      AND e.Status = N'Active'
      AND ISNULL(e.IsPendingMigration, 0) = 0
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
    UNION
    SELECT vp.ProductId, vp.ProductName, COALESCE(g.TenantId, m.TenantId) AS TenantId, N'enrollment' AS LinkType
    FROM oe.Enrollments e
    INNER JOIN oe.Products bundle ON bundle.ProductId = e.ProductId AND ISNULL(bundle.IsBundle, 0) = 1
    INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = e.ProductId
    INNER JOIN VendorProducts vp ON vp.ProductId = pb.IncludedProductId
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
    WHERE COALESCE(g.TenantId, m.TenantId) IS NOT NULL
      AND e.Status = N'Active'
      AND ISNULL(e.IsPendingMigration, 0) = 0
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
  )`;

const ENROLLMENT_VENDOR_PRODUCT_ROWS_CTE = `
  EnrollmentVendorProductRows AS (
    SELECT
      COALESCE(g.TenantId, m.TenantId) AS TenantId,
      vp.ProductId,
      m.HouseholdId,
      m.GroupId
    FROM oe.Enrollments e
    INNER JOIN VendorProducts vp ON e.ProductId = vp.ProductId
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
    WHERE COALESCE(g.TenantId, m.TenantId) IS NOT NULL
      AND ${MEMBER_STATS_PREMIUM_ENROLLMENT_WHERE_SQL}
    UNION
    SELECT
      COALESCE(g.TenantId, m.TenantId) AS TenantId,
      vp.ProductId,
      m.HouseholdId,
      m.GroupId
    FROM oe.Enrollments e
    INNER JOIN oe.Products bundle ON bundle.ProductId = e.ProductId AND ISNULL(bundle.IsBundle, 0) = 1
    INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = e.ProductId
    INNER JOIN VendorProducts vp ON vp.ProductId = pb.IncludedProductId
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
    WHERE COALESCE(g.TenantId, m.TenantId) IS NOT NULL
      AND ${MEMBER_STATS_PREMIUM_ENROLLMENT_WHERE_SQL}
  )`;

const IS_SUBSCRIBED_CASE_SQL = `
  CASE
    WHEN EXISTS (
      SELECT 1 FROM oe.TenantProductSubscriptions tps
      WHERE tps.TenantId = pt.TenantId AND tps.ProductId = dtp.ProductId
        AND ${ACTIVE_TENANT_SUBSCRIPTION_WHERE}
    ) OR EXISTS (
      SELECT 1 FROM oe.TenantProductSubscriptions tps
      INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = tps.ProductId
      WHERE tps.TenantId = pt.TenantId
        AND pb.IncludedProductId = dtp.ProductId
        AND ${ACTIVE_TENANT_SUBSCRIPTION_WHERE}
    ) THEN 1 ELSE 0
  END AS IsSubscribed`;

const ELIGIBLE_TENANT_LINKS_CTE = `
  EligibleTenantLinks AS (
    SELECT DISTINCT tps.TenantId
    FROM oe.TenantProductSubscriptions tps
    INNER JOIN VendorProducts vp ON vp.ProductId = tps.ProductId
    WHERE tps.TenantId IS NOT NULL
      AND ${ACTIVE_TENANT_SUBSCRIPTION_WHERE}
    UNION
    SELECT DISTINCT tps.TenantId
    FROM oe.TenantProductSubscriptions tps
    INNER JOIN oe.Products bundle ON bundle.ProductId = tps.ProductId AND ISNULL(bundle.IsBundle, 0) = 1
    INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = tps.ProductId
    INNER JOIN VendorProducts vp ON vp.ProductId = pb.IncludedProductId
    WHERE tps.TenantId IS NOT NULL
      AND ${ACTIVE_TENANT_SUBSCRIPTION_WHERE}
    UNION
    SELECT DISTINCT COALESCE(g.TenantId, m.TenantId) AS TenantId
    FROM oe.Enrollments e
    INNER JOIN VendorProducts vp ON e.ProductId = vp.ProductId
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
    WHERE COALESCE(g.TenantId, m.TenantId) IS NOT NULL
      AND ${MEMBER_STATS_PREMIUM_ENROLLMENT_WHERE_SQL}
    UNION
    SELECT DISTINCT COALESCE(g.TenantId, m.TenantId) AS TenantId
    FROM oe.Enrollments e
    INNER JOIN oe.Products bundle ON bundle.ProductId = e.ProductId AND ISNULL(bundle.IsBundle, 0) = 1
    INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = e.ProductId
    INNER JOIN VendorProducts vp ON vp.ProductId = pb.IncludedProductId
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
    WHERE COALESCE(g.TenantId, m.TenantId) IS NOT NULL
      AND ${MEMBER_STATS_PREMIUM_ENROLLMENT_WHERE_SQL}
  )`;

function normalizeTenantDirectoryQuery(options = {}) {
  const search = String(options.search ?? options.q ?? '').trim();
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit ?? options.pageSize, 10) || 25));
  const offset = (page - 1) * limit;
  const searchPattern = search
    ? `%${search.replace(/[%_\[]/g, (char) => `[${char}]`)}%`
    : null;
  return { search, page, limit, offset, searchPattern };
}

function aggregateTenantDirectoryRows(recordset) {
  let total = 0;
  const byTenant = new Map();
  for (const row of recordset || []) {
    if (!total && row.TotalCount != null) total = row.TotalCount;
    if (!byTenant.has(row.TenantId)) {
      byTenant.set(row.TenantId, {
        tenantId: row.TenantId,
        tenantName: row.TenantName || '',
        isExternal: row.IsExternal === true || row.IsExternal === 1,
        products: [],
      });
    }
    const tenant = byTenant.get(row.TenantId);
    const relationships = [];
    if (row.IsOwner) relationships.push('owner');
    if (row.IsSubscribed) relationships.push('subscription');
    if (row.HasEnrollment) relationships.push('enrollment');
    tenant.products.push({
      productId: row.ProductId,
      productName: row.ProductName || '',
      relationships,
      stats: {
        householdCount: row.HouseholdCount || 0,
        groupCount: row.GroupCount || 0,
      },
    });
  }
  return { tenants: [...byTenant.values()], total };
}

/**
 * Tenants with subscription or enrollment on this vendor's products (not full tenant catalog).
 */
async function getTenantDirectoryForVendor(vendorId, options = {}) {
  const { page, limit, offset, searchPattern } = normalizeTenantDirectoryQuery(options);
  const pool = await getPool();
  const req = pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('offset', sql.Int, offset)
    .input('limit', sql.Int, limit);

  const searchFilter = searchPattern
    ? `AND (
        t.Name LIKE @searchPattern
        OR EXISTS (
          SELECT 1
          FROM DistinctTenantProducts dtpSearch
          WHERE dtpSearch.TenantId = t.TenantId
            AND dtpSearch.ProductName LIKE @searchPattern
        )
      )`
    : '';

  if (searchPattern) {
    req.input('searchPattern', sql.NVarChar, searchPattern);
  }

  const r = await req.query(`
      WITH ${VENDOR_PRODUCTS_CTE},
      ${TENANT_PRODUCT_LINKS_CTE},
      DistinctTenantProducts AS (
        SELECT DISTINCT tpl.TenantId, tpl.ProductId, tpl.ProductName
        FROM TenantProductLinks tpl
        INNER JOIN VendorProducts vp ON vp.ProductId = tpl.ProductId
        WHERE tpl.TenantId IS NOT NULL
      ),
      ${ENROLLMENT_VENDOR_PRODUCT_ROWS_CTE},
      EnrollmentStats AS (
        SELECT
          evpr.TenantId,
          evpr.ProductId,
          COUNT(DISTINCT CASE WHEN evpr.HouseholdId IS NOT NULL THEN evpr.HouseholdId END) AS HouseholdCount,
          COUNT(DISTINCT CASE WHEN evpr.GroupId IS NOT NULL THEN evpr.GroupId END) AS GroupCount
        FROM EnrollmentVendorProductRows evpr
        GROUP BY evpr.TenantId, evpr.ProductId
      ),
      FilteredTenants AS (
        SELECT DISTINCT
          t.TenantId,
          t.Name AS TenantName,
          ISNULL(t.IsExternal, 0) AS IsExternal
        FROM DistinctTenantProducts dtp
        INNER JOIN oe.Tenants t ON t.TenantId = dtp.TenantId
        WHERE 1 = 1
          ${searchFilter}
      ),
      PaginatedTenants AS (
        SELECT
          TenantId,
          TenantName,
          IsExternal,
          COUNT(*) OVER() AS TotalCount,
          ROW_NUMBER() OVER (ORDER BY TenantName) AS RowNum
        FROM FilteredTenants
      )
      SELECT
        pt.TenantId,
        pt.TenantName,
        pt.IsExternal,
        pt.TotalCount,
        dtp.ProductId,
        dtp.ProductName,
        ISNULL(es.HouseholdCount, 0) AS HouseholdCount,
        ISNULL(es.GroupCount, 0) AS GroupCount,
        CASE
          WHEN vp.ProductOwnerId = pt.TenantId THEN 1 ELSE 0
        END AS IsOwner,
        ${IS_SUBSCRIBED_CASE_SQL},
        CASE
          WHEN EXISTS (
            SELECT 1 FROM TenantProductLinks tpl
            WHERE tpl.TenantId = pt.TenantId AND tpl.ProductId = dtp.ProductId AND tpl.LinkType = N'enrollment'
          ) THEN 1 ELSE 0
        END AS HasEnrollment
      FROM PaginatedTenants pt
      INNER JOIN DistinctTenantProducts dtp ON dtp.TenantId = pt.TenantId
      INNER JOIN VendorProducts vp ON vp.ProductId = dtp.ProductId
      LEFT JOIN EnrollmentStats es ON es.TenantId = dtp.TenantId AND es.ProductId = dtp.ProductId
      WHERE pt.RowNum > @offset AND pt.RowNum <= @offset + @limit
      ORDER BY pt.RowNum, dtp.ProductName
    `);

  const { tenants, total } = aggregateTenantDirectoryRows(r.recordset);

  return {
    data: tenants,
    pagination: {
      page,
      limit,
      total,
      totalPages: total ? Math.ceil(total / limit) : 0,
    },
  };
}

async function assertVendorOwnsProducts(pool, vendorId, productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    throw new Error('Select at least one product for this tenant');
  }

  const req = pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId);
  productIds.forEach((id, i) => req.input(`pid${i}`, sql.UniqueIdentifier, id));

  const inList = productIds.map((_, i) => `@pid${i}`).join(', ');
  const r = await req.query(`
    SELECT ProductId, Name, IsBundle
    FROM oe.Products
    WHERE VendorId = @vendorId
      AND Status NOT IN (N'Deleted')
      AND ISNULL(IsBundle, 0) = 0
      AND ProductId IN (${inList})
  `);

  if (r.recordset.length !== productIds.length) {
    throw new Error('One or more selected products are invalid or not owned by this vendor');
  }

  return r.recordset;
}

async function createActiveSubscription(transaction, { tenantId, productId, userId, systemFees }) {
  const subscriptionId = uuidv4();
  const now = new Date();
  const req = transaction.request();
  req.input('subscriptionId', sql.UniqueIdentifier, subscriptionId);
  req.input('tenantId', sql.UniqueIdentifier, tenantId);
  req.input('productId', sql.UniqueIdentifier, productId);
  req.input('subscriptionStatus', sql.NVarChar(50), 'Active');
  req.input('tenantRate', sql.Decimal(19, 4), 0);
  req.input('systemFeesSnapshot', sql.NVarChar, systemFees);
  req.input('createdBy', sql.UniqueIdentifier, userId);
  req.input('modifiedBy', sql.UniqueIdentifier, userId);
  req.input('subscriptionDate', sql.DateTime2, now);
  req.input('modifiedDate', sql.DateTime2, now);
  req.input('isConfigured', sql.Bit, 0);

  await req.query(`
    INSERT INTO oe.TenantProductSubscriptions (
      SubscriptionId, TenantId, ProductId, SubscriptionStatus, TenantRate, SystemFeesSnapshot,
      CreatedBy, ModifiedBy, SubscriptionDate, ModifiedDate, IsConfigured
    ) VALUES (
      @subscriptionId, @tenantId, @productId, @subscriptionStatus, @tenantRate, @systemFeesSnapshot,
      @createdBy, @modifiedBy, @subscriptionDate, @modifiedDate, @isConfigured
    )
  `);
}

/**
 * Vendor-scoped tenant create: external tenant + active product subscriptions.
 */
async function createVendorTenant({ vendorId, userId, body }) {
  const {
    name,
    contactEmail,
    contactPhone,
    primaryAddress,
    primaryCity,
    primaryState,
    primaryZip,
    defaultUrlPath,
    isExternal = true,
    productIds,
    timeZone = 'America/New_York',
  } = body || {};

  if (!name || !String(name).trim()) throw new Error('Tenant name is required');
  if (!contactEmail || !String(contactEmail).trim()) throw new Error('Contact email is required');
  if (!defaultUrlPath || !String(defaultUrlPath).trim()) throw new Error('URL path is required');

  const normalizedProductIds = [...new Set((productIds || []).filter(Boolean))];
  const pool = await getPool();
  await assertVendorOwnsProducts(pool, vendorId, normalizedProductIds);

  const urlPath = String(defaultUrlPath).trim().toLowerCase();
  const available = await TenantIdentificationService.isUrlPathAvailable(urlPath, null);
  if (!available) throw new Error('URL path is not available');

  const tenantId = uuidv4();
  const transaction = new rawSql.Transaction(pool);
  await transaction.begin();

  try {
    const insertReq = transaction.request();
    insertReq.input('tenantId', sql.UniqueIdentifier, tenantId);
    insertReq.input('name', sql.NVarChar(100), String(name).trim());
    insertReq.input('contactEmail', sql.NVarChar(255), String(contactEmail).trim());
    insertReq.input('contactPhone', sql.NVarChar(20), contactPhone?.trim() || null);
    insertReq.input('primaryAddress', sql.NVarChar(255), primaryAddress?.trim() || null);
    insertReq.input('primaryCity', sql.NVarChar(100), primaryCity?.trim() || null);
    insertReq.input('primaryState', sql.NVarChar(2), primaryState?.trim() || null);
    insertReq.input('primaryZip', sql.NVarChar(10), primaryZip?.trim() || null);
    insertReq.input('timeZone', sql.NVarChar(50), timeZone || 'America/New_York');
    insertReq.input('defaultUrlPath', sql.NVarChar(100), urlPath);
    insertReq.input('status', sql.NVarChar(20), 'Active');
    insertReq.input('systemFees', sql.NVarChar(sql.MAX), DEFAULT_SYSTEM_FEES);
    insertReq.input('createdBy', sql.UniqueIdentifier, userId);
    insertReq.input('isExternal', sql.Bit, isExternal ? 1 : 0);

    try {
      await insertReq.query(`
        INSERT INTO oe.Tenants (
          TenantId, Name, Status, ContactEmail, ContactPhone,
          PrimaryAddress, PrimaryCity, PrimaryState, PrimaryZip,
          TimeZone, DefaultUrlPath, SystemFees, IsExternal,
          CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
        ) VALUES (
          @tenantId, @name, @status, @contactEmail, @contactPhone,
          @primaryAddress, @primaryCity, @primaryState, @primaryZip,
          @timeZone, @defaultUrlPath, @systemFees, @isExternal,
          GETDATE(), GETDATE(), @createdBy, @createdBy
        )
      `);
    } catch (colErr) {
      const msg = (colErr?.message || '').toLowerCase();
      if (msg.includes('isexternal')) {
        await transaction.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('name', sql.NVarChar(100), String(name).trim())
          .input('contactEmail', sql.NVarChar(255), String(contactEmail).trim())
          .input('contactPhone', sql.NVarChar(20), contactPhone?.trim() || null)
          .input('primaryAddress', sql.NVarChar(255), primaryAddress?.trim() || null)
          .input('primaryCity', sql.NVarChar(100), primaryCity?.trim() || null)
          .input('primaryState', sql.NVarChar(2), primaryState?.trim() || null)
          .input('primaryZip', sql.NVarChar(10), primaryZip?.trim() || null)
          .input('timeZone', sql.NVarChar(50), timeZone || 'America/New_York')
          .input('defaultUrlPath', sql.NVarChar(100), urlPath)
          .input('status', sql.NVarChar(20), 'Active')
          .input('systemFees', sql.NVarChar(sql.MAX), DEFAULT_SYSTEM_FEES)
          .input('createdBy', sql.UniqueIdentifier, userId)
          .query(`
            INSERT INTO oe.Tenants (
              TenantId, Name, Status, ContactEmail, ContactPhone,
              PrimaryAddress, PrimaryCity, PrimaryState, PrimaryZip,
              TimeZone, DefaultUrlPath, SystemFees,
              CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
            ) VALUES (
              @tenantId, @name, @status, @contactEmail, @contactPhone,
              @primaryAddress, @primaryCity, @primaryState, @primaryZip,
              @timeZone, @defaultUrlPath, @systemFees,
              GETDATE(), GETDATE(), @createdBy, @createdBy
            )
          `);
      } else {
        throw colErr;
      }
    }

    for (const productId of normalizedProductIds) {
      await createActiveSubscription(transaction, {
        tenantId,
        productId,
        userId,
        systemFees: DEFAULT_SYSTEM_FEES,
      });
    }

    await transaction.commit();

    return {
      tenantId,
      tenantName: String(name).trim(),
      isExternal: !!isExternal,
      productIds: normalizedProductIds,
    };
  } catch (err) {
    try {
      await transaction.rollback();
    } catch (_) {
      /* ignore rollback errors */
    }
    throw err;
  }
}

/**
 * Tenants eligible for eligibility import: active subscription or enrollment on vendor products.
 */
async function getImportEligibleTenantsForVendor(vendorId) {
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      WITH ${VENDOR_PRODUCTS_ID_CTE},
      ${ELIGIBLE_TENANT_LINKS_CTE}
      SELECT
        t.TenantId,
        t.Name AS TenantName,
        t.Status AS TenantStatus,
        ISNULL(t.IsExternal, 0) AS IsExternal
      FROM EligibleTenantLinks x
      INNER JOIN oe.Tenants t ON t.TenantId = x.TenantId
      ORDER BY t.Name
    `);

  return (r.recordset || []).map((row) => ({
    tenantId: row.TenantId,
    tenantName: row.TenantName || '',
    tenantStatus: row.TenantStatus || 'Active',
    isExternal: row.IsExternal === true || row.IsExternal === 1,
  }));
}

async function assertTenantEligibleForVendorImport(vendorId, tenantId) {
  if (!tenantId) throw new Error('Tenant is required');
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      WITH ${VENDOR_PRODUCTS_ID_CTE},
      ${ELIGIBLE_TENANT_LINKS_CTE}
      SELECT TOP 1 1 AS ok
      FROM EligibleTenantLinks x
      WHERE x.TenantId = @tenantId
    `);

  if (!(r.recordset || []).length) {
    throw new Error(
      'Tenant is not eligible for import. They must have an active subscription or enrollment on at least one of your vendor products.'
    );
  }
}

module.exports = {
  getTenantDirectoryForVendor,
  getImportEligibleTenantsForVendor,
  assertTenantEligibleForVendorImport,
  createVendorTenant,
  assertVendorOwnsProducts,
  normalizeTenantDirectoryQuery,
  aggregateTenantDirectoryRows,
};

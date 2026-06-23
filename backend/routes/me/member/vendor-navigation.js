const express = require('express');
const router = express.Router();
const { getEffectiveUserId } = require('../../../middleware/attachMemberHouseholdContext');
const { getPool, sql } = require('../../../config/database');

const parseVisibilityRule = (rule) => {
  if (!rule) {
    return null;
  }

  if (typeof rule === 'object') {
    return rule;
  }

  try {
    return JSON.parse(rule);
  } catch (error) {
    console.warn('⚠️ Failed to parse visibility rule JSON:', error.message);
    return null;
  }
};

const passesVisibilityRule = (rule, context) => {
  if (!rule) {
    return true;
  }

  const {
    activeVendorEnrollments,
    activeProductIds,
    activeProductPricingIds,
    activeBundleIds,
    activeProductTypes
  } = context;

  const hasActiveEnrollment = activeVendorEnrollments.length > 0;

  if (rule.requiresActiveEnrollment && !hasActiveEnrollment) {
    return false;
  }

  if (Array.isArray(rule.productIds) && rule.productIds.length > 0) {
    const intersects = rule.productIds.some((id) => activeProductIds.has(id.toLowerCase()));
    if (!intersects) {
      return false;
    }
  }

  if (Array.isArray(rule.productPricingIds) && rule.productPricingIds.length > 0) {
    const intersects = rule.productPricingIds.some((id) => activeProductPricingIds.has(id.toLowerCase()));
    if (!intersects) {
      return false;
    }
  }

  if (Array.isArray(rule.bundleProductIds) && rule.bundleProductIds.length > 0) {
    const intersects = rule.bundleProductIds.some((id) => activeBundleIds.has(id.toLowerCase()));
    if (!intersects) {
      return false;
    }
  }

  if (Array.isArray(rule.productTypes) && rule.productTypes.length > 0) {
    const intersects = rule.productTypes.some((type) =>
      activeProductTypes.has(String(type).toLowerCase())
    );
    if (!intersects) {
      return false;
    }
  }

  if (rule.minStartDate) {
    const minDate = new Date(rule.minStartDate);
    if (!activeVendorEnrollments.some((enrollment) => {
      const effectiveDate = enrollment.EffectiveDate ? new Date(enrollment.EffectiveDate) : null;
      return effectiveDate && effectiveDate >= minDate;
    })) {
      return false;
    }
  }

  if (rule.maxStartDate) {
    const maxDate = new Date(rule.maxStartDate);
    if (!activeVendorEnrollments.some((enrollment) => {
      const effectiveDate = enrollment.EffectiveDate ? new Date(enrollment.EffectiveDate) : null;
      return effectiveDate && effectiveDate <= maxDate;
    })) {
      return false;
    }
  }

  return true;
};

router.get('/pages', async (req, res) => {
  try {
    const pool = await getPool();

    const memberRequest = pool.request();
    memberRequest.input('userId', sql.UniqueIdentifier, getEffectiveUserId(req));

    const memberResult = await memberRequest.query(`
      SELECT TOP 1 MemberId, TenantId
      FROM oe.Members
      WHERE UserId = @userId
    `);

    if (memberResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member record not found'
      });
    }

    const memberId = memberResult.recordset[0].MemberId;
    const tenantId = memberResult.recordset[0].TenantId;

    const enrollmentRequest = pool.request();
    enrollmentRequest.input('memberId', sql.UniqueIdentifier, memberId);

    const enrollmentResult = await enrollmentRequest.query(`
      SELECT
        e.EnrollmentId,
        e.ProductId,
        e.ProductPricingId,
        e.ProductBundleID,
        e.Status,
        e.EffectiveDate,
        e.TerminationDate,
        p.ProductType,
        v.VendorId,
        v.VendorName
      FROM oe.Enrollments e
      INNER JOIN oe.Products p ON e.ProductId = p.ProductId
      LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
      WHERE e.MemberId = @memberId
        AND e.Status IN ('Active', 'Pending', 'Approved')
    `);

    const activeEnrollments = enrollmentResult.recordset.filter((enrollment) => enrollment.VendorId);

    if (activeEnrollments.length === 0) {
      return res.json({
        success: true,
        data: []
      });
    }

    const vendorsMap = new Map();
    const activeProductIds = new Set();
    const activeProductPricingIds = new Set();
    const activeBundleIds = new Set();
    const activeProductTypes = new Set();

    activeEnrollments.forEach((enrollment) => {
      const vendorId = enrollment.VendorId;
      const vendorEntry = vendorsMap.get(vendorId) || {
        vendorId,
        vendorName: enrollment.VendorName,
        enrollments: []
      };

      vendorEntry.enrollments.push(enrollment);
      vendorsMap.set(vendorId, vendorEntry);

      if (enrollment.ProductId) {
        activeProductIds.add(String(enrollment.ProductId).toLowerCase());
      }

      if (enrollment.ProductPricingId) {
        activeProductPricingIds.add(String(enrollment.ProductPricingId).toLowerCase());
      }

      if (enrollment.ProductBundleID) {
        activeBundleIds.add(String(enrollment.ProductBundleID).toLowerCase());
      }

      if (enrollment.ProductType) {
        activeProductTypes.add(String(enrollment.ProductType).toLowerCase());
      }
    });

    const vendorIds = Array.from(vendorsMap.keys());

    if (vendorIds.length === 0) {
      return res.json({
        success: true,
        data: []
      });
    }

    const vendorRequest = pool.request();
    vendorRequest.input('tenantId', sql.UniqueIdentifier, tenantId || null);

    const vendorPlaceholders = vendorIds.map((vendorId, index) => {
      const paramName = `vendorId_${index}`;
      vendorRequest.input(paramName, sql.UniqueIdentifier, vendorId);
      return `@${paramName}`;
    }).join(', ');

    const vendorPagesResult = await vendorRequest.query(`
      SELECT
        VendorNavigationPageId,
        VendorId,
        TenantId,
        RouteKey,
        Label,
        [Description],
        IconName,
        ContentType,
        ContentRef,
        VisibilityRule,
        SortOrder,
        EffectiveDate,
        ExpirationDate,
        Published
      FROM oe.VendorNavigationPages
      WHERE VendorId IN (${vendorPlaceholders})
        AND Published = 1
        AND (EffectiveDate IS NULL OR EffectiveDate <= SYSUTCDATETIME())
        AND (ExpirationDate IS NULL OR ExpirationDate >= SYSUTCDATETIME())
        AND (TenantId IS NULL OR TenantId = @tenantId)
      ORDER BY VendorId, TenantId, SortOrder, Label
    `);

    const pagesByVendorRoute = new Map();

    vendorPagesResult.recordset.forEach((page) => {
      const key = `${page.VendorId}::${page.RouteKey}`;
      const existing = pagesByVendorRoute.get(key);

      if (!existing || (!existing.TenantId && page.TenantId)) {
        pagesByVendorRoute.set(key, page);
      }
    });

    const evaluatedPages = [];

    pagesByVendorRoute.forEach((page) => {
      const vendorContext = vendorsMap.get(page.VendorId);
      if (!vendorContext) {
        return;
      }

      const visibilityRule = parseVisibilityRule(page.VisibilityRule);
      const context = {
        activeVendorEnrollments: vendorContext.enrollments,
        activeProductIds,
        activeProductPricingIds,
        activeBundleIds,
        activeProductTypes
      };

      if (!passesVisibilityRule(visibilityRule, context)) {
        return;
      }

      evaluatedPages.push({
        vendorId: page.VendorId,
        vendorName: vendorContext.vendorName,
        routeKey: page.RouteKey,
        label: page.Label,
        description: page.Description,
        iconName: page.IconName,
        contentType: page.ContentType,
        contentRef: page.ContentRef,
        sortOrder: page.SortOrder,
        effectiveDate: page.EffectiveDate,
        expirationDate: page.ExpirationDate,
        tenantScoped: Boolean(page.TenantId),
        visibilityRule: visibilityRule || null
      });
    });

    evaluatedPages.sort((a, b) => {
      if (a.vendorId === b.vendorId) {
        return a.sortOrder - b.sortOrder || a.label.localeCompare(b.label);
      }

      const vendorIndexA = vendorIds.indexOf(a.vendorId);
      const vendorIndexB = vendorIds.indexOf(b.vendorId);
      return vendorIndexA - vendorIndexB;
    });

    const grouped = vendorsMapToResponse(vendorsMap, evaluatedPages);

    return res.json({
      success: true,
      data: grouped
    });
  } catch (error) {
    console.error('❌ Error fetching vendor navigation pages:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load vendor navigation pages'
    });
  }
});

const vendorsMapToResponse = (vendorsMap, pages) => {
  const results = [];

  vendorsMap.forEach((vendorEntry, vendorId) => {
    const vendorPages = pages.filter((page) => page.vendorId === vendorId);

    if (vendorPages.length === 0) {
      return;
    }

    results.push({
      vendorId,
      vendorName: vendorEntry.vendorName,
      pages: vendorPages
    });
  });

  return results;
};

module.exports = router;











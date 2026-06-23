// backend/services/commissionService.advances.js
// Commission Service for Advances, Chargebacks, and Refunds
// Uses the new oe.Commissions table structure

const { getPool, sql } = require('../config/database');
// Raw mssql module is needed to construct transaction-scoped Requests
// (`new mssql.Request(transaction)`). The `sql` export from config/database.js
// is a curated SqlTypes map and does NOT expose Request/Transaction constructors.
const mssql = require('mssql');
const CommissionCalculatorService = require('./CommissionCalculatorService');
const logger = require('../config/logger');

class CommissionService {
  static normalizeEnrollmentLookupWindow(paymentDate, billingPeriodStart = null, billingPeriodEnd = null) {
    const fallback = paymentDate ? new Date(paymentDate) : new Date();
    const start = billingPeriodStart ? new Date(billingPeriodStart) : fallback;
    const end = billingPeriodEnd ? new Date(billingPeriodEnd) : fallback;

    // Ensure deterministic order even if invoice data is malformed.
    if (start <= end) {
      return { lookupStartDate: start, lookupEndDate: end };
    }
    return { lookupStartDate: end, lookupEndDate: start };
  }

  /**
   * Enrollment status filter for paid-invoice commission tier/product lookup.
   * Coverage is defined by billing-period dates, not current Status — Inactive
   * rows superseded after the period still describe who was covered when billed.
   */
  static billingPeriodEnrollmentStatusSql(enrollmentAlias = 'e') {
    return `${enrollmentAlias}.Status NOT IN ('Pending', 'Cancelled', 'Denied')`;
  }

  /**
   * Like resolveEnrollmentLookupWindow but anchored on an invoice (used for
   * credit-funded commission generation where no oe.Payments row exists).
   */
  static async resolveEnrollmentLookupWindowFromInvoice(invoiceId, fallbackDate = null) {
    const fallbackWindow = this.normalizeEnrollmentLookupWindow(fallbackDate);
    if (!invoiceId) {
      return { ...fallbackWindow, source: 'paymentDateFallback' };
    }
    try {
      const pool = await getPool();
      const req = pool.request();
      req.input('InvoiceId', sql.UniqueIdentifier, invoiceId);
      const result = await req.query(`
        SELECT TOP 1 BillingPeriodStart, BillingPeriodEnd
        FROM oe.Invoices
        WHERE InvoiceId = @InvoiceId
      `);
      if (result.recordset.length === 0) {
        return { ...fallbackWindow, source: 'paymentDateFallback' };
      }
      const row = result.recordset[0];
      const window = this.normalizeEnrollmentLookupWindow(
        fallbackDate || row.BillingPeriodStart || new Date(),
        row.BillingPeriodStart || null,
        row.BillingPeriodEnd || null
      );
      return { ...window, source: 'invoiceBillingPeriod' };
    } catch (error) {
      logger.warn('Failed to resolve invoice enrollment lookup window from invoice', {
        invoiceId,
        error: error.message
      });
      return { ...fallbackWindow, source: 'paymentDateFallback' };
    }
  }

  /**
   * Create commissions for a credit-funded (invoice-anchored) settlement.
   *
   * Used when an invoice transitions to Status='Paid' via credit (e.g.
   * household credit application) without a corresponding oe.Payments row.
   * Loads scope (household/group/agent/etc.) from the invoice and its
   * primary enrollment, then delegates to createCommissionsForPayment with
   * paymentId=null + invoiceId set so the resulting oe.Commissions rows are
   * findable by getEligibleCommissions' invoice-anchored UNION ALL branch.
   *
   * Idempotent: if commissions already exist for this InvoiceId, it returns
   * { success: true, commissionsCreated: 0, skipped: true } without inserting.
   *
   * @param {Object} opts
   * @param {string} opts.invoiceId - REQUIRED
   * @param {Object} [opts.transaction] - Optional SQL transaction
   * @returns {Promise<Object>} { success, commissionsCreated, ... }
   */
  static async createCommissionsForInvoice({ invoiceId, transaction = null } = {}) {
    if (!invoiceId) {
      throw new Error('createCommissionsForInvoice: invoiceId is required');
    }
    const pool = await getPool();

    // Idempotency guard: if commissions already exist for this invoice, do
    // nothing. Prevents double-creation if the same invoice flips Paid twice.
    const existingReq = transaction ? new mssql.Request(transaction) : pool.request();
    existingReq.input('InvoiceId', sql.UniqueIdentifier, invoiceId);
    const existing = await existingReq.query(`
      SELECT COUNT(*) AS Cnt FROM oe.Commissions WHERE InvoiceId = @InvoiceId
    `);
    if ((existing.recordset[0]?.Cnt || 0) > 0) {
      return { success: true, commissionsCreated: 0, skipped: true, reason: 'already-exists' };
    }

    // Load invoice + primary enrollment for scope.
    const scopeReq = transaction ? new mssql.Request(transaction) : pool.request();
    scopeReq.input('InvoiceId', sql.UniqueIdentifier, invoiceId);
    const scopeResult = await scopeReq.query(`
      SELECT TOP 1
        inv.InvoiceId,
        inv.HouseholdId,
        inv.GroupId,
        inv.TenantId,
        inv.BillingPeriodStart,
        inv.BillingPeriodEnd,
        inv.TotalAmount,
        inv.Commission,
        inv.OverrideRate,
        inv.NetRate,
        inv.Status,
        e.EnrollmentId AS PrimaryEnrollmentId,
        e.AgentId       AS PrimaryAgentId,
        e.ProductId     AS PrimaryProductId
      FROM oe.Invoices inv
      OUTER APPLY (
        SELECT TOP 1 e.EnrollmentId, e.AgentId, e.ProductId
        FROM oe.Enrollments e
        LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE e.Status = 'Active'
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND (
            (inv.HouseholdId IS NOT NULL AND e.HouseholdId = inv.HouseholdId AND m.RelationshipType = 'P')
            OR (inv.GroupId IS NOT NULL AND m.GroupId = inv.GroupId AND m.RelationshipType = 'P')
          )
          AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= inv.BillingPeriodEnd)
          AND (e.TerminationDate IS NULL OR e.TerminationDate > inv.BillingPeriodStart)
        ORDER BY e.CreatedDate ASC
      ) e
      WHERE inv.InvoiceId = @InvoiceId
    `);

    if (scopeResult.recordset.length === 0) {
      logger.warn('createCommissionsForInvoice: invoice not found', { invoiceId });
      return { success: true, commissionsCreated: 0 };
    }
    const inv = scopeResult.recordset[0];

    if (inv.Status !== 'Paid') {
      logger.warn('createCommissionsForInvoice: invoice is not Paid; skipping', {
        invoiceId,
        status: inv.Status
      });
      return { success: true, commissionsCreated: 0, skipped: true, reason: 'not-paid' };
    }
    if (!inv.PrimaryAgentId) {
      logger.info('createCommissionsForInvoice: no agent on primary enrollment; skipping', { invoiceId });
      return { success: true, commissionsCreated: 0 };
    }

    return await this.createCommissionsForPayment({
      paymentId: null,
      invoiceId,
      householdId: inv.HouseholdId,
      groupId: inv.GroupId,
      paymentDate: inv.BillingPeriodStart,
      productId: inv.PrimaryProductId,
      paymentAmount: parseFloat(inv.TotalAmount) || 0,
      agentId: inv.PrimaryAgentId,
      tenantId: inv.TenantId,
      commission: parseFloat(inv.Commission) || 0,
      overrideRate: parseFloat(inv.OverrideRate) || 0,
      netRate: parseFloat(inv.NetRate) || 0,
      commissionStatus: 'Pending',
      transaction
    });
  }

  static async resolveEnrollmentLookupWindow(paymentId, paymentDate = null) {
    const fallbackWindow = this.normalizeEnrollmentLookupWindow(paymentDate);
    if (!paymentId) {
      return { ...fallbackWindow, source: 'paymentDateFallback' };
    }

    try {
      const pool = await getPool();
      const req = pool.request();
      req.input('PaymentId', sql.UniqueIdentifier, paymentId);
      const result = await req.query(`
        SELECT TOP 1
          p.PaymentDate,
          p.InvoiceId,
          i.BillingPeriodStart,
          i.BillingPeriodEnd
        FROM oe.Payments p
        LEFT JOIN oe.Invoices i ON p.InvoiceId = i.InvoiceId
        WHERE p.PaymentId = @PaymentId
      `);

      if (result.recordset.length === 0) {
        return { ...fallbackWindow, source: 'paymentDateFallback' };
      }

      const row = result.recordset[0];
      const effectivePaymentDate = row.PaymentDate || paymentDate || new Date();
      const hasInvoiceWindow = row.BillingPeriodStart || row.BillingPeriodEnd;
      const window = this.normalizeEnrollmentLookupWindow(
        effectivePaymentDate,
        row.BillingPeriodStart || null,
        row.BillingPeriodEnd || null
      );

      return {
        ...window,
        source: hasInvoiceWindow ? 'invoiceBillingPeriod' : 'paymentDateFallback'
      };
    } catch (error) {
      logger.warn('Failed to resolve invoice enrollment lookup window, using payment date fallback', {
        paymentId,
        error: error.message
      });
      return { ...fallbackWindow, source: 'paymentDateFallback' };
    }
  }

  /**
   * Create commissions for a payment
   * @param {Object} paymentData - Payment data
   * @returns {Promise<Object>} Commission creation result
   */
  static async createCommissionsForPayment(paymentData) {
    const {
      paymentId,
      // invoiceId is set when commission generation is anchored on a credit-funded
      // invoice (no oe.Payments row). It is stamped on every created oe.Commissions
      // row so getEligibleCommissions' invoice-anchored UNION ALL branch can find
      // them by InvoiceId.
      invoiceId = null,
      householdId,
      groupId,
      paymentDate,
      productId,
      paymentAmount,
      agentId,
      tenantId,
      commission, // Commission (Agent Commission Pool) from oe.Payments
      overrideRate, // OverrideRate from oe.Payments (100% goes to tenant/product owner)
      netRate, // NetRate from oe.Payments (100% goes to vendor)
      commissionStatus = 'Pending', // 'Pending' for completed payments, 'Draft' for expected payments
      transaction = null // Optional SQL transaction for atomic batch operations
    } = paymentData;

    // Group payments can sometimes carry a HouseholdId, but commission calculation must treat
    // group scope as authoritative so all group enrollments in the lookup window are considered.
    const effectiveHouseholdId = groupId ? null : householdId;

    try {
      // For credit-funded (invoice-anchored) commission creation there is no
      // oe.Payments row to look up — derive the enrollment lookup window from
      // the invoice's billing period directly when invoiceId is provided.
      let enrollmentLookupWindow;
      if (!paymentId && invoiceId) {
        enrollmentLookupWindow = await this.resolveEnrollmentLookupWindowFromInvoice(invoiceId, paymentDate);
      } else {
        enrollmentLookupWindow = await this.resolveEnrollmentLookupWindow(paymentId, paymentDate);
      }

      // Validate required fields
      if (!agentId) {
        logger.warn('No agentId found for payment', { paymentId });
        return { success: true, commissionsCreated: 0 };
      }

      // 1. Get TenantId from oe.Agents (simpler than deriving from enrollments)
      const pool = await getPool();
      const agentRequest = pool.request();
      agentRequest.input('AgentId', sql.UniqueIdentifier, agentId);
      const agentResult = await agentRequest.query(`
        SELECT TenantId
        FROM oe.Agents
        WHERE AgentId = @AgentId
          AND Status = 'Active'
      `);

      if (agentResult.recordset.length === 0) {
        logger.warn('Agent not found or inactive', { paymentId, agentId });
        return { success: true, commissionsCreated: 0 };
      }

      const finalTenantId = tenantId || agentResult.recordset[0].TenantId;

      // 2. Get ProductIds from enrollments associated with this payment
      // Note: Enrollments store component product IDs (not bundle IDs), so we get all ProductIds
      // and check commission rules for any of them. For group payments, there may be multiple
      // enrollments with different ProductIds (bundle components).
      let finalProductId = productId;
      let enrollmentProductIds = [];
      
      if (!finalProductId) {
        const productRequest = pool.request();
        productRequest.input('PaymentId', sql.UniqueIdentifier, paymentId);
        productRequest.input('HouseholdId', sql.UniqueIdentifier, effectiveHouseholdId || '00000000-0000-0000-0000-000000000000');
        productRequest.input('GroupId', sql.UniqueIdentifier, groupId || '00000000-0000-0000-0000-000000000000');
        productRequest.input('AllProductsId', sql.UniqueIdentifier, '00000000-0000-0000-0000-000000000000');
        productRequest.input('EnrollmentLookupStartDate', sql.DateTime2, enrollmentLookupWindow.lookupStartDate);
        productRequest.input('EnrollmentLookupEndDate', sql.DateTime2, enrollmentLookupWindow.lookupEndDate);
        // Product linkage uses HouseholdId / GroupId + primary member only — oe.Payments.EnrollmentId is deprecated and not used.
        const dateWindowClause = `
            AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @EnrollmentLookupEndDate)
            AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate)
          `;

        const productResult = await productRequest.query(`
          SELECT DISTINCT e.ProductId
          FROM oe.Enrollments e
          LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE ${CommissionService.billingPeriodEnrollmentStatusSql('e')}
            AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
            AND e.ProductId != @AllProductsId
            ${dateWindowClause}
            AND (
              (@HouseholdId != '00000000-0000-0000-0000-000000000000' AND e.HouseholdId = @HouseholdId AND m.RelationshipType = 'P')
              OR (@GroupId != '00000000-0000-0000-0000-000000000000' AND m.GroupId = @GroupId AND m.RelationshipType = 'P')
            )
        `);
        
        enrollmentProductIds = productResult.recordset.map(row => row.ProductId);
        
        if (enrollmentProductIds.length > 0) {
          // Use the first ProductId as the primary one (for product lookup, etc.)
          // But we'll pass all ProductIds to getApplicableRules to check rules for any component
          finalProductId = enrollmentProductIds[0];
          logger.info('Found ProductIds from enrollments', { 
            paymentId, 
            productIds: enrollmentProductIds,
            primaryProductId: finalProductId
          });
        }
      } else {
        // If productId was provided, use it as the only one to check
        enrollmentProductIds = [finalProductId];
      }

      // Read ProductCommissions JSON to get enrollment counts per product.
      // Invoice-sourced payouts: prefer the invoice's breakdown (current source of truth)
      // and fall back to the payment's snapshot for legacy rows. Same COALESCE pattern used by
      // getPaymentBreakdownPreview so both code paths agree on what's allocated per product.
      // (Parse before all-products fallback so snapshot can supply real ProductIds when enrollments query returned none.)
      let productEnrollmentCounts = new Map(); // Map<ProductId, enrollmentCount>
      let snapshotCommissionByProduct = new Map(); // Map<ProductId, CommissionAmount>
      try {
        logger.info('🔍 Attempting to read ProductCommissions', { paymentId });
        const paymentRequest = pool.request();
        paymentRequest.input('PaymentId', sql.UniqueIdentifier, paymentId);
        const paymentResult = await paymentRequest.query(`
          SELECT COALESCE(inv.ProductCommissions, p.ProductCommissions) AS ProductCommissions
          FROM oe.Payments p
          LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
          WHERE p.PaymentId = @PaymentId
        `);
        
        logger.info('🔍 Payment query result', { 
          paymentId, 
          recordCount: paymentResult.recordset.length,
          hasProductCommissions: !!paymentResult.recordset[0]?.ProductCommissions,
          productCommissionsType: typeof paymentResult.recordset[0]?.ProductCommissions
        });
        
        if (paymentResult.recordset.length > 0) {
          const productCommissionsRaw = paymentResult.recordset[0].ProductCommissions;
          logger.info('🔍 Raw ProductCommissions value', { 
            paymentId,
            raw: productCommissionsRaw,
            isNull: productCommissionsRaw === null,
            isUndefined: productCommissionsRaw === undefined
          });
          
          if (productCommissionsRaw) {
            try {
              const productCommissions = JSON.parse(productCommissionsRaw);
              logger.info('Parsed ProductCommissions JSON', {
                paymentId,
                rawJson: productCommissionsRaw,
                parsed: productCommissions,
                isArray: Array.isArray(productCommissions)
              });
              
              // Handle both formats:
              // 1. Object format: { "productId": { "enrolledHouseholdsCount": 1, "commissionAmount": 25 } }
              // 2. Array format: [{ "ProductId": "productId", "EnrolledHouseholdsCount": 1, "CommissionAmount": 25 }]
              if (Array.isArray(productCommissions)) {
                // Array format - convert to object
                for (const item of productCommissions) {
                  if (item && item.ProductId) {
                    const productIdUpper = item.ProductId.toUpperCase();
                    if (item.EnrolledHouseholdsCount === undefined && item.enrolledHouseholdsCount === undefined) {
                      logger.warn('Missing enrolledHouseholdsCount in ProductCommissions JSON (array format)', {
                        paymentId,
                        productId: item.ProductId
                      }, 'Commission');
                    }
                    const householdsCount = item.EnrolledHouseholdsCount !== undefined 
                      ? item.EnrolledHouseholdsCount 
                      : (item.enrolledHouseholdsCount !== undefined ? item.enrolledHouseholdsCount : 0);
                    productEnrollmentCounts.set(productIdUpper, householdsCount);
                    const commissionAmount = item.CommissionAmount !== undefined ? Number(item.CommissionAmount) : null;
                    if (commissionAmount != null && !Number.isNaN(commissionAmount)) {
                      snapshotCommissionByProduct.set(productIdUpper, commissionAmount);
                    }
                    logger.info('Added enrolled households count for product (array format)', {
                      paymentId,
                      productId: item.ProductId,
                      productIdUpper: productIdUpper,
                      enrolledHouseholdsCount: householdsCount
                    });
                  }
                }
              } else {
                // Object format - already in correct structure
                for (const [productIdStr, data] of Object.entries(productCommissions)) {
                  if (data && typeof data === 'object') {
                    // Require enrolledHouseholdsCount field - do not fallback to enrollmentCount
                    if (data.enrolledHouseholdsCount === undefined) {
                      logger.warn('Missing enrolledHouseholdsCount in ProductCommissions JSON (object format)', {
                        paymentId,
                        productId: productIdStr
                      }, 'Commission');
                    }
                    const householdsCount = data.enrolledHouseholdsCount !== undefined ? data.enrolledHouseholdsCount : 0;
                    if (householdsCount > 0 || data.commissionAmount !== undefined) {
                      const productIdUpper = productIdStr.toUpperCase();
                      productEnrollmentCounts.set(productIdUpper, householdsCount);
                      const commissionAmount = data.commissionAmount !== undefined ? Number(data.commissionAmount) : null;
                      if (commissionAmount != null && !Number.isNaN(commissionAmount)) {
                        snapshotCommissionByProduct.set(productIdUpper, commissionAmount);
                      }
                      logger.info('Added enrolled households count for product (object format)', {
                        paymentId,
                        productId: productIdStr,
                        productIdUpper: productIdUpper,
                        enrolledHouseholdsCount: householdsCount
                      });
                    }
                  }
                }
              }
              
              logger.info('Read ProductCommissions from payment', {
                paymentId,
                productEnrollmentCounts: Object.fromEntries(productEnrollmentCounts),
                mapSize: productEnrollmentCounts.size
              });
            } catch (e) {
              logger.warn('Could not parse ProductCommissions JSON from payment', { 
                paymentId, 
                rawJson: productCommissionsRaw,
                error: e.message 
              });
            }
          } else {
            logger.warn('ProductCommissions is NULL for payment - run migration script to populate', { paymentId });
          }
        }
      } catch (e) {
        logger.warn('Could not read ProductCommissions from payment', { paymentId, error: e.message });
      }

      // Fallback when payment has weak/null enrollment linkage:
      // use ProductCommissions snapshot product IDs so rules can still match per product.
      const ALL_PRODUCTS_GUID_CREATE = '00000000-0000-0000-0000-000000000000';
      const snapshotProductIdsFromPayment = Array.from(
        new Set([
          ...snapshotCommissionByProduct.keys(),
          ...productEnrollmentCounts.keys()
        ])
      ).filter(
        (k) =>
          k &&
          String(k).toUpperCase() !== ALL_PRODUCTS_GUID_CREATE.toUpperCase()
      );
      if (snapshotProductIdsFromPayment.length > 0 && enrollmentProductIds.length === 0) {
        enrollmentProductIds = snapshotProductIdsFromPayment;
        finalProductId = enrollmentProductIds[0];
        logger.info('Using ProductCommissions snapshot for product context fallback', {
          paymentId,
          fallbackProductIds: enrollmentProductIds,
          primaryProductId: finalProductId
        });
      }

      // If still no ProductId (no enrollments + no JSON snapshot), use "All Products" GUID
      if (!finalProductId) {
        logger.warn('No ProductId found for payment - using "All Products" fallback', { paymentId, householdId, groupId });
        finalProductId = ALL_PRODUCTS_GUID_CREATE;
        enrollmentProductIds = [finalProductId];
      }

      // 3. Create commissions using the payment's allocated commission pool
      // Use HouseholdId for advance balance tracking (per agent per household)
      logger.info('Calling createCommissionsForEnrollment with productEnrollmentCounts', {
        paymentId,
        groupId,
        hasProductEnrollmentCounts: !!productEnrollmentCounts,
        productEnrollmentCountsKeys: productEnrollmentCounts ? Array.from(productEnrollmentCounts.keys()) : []
      });
      const dryRun = paymentData.dryRun === true;
      const commissions = await this.createCommissionsForEnrollment({
        paymentId,
        // Pass through invoiceId so commission rows are stamped with it (required for
        // the invoice-anchored UNION ALL branch in getEligibleCommissions to locate
        // credit-funded invoice commissions, and for joins via npd.InvoiceId).
        invoiceId,
        // oe.Payments.EnrollmentId is deprecated — never pass it; household/group scope defines enrollments.
        enrollmentId: null,
        householdId: effectiveHouseholdId,
        groupId,
        paymentDate,
        productId: finalProductId,
        enrollmentProductIds: enrollmentProductIds, // Pass all ProductIds from enrollments
        paymentAmount,
        agentId,
        tenantId: finalTenantId,
        commission, // Use allocated commission pool from oe.Payments
        overrideRate, // Use OverrideRate from oe.Payments
        netRate, // Use NetRate from oe.Payments
        commissionStatus, // Pass status (Pending or Draft)
        productEnrollmentCounts, // Pass enrollment counts per product from ProductCommissions JSON
        enrollmentLookupStartDate: enrollmentLookupWindow.lookupStartDate,
        enrollmentLookupEndDate: enrollmentLookupWindow.lookupEndDate,
        dryRun,
        transaction
      });

      logger.info('Commissions created for payment', {
        paymentId,
        commissionsCreated: commissions.length
      });

      // Apply agent-to-agent overrides AFTER the base rows are in place. This must run
      // inside the same transaction so a failure here still rolls back the whole payment.
      const overrideResult = await this.resolveAgentOverrides({
        paymentId,
        tenantId: finalTenantId,
        paymentDate,
        householdId: effectiveHouseholdId,
        groupId,
        commissionStatus,
        dryRun,
        transaction,
        dryRunRows: dryRun ? commissions : null
      });

      if (dryRun) {
        const allPreviewRows = [...commissions, ...overrideResult.dryRunRows];
        return {
          success: true,
          commissionsCreated: 0,
          commissionIds: [],
          dryRunRows: allPreviewRows,
          agentOverrides: {
            applied: overrideResult.applied,
            skipped: overrideResult.skipped
          }
        };
      }
      return {
        success: true,
        commissionsCreated: commissions.length + overrideResult.createdCommissionIds.length,
        commissionIds: [...(commissions || []), ...overrideResult.createdCommissionIds],
        agentOverrides: {
          applied: overrideResult.applied,
          skipped: overrideResult.skipped
        }
      };
    } catch (error) {
      logger.error('Error creating commissions for payment', {
        error: error.message,
        paymentId,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Create commissions for a specific enrollment
   * @param {Object} enrollmentData - Enrollment data
   * @returns {Promise<Array>} Created commission IDs
   */
  static async createCommissionsForEnrollment(enrollmentData) {
    const {
      paymentId,
      // invoiceId is stamped on every oe.Commissions row created here so the
      // invoice-anchored UNION ALL branch in getEligibleCommissions can find
      // them by InvoiceId (especially for credit-funded invoices with no
      // matching oe.Payments row). Defaults to null for legacy payment-only flow.
      invoiceId = null,
      enrollmentId,
      householdId,
      groupId,
      paymentDate,
      productId,
      paymentAmount,
      agentId,
      tenantId,
      commission, // Commission (Agent Commission Pool) from oe.Payments
      overrideRate, // OverrideRate from oe.Payments
      netRate, // NetRate from oe.Payments
      commissionStatus = 'Pending', // 'Pending' for completed payments, 'Draft' for expected payments
      productEnrollmentCounts = null, // Map<ProductId, enrollmentCount> from ProductCommissions JSON
      enrollmentLookupStartDate = null,
      enrollmentLookupEndDate = null,
      dryRun = false, // When true, do not INSERT; return preview row objects
      transaction = null // Optional SQL transaction for atomic batch operations
    } = enrollmentData;

    const normalizedLookupWindow = CommissionService.normalizeEnrollmentLookupWindow(
      paymentDate || new Date(),
      enrollmentLookupStartDate,
      enrollmentLookupEndDate
    );
    const lookupStartDate = normalizedLookupWindow.lookupStartDate;
    const lookupEndDate = normalizedLookupWindow.lookupEndDate;

    console.log('🔍🔍🔍 createCommissionsForEnrollment CALLED', {
      paymentId: paymentId?.toString(),
      groupId: groupId?.toString(),
      householdId: householdId?.toString(),
      enrollmentId: enrollmentId?.toString(),
      hasProductEnrollmentCounts: !!productEnrollmentCounts,
      productEnrollmentCountsKeys: productEnrollmentCounts ? Array.from(productEnrollmentCounts.keys()) : [],
      willQueryTierDistribution: !!groupId && !householdId && !enrollmentId
    });
    logger.info('createCommissionsForEnrollment called', {
      paymentId,
      groupId,
      householdId,
      enrollmentId,
      hasProductEnrollmentCounts: !!productEnrollmentCounts,
      productEnrollmentCountsKeys: productEnrollmentCounts ? Array.from(productEnrollmentCounts.keys()) : [],
      productEnrollmentCountsType: productEnrollmentCounts ? typeof productEnrollmentCounts : 'null',
      productEnrollmentCountsIsMap: productEnrollmentCounts instanceof Map,
      willQueryTierDistribution: !!groupId && !householdId && !enrollmentId
    });

    // Get product tier (EE, ES, EC, EF) from household primary or group — not from oe.Payments.EnrollmentId.

    // 1. Get commission amounts per product from enrollments
    // This allows product-specific rules to be applied to the correct product's commission portion
    const pool = await getPool();
    const enrollmentProductIds = enrollmentData.enrollmentProductIds || null;
    let productCommissionAmounts = new Map(); // Map<ProductId, CommissionAmount>
    
    // Always query for commission amounts per product, even if enrollmentProductIds is null
    // This ensures we have product-specific commission amounts for group/household payments
    const commissionRequest = pool.request();
    commissionRequest.input('EnrollmentLookupStartDate', sql.DateTime2, lookupStartDate);
    commissionRequest.input('EnrollmentLookupEndDate', sql.DateTime2, lookupEndDate);
    if (householdId) {
      commissionRequest.input('HouseholdId', sql.UniqueIdentifier, householdId);
    }
    if (groupId) {
      commissionRequest.input('GroupId', sql.UniqueIdentifier, groupId);
    }

    // Build query conditions (household / group + primary member only; payment EnrollmentId not used)
    let whereConditions = [];
    if (householdId) {
      whereConditions.push('(e.HouseholdId = @HouseholdId AND m.RelationshipType = \'P\')');
    }
    if (groupId) {
      whereConditions.push('(m.GroupId = @GroupId AND m.RelationshipType = \'P\')');
    }

    // Only query if we have at least one identifier
    if (whereConditions.length > 0) {
      const commissionDateWindowClause = `
          AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @EnrollmentLookupEndDate)
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate)
        `;
      const commissionQuery = `
        SELECT 
          e.ProductId,
          SUM(COALESCE(e.Commission, 0)) as CommissionAmount
        FROM oe.Enrollments e
        LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE ${CommissionService.billingPeriodEnrollmentStatusSql('e')}
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND e.Commission IS NOT NULL
          ${commissionDateWindowClause}
          AND (${whereConditions.join(' OR ')})
        GROUP BY e.ProductId
      `;
      
      const commissionResult = await commissionRequest.query(commissionQuery);
      
      for (const row of commissionResult.recordset) {
        productCommissionAmounts.set(row.ProductId.toString(), parseFloat(row.CommissionAmount) || 0);
      }
      
      logger.info('Commission amounts per product', {
        paymentId,
        productCommissionAmounts: Object.fromEntries(productCommissionAmounts),
        totalCommission: commission,
        enrollmentId,
        householdId,
        groupId
      });
    }

    let productTier = null;
    if (householdId) {
      // For household payments, get tier from primary member
      try {
        const tierRequest = pool.request();
        tierRequest.input('HouseholdId', sql.UniqueIdentifier, householdId);
        tierRequest.input('EnrollmentLookupStartDate', sql.DateTime2, lookupStartDate);
        tierRequest.input('EnrollmentLookupEndDate', sql.DateTime2, lookupEndDate);
        const tierResult = await tierRequest.query(`
          SELECT TOP 1 m.Tier
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE e.HouseholdId = @HouseholdId
            AND m.RelationshipType = 'P'
            AND ${CommissionService.billingPeriodEnrollmentStatusSql('e')}
            AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @EnrollmentLookupEndDate)
            AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate)
          ORDER BY e.EffectiveDate DESC
        `);
        if (tierResult.recordset.length > 0 && tierResult.recordset[0].Tier) {
          productTier = tierResult.recordset[0].Tier;
          logger.info('Product tier from household primary member', { householdId, productTier });
        }
      } catch (error) {
        logger.warn('Could not get product tier from household', { householdId, error: error.message });
      }
    } else if (groupId) {
      // For group payments, get tier distribution (how many households per tier)
      // This is needed for tier-based commission rules that have different rates per tier (EE, ES, EC, EF)
      // We still set productTier to the most common tier for backward compatibility, but we'll calculate
      // commission per tier in calculateComplexTieredCommission if tier distribution is available
      logger.info('🔍 Processing group payment - will query tier distribution', {
        groupId,
        agentId,
        paymentId,
        hasProductEnrollmentCounts: !!productEnrollmentCounts
      });
      try {
        const tierRequest = pool.request();
        tierRequest.input('GroupId', sql.UniqueIdentifier, groupId);
        tierRequest.input('AgentId', sql.UniqueIdentifier, agentId);
        tierRequest.input('ProductId', sql.UniqueIdentifier, productId || '00000000-0000-0000-0000-000000000000');
        tierRequest.input('EnrollmentLookupStartDate', sql.DateTime2, lookupStartDate);
        tierRequest.input('EnrollmentLookupEndDate', sql.DateTime2, lookupEndDate);
        const tierResult = await tierRequest.query(`
          SELECT TOP 1 m.Tier, COUNT(DISTINCT m.HouseholdId) as HouseholdCount
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE e.GroupId = @GroupId
            AND e.AgentId = @AgentId
            AND (
              @ProductId = '00000000-0000-0000-0000-000000000000'
              OR e.ProductId = @ProductId
            )
            AND e.EnrollmentType = 'Product'
            AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @EnrollmentLookupEndDate)
            AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate)
            AND m.RelationshipType = 'P'
            AND m.Tier IS NOT NULL
          GROUP BY m.Tier
          ORDER BY COUNT(DISTINCT m.HouseholdId) DESC
        `);
        if (tierResult.recordset.length > 0 && tierResult.recordset[0].Tier) {
          productTier = tierResult.recordset[0].Tier;
          logger.info('Product tier from group enrollment (most common)', { groupId, productId, productTier });
        }
        
        // Also get full tier distribution for tier-based commission calculations
        // For group payments, we need tier distribution PER COMPONENT PRODUCT, not just the bundle
        // Get tier distribution for all component products in the group
        // Note: We use the household count from ProductCommissions as the source of truth,
        // but we need tier distribution to calculate tier-based commissions correctly
        logger.info('🔍 About to query tier distribution for group payment', {
          groupId,
          agentId,
          paymentDate: paymentDate || new Date(),
          hasProductEnrollmentCounts: !!productEnrollmentCounts,
          productEnrollmentCountsSize: productEnrollmentCounts ? productEnrollmentCounts.size : 0
        });
        console.log('🔍🔍🔍 TIER DISTRIBUTION QUERY STARTING', {
          groupId,
          agentId,
          paymentId,
          paymentDate: paymentDate || new Date()
        });
        try {
          const tierDistRequest = pool.request();
          tierDistRequest.input('GroupId', sql.UniqueIdentifier, groupId);
          tierDistRequest.input('AgentId', sql.UniqueIdentifier, agentId);
          tierDistRequest.input('EnrollmentLookupStartDate', sql.DateTime2, lookupStartDate);
          tierDistRequest.input('EnrollmentLookupEndDate', sql.DateTime2, lookupEndDate);
          console.log('🔍🔍🔍 TIER DISTRIBUTION QUERY EXECUTING', {
            groupId: groupId?.toString(),
            agentId: agentId?.toString(),
            paymentDate: paymentDate || new Date()
          });
          // Get tier distribution for ALL households with enrollments (no date filter)
          // This ensures we get tiers for all households, even if some enrollments are terminated
          // We'll match this to the household count from ProductCommissions
          const tierDistResult = await tierDistRequest.query(`
            SELECT e.ProductId, pm.Tier, COUNT(DISTINCT e.HouseholdId) as HouseholdCount
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            INNER JOIN oe.Members pm ON m.HouseholdId = pm.HouseholdId AND pm.RelationshipType = 'P'
            WHERE e.GroupId = @GroupId
              AND e.AgentId = @AgentId
              AND e.EnrollmentType = 'Product'
              AND m.RelationshipType = 'P'
              AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @EnrollmentLookupEndDate)
              AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate)
              AND pm.Tier IS NOT NULL
            GROUP BY e.ProductId, pm.Tier
            ORDER BY e.ProductId, pm.Tier
          `);
          
          // Also get total household count per product to identify missing households
          const totalHouseholdsRequest = pool.request();
          totalHouseholdsRequest.input('GroupId', sql.UniqueIdentifier, groupId);
          totalHouseholdsRequest.input('AgentId', sql.UniqueIdentifier, agentId);
          totalHouseholdsRequest.input('EnrollmentLookupStartDate', sql.DateTime2, lookupStartDate);
          totalHouseholdsRequest.input('EnrollmentLookupEndDate', sql.DateTime2, lookupEndDate);
          const totalHouseholdsResult = await totalHouseholdsRequest.query(`
            SELECT e.ProductId, COUNT(DISTINCT e.HouseholdId) as TotalHouseholds
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE e.GroupId = @GroupId
              AND e.AgentId = @AgentId
              AND e.EnrollmentType = 'Product'
              AND m.RelationshipType = 'P'
              AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @EnrollmentLookupEndDate)
              AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate)
            GROUP BY e.ProductId
          `);
          
          // Create a map of total households per product
          const totalHouseholdsByProduct = new Map();
          for (const row of totalHouseholdsResult.recordset) {
            const prodId = row.ProductId ? row.ProductId.toString().toUpperCase() : null;
            if (prodId) {
              totalHouseholdsByProduct.set(prodId, row.TotalHouseholds);
            }
          }
          
          console.log('🔍🔍🔍 TIER DISTRIBUTION QUERY RESULT', {
            groupId: groupId?.toString(),
            agentId: agentId?.toString(),
            rowCount: tierDistResult.recordset.length,
            rows: tierDistResult.recordset.map(r => ({
              productId: r.ProductId?.toString(),
              tier: r.Tier,
              householdCount: r.HouseholdCount
            }))
          });
          logger.info('Tier distribution query executed', {
            groupId,
            agentId,
            paymentDate: paymentDate || new Date(),
            rowCount: tierDistResult.recordset.length,
            sampleRows: tierDistResult.recordset.slice(0, 3).map(r => ({
              productId: r.ProductId?.toString(),
              tier: r.Tier,
              householdCount: r.HouseholdCount
            }))
          });
          
          // Store tier distribution per product in productEnrollmentCounts
          // We'll use a special key format: "TIER_DIST:{ProductId}" to store tier distribution
          if (tierDistResult.recordset.length > 0) {
            if (!productEnrollmentCounts) {
              productEnrollmentCounts = new Map();
            }
            
            // Group by ProductId
            const tierDistByProduct = new Map();
            for (const row of tierDistResult.recordset) {
              const prodId = row.ProductId ? row.ProductId.toString().toUpperCase() : null;
              if (!prodId) continue;
              if (!tierDistByProduct.has(prodId)) {
                tierDistByProduct.set(prodId, new Map());
              }
              tierDistByProduct.get(prodId).set(row.Tier, row.HouseholdCount);
            }
            
          // Store tier distribution for each product
          for (const [prodId, tierDistribution] of tierDistByProduct.entries()) {
            const tierDistKey = `TIER_DIST:${prodId}`;
            productEnrollmentCounts.set(tierDistKey, tierDistribution);
            console.log('✅✅✅ TIER DISTRIBUTION STORED', {
              tierDistKey,
              productId: prodId,
              tierDistribution: Object.fromEntries(tierDistribution),
              allKeys: Array.from(productEnrollmentCounts.keys())
            });
            logger.info('✅ Tier distribution stored in productEnrollmentCounts', {
              groupId,
              productId: prodId,
              tierDistKey,
              tierDistribution: Object.fromEntries(tierDistribution),
              totalHouseholds: Array.from(tierDistribution.values()).reduce((sum, count) => sum + count, 0),
              productEnrollmentCountsSize: productEnrollmentCounts.size,
              allKeysInMap: Array.from(productEnrollmentCounts.keys()),
              tierDistKeysInMap: Array.from(productEnrollmentCounts.keys()).filter(k => k.startsWith('TIER_DIST:'))
            });
          }
          
          logger.info('✅ All tier distributions stored', {
            groupId,
            productEnrollmentCountsSize: productEnrollmentCounts.size,
            allKeys: Array.from(productEnrollmentCounts.keys()),
            tierDistKeys: Array.from(productEnrollmentCounts.keys()).filter(k => k.startsWith('TIER_DIST:')),
            tierDistDetails: Array.from(productEnrollmentCounts.entries())
              .filter(([k]) => k.startsWith('TIER_DIST:'))
              .map(([k, v]) => ({
                key: k,
                value: v instanceof Map ? Object.fromEntries(v) : v
              }))
          });
          } else {
            logger.warn('No tier distribution found for group payment', {
              groupId,
              agentId,
              paymentDate: paymentDate || new Date()
            });
          }
        } catch (tierDistError) {
          console.error('❌❌❌ TIER DISTRIBUTION QUERY ERROR', {
            groupId: groupId?.toString(),
            agentId: agentId?.toString(),
            error: tierDistError.message,
            stack: tierDistError.stack
          });
          logger.warn('Error getting tier distribution for group payment', {
            groupId,
            agentId,
            error: tierDistError.message
          });
        }
      } catch (error) {
        logger.warn('Could not get product tier from group', { groupId, productId, error: error.message });
      }
    }

    // 2. Calculate commission distribution using commission rules
    // Use the allocated commission pool from oe.Payments (same as NACHA service)
    // Split rules are applied LAST (after all regular rules)
    //
    // IMPORTANT: For group payments, ProductCommissions.enrolledHouseholdsCount can be wrong (stale/migrated).
    // Recompute per-product household counts from enrollments as-of paymentDate to avoid over/underpaying.
    if (groupId && paymentDate && agentId) {
      try {
        const countsReq = pool.request();
        countsReq.input('GroupId', sql.UniqueIdentifier, groupId);
        countsReq.input('AgentId', sql.UniqueIdentifier, agentId);
        countsReq.input('EnrollmentLookupStartDate', sql.DateTime2, lookupStartDate);
        countsReq.input('EnrollmentLookupEndDate', sql.DateTime2, lookupEndDate);
        countsReq.input('AllProductsId', sql.UniqueIdentifier, '00000000-0000-0000-0000-000000000000');

        const countsResult = await countsReq.query(`
          SELECT
            e.ProductId,
            COUNT(DISTINCT e.HouseholdId) as HouseholdCount
          FROM oe.Enrollments e
          LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE (e.GroupId = @GroupId OR m.GroupId = @GroupId)
            AND e.AgentId = @AgentId
            AND e.EnrollmentType = 'Product'
            AND m.RelationshipType = 'P'
            AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @EnrollmentLookupEndDate)
            AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate)
            AND e.ProductId IS NOT NULL
            AND e.ProductId != @AllProductsId
            -- Exclude bundle ProductIds (commission rules apply to component products)
            AND e.ProductId NOT IN (
              SELECT DISTINCT BundleProductId
              FROM oe.ProductBundles
              WHERE BundleProductId IS NOT NULL
            )
          GROUP BY e.ProductId
        `);

        const recomputed = new Map();
        for (const row of (countsResult.recordset || [])) {
          const pid = row.ProductId ? row.ProductId.toString().toUpperCase() : null;
          if (!pid) continue;
          recomputed.set(pid, Number(row.HouseholdCount || 0));
        }

        if (recomputed.size > 0) {
          if (!productEnrollmentCounts) productEnrollmentCounts = new Map();

          for (const [pid, newCount] of recomputed.entries()) {
            const oldCount = productEnrollmentCounts.get(pid);
            if (typeof oldCount === 'number' && oldCount !== newCount) {
              logger.warn('Group payment enrolledHouseholdsCount mismatch - using recomputed count from enrollments', {
                paymentId,
                groupId,
                agentId,
                productId: pid,
                oldCount,
                newCount
              }, 'Commission');
            }
            productEnrollmentCounts.set(pid, newCount);
          }
        }
      } catch (e) {
        logger.warn('Could not recompute group product household counts from enrollments', {
          paymentId,
          groupId,
          agentId,
          error: e.message
        }, 'Commission');
      }
    }

    // Safely serialize productEnrollmentCounts for logging (handles nested Maps)
    let productEnrollmentCountsForLog = null;
    if (productEnrollmentCounts) {
      try {
        productEnrollmentCountsForLog = {};
        for (const [key, value] of productEnrollmentCounts.entries()) {
          if (value instanceof Map) {
            productEnrollmentCountsForLog[key] = Object.fromEntries(value);
          } else {
            productEnrollmentCountsForLog[key] = value;
          }
        }
      } catch (e) {
        productEnrollmentCountsForLog = { error: 'Could not serialize', message: e.message };
      }
    }
    logger.info('🔍 Calling calculateCommissionDistribution with productEnrollmentCounts', {
      paymentId,
      productEnrollmentCounts: productEnrollmentCountsForLog,
      mapSize: productEnrollmentCounts ? productEnrollmentCounts.size : 0,
      allKeys: productEnrollmentCounts ? Array.from(productEnrollmentCounts.keys()) : [],
      tierDistKeys: productEnrollmentCounts ? Array.from(productEnrollmentCounts.keys()).filter(k => k.startsWith('TIER_DIST:')) : []
    });
    const commissionDistribution = await this.calculateCommissionDistribution(
      paymentId,
      enrollmentId,
      productId,
      paymentAmount,
      agentId,
      tenantId,
      commission, // Use allocated commission pool from oe.Payments (total)
      overrideRate, // Use OverrideRate from oe.Payments
      netRate, // Use NetRate from oe.Payments
      householdId, // Pass HouseholdId for split rule filtering
      groupId, // Pass GroupId for split rule filtering
      paymentDate, // Pass paymentDate to determine which rules are effective
      enrollmentProductIds, // Pass enrollment ProductIds for rule lookup
      productCommissionAmounts, // Pass commission amounts per product
      productTier, // Pass product tier (EE, ES, EC, EF) for tier-specific commission amounts
      productEnrollmentCounts // Pass enrollment counts per product from ProductCommissions JSON
    );

    logger.info('💰 Commission distribution result', {
      paymentId,
      distributionCount: commissionDistribution.length,
      distribution: commissionDistribution.map(d => ({
        agentId: d.agentId,
        agencyId: d.agencyId,
        amount: d.amount,
        ruleId: d.ruleId,
        ruleName: d.ruleName,
        tierLevel: d.tierLevel,
        isAgencyOverflow: d.isAgencyOverflow,
        isOverflow: d.isOverflow
      }))
    });

    const createdCommissions = [];
    const agentsWithAdvanceCreated = new Set(); // Track agents that already have advance commissions created

    // 2. Aggregate commissions by agent/agency (sum amounts, collect RuleIds, capture split details)
    // This ensures 1 commission row per payment per agent/agency, with all RuleIds stored as JSON
    const agentCommissions = new Map();
    const agencyCommissions = new Map(); // Separate map for agencies
    
    logger.info('📦 Processing commission distribution into agent/agency maps', {
      paymentId,
      totalDistributions: commissionDistribution.length
    });

    for (const agentPayout of commissionDistribution) {
      const {
        agentId: payoutAgentId,
        agencyId: payoutAgencyId,
        amount,
        ruleId,
        tierLevel,
        splitAmount,
        splitPartnerId,
        isSplitPartner,
        splitFromAgentId,
        splitRuleId,
        isAgencyOverflow,
        isOverflow
      } = agentPayout;
      
      logger.info('📋 Processing payout', {
        paymentId,
        agentId: payoutAgentId,
        agencyId: payoutAgencyId,
        amount,
        ruleId,
        ruleName: agentPayout.ruleName || null,
        isAgencyOverflow,
        isOverflow
      });

      // Handle agencies separately (they use AgencyId, not AgentId).
      // Key includes ruleId so multiple distinct rules paying the same agency
      // on one payment land in distinct oe.Commissions rows (each with its own
      // RuleIds), matching how agent rows aggregate. Overflow rows have no
      // ruleId — they bucket together under the 'overflow' sentinel.
      if (isAgencyOverflow && payoutAgencyId) {
        const ruleKey = ruleId ? String(ruleId) : 'overflow';
        const mapKey = `${payoutAgencyId}::${ruleKey}`;
        logger.info('🏢 Adding to agency commissions', {
          paymentId,
          agencyId: payoutAgencyId,
          ruleId,
          amount
        });
        if (!agencyCommissions.has(mapKey)) {
          agencyCommissions.set(mapKey, {
            agencyId: payoutAgencyId,
            totalAmount: 0,
            ruleIds: [],
            tierLevel: tierLevel ?? null
          });
        }
        const agencyComm = agencyCommissions.get(mapKey);
        agencyComm.totalAmount += amount;
        if (ruleId && !agencyComm.ruleIds.includes(ruleId)) {
          agencyComm.ruleIds.push(ruleId);
        }
        continue; // Skip to next payout
      }
      
      // Handle agents (normal flow)
      if (!payoutAgentId) {
        logger.warn('⚠️ Skipping payout - no agentId', {
          paymentId,
          agencyId: payoutAgencyId,
          amount,
          isAgencyOverflow,
          isOverflow
        });
        continue; // Skip if no agent ID
      }

      logger.info('👤 Adding to agent commissions', {
        paymentId,
        agentId: payoutAgentId,
        amount,
        ruleId
      });
      
      if (!agentCommissions.has(payoutAgentId)) {
        agentCommissions.set(payoutAgentId, {
          agentId: payoutAgentId,
          totalAmount: 0,
          ruleIds: [],
          tierLevel: tierLevel ?? null,
          // Split commission details
          splitPartnerId: null,
          splitPercentage: null,
          isPrimaryInSplit: null, // null = not a split, true = primary, false = partner
          splitRuleId: null
        });
      }
      
      const agentComm = agentCommissions.get(payoutAgentId);
      agentComm.totalAmount += amount;
      if (ruleId && !agentComm.ruleIds.includes(ruleId)) {
        agentComm.ruleIds.push(ruleId);
      }
      
      // Capture split commission details
      // Use splitPercentage from the distribution (comes directly from rule configuration)
      if (splitAmount && splitPartnerId) {
        // This agent is the primary agent in a split
        agentComm.splitPartnerId = splitPartnerId;
        agentComm.isPrimaryInSplit = true;
        agentComm.splitRuleId = splitRuleId;
        agentComm.splitPercentage = agentPayout.splitPercentage || null; // Use percentage from rule
      } else if (isSplitPartner && splitFromAgentId) {
        // This agent is a split partner (receiving split commission)
        agentComm.splitPartnerId = splitFromAgentId; // Store who they're splitting with
        agentComm.isPrimaryInSplit = false;
        agentComm.splitRuleId = splitRuleId;
        agentComm.splitPercentage = agentPayout.splitPercentage || null; // Use percentage from rule
      }
    }

    logger.info('📊 Commission aggregation summary', {
      paymentId,
      agentCommissionsCount: agentCommissions.size,
      agencyCommissionsCount: agencyCommissions.size,
      agentCommissions: Array.from(agentCommissions.entries()).map(([id, comm]) => ({
        agentId: id,
        totalAmount: comm.totalAmount,
        ruleIds: comm.ruleIds
      })),
      agencyCommissions: Array.from(agencyCommissions.entries()).map(([key, comm]) => ({
        mapKey: key,
        agencyId: comm.agencyId,
        totalAmount: comm.totalAmount,
        ruleIds: comm.ruleIds
      }))
    });

    // Batch-fetch tier level labels for all agents + agencies so we can snapshot them
    const tierLabelById = new Map(); // id (uppercase) → string label
    try {
      const allAgentIds = [...agentCommissions.keys()];
      // agencyCommissions is keyed by `${agencyId}::${ruleKey}` for dedup; pull
      // distinct AgencyIds for the label lookup.
      const allAgencyIds = Array.from(new Set(
        Array.from(agencyCommissions.values()).map((c) => c.agencyId).filter(Boolean)
      ));
      if (allAgentIds.length > 0 || allAgencyIds.length > 0) {
        const labelPool = await getPool();
        const labelReq = labelPool.request();
        const parts = [];
        allAgentIds.forEach((id, i) => {
          labelReq.input(`LAId${i}`, sql.UniqueIdentifier, id);
          parts.push(`SELECT @LAId${i} AS EntityId, COALESCE(cl.DisplayName, CAST(a.CommissionTierLevel AS NVARCHAR)) AS LevelName
            FROM oe.Agents a LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
            WHERE a.AgentId = @LAId${i}`);
        });
        allAgencyIds.forEach((id, i) => {
          labelReq.input(`LAgId${i}`, sql.UniqueIdentifier, id);
          parts.push(`SELECT @LAgId${i} AS EntityId, COALESCE(cl.DisplayName, CAST(ag.CommissionTierLevel AS NVARCHAR)) AS LevelName
            FROM oe.Agencies ag LEFT JOIN oe.CommissionLevels cl ON ag.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
            WHERE ag.AgencyId = @LAgId${i}`);
        });
        const labelResult = await labelReq.query(parts.join(' UNION ALL '));
        for (const row of labelResult.recordset || []) {
          if (row.EntityId) tierLabelById.set(row.EntityId.toString().toUpperCase(), row.LevelName || null);
        }
      }
    } catch (labelErr) {
      logger.warn('⚠️ Failed to fetch tier level labels for snapshot (non-fatal)', { error: labelErr?.message });
    }

    // 3. Process each agent once (not per rule)
    for (const [agentId, agentComm] of agentCommissions) {
      logger.info('💰 Creating commission row for agent', {
        paymentId,
        agentId,
        totalAmount: agentComm.totalAmount,
        ruleIds: agentComm.ruleIds
      });
      const {
        totalAmount,
        ruleIds,
        tierLevel,
        splitPartnerId,
        splitPercentage,
        isPrimaryInSplit,
        splitRuleId
      } = agentComm;
      const payoutAgentId = agentId;

      // 3. Check if agent has AdvanceMonths configured
      const agentAdvanceMonths = await this.getAgentAdvanceMonths(payoutAgentId);
      
      // 4. Check if agent has active advance balance
      const advanceCommission = await this.getAdvanceCommissionForAgent(
        payoutAgentId,
        enrollmentId,
        householdId,
        groupId
      );

      // 5. If agent has AdvanceMonths but no advance commission exists, create one
      // Only create once per agent (track with Set)
      if (agentAdvanceMonths && agentAdvanceMonths > 0 && !advanceCommission && !agentsWithAdvanceCreated.has(payoutAgentId)) {
        agentsWithAdvanceCreated.add(payoutAgentId); // Mark this agent as having advance created
        // This is the first payment - create advance commission
        const enrollmentEffectiveDate = await this.getEnrollmentEffectiveDate(enrollmentId, groupId, householdId, paymentDate);
        
        // Calculate total advance amount: monthly commission × advance months
        // We need to sum all commission amounts for this agent from this payment
        const totalMonthlyCommission = commissionDistribution
          .filter(p => p.agentId === payoutAgentId)
          .reduce((sum, p) => sum + p.amount, 0);
        
        const totalAdvanceAmount = totalMonthlyCommission * agentAdvanceMonths;
        
        // Calculate how much of this first payment's commission goes to balance recovery
        const appliedToBalance = Math.min(totalAdvanceAmount, totalAmount);
        const newBalance = totalAdvanceAmount - appliedToBalance;
        
        // Calculate period dates (for logging/tracking only - doesn't impact payout logic)
        // PeriodStartDate = first payment date (when advance is created)
        const periodStartDate = new Date(paymentDate);
        // PeriodEndDate = x months after enrollment effective date (captures the x monthly transactions)
        const periodEndDate = this.addMonths(enrollmentEffectiveDate, agentAdvanceMonths);
        // Set to last day of that month
        const lastDay = new Date(periodEndDate.getFullYear(), periodEndDate.getMonth() + 1, 0);
        
        // Create advance commission with first payment's commission already applied to balance
        // The advance row shows the balance after the first payment is applied
        const advanceCommissionId = await this.createCommissionRow({
          agentId: payoutAgentId,
          enrollmentId,
          householdId,
          groupId,
          paymentId,
          invoiceId,
          amount: totalAdvanceAmount,
          paymentAmount: paymentAmount,
          balance: newBalance, // Balance after first payment's commission is applied
          appliedToBalance: appliedToBalance, // First payment's commission applied to balance
          status: commissionStatus, // 'Pending' for completed payments, 'Draft' for expected payments
          transactionType: 'Advance',
          originalCommissionId: null,
          periodStartDate: periodStartDate,
          periodEndDate: lastDay,
          ruleIds: null, // Advance is not tied to specific rules
          commissionTierLevelSnapshot: tierLevel ?? null,
          commissionTierLevelSnapshotLabel: tierLabelById.get(String(payoutAgentId).toUpperCase()) ?? null
        }, dryRun, transaction);
        
        createdCommissions.push(advanceCommissionId);

        // Note: We only create the advance row here. The commission row for this payment
        // will be created on the NEXT payment when we apply it to the advance balance.
        // The advance row tracks the total advance amount and initial balance.
        
        continue; // Skip to next agent - no commission row created for this payment
      }

      if (advanceCommission && advanceCommission.AdvanceBalance > 0) {
        // 4. Agent has advance balance - apply to balance first
        const balanceResult = await this.applyCommissionToBalance(
          payoutAgentId,
          totalAmount,
          advanceCommission,
          enrollmentId,
          householdId,
          groupId,
          transaction
        );
        
        // 5. Get enrollment effective date for period calculation
        const enrollmentEffectiveDate = await this.getEnrollmentEffectiveDate(enrollmentId, groupId, householdId, paymentDate);
        
        // 6. Calculate period dates (for logging/tracking only - don't impact payout logic)
        // PeriodStartDate = payment date, PeriodEndDate = 1 month after effective date
        const periodStartDate = new Date(paymentDate);
        const periodEndDate = this.addMonths(enrollmentEffectiveDate, 1);
        
        // 7. Create commission row (aggregated by agent)
        // Amount = remainingPayout (actual payout after balance recovery)
        // This can be > $0 if balance is paid off early (e.g., premium increase)
        const commissionId = await this.createCommissionRow({
          agentId: payoutAgentId,
          enrollmentId,
          householdId,
          groupId,
          paymentId,
          invoiceId,
          amount: balanceResult.remainingPayout, // Actual payout amount (after balance recovery)
          paymentAmount: paymentAmount,
          balance: balanceResult.newBalance, // Store the updated advance balance after this transaction
          appliedToBalance: balanceResult.appliedToBalance, // Amount applied to advance balance recovery
          status: commissionStatus,
          transactionType: 'Commission',
          originalCommissionId: advanceCommission.CommissionId,
          periodStartDate: periodStartDate,
          periodEndDate: periodEndDate,
          ruleIds: JSON.stringify(ruleIds), // Store as JSON array
          splitPartnerAgentId: splitPartnerId || null,
          splitPercentage: splitPercentage || null,
          isPrimaryInSplit: isPrimaryInSplit !== undefined ? isPrimaryInSplit : null,
          commissionTierLevelSnapshot: tierLevel ?? null,
          commissionTierLevelSnapshotLabel: tierLabelById.get(String(payoutAgentId).toUpperCase()) ?? null
        }, dryRun, transaction);

        createdCommissions.push(commissionId);

        // 8. If balance reached 0, mark commissions as eligible for payout (skip when dryRun)
        if (!dryRun && balanceResult.newBalance <= 0) {
          await this.markCommissionsAsEligible(advanceCommission.CommissionId, transaction);
        }

        // Note: We no longer need a separate row for remainingPayout since it's already in the commission row above
        // The commission row Amount = remainingPayout, so if remainingPayout = 0, Amount = $0
      } else {
        // 10. No advance balance - create normal commission (aggregated by agent)
        // Get enrollment effective date for period calculation
        const enrollmentEffectiveDate = await this.getEnrollmentEffectiveDate(enrollmentId, groupId, householdId, paymentDate);
        
        // Calculate period dates (based on effective date, not payment date)
        const periodStartDate = new Date(Math.min(
          new Date(enrollmentEffectiveDate).getTime(),
          new Date(paymentDate).getTime()
        ));
        const periodEndDate = this.addMonths(enrollmentEffectiveDate, 1);
        
        const commissionId = await this.createCommissionRow({
          agentId: payoutAgentId,
          enrollmentId,
          householdId,
          groupId,
          paymentId,
          invoiceId,
          amount: totalAmount,
          paymentAmount: paymentAmount,
          balance: null, // No advance balance (no advance exists or balance is 0)
          appliedToBalance: null, // No advance, so nothing applied to balance
          status: commissionStatus,
          transactionType: 'Commission',
          periodStartDate: periodStartDate,
          periodEndDate: periodEndDate,
          ruleIds: JSON.stringify(ruleIds), // Store as JSON array
          splitPartnerAgentId: splitPartnerId || null,
          splitPercentage: splitPercentage || null,
          isPrimaryInSplit: isPrimaryInSplit !== undefined ? isPrimaryInSplit : null,
          commissionTierLevelSnapshot: tierLevel ?? null,
          commissionTierLevelSnapshotLabel: tierLabelById.get(String(payoutAgentId).toUpperCase()) ?? null
        }, dryRun, transaction);

        createdCommissions.push(commissionId);
      }
    }
    
    // 11. Create commission rows for agencies (overflow commissions)
    logger.info('🏢 Processing agency commissions', {
      paymentId,
      agencyCount: agencyCommissions.size,
      agencies: Array.from(agencyCommissions.entries()).map(([key, comm]) => ({
        mapKey: key,
        agencyId: comm.agencyId,
        totalAmount: comm.totalAmount,
        ruleIds: comm.ruleIds
      }))
    });

    for (const [mapKey, agencyComm] of agencyCommissions) {
      const { agencyId, totalAmount, ruleIds, tierLevel: agencyTierLevel } = agencyComm;

      logger.info('💰 Creating commission row for agency', {
        paymentId,
        agencyId,
        mapKey,
        ruleIds,
        totalAmount
      });

      // Get enrollment effective date for period calculation
      // For group payments, enrollmentId may be null, so pass groupId and householdId as fallbacks
      const enrollmentEffectiveDate = await this.getEnrollmentEffectiveDate(enrollmentId, groupId, householdId, paymentDate);

      // Calculate period dates (based on effective date, not payment date)
      const periodStartDate = new Date(Math.min(
        new Date(enrollmentEffectiveDate).getTime(),
        new Date(paymentDate).getTime()
      ));
      const periodEndDate = this.addMonths(enrollmentEffectiveDate, 1);

      // Create commission row for agency. RuleIds populated when the row came
      // from a Tier or Override rule; null for primary-agency overflow.
      const commissionId = await this.createCommissionRow({
        agentId: null, // No AgentId for agencies
        agencyId: agencyId, // Use AgencyId instead
        enrollmentId,
        householdId,
        groupId,
        paymentId,
        invoiceId,
        amount: totalAmount,
        paymentAmount: paymentAmount,
        balance: null, // Agencies don't have advance balances
        appliedToBalance: null, // No advance, so nothing applied to balance
        status: commissionStatus,
        transactionType: 'Commission',
        periodStartDate: periodStartDate,
        periodEndDate: periodEndDate,
        ruleIds: Array.isArray(ruleIds) && ruleIds.length > 0 ? JSON.stringify(ruleIds) : null,
        splitPartnerAgentId: null,
        splitPercentage: null,
        isPrimaryInSplit: null,
        commissionTierLevelSnapshot: agencyTierLevel ?? null,
        commissionTierLevelSnapshotLabel: tierLabelById.get(String(agencyId).toUpperCase()) ?? null
      }, dryRun, transaction);

      createdCommissions.push(commissionId);
    }

    return createdCommissions;
  }

  /**
   * Calculate commission distribution using commission rules
   * Uses the same logic as NACHA service - distributes the allocated commission pool from oe.Payments
   */
  static async calculateCommissionDistribution(
    paymentId,
    enrollmentId,
    productId,
    paymentAmount,
    agentId,
    tenantId,
    commission = null, // Commission (Agent Commission Pool) from oe.Payments
    overrideRate = 0, // OverrideRate from oe.Payments (100% goes to tenant/product owner)
    netRate = null, // NetRate from oe.Payments (100% goes to vendor)
    householdId = null, // HouseholdId for split rule filtering
    groupId = null, // GroupId for split rule filtering
    paymentDate = null, // Payment date (used to determine which rules are effective)
    enrollmentProductIds = null, // ProductIds from enrollments (component products, not bundle IDs)
    productCommissionAmounts = null, // Map<ProductId, CommissionAmount> - commission per product from enrollments
    productTier = null, // Product tier (EE, ES, EC, EF) from member's Tier field
    productEnrollmentCounts = null // Map<ProductId, enrollmentCount> - enrollment count per product from ProductCommissions JSON
  ) {
    // CommissionCalculatorService is a singleton instance, not a class
    // Use the same parameters as NACHA service to ensure consistency
    const commissionCalculator = CommissionCalculatorService;
    const calculation = await commissionCalculator.calculateCommissions(
      paymentId,
      productId,
      paymentAmount,
      agentId,
      tenantId,
      enrollmentId, // Pass enrollmentId for fallback calculation
      overrideRate, // Pass OverrideRate (100% goes to tenant/product owner)
      commission, // Use Commission (Agent Commission Pool) from oe.Payments
      netRate, // Use NetRate (100% goes to vendor)
      householdId, // Pass HouseholdId for split rule filtering
      groupId, // Pass GroupId for split rule filtering
      paymentDate, // Pass paymentDate for historical context
      false, // allowUnlockedRules: false for production - only locked rules are applied
      null, // overrideAgentRuleId
      productTier, // Pass product tier (EE, ES, EC, EF) for tier-specific commission amounts
      enrollmentProductIds, // Pass enrollment ProductIds for rule lookup
      productCommissionAmounts, // Pass commission amounts per product
      productEnrollmentCounts, // Pass enrollment counts per product from ProductCommissions JSON
      false // useCurrentDateForRuleEffectiveness: false - rule effectiveness vs payment date (EffectiveDate <= payment date, TerminationDate >= payment date)
    );

    logger.info('🔄 Processing commission calculation result into distribution', {
      paymentId,
      hasDistribution: !!calculation.distribution,
      agentsCount: calculation.distribution?.agents?.length || 0,
      tenantsCount: calculation.distribution?.tenants?.length || 0,
      vendorsCount: calculation.distribution?.vendors?.length || 0,
      totalCommissionsPaid: calculation.totalCommissionsPaid,
      remainingAmount: calculation.remainingAmount
    });

    const distribution = [];
    if (calculation.distribution && calculation.distribution.agents) {
      logger.info('👤 Processing agent payouts', {
        paymentId,
        agentPayoutsCount: calculation.distribution.agents.length,
        agentPayouts: calculation.distribution.agents.map(ap => ({
          agentId: ap.agentId,
          amount: ap.amount,
          ruleId: ap.ruleId,
          ruleName: ap.ruleName,
          tierLevel: ap.tierLevel
        }))
      });

      for (const agentPayout of calculation.distribution.agents) {
        distribution.push({
          agentId: agentPayout.agentId,
          amount: agentPayout.amount,
          ruleId: agentPayout.ruleId,
          ruleName: agentPayout.ruleName,
          tierLevel: agentPayout.tierLevel,
          // Split commission details (if applicable)
          splitAmount: agentPayout.splitAmount || null,
          splitPartnerId: agentPayout.splitPartnerId || null,
          isSplitPartner: agentPayout.isSplitPartner || false,
          splitFromAgentId: agentPayout.splitFromAgentId || null,
          splitRuleId: agentPayout.splitRuleId || null,
          splitPercentage: agentPayout.splitPercentage || null, // Percentage from rule configuration
          isPrimaryInSplit: agentPayout.isPrimaryInSplit !== undefined ? agentPayout.isPrimaryInSplit : null
        });
      }
    } else {
      logger.warn('⚠️ No agent payouts in calculation distribution', {
        paymentId,
        hasDistribution: !!calculation.distribution
      });
    }
    
    // Also include agency overflow payouts (from tenants breakdown)
    // Agencies receive overflow from commission pool and should be stored in oe.Commissions with AgencyId
    if (calculation.distribution && calculation.distribution.tenants) {
      logger.info('🏢 Processing tenant/agency payouts', {
        paymentId,
        tenantPayoutsCount: calculation.distribution.tenants.length,
        tenantPayouts: calculation.distribution.tenants.map(tp => ({
          tenantId: tp.tenantId,
          amount: tp.amount,
          isPrimaryAgency: tp.isPrimaryAgency,
          isOverflow: tp.isOverflow,
          ruleName: tp.ruleName
        }))
      });

      for (const tenantPayout of calculation.distribution.tenants) {
        // Any row whose recipient is an agency persists into oe.Commissions.
        // Three sources land here today: primary-agency overflow, Override-rule
        // agency emit, and tier-slot agency emit. They share the array;
        // entityType: 'Agency' identifies them. Real-tenant rows (entityType
        // 'Tenant' / undefined) are not commission recipients on this side.
        const isAgencyRow = tenantPayout.entityType === 'Agency'
          || (tenantPayout.isPrimaryAgency && tenantPayout.isOverflow);
        if (isAgencyRow) {
          logger.info('💰 Adding agency payout to distribution', {
            paymentId,
            agencyId: tenantPayout.tenantId,
            amount: tenantPayout.amount,
            ruleId: tenantPayout.ruleId,
            isPrimaryAgency: !!tenantPayout.isPrimaryAgency,
            isOverride: !!tenantPayout.isOverride,
            isOverflow: !!tenantPayout.isOverflow
          });
          distribution.push({
            agencyId: tenantPayout.tenantId, // tenantId field carries AgencyId
            agentId: null,
            amount: tenantPayout.amount,
            ruleId: tenantPayout.ruleId || null,
            ruleName: tenantPayout.ruleName || (tenantPayout.isOverflow ? 'Overflow' : null),
            // != null guard so legitimate level 0 doesn't get dropped to null
            // by `||` falsy collapse.
            tierLevel: tenantPayout.tierLevel != null ? tenantPayout.tierLevel : null,
            isAgencyOverflow: true, // existing flag — treated as agency-row gate downstream
            isOverflow: !!tenantPayout.isOverflow
          });
        } else {
          logger.info('⏭️ Skipping tenant payout (not an agency row)', {
            paymentId,
            tenantId: tenantPayout.tenantId,
            amount: tenantPayout.amount,
            entityType: tenantPayout.entityType,
            isPrimaryAgency: tenantPayout.isPrimaryAgency,
            isOverflow: tenantPayout.isOverflow
          });
        }
      }
    }

    logger.info('✅ Final distribution array', {
      paymentId,
      distributionCount: distribution.length,
      distribution: distribution.map(d => ({
        agentId: d.agentId,
        agencyId: d.agencyId,
        amount: d.amount,
        ruleId: d.ruleId,
        ruleName: d.ruleName,
        isAgencyOverflow: d.isAgencyOverflow
      }))
    });

    return distribution;
  }

  /**
   * Get advance commission for an agent
   */
  static async getAdvanceCommissionForAgent(agentId, enrollmentId, householdId, groupId) {
    const pool = await getPool();
    const request = pool.request();

    request.input('AgentId', sql.UniqueIdentifier, agentId);
    request.input('EnrollmentId', sql.UniqueIdentifier, enrollmentId);
    request.input('HouseholdId', sql.UniqueIdentifier, householdId);
    request.input('GroupId', sql.UniqueIdentifier, groupId);

    const result = await request.query(`
      SELECT TOP 1
        CommissionId,
        Amount,
        AdvanceBalance,
        PeriodStartDate,
        PeriodEndDate
      FROM oe.Commissions
      WHERE AgentId = @AgentId
        AND TransactionType = 'Advance'
        AND AdvanceBalance > 0
        AND (
          EnrollmentId = @EnrollmentId
          OR HouseholdId = @HouseholdId
          OR GroupId = @GroupId
        )
      ORDER BY CreatedDate DESC
    `);

    return result.recordset.length > 0 ? result.recordset[0] : null;
  }

  /**
   * Apply commission to advance balance
   */
  static async applyCommissionToBalance(agentId, commissionAmount, advanceCommission, enrollmentId, householdId, groupId, transaction = null) {
    const currentBalance = parseFloat(advanceCommission.AdvanceBalance);
    const appliedToBalance = Math.min(currentBalance, commissionAmount);
    const newBalance = currentBalance - appliedToBalance;
    const remainingPayout = commissionAmount - appliedToBalance;

    const pool = await getPool();
    const request = transaction ? new mssql.Request(transaction) : pool.request();

    request.input('CommissionId', sql.UniqueIdentifier, advanceCommission.CommissionId);
    request.input('AppliedAmount', sql.Decimal(18, 2), appliedToBalance);

    await request.query(`
      UPDATE oe.Commissions
      SET AdvanceBalance = AdvanceBalance - @AppliedAmount
      WHERE CommissionId = @CommissionId
    `);

    return {
      appliedToBalance,
      remainingPayout,
      newBalance
    };
  }

  /**
   * Get agent advance months configuration
   * @param {string} agentId - Agent ID
   * @returns {Promise<number|null>} Advance months (1-12) or null if disabled
   */
  static async getAgentAdvanceMonths(agentId) {
    const pool = await getPool();
    const request = pool.request();

    request.input('AgentId', sql.UniqueIdentifier, agentId);

    const result = await request.query(`
      SELECT AdvanceMonths
      FROM oe.Agents
      WHERE AgentId = @AgentId
    `);

    if (result.recordset.length === 0) {
      return null;
    }

    return result.recordset[0].AdvanceMonths; // NULL or 1-12
  }

  /**
   * Get enrollment effective date for period calculations
   * @param {string} enrollmentId - Enrollment ID (optional for group payments)
   * @param {string} groupId - Group ID (optional, used as fallback if enrollmentId is null)
   * @param {string} householdId - Household ID (optional, used as fallback if enrollmentId is null)
   * @param {Date} paymentDate - Payment date (used as fallback if no enrollment found)
   * @returns {Promise<Date>} Effective date
   */
  static async getEnrollmentEffectiveDate(enrollmentId, groupId = null, householdId = null, paymentDate = null) {
    const pool = await getPool();
    
    // If enrollmentId is provided, use it
    if (enrollmentId) {
    const request = pool.request();
    request.input('EnrollmentId', sql.UniqueIdentifier, enrollmentId);
    const result = await request.query(`
      SELECT EffectiveDate
      FROM oe.Enrollments
      WHERE EnrollmentId = @EnrollmentId
    `);

      if (result.recordset.length > 0) {
        return result.recordset[0].EffectiveDate;
      }
    }

    // If no enrollmentId but groupId is provided, get from group enrollments
    if (!enrollmentId && groupId) {
      const groupRequest = pool.request();
      groupRequest.input('GroupId', sql.UniqueIdentifier, groupId);
      const groupResult = await groupRequest.query(`
        SELECT TOP 1 e.EffectiveDate
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @GroupId
          AND e.Status = 'Active'
        ORDER BY e.CreatedDate DESC
      `);
      
      if (groupResult.recordset.length > 0) {
        return groupResult.recordset[0].EffectiveDate;
      }
    }

    // If no enrollmentId but householdId is provided, get from household enrollments
    if (!enrollmentId && householdId) {
      const householdRequest = pool.request();
      householdRequest.input('HouseholdId', sql.UniqueIdentifier, householdId);
      const householdResult = await householdRequest.query(`
        SELECT TOP 1 EffectiveDate
        FROM oe.Enrollments
        WHERE HouseholdId = @HouseholdId
          AND Status = 'Active'
        ORDER BY CreatedDate DESC
      `);
      
      if (householdResult.recordset.length > 0) {
        return householdResult.recordset[0].EffectiveDate;
      }
    }

    // Fallback to payment date if no enrollment found
    if (paymentDate) {
      logger.warn('No enrollment found for effective date - using payment date', { enrollmentId, groupId, householdId });
      return paymentDate;
    }

    // Last resort: throw error
    throw new Error(`Enrollment not found: ${enrollmentId || 'null'} (groupId: ${groupId}, householdId: ${householdId})`);
  }

  /**
   * Add months to a date
   */
  static addMonths(date, months) {
    const result = new Date(date);
    result.setMonth(result.getMonth() + months);
    return result;
  }

  /**
   * Create commission row
   * Note: Percentage field is for reporting/audit only - commission rules already define percentages/flat amounts
   * @param {Object} commissionData - Row data
   * @param {boolean} [dryRun] - If true, do not INSERT; return preview object { commissionId, paymentId, amount, ... }
   * @returns {Promise<string|Object>} CommissionId (string) or when dryRun: preview object
   */
  /**
   * Apply agent-to-agent overrides to a payment's commission rows.
   *
   * For each active override where SourceAgentId earned commission on this payment,
   * writes two paired rows:
   *   1) -X for the source agent (deduction)
   *   2) +X for the recipient agent (credit)
   * Both carry TransactionType = 'Commission' and RuleIds = 'AGENT_OVERRIDE:<id>' so
   * NACHA naturally nets them against each agent's payout.
   *
   * Safe to call even if oe.AgentCommissionOverrides doesn't exist yet — no-ops.
   *
   * @returns {Promise<{ createdCommissionIds: string[], dryRunRows: Object[], applied: Array, skipped: Array }>}
   */
  static async resolveAgentOverrides({
    paymentId,
    tenantId,
    paymentDate,
    householdId = null,
    groupId = null,
    commissionStatus = 'Pending',
    dryRun = false,
    transaction = null,
    dryRunRows = null
  }) {
    const empty = { createdCommissionIds: [], dryRunRows: [], applied: [], skipped: [] };
    if (!tenantId || !paymentId) {
      return empty;
    }

    const pool = await getPool();

    // Step 1: per-agent commission totals on this payment, excluding prior override rows.
    const agentTotals = new Map();
    if (dryRun && Array.isArray(dryRunRows)) {
      for (const r of dryRunRows) {
        if (!r || !r.agentId) continue;
        if (typeof r.ruleIds === 'string' && r.ruleIds.startsWith('AGENT_OVERRIDE:')) continue;
        const prev = agentTotals.get(r.agentId) || 0;
        agentTotals.set(r.agentId, prev + Number(r.amount || 0));
      }
    } else {
      const sumReq = transaction ? new mssql.Request(transaction) : pool.request();
      sumReq.input('PaymentId', sql.UniqueIdentifier, paymentId);
      const sumRes = await sumReq.query(`
        SELECT AgentId, SUM(Amount) AS Total
        FROM oe.Commissions
        WHERE PaymentId = @PaymentId
          AND Status <> 'Deleted'
          AND AgentId IS NOT NULL
          AND (RuleIds IS NULL OR RuleIds NOT LIKE 'AGENT_OVERRIDE:%')
        GROUP BY AgentId
      `);
      for (const row of sumRes.recordset || []) {
        agentTotals.set(row.AgentId, Number(row.Total || 0));
      }
    }

    if (agentTotals.size === 0) {
      return empty;
    }

    // Step 2: load active overrides whose SourceAgentId earned on this payment.
    const sourceAgentIds = Array.from(agentTotals.keys()).filter(
      (id) => (agentTotals.get(id) || 0) > 0
    );
    if (sourceAgentIds.length === 0) {
      return empty;
    }

    const ovReq = transaction ? new mssql.Request(transaction) : pool.request();
    ovReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    ovReq.input('PaymentDate', sql.Date, paymentDate || new Date());
    const placeholders = sourceAgentIds
      .map((id, i) => {
        ovReq.input(`SrcAgent${i}`, sql.UniqueIdentifier, id);
        return `@SrcAgent${i}`;
      })
      .join(', ');

    let overrides = [];
    try {
      const ovRes = await ovReq.query(`
        SELECT
          OverrideId,
          SourceAgentId,
          RecipientAgentId,
          OverrideType,
          OverrideAmount,
          OverridePercentage
        FROM oe.AgentCommissionOverrides
        WHERE TenantId = @TenantId
          AND Status = 'Active'
          AND SourceAgentId IN (${placeholders})
          AND (EffectiveDate IS NULL OR EffectiveDate <= @PaymentDate)
          AND (TerminationDate IS NULL OR TerminationDate >= @PaymentDate)
        ORDER BY CreatedDate ASC
      `);
      overrides = ovRes.recordset || [];
    } catch (err) {
      if (err && err.message && /Invalid object name|AgentCommissionOverrides/i.test(err.message)) {
        logger.warn('oe.AgentCommissionOverrides not present — skipping agent overrides', { paymentId });
        return empty;
      }
      throw err;
    }

    if (overrides.length === 0) {
      return empty;
    }

    const createdCommissionIds = [];
    const previewRows = [];
    const applied = [];
    const skipped = [];

    for (const ov of overrides) {
      const sourceTotal = agentTotals.get(ov.SourceAgentId) || 0;
      let amount = 0;
      if (ov.OverrideType === 'Fixed') {
        amount = Number(ov.OverrideAmount || 0);
      } else if (ov.OverrideType === 'Percentage') {
        amount = Math.round((sourceTotal * Number(ov.OverridePercentage || 0) / 100) * 100) / 100;
      }

      if (amount <= 0) {
        skipped.push({
          overrideId: ov.OverrideId,
          sourceAgentId: ov.SourceAgentId,
          recipientAgentId: ov.RecipientAgentId,
          amount: 0,
          reason: 'Computed override amount is zero'
        });
        continue;
      }

      if (amount > sourceTotal) {
        skipped.push({
          overrideId: ov.OverrideId,
          sourceAgentId: ov.SourceAgentId,
          recipientAgentId: ov.RecipientAgentId,
          amount,
          sourceTotal,
          reason: `Source agent commission (${sourceTotal.toFixed(2)}) is less than override amount (${amount.toFixed(2)})`
        });
        continue;
      }

      // Decrement running total so subsequent overrides stacking on the same source agent
      // never combine to exceed the source agent's actual commission.
      agentTotals.set(ov.SourceAgentId, sourceTotal - amount);

      const ruleIds = `AGENT_OVERRIDE:${ov.OverrideId}`;

      const negResult = await this.createCommissionRow({
        paymentId,
        agentId: ov.SourceAgentId,
        amount: -amount,
        status: commissionStatus,
        transactionType: 'Commission',
        householdId: householdId || null,
        groupId: groupId || null,
        periodStartDate: null,
        periodEndDate: null,
        ruleIds
      }, dryRun, transaction);

      const posResult = await this.createCommissionRow({
        paymentId,
        agentId: ov.RecipientAgentId,
        amount: amount,
        status: commissionStatus,
        transactionType: 'Commission',
        householdId: householdId || null,
        groupId: groupId || null,
        periodStartDate: null,
        periodEndDate: null,
        ruleIds
      }, dryRun, transaction);

      if (dryRun) {
        if (negResult) previewRows.push(negResult);
        if (posResult) previewRows.push(posResult);
      } else {
        if (negResult) createdCommissionIds.push(negResult);
        if (posResult) createdCommissionIds.push(posResult);
      }

      applied.push({
        overrideId: ov.OverrideId,
        sourceAgentId: ov.SourceAgentId,
        recipientAgentId: ov.RecipientAgentId,
        overrideType: ov.OverrideType,
        amount
      });

      logger.info('Agent override applied', {
        paymentId,
        overrideId: ov.OverrideId,
        sourceAgentId: ov.SourceAgentId,
        recipientAgentId: ov.RecipientAgentId,
        overrideType: ov.OverrideType,
        amount
      });
    }

    return { createdCommissionIds, dryRunRows: previewRows, applied, skipped };
  }

  static async createCommissionRow(commissionData, dryRun = false, transaction = null) {
    const commissionId = require('crypto').randomUUID();
    const row = {
      commissionId,
      paymentId: commissionData.paymentId,
      invoiceId: commissionData.invoiceId || null,
      amount: commissionData.amount,
      agentId: commissionData.agentId || null,
      agencyId: commissionData.agencyId || null,
      transactionType: commissionData.transactionType,
      status: commissionData.status,
      enrollmentId: commissionData.enrollmentId || null,
      householdId: commissionData.householdId || null,
      groupId: commissionData.groupId || null,
      periodStartDate: commissionData.periodStartDate || null,
      periodEndDate: commissionData.periodEndDate || null,
      ruleIds: commissionData.ruleIds || null,
      commissionTierLevelSnapshot: commissionData.commissionTierLevelSnapshot ?? null,
      commissionTierLevelSnapshotLabel: commissionData.commissionTierLevelSnapshotLabel ?? null
    };
    if (dryRun) {
      return row;
    }
    const pool = await getPool();
    const request = transaction ? new mssql.Request(transaction) : pool.request();

    request.input('CommissionId', sql.UniqueIdentifier, commissionId);
    request.input('AgentId', sql.UniqueIdentifier, commissionData.agentId || null);
    request.input('AgencyId', sql.UniqueIdentifier, commissionData.agencyId || null);
    request.input('EnrollmentId', sql.UniqueIdentifier, commissionData.enrollmentId || null);
    request.input('HouseholdId', sql.UniqueIdentifier, commissionData.householdId);
    request.input('GroupId', sql.UniqueIdentifier, commissionData.groupId);
    request.input('PaymentId', sql.UniqueIdentifier, commissionData.paymentId);
    request.input('InvoiceId', sql.UniqueIdentifier, commissionData.invoiceId || null);
    request.input('Amount', sql.Decimal(18, 2), commissionData.amount);
    request.input('AdvanceBalance', sql.Decimal(18, 2), commissionData.balance); // Renamed from Balance
    request.input('Status', sql.NVarChar, commissionData.status);
    request.input('TransactionType', sql.NVarChar, commissionData.transactionType);
    request.input('OriginalCommissionId', sql.UniqueIdentifier, commissionData.originalCommissionId);
    request.input('PeriodStartDate', sql.Date, commissionData.periodStartDate);
    request.input('PeriodEndDate', sql.Date, commissionData.periodEndDate);
    request.input('RuleIds', sql.NVarChar(sql.MAX), commissionData.ruleIds || null); // JSON array of RuleIds
    request.input('AppliedToBalance', sql.Decimal(18, 2), commissionData.appliedToBalance || null); // Amount applied to advance balance recovery
    request.input('SplitPartnerAgentId', sql.UniqueIdentifier, commissionData.splitPartnerAgentId || null); // Split partner agent ID
    request.input('SplitPercentage', sql.Decimal(5, 4), commissionData.splitPercentage || null); // Split percentage (0.4000 = 40%)
    request.input('IsPrimaryInSplit', sql.Bit, commissionData.isPrimaryInSplit !== undefined ? commissionData.isPrimaryInSplit : null); // true = primary, false = partner, null = not split
    request.input('CommissionTierLevel_Snapshot', sql.Decimal(9,4), commissionData.commissionTierLevelSnapshot ?? null);
    request.input('CommissionTierLevel_Snapshot_Label', sql.NVarChar(200), commissionData.commissionTierLevelSnapshotLabel ?? null);

    await request.query(`
      INSERT INTO oe.Commissions (
        CommissionId, AgentId, AgencyId, EnrollmentId, HouseholdId, GroupId,
        PaymentId, InvoiceId, Amount, AdvanceBalance, AppliedToBalance, Status, TransactionType,
        OriginalCommissionId, PeriodStartDate, PeriodEndDate,
        RuleIds, SplitPartnerAgentId, SplitPercentage, IsPrimaryInSplit,
        CommissionTierLevel_Snapshot, CommissionTierLevel_Snapshot_Label, CreatedDate
      ) VALUES (
        @CommissionId, @AgentId, @AgencyId, @EnrollmentId, @HouseholdId, @GroupId,
        @PaymentId, @InvoiceId, @Amount, @AdvanceBalance, @AppliedToBalance, @Status, @TransactionType,
        @OriginalCommissionId, @PeriodStartDate, @PeriodEndDate,
        @RuleIds, @SplitPartnerAgentId, @SplitPercentage, @IsPrimaryInSplit,
        @CommissionTierLevel_Snapshot, @CommissionTierLevel_Snapshot_Label, GETDATE()
      )
    `);

    return commissionId;
  }

  /**
   * Mark commissions as eligible for payout
   */
  static async markCommissionsAsEligible(advanceCommissionId, transaction = null) {
    const pool = await getPool();
    const request = transaction ? new mssql.Request(transaction) : pool.request();

    request.input('OriginalCommissionId', sql.UniqueIdentifier, advanceCommissionId);

    await request.query(`
      UPDATE oe.Commissions
      SET Status = 'Pending'
      WHERE OriginalCommissionId = @OriginalCommissionId
        AND Status = 'Pending'
        AND AdvanceBalance IS NULL
    `);
  }

  /**
   * Get enrollments for household/group
   */
  static async getEnrollmentsForHousehold(householdId, groupId) {
    const pool = await getPool();
    const request = pool.request();

    if (householdId) {
      request.input('HouseholdId', sql.UniqueIdentifier, householdId);
      const result = await request.query(`
        SELECT 
          e.EnrollmentId, 
          e.ProductId, 
          e.AgentId,
          COALESCE(g.TenantId, p.ProductOwnerId) as TenantId
        FROM oe.Enrollments e
        INNER JOIN oe.Products p ON e.ProductId = p.ProductId
        LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        WHERE e.HouseholdId = @HouseholdId
          AND e.Status = 'Active'
      `);
      return result.recordset;
    } else if (groupId) {
      request.input('GroupId', sql.UniqueIdentifier, groupId);
      const result = await request.query(`
        SELECT 
          e.EnrollmentId, 
          e.ProductId, 
          e.AgentId,
          COALESCE(g.TenantId, p.ProductOwnerId) as TenantId
        FROM oe.Enrollments e
        INNER JOIN oe.Products p ON e.ProductId = p.ProductId
        LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Groups g ON COALESCE(e.GroupId, m.GroupId) = g.GroupId
        WHERE (e.GroupId = @GroupId OR m.GroupId = @GroupId)
          AND e.Status = 'Active'
      `);
      return result.recordset;
    }

    return [];
  }

  /**
   * Get payment-level expected payout chain summary (selling agent + uplines).
   * Uses the same dry-run commission generation path as "Generate missing".
   * @param {string} paymentId
   * @param {object} [options]
   * @param {boolean} [options.allowExistingCommissions] - when true, include payments that already have commissions
   * @returns {Promise<object|null>}
   */
  static async getPaymentPayoutChainSummary(paymentId, options = {}) {
    const allowExistingCommissions = options.allowExistingCommissions === true;
    const existingCommissionsClause = allowExistingCommissions
      ? ''
      : `AND NOT EXISTS (SELECT 1 FROM oe.Commissions c WHERE c.PaymentId = p.PaymentId AND c.Status != 'Deleted')`;
    const pool = await getPool();
    const req = pool.request();
    req.input('PaymentId', sql.UniqueIdentifier, paymentId);
    const paymentResult = await req.query(`
      SELECT
        p.PaymentId,
        p.AgentId,
        p.PaymentDate,
        p.Amount,
        -- Invoice-sourced payouts: prefer invoice breakdowns with payment fallback
        COALESCE(inv.Commission, p.Commission) AS Commission,
        COALESCE(inv.OverrideRate, p.OverrideRate) AS OverrideRate,
        COALESCE(inv.NetRate, p.NetRate) AS NetRate,
        p.HouseholdId,
        p.GroupId,
        a.TenantId
      FROM oe.Payments p
      INNER JOIN oe.Agents a ON p.AgentId = a.AgentId
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      WHERE p.PaymentId = @PaymentId
        AND p.Status IN ('Completed', 'Draft', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded')
        AND p.AgentId IS NOT NULL
        AND COALESCE(inv.Commission, p.Commission) IS NOT NULL
        AND COALESCE(inv.Commission, p.Commission) > 0
        AND a.Status = 'Active'
        ${existingCommissionsClause}
    `);

    if (!paymentResult.recordset?.length) return null;
    const payment = paymentResult.recordset[0];
    const sellingAgentId = payment.AgentId?.toString() || null;
    if (!sellingAgentId) return null;

    const dryRunResult = await this.createCommissionsForPayment({
      paymentId: payment.PaymentId,
      householdId: payment.GroupId ? null : payment.HouseholdId,
      groupId: payment.GroupId,
      paymentDate: payment.PaymentDate,
      productId: null,
      paymentAmount: parseFloat(payment.Amount) || 0,
      agentId: sellingAgentId,
      tenantId: payment.TenantId ? payment.TenantId.toString() : null,
      commission: payment.Commission != null ? parseFloat(payment.Commission) : null,
      overrideRate: payment.OverrideRate != null ? parseFloat(payment.OverrideRate) : 0,
      netRate: payment.NetRate != null ? parseFloat(payment.NetRate) : null,
      commissionStatus: 'Pending',
      dryRun: true
    });

    const rows = (dryRunResult?.dryRunRows || []).filter((r) => !r?._previewError);
    const agentTotals = new Map();
    let hasAgencyPayout = false;
    let agencyExpectedTotal = 0;
    for (const row of rows) {
      const amount = Number(row?.amount || 0);
      if (!(amount > 0)) continue;
      const agentId = row?.agentId ? row.agentId.toString() : null;
      if (agentId) {
        const key = agentId.toUpperCase();
        agentTotals.set(key, Number((agentTotals.get(key) || 0) + amount));
      } else if (row?.agencyId) {
        hasAgencyPayout = true;
        agencyExpectedTotal += amount;
      }
    }

    const sellingKey = sellingAgentId.toUpperCase();
    const sellingAgentExpectedAmount = Number(agentTotals.get(sellingKey) || 0);
    const uplineIds = Array.from(agentTotals.keys()).filter((id) => id !== sellingKey);

    const agentMetaById = new Map();
    if (uplineIds.length > 0) {
      const metaReq = pool.request();
      const idParams = uplineIds.map((id, idx) => {
        const param = `UplineAgentId${idx}`;
        metaReq.input(param, sql.UniqueIdentifier, id);
        return `@${param}`;
      });
      const metaResult = await metaReq.query(`
        SELECT
          a.AgentId,
          COALESCE(cl.SortOrder, a.CommissionTierLevel) AS CommissionTierLevel,
          u.FirstName + ' ' + u.LastName AS AgentName
        FROM oe.Agents a
        LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
        LEFT JOIN oe.Users u ON a.UserId = u.UserId
        WHERE a.AgentId IN (${idParams.join(', ')})
      `);
      for (const rec of metaResult.recordset || []) {
        const key = rec.AgentId?.toString()?.toUpperCase();
        if (!key) continue;
        agentMetaById.set(key, {
          agentName: rec.AgentName || 'Unknown',
          tierLevel: rec.CommissionTierLevel != null ? Number(rec.CommissionTierLevel) : null
        });
      }
    }

    const uplineExpectedAmounts = uplineIds
      .map((id) => ({
        agentId: id,
        agentName: agentMetaById.get(id)?.agentName || 'Unknown',
        tierLevel: agentMetaById.get(id)?.tierLevel ?? null,
        amount: Number(agentTotals.get(id) || 0)
      }))
      .filter((row) => row.amount > 0)
      .sort((a, b) => {
        const at = a.tierLevel == null ? 999 : a.tierLevel;
        const bt = b.tierLevel == null ? 999 : b.tierLevel;
        if (at !== bt) return at - bt;
        return b.amount - a.amount;
      });

    const sellingAgentZeroPayout = sellingAgentExpectedAmount <= 0.005;
    let zeroPayoutReason = null;
    if (sellingAgentZeroPayout) {
      if (uplineExpectedAmounts.length > 0) {
        zeroPayoutReason = 'Selling agent receives $0 while payout allocates to uplines.';
      } else if (hasAgencyPayout) {
        zeroPayoutReason = 'No applicable selling-agent payout; commission overflows to agency.';
      } else {
        zeroPayoutReason = 'No applicable commission payout for this selling agent.';
      }
    }

    const uplineExpectedTotal = Number(
      uplineExpectedAmounts.reduce((sum, row) => sum + Number(row.amount || 0), 0)
    );

    return {
      paymentId: payment.PaymentId?.toString() || paymentId,
      sellingAgentId: sellingAgentId.toUpperCase(),
      sellingAgentExpectedAmount,
      uplineExpectedAmounts,
      uplineExpectedTotal,
      agencyExpectedTotal,
      sellingAgentZeroPayout,
      zeroPayoutReason
    };
  }

  /**
   * Get per-product commission breakdown preview for a payment (who gets paid what for each product).
   * Used by GenerateCommissionsPreviewModal "Details" button.
   * @param {string} paymentId - Payment ID
   * @param {object} [options]
   * @param {boolean} [options.allowExistingCommissions] - When true (e.g. agent portal after commissions generated), skip the "no oe.Commissions rows yet" filter so the same per-product breakdown can be shown for posted payments.
   * @returns {Promise<Object>} { paymentId, paymentDate, amount, commission, agentName, products: [{ productId, productName, commissionAmount, breakdown: [{ recipientName, amount, ruleName, tierLevel }] }] }
   */
  static async getPaymentBreakdownPreview(paymentId, options = {}) {
    const allowExistingCommissions = options.allowExistingCommissions === true;
    const existingCommissionsClause = allowExistingCommissions
      ? ''
      : `AND NOT EXISTS (SELECT 1 FROM oe.Commissions c WHERE c.PaymentId = p.PaymentId AND c.Status != 'Deleted')`;
    const pool = await getPool();
    const paymentRequest = pool.request();
    paymentRequest.input('PaymentId', sql.UniqueIdentifier, paymentId);
    const paymentResult = await paymentRequest.query(`
      SELECT
        p.PaymentId,
        p.AgentId,
        p.PaymentDate,
        p.Amount,
        -- Invoice-sourced payouts: prefer invoice breakdowns with payment fallback
        COALESCE(inv.Commission, p.Commission) AS Commission,
        COALESCE(inv.OverrideRate, p.OverrideRate) AS OverrideRate,
        COALESCE(inv.NetRate, p.NetRate) AS NetRate,
        p.HouseholdId,
        p.GroupId,
        COALESCE(inv.ProductCommissions, p.ProductCommissions) AS ProductCommissions,
        COALESCE(cl.SortOrder, a.CommissionTierLevel) AS AgentCommissionTierLevel,
        u.FirstName + ' ' + u.LastName AS AgentName
      FROM oe.Payments p
      INNER JOIN oe.Agents a ON p.AgentId = a.AgentId
      LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
      INNER JOIN oe.Users u ON a.UserId = u.UserId
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      WHERE p.PaymentId = @PaymentId
        AND p.Status IN ('Completed', 'Draft', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded')
        AND p.AgentId IS NOT NULL
        AND COALESCE(inv.Commission, p.Commission) IS NOT NULL
        AND COALESCE(inv.Commission, p.Commission) > 0
        AND a.Status = 'Active'
        ${existingCommissionsClause}
    `);

    if (!paymentResult.recordset || paymentResult.recordset.length === 0) {
      return null;
    }

    const row = paymentResult.recordset[0];
    const agentId = row.AgentId?.toString();
    if (!agentId) return null;

    const tenantResult = await pool.request().input('AgentId', sql.UniqueIdentifier, agentId).query(`SELECT TenantId, AgencyId FROM oe.Agents WHERE AgentId = @AgentId`);
    const agentRow = tenantResult.recordset[0];
    let tenantId = agentRow?.TenantId != null ? agentRow.TenantId.toString() : null;
    if (!tenantId && agentRow?.AgencyId) {
      const agencyTenant = await pool.request().input('AgencyId', sql.UniqueIdentifier, agentRow.AgencyId).query(`SELECT TenantId FROM oe.Agencies WHERE AgencyId = @AgencyId`);
      tenantId = agencyTenant.recordset[0]?.TenantId != null ? agencyTenant.recordset[0].TenantId.toString() : null;
    }
    if (!tenantId && (row.HouseholdId || row.GroupId)) {
      const enrollReq = pool.request();
      let enrollTenant;
      if (row.HouseholdId) {
        enrollReq.input('HouseholdId', sql.UniqueIdentifier, row.HouseholdId);
        enrollTenant = await enrollReq.query(
          `SELECT TOP 1 COALESCE(g.TenantId, p.ProductOwnerId) as TenantId FROM oe.Enrollments e INNER JOIN oe.Products p ON e.ProductId = p.ProductId LEFT JOIN oe.Members m ON e.MemberId = m.MemberId LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId WHERE e.HouseholdId = @HouseholdId AND e.Status = 'Active'`
        );
      } else {
        enrollReq.input('GroupId', sql.UniqueIdentifier, row.GroupId);
        enrollTenant = await enrollReq.query(
          `SELECT TOP 1 COALESCE(g.TenantId, p.ProductOwnerId) as TenantId FROM oe.Enrollments e INNER JOIN oe.Products p ON e.ProductId = p.ProductId INNER JOIN oe.Members m ON e.MemberId = m.MemberId LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId WHERE m.GroupId = @GroupId AND e.Status = 'Active'`
        );
      }
      tenantId = enrollTenant.recordset[0]?.TenantId != null ? enrollTenant.recordset[0].TenantId.toString() : null;
    }

    const paymentData = {
      paymentId: row.PaymentId,
      householdId: row.HouseholdId,
      groupId: row.GroupId,
      paymentDate: row.PaymentDate,
      productId: null,
      paymentAmount: parseFloat(row.Amount),
      agentId,
      tenantId,
      commission: row.Commission != null ? parseFloat(row.Commission) : null,
      overrideRate: row.OverrideRate != null ? parseFloat(row.OverrideRate) : 0,
      netRate: row.NetRate != null ? parseFloat(row.NetRate) : null
    };
    const previewLookupWindow = await this.resolveEnrollmentLookupWindow(
      row.PaymentId != null ? row.PaymentId.toString() : paymentId,
      paymentData.paymentDate
    );
    const previewLookupStartDate = previewLookupWindow.lookupStartDate;
    const previewLookupEndDate = previewLookupWindow.lookupEndDate;

    const enrollmentProductIds = [];
    const productCommissionAmounts = new Map();
    const productEnrollmentCounts = new Map();
    const productNames = new Map();

    const productRequest = pool.request();
    productRequest.input('PaymentId', sql.UniqueIdentifier, paymentId);
    productRequest.input('HouseholdId', sql.UniqueIdentifier, paymentData.householdId || '00000000-0000-0000-0000-000000000000');
    productRequest.input('GroupId', sql.UniqueIdentifier, paymentData.groupId || '00000000-0000-0000-0000-000000000000');
    productRequest.input('AllProductsId', sql.UniqueIdentifier, '00000000-0000-0000-0000-000000000000');
    productRequest.input('EnrollmentLookupStartDate', sql.DateTime2, previewLookupStartDate);
    productRequest.input('EnrollmentLookupEndDate', sql.DateTime2, previewLookupEndDate);
    const previewDateWindowClause = `
        AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @EnrollmentLookupEndDate)
        AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate)
      `;
    const productResult = await productRequest.query(`
      SELECT DISTINCT e.ProductId, pr.Name as ProductName, SUM(COALESCE(e.Commission, 0)) as CommissionAmount
      FROM oe.Enrollments e
      INNER JOIN oe.Products pr ON e.ProductId = pr.ProductId
      WHERE ${CommissionService.billingPeriodEnrollmentStatusSql('e')}
        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        AND e.ProductId != @AllProductsId
        ${previewDateWindowClause}
        AND (
          (@HouseholdId != '00000000-0000-0000-0000-000000000000' AND e.HouseholdId = @HouseholdId)
          OR (@GroupId != '00000000-0000-0000-0000-000000000000' AND EXISTS (
            SELECT 1 FROM oe.Members m WHERE m.MemberId = e.MemberId AND m.GroupId = @GroupId
          ))
        )
      GROUP BY e.ProductId, pr.Name
    `);

    for (const r of (productResult.recordset || [])) {
      const pid = r.ProductId?.toString();
      if (pid) {
        enrollmentProductIds.push(pid);
        productCommissionAmounts.set(pid, parseFloat(r.CommissionAmount) || 0);
        productNames.set(pid, r.ProductName || 'Unknown');
      }
    }

    const productCommissionsRaw = row.ProductCommissions;
    if (productCommissionsRaw) {
      try {
        const pc = typeof productCommissionsRaw === 'string' ? JSON.parse(productCommissionsRaw) : productCommissionsRaw;
        if (Array.isArray(pc)) {
          for (const item of pc) {
            if (item?.ProductId) {
              const pid = item.ProductId.toString().toUpperCase();
              const count = item.EnrolledHouseholdsCount ?? item.enrolledHouseholdsCount ?? 0;
              productEnrollmentCounts.set(pid, count);
              const commissionAmount = item.CommissionAmount !== undefined ? Number(item.CommissionAmount) : null;
              if (commissionAmount != null && !Number.isNaN(commissionAmount)) {
                productCommissionAmounts.set(pid, commissionAmount);
              }
            }
          }
        } else if (typeof pc === 'object') {
          for (const [pid, data] of Object.entries(pc)) {
            if (data && typeof data === 'object') {
              const count = data.enrolledHouseholdsCount ?? 0;
              if (count > 0 || data.commissionAmount !== undefined) {
                const pidUpper = pid.toUpperCase();
                productEnrollmentCounts.set(pidUpper, count);
                const commissionAmount = data.commissionAmount !== undefined ? Number(data.commissionAmount) : null;
                if (commissionAmount != null && !Number.isNaN(commissionAmount)) {
                  productCommissionAmounts.set(pidUpper, commissionAmount);
                }
              }
            }
          }
        }
      } catch (e) {
        logger.warn('Could not parse ProductCommissions for breakdown preview', { paymentId, error: e.message });
      }
    }

    const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';
    const snapshotProductIdsFromPayment = Array.from(
      new Set([
        ...productCommissionAmounts.keys(),
        ...productEnrollmentCounts.keys()
      ])
    ).filter(
      (k) =>
        k &&
        String(k).toUpperCase() !== ALL_PRODUCTS_GUID.toUpperCase() &&
        !String(k).startsWith('TIER_DIST:')
    );

    // SQL can return no rows while ProductCommissions JSON still lists real component products.
    // (Previously we inserted the all-products GUID before parsing JSON, so recovery never ran.)
    if (snapshotProductIdsFromPayment.length > 0 && enrollmentProductIds.length === 0) {
      enrollmentProductIds.push(...snapshotProductIdsFromPayment);
    }

    if (enrollmentProductIds.length === 0) {
      enrollmentProductIds.push(ALL_PRODUCTS_GUID);
      productCommissionAmounts.set(ALL_PRODUCTS_GUID, parseFloat(row.Commission) || 0);
      productNames.set(ALL_PRODUCTS_GUID, 'All Products');
    }

    const idsNeedingNames = enrollmentProductIds.filter(
      (pid) =>
        pid &&
        String(pid).toUpperCase() !== ALL_PRODUCTS_GUID.toUpperCase() &&
        !productNames.has(pid)
    );
    if (idsNeedingNames.length > 0) {
      const nameReq = pool.request();
      const params = idsNeedingNames.map((id, idx) => {
        const p = `SnapshotProductId${idx}`;
        nameReq.input(p, sql.UniqueIdentifier, id);
        return `@${p}`;
      });
      try {
        const nameResult = await nameReq.query(`
          SELECT ProductId, Name
          FROM oe.Products
          WHERE ProductId IN (${params.join(', ')})
        `);
        for (const rec of (nameResult.recordset || [])) {
          const pid = rec.ProductId?.toString()?.toUpperCase();
          if (pid) {
            productNames.set(pid, rec.Name || 'Unknown');
          }
        }
      } catch (nameErr) {
        logger.warn('Could not resolve product names for breakdown preview', {
          paymentId,
          error: nameErr.message
        });
      }
    }

    // For group payments, recompute per-product tier distribution (EE/ES/EC/EF household counts)
    // and correct the enrollment counts so CommissionCalculatorService uses the per-tier branch.
    if (paymentData.groupId && paymentData.groupId !== '00000000-0000-0000-0000-000000000000') {
      try {
        const tierDistReq = pool.request();
        tierDistReq.input('TierDistGroupId', sql.UniqueIdentifier, paymentData.groupId);
        tierDistReq.input('TierDistLookupStart', sql.DateTime2, previewLookupStartDate);
        tierDistReq.input('TierDistLookupEnd', sql.DateTime2, previewLookupEndDate);

        const tierDistResult = await tierDistReq.query(`
          SELECT e.ProductId, m.Tier, COUNT(DISTINCT e.HouseholdId) AS HouseholdCount
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE (e.GroupId = @TierDistGroupId OR m.GroupId = @TierDistGroupId)
            AND m.RelationshipType = 'P'
            AND m.Tier IN ('EE','EC','ES','EF')
            AND ${CommissionService.billingPeriodEnrollmentStatusSql('e')}
            AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @TierDistLookupEnd)
            AND (e.TerminationDate IS NULL OR e.TerminationDate > @TierDistLookupStart)
            AND e.ProductId IS NOT NULL
            AND e.ProductId != '00000000-0000-0000-0000-000000000000'
          GROUP BY e.ProductId, m.Tier
        `);

        if (tierDistResult.recordset.length > 0) {
          const tierDistByProduct = new Map();
          const correctCountByProduct = new Map();

          for (const row of tierDistResult.recordset) {
            const prodId = row.ProductId ? row.ProductId.toString().toUpperCase() : null;
            if (!prodId) continue;
            const tier = (row.Tier || '').toUpperCase();
            if (!['EE', 'EC', 'ES', 'EF'].includes(tier)) continue;

            if (!tierDistByProduct.has(prodId)) {
              tierDistByProduct.set(prodId, new Map());
            }
            tierDistByProduct.get(prodId).set(tier, Number(row.HouseholdCount) || 0);

            correctCountByProduct.set(
              prodId,
              (correctCountByProduct.get(prodId) || 0) + (Number(row.HouseholdCount) || 0)
            );
          }

          for (const [prodId, tierDistribution] of tierDistByProduct.entries()) {
            const tierDistKey = `TIER_DIST:${prodId}`;
            productEnrollmentCounts.set(tierDistKey, tierDistribution);

            const correctCount = correctCountByProduct.get(prodId) || 0;
            if (correctCount > 0) {
              productEnrollmentCounts.set(prodId, correctCount);
            }
          }

          logger.info('Preview: Recomputed TIER_DIST for group payment breakdown', {
            paymentId,
            groupId: paymentData.groupId,
            tierDistKeys: Array.from(productEnrollmentCounts.keys()).filter(k => k.startsWith('TIER_DIST:')),
            correctedCounts: Object.fromEntries(correctCountByProduct)
          });
        }
      } catch (tierDistErr) {
        logger.warn('Preview: Could not recompute TIER_DIST for group payment breakdown', {
          paymentId,
          groupId: paymentData.groupId,
          error: tierDistErr.message
        });
      }
    }

    // Get default product tier (EE, ES, EC, EF) - fallback only.
    // For multi-product payments we resolve tier per product inside the loop below.
    let defaultProductTier = null;
    if (paymentData.householdId && paymentData.householdId !== '00000000-0000-0000-0000-000000000000') {
      try {
        const tierResult = await pool.request()
          .input('HouseholdId', sql.UniqueIdentifier, paymentData.householdId)
          .input('EnrollmentLookupStartDate', sql.DateTime2, previewLookupStartDate)
          .input('EnrollmentLookupEndDate', sql.DateTime2, previewLookupEndDate)
          .query(`SELECT TOP 1 m.Tier FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE e.HouseholdId = @HouseholdId AND m.RelationshipType = 'P' AND ${CommissionService.billingPeriodEnrollmentStatusSql('e')} AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @EnrollmentLookupEndDate) AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate) ORDER BY e.EffectiveDate DESC`);
        if (tierResult.recordset.length > 0 && tierResult.recordset[0].Tier) {
          defaultProductTier = tierResult.recordset[0].Tier;
        }
      } catch (e) {
        logger.warn('Could not get product tier from household for breakdown', { paymentId, error: e.message });
      }
    } else if (paymentData.groupId && paymentData.groupId !== '00000000-0000-0000-0000-000000000000') {
      try {
        const tierResult = await pool.request()
          .input('GroupId', sql.UniqueIdentifier, paymentData.groupId)
          .input('EnrollmentLookupStartDate', sql.DateTime2, previewLookupStartDate)
          .input('EnrollmentLookupEndDate', sql.DateTime2, previewLookupEndDate)
          .query(`
            SELECT TOP 1 m.Tier
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE (e.GroupId = @GroupId OR m.GroupId = @GroupId)
              AND ${CommissionService.billingPeriodEnrollmentStatusSql('e')}
              AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @EnrollmentLookupEndDate)
              AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate)
              AND m.RelationshipType = 'P'
              AND m.Tier IS NOT NULL
            GROUP BY m.Tier
            ORDER BY COUNT(DISTINCT m.HouseholdId) DESC
          `);
        if (tierResult.recordset.length > 0 && tierResult.recordset[0].Tier) {
          defaultProductTier = tierResult.recordset[0].Tier;
        }
      } catch (e) {
        logger.warn('Could not get product tier from group for breakdown', { paymentId, error: e.message });
      }
    }

    const products = [];
    const agentNameMap = new Map();
    const agencyNameMap = new Map();
    const productTierByProduct = new Map();
    let clientTierDisplay = null;

    for (const productId of enrollmentProductIds) {
      // Resolve member tier per product so tiered rules use the correct family-size band.
      // This avoids reusing one payment-level tier (often EE) across all component products.
      let productTier = defaultProductTier;
      if (productTierByProduct.has(productId)) {
        productTier = productTierByProduct.get(productId);
      } else {
        try {
          let tierResult = null;
          if (paymentData.householdId && paymentData.householdId !== '00000000-0000-0000-0000-000000000000') {
            tierResult = await pool.request()
              .input('HouseholdId', sql.UniqueIdentifier, paymentData.householdId)
              .input('ProductId', sql.UniqueIdentifier, productId)
              .input('EnrollmentLookupStartDate', sql.DateTime2, previewLookupStartDate)
              .input('EnrollmentLookupEndDate', sql.DateTime2, previewLookupEndDate)
              .query(`
                SELECT TOP 1 m.Tier
                FROM oe.Enrollments e
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                WHERE e.HouseholdId = @HouseholdId
                  AND e.ProductId = @ProductId
                  AND ${CommissionService.billingPeriodEnrollmentStatusSql('e')}
                  AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @EnrollmentLookupEndDate)
                  AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate)
                  AND m.Tier IS NOT NULL
                ORDER BY CASE WHEN m.RelationshipType = 'P' THEN 0 ELSE 1 END, e.EffectiveDate DESC
              `);
          }
          if ((!tierResult || !tierResult.recordset?.length) && paymentData.groupId && paymentData.groupId !== '00000000-0000-0000-0000-000000000000') {
            tierResult = await pool.request()
              .input('GroupId', sql.UniqueIdentifier, paymentData.groupId)
              .input('ProductId', sql.UniqueIdentifier, productId)
              .input('EnrollmentLookupStartDate', sql.DateTime2, previewLookupStartDate)
              .input('EnrollmentLookupEndDate', sql.DateTime2, previewLookupEndDate)
              .query(`
                SELECT TOP 1 m.Tier
                FROM oe.Enrollments e
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                WHERE (e.GroupId = @GroupId OR m.GroupId = @GroupId)
                  AND e.ProductId = @ProductId
                  AND ${CommissionService.billingPeriodEnrollmentStatusSql('e')}
                  AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @EnrollmentLookupEndDate)
                  AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate)
                  AND m.Tier IS NOT NULL
                ORDER BY CASE WHEN m.RelationshipType = 'P' THEN 0 ELSE 1 END, e.EffectiveDate DESC
              `);
          }
          if (tierResult?.recordset?.length && tierResult.recordset[0].Tier) {
            productTier = tierResult.recordset[0].Tier;
          }
        } catch (e) {
          logger.warn('Could not resolve per-product tier for breakdown', {
            paymentId,
            productId,
            error: e.message
          });
        }
        productTierByProduct.set(productId, productTier);
      }

      const singleProductCommission = new Map();
      const productCommission = productCommissionAmounts.get(productId) || 0;
      singleProductCommission.set(productId, productCommission);

      const dist = await this.calculateCommissionDistribution(
        paymentId,
        null,
        productId,
        paymentData.paymentAmount,
        agentId,
        tenantId,
        productCommission,
        paymentData.overrideRate,
        paymentData.netRate,
        paymentData.householdId,
        paymentData.groupId,
        paymentData.paymentDate,
        [productId],
        singleProductCommission,
        productTier,
        productEnrollmentCounts
      );

      const breakdown = [];
      for (const d of dist) {
        const agentIdStr = d.agentId != null ? d.agentId.toString() : null;
        const agencyIdStr = d.agencyId != null ? d.agencyId.toString() : null;
        let name = '—';
        try {
          if (agentIdStr) {
            if (!agentNameMap.has(agentIdStr)) {
              const ar = await pool.request().input('AgentId', sql.UniqueIdentifier, agentIdStr).query(`
                SELECT u.FirstName + ' ' + u.LastName AS AgentName FROM oe.Agents a INNER JOIN oe.Users u ON a.UserId = u.UserId WHERE a.AgentId = @AgentId
              `);
              agentNameMap.set(agentIdStr, ar.recordset[0]?.AgentName || 'Unknown');
            }
            name = agentNameMap.get(agentIdStr);
          } else if (agencyIdStr) {
            if (!agencyNameMap.has(agencyIdStr)) {
              const ag = await pool.request().input('AgencyId', sql.UniqueIdentifier, agencyIdStr).query(`SELECT AgencyName FROM oe.Agencies WHERE AgencyId = @AgencyId`);
              agencyNameMap.set(agencyIdStr, ag.recordset[0]?.AgencyName || 'Unknown');
            }
            name = (agencyNameMap.get(agencyIdStr) || '') + (d.isOverflow ? ' (Overflow)' : '');
          }
        } catch (nameErr) {
          logger.warn('Could not resolve recipient name for breakdown', { agentIdStr, agencyIdStr, error: nameErr.message });
        }
        const amount = typeof d.amount === 'number' ? d.amount : parseFloat(d.amount) || 0;
        breakdown.push({
          recipientName: name,
          amount,
          ruleName: d.ruleName || null,
          tierLevel: d.tierLevel != null ? d.tierLevel : null,
          recipientAgentId: agentIdStr || null,
          recipientAgencyId: agencyIdStr || null
        });
      }

      products.push({
        productId,
        productName: productNames.get(productId) || 'Unknown',
        commissionAmount: productCommissionAmounts.get(productId) || 0,
        breakdown,
        tierDisplay: null
      });
    }

    // Build per-product tier distribution (EE/ES/EC/EF counts) for each product card
    const realProductIds = enrollmentProductIds.filter(
      (id) => id && id !== '00000000-0000-0000-0000-000000000000'
    );
    if (realProductIds.length > 0) {
      try {
        if (paymentData.groupId && paymentData.groupId !== '00000000-0000-0000-0000-000000000000') {
          const perProductTierReq = pool.request();
          perProductTierReq.input('GroupId', sql.UniqueIdentifier, paymentData.groupId);
          perProductTierReq.input('EnrollmentLookupStartDate', sql.DateTime2, previewLookupStartDate);
          perProductTierReq.input('EnrollmentLookupEndDate', sql.DateTime2, previewLookupEndDate);
          const productParams = realProductIds.map((id, idx) => {
            const param = `PerProdTier${idx}`;
            perProductTierReq.input(param, sql.UniqueIdentifier, id);
            return `@${param}`;
          });
          const perProductTierResult = await perProductTierReq.query(`
            SELECT e.ProductId, m.Tier, COUNT(DISTINCT e.HouseholdId) AS HouseholdCount
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE (e.GroupId = @GroupId OR m.GroupId = @GroupId)
              AND e.ProductId IN (${productParams.join(', ')})
              AND ${CommissionService.billingPeriodEnrollmentStatusSql('e')}
              AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @EnrollmentLookupEndDate)
              AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate)
              AND m.RelationshipType = 'P'
              AND m.Tier IN ('EE', 'EC', 'ES', 'EF')
            GROUP BY e.ProductId, m.Tier
          `);
          const perProductTierMap = new Map();
          for (const rec of (perProductTierResult.recordset || [])) {
            const pid = rec.ProductId?.toString()?.toUpperCase();
            const tier = (rec.Tier || '').toUpperCase();
            if (!pid || !['EE', 'EC', 'ES', 'EF'].includes(tier)) continue;
            if (!perProductTierMap.has(pid)) {
              perProductTierMap.set(pid, new Map([['EE', 0], ['EC', 0], ['ES', 0], ['EF', 0]]));
            }
            perProductTierMap.get(pid).set(tier, Number(rec.HouseholdCount) || 0);
          }
          for (const product of products) {
            const pidUpper = product.productId?.toUpperCase();
            const tierCounts = perProductTierMap.get(pidUpper);
            if (tierCounts) {
              const hasAny = Array.from(tierCounts.values()).some((c) => c > 0);
              if (hasAny) {
                product.tierDisplay = ['EE', 'ES', 'EC', 'EF']
                  .map((t) => `${t}: ${tierCounts.get(t) || 0}`)
                  .join(', ');
              }
            }
          }
        } else if (paymentData.householdId && paymentData.householdId !== '00000000-0000-0000-0000-000000000000') {
          for (const product of products) {
            const pidUpper = product.productId?.toUpperCase();
            const tier = productTierByProduct.get(pidUpper) || productTierByProduct.get(product.productId);
            if (tier && ['EE', 'EC', 'ES', 'EF'].includes(String(tier).toUpperCase())) {
              product.tierDisplay = String(tier).toUpperCase();
            }
          }
        }
      } catch (perProdTierErr) {
        logger.warn('Could not build per-product tier display for breakdown', {
          paymentId,
          error: perProdTierErr.message
        });
      }
    }

    const paymentDate = row.PaymentDate;
    const paymentDateStr = paymentDate instanceof Date ? paymentDate.toISOString() : (paymentDate != null ? String(paymentDate) : null);

    // Build client-tier display for modal header:
    // - Individual/household: "(EE|ES|EC|EF)"
    // - Group: "(EE: x, EC: y, ES: z, EF: w)" for active primary members in this payout scope
    if (paymentData.groupId && paymentData.groupId !== '00000000-0000-0000-0000-000000000000') {
      try {
        const groupTierRequest = pool.request();
        groupTierRequest.input('GroupId', sql.UniqueIdentifier, paymentData.groupId);
        groupTierRequest.input('EnrollmentLookupStartDate', sql.DateTime2, previewLookupStartDate);
        groupTierRequest.input('EnrollmentLookupEndDate', sql.DateTime2, previewLookupEndDate);
        const validProductIds = enrollmentProductIds.filter(
          (id) => id && id !== '00000000-0000-0000-0000-000000000000'
        );
        let productFilter = '';
        if (validProductIds.length > 0) {
          const productParams = validProductIds.map((id, idx) => {
            const param = `GroupTierProductId${idx}`;
            groupTierRequest.input(param, sql.UniqueIdentifier, id);
            return `@${param}`;
          });
          productFilter = ` AND e.ProductId IN (${productParams.join(', ')}) `;
        }

        const groupTierResult = await groupTierRequest.query(`
          SELECT m.Tier, COUNT(DISTINCT e.HouseholdId) AS HouseholdCount
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE (e.GroupId = @GroupId OR m.GroupId = @GroupId)
            AND ${CommissionService.billingPeriodEnrollmentStatusSql('e')}
            AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @EnrollmentLookupEndDate)
            AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate)
            AND m.RelationshipType = 'P'
            AND m.Tier IN ('EE', 'EC', 'ES', 'EF')
            ${productFilter}
          GROUP BY m.Tier
        `);

        const tierCounts = new Map([
          ['EE', 0],
          ['EC', 0],
          ['ES', 0],
          ['EF', 0]
        ]);
        for (const rec of groupTierResult.recordset || []) {
          const tier = (rec.Tier || '').toUpperCase();
          if (tierCounts.has(tier)) {
            tierCounts.set(tier, Number(rec.HouseholdCount) || 0);
          }
        }
        clientTierDisplay = `(${['EE', 'EC', 'ES', 'EF']
          .map((tier) => `${tier}: ${tierCounts.get(tier) || 0}`)
          .join(', ')})`;
      } catch (tierErr) {
        logger.warn('Could not build group tier display for breakdown', {
          paymentId,
          groupId: paymentData.groupId,
          error: tierErr.message
        });
      }
    } else {
      // Individual/household
      const tierCode = (defaultProductTier || '').toString().toUpperCase();
      if (['EE', 'EC', 'ES', 'EF'].includes(tierCode)) {
        clientTierDisplay = `(${tierCode})`;
      }
    }

    // Fallback: for older/edge records where enrollment-window lookups return nothing,
    // resolve tier display directly from members so the header still explains the math.
    if (!clientTierDisplay) {
      try {
        if (paymentData.groupId && paymentData.groupId !== '00000000-0000-0000-0000-000000000000') {
          const fallbackGroupTierResult = await pool.request()
            .input('GroupId', sql.UniqueIdentifier, paymentData.groupId)
            .query(`
              SELECT m.Tier, COUNT(DISTINCT m.HouseholdId) AS HouseholdCount
              FROM oe.Members m
              WHERE m.GroupId = @GroupId
                AND m.RelationshipType = 'P'
                AND m.Tier IN ('EE', 'EC', 'ES', 'EF')
              GROUP BY m.Tier
            `);

          const tierCounts = new Map([
            ['EE', 0],
            ['EC', 0],
            ['ES', 0],
            ['EF', 0]
          ]);
          for (const rec of fallbackGroupTierResult.recordset || []) {
            const tier = (rec.Tier || '').toUpperCase();
            if (tierCounts.has(tier)) {
              tierCounts.set(tier, Number(rec.HouseholdCount) || 0);
            }
          }
          const hasAnyTier = Array.from(tierCounts.values()).some((count) => count > 0);
          if (hasAnyTier) {
            clientTierDisplay = `(${['EE', 'EC', 'ES', 'EF']
              .map((tier) => `${tier}: ${tierCounts.get(tier) || 0}`)
              .join(', ')})`;
          }
        } else if (paymentData.householdId && paymentData.householdId !== '00000000-0000-0000-0000-000000000000') {
          const fallbackHouseholdTierResult = await pool.request()
            .input('HouseholdId', sql.UniqueIdentifier, paymentData.householdId)
            .query(`
              SELECT TOP 1 m.Tier
              FROM oe.Members m
              WHERE m.HouseholdId = @HouseholdId
                AND m.RelationshipType = 'P'
                AND m.Tier IN ('EE', 'EC', 'ES', 'EF')
            `);
          const fallbackTierCode = (fallbackHouseholdTierResult.recordset?.[0]?.Tier || '').toString().toUpperCase();
          if (['EE', 'EC', 'ES', 'EF'].includes(fallbackTierCode)) {
            clientTierDisplay = `(${fallbackTierCode})`;
          }
        }
      } catch (fallbackTierErr) {
        logger.warn('Could not resolve fallback client tier display for breakdown', {
          paymentId,
          groupId: paymentData.groupId,
          householdId: paymentData.householdId,
          error: fallbackTierErr.message
        });
      }
    }

    // Simulate agent-to-agent overrides so the preview matches post-generation reality.
    const agentOverridesPreview = [];
    try {
      if (tenantId) {
        const agentTotals = new Map();
        for (const product of products) {
          for (const line of (product.breakdown || [])) {
            if (!line.recipientAgentId) continue;
            const prev = agentTotals.get(line.recipientAgentId) || 0;
            agentTotals.set(line.recipientAgentId, prev + Number(line.amount || 0));
          }
        }
        const sourceIds = Array.from(agentTotals.keys()).filter((id) => (agentTotals.get(id) || 0) > 0);
        if (sourceIds.length > 0) {
          const ovReq = pool.request();
          ovReq.input('TenantId', sql.UniqueIdentifier, tenantId);
          ovReq.input('PaymentDate', sql.Date, paymentData.paymentDate || new Date());
          const placeholders = sourceIds.map((id, i) => {
            ovReq.input(`SrcAgent${i}`, sql.UniqueIdentifier, id);
            return `@SrcAgent${i}`;
          }).join(', ');
          let ovRows = [];
          try {
            const ovRes = await ovReq.query(`
              SELECT OverrideId, SourceAgentId, RecipientAgentId, OverrideType, OverrideAmount, OverridePercentage
              FROM oe.AgentCommissionOverrides
              WHERE TenantId = @TenantId
                AND Status = 'Active'
                AND SourceAgentId IN (${placeholders})
                AND (EffectiveDate IS NULL OR EffectiveDate <= @PaymentDate)
                AND (TerminationDate IS NULL OR TerminationDate >= @PaymentDate)
              ORDER BY CreatedDate ASC
            `);
            ovRows = ovRes.recordset || [];
          } catch (ovErr) {
            if (!(ovErr?.message && /Invalid object name|AgentCommissionOverrides/i.test(ovErr.message))) {
              throw ovErr;
            }
            ovRows = [];
          }

          for (const ov of ovRows) {
            const srcId = ov.SourceAgentId;
            const sourceTotal = agentTotals.get(srcId) || 0;
            let amount = 0;
            if (ov.OverrideType === 'Fixed') {
              amount = Number(ov.OverrideAmount || 0);
            } else if (ov.OverrideType === 'Percentage') {
              amount = Math.round((sourceTotal * Number(ov.OverridePercentage || 0) / 100) * 100) / 100;
            }
            const entry = {
              overrideId: ov.OverrideId,
              overrideType: ov.OverrideType,
              sourceAgentId: srcId,
              sourceAgentName: agentNameMap.get(srcId) || 'Unknown',
              recipientAgentId: ov.RecipientAgentId,
              recipientAgentName: agentNameMap.get(ov.RecipientAgentId) || null,
              amount: amount > 0 ? amount : 0,
              sourceTotalBefore: sourceTotal
            };
            if (amount <= 0) {
              entry.skipped = true;
              entry.skipReason = 'Computed override amount is zero';
            } else if (amount > sourceTotal) {
              entry.skipped = true;
              entry.skipReason = `Source agent commission (${sourceTotal.toFixed(2)}) is less than override amount (${amount.toFixed(2)})`;
            } else {
              agentTotals.set(srcId, sourceTotal - amount);
            }

            if (!entry.recipientAgentName && ov.RecipientAgentId) {
              try {
                const rn = await pool.request()
                  .input('AgentId', sql.UniqueIdentifier, ov.RecipientAgentId)
                  .query(`SELECT u.FirstName + ' ' + u.LastName AS AgentName FROM oe.Agents a INNER JOIN oe.Users u ON a.UserId = u.UserId WHERE a.AgentId = @AgentId`);
                entry.recipientAgentName = rn.recordset[0]?.AgentName || 'Unknown';
              } catch (_) {
                entry.recipientAgentName = 'Unknown';
              }
            }
            agentOverridesPreview.push(entry);
          }
        }
      }
    } catch (overridePreviewErr) {
      logger.warn('Could not simulate agent overrides for breakdown preview', {
        paymentId,
        error: overridePreviewErr.message
      });
    }

    return {
      paymentId: row.PaymentId != null ? row.PaymentId.toString() : paymentId,
      paymentDate: paymentDateStr,
      amount: parseFloat(row.Amount) || 0,
      commission: parseFloat(row.Commission) || 0,
      agentName: row.AgentName || 'Unknown',
      sellingAgentId: agentId,
      sellingAgentAgencyId: agentRow?.AgencyId != null ? agentRow.AgencyId.toString() : null,
      agentCommissionTierLevel: row.AgentCommissionTierLevel != null ? Number(row.AgentCommissionTierLevel) : null,
      clientTierDisplay,
      products,
      agentOverrides: agentOverridesPreview
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — Commission clawback
  //
  // Reuses oe.Commissions. Cancels Pending advances/commissions outright, and
  // for already-Paid rows inserts a negative-amount Refund/Chargeback row with
  // Status='Pending' so the next NACHA cycle nets it against future positive
  // payouts (Phase 6). Carry-forward across cycles is achieved by leaving any
  // unsettled negative rows in Pending.
  //
  // ALL writes use the open transaction passed by RefundService so the entire
  // refund + clawback chain commits or rolls back together.
  // ---------------------------------------------------------------------------

  /**
   * Claw back commission for a refunded payment.
   *
   * @param {string} paymentId        Original payment that was refunded
   * @param {number} refundAmount     Positive refund amount
   * @param {Object} transaction      Open mssql transaction (required)
   * @param {Object} [opts]
   * @param {('Refund'|'Chargeback')} [opts.transactionType='Refund']
   * @returns {Promise<{ cancelledPending: number, negativeRows: Array }>}
   */
  static async clawBackForRefund(paymentId, refundAmount, transaction, opts = {}) {
    if (!paymentId) throw new Error('clawBackForRefund: paymentId is required');
    if (!transaction) throw new Error('clawBackForRefund: transaction is required');
    const amt = Number(refundAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return { cancelledPending: 0, negativeRows: [] };
    }
    const transactionType = opts.transactionType === 'Chargeback' ? 'Chargeback' : 'Refund';

    // Look up original payment to get amount + tenant context.
    const payReq = new mssql.Request(transaction);
    payReq.input('paymentId', mssql.UniqueIdentifier, paymentId);
    const payRes = await payReq.query(`
      SELECT PaymentId, TenantId, Amount, InvoiceId
      FROM oe.Payments
      WHERE PaymentId = @paymentId
    `);
    const payment = payRes.recordset?.[0];
    if (!payment) return { cancelledPending: 0, negativeRows: [] };
    const paymentInvoiceId = payment.InvoiceId || null;

    // Full-refund-only rule: RefundService validates refund == payment.Amount
    // before reaching here, so there is no proration. Each positive
    // commission tied to this payment is reversed dollar-for-dollar.

    // Match payment-anchored rows OR invoice-anchored rows (PaymentId NULL,
    // InvoiceId set) — same pattern as NACHA agent payout selection.
    const commsMatchSql = paymentInvoiceId
      ? `(c.PaymentId = @paymentId OR (c.InvoiceId = @invoiceId AND c.PaymentId IS NULL))`
      : `c.PaymentId = @paymentId`;

    // Find all positive commission rows tied to this payment. Schema columns
    // are AgentId/AgencyId/EnrollmentId/HouseholdId/GroupId — there is no
    // MemberId/ProductId/TenantId on oe.Commissions.
    const commsReq = new mssql.Request(transaction);
    commsReq.input('paymentId', mssql.UniqueIdentifier, paymentId);
    if (paymentInvoiceId) commsReq.input('invoiceId', mssql.UniqueIdentifier, paymentInvoiceId);
    const commsRes = await commsReq.query(`
      SELECT c.CommissionId, c.AgentId, c.AgencyId, c.EnrollmentId, c.HouseholdId, c.GroupId,
             c.PeriodStartDate, c.PeriodEndDate, c.Amount, c.Status, c.TransactionType, c.AppliedToNACHAId,
             c.InvoiceId
      FROM oe.Commissions c
      WHERE ${commsMatchSql}
        AND c.Amount > 0
        AND c.TransactionType IN (N'Advance', N'Commission')
    `);

    let cancelledPending = 0;
    const negativeRows = [];

    for (const row of commsRes.recordset || []) {
      const status = String(row.Status || '').toLowerCase();
      const isPending = status === 'pending';
      const fullAmount = Math.round(Number(row.Amount) * 100) / 100;
      if (fullAmount <= 0) continue;

      if (isPending) {
        // Cancel outright — Pending rows haven't been paid out yet.
        const cancelReq = new mssql.Request(transaction);
        cancelReq.input('commissionId', mssql.UniqueIdentifier, row.CommissionId);
        await cancelReq.query(`
          UPDATE oe.Commissions
          SET Status = N'Cancelled',
              ModifiedDate = GETUTCDATE()
          WHERE CommissionId = @commissionId
        `);
        cancelledPending += 1;
      } else {
        // Already paid out — insert a negative offsetting row with Status='Pending'
        // so it's eligible for the next NACHA cycle. Mirror the canonical
        // commission insert shape (line 1845): no MemberId/ProductId/TenantId
        // columns; the back-pointer to the original positive row is
        // OriginalCommissionId, matching the rest of the codebase.
        const newId = require('crypto').randomUUID();
        const invForClawback = row.InvoiceId || paymentInvoiceId || null;
        const insReq = new mssql.Request(transaction);
        insReq.input('commissionId', mssql.UniqueIdentifier, newId);
        insReq.input('agentId', mssql.UniqueIdentifier, row.AgentId);
        insReq.input('agencyId', mssql.UniqueIdentifier, row.AgencyId);
        insReq.input('enrollmentId', mssql.UniqueIdentifier, row.EnrollmentId);
        insReq.input('householdId', mssql.UniqueIdentifier, row.HouseholdId);
        insReq.input('groupId', mssql.UniqueIdentifier, row.GroupId);
        insReq.input('periodStartDate', mssql.Date, row.PeriodStartDate);
        insReq.input('periodEndDate', mssql.Date, row.PeriodEndDate);
        insReq.input('paymentId', mssql.UniqueIdentifier, paymentId);
        insReq.input('invoiceId', mssql.UniqueIdentifier, invForClawback);
        insReq.input('amount', mssql.Decimal(10, 2), -fullAmount);
        insReq.input('transactionType', mssql.NVarChar(20), transactionType);
        insReq.input('originalCommissionId', mssql.UniqueIdentifier, row.CommissionId);
        await insReq.query(`
          INSERT INTO oe.Commissions
            (CommissionId, AgentId, AgencyId, EnrollmentId, HouseholdId, GroupId,
             PaymentId, InvoiceId, Amount, Status, TransactionType, OriginalCommissionId,
             PeriodStartDate, PeriodEndDate, CreatedDate, ModifiedDate)
          VALUES
            (@commissionId, @agentId, @agencyId, @enrollmentId, @householdId, @groupId,
             @paymentId, @invoiceId, @amount, N'Pending', @transactionType, @originalCommissionId,
             @periodStartDate, @periodEndDate, GETUTCDATE(), GETUTCDATE())
        `);
        negativeRows.push({ commissionId: newId, agentId: row.AgentId, amount: -fullAmount, originalCommissionId: row.CommissionId });
      }
    }

    return { cancelledPending, negativeRows };
  }

  /**
   * Cascade clawback when previously-applied member credit was reversed by a
   * refund. For each (destinationInvoiceId, amountReversed), we find the
   * commission rows tied to whichever payment originally covered that invoice
   * (the "creditPayment" — i.e. the OverpaymentRecognized source) and prorate
   * a clawback against its already-paid commission.
   *
   * @param {Array<{ destinationInvoiceId: string, amountReversed: number }>} reversals
   * @param {Object} transaction      Open mssql transaction (required)
   */
  static async clawBackForCreditReversal(reversals, transaction) {
    if (!Array.isArray(reversals) || reversals.length === 0) return { cascades: [] };
    if (!transaction) throw new Error('clawBackForCreditReversal: transaction is required');

    const cascades = [];

    for (const item of reversals) {
      const invoiceId = item?.destinationInvoiceId;
      const reversed = Number(item?.amountReversed) || 0;
      if (!invoiceId || reversed <= 0) continue;

      // Find payments that fulfilled this invoice (excluding the refund row itself).
      const payReq = new mssql.Request(transaction);
      payReq.input('invoiceId', mssql.UniqueIdentifier, invoiceId);
      const payRes = await payReq.query(`
        SELECT PaymentId, Amount
        FROM oe.Payments
        WHERE InvoiceId = @invoiceId
          AND ISNULL(TransactionType, N'Payment') = N'Payment'
          AND Status IN (N'Completed', N'completed', N'Paid', N'paid', N'Approved', N'APPROVAL', N'success', N'SUCCESS')
      `);

      for (const pay of payRes.recordset || []) {
        const result = await CommissionService.clawBackForRefund(pay.PaymentId, reversed, transaction, { transactionType: 'Refund' });
        cascades.push({ invoiceId, paymentId: pay.PaymentId, ...result });
      }
    }

    return { cascades };
  }
}

module.exports = CommissionService;
// Phase 2 — convenience instance-style exports so RefundService can call without `new`.
module.exports.clawBackForRefund = CommissionService.clawBackForRefund.bind(CommissionService);
module.exports.clawBackForCreditReversal = CommissionService.clawBackForCreditReversal.bind(CommissionService);


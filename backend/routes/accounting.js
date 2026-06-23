const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { getUserRoles } = require('../middleware/auth');
const DimeService = require('../services/dimeService');
const encryptionService = require('../services/encryptionService');
const { resolveAchRoutingForCharge } = require('../utils/achRouting');
const { syncInvoiceAfterPaymentStatusChange } = require('../services/invoiceSync.service');
const invoiceService = require('../services/invoiceService');
const vendorBreakdownRoutes = require('./accounting/vendor-breakdown');
const productOverridesRoutes = require('./accounting/product-overrides');
const commissionBreakdownRoutes = require('./accounting/commission-breakdown');
const clawbackDetailsRoutes = require('./accounting/clawback-details');

// Authorization middleware - EXACT pattern from members.js
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

/** GroupAdmin may retry failed group payments for their assigned group only. */
async function assertGroupAdminPaymentRetryAccess(pool, user, effectiveGroupId) {
  const currentRole = user.currentRole || getUserRoles(user)[0];
  if (currentRole !== 'GroupAdmin') {
    return { ok: true };
  }

  if (!effectiveGroupId) {
    return {
      ok: false,
      status: 403,
      message: 'Access denied: group admins can only retry group payments'
    };
  }

  let userGroupId = user.GroupId || user.groupId;
  if (!userGroupId) {
    const gidRes = await pool.request()
      .input('userId', sql.UniqueIdentifier, user.UserId)
      .query(`
        SELECT TOP 1 GroupId
        FROM oe.GroupAdmins
        WHERE UserId = @userId AND Status = N'Active'
      `);
    userGroupId = gidRes.recordset[0]?.GroupId;
  }

  if (!userGroupId || String(userGroupId).toLowerCase() !== String(effectiveGroupId).toLowerCase()) {
    return {
      ok: false,
      status: 403,
      message: 'Access denied: payment is not for your group'
    };
  }

  return { ok: true };
}

// Test route
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'Enhanced Accounting routes working!' });
});

// Vendor breakdown routes
router.use('/', vendorBreakdownRoutes);
router.use('/', productOverridesRoutes);
router.use('/', commissionBreakdownRoutes);
router.use('/', clawbackDetailsRoutes);

// Get payments with enhanced filtering
router.get('/payments', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { status, paymentMethod, tenantName, dateRange, search } = req.query;
    const pool = await getPool();
    
    let whereClause = "WHERE 1=1";
    const request = pool.request();
    
    // Build dynamic WHERE clause with proper parameterization
    if (status) {
      whereClause += " AND p.Status = @status";
      request.input('status', sql.NVarChar, status);
    }
    
    if (paymentMethod) {
      whereClause += " AND p.PaymentMethod = @paymentMethod";
      request.input('paymentMethod', sql.NVarChar, paymentMethod);
    }
    
    if (dateRange) {
      switch (dateRange) {
        case '7d':
          whereClause += " AND p.PaymentDate >= DATEADD(day, -7, GETUTCDATE())";
          break;
        case '30d':
          whereClause += " AND p.PaymentDate >= DATEADD(day, -30, GETUTCDATE())";
          break;
        case '90d':
          whereClause += " AND p.PaymentDate >= DATEADD(day, -90, GETUTCDATE())";
          break;
      }
    }
    
    if (search) {
      whereClause += ` AND (
        ISNULL(u.FirstName + ' ' + u.LastName, 'Unknown') LIKE @search
        OR pr.Name LIKE @search
        OR p.ProcessorTransactionId LIKE @search
      )`;
      request.input('search', sql.NVarChar, `%${search}%`);
    }
    
    // Main payments query
    const query = `
      SELECT TOP 100
        p.PaymentId,
        p.Amount,
        p.PaymentDate,
        p.Status,
        p.PaymentMethod,
        p.ProcessorTransactionId,
        p.FailureReason,
        p.NextBillingDate,
        ISNULL(u.FirstName + ' ' + u.LastName, 'Unknown') as MemberName,
        pr.Name as ProductName,
        ISNULL(t.Name, 'Unknown Tenant') as TenantName
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
      LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
      LEFT JOIN oe.Tenants t ON g.TenantId = t.TenantId
      ${whereClause}
      ORDER BY p.PaymentDate DESC
    `;
    
    const payments = await request.query(query);
    
    // Summary statistics - separate query
    const summaryRequest = pool.request();
    
    // Re-add parameters for summary
    if (status) summaryRequest.input('status', sql.NVarChar, status);
    if (paymentMethod) summaryRequest.input('paymentMethod', sql.NVarChar, paymentMethod);
    if (search) summaryRequest.input('search', sql.NVarChar, `%${search}%`);
    
    const summaryQuery = `
      SELECT 
        COUNT(*) as totalPayments,
        COUNT(CASE WHEN p.Status = 'Completed' THEN 1 END) as successfulPayments,
        COUNT(CASE WHEN p.Status = 'Failed' THEN 1 END) as failedPayments,
        COUNT(CASE WHEN p.Status = 'Pending' THEN 1 END) as pendingPayments,
        ISNULL(SUM(CASE WHEN p.Status = 'Completed' THEN p.Amount ELSE 0 END), 0) as totalRevenue,
        ISNULL(AVG(CASE WHEN p.Status = 'Completed' THEN p.Amount END), 0) as averagePayment,
        8.5 as monthlyGrowth
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
      LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
      LEFT JOIN oe.Tenants t ON g.TenantId = t.TenantId
      ${whereClause}
    `;
    
    const summary = await summaryRequest.query(summaryQuery);
    
    res.json({
      success: true,
      payments: payments.recordset,
      summary: summary.recordset[0] || {
        totalPayments: 0,
        successfulPayments: 0,
        failedPayments: 0,
        pendingPayments: 0,
        totalRevenue: 0,
        averagePayment: 0,
        monthlyGrowth: 0
      }
    });
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch payments',
      error: error.message 
    });
  }
});

// Get payment methods available for retry (group or household), so UI can let user pick one (default primary)
router.get('/payments/:paymentId/retry-options', authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin']), async (req, res) => {
  try {
    const { paymentId } = req.params;
    const pool = await getPool();

    const payResult = await pool.request()
      .input('paymentId', sql.UniqueIdentifier, paymentId)
      .query(`
        SELECT p.PaymentId, p.TenantId, p.GroupId, p.HouseholdId, p.EnrollmentId, p.LocationId,
          p.InvoiceId,
          i.InvoiceNumber AS LinkedInvoiceNumber,
          i.BillingPeriodStart AS LinkedInvoiceBillingPeriodStart,
          i.BillingPeriodEnd AS LinkedInvoiceBillingPeriodEnd,
          i.Status AS LinkedInvoiceStatus
        FROM oe.Payments p
        LEFT JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
        WHERE p.PaymentId = @paymentId AND p.Status IN ('Failed', 'Pending')
      `);

    if (payResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment not found or not retryable' });
    }

    const pay = payResult.recordset[0];
    let effectiveGroupId = pay.GroupId;
    let effectiveHouseholdId = pay.HouseholdId;

    if (!effectiveGroupId && !effectiveHouseholdId && pay.EnrollmentId) {
      const enrollResult = await pool.request()
        .input('enrollmentId', sql.UniqueIdentifier, pay.EnrollmentId)
        .query(`
          SELECT e.HouseholdId, m.GroupId
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE e.EnrollmentId = @enrollmentId
        `);
      if (enrollResult.recordset.length > 0) {
        effectiveHouseholdId = enrollResult.recordset[0].HouseholdId || effectiveHouseholdId;
        effectiveGroupId = enrollResult.recordset[0].GroupId || effectiveGroupId;
      }
    }

    const userRoles = getUserRoles(req.user);
    if (!userRoles.includes('SysAdmin')) {
      const userTenantId = req.tenantId || req.user?.TenantId;
      if (userTenantId && String(pay.TenantId) !== String(userTenantId)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }

    const groupAdminAccess = await assertGroupAdminPaymentRetryAccess(pool, req.user, effectiveGroupId);
    if (!groupAdminAccess.ok) {
      return res.status(groupAdminAccess.status).json({ success: false, message: groupAdminAccess.message });
    }

    if (effectiveGroupId) {
      let pmQuery = `
        SELECT PaymentMethodId, Type, IsDefault, CardBrand, CardLast4, AccountNumberLast4, BankName
        FROM oe.GroupPaymentMethods
        WHERE GroupId = @groupId AND Status = 'Active'
      `;
      const pmRequest = pool.request().input('groupId', sql.UniqueIdentifier, effectiveGroupId);
      if (pay.LocationId) {
        pmQuery += ` AND (LocationId = @locationId OR LocationId IS NULL)`;
        pmRequest.input('locationId', sql.UniqueIdentifier, pay.LocationId);
        pmQuery += ` ORDER BY CASE WHEN LocationId = @locationId THEN 0 ELSE 1 END, IsDefault DESC`;
      } else {
        pmQuery += ` ORDER BY IsDefault DESC`;
      }
      const pmResult = await pmRequest.query(pmQuery);
      const paymentMethods = (pmResult.recordset || []).map((row) => {
        const type = (row.Type || 'Card').toString();
        const isAch = type.toLowerCase().includes('ach');
        const label = isAch
          ? `${row.BankName || 'Bank'} ••••${row.AccountNumberLast4 || row.CardLast4 || '****'}`
          : `${row.CardBrand || 'Card'} ••••${row.CardLast4 || '****'}`;
        return {
          paymentMethodId: row.PaymentMethodId,
          label,
          type: isAch ? 'ACH' : 'Card',
          isDefault: !!row.IsDefault
        };
      });
      const linkedInvoiceGrp =
        pay.InvoiceId
          ? {
              invoiceId: String(pay.InvoiceId),
              invoiceNumber: pay.LinkedInvoiceNumber ?? null,
              billingPeriodStart: pay.LinkedInvoiceBillingPeriodStart ?? null,
              billingPeriodEnd: pay.LinkedInvoiceBillingPeriodEnd ?? null,
              status: pay.LinkedInvoiceStatus ?? null
            }
          : null;

      return res.json({
        success: true,
        context: 'group',
        groupId: effectiveGroupId,
        paymentMethods,
        linkedInvoice: linkedInvoiceGrp
      });
    }

    if (effectiveHouseholdId) {
      const primaryResult = await pool.request()
        .input('householdId', sql.UniqueIdentifier, effectiveHouseholdId)
        .query(`
          SELECT m.MemberId
          FROM oe.Members m
          WHERE m.HouseholdId = @householdId AND m.RelationshipType = 'P'
        `);
      const primary = primaryResult.recordset[0];
      if (!primary) {
        return res.status(400).json({ success: false, message: 'Household primary not found' });
      }

      const mpmResult = await pool.request()
        .input('memberId', sql.UniqueIdentifier, primary.MemberId)
        .query(`
          SELECT PaymentMethodId, PaymentMethodType, IsDefault, CardBrand, CardLast4, AccountNumberLast4, BankName
          FROM oe.MemberPaymentMethods
          WHERE MemberId = @memberId AND Status = 'Active'
          ORDER BY IsDefault DESC
        `);
      const paymentMethods = (mpmResult.recordset || []).map((row) => {
        const type = (row.PaymentMethodType || 'Card').toString();
        const isAch = type === 'ACH';
        const label = isAch
          ? `${row.BankName || 'Bank'} ••••${row.AccountNumberLast4 || row.CardLast4 || '****'}`
          : `${row.CardBrand || 'Card'} ••••${row.CardLast4 || '****'}`;
        return {
          paymentMethodId: row.PaymentMethodId,
          label,
          type: isAch ? 'ACH' : 'Card',
          isDefault: !!row.IsDefault
        };
      });
      const { buildHouseholdChargeNowPreviewData } = require('../services/householdChargePreview.service');
      let chargeNowPreview = null;
      try {
        chargeNowPreview = await buildHouseholdChargeNowPreviewData(pool, effectiveHouseholdId);
      } catch (_e) {
        chargeNowPreview = null;
      }

      const linkedInvoice =
        pay.InvoiceId
          ? {
              invoiceId: String(pay.InvoiceId),
              invoiceNumber: pay.LinkedInvoiceNumber ?? null,
              billingPeriodStart: pay.LinkedInvoiceBillingPeriodStart ?? null,
              billingPeriodEnd: pay.LinkedInvoiceBillingPeriodEnd ?? null,
              status: pay.LinkedInvoiceStatus ?? null
            }
          : null;

      return res.json({
        success: true,
        context: 'household',
        householdId: effectiveHouseholdId,
        paymentMethods,
        linkedInvoice,
        chargeNowPreview
      });
    }

    return res.status(400).json({
      success: false,
      message: 'Payment is not linked to a group or household'
    });
  } catch (error) {
    console.error('Error fetching retry options:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Retry failed payment via DIME (charge-ach or charge-card with stored payment method)
router.post('/payments/:paymentId/retry', authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin']), async (req, res) => {
  try {
    const { paymentId } = req.params;
    const body = req.body || {};
    const pool = await getPool();

    const payResult = await pool.request()
      .input('paymentId', sql.UniqueIdentifier, paymentId)
      .query(`
        SELECT PaymentId, Status, Amount, TenantId, GroupId, HouseholdId, EnrollmentId, LocationId, PaymentMethod,
          InvoiceId
        FROM oe.Payments
        WHERE PaymentId = @paymentId AND Status IN ('Failed', 'Pending')
      `);

    if (payResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found or not retryable'
      });
    }

    const pay = payResult.recordset[0];
    let effectiveGroupId = pay.GroupId;
    let effectiveHouseholdId = pay.HouseholdId;

    // Resolve GroupId/HouseholdId from enrollment if not set on payment (e.g. legacy or some flows)
    if (!effectiveGroupId && !effectiveHouseholdId && pay.EnrollmentId) {
      const enrollResult = await pool.request()
        .input('enrollmentId', sql.UniqueIdentifier, pay.EnrollmentId)
        .query(`
          SELECT e.HouseholdId, m.GroupId
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE e.EnrollmentId = @enrollmentId
        `);
      if (enrollResult.recordset.length > 0) {
        effectiveHouseholdId = enrollResult.recordset[0].HouseholdId || effectiveHouseholdId;
        effectiveGroupId = enrollResult.recordset[0].GroupId || effectiveGroupId;
      }
    }

    const tenantId = pay.TenantId;
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'Payment has no tenant and cannot be retried'
      });
    }

    // Tenant scope: non-SysAdmin can only retry payments for their tenant
    const userRoles = getUserRoles(req.user);
    if (!userRoles.includes('SysAdmin')) {
      const userTenantId = req.tenantId || req.user?.TenantId;
      if (userTenantId && String(tenantId) !== String(userTenantId)) {
        return res.status(403).json({
          success: false,
          message: 'You can only retry payments for your tenant'
        });
      }
    }

    const groupAdminAccess = await assertGroupAdminPaymentRetryAccess(pool, req.user, effectiveGroupId);
    if (!groupAdminAccess.ok) {
      return res.status(groupAdminAccess.status).json({ success: false, message: groupAdminAccess.message });
    }

    const amount = Number(pay.Amount) || 0;
    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Payment amount must be greater than zero'
      });
    }

    let customerId = null;
    let paymentMethodId = null;
    let paymentMethodType = 'Card';
    let paymentMethodToken = null;
    let cardholderName = null;
    let billingAddress = null;
    let billingCity = null;
    let billingState = null;
    let billingZip = null;
    /** ACH charge-ach needs decrypted routing/account (same as members charge-now / groupBilling invoice charge). */
    let achForDime = null;
    const rawMethod = (pay.PaymentMethod || '').toString().toLowerCase();
    if (rawMethod.includes('ach') || rawMethod.includes('bank') || rawMethod.includes('checking') || rawMethod.includes('savings')) {
      paymentMethodType = 'ACH';
    }

    if (effectiveGroupId) {
      const groupRow = await pool.request()
        .input('groupId', sql.UniqueIdentifier, effectiveGroupId)
        .query(`
          SELECT g.ProcessorCustomerId
          FROM oe.Groups g
          WHERE g.GroupId = @groupId
        `);
      const selectedGroupPmId = body.groupPaymentMethodId ? String(body.groupPaymentMethodId).trim() : null;
      let pmQuery = `
        SELECT PaymentMethodId, ProcessorPaymentMethodId, ProcessorCustomerId, Type,
          ProcessorToken, CardholderName, AccountHolderName, AccountType, BankName,
          BillingAddress, BillingAddress2, BillingCity, BillingState, BillingZip,
          RoutingNumber, RoutingNumberEncrypted, AccountNumberEncrypted
        FROM oe.GroupPaymentMethods
        WHERE GroupId = @groupId AND Status = 'Active'
      `;
      const pmRequest = pool.request().input('groupId', sql.UniqueIdentifier, effectiveGroupId);
      if (selectedGroupPmId) {
        pmQuery += ` AND PaymentMethodId = @selectedPaymentMethodId`;
        pmRequest.input('selectedPaymentMethodId', sql.UniqueIdentifier, selectedGroupPmId);
      }
      if (pay.LocationId) {
        pmQuery += ` AND (LocationId = @locationId OR LocationId IS NULL)`;
        pmRequest.input('locationId', sql.UniqueIdentifier, pay.LocationId);
      }
      if (!selectedGroupPmId) {
        pmQuery += pay.LocationId
          ? ` ORDER BY CASE WHEN LocationId = @locationId THEN 0 ELSE 1 END, IsDefault DESC`
          : ` ORDER BY IsDefault DESC`;
      }
      const pmResult = await pmRequest.query(pmQuery);
      const pm = pmResult.recordset[0];
      if (!pm?.ProcessorPaymentMethodId) {
        return res.status(400).json({
          success: false,
          message: selectedGroupPmId ? 'Selected payment method not found or inactive' : 'No active payment method found for this group/location; cannot retry'
        });
      }
      customerId = groupRow.recordset[0]?.ProcessorCustomerId || pm?.ProcessorCustomerId;
      if (!customerId) {
        return res.status(400).json({
          success: false,
          message: 'Group has no payment processor customer; cannot retry'
        });
      }
      paymentMethodId = String(pm.ProcessorPaymentMethodId);
      if ((pm.Type || '').toString().toLowerCase().includes('ach')) paymentMethodType = 'ACH';
      else paymentMethodType = 'Card';

      if (paymentMethodType === 'ACH') {
        const routingNumber = resolveAchRoutingForCharge(pm.RoutingNumber, pm.RoutingNumberEncrypted);
        let accountNumber = null;
        if (pm.AccountNumberEncrypted) {
          try {
            const decryptedAcct = encryptionService.decryptPaymentData({
              accountNumberEncrypted: pm.AccountNumberEncrypted
            });
            if (decryptedAcct.accountNumber) {
              accountNumber = String(decryptedAcct.accountNumber).replace(/\D/g, '');
            }
          } catch (decryptErr) {
            console.error('❌ Payment retry: failed to decrypt group ACH account:', decryptErr);
            return res.status(400).json({
              success: false,
              message: 'Failed to decrypt ACH payment details for retry. Re-add the group payment method or try again.'
            });
          }
        }
        if (!routingNumber || !accountNumber) {
          return res.status(400).json({
            success: false,
            message: 'ACH payment method is missing stored routing or account details. Remove and re-add the payment method, then retry.'
          });
        }
        const holderName =
          (pm.AccountHolderName && String(pm.AccountHolderName).trim()) ||
          (pm.CardholderName && String(pm.CardholderName).trim()) ||
          'Account Holder';
        const nameParts = holderName.split(/\s+/).filter(Boolean);
        achForDime = {
          routingNumber,
          accountNumber,
          accountType: pm.AccountType || 'Checking',
          accountHolderName: holderName,
          bankName: pm.BankName || 'Bank',
          billingFirstName: nameParts[0] || '',
          billingLastName: nameParts.slice(1).join(' ') || '',
          billingAddress: (pm.BillingAddress && String(pm.BillingAddress).trim()) || '',
          billingCity: (pm.BillingCity && String(pm.BillingCity).trim()) || '',
          billingState: (pm.BillingState && String(pm.BillingState).trim()) || '',
          billingZip: (pm.BillingZip && String(pm.BillingZip).trim()) || ''
        };
      } else if (!(pm.ProcessorToken && pm.ProcessorToken.trim())) {
        return res.status(400).json({
          success: false,
          message: 'Stored card payment method has no token; cannot retry. Please update or re-add the payment method.'
        });
      } else {
        paymentMethodToken = pm.ProcessorToken ? String(pm.ProcessorToken).trim() : null;
        cardholderName = (pm.CardholderName && String(pm.CardholderName).trim()) || null;
        billingAddress = (pm.BillingAddress && String(pm.BillingAddress).trim()) || null;
        billingCity = (pm.BillingCity && String(pm.BillingCity).trim()) || null;
        billingState = (pm.BillingState && String(pm.BillingState).trim()) || null;
        billingZip = (pm.BillingZip && String(pm.BillingZip).trim()) || null;
      }
    } else if (effectiveHouseholdId) {
      const primaryResult = await pool.request()
        .input('householdId', sql.UniqueIdentifier, effectiveHouseholdId)
        .query(`
          SELECT m.MemberId, m.ProcessorCustomerId
          FROM oe.Members m
          WHERE m.HouseholdId = @householdId AND m.RelationshipType = 'P'
        `);
      const primary = primaryResult.recordset[0];
      if (!primary) {
        return res.status(400).json({
          success: false,
          message: 'Household primary member not found; cannot retry'
        });
      }
      const selectedMemberPmId = body.memberPaymentMethodId ? String(body.memberPaymentMethodId).trim() : null;
      let mpmQuery = `
        SELECT ProcessorCustomerId, ProcessorPaymentMethodId, PaymentMethodType,
          ProcessorToken, CardholderName, AccountHolderName, AccountType, BankName,
          BillingAddress, BillingAddress2, BillingCity, BillingState, BillingZip,
          RoutingNumber, RoutingNumberEncrypted, AccountNumberEncrypted
        FROM oe.MemberPaymentMethods
        WHERE MemberId = @memberId AND Status = 'Active'
      `;
      const mpmRequest = pool.request().input('memberId', sql.UniqueIdentifier, primary.MemberId);
      if (selectedMemberPmId) {
        mpmQuery += ` AND PaymentMethodId = @selectedPaymentMethodId`;
        mpmRequest.input('selectedPaymentMethodId', sql.UniqueIdentifier, selectedMemberPmId);
      }
      mpmQuery += ` ORDER BY IsDefault DESC`;
      const mpmResult = await mpmRequest.query(mpmQuery);
      const mpm = mpmResult.recordset[0];
      if (!mpm?.ProcessorPaymentMethodId) {
        return res.status(400).json({
          success: false,
          message: selectedMemberPmId ? 'Selected payment method not found or inactive' : 'No active payment method found for this household; cannot retry'
        });
      }
      customerId = primary.ProcessorCustomerId || mpm.ProcessorCustomerId;
      if (!customerId) {
        return res.status(400).json({
          success: false,
          message: 'No active payment method found for this household; cannot retry'
        });
      }
      paymentMethodId = String(mpm.ProcessorPaymentMethodId);
      paymentMethodType = (mpm.PaymentMethodType || 'Card') === 'ACH' ? 'ACH' : 'Card';

      if (paymentMethodType === 'ACH') {
        const routingNumber = resolveAchRoutingForCharge(mpm.RoutingNumber, mpm.RoutingNumberEncrypted);
        let accountNumber = null;
        if (mpm.AccountNumberEncrypted) {
          try {
            const decryptedAcct = encryptionService.decryptPaymentData({
              accountNumberEncrypted: mpm.AccountNumberEncrypted
            });
            if (decryptedAcct.accountNumber) {
              accountNumber = String(decryptedAcct.accountNumber).replace(/\D/g, '');
            }
          } catch (decryptErr) {
            console.error('❌ Payment retry: failed to decrypt member ACH account:', decryptErr);
            return res.status(400).json({
              success: false,
              message: 'Failed to decrypt ACH payment details for retry. The member payment method may need to be re-added.'
            });
          }
        }
        if (!routingNumber || !accountNumber) {
          return res.status(400).json({
            success: false,
            message: 'ACH payment method is missing stored routing or account details. Remove and re-add the payment method, then retry.'
          });
        }
        const holderName =
          (mpm.AccountHolderName && String(mpm.AccountHolderName).trim()) ||
          (mpm.CardholderName && String(mpm.CardholderName).trim()) ||
          'Account Holder';
        const nameParts = holderName.split(/\s+/).filter(Boolean);
        achForDime = {
          routingNumber,
          accountNumber,
          accountType: mpm.AccountType || 'Checking',
          accountHolderName: holderName,
          bankName: mpm.BankName || 'Bank',
          billingFirstName: nameParts[0] || '',
          billingLastName: nameParts.slice(1).join(' ') || '',
          billingAddress: (mpm.BillingAddress && String(mpm.BillingAddress).trim()) || '',
          billingCity: (mpm.BillingCity && String(mpm.BillingCity).trim()) || '',
          billingState: (mpm.BillingState && String(mpm.BillingState).trim()) || '',
          billingZip: (mpm.BillingZip && String(mpm.BillingZip).trim()) || ''
        };
      } else if (!(mpm.ProcessorToken && mpm.ProcessorToken.trim())) {
        return res.status(400).json({
          success: false,
          message: 'Stored card payment method has no token; cannot retry. Please update or re-add the payment method.'
        });
      } else {
        paymentMethodToken = mpm.ProcessorToken ? String(mpm.ProcessorToken).trim() : null;
        cardholderName = (mpm.CardholderName && String(mpm.CardholderName).trim()) || null;
        billingAddress = (mpm.BillingAddress && String(mpm.BillingAddress).trim()) || null;
        billingCity = (mpm.BillingCity && String(mpm.BillingCity).trim()) || null;
        billingState = (mpm.BillingState && String(mpm.BillingState).trim()) || null;
        billingZip = (mpm.BillingZip && String(mpm.BillingZip).trim()) || null;
      }
    } else {
      console.warn('Payment retry: no GroupId, HouseholdId, or EnrollmentId to resolve:', { paymentId, hasEnrollmentId: !!pay.EnrollmentId });
      return res.status(400).json({
        success: false,
        message: 'Payment is not linked to a group or household; cannot retry. If this payment has an enrollment, the enrollment may be missing or invalid.'
      });
    }

    /** Target invoice for household retries (Charge now parity): period / explicit id / existing payment link. */
    let invoiceIdForFulfillmentSync = pay.InvoiceId ? String(pay.InvoiceId) : null;

    if (effectiveHouseholdId) {
      const invoiceServiceMod = require('../services/invoiceService');
      const bpStartRaw = body.billingPeriodStart;
      const bpEndRaw = body.billingPeriodEnd;
      const bodyInvoiceIdTrim = typeof body.invoiceId === 'string' ? body.invoiceId.trim() : '';

      if (bpStartRaw && bpEndRaw) {
        try {
          const invResult = await invoiceServiceMod.getOrCreateInvoiceForPeriod(
            effectiveHouseholdId,
            tenantId,
            new Date(bpStartRaw),
            new Date(bpEndRaw)
          );
          if (invResult?.invoiceId) {
            invoiceIdForFulfillmentSync = String(invResult.invoiceId);
          }
        } catch (invErr) {
          console.error('Payment retry: invoice resolve from billing period:', invErr);
          return res.status(400).json({
            success: false,
            message: invErr.message || 'Could not resolve invoice for the selected billing period.'
          });
        }
      } else if (bodyInvoiceIdTrim) {
        const invCheck = await pool.request()
          .input('invoiceId', sql.UniqueIdentifier, bodyInvoiceIdTrim)
          .input('householdId', sql.UniqueIdentifier, effectiveHouseholdId)
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .query(`
            SELECT InvoiceId FROM oe.Invoices
            WHERE InvoiceId = @invoiceId AND HouseholdId = @householdId AND TenantId = @tenantId
          `);
        if (!invCheck.recordset.length) {
          return res.status(400).json({
            success: false,
            message: 'Invoice not found for this household or tenant.'
          });
        }
        invoiceIdForFulfillmentSync = bodyInvoiceIdTrim;
      }
    }

    const idempotencyKey = `retry_${paymentId}_${Date.now()}`;
    const invoiceNumber = `RETRY-${paymentId}`;
    const description = `Payment retry for ${invoiceNumber}`;

    const updProcessing = pool.request()
      .input('paymentId', sql.UniqueIdentifier, paymentId)
      .input('transactionId', sql.NVarChar, idempotencyKey);
    let processingSql = `
        UPDATE oe.Payments
        SET Status = 'Processing', ProcessorTransactionId = @transactionId, ModifiedDate = GETUTCDATE(), FailureReason = NULL`;

    if (invoiceIdForFulfillmentSync && effectiveHouseholdId) {
      updProcessing.input('retryInvoiceId', sql.UniqueIdentifier, invoiceIdForFulfillmentSync);
      processingSql += `, InvoiceId = @retryInvoiceId`;
    }
    processingSql += ` WHERE PaymentId = @paymentId`;
    await updProcessing.query(processingSql);

    const dimeBasePayload = {
      customerId,
      amount,
      description,
      invoiceNumber,
      paymentMethodType,
      idempotencyKey,
      tenantId
    };

    let paymentResult;
    if (paymentMethodType === 'ACH') {
      if (!achForDime) {
        return res.status(400).json({
          success: false,
          message: 'ACH retry could not resolve bank account details.'
        });
      }
      paymentResult = await DimeService.processPayment({ ...dimeBasePayload, ...achForDime }, tenantId);
    } else {
      paymentResult = await DimeService.processPayment(
        {
          ...dimeBasePayload,
          paymentMethodId,
          paymentMethodToken: paymentMethodToken || undefined,
          cardholderName: cardholderName || undefined,
          billingAddress: billingAddress || undefined,
          billingCity: billingCity || undefined,
          billingState: billingState || undefined,
          billingZip: billingZip || undefined
        },
        tenantId
      );
    }

    if (paymentResult.success && paymentResult.transactionId) {
      const statusBeforeCompletion = pay.Status;
      await pool.request()
        .input('paymentId', sql.UniqueIdentifier, paymentId)
        .input('processorTransactionId', sql.NVarChar, paymentResult.transactionId)
        .query(`
          UPDATE oe.Payments
          SET Status = 'Completed', ProcessorTransactionId = @processorTransactionId, ModifiedDate = GETUTCDATE(), FailureReason = NULL
          WHERE PaymentId = @paymentId
        `);

      /** Same path as webhook / DIME status audit when a payment becomes successful */
      let invoiceSync = { applied: false, reason: 'skipped' };
      try {
        invoiceSync = await syncInvoiceAfterPaymentStatusChange(pool, sql, {
          invoiceId: invoiceIdForFulfillmentSync || pay.InvoiceId,
          paymentAmount: amount,
          previousStatus: statusBeforeCompletion,
          newStatus: 'Completed'
        });
      } catch (invErr) {
        console.error('Payment retry invoice sync:', invErr);
        invoiceSync = { applied: false, reason: invErr.message || 'invoice_sync_error' };
      }

      let dimeRecurringReschedule = { skipped: true };
      const recurringInvoiceId = invoiceIdForFulfillmentSync || (pay.InvoiceId ? String(pay.InvoiceId) : null);
      if (
        !effectiveGroupId &&
        effectiveHouseholdId &&
        recurringInvoiceId &&
        body.skipDimeRecurringReschedule !== true &&
        body.skipDimeRecurringReschedule !== 'true'
      ) {
        try {
          dimeRecurringReschedule =
            await invoiceService.rescheduleDimeRecurringAfterAccountingPaymentRetry(
              pool,
              effectiveHouseholdId,
              tenantId,
              recurringInvoiceId
            );
        } catch (dimeResErr) {
          console.error('Payment retry DIME recurring reschedule:', dimeResErr);
          dimeRecurringReschedule = {
            skipped: false,
            error: dimeResErr.message || String(dimeResErr)
          };
        }
      }

      let msg = 'Payment retry successful';
      if (invoiceSync.applied) {
        msg = 'Payment retry successful. Invoice balance was updated.';
      }

      return res.json({
        success: true,
        transactionId: paymentResult.transactionId,
        message: msg,
        invoiceSync,
        dimeRecurringReschedule
      });
    }

    const failureReason = (paymentResult.error && paymentResult.error.message) ? paymentResult.error.message : 'Retry failed';
    await pool.request()
      .input('paymentId', sql.UniqueIdentifier, paymentId)
      .input('failureReason', sql.NVarChar, failureReason)
      .query(`
        UPDATE oe.Payments
        SET Status = 'Failed', FailureReason = @failureReason, ModifiedDate = GETUTCDATE()
        WHERE PaymentId = @paymentId
      `);
    return res.status(400).json({
      success: false,
      message: failureReason,
      error: paymentResult.error || null
    });
  } catch (error) {
    console.error('Error retrying payment:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retry payment',
      error: error.message
    });
  }
});

// Get commissions
router.get('/commissions', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { status, agentId, tenantName, search, dateRange } = req.query;
    const pool = await getPool();
    
    let whereClause = "WHERE 1=1";
    const request = pool.request();
    
    if (status) {
      whereClause += " AND c.Status = @status";
      request.input('status', sql.NVarChar, status);
    }
    if (agentId) {
      whereClause += " AND c.AgentId = @agentId";
      request.input('agentId', sql.UniqueIdentifier, agentId);
    }
    if (tenantName) {
      whereClause += " AND t.Name = @tenantName";
      request.input('tenantName', sql.NVarChar, tenantName);
    }
    if (dateRange === '30d') {
      whereClause += " AND c.CreatedDate >= DATEADD(day, -30, GETUTCDATE())";
    }
    if (dateRange === '7d') {
      whereClause += " AND c.CreatedDate >= DATEADD(day, -7, GETUTCDATE())";
    }
    
    if (search) {
      whereClause += ` AND (
        ISNULL(au.FirstName + ' ' + au.LastName, 'Unknown') LIKE @search
        OR pr.Name LIKE @search
        OR t.Name LIKE @search
      )`;
      request.input('search', sql.NVarChar, `%${search}%`);
    }
    
    const commissionsQuery = `
      SELECT TOP 100
        c.CommissionId,
        ISNULL(au.FirstName + ' ' + au.LastName, 'Unknown') as AgentName,
        ISNULL(t.Name, 'Unknown Tenant') as TenantName,
        c.PaymentId,
        ISNULL(p.Amount, 0) as PaymentAmount,
        p.PaymentDate,
        pr.Name as ProductName,
        ISNULL(u.FirstName + ' ' + u.LastName, 'Unknown Member') as MemberName,
        c.Amount,
        c.AdvanceBalance,
        c.AppliedToBalance,
        c.TransactionType,
        c.OriginalCommissionId,
        c.HouseholdId,
        c.GroupId,
        c.PeriodStartDate,
        c.PeriodEndDate,
        c.Status,
        c.CreatedDate,
        c.RuleIds,
        -- Split commission details
        c.SplitPartnerAgentId,
        ISNULL(split_au.FirstName + ' ' + split_au.LastName, NULL) as SplitPartnerName,
        c.SplitPercentage,
        c.IsPrimaryInSplit,
        -- AdvanceBalance is stored on every commission row (balance at the time of that transaction)
        -- NULL means no advance balance (no advance exists or balance is 0)
        c.AdvanceBalance as RemainingAdvanceBalance
      FROM oe.Commissions c
      LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
      LEFT JOIN oe.Users au ON a.UserId = au.UserId
      LEFT JOIN oe.Payments p ON c.PaymentId = p.PaymentId
      LEFT JOIN oe.Enrollments e ON c.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
      LEFT JOIN oe.Tenants t ON g.TenantId = t.TenantId
      LEFT JOIN oe.Commissions adv ON c.OriginalCommissionId = adv.CommissionId
      LEFT JOIN oe.Agents split_a ON c.SplitPartnerAgentId = split_a.AgentId
      LEFT JOIN oe.Users split_au ON split_a.UserId = split_au.UserId
      ${whereClause}
      ORDER BY c.CreatedDate DESC
    `;
    
    const commissions = await request.query(commissionsQuery);
    
    // Summary query
    const summaryRequest = pool.request();
    
    // Re-add parameters
    if (status) summaryRequest.input('status', sql.NVarChar, status);
    if (agentId) summaryRequest.input('agentId', sql.UniqueIdentifier, agentId);
    if (tenantName) summaryRequest.input('tenantName', sql.NVarChar, tenantName);
    if (search) summaryRequest.input('search', sql.NVarChar, `%${search}%`);
    
    const summaryQuery = `
      SELECT 
        ISNULL(SUM(c.Amount), 0) as totalCommissions,
        ISNULL(SUM(CASE WHEN c.Status = 'Paid' THEN c.Amount ELSE 0 END), 0) as totalPaid,
        ISNULL(SUM(CASE WHEN c.Status = 'Earned' THEN c.Amount ELSE 0 END), 0) as totalPending,
        COUNT(DISTINCT c.AgentId) as totalAgents,
        AVG(c.Amount) as averageCommission,
        12.3 as monthlyGrowth
      FROM oe.Commissions c
      LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
      LEFT JOIN oe.Users au ON a.UserId = au.UserId
      LEFT JOIN oe.Enrollments e ON c.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
      LEFT JOIN oe.Tenants t ON g.TenantId = t.TenantId
      ${whereClause}
    `;
    
    const summary = await summaryRequest.query(summaryQuery);
    
    res.json({
      success: true,
      commissions: commissions.recordset,
      summary: summary.recordset[0] || {
        totalCommissions: 0,
        totalPaid: 0,
        totalPending: 0,
        totalAgents: 0,
        averageCommission: 0,
        monthlyGrowth: 0
      }
    });
  } catch (error) {
    console.error('Error fetching commissions:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch commissions',
      error: error.message 
    });
  }
});

// Process commissions
router.post('/commissions/process', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { commissionIds } = req.body;
    
    if (!commissionIds || !Array.isArray(commissionIds) || commissionIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Commission IDs are required' 
      });
    }
    
    const pool = await getPool();
    const request = pool.request();
    
    // Add each ID as a parameter
    const placeholders = [];
    commissionIds.forEach((id, index) => {
      request.input(`id${index}`, sql.UniqueIdentifier, id);
      placeholders.push(`@id${index}`);
    });
    
    const result = await request.query(`
      UPDATE oe.Commissions 
      SET Status = 'Paid', PaymentDate = GETUTCDATE(), ModifiedDate = GETUTCDATE()
      WHERE CommissionId IN (${placeholders.join(',')}) AND Status = 'Pending'
    `);
    
    res.json({ 
      success: true, 
      processedCount: result.rowsAffected[0],
      failedCount: commissionIds.length - result.rowsAffected[0],
      message: `Successfully processed ${result.rowsAffected[0]} commission(s)`
    });
  } catch (error) {
    console.error('Error processing commissions:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to process commissions',
      error: error.message 
    });
  }
});

// Get reports
router.get('/reports', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const pool = await getPool();
    
    // Revenue by month
    const revenueByMonthQuery = `
      SELECT 
        FORMAT(p.PaymentDate, 'yyyy-MM') as month,
        SUM(CASE WHEN p.Status = 'Completed' THEN p.Amount ELSE 0 END) as revenue,
        COUNT(CASE WHEN p.Status = 'Completed' THEN 1 END) as payments,
        ISNULL(SUM(c.Amount), 0) as commissions,
        SUM(CASE WHEN p.Status = 'Completed' THEN p.Amount ELSE 0 END) - ISNULL(SUM(c.Amount), 0) as netRevenue
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Commissions c ON e.EnrollmentId = c.EnrollmentId
      WHERE p.PaymentDate >= DATEADD(month, -12, GETUTCDATE())
      GROUP BY FORMAT(p.PaymentDate, 'yyyy-MM')
      ORDER BY month DESC
    `;
    
    // Revenue by tenant  
    const revenueByTenantQuery = `
      SELECT TOP 10
        ISNULL(t.Name, 'Unknown Tenant') as tenantName,
        SUM(CASE WHEN p.Status = 'Completed' THEN p.Amount ELSE 0 END) as revenue,
        COUNT(DISTINCT m.MemberId) as members,
        COUNT(DISTINCT pr.ProductId) as products
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
      LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
      LEFT JOIN oe.Tenants t ON g.TenantId = t.TenantId
      WHERE p.PaymentDate >= DATEADD(month, -1, GETUTCDATE())
      GROUP BY t.TenantId, t.Name
      HAVING SUM(CASE WHEN p.Status = 'Completed' THEN p.Amount ELSE 0 END) > 0
      ORDER BY revenue DESC
    `;
    
    // Revenue by product
    const revenueByProductQuery = `
      SELECT TOP 10
        pr.Name as productName,
        pr.ProductType,
        SUM(CASE WHEN p.Status = 'Completed' THEN p.Amount ELSE 0 END) as revenue,
        COUNT(CASE WHEN p.Status = 'Completed' THEN 1 END) as subscriptions,
        AVG(CASE WHEN p.Status = 'Completed' THEN p.Amount END) as averagePrice
      FROM oe.Products pr
      LEFT JOIN oe.Enrollments e ON pr.ProductId = e.ProductId
      LEFT JOIN oe.Payments p ON e.EnrollmentId = p.EnrollmentId
      WHERE p.PaymentDate >= DATEADD(month, -1, GETUTCDATE())
      GROUP BY pr.ProductId, pr.Name, pr.ProductType
      HAVING SUM(CASE WHEN p.Status = 'Completed' THEN p.Amount ELSE 0 END) > 0
      ORDER BY revenue DESC
    `;
    
    // Commissions by agent
    // Note: Percentage column was removed - calculate average rate as (commission / payment amount) * 100
    const commissionsByAgentQuery = `
      SELECT TOP 10
        ISNULL(au.FirstName + ' ' + au.LastName, 'Unknown Agent') as agentName,
        ISNULL(t.Name, 'Unknown Tenant') as tenantName,
        SUM(c.Amount) as totalCommissions,
        SUM(CASE WHEN p.Status = 'Completed' THEN p.Amount ELSE 0 END) as totalSales,
        CASE 
          WHEN SUM(CASE WHEN p.Status = 'Completed' THEN p.Amount ELSE 0 END) > 0 
          THEN (SUM(c.Amount) / SUM(CASE WHEN p.Status = 'Completed' THEN p.Amount ELSE 0 END)) * 100
          ELSE 0 
        END as averageRate
      FROM oe.Commissions c
      LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
      LEFT JOIN oe.Users au ON a.UserId = au.UserId
      LEFT JOIN oe.Enrollments e ON c.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Payments p ON e.EnrollmentId = p.EnrollmentId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
      LEFT JOIN oe.Tenants t ON g.TenantId = t.TenantId
      WHERE c.CreatedDate >= DATEADD(month, -1, GETUTCDATE())
      GROUP BY c.AgentId, au.FirstName, au.LastName, t.Name
      HAVING SUM(c.Amount) > 0
      ORDER BY totalCommissions DESC
    `;
    
    // Summary query
    const summaryQuery = `
      SELECT 
        SUM(CASE WHEN p.Status = 'Completed' THEN p.Amount ELSE 0 END) as totalRevenue,
        COUNT(CASE WHEN p.Status = 'Completed' THEN 1 END) as totalPayments,
        ISNULL(SUM(c.Amount), 0) as totalCommissions,
        SUM(CASE WHEN p.Status = 'Refunded' THEN p.Amount ELSE 0 END) as totalRefunds,
        8.5 as growthRate
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Commissions c ON e.EnrollmentId = c.EnrollmentId
      WHERE p.PaymentDate >= DATEADD(month, -1, GETUTCDATE())
    `;
    
    // Execute all queries
    const [revenueByMonth, revenueByTenant, revenueByProduct, commissionsByAgent, summary] = await Promise.all([
      pool.request().query(revenueByMonthQuery),
      pool.request().query(revenueByTenantQuery),
      pool.request().query(revenueByProductQuery),
      pool.request().query(commissionsByAgentQuery),
      pool.request().query(summaryQuery)
    ]);
    
    const summaryData = summary.recordset[0] || {};
    
    res.json({
      success: true,
      revenueByMonth: revenueByMonth.recordset,
      revenueByTenant: revenueByTenant.recordset,
      revenueByProduct: revenueByProduct.recordset,
      commissionsByAgent: commissionsByAgent.recordset,
      summary: {
        ...summaryData,
        netRevenue: (summaryData.totalRevenue || 0) - (summaryData.totalRefunds || 0)
      }
    });
  } catch (error) {
    console.error('Error fetching revenue reports:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch revenue reports',
      error: error.message 
    });
  }
});

// Export payments
router.get('/payments/export', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { format = 'csv' } = req.query;
    const pool = await getPool();
    
    if (format === 'csv') {
      const query = `
        SELECT 
          p.PaymentId,
          ISNULL(u.FirstName + ' ' + u.LastName, 'Unknown') as MemberName,
          ISNULL(t.Name, 'Unknown Tenant') as TenantName,
          pr.Name as ProductName,
          p.Amount,
          p.Status,
          p.PaymentMethod,
          FORMAT(p.PaymentDate, 'yyyy-MM-dd') as PaymentDate
        FROM oe.Payments p
        LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
        LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        LEFT JOIN oe.Tenants t ON g.TenantId = t.TenantId
        ORDER BY p.PaymentDate DESC
      `;
      
      const result = await pool.request().query(query);
      
      // Convert to CSV
      const headers = ['Payment ID', 'Member Name', 'Tenant', 'Product', 'Amount', 'Status', 'Method', 'Date'];
      const csvRows = [headers.join(',')];
      
      result.recordset.forEach(row => {
        const values = [
          row.PaymentId,
          `"${row.MemberName}"`,
          `"${row.TenantName}"`,
          `"${row.ProductName}"`,
          row.Amount,
          row.Status,
          row.PaymentMethod,
          row.PaymentDate
        ];
        csvRows.push(values.join(','));
      });
      
      res.json({
        success: true,
        data: csvRows.join('\n'),
        filename: `payments-export-${new Date().toISOString().split('T')[0]}.csv`
      });
    } else {
      res.json({
        success: true,
        data: 'PDF export functionality would be implemented here',
        filename: `payments-export-${new Date().toISOString().split('T')[0]}.pdf`
      });
    }
  } catch (error) {
    console.error('Error exporting payments:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to export payments',
      error: error.message 
    });
  }
});

// Export commissions
router.get('/commissions/export', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { format = 'csv' } = req.query;
    const pool = await getPool();
    
    if (format === 'csv') {
      const query = `
        SELECT 
          c.CommissionId,
          ISNULL(au.FirstName + ' ' + au.LastName, 'Unknown') as AgentName,
          ISNULL(t.Name, 'Unknown Tenant') as TenantName,
          pr.Name as ProductName,
          c.Amount,
          c.Percentage,
          c.Status,
          FORMAT(c.CreatedDate, 'yyyy-MM-dd') as CreatedDate,
          FORMAT(c.PaymentDate, 'yyyy-MM-dd') as PaymentDate
        FROM oe.Commissions c
        LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
        LEFT JOIN oe.Users au ON a.UserId = au.UserId
        LEFT JOIN oe.Enrollments e ON c.EnrollmentId = e.EnrollmentId
        LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
        LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        LEFT JOIN oe.Tenants t ON g.TenantId = t.TenantId
        ORDER BY c.CreatedDate DESC
      `;
      
      const result = await pool.request().query(query);
      
      // Convert to CSV
      const headers = ['Commission ID', 'Agent Name', 'Tenant', 'Product', 'Amount', 'Rate %', 'Status', 'Created', 'Paid'];
      const csvRows = [headers.join(',')];
      
      result.recordset.forEach(row => {
        const values = [
          row.CommissionId,
          `"${row.AgentName}"`,
          `"${row.TenantName}"`,
          `"${row.ProductName}"`,
          row.Amount,
          row.Percentage,
          row.Status,
          row.CreatedDate || '',
          row.PaymentDate || ''
        ];
        csvRows.push(values.join(','));
      });
      
      res.json({
        success: true,
        data: csvRows.join('\n'),
        filename: `commissions-export-${new Date().toISOString().split('T')[0]}.csv`
      });
    } else {
      res.json({
        success: true,
        data: 'PDF export functionality would be implemented here',
        filename: `commissions-export-${new Date().toISOString().split('T')[0]}.pdf`
      });
    }
  } catch (error) {
    console.error('Error exporting commissions:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to export commissions',
      error: error.message 
    });
  }
});

// Export reports
router.get('/reports/export', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { format = 'csv', reportType = 'summary' } = req.query;
    
    res.json({
      success: true,
      data: format === 'csv' 
        ? 'Month,Revenue,Payments\n2024-06,58940,342\n2024-05,62450,389'
        : 'PDF report data would be generated here',
      filename: `revenue-report-${reportType}-${new Date().toISOString().split('T')[0]}.${format}`
    });
  } catch (error) {
    console.error('Error exporting reports:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to export reports',
      error: error.message 
    });
  }
});

// Refund info (read-only): commission/vendor payout status and whether DIME Transaction Info ID is needed for refund
router.get('/payments/:paymentId/refund-info', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { paymentId } = req.params;
    const pool = await getPool();
    let paymentReq = pool.request();
    paymentReq.input('paymentId', sql.UniqueIdentifier, paymentId);

    let paymentRow = null;
    try {
      const payResult = await paymentReq.query(`
        SELECT Processor, ProcessorTransactionId, ProcessorTransactionInfoId, TenantId, PaymentMethod, InvoiceId
        FROM oe.Payments
        WHERE PaymentId = @paymentId
      `);
      paymentRow = payResult.recordset?.[0];
    } catch (e) {
      if ((e.message || '').includes('ProcessorTransactionInfoId') || (e.message || '').includes('Invalid column name')) {
        const fallback = await pool.request().input('paymentId', sql.UniqueIdentifier, paymentId).query(`
          SELECT Processor, ProcessorTransactionId, TenantId, PaymentMethod, InvoiceId
          FROM oe.Payments
          WHERE PaymentId = @paymentId
        `);
        paymentRow = fallback.recordset?.[0];
        if (paymentRow) paymentRow.ProcessorTransactionInfoId = null;
      } else {
        throw e;
      }
    }

    const paymentInvoiceId = paymentRow?.InvoiceId || null;

    const commissionPaidOrClawSql = paymentInvoiceId
      ? `(
          PaymentId = @paymentId
          OR (InvoiceId = @invoiceId AND PaymentId IS NULL)
        )`
      : `PaymentId = @paymentId`;

    const req1 = pool.request();
    req1.input('paymentId', sql.UniqueIdentifier, paymentId);
    if (paymentInvoiceId) req1.input('invoiceId', sql.UniqueIdentifier, paymentInvoiceId);
    const req2 = pool.request();
    req2.input('paymentId', sql.UniqueIdentifier, paymentId);
    const reqCommClaw = pool.request();
    reqCommClaw.input('paymentId', sql.UniqueIdentifier, paymentId);
    if (paymentInvoiceId) reqCommClaw.input('invoiceId', sql.UniqueIdentifier, paymentInvoiceId);
    const reqPayoutClaw = pool.request();
    reqPayoutClaw.input('paymentId', sql.UniqueIdentifier, paymentId);

    // Vendor payout check: match by PaymentId OR InvoiceId. Pre-shift this only
    // matched npd.PaymentId, which silently missed NACHA details stamped only
    // with InvoiceId (credit-funded vendor payouts under the same invoice as
    // this payment). That would falsely report "no vendor payout" and let an
    // operator process a refund without knowing the vendor was already paid.
    const [commissionResult, vendorResult, commClawbackResult, payoutClawbackRowsResult] = await Promise.all([
      req1.query(`
        SELECT 1 as HasPaid FROM oe.Commissions
        WHERE Status = 'Paid' AND ${commissionPaidOrClawSql}
      `),
      req2.query(`
        SELECT TOP 1 1 as HasPaid
        FROM oe.NACHAPaymentDetails npd
        INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
        LEFT JOIN oe.Payments p ON p.PaymentId = @paymentId
        WHERE (npd.PaymentId = @paymentId
               OR (p.InvoiceId IS NOT NULL AND npd.InvoiceId = p.InvoiceId))
          AND npd.RecipientEntityType = 'Vendor'
          AND ng.Status = 'Sent'
      `),
      reqCommClaw.query(`
        SELECT COUNT(1) AS Cnt
        FROM oe.Commissions
        WHERE Amount > 0
          AND TransactionType IN (N'Advance', N'Commission')
          AND ${commissionPaidOrClawSql}
      `),
      reqPayoutClaw.query(`
        SELECT d.RecipientEntityType,
               d.RecipientEntityId,
               SUM(d.Amount) AS PaidAmount,
               MAX(v.VendorName) AS VendorName,
               MAX(t.Name) AS TenantName
        FROM oe.Payments p
        INNER JOIN oe.NACHAPaymentDetails d ON (
          (d.PaymentId IS NOT NULL AND d.PaymentId = p.PaymentId)
          OR (
            d.PaymentId IS NULL
            AND d.InvoiceId IS NOT NULL
            AND p.InvoiceId IS NOT NULL
            AND d.InvoiceId = p.InvoiceId
          )
        )
        INNER JOIN oe.NACHAGenerations g ON g.NACHAId = d.NACHAId
        LEFT JOIN oe.Vendors v ON d.RecipientEntityType = N'Vendor' AND v.VendorId = d.RecipientEntityId
        LEFT JOIN oe.Tenants t ON d.RecipientEntityType = N'Tenant' AND t.TenantId = d.RecipientEntityId
        WHERE p.PaymentId = @paymentId
          AND g.Status IN (N'Pending', N'Sent')
          AND d.RecipientEntityType IN (N'Vendor', N'Tenant')
          AND d.Amount > 0
          AND d.ReissueOfNACHAPaymentDetailId IS NULL
        GROUP BY d.RecipientEntityType, d.RecipientEntityId
      `)
    ]);

    const hasCommissionPayout = (commissionResult.recordset?.length ?? 0) > 0;
    const hasVendorPayout = (vendorResult.recordset?.length ?? 0) > 0;

    const commissionClawbackApplies = Number(commClawbackResult.recordset?.[0]?.Cnt || 0) > 0;
    const vendorNames = [];
    const tenantOverrideNames = [];
    for (const row of payoutClawbackRowsResult.recordset || []) {
      const typ = String(row.RecipientEntityType || '');
      if (typ === 'Vendor') {
        const nm = (row.VendorName != null && String(row.VendorName).trim()) ? String(row.VendorName).trim() : 'Vendor';
        if (!vendorNames.includes(nm)) vendorNames.push(nm);
      } else if (typ === 'Tenant') {
        const nm = (row.TenantName != null && String(row.TenantName).trim()) ? String(row.TenantName).trim() : 'Tenant override';
        if (!tenantOverrideNames.includes(nm)) tenantOverrideNames.push(nm);
      }
    }
    vendorNames.sort((a, b) => a.localeCompare(b));
    tenantOverrideNames.sort((a, b) => a.localeCompare(b));
    const processorRaw = paymentRow?.Processor != null ? String(paymentRow.Processor).trim() : '';
    const processor = processorRaw.toLowerCase();
    /** Matches POST /refund: blank Processor is treated as DIME-integrated. */
    const useIntegratedDime = !processorRaw || processor.includes('dime');
    let hasProcessorTransactionInfoId = paymentRow?.ProcessorTransactionInfoId != null && String(paymentRow.ProcessorTransactionInfoId).trim() !== '';

    const canTryDimeLookup = useIntegratedDime && !hasProcessorTransactionInfoId && paymentRow?.ProcessorTransactionId && paymentRow?.TenantId;
    if (canTryDimeLookup) {
      const pm = String(paymentRow.PaymentMethod || '').toLowerCase();
      const transactionType = (pm.includes('ach') || pm.includes('bank')) ? 'ACH' : 'CC';
      console.log('🔍 Refund-info: attempting DIME GET /api/transaction to resolve transaction_info_id', {
        paymentId,
        processorTransactionId: String(paymentRow.ProcessorTransactionId).trim(),
        transactionType
      });
      const lookup = await DimeService.getTransaction(paymentRow.TenantId, String(paymentRow.ProcessorTransactionId).trim(), transactionType);
      if (lookup.success && lookup.transactionInfoId) {
        console.log('✅ Refund-info: DIME lookup got transaction_info_id', { transactionInfoId: lookup.transactionInfoId });
        hasProcessorTransactionInfoId = true;
        try {
          await pool.request()
            .input('paymentId', sql.UniqueIdentifier, paymentId)
            .input('processorTransactionInfoId', sql.NVarChar(255), lookup.transactionInfoId)
            .query(`
              UPDATE oe.Payments
              SET ProcessorTransactionInfoId = @processorTransactionInfoId
              WHERE PaymentId = @paymentId
            `);
        } catch (updateErr) {
          if (!(updateErr.message || '').includes('ProcessorTransactionInfoId') && !(updateErr.message || '').includes('Invalid column name')) {
            console.error('Error saving looked-up ProcessorTransactionInfoId:', updateErr.message);
          }
        }
      } else {
        console.log('⚠️ Refund-info: DIME lookup did not return transaction_info_id', { success: lookup.success, error: lookup.error?.message });
      }
    } else if (useIntegratedDime && !hasProcessorTransactionInfoId) {
      console.log('⚠️ Refund-info: skipping DIME lookup (missing ProcessorTransactionId or TenantId)', {
        hasProcessorTransactionId: !!paymentRow?.ProcessorTransactionId,
        hasTenantId: !!paymentRow?.TenantId
      });
    }

    const needsTransactionInfoId = useIntegratedDime && !hasProcessorTransactionInfoId;

    res.json({
      success: true,
      hasCommissionPayout,
      hasVendorPayout,
      needsTransactionInfoId,
      clawbackPreview: {
        commission: commissionClawbackApplies,
        vendors: vendorNames,
        tenantOverrides: tenantOverrideNames
      }
    });
  } catch (error) {
    console.error('Error fetching refund info:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST refund: DIME API must succeed first; then RefundService runs. Non-DIME Processor → 400 (use webhook/replay).
router.post('/payments/:paymentId/refund', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { paymentId } = req.params;
    const {
      amount: bodyAmount,
      reason: refundReason,
      transactionInfoId: bodyTransactionInfoId,
      skipClawbacks: bodySkipClawbacks,
      skipProcessorRefund: bodySkipProcessorRefund
    } = req.body || {};
    const skipClawbacks = bodySkipClawbacks === true;
    const skipProcessorRefund = bodySkipProcessorRefund === true;
    const pool = await getPool();

    const getRequest = pool.request();
    getRequest.input('paymentId', sql.UniqueIdentifier, paymentId);
    let payment;
    try {
      const paymentResult = await getRequest.query(`
        SELECT PaymentId, TenantId, Amount, ProcessorTransactionId, ProcessorTransactionInfoId, Processor, Status, PaymentMethod, InvoiceId
        FROM oe.Payments
        WHERE PaymentId = @paymentId
      `);
      payment = paymentResult.recordset?.[0];
    } catch (colErr) {
      if ((colErr.message || '').includes('ProcessorTransactionInfoId') || (colErr.message || '').includes('Invalid column name')) {
        const fallbackResult = await pool.request().input('paymentId', sql.UniqueIdentifier, paymentId).query(`
          SELECT PaymentId, TenantId, Amount, ProcessorTransactionId, Processor, Status, PaymentMethod
          FROM oe.Payments
          WHERE PaymentId = @paymentId
        `);
        payment = fallbackResult.recordset?.[0];
        if (payment) payment.ProcessorTransactionInfoId = null;
      } else {
        throw colErr;
      }
    }
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    const refundAmount = bodyAmount != null ? Number(bodyAmount) : Number(payment.Amount);
    if (isNaN(refundAmount) || refundAmount <= 0 || refundAmount > Number(payment.Amount)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid refund amount. Must be greater than 0 and not exceed payment amount.'
      });
    }

    const processorRaw = payment.Processor != null ? String(payment.Processor).trim() : '';
    const processor = processorRaw.toLowerCase();
    /** Live DIME refund before DB write; skipped when operator records refund in DB only. */
    const useIntegratedDimeRefund = !processorRaw || processor.includes('dime');
    let dimeRefundResultTxnId = null;

    if (!skipProcessorRefund) {
      if (!useIntegratedDimeRefund) {
        return res.status(400).json({
          success: false,
          code: 'REFUND_NOT_INTEGRATED_FOR_PROCESSOR',
          message:
            'This button only refunds through DIME. For other processors, refund there first, then record it using your usual webhook or replay process, or uncheck "Process refund on payment processor" to record in our database only.'
        });
      }

      const processorTransactionId = payment.ProcessorTransactionId ? String(payment.ProcessorTransactionId).trim() : null;
      const processorTransactionInfoId = payment.ProcessorTransactionInfoId != null && String(payment.ProcessorTransactionInfoId).trim() !== '' ? String(payment.ProcessorTransactionInfoId).trim() : null;
      const tenantId = payment.TenantId;
      const manualTransactionInfoId = bodyTransactionInfoId != null && String(bodyTransactionInfoId).trim() !== '' ? String(bodyTransactionInfoId).trim() : null;

      let dimeTransactionIdForRefund = processorTransactionInfoId || manualTransactionInfoId;
      if (!dimeTransactionIdForRefund && processorTransactionId) {
        const pm = String(payment.PaymentMethod || '').toLowerCase();
        const transactionType = (pm.includes('ach') || pm.includes('bank')) ? 'ACH' : 'CC';
        const lookup = await DimeService.getTransaction(tenantId, processorTransactionId, transactionType);
        if (lookup.success && lookup.transactionInfoId) {
          dimeTransactionIdForRefund = lookup.transactionInfoId;
        }
      }
      // Do not fall back to ProcessorTransactionId for refunds — DIME requires transaction_info_id, not transaction_number.

      if (!dimeTransactionIdForRefund) {
        return res.status(400).json({
          success: false,
          message:
            'Could not resolve DIME Transaction Info ID. Please enter it manually: open this payment in the DIME dashboard, go to transaction details, and copy the transaction_info_id into the refund form, then try again.'
        });
      }
      const dimeOutcome = await DimeService.refundTransaction(
        dimeTransactionIdForRefund,
        refundAmount,
        tenantId,
        payment.PaymentMethod
      );
      if (!dimeOutcome.success) {
        const msg = dimeOutcome.error?.message || 'DIME refund failed';
        console.error('Refund DIME failure:', { paymentId, processorTransactionId, error: dimeOutcome.error });
        return res.status(502).json({
          success: false,
          message: 'Payment processor refund failed: ' + msg,
          code: dimeOutcome.error?.code
        });
      }
      // DIME refund returns its own transaction id; surface it for idempotency.
      dimeRefundResultTxnId = dimeOutcome.transactionId || dimeOutcome.refundTransactionId || null;
    } else {
      console.warn('[accounting] POST refund with skipProcessorRefund=true (DB record only)', {
        paymentId,
        userId: req.user?.UserId,
        processor: processorRaw || null
      });
    }

    if (skipClawbacks) {
      console.warn('[accounting] POST refund with skipClawbacks=true', {
        paymentId,
        userId: req.user?.UserId
      });
    }

    const RefundService = require('../services/refundService');
    let result;
    try {
      result = await RefundService.processRefund({
        paymentId,
        refundAmount,
        reason: refundReason,
        processedBy: req.user?.UserId,
        processorTxnId: dimeRefundResultTxnId,
        source: 'manual',
        bypassTenantGuard: false,
        user: req.user,
        skipClawbacks
      });
    } catch (dbErr) {
      // Phase 11 hardening: processor (DIME) already succeeded, but our DB
      // transaction failed. Surface a recoverable error with the DIME txn id
      // so an operator can replay via the internal endpoint without
      // double-charging the customer.
      console.error('[refund] DB transaction failed after processor success — REQUIRES MANUAL REPLAY', {
        paymentId,
        refundAmount,
        dimeRefundResultTxnId,
        error: dbErr?.message
      });
      return res.status(500).json({
        success: false,
        code: 'REFUND_DB_FAILURE_AFTER_PROCESSOR',
        message: `Refund was processed by the payment processor but the database update failed. Replay required. processorTxnId=${dimeRefundResultTxnId || 'N/A'}. Error: ${dbErr?.message || 'Unknown'}`,
        recoverable: true,
        dimeRefundResultTxnId
      });
    }

    if (!result.success) {
      const status = result.code === 'NOT_FOUND' ? 404
        : result.code === 'FORBIDDEN' ? 403
        : result.code === 'INVALID_STATUS' || result.code === 'EXCEEDS_AMOUNT' || result.code === 'INVALID_AMOUNT' || result.code === 'INVALID_INPUT' ? 400
        : 500;
      // If processor already ran but DB layer rejected with TXN_FAILED, surface
      // the dime txn id so operators can replay manually instead of clicking
      // refund again (which would double-charge).
      if (result.code === 'TXN_FAILED' && dimeRefundResultTxnId) {
        return res.status(500).json({
          success: false,
          code: 'REFUND_DB_FAILURE_AFTER_PROCESSOR',
          message: `Refund processed by DIME but DB write failed. Replay via /api/internal/refunds/process with processorTxnId=${dimeRefundResultTxnId}.`,
          dimeRefundResultTxnId,
          recoverable: true
        });
      }
      return res.status(status).json({ success: false, message: result.message, code: result.code });
    }

    res.json({
      success: true,
      message: result.alreadyProcessed
        ? 'Refund already recorded (idempotent)'
        : skipProcessorRefund
          ? 'Refund recorded in database (payment processor was not contacted)'
          : 'Refund processed successfully',
      partial: !!result.partial,
      refundPaymentId: result.refundPaymentId,
      recordedInDatabaseOnly: skipProcessorRefund
    });
  } catch (error) {
    console.error('Error processing refund:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Process commission payout
router.post('/commissions/payout', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { commissionIds } = req.body;
    
    if (!commissionIds || commissionIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No commissions selected' 
      });
    }
    
    const pool = await getPool();
    const request = pool.request();
    
    // Add each ID as a parameter
    const placeholders = [];
    commissionIds.forEach((id, index) => {
      request.input(`id${index}`, sql.UniqueIdentifier, id);
      placeholders.push(`@id${index}`);
    });
    
    const result = await request.query(`
      UPDATE oe.Commissions 
      SET Status = 'Paid', PaymentDate = GETUTCDATE(), ModifiedDate = GETUTCDATE()
      WHERE CommissionId IN (${placeholders.join(',')}) AND Status = 'Earned'
    `);
    
    res.json({ 
      success: true, 
      message: 'Commission payout processed',
      processedCount: result.rowsAffected[0],
      failedCount: commissionIds.length - result.rowsAffected[0]
    });
  } catch (error) {
    console.error('Error processing payout:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

module.exports = router;
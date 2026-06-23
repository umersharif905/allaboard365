const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getPool, rawSql } = require('../config/database');
const sql = require('mssql');
const { requireShared } = require('../config/shared-modules');
const {
  buildGroupProductSnapshotsForPeriod,
  getPricingFields
} = requireShared('payment-product-snapshots');
const PDFDocument = require('pdfkit');
const { BlobServiceClient } = require('@azure/storage-blob');
const DimeService = require('../services/dimeService');
const dimeCardBrand = require('../services/dimeCardBrand');
const PaymentMethodService = require('../services/PaymentMethodService');
const { authorize, requireTenantAccess, getUserRoles } = require('../middleware/auth');
const { isSuccessfulPaymentRecordStatus } = requireShared('payment-status');
const { PENDING_BANK_APPROVAL_MESSAGE } = requireShared('payment-messages');
const invoiceService = require('../services/invoiceService');
const { generateInvoicePdf, prepareTenantLogoBufferForPdf } = require('../services/invoicePdfService');
const { generateInvoiceEmailHtml } = require('../services/invoiceEmailService');
const MessageQueueService = require('../services/messageQueue.service');
const encryptionService = require('../services/encryptionService');
const { resolveAchRoutingForCharge } = require('../utils/achRouting');
const { getAccessibleAgentIdsForUser, buildAgentScopeClause } = require('../utils/agentGroupAccess');
const {
  invoiceDueDateBeforeTenantLocalTodayPredicate
} = require('../utils/invoiceTenantCalendarSql');

const GB_INV_OVERDUE_TZ = invoiceDueDateBeforeTenantLocalTodayPredicate('i', 't');

/**
 * Helper function to verify group access based on user role
 * @param {object} pool - Database pool
 * @param {string} groupId - Group ID to verify access for
 * @param {object} user - User object from req.user
 * @returns {Promise<{hasAccess: boolean, group: object}>}
 */
async function verifyGroupAccess(pool, groupId, user) {
  // Use currentRole instead of all roles to avoid conflicts when user has multiple roles
  const currentRole = user.currentRole || (getUserRoles(user)[0]);
  
  console.log(`🔐 Verifying group access for user ${user.UserId} with currentRole: ${currentRole}`);
  
  // SysAdmin has access to all groups
  if (currentRole === 'SysAdmin') {
    const request = pool.request();
    request.input('groupId', sql.UniqueIdentifier, groupId);
    const result = await request.query(`
      SELECT GroupId, TenantId, AgentId 
      FROM oe.Groups 
      WHERE GroupId = @groupId
    `);
    
    console.log(`✅ SysAdmin access granted for group ${groupId}`);
    return {
      hasAccess: result.recordset.length > 0,
      group: result.recordset[0] || null
    };
  }
  
  // Build query based on current role
  let query = `
    SELECT g.GroupId, g.TenantId, g.AgentId
    FROM oe.Groups g
    WHERE g.GroupId = @groupId
  `;
  
  const request = pool.request();
  request.input('groupId', sql.UniqueIdentifier, groupId);
  
  if (currentRole === 'GroupAdmin') {
    // GroupAdmin: Query from GroupAdmins table to find user's assigned group
    let userGroupId = user.GroupId || user.groupId;
    
    console.log(`🔍 Initial GroupAdmin check:`, {
      userId: user.UserId,
      userGroupIdFromJWT: userGroupId,
      requestedGroupId: groupId
    });
    
    // If GroupId not in JWT, query from GroupAdmins table
    if (!userGroupId) {
      const groupIdQuery = `
        SELECT GroupId 
        FROM oe.GroupAdmins 
        WHERE UserId = @userId AND Status = 'Active'
      `;
      const groupIdRequest = pool.request();
      groupIdRequest.input('userId', sql.UniqueIdentifier, user.UserId);
      const groupIdResult = await groupIdRequest.query(groupIdQuery);
      
      if (groupIdResult.recordset.length > 0 && groupIdResult.recordset[0].GroupId) {
        userGroupId = groupIdResult.recordset[0].GroupId;
        console.log(`🔍 Retrieved GroupId from GroupAdmins table: ${userGroupId}`);
      } else {
        console.log(`❌ No GroupId found in GroupAdmins table for UserId: ${user.UserId}`);
      }
    }
    
    if (!userGroupId) {
      console.log(`❌ GroupAdmin has no group assigned - access denied`);
      return { hasAccess: false, group: null };
    }
    
    query += ` AND g.GroupId = @userGroupId`;
    request.input('userGroupId', sql.UniqueIdentifier, userGroupId);
    console.log(`🔍 Checking GroupAdmin access: userGroupId = ${userGroupId}, requestedGroupId = ${groupId}`);
  } else if (currentRole === 'Agent') {
    const accessibleAgentIds = await getAccessibleAgentIdsForUser(pool, user);
    const agentScopeClause = buildAgentScopeClause(request, accessibleAgentIds, 'g.AgentId', 'agBill');
    query += ` AND ${agentScopeClause}`;
    console.log(`🔍 Checking Agent access with scoped agents: ${accessibleAgentIds.length}`);
  } else if (currentRole === 'TenantAdmin') {
    // TenantAdmin: Must match TenantId
    query += ` AND g.TenantId = @userTenantId`;
    request.input('userTenantId', sql.UniqueIdentifier, user.TenantId);
    console.log(`🔍 Checking TenantAdmin access: user.TenantId = ${user.TenantId}`);
  } else {
    console.log(`⚠️ Unknown role: ${currentRole}`);
    return { hasAccess: false, group: null };
  }
  
  const result = await request.query(query);
  
  if (result.recordset.length > 0) {
    console.log(`✅ Access granted for ${currentRole} to group ${groupId}`);
  } else {
    console.log(`❌ Access denied for ${currentRole} to group ${groupId}`);
  }
  
  return {
    hasAccess: result.recordset.length > 0,
    group: result.recordset[0] || null
  };
}

/**
 * Build per-location invoice rows from calculateLocationPremiums() result (fees from enrollments).
 */
async function buildLocationInvoiceResultsFromPremiums(pool, groupId, locationPremiums) {
  const locationResults = [];
  const locationsChargingToPrimary = [];

  let primaryPaymentMethodType = 'ACH';
  const primaryLoc = locationPremiums.find(lp => lp.LocationIsPrimary);
  if (primaryLoc) {
    const primaryPaymentMethodResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('locationId', sql.UniqueIdentifier, primaryLoc.LocationId)
      .query(`
        SELECT TOP 1 Type
        FROM oe.GroupPaymentMethods
        WHERE GroupId = @groupId 
          AND LocationId = @locationId
          AND IsDefault = 1 
          AND Status = 'Active'
      `);
    if (primaryPaymentMethodResult.recordset.length > 0) {
      primaryPaymentMethodType = primaryPaymentMethodResult.recordset[0].Type;
    }
  }

  for (const location of locationPremiums) {
    let paymentMethodType = 'ACH';
    if (location.UseLocationACH) {
      const paymentMethodResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('locationId', sql.UniqueIdentifier, location.LocationId)
        .query(`
          SELECT TOP 1 Type
          FROM oe.GroupPaymentMethods
          WHERE GroupId = @groupId 
            AND LocationId = @locationId
            AND IsDefault = 1 
            AND Status = 'Active'
        `);
      if (paymentMethodResult.recordset.length > 0) {
        paymentMethodType = paymentMethodResult.recordset[0].Type;
      }
    } else {
      paymentMethodType = primaryPaymentMethodType;
    }

    const unpaidSetupFees = location.UnpaidSetupFees || 0;
    const dbPaymentProcessingFee = location.PaymentProcessingFeeAmount || 0;
    const dbSystemFee = location.SystemFeeAmount || 0;

    if (dbPaymentProcessingFee === 0 && dbSystemFee === 0) {
      console.warn(`⚠️ WARNING: No fee enrollments found in oe.Enrollments for location ${location.LocationName} (SystemFee=$${dbSystemFee.toFixed(2)}, PaymentProcessingFee=$${dbPaymentProcessingFee.toFixed(2)})`);
    }

    const subtotalWithSystemFees = location.BasePremium + dbSystemFee;
    const fees = {
      systemFeesAmount: dbSystemFee,
      paymentProcessingFee: dbPaymentProcessingFee,
      setupFeesAmount: unpaidSetupFees,
      totalAmount: Math.round((subtotalWithSystemFees + dbPaymentProcessingFee + unpaidSetupFees) * 100) / 100,
      processingFees: Math.round((dbSystemFee + dbPaymentProcessingFee) * 100) / 100,
      subtotalWithSystemFees: subtotalWithSystemFees
    };

    if (!location.UseLocationACH) {
      locationsChargingToPrimary.push({ location, fees });
      if (location.LocationIsPrimary) {
        locationResults.push({
          locationId: location.LocationId,
          locationName: location.LocationName || 'Unnamed Location',
          isPrimary: true,
          basePremium: parseFloat(location.BasePremium || 0),
          basePremiumNonProfit: parseFloat(location.BasePremiumNonProfit || 0),
          basePremiumForProfit: parseFloat(location.BasePremiumForProfit || 0),
          systemFees: fees.systemFeesAmount,
          paymentProcessingFee: fees.paymentProcessingFee || 0,
          processingFees: fees.processingFees,
          setupFees: fees.setupFeesAmount,
          totalAmount: fees.totalAmount,
          householdCount: location.HouseholdCount || 0,
          memberCount: location.MemberCount || 0
        });
      }
      continue;
    }

    locationResults.push({
      locationId: location.LocationId,
      locationName: location.LocationName || 'Unnamed Location',
      isPrimary: location.LocationIsPrimary || false,
      basePremium: parseFloat(location.BasePremium || 0),
      basePremiumNonProfit: parseFloat(location.BasePremiumNonProfit || 0),
      basePremiumForProfit: parseFloat(location.BasePremiumForProfit || 0),
      systemFees: fees.systemFeesAmount,
      paymentProcessingFee: fees.paymentProcessingFee,
      processingFees: fees.processingFees,
      setupFees: fees.setupFeesAmount,
      totalAmount: fees.totalAmount,
      householdCount: location.HouseholdCount || 0,
      memberCount: location.MemberCount || 0
    });
  }

  const primaryLocationIndex = locationResults.findIndex(lr => lr.isPrimary);
  if (primaryLocationIndex >= 0 && locationsChargingToPrimary.length > 0) {
    const primaryLocation = locationResults[primaryLocationIndex];
    const primaryLocationId = primaryLocation.locationId;

    locationsChargingToPrimary.forEach(charge => {
      if (charge.location.LocationId === primaryLocationId) {
        return;
      }
      primaryLocation.basePremium += parseFloat(charge.location.BasePremium || 0);
      primaryLocation.basePremiumNonProfit = (primaryLocation.basePremiumNonProfit || 0) + parseFloat(charge.location.BasePremiumNonProfit || 0);
      primaryLocation.basePremiumForProfit = (primaryLocation.basePremiumForProfit || 0) + parseFloat(charge.location.BasePremiumForProfit || 0);
      primaryLocation.totalAmount += charge.fees.totalAmount;
      primaryLocation.setupFees += (charge.fees.setupFeesAmount || 0);
      primaryLocation.paymentProcessingFee = (primaryLocation.paymentProcessingFee || 0) + (charge.fees.paymentProcessingFee || 0);
      primaryLocation.systemFees = (primaryLocation.systemFees || 0) + (charge.fees.systemFeesAmount || 0);
      primaryLocation.householdCount += (charge.location.HouseholdCount || 0);
      primaryLocation.memberCount += (charge.location.MemberCount || 0);
    });

    primaryLocation.processingFees = Math.round(((primaryLocation.systemFees || 0) + (primaryLocation.paymentProcessingFee || 0)) * 100) / 100;
    primaryLocation.totalAmount = Math.round((primaryLocation.basePremium + primaryLocation.systemFees + primaryLocation.paymentProcessingFee + primaryLocation.setupFees) * 100) / 100;

    if (!primaryLocation.systemFees || primaryLocation.systemFees === 0) {
      console.warn(`⚠️ WARNING: No SystemFee enrollments found in oe.Enrollments for primary location ${primaryLocation.locationName || 'Unknown'}`);
      primaryLocation.processingFees = Math.round((0 + (primaryLocation.paymentProcessingFee || 0)) * 100) / 100;
    }
  }

  const totalAmount = locationResults.reduce((sum, loc) => sum + loc.totalAmount, 0);
  const premiumNonProfitTotal = Math.round(
    locationResults.reduce((sum, loc) => sum + (loc.basePremiumNonProfit || 0), 0) * 100
  ) / 100;
  const premiumForProfitTotal = Math.round(
    locationResults.reduce((sum, loc) => sum + (loc.basePremiumForProfit || 0), 0) * 100
  ) / 100;
  const totalFees = Math.round(
    locationResults.reduce(
      (sum, loc) =>
        sum +
        (loc.systemFees || 0) +
        (loc.paymentProcessingFee || 0) +
        (loc.setupFees || 0),
      0
    ) * 100
  ) / 100;

  return {
    locationResults,
    totalAmount: Math.round(totalAmount * 100) / 100,
    premiumNonProfitTotal,
    premiumForProfitTotal,
    totalFees
  };
}

// =============================================
// GET /api/groups/:groupId/billing
// Get comprehensive billing data for a group
// Query params: invoiceLocationId, paymentLocationId, paymentStatus, invoicePage, invoiceLimit, paymentPage, paymentLimit
// =============================================
router.get('/:groupId/billing', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { 
      invoiceLocationId, 
      paymentLocationId, 
      paymentStatus,
      invoicePage = 1, 
      invoiceLimit = 50,
      paymentPage = 1,
      paymentLimit = 10
    } = req.query;
    
    const pool = await getPool();

    // Get billing details
    const billingResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT 
          gb.*,
          g.Name as GroupName,
          g.TenantId
        FROM oe.GroupBilling gb
        JOIN oe.Groups g ON gb.GroupId = g.GroupId
        WHERE gb.GroupId = @groupId
      `);

    // Build invoices query with location filter and pagination
    let invoicesQuery = `
      SELECT 
        i.InvoiceId,
        i.GroupId,
        i.LocationId,
        i.InvoiceNumber,
        i.InvoiceDate,
        i.DueDate,
        i.BillingPeriodStart,
        i.BillingPeriodEnd,
        i.TotalAmount,
        i.PaidAmount,
        gl.Name as LocationName,
        gl.UseLocationACH,
        gl.IsPrimary as LocationIsPrimary,
        CASE 
          WHEN i.Status = 'Paid' THEN 'Paid'
          WHEN i.Status = 'Cancelled' THEN 'Cancelled'
          WHEN ${GB_INV_OVERDUE_TZ} AND i.PaidAmount < i.TotalAmount THEN 'Overdue'
          WHEN i.PaidAmount > 0 AND i.PaidAmount < i.TotalAmount THEN 'Partial'
          ELSE 'Unpaid'
        END as Status,
        i.PaymentReceivedDate as PaymentDate,
        i.PdfUrl
      FROM oe.Invoices i
      LEFT JOIN oe.Tenants t ON t.TenantId = i.TenantId
      LEFT JOIN oe.GroupLocations gl ON i.LocationId = gl.LocationId
      WHERE i.GroupId = @groupId
    `;
    
    // Add location filter for invoices
    if (invoiceLocationId && invoiceLocationId !== 'all') {
      invoicesQuery += ` AND i.LocationId = @invoiceLocationId`;
    }
    
    invoicesQuery += ` ORDER BY i.InvoiceDate DESC, gl.IsPrimary DESC, gl.Name`;
    
    // Get total count for invoices pagination
    let invoicesCountQuery = `
      SELECT COUNT(*) as Total
      FROM oe.Invoices i
      LEFT JOIN oe.GroupLocations gl ON i.LocationId = gl.LocationId
      WHERE i.GroupId = @groupId
    `;
    if (invoiceLocationId && invoiceLocationId !== 'all') {
      invoicesCountQuery += ` AND i.LocationId = @invoiceLocationId`;
    }
    
    const invoicesCountRequest = pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId);
    if (invoiceLocationId && invoiceLocationId !== 'all') {
      invoicesCountRequest.input('invoiceLocationId', sql.UniqueIdentifier, invoiceLocationId);
    }
    const invoicesCountResult = await invoicesCountRequest.query(invoicesCountQuery);
    const invoicesTotal = invoicesCountResult.recordset[0].Total;
    
    // Add pagination to invoices query
    const invoicePageNum = parseInt(invoicePage);
    const invoiceLimitNum = parseInt(invoiceLimit);
    const invoiceOffset = (invoicePageNum - 1) * invoiceLimitNum;
    invoicesQuery += ` OFFSET @invoiceOffset ROWS FETCH NEXT @invoiceLimit ROWS ONLY`;
    
    const invoicesRequest = pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('invoiceOffset', sql.Int, invoiceOffset)
      .input('invoiceLimit', sql.Int, invoiceLimitNum);
    if (invoiceLocationId && invoiceLocationId !== 'all') {
      invoicesRequest.input('invoiceLocationId', sql.UniqueIdentifier, invoiceLocationId);
    }
    const invoicesResult = await invoicesRequest.query(invoicesQuery);

    // Build payments query with location filter and pagination
    let paymentsQuery = `
      SELECT 
        p.PaymentId,
        p.GroupId,
        p.TenantId,
        p.InvoiceId,
        p.LocationId,
        p.PaymentDate,
        p.Amount,
        p.PaymentMethod,
        p.ProcessorTransactionId as TransactionId,
        p.Status,
        p.TransactionType,
        p.Processor,
        p.FailureReason,
        p.ACHReturnCode,
        p.ACHReturnReason,
        p.ChargebackReason,
        p.OriginalPaymentId,
        p.ProcessorResponse,
        p.CreatedDate,
        p.ModifiedDate,
        p.AttemptNumber,
        p.ConsecutiveFailureCount,
        p.LastFailureDate,
        gl.Name as LocationName,
        gl.IsPrimary as LocationIsPrimary
      FROM oe.Payments p
      LEFT JOIN oe.GroupLocations gl ON p.LocationId = gl.LocationId
      WHERE p.GroupId = @groupId
    `;
    
    // Add location filter for payments
    if (paymentLocationId && paymentLocationId !== 'all') {
      paymentsQuery += ` AND p.LocationId = @paymentLocationId`;
    }
    
    // Add status filter for payments
    if (paymentStatus && paymentStatus !== 'all') {
      paymentsQuery += ` AND p.Status = @paymentStatus`;
    }
    
    paymentsQuery += ` ORDER BY p.PaymentDate DESC`;
    
    // Get total count for payments pagination
    let paymentsCountQuery = `
      SELECT COUNT(*) as Total
      FROM oe.Payments p
      LEFT JOIN oe.GroupLocations gl ON p.LocationId = gl.LocationId
      WHERE p.GroupId = @groupId
    `;
    if (paymentLocationId && paymentLocationId !== 'all') {
      paymentsCountQuery += ` AND p.LocationId = @paymentLocationId`;
    }
    if (paymentStatus && paymentStatus !== 'all') {
      paymentsCountQuery += ` AND p.Status = @paymentStatus`;
    }
    
    const paymentsCountRequest = pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId);
    if (paymentLocationId && paymentLocationId !== 'all') {
      paymentsCountRequest.input('paymentLocationId', sql.UniqueIdentifier, paymentLocationId);
    }
    if (paymentStatus && paymentStatus !== 'all') {
      paymentsCountRequest.input('paymentStatus', sql.NVarChar(50), paymentStatus);
    }
    const paymentsCountResult = await paymentsCountRequest.query(paymentsCountQuery);
    const paymentsTotal = paymentsCountResult.recordset[0].Total;
    
    // Add pagination to payments query
    const paymentPageNum = parseInt(paymentPage);
    const paymentLimitNum = parseInt(paymentLimit);
    const paymentOffset = (paymentPageNum - 1) * paymentLimitNum;
    paymentsQuery += ` OFFSET @paymentOffset ROWS FETCH NEXT @paymentLimit ROWS ONLY`;
    
    const paymentsRequest = pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('paymentOffset', sql.Int, paymentOffset)
      .input('paymentLimit', sql.Int, paymentLimitNum);
    if (paymentLocationId && paymentLocationId !== 'all') {
      paymentsRequest.input('paymentLocationId', sql.UniqueIdentifier, paymentLocationId);
    }
    if (paymentStatus && paymentStatus !== 'all') {
      paymentsRequest.input('paymentStatus', sql.NVarChar(50), paymentStatus);
    }
    const paymentsResult = await paymentsRequest.query(paymentsQuery);

    // Get all payment methods (both group-level and location-specific)
    const paymentMethodResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT 
          gpm.PaymentMethodId,
          gpm.GroupId,
          gpm.LocationId,
          gpm.Type,
          gpm.AccountNumberLast4,
          gpm.AccountHolderName,
          CASE 
            WHEN gpm.Type = 'ACH' THEN gpm.AccountNumberLast4
            ELSE gpm.CardLast4
          END as Last4,
          gpm.BankName,
          gpm.AccountType,
          gpm.CardBrand,
          gpm.ExpiryMonth,
          gpm.ExpiryYear,
          gpm.IsDefault,
          gpm.Status,
          gpm.CreatedDate,
          gpm.BillingAddress,
          gpm.BillingCity,
          gpm.BillingState,
          gpm.BillingZip,
          gpm.ProcessorToken,
          gpm.ProcessorCustomerId,
          gpm.ProcessorPaymentMethodId,
          gpm.RoutingNumber,
          gpm.RoutingNumberEncrypted,
          gl.Name as LocationName,
          gl.IsPrimary as LocationIsPrimary
        FROM oe.GroupPaymentMethods gpm
        LEFT JOIN oe.GroupLocations gl ON gpm.LocationId = gl.LocationId
        WHERE gpm.GroupId = @groupId 
          AND gpm.Status = 'Active'
        ORDER BY gl.IsPrimary DESC, gpm.IsDefault DESC, gpm.CreatedDate DESC
      `);

    // Get tenantId from billing result
    const tenantId = billingResult.recordset[0]?.TenantId;

    // Get all scheduled payments (active and cancelled) so UI can show both with processor info
    const scheduledPaymentsResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT 
          grp.DimeScheduleId as scheduleId,
          grp.LocationId,
          gl.Name as LocationName,
          grp.NextBillingDate,
          grp.MonthlyAmount,
          grp.IsActive,
          grp.ModifiedDate as CancelledDate
        FROM oe.GroupRecurringPaymentPlans grp
        LEFT JOIN oe.GroupLocations gl ON grp.LocationId = gl.LocationId
        WHERE grp.GroupId = @groupId 
          AND grp.DimeScheduleId IS NOT NULL
        ORDER BY grp.IsActive DESC, gl.IsPrimary DESC, gl.Name
      `);
    const scheduledPayments = (scheduledPaymentsResult.recordset || []).map(r => ({
      scheduleId: String(r.scheduleId),
      locationId: r.LocationId,
      locationName: r.LocationName || 'Primary',
      nextBillingDate: r.NextBillingDate,
      monthlyAmount: parseFloat(r.MonthlyAmount || 0),
      isActive: r.IsActive === 1 || r.IsActive === true,
      cancelledDate: r.IsActive === 0 || r.IsActive === false ? r.CancelledDate : null,
      processor: 'DIME'
    }));

    // Validate DIME payment methods
    const validatedPaymentMethods = [];
    for (const paymentMethod of paymentMethodResult.recordset) {
      if (paymentMethod.ProcessorPaymentMethodId && paymentMethod.ProcessorCustomerId) {
        try {
          const validation = await DimeService.validatePaymentMethod(
            paymentMethod.ProcessorPaymentMethodId, 
            paymentMethod.ProcessorCustomerId,
            tenantId
          );
          
          if (!validation.isValid) {
            console.log(`⚠️ Group payment method ${paymentMethod.PaymentMethodId} is no longer valid in DIME`);
            // Mark as inactive in database
            const updateQuery = `
              UPDATE oe.GroupPaymentMethods 
              SET Status = 'Inactive', ModifiedDate = GETUTCDATE()
              WHERE PaymentMethodId = @paymentMethodId
            `;
            const updateRequest = pool.request();
            updateRequest.input('paymentMethodId', sql.UniqueIdentifier, paymentMethod.PaymentMethodId);
            await updateRequest.query(updateQuery);
            continue; // Skip adding to results
          }
        } catch (validationError) {
          console.error('Error validating group payment method:', validationError);
          // Continue with the payment method if validation fails
        }
      }
      validatedPaymentMethods.push(paymentMethod);
    }

    console.log(`✅ ${validatedPaymentMethods.length} group payment methods validated and returned`);

    // Format the response
    const billingDetails = billingResult.recordset[0] || null;
    const response = {
      success: true,
      data: {
        billingDetails: billingDetails ? {
          BillingType: billingDetails.BillingType,
          BillingFrequency: billingDetails.BillingFrequency,
          NextBillingDate: billingDetails.NextBillingDate,
          CurrentBalance: parseFloat(billingDetails.CurrentBalance || 0),
          TotalPaidYTD: parseFloat(billingDetails.TotalPaidYTD || 0),
          AutoPay: billingDetails.AutoPay,
          PaymentTerms: billingDetails.PaymentTerms
        } : null,
        invoices: invoicesResult.recordset.map(inv => ({
          ...inv,
          TotalAmount: parseFloat(inv.TotalAmount),
          PaidAmount: parseFloat(inv.PaidAmount)
        })),
        payments: paymentsResult.recordset.map(pay => ({
          ...pay,
          Amount: parseFloat(pay.Amount)
        })),
        paymentMethods: validatedPaymentMethods.map(method => {
          const { RoutingNumber, RoutingNumberEncrypted, ...safe } = method;
          let routingLast4 = null;
          if (method.Type === 'ACH') {
            if (RoutingNumber) {
              routingLast4 = String(RoutingNumber).replace(/\D/g, '').slice(-4);
            } else if (RoutingNumberEncrypted) {
              try {
                const decrypted = encryptionService.decrypt(RoutingNumberEncrypted);
                routingLast4 = String(decrypted).replace(/\D/g, '').slice(-4);
              } catch (e) {
                // ignore decryption errors
              }
            }
          }
          return {
            ...safe,
            ExpiryMonth: method.ExpiryMonth ? parseInt(method.ExpiryMonth) : null,
            ExpiryYear: method.ExpiryYear ? parseInt(method.ExpiryYear) : null,
            accountLast4: method.Type === 'ACH' ? (method.AccountNumberLast4 || method.Last4) : null,
            routingLast4: method.Type === 'ACH' ? routingLast4 : null
          };
        }),
        paymentMethod: validatedPaymentMethods[0] || null, // Keep for backward compatibility
        pagination: {
          invoices: {
            page: invoicePageNum,
            limit: invoiceLimitNum,
            total: invoicesTotal,
            totalPages: Math.ceil(invoicesTotal / invoiceLimitNum)
          },
          payments: {
            page: paymentPageNum,
            limit: paymentLimitNum,
            total: paymentsTotal,
            totalPages: Math.ceil(paymentsTotal / paymentLimitNum)
          }
        },
        scheduledPayments
      }
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching billing data:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch billing data',
      error: error.message
    });
  }
});

// =============================================
// POST /api/groups/:groupId/payment-method
// Add or update payment method
// =============================================
router.post('/:groupId/payment-method', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { 
      type, 
      locationId, // Add locationId parameter
      bankName, 
      accountType, 
      accountHolderName,
      routingNumber, 
      accountNumber,
      cardNumber,
      expiryMonth,
      expiryYear,
      cvv,
      cardholderName,
      billingAddress,
      billingCity,
      billingState,
      billingZip,
      phoneNumber
    } = req.body;
    const userId = req.user?.UserId || req.user?.userId || req.headers['x-user-id'];
    
    console.log('🔍 POST /api/groups/:groupId/payment-method - Request received:', {
      groupId,
      type,
      userId,
      hasUserId: !!userId,
      userObject: req.user ? { UserId: req.user.UserId, userId: req.user.userId } : 'no user'
    });

    const pool = await getPool();
    
    // Get group information for DIME customer creation
    const groupQuery = `
      SELECT g.Name as GroupName, g.TenantId, g.ContactEmail as PrimaryContactEmail, g.ContactPhone as PrimaryContactPhone, g.PrimaryContact as PrimaryContactName
      FROM oe.Groups g
      WHERE g.GroupId = @groupId
    `;
    const groupResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(groupQuery);

    if (groupResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group not found',
        error: {
          message: 'Group not found',
          code: 'GROUP_NOT_FOUND'
        }
      });
    }

    const group = groupResult.recordset[0];

    // Check payment method limit (2 per location or group-level)
    const countRequest = pool.request();
    countRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    let countQuery;
    if (locationId) {
      countRequest.input('locationId', sql.UniqueIdentifier, locationId);
      countQuery = `
        SELECT COUNT(*) as count
        FROM oe.GroupPaymentMethods
        WHERE GroupId = @groupId 
          AND LocationId = @locationId
          AND Status = 'Active'
      `;
    } else {
      countQuery = `
        SELECT COUNT(*) as count
        FROM oe.GroupPaymentMethods
        WHERE GroupId = @groupId 
          AND LocationId IS NULL
          AND Status = 'Active'
      `;
    }
    
    const countResult = await countRequest.query(countQuery);
    
    if (countResult.recordset[0].count >= 2) {
      const locationMsg = locationId ? 'for this location' : 'for group-level payments';
      return res.status(400).json({
        success: false,
        message: `Maximum of 2 payment methods allowed ${locationMsg}`,
        error: {
          message: 'Payment method limit reached',
          code: 'PAYMENT_METHOD_LIMIT_REACHED'
        }
      });
    }

    // Ensure DIME customer exists using unified service
    const customerData = {
      firstName: group.PrimaryContactName?.split(' ')[0] || 'Group',
      lastName: group.PrimaryContactName?.split(' ').slice(1).join(' ') || 'Admin',
      email: group.PrimaryContactEmail || 'group@example.com',
      phone: phoneNumber || group.PrimaryContactPhone || '+17707892072',
      billingAddress: billingAddress || '',
      billingCity: billingCity || '',
      billingState: billingState || '',
      billingZip: billingZip || '',
      billingCountry: 'US'
    };

    const customerResult = await PaymentMethodService.ensureDimeCustomer(customerData, 'group', groupId, group.TenantId);
    if (!customerResult.success) {
      // Handle specific error types
      if (customerResult.error?.code === 'PHONE_NUMBER_CONFLICT') {
        return res.status(400).json({
          success: false,
          message: customerResult.error.message,
          error: {
            message: 'Phone number already exists',
            code: 'PHONE_NUMBER_CONFLICT'
          }
        });
      }
      
      if (customerResult.error?.code === 'EMAIL_CONFLICT' || customerResult.error?.code === 'EMAIL_CONFLICT_OTHER_MERCHANT') {
        return res.status(400).json({
          success: false,
          message: customerResult.error.message,
          error: {
            message: customerResult.error.message,
            code: customerResult.error.code
          }
        });
      }
      
      return res.status(500).json({
        success: false,
        message: customerResult.error.message,
        error: {
          message: customerResult.error.message,
          code: customerResult.error.code,
          details: customerResult.error.details
        }
      });
    }

    const dimeCustomerId = customerResult.customerId;

    // Prepare payment method data for unified service
    const paymentMethodData = {
      paymentMethodType: type,
      bankName,
      accountType,
      routingNumber,
      accountNumber,
      accountHolderName: (accountHolderName || '').toString().trim() || group.PrimaryContactName || 'Group Admin',
      cardNumber: (type === 'CreditCard' || type === 'card') && cardNumber ? String(cardNumber).replace(/\D/g, '') : undefined,
      expiryMonth: (type === 'CreditCard' || type === 'card') && expiryMonth ? parseInt(expiryMonth, 10) : undefined,
      expiryYear: (type === 'CreditCard' || type === 'card') && expiryYear ? parseInt(expiryYear, 10) : undefined,
      cvv: (type === 'CreditCard' || type === 'card') ? cvv : undefined,
      cardholderName: (type === 'CreditCard' || type === 'card') ? cardholderName : undefined,
      billingAddress,
      billingAddress2: '',
      billingCity,
      billingState,
      billingZip,
      billingCountry: 'US'
    };
    
    console.log('🔍 Payment method data prepared:', {
      type,
      hasCardNumber: !!paymentMethodData.cardNumber,
      hasAccountNumber: !!paymentMethodData.accountNumber,
      expiryMonth: paymentMethodData.expiryMonth,
      expiryYear: paymentMethodData.expiryYear,
      billingZip: paymentMethodData.billingZip,
      billingZipLength: paymentMethodData.billingZip?.length
    });

    // Validate payment method data
    const validation = PaymentMethodService.validatePaymentMethodData(paymentMethodData, type);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment method data',
        error: {
          message: 'Validation failed',
          code: 'VALIDATION_FAILED',
          details: validation.errors
        }
      });
    }

    // Create payment method with DIME using unified service (includes proper tokenization)
    console.log('🔍 Creating payment method with DIME:', {
      type,
      customerId: dimeCustomerId,
      hasCardNumber: !!cardNumber,
      hasAccountNumber: !!accountNumber
    });
    
    const dimeResult = await PaymentMethodService.createPaymentMethod(paymentMethodData, dimeCustomerId, group.TenantId);

    if (!dimeResult.success) {
      console.error('❌ DIME payment method creation failed:', {
        error: dimeResult.error,
        message: dimeResult.error?.message,
        code: dimeResult.error?.code,
        details: dimeResult.error?.details
      });
      
      return res.status(500).json({
        success: false,
        message: 'Failed to create payment method',
        error: {
          message: dimeResult.error?.message || 'Unknown error creating payment method',
          code: dimeResult.error?.code || 'PAYMENT_METHOD_CREATION_ERROR',
          details: process.env.NODE_ENV === 'development' ? dimeResult.error : undefined
        }
      });
    }
    
    console.log('✅ DIME payment method created successfully:', {
      paymentMethodId: dimeResult.paymentMethodId,
      token: dimeResult.token ? 'present' : 'missing',
      last4: dimeResult.last4
    });

    // Insert payment method using unified service
    console.log('🔍 Inserting payment method into database:', {
      groupId,
      locationId: locationId || null,
      userId,
      hasUserId: !!userId
    });
    
    const insertResult = await PaymentMethodService.insertPaymentMethod(
      paymentMethodData, 
      'group', 
      groupId, 
      dimeResult, 
      userId,
      null, // tenantId
      null, // transaction
      locationId || null  // locationId (can be group-level or location-specific)
    );
    
    if (!insertResult.success) {
      console.error('❌ Database insert failed:', {
        error: insertResult.error,
        message: insertResult.error?.message,
        code: insertResult.error?.code
      });
      
      return res.status(500).json({
        success: false,
        message: 'Failed to save payment method to database',
        error: {
          message: insertResult.error?.message || 'Unknown database error',
          code: insertResult.error?.code || 'DATABASE_INSERT_FAILED',
          details: process.env.NODE_ENV === 'development' ? insertResult.error : undefined
        }
      });
    }
    
    console.log('✅ Payment method inserted into database:', {
      paymentMethodId: insertResult.paymentMethodId
    });

    // Update payment method defaults using unified service
    await PaymentMethodService.updatePaymentMethodDefaults('group', groupId, insertResult.paymentMethodId, userId, null, null, locationId || null);

    console.log('✅ Group payment method saved to database with DIME tokens');

    // Update setup status since payment method was added
    try {
      const { updateSetupStatus } = require('../services/setupStatus.service');
      await updateSetupStatus(groupId);
      console.log(`✅ Updated setup status for group ${groupId} after adding payment method`);
    } catch (error) {
      console.warn('⚠️ Failed to update setup status:', error.message);
    }

    res.json({
      success: true,
      message: 'Payment method added successfully',
      data: {
        type,
        isDefault: true,
        processorToken: dimeResult.token,
        processorCustomerId: dimeResult.customerId,
        processorPaymentMethodId: dimeResult.paymentMethodId
      }
    });

  } catch (error) {
    console.error('❌ Error adding group payment method:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code,
      originalError: error.originalError?.message,
      sqlError: error.originalError?.info?.message,
      fullError: error
    });
    
    res.status(500).json({
      success: false,
      message: 'Failed to add payment method',
      error: {
        message: error.message || 'Unknown error occurred',
        code: error.code || 'ADD_PAYMENT_METHOD_ERROR',
        details: process.env.NODE_ENV === 'development' ? {
          stack: error.stack,
          name: error.name,
          originalError: error.originalError?.message,
          sqlError: error.originalError?.info?.message
        } : undefined
      }
    });
  }
});

// =============================================
// PUT /api/groups/:groupId/payment-method
// Update existing payment method
// =============================================
router.put('/:groupId/payment-method', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { 
      type,
      billingAddress,
      billingCity,
      billingState,
      billingZip,
      accountHolderName,
      bankName,
      accountType,
      routingNumber,
      accountNumber,
      cardNumber,
      expiryMonth,
      expiryYear,
      cvv,
      cardholderName
    } = req.body;
    const userId = req.user?.userId || req.headers['x-user-id'];

    // Safety: do not allow local-only updates for payment credentials.
    // Credential/name changes must go through /payment-method/:paymentMethodId,
    // which updates DIME first and only then persists DB changes.
    const hasPaymentMethodFieldUpdate =
      type !== undefined ||
      bankName !== undefined ||
      accountType !== undefined ||
      routingNumber !== undefined ||
      accountNumber !== undefined ||
      cardNumber !== undefined ||
      expiryMonth !== undefined ||
      expiryYear !== undefined ||
      cvv !== undefined ||
      cardholderName !== undefined ||
      accountHolderName !== undefined;
    if (hasPaymentMethodFieldUpdate) {
      return res.status(400).json({
        success: false,
        message: 'Payment method credentials must be updated via the specific payment method endpoint so DIME and DB stay in sync.'
      });
    }

    const pool = await getPool();
    
    // Update billing address for existing payment method
    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('billingAddress', sql.NVarChar(255), billingAddress)
      .input('billingCity', sql.NVarChar(100), billingCity)
      .input('billingState', sql.NVarChar(50), billingState)
      .input('billingZip', sql.NVarChar(20), billingZip)
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        UPDATE oe.GroupPaymentMethods
        SET 
          BillingAddress = @billingAddress,
          BillingCity = @billingCity,
          BillingState = @billingState,
          BillingZip = @billingZip,
          ModifiedDate = GETUTCDATE(),
          ModifiedBy = @userId
        WHERE GroupId = @groupId AND IsDefault = 1 AND Status = 'Active'
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'No active payment method found to update'
      });
    }

    res.json({
      success: true,
      message: 'Payment method updated successfully'
    });
  } catch (error) {
    console.error('Error updating payment method:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update payment method',
      error: error.message
    });
  }
});

// =============================================
// DELETE /api/groups/:groupId/invoices/:invoiceId
// Delete an invoice (TenantAdmin, SysAdmin only). Removes the invoice record only; does not affect payments.
// =============================================
router.delete('/:groupId/invoices/:invoiceId', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, invoiceId } = req.params;
    const pool = await getPool();

    const checkResult = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT InvoiceId FROM oe.Invoices
        WHERE InvoiceId = @invoiceId AND GroupId = @groupId
      `);

    if (!checkResult.recordset || checkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        DELETE FROM oe.Invoices
        WHERE InvoiceId = @invoiceId AND GroupId = @groupId
      `);

    return res.json({
      success: true,
      data: { message: 'Invoice deleted' }
    });
  } catch (error) {
    console.error('Error deleting invoice:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete invoice',
      error: { message: error.message }
    });
  }
});

// =============================================
// PATCH /api/groups/:groupId/invoices/:invoiceId/status
// Manual correction: mark invoice paid, unpaid, or set partial paid amount (TenantAdmin, SysAdmin).
// Body: { mode: 'paid_full' | 'unpaid' | 'partial', paidAmount?: number } — paidAmount required for partial
// =============================================
router.patch('/:groupId/invoices/:invoiceId/status', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, invoiceId } = req.params;
    const { mode, paidAmount: paidAmountBody } = req.body || {};
    const pool = await getPool();

    const invResult = await pool
      .request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT InvoiceId, TotalAmount, PaidAmount, Status
        FROM oe.Invoices
        WHERE InvoiceId = @invoiceId AND GroupId = @groupId
      `);

    if (!invResult.recordset?.length) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const inv = invResult.recordset[0];
    if (String(inv.Status) === 'Cancelled') {
      return res.status(400).json({ success: false, message: 'Cannot change a cancelled invoice' });
    }

    const total = parseFloat(inv.TotalAmount) || 0;

    if (mode === 'paid_full') {
      await pool
        .request()
        .input('invoiceId', sql.UniqueIdentifier, invoiceId)
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('total', sql.Decimal(12, 2), total)
        .query(`
          UPDATE oe.Invoices
          SET Status = N'Paid',
              PaidAmount = @total,
              PaymentReceivedDate = GETUTCDATE(),
              ModifiedDate = GETUTCDATE()
          WHERE InvoiceId = @invoiceId AND GroupId = @groupId
        `);
      return res.json({
        success: true,
        message: 'Invoice marked as paid',
        data: { mode: 'paid_full', paidAmount: total }
      });
    }

    if (mode === 'unpaid') {
      await pool
        .request()
        .input('invoiceId', sql.UniqueIdentifier, invoiceId)
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
          UPDATE oe.Invoices
          SET Status = N'Unpaid',
              PaidAmount = 0,
              PaymentReceivedDate = NULL,
              ModifiedDate = GETUTCDATE()
          WHERE InvoiceId = @invoiceId AND GroupId = @groupId
        `);
      return res.json({
        success: true,
        message: 'Invoice marked as unpaid',
        data: { mode: 'unpaid' }
      });
    }

    if (mode === 'partial') {
      const pa = paidAmountBody != null ? Number(paidAmountBody) : NaN;
      if (!Number.isFinite(pa) || pa <= 0) {
        return res.status(400).json({ success: false, message: 'partial requires paidAmount > 0' });
      }
      if (pa >= total) {
        return res.status(400).json({
          success: false,
          message: 'For full balance use “Mark paid” instead of partial'
        });
      }
      await pool
        .request()
        .input('invoiceId', sql.UniqueIdentifier, invoiceId)
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('paid', sql.Decimal(12, 2), pa)
        .query(`
          UPDATE oe.Invoices
          SET Status = N'Unpaid',
              PaidAmount = @paid,
              PaymentReceivedDate = NULL,
              ModifiedDate = GETUTCDATE()
          WHERE InvoiceId = @invoiceId AND GroupId = @groupId
        `);
      return res.json({
        success: true,
        message: 'Invoice partial payment amount updated',
        data: { mode: 'partial', paidAmount: pa }
      });
    }

    return res.status(400).json({
      success: false,
      message: 'Invalid mode. Use paid_full, unpaid, or partial'
    });
  } catch (error) {
    console.error('Error updating invoice status:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update invoice',
      error: { message: error.message }
    });
  }
});

// =============================================
// GET /api/groups/:groupId/invoices/:invoiceId/regenerate-preview
// Preview recalculated amounts for an Unpaid invoice (TenantAdmin, SysAdmin only)
// =============================================
router.get('/:groupId/invoices/:invoiceId/regenerate-preview', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, invoiceId } = req.params;
    const pool = await getPool();

    const invoiceResult = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT i.*, g.TenantId
        FROM oe.Invoices i
        JOIN oe.Groups g ON i.GroupId = g.GroupId
        WHERE i.InvoiceId = @invoiceId AND i.GroupId = @groupId
      `);

    if (invoiceResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    const invoice = invoiceResult.recordset[0];
    if (invoice.Status !== 'Unpaid') {
      return res.status(400).json({ success: false, message: 'Only Unpaid invoices can be regenerated' });
    }

    const billingPeriodStart = new Date(invoice.BillingPeriodStart);
    const billingPeriodEnd = new Date(invoice.BillingPeriodEnd);
    const billingDate = new Date(invoice.InvoiceDate);
    const { calculateLocationPremiums } = require('../services/invoiceCalculationService');
    const locationPremiums = await calculateLocationPremiums(
      pool,
      groupId,
      { periodStart: billingPeriodStart, periodEnd: billingPeriodEnd },
      sql
    );

    let primaryPaymentMethodType = 'ACH';
    const primaryLocation = locationPremiums.find(lp => lp.LocationIsPrimary);
    if (primaryLocation) {
      const pmResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('locationId', sql.UniqueIdentifier, primaryLocation.LocationId)
        .query(`SELECT TOP 1 Type FROM oe.GroupPaymentMethods WHERE GroupId = @groupId AND LocationId = @locationId AND IsDefault = 1 AND Status = 'Active'`);
      if (pmResult.recordset.length > 0) primaryPaymentMethodType = pmResult.recordset[0].Type;
    }

    const locationResults = [];
    const locationsChargingToPrimary = [];
    for (const location of locationPremiums) {
      let paymentMethodType = location.UseLocationACH ? 'ACH' : primaryPaymentMethodType;
      if (location.UseLocationACH) {
        const pmResult = await pool.request()
          .input('groupId', sql.UniqueIdentifier, groupId)
          .input('locationId', sql.UniqueIdentifier, location.LocationId)
          .query(`SELECT TOP 1 Type FROM oe.GroupPaymentMethods WHERE GroupId = @groupId AND LocationId = @locationId AND IsDefault = 1 AND Status = 'Active'`);
        if (pmResult.recordset.length > 0) paymentMethodType = pmResult.recordset[0].Type;
      }
      const unpaidSetupFees = location.UnpaidSetupFees || 0;
      const dbPaymentProcessingFee = location.PaymentProcessingFeeAmount || 0;
      const dbSystemFee = location.SystemFeeAmount || 0;
      const subtotalWithSystemFees = location.BasePremium + dbSystemFee;
      const fees = {
        systemFeesAmount: dbSystemFee,
        paymentProcessingFee: dbPaymentProcessingFee,
        setupFeesAmount: unpaidSetupFees,
        totalAmount: Math.round((subtotalWithSystemFees + dbPaymentProcessingFee + unpaidSetupFees) * 100) / 100,
        processingFees: Math.round((dbSystemFee + dbPaymentProcessingFee) * 100) / 100,
        subtotalWithSystemFees
      };
      if (!location.UseLocationACH) {
        locationsChargingToPrimary.push({ location, fees });
        if (location.LocationIsPrimary) locationResults.push({ location, fees, totalAmount: fees.totalAmount });
        continue;
      }
      locationResults.push({ location, fees, totalAmount: fees.totalAmount });
    }

    const primaryIdx = locationResults.findIndex(lr => lr.location.LocationIsPrimary);
    if (primaryIdx >= 0 && locationsChargingToPrimary.length > 0) {
      const primaryResult = locationResults[primaryIdx];
      const primaryLocationId = primaryResult.location.LocationId;
      locationsChargingToPrimary.forEach(charge => {
        if (charge.location.LocationId === primaryLocationId) return;
        primaryResult.location.BasePremium += parseFloat(charge.location.BasePremium || 0);
        primaryResult.totalAmount += charge.fees.totalAmount;
        primaryResult.fees.setupFeesAmount += (charge.fees.setupFeesAmount || 0);
        primaryResult.fees.paymentProcessingFee = (primaryResult.fees.paymentProcessingFee || 0) + (charge.fees.paymentProcessingFee || 0);
        primaryResult.fees.systemFeesAmount = (primaryResult.fees.systemFeesAmount || 0) + (charge.fees.systemFeesAmount || 0);
        primaryResult.location.HouseholdCount += (charge.location.HouseholdCount || 0);
        primaryResult.location.MemberCount += (charge.location.MemberCount || 0);
      });
      primaryResult.fees.processingFees = Math.round(((primaryResult.fees.systemFeesAmount || 0) + (primaryResult.fees.paymentProcessingFee || 0)) * 100) / 100;
      primaryResult.totalAmount = Math.round((primaryResult.location.BasePremium + primaryResult.fees.systemFeesAmount + primaryResult.fees.paymentProcessingFee + primaryResult.fees.setupFeesAmount) * 100) / 100;
    }

    const matchResult = locationResults.find(lr => lr.location.LocationId === invoice.LocationId);
    if (!matchResult) {
      return res.status(400).json({ success: false, message: 'Invoice location no longer has enrollments' });
    }

    const newSubTotal = matchResult.location.BasePremium;
    const newTotalAmount = matchResult.totalAmount;
    const currentAmount = parseFloat(invoice.TotalAmount || 0);
    const currentSubTotal = parseFloat(invoice.SubTotal || 0);

    const billingDateFormatted = billingDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    return res.json({
      success: true,
      data: {
        invoiceNumber: invoice.InvoiceNumber,
        locationName: matchResult.location.LocationName || 'Primary Location',
        billingDate: billingDateFormatted,
        billingDateStr: `${billingDate.getFullYear()}-${String(billingDate.getMonth() + 1).padStart(2, '0')}-${String(billingDate.getDate()).padStart(2, '0')}`,
        currentAmount,
        currentSubTotal,
        newAmount: newTotalAmount,
        newSubTotal,
        breakdown: {
          basePremium: matchResult.location.BasePremium,
          systemFees: matchResult.fees.systemFeesAmount,
          paymentProcessingFee: matchResult.fees.paymentProcessingFee,
          setupFees: matchResult.fees.setupFeesAmount
        }
      }
    });
  } catch (error) {
    console.error('Error getting regenerate preview:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// =============================================
// POST /api/groups/:groupId/invoices/:invoiceId/regenerate
// Delete existing Unpaid invoice and trigger oe_payment_manager manual-run for this group.
// Manual run creates new invoice(s) and DIME recurring payment(s), canceling any existing DIME schedules.
// (TenantAdmin, SysAdmin only)
// =============================================
router.post('/:groupId/invoices/:invoiceId/regenerate', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  const {
    loadGroupInvoiceRegenerateSnapshot,
    deleteGroupInvoiceForRegenerate,
    restoreGroupInvoiceSnapshot,
    callPaymentManagerManualRun,
    paymentManagerRunFailed
  } = require('../utils/groupInvoiceRegenerate');

  try {
    const { groupId, invoiceId } = req.params;
    if (!groupId) {
      return res.status(400).json({ success: false, message: 'groupId is required for regenerate' });
    }
    const pool = await getPool();

    const snapshot = await loadGroupInvoiceRegenerateSnapshot(pool, invoiceId, groupId);
    if (!snapshot) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    const invoice = snapshot.invoice;
    if (invoice.Status !== 'Unpaid') {
      return res.status(400).json({ success: false, message: 'Only Unpaid invoices can be regenerated' });
    }

    const invoiceDate = new Date(invoice.InvoiceDate);
    const billingDateStr = `${invoiceDate.getFullYear()}-${String(invoiceDate.getMonth() + 1).padStart(2, '0')}-${String(invoiceDate.getDate()).padStart(2, '0')}`;

    // Payment manager skips if invoice exists for billing period — delete first, restore on failure.
    await deleteGroupInvoiceForRegenerate(pool, invoiceId);

    const pmResult = await callPaymentManagerManualRun(groupId, billingDateStr);
    if (!pmResult.ok) {
      const restoreResult = await restoreGroupInvoiceSnapshot(pool, snapshot);
      const restored = restoreResult.restored;
      return res.status(502).json({
        success: false,
        message: restored
          ? `${pmResult.message} Original invoice #${invoice.InvoiceNumber} was restored.`
          : pmResult.message,
        invoiceDeleted: !restored,
        invoiceRestored: restored
      });
    }

    const manualRunResponse = pmResult.response;
    if (paymentManagerRunFailed(manualRunResponse)) {
      const errMsg = manualRunResponse.data?.error || manualRunResponse.data?.message || 'Manual run failed';
      const restoreResult = await restoreGroupInvoiceSnapshot(pool, snapshot);
      const restored = restoreResult.restored;
      return res.status(502).json({
        success: false,
        message: restored
          ? `Payment manager failed: ${errMsg}. Original invoice #${invoice.InvoiceNumber} was restored.`
          : `Payment manager failed: ${errMsg}`,
        invoiceDeleted: !restored,
        invoiceRestored: restored
      });
    }

    return res.json({
      success: true,
      data: {
        message: 'Invoice regenerated successfully. New invoice(s) and DIME schedule(s) created.',
        invoiceNumber: invoice.InvoiceNumber,
        manualRunResult: manualRunResponse.data
      }
    });
  } catch (error) {
    const isAxiosError = error.response !== undefined;
    const status = isAxiosError ? (error.response?.status || 502) : 500;
    const message = isAxiosError
      ? (error.response?.data?.error || error.response?.data?.message || error.message)
      : error.message;
    console.error('Error regenerating invoice:', error);
    return res.status(status).json({
      success: false,
      message: `Regenerate failed: ${message}`,
      invoiceDeleted: false
    });
  }
});

// =============================================
// POST /api/groups/:groupId/invoices/:invoiceId/charge
// Manual charge for an Unpaid invoice. Same options as individual setup recurring.
// Body: { amount, groupPaymentMethodId?, cancelExisting? }
// (TenantAdmin, SysAdmin only)
// =============================================
router.post('/:groupId/invoices/:invoiceId/charge', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, invoiceId } = req.params;
    const { amount, groupPaymentMethodId, cancelExisting = true } = req.body || {};
    const pool = await getPool();

    const invoiceResult = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`SELECT * FROM oe.Invoices WHERE InvoiceId = @invoiceId AND GroupId = @groupId`);

    if (invoiceResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    const invoice = invoiceResult.recordset[0];
    if (invoice.Status !== 'Unpaid' && invoice.Status !== 'Overdue' && invoice.Status !== 'Partial') {
      if (invoice.Status === 'Paid') {
        const unsettledResult = await pool.request()
          .input('invoiceId', sql.UniqueIdentifier, invoiceId)
          .query(`
            SELECT TOP 1 1 AS HasUnsettled
            FROM oe.Payments
            WHERE InvoiceId = @invoiceId
              AND TransactionType = 'Payment'
              AND Status IN ('Pending', 'Failed')
          `);
        if (!unsettledResult.recordset?.length) {
          return res.status(400).json({ success: false, message: 'Only Unpaid invoices can be charged' });
        }
      } else {
        return res.status(400).json({ success: false, message: 'Only Unpaid invoices can be charged' });
      }
    }

    const chargeAmount = Number(amount) || parseFloat(invoice.TotalAmount) - parseFloat(invoice.PaidAmount || 0);
    if (chargeAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invoice has no amount due' });
    }

    const groupRow = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`SELECT ProcessorCustomerId, TenantId FROM oe.Groups WHERE GroupId = @groupId`);
    if (!groupRow.recordset?.length || !groupRow.recordset[0].ProcessorCustomerId) {
      return res.status(400).json({ success: false, message: 'Group has no DIME customer; cannot charge' });
    }
    const customerId = groupRow.recordset[0].ProcessorCustomerId;
    const tenantId = groupRow.recordset[0].TenantId;

    let pmQuery = `
      SELECT PaymentMethodId, ProcessorPaymentMethodId, ProcessorToken, Type, CardholderName, AccountHolderName,
        BillingAddress, BillingCity, BillingState, BillingZip,
        RoutingNumber, RoutingNumberEncrypted, AccountNumberEncrypted, BankName, AccountType
      FROM oe.GroupPaymentMethods
      WHERE GroupId = @groupId AND Status = 'Active'
    `;
    const pmRequest = pool.request().input('groupId', sql.UniqueIdentifier, groupId);
    if (groupPaymentMethodId) {
      pmQuery += ` AND PaymentMethodId = @selectedPmId`;
      pmRequest.input('selectedPmId', sql.UniqueIdentifier, groupPaymentMethodId);
    }
    if (invoice.LocationId) {
      pmQuery += ` AND (LocationId = @locationId OR LocationId IS NULL)`;
      pmRequest.input('locationId', sql.UniqueIdentifier, invoice.LocationId);
    }
    pmQuery += ` ORDER BY ${invoice.LocationId ? 'CASE WHEN LocationId = @locationId THEN 0 ELSE 1 END, ' : ''}IsDefault DESC`;
    const pmResult = await pmRequest.query(pmQuery);
    const pm = pmResult.recordset?.[0];
    if (!pm?.ProcessorPaymentMethodId) {
      return res.status(400).json({ success: false, message: 'No active payment method found for this group/location' });
    }

    const paymentMethodType = (pm.Type || 'CreditCard').toString().toLowerCase().includes('ach') ? 'ACH' : 'Card';

    // Cancel existing DIME schedules first if requested (same as setup recurring: create charge, then cancel old)
    const cancelFailures = [];
    if (cancelExisting) {
      const grpResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('locationId', sql.UniqueIdentifier, invoice.LocationId || null)
        .query(`
          SELECT DimeScheduleId FROM oe.GroupRecurringPaymentPlans
          WHERE GroupId = @groupId AND IsActive = 1
            AND (LocationId = @locationId OR (@locationId IS NULL AND LocationId IS NULL))
        `);
      for (const r of grpResult.recordset || []) {
        const cancelResult = await DimeService.cancelRecurringPayment(String(r.DimeScheduleId), tenantId);
        if (!cancelResult.success && !cancelResult.wasAlreadyCanceled) {
          cancelFailures.push({ scheduleId: r.DimeScheduleId, error: cancelResult.error || 'Unknown' });
        } else {
          await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('scheduleId', sql.NVarChar(255), r.DimeScheduleId)
            .query(`UPDATE oe.GroupRecurringPaymentPlans SET IsActive = 0, ModifiedDate = GETUTCDATE() WHERE GroupId = @groupId AND DimeScheduleId = @scheduleId`);
        }
      }
    }

    const idempotencyKey = `charge_invoice_${invoiceId}_${Date.now()}`;
    const invoiceNumber = invoice.InvoiceNumber || `INV-${invoiceId}`;
    const paymentPayload = {
      customerId,
      paymentMethodId: pm.ProcessorPaymentMethodId,
      paymentMethodToken: pm.ProcessorToken,
      amount: chargeAmount,
      paymentMethodType,
      invoiceNumber: `MANUAL-${invoiceNumber}`,
      idempotencyKey,
      cardholderName: pm.CardholderName,
      billingAddress: pm.BillingAddress,
      billingCity: pm.BillingCity,
      billingState: pm.BillingState,
      billingZip: pm.BillingZip
    };

    // DIME charge-ach requires raw routing/account data; payment_method_id is not supported
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
          console.error('❌ Failed to decrypt ACH account for invoice charge:', decryptErr);
          return res.status(400).json({
            success: false,
            message: 'Failed to decrypt payment method for charge. The payment method may need to be re-added.'
          });
        }
      }
      if (!routingNumber || !accountNumber) {
        return res.status(400).json({
          success: false,
          message: 'ACH payment method is missing stored account data. Please remove and re-add the payment method.'
        });
      }
      const holderName = (pm.AccountHolderName || pm.CardholderName || '').toString().trim() || 'Account Holder';
      const nameParts = holderName.split(' ');
      paymentPayload.routingNumber = routingNumber;
      paymentPayload.accountNumber = accountNumber;
      paymentPayload.accountType = pm.AccountType || 'Checking';
      paymentPayload.accountHolderName = holderName;
      paymentPayload.bankName = pm.BankName || 'Bank';
      paymentPayload.billingFirstName = nameParts[0] || '';
      paymentPayload.billingLastName = (nameParts.slice(1).join(' ') || '').trim();
      paymentPayload.billingAddress = pm.BillingAddress || '';
      paymentPayload.billingCity = pm.BillingCity || '';
      paymentPayload.billingState = pm.BillingState || '';
      paymentPayload.billingZip = pm.BillingZip || '';
    }

    const paymentResult = await DimeService.processPayment(paymentPayload, tenantId);
    if (!paymentResult.success || !paymentResult.transactionId) {
      return res.status(400).json({
        success: false,
        message: paymentResult.error?.message || 'Payment processing failed'
      });
    }
    const paymentRecordStatus = paymentResult.recordStatus ?? 'Pending';

    const groupAgent = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`SELECT AgentId FROM oe.Groups WHERE GroupId = @groupId`);
    const agentId = groupAgent.recordset?.[0]?.AgentId || null;

    // Record one-time payment (not recurring) in oe.Payments — same product JSON rules as payment audit (invoice billing period).
    const paymentDateVal = new Date();
    const periodOpts =
      invoice.BillingPeriodStart && invoice.BillingPeriodEnd
        ? { periodStart: invoice.BillingPeriodStart, periodEnd: invoice.BillingPeriodEnd }
        : {};
    const pricing = await getPricingFields(pool, groupId, null, null, paymentDateVal, {
      ...periodOpts,
      sqlTypes: rawSql
    });
    const snaps =
      invoice.BillingPeriodStart && invoice.BillingPeriodEnd
        ? await buildGroupProductSnapshotsForPeriod(
            pool,
            groupId,
            invoice.BillingPeriodStart,
            invoice.BillingPeriodEnd,
            null
          )
        : null;

    const openRowsResult = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('amount', sql.Decimal(10, 2), chargeAmount)
      .query(`
        SELECT PaymentId, Status, ProcessorTransactionId
        FROM oe.Payments
        WHERE InvoiceId = @invoiceId
          AND TransactionType = 'Payment'
          AND Status IN ('Pending', 'Failed')
          AND LOWER(ISNULL(Processor, '')) LIKE '%dime%'
          AND ABS(Amount - @amount) < 0.01
        ORDER BY ModifiedDate DESC
      `);
    const openRows = openRowsResult.recordset || [];
    const pendingRow = openRows.find((r) => r.Status === 'Pending');
    const failedRow = openRows.find((r) => r.Status === 'Failed');
    let reusePaymentId = null;
    let originalPaymentId = null;

    if (
      pendingRow &&
      (!pendingRow.ProcessorTransactionId ||
        String(pendingRow.ProcessorTransactionId).trim() === String(paymentResult.transactionId).trim())
    ) {
      reusePaymentId = pendingRow.PaymentId;
    } else if (failedRow) {
      originalPaymentId = failedRow.PaymentId;
    } else if (pendingRow) {
      originalPaymentId = pendingRow.PaymentId;
    }

    const failureReasonClear = null;

    if (reusePaymentId) {
      await pool.request()
        .input('paymentId', sql.UniqueIdentifier, reusePaymentId)
        .input('processorTransactionId', sql.NVarChar(255), paymentResult.transactionId)
        .input('paymentStatus', sql.NVarChar(50), paymentRecordStatus)
        .input('paymentDate', sql.DateTime2, paymentDateVal)
        .input('netRate', sql.Decimal(10, 2), pricing.netRate)
        .input('commission', sql.Decimal(10, 2), pricing.commission)
        .input('overrideRate', sql.Decimal(10, 2), pricing.overrideRate)
        .input('systemFees', sql.Decimal(10, 2), pricing.systemFees)
        .input('processingFeeAmount', sql.Decimal(10, 2), pricing.processingFeeAmount)
        .input('productCommissions', sql.NVarChar(sql.MAX), snaps ? snaps.productCommissionsJSON : null)
        .input('productVendorAmounts', sql.NVarChar(sql.MAX), snaps ? snaps.productVendorAmountsJSON : null)
        .input('productOwnerAmounts', sql.NVarChar(sql.MAX), snaps ? snaps.productOwnerAmountsJSON : null)
        .input('failureReason', sql.NVarChar(sql.MAX), failureReasonClear)
        .query(`
          UPDATE oe.Payments
          SET ProcessorTransactionId = @processorTransactionId,
              Status = @paymentStatus,
              PaymentDate = @paymentDate,
              NetRate = @netRate,
              Commission = @commission,
              OverrideRate = @overrideRate,
              SystemFees = @systemFees,
              ProcessingFeeAmount = @processingFeeAmount,
              ProductCommissions = @productCommissions,
              ProductVendorAmounts = @productVendorAmounts,
              ProductOwnerAmounts = @productOwnerAmounts,
              FailureReason = @failureReason,
              ModifiedDate = GETUTCDATE()
          WHERE PaymentId = @paymentId
        `);
    } else {
      const paymentId = crypto.randomUUID();
      await pool.request()
        .input('paymentId', sql.UniqueIdentifier, paymentId)
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('agentId', sql.UniqueIdentifier, agentId)
        .input('locationId', sql.UniqueIdentifier, invoice.LocationId || null)
        .input('invoiceId', sql.UniqueIdentifier, invoiceId)
        .input('amount', sql.Decimal(10, 2), chargeAmount)
        .input('paymentStatus', sql.NVarChar(50), paymentRecordStatus)
        .input('processorTransactionId', sql.NVarChar(255), paymentResult.transactionId)
        .input('paymentDate', sql.DateTime2, paymentDateVal)
        .input('originalPaymentId', sql.UniqueIdentifier, originalPaymentId)
        .input('netRate', sql.Decimal(10, 2), pricing.netRate)
        .input('commission', sql.Decimal(10, 2), pricing.commission)
        .input('overrideRate', sql.Decimal(10, 2), pricing.overrideRate)
        .input('systemFees', sql.Decimal(10, 2), pricing.systemFees)
        .input('processingFeeAmount', sql.Decimal(10, 2), pricing.processingFeeAmount)
        .input('productCommissions', sql.NVarChar(sql.MAX), snaps ? snaps.productCommissionsJSON : null)
        .input('productVendorAmounts', sql.NVarChar(sql.MAX), snaps ? snaps.productVendorAmountsJSON : null)
        .input('productOwnerAmounts', sql.NVarChar(sql.MAX), snaps ? snaps.productOwnerAmountsJSON : null)
        .query(`
          INSERT INTO oe.Payments (
            PaymentId, GroupId, TenantId, AgentId, LocationId, InvoiceId, OriginalPaymentId,
            TransactionType, Amount, Status, Processor, ProcessorTransactionId, PaymentMethod,
            RecurringScheduleId, PaymentDate, NetRate, Commission, OverrideRate, SystemFees, ProcessingFeeAmount,
            ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts,
            CreatedDate, ModifiedDate
          ) VALUES (
            @paymentId, @groupId, @tenantId, @agentId, @locationId, @invoiceId, @originalPaymentId,
            'Payment', @amount, @paymentStatus, 'DIME', @processorTransactionId, 'dime',
            NULL, @paymentDate, @netRate, @commission, @overrideRate, @systemFees, @processingFeeAmount,
            @productCommissions, @productVendorAmounts, @productOwnerAmounts,
            GETUTCDATE(), GETUTCDATE()
          )
        `);
    }

    // Only mark invoice Paid when the processor reports a settled capture.
    const paymentSettled = isSuccessfulPaymentRecordStatus(paymentRecordStatus);
    if (paymentSettled) {
      const newPaidAmount = parseFloat(invoice.PaidAmount || 0) + chargeAmount;
      const isFullyPaid = newPaidAmount >= parseFloat(invoice.TotalAmount);

      await pool.request()
        .input('invoiceId', sql.UniqueIdentifier, invoiceId)
        .input('paidAmount', sql.Decimal(12, 2), newPaidAmount)
        .input('status', sql.NVarChar(50), isFullyPaid ? 'Paid' : invoice.Status)
        .query(`
          UPDATE oe.Invoices
          SET Status = @status, PaidAmount = @paidAmount,
              PaymentReceivedDate = CASE
                WHEN @status = N'Paid' THEN COALESCE(PaymentReceivedDate, GETUTCDATE())
                ELSE NULL
              END,
              ModifiedDate = GETUTCDATE()
          WHERE InvoiceId = @invoiceId
        `);
    } else if (invoice.Status === 'Paid') {
      // Correct invoices that were marked Paid before settlement (sync API said success, DIME still pending).
      try {
        await invoiceService.unfulfillInvoice(invoiceId, chargeAmount);
      } catch (unfulfillErr) {
        console.warn(`Manual charge: could not unfulfill prematurely paid invoice ${invoiceId}:`, unfulfillErr.message);
      }
    }

    const responseData = {
      amount: chargeAmount,
      transactionId: paymentResult.transactionId,
      paymentStatus: paymentRecordStatus,
      invoiceUpdated: paymentSettled
    };
    if (cancelFailures.length > 0) {
      responseData.warning = `${cancelFailures.length} existing schedule(s) could not be cancelled in DIME. They may still be active.`;
      responseData.cancelFailures = cancelFailures;
    }

    const successMessage = paymentSettled
      ? 'Invoice charged successfully'
      : PENDING_BANK_APPROVAL_MESSAGE;

    return res.json({
      success: true,
      message: successMessage,
      data: responseData
    });
  } catch (error) {
    console.error('Error charging invoice:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to charge invoice'
    });
  }
});

// =============================================
// GET /api/groups/:groupId/invoices/:invoiceId/download
// Download invoice as PDF
// =============================================
router.get('/:groupId/invoices/:invoiceId/download', async (req, res) => {
  try {
    const { groupId, invoiceId } = req.params;
    const pool = await getPool();

    // Get invoice details
    const invoiceResult = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT 
          i.*,
          g.Name as GroupName,
          g.Address as PrimaryAddress,
          g.City as PrimaryCity,
          g.State as PrimaryState,
          g.Zip as PrimaryZip,
          t.Name as TenantName,
          t.PrimaryAddress as TenantAddress,
          t.PrimaryCity as TenantCity,
          t.PrimaryState as TenantState,
          t.PrimaryZip as TenantZip,
          COALESCE(
            NULLIF(LTRIM(RTRIM(ISNULL(t.CustomLogoUrl, ''))), ''),
            NULLIF(LTRIM(RTRIM(ISNULL(json_value(t.AdvancedSettings, '$.branding.logoUrl'), ''))), '')
          ) AS TenantLogoUrl
        FROM oe.Invoices i
        JOIN oe.Groups g ON i.GroupId = g.GroupId
        JOIN oe.Tenants t ON g.TenantId = t.TenantId
        WHERE i.InvoiceId = @invoiceId AND i.GroupId = @groupId
      `);

    if (invoiceResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    const invoice = invoiceResult.recordset[0];
    const billingDate = new Date(invoice.InvoiceDate);
    const dueDate = new Date(invoice.DueDate);
    const billingPeriodStart = new Date(invoice.BillingPeriodStart);
    const billingPeriodEnd = new Date(invoice.BillingPeriodEnd);

    // Rebuild line items using the invoice's billing window (not InvoiceDate alone).
    // InvoiceDate is often UTC midnight; passing it as a JS Date uses local month in
    // calculateLocationPremiums unless explicit period is passed — that mislabels
    // May invoices as April on US servers and makes Subtotal diverge from TotalAmount.
    const { calculateLocationPremiums } = require('../services/invoiceCalculationService');
    const locationPremiums = await calculateLocationPremiums(
      pool,
      groupId,
      { periodStart: billingPeriodStart, periodEnd: billingPeriodEnd },
      sql
    );
    
    // Fetch tenant settings
    const tenantSettingsResult = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, invoice.TenantId)
      .query(`SELECT SystemFees, PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId`);
    
    let systemFeesSettings = null;
    let paymentProcessorSettings = null;
    
    if (tenantSettingsResult.recordset.length > 0) {
      try {
        systemFeesSettings = tenantSettingsResult.recordset[0].SystemFees ? JSON.parse(tenantSettingsResult.recordset[0].SystemFees) : null;
        paymentProcessorSettings = tenantSettingsResult.recordset[0].PaymentProcessorSettings ? JSON.parse(tenantSettingsResult.recordset[0].PaymentProcessorSettings) : null;
      } catch (e) {
        console.warn(`Failed to parse settings: ${e.message}`);
      }
    }
    
    // Get primary location's payment method type
    let primaryPaymentMethodType = 'ACH';
    const primaryLocation = locationPremiums.find(lp => lp.LocationIsPrimary);
    if (primaryLocation) {
      const primaryPaymentMethodResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('locationId', sql.UniqueIdentifier, primaryLocation.LocationId)
      .query(`
          SELECT TOP 1 Type
          FROM oe.GroupPaymentMethods
          WHERE GroupId = @groupId 
            AND LocationId = @locationId
            AND IsDefault = 1 
            AND Status = 'Active'
        `);
      
      if (primaryPaymentMethodResult.recordset.length > 0) {
        primaryPaymentMethodType = primaryPaymentMethodResult.recordset[0].Type;
      }
    }
    
    // Calculate fees for each location
    const locationResults = [];
    const locationsChargingToPrimary = [];
    
    for (const location of locationPremiums) {
      // Get payment method for this location
      let paymentMethodType = 'ACH';
      
      if (location.UseLocationACH) {
        const paymentMethodResult = await pool.request()
          .input('groupId', sql.UniqueIdentifier, groupId)
          .input('locationId', sql.UniqueIdentifier, location.LocationId)
          .query(`
            SELECT TOP 1 Type
            FROM oe.GroupPaymentMethods
            WHERE GroupId = @groupId 
              AND LocationId = @locationId
              AND IsDefault = 1 
              AND Status = 'Active'
          `);
        
        if (paymentMethodResult.recordset.length > 0) {
          paymentMethodType = paymentMethodResult.recordset[0].Type;
        }
      } else {
        paymentMethodType = primaryPaymentMethodType;
      }
      
      // Use PaymentProcessingFee and SystemFee from database enrollments ONLY (oe.Enrollments)
      // Never calculate from settings - all fees must be in oe.Enrollments
      const unpaidSetupFees = location.UnpaidSetupFees || 0;
      const dbPaymentProcessingFee = location.PaymentProcessingFeeAmount || 0;
      const dbSystemFee = location.SystemFeeAmount || 0;
      
      if (dbPaymentProcessingFee === 0 && dbSystemFee === 0) {
        console.warn(`⚠️ WARNING: No fee enrollments found in oe.Enrollments for location ${location.LocationName} (SystemFee=$${dbSystemFee.toFixed(2)}, PaymentProcessingFee=$${dbPaymentProcessingFee.toFixed(2)})`);
      }
      
      const subtotalWithSystemFees = location.BasePremium + dbSystemFee;
      const fees = {
        systemFeesAmount: dbSystemFee,
        paymentProcessingFee: dbPaymentProcessingFee,
        setupFeesAmount: unpaidSetupFees,
        totalAmount: Math.round((subtotalWithSystemFees + dbPaymentProcessingFee + unpaidSetupFees) * 100) / 100,
        processingFees: Math.round((dbSystemFee + dbPaymentProcessingFee) * 100) / 100,
        subtotalWithSystemFees: subtotalWithSystemFees
      };
      
      if (!location.UseLocationACH) {
        locationsChargingToPrimary.push({ location, fees });
        if (location.LocationIsPrimary) {
          locationResults.push({
            location,
            fees,
            totalAmount: fees.totalAmount
          });
        }
        continue;
      }
      
      locationResults.push({
        location,
        fees,
        totalAmount: fees.totalAmount
      });
    }
    
    // Consolidate charges to primary location if needed
    const primaryLocationIndex = locationResults.findIndex(lr => lr.location.LocationIsPrimary);
    if (primaryLocationIndex >= 0 && locationsChargingToPrimary.length > 0) {
      const primaryLocationResult = locationResults[primaryLocationIndex];
      const primaryLocationId = primaryLocationResult.location.LocationId;
      
      locationsChargingToPrimary.forEach(charge => {
        if (charge.location.LocationId === primaryLocationId) {
          return;
        }
        primaryLocationResult.location.BasePremium += parseFloat(charge.location.BasePremium || 0);
        primaryLocationResult.totalAmount += charge.fees.totalAmount;
        primaryLocationResult.fees.setupFeesAmount += (charge.fees.setupFeesAmount || 0);
        primaryLocationResult.fees.paymentProcessingFee = (primaryLocationResult.fees.paymentProcessingFee || 0) + (charge.fees.paymentProcessingFee || 0);
        primaryLocationResult.fees.systemFeesAmount = (primaryLocationResult.fees.systemFeesAmount || 0) + (charge.fees.systemFeesAmount || 0);
        primaryLocationResult.location.HouseholdCount += (charge.location.HouseholdCount || 0);
        primaryLocationResult.location.MemberCount += (charge.location.MemberCount || 0);
      });
      
      primaryLocationResult.fees.processingFees = Math.round(((primaryLocationResult.fees.systemFeesAmount || 0) + (primaryLocationResult.fees.paymentProcessingFee || 0)) * 100) / 100;
      primaryLocationResult.totalAmount = Math.round((primaryLocationResult.location.BasePremium + primaryLocationResult.fees.systemFeesAmount + primaryLocationResult.fees.paymentProcessingFee + primaryLocationResult.fees.setupFeesAmount) * 100) / 100;
    }
    
    // Filter to only the location that matches this invoice's LocationId
    const invoiceLocationResults = locationResults.filter(lr => lr.location.LocationId === invoice.LocationId);

    const tenantLogoBuffer = await prepareTenantLogoBufferForPdf(invoice.TenantLogoUrl);

    // Generate PDF using shared service
    const doc = generateInvoicePdf({
      invoice,
      locationResults: invoiceLocationResults.length > 0 ? invoiceLocationResults : locationResults,
      group: {
        Name: invoice.GroupName,
        Address: invoice.PrimaryAddress,
        City: invoice.PrimaryCity,
        State: invoice.PrimaryState,
        Zip: invoice.PrimaryZip
      },
      tenant: {
        Name: invoice.TenantName,
        PrimaryAddress: invoice.TenantAddress,
        PrimaryCity: invoice.TenantCity,
        PrimaryState: invoice.TenantState,
        PrimaryZip: invoice.TenantZip
      },
      billingDate,
      dueDate,
      billingPeriodStart,
      billingPeriodEnd,
      title: 'INVOICE',
      invoiceNumber: invoice.InvoiceNumber,
      isSample: false,
      tenantLogoBuffer
    });

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice-${invoice.InvoiceNumber}.pdf`);
    
    // Pipe the PDF to the response
    doc.pipe(res);
    doc.end();

  } catch (error) {
    console.error('Error generating invoice PDF:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate invoice PDF',
      error: error.message
    });
  }
});

// =============================================
// POST /api/groups/:groupId/invoices/generate
// Generate invoices for a group (manual trigger)
// =============================================
router.post('/:groupId/invoices/generate', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { billingDate } = req.body;
    const userId = req.user?.userId || req.headers['x-user-id'];

    const pool = await getPool();
    
    // Get next invoice number
    const invoiceNumberResult = await pool.request()
      .output('InvoiceNumber', sql.NVarChar(50))
      .execute('oe.sp_GetNextInvoiceNumber');
    
    const invoiceNumber = invoiceNumberResult.output.InvoiceNumber;
    
    // Execute stored procedure to generate invoices
    await pool.request()
      .input('GroupId', sql.UniqueIdentifier, groupId)
      .input('BillingDate', sql.Date, billingDate || new Date())
      .execute('oe.sp_GenerateGroupInvoices');

    res.json({
      success: true,
      message: 'Invoice generation initiated',
      invoiceNumber: invoiceNumber
    });
  } catch (error) {
    console.error('Error generating invoices:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate invoices',
      error: error.message
    });
  }
});

// =============================================
// GET /api/groups/:groupId/billing/summary
// Get billing summary for dashboard
// =============================================
router.get('/:groupId/billing/summary', async (req, res) => {
  try {
    const { groupId } = req.params;
    const pool = await getPool();

    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT 
          GroupId,
          GroupName,
          BillingType,
          BillingFrequency,
          CurrentBalance,
          TotalPaidYTD,
          NextBillingDate,
          AutoPay,
          PaymentTerms,
          OverdueInvoices,
          TotalOutstanding,
          LastPaymentDate,
          HasPaymentMethod
        FROM oe.vw_GroupBillingDashboard
        WHERE GroupId = @groupId
      `);

    if (result.recordset.length === 0) {
      // Initialize billing if not exists
      await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('userId', sql.UniqueIdentifier, req.user?.userId || req.headers['x-user-id'])
        .query(`
          INSERT INTO oe.GroupBilling (
            GroupId, BillingType, BillingFrequency, 
            NextBillingDate, BillingStartDate, CreatedBy
          ) VALUES (
            @groupId, 'SingleBill', 'Monthly',
            DATEADD(month, 1, GETUTCDATE()), GETUTCDATE(), @userId
          )
        `);

      return res.json({
        success: true,
        data: {
          GroupId: groupId,
          BillingType: 'SingleBill',
          BillingFrequency: 'Monthly',
          CurrentBalance: 0,
          TotalPaidYTD: 0,
          NextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          AutoPay: false,
          PaymentTerms: 30,
          OverdueInvoices: 0,
          TotalOutstanding: 0,
          HasPaymentMethod: false
        }
      });
    }

    res.json({
      success: true,
      data: result.recordset[0]
    });
  } catch (error) {
    console.error('Error fetching billing summary:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch billing summary',
      error: error.message
    });
  }
});

// =============================================
// GET /api/groups/:groupId/billing/monthly-summary
// Get last month's bill and next month's scheduled bill
// =============================================
router.get('/:groupId/billing/monthly-summary', async (req, res) => {
  try {
    const { groupId } = req.params;
    const pool = await getPool();

    // Get last month's invoice (most recent paid invoice)
    const lastInvoiceResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT TOP 1
          InvoiceId,
          TotalAmount as Amount,
          PaymentReceivedDate as PaymentDate,
          BillingPeriodStart,
          BillingPeriodEnd,
          InvoiceDate
        FROM oe.Invoices
        WHERE GroupId = @groupId 
          AND Status = 'Paid'
        ORDER BY PaymentReceivedDate DESC
      `);

    // Get next month's scheduled payment from GroupRecurringPaymentPlans
    const nextPaymentResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT 
          grp.MonthlyAmount as ScheduledAmount,
          grp.NextBillingDate,
          grp.ModifiedDate as LastUpdated
        FROM oe.GroupRecurringPaymentPlans grp
        WHERE grp.GroupId = @groupId 
          AND grp.IsActive = 1
      `);

    const lastMonthBill = lastInvoiceResult.recordset.length > 0 
      ? {
          amount: parseFloat(lastInvoiceResult.recordset[0].Amount || 0),
          paymentDate: lastInvoiceResult.recordset[0].PaymentDate,
          billingPeriodStart: lastInvoiceResult.recordset[0].BillingPeriodStart,
          billingPeriodEnd: lastInvoiceResult.recordset[0].BillingPeriodEnd
        }
      : null;

    const nextMonthBill = nextPaymentResult.recordset.length > 0
      ? {
          scheduledAmount: parseFloat(nextPaymentResult.recordset[0].ScheduledAmount || 0),
          billingDate: nextPaymentResult.recordset[0].NextBillingDate,
          lastUpdated: nextPaymentResult.recordset[0].LastUpdated
        }
      : null;

    res.json({
      success: true,
      data: {
        lastMonthBill,
        nextMonthBill
      }
    });

  } catch (error) {
    console.error('Error fetching monthly billing summary:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch monthly billing summary',
      error: error.message
    });
  }
});

// =============================================
// Helper: get first month (current or future) that has enrollments and no existing invoice
// Returns { billingDate, locationPremiums } or null.
// =============================================
async function getPendingInvoiceMonth(pool, groupId, sql) {
  const { calculateLocationPremiums } = require('../services/invoiceCalculationService');
  const today = new Date();
  const maxMonthsAhead = 12;

  // Distinct (year, month) for which the group already has an invoice
  const invoicesResult = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`
      SELECT DISTINCT YEAR(i.BillingPeriodStart) AS Y, MONTH(i.BillingPeriodStart) AS M
      FROM oe.Invoices i
      WHERE i.GroupId = @groupId
    `);
  const existingMonths = new Set(
    (invoicesResult.recordset || []).map(r => `${r.Y}-${r.M}`)
  );

  for (let offset = 0; offset <= maxMonthsAhead; offset++) {
    const tryDate = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    const key = `${tryDate.getFullYear()}-${tryDate.getMonth() + 1}`;
    if (existingMonths.has(key)) continue;
    const premiums = await calculateLocationPremiums(pool, groupId, tryDate, sql);
    const totalBase = premiums.reduce((sum, lp) => sum + parseFloat(lp.BasePremium || 0), 0);
    if (premiums.length > 0 && totalBase > 0) {
      return { billingDate: tryDate, locationPremiums: premiums };
    }
  }
  return null;
}

// =============================================
// GET /api/groups/:groupId/billing/estimated
// Get estimated invoice amount for the first month that has enrollments and no existing invoice (current or future).
// =============================================
router.get('/:groupId/billing/estimated', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const pool = await getPool();
    
    // Verify group access based on role
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    
    const groupResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT GroupId, TenantId, Name as GroupName
        FROM oe.Groups
        WHERE GroupId = @groupId
      `);
    
    if (groupResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }
    
    const { calculateLocationPremiums } = require('../services/invoiceCalculationService');
    const today = new Date();
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    
    // First month (current or future) that has enrollments and no existing invoice
    let billingDate = null;
    let locationPremiums = [];
    const pending = await getPendingInvoiceMonth(pool, groupId, sql);
    if (pending) {
      billingDate = pending.billingDate;
      locationPremiums = pending.locationPremiums;
    }
    if (!billingDate) {
      billingDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      locationPremiums = await calculateLocationPremiums(pool, groupId, billingDate, sql);
    }
    
    const billingPeriodStart = new Date(billingDate.getFullYear(), billingDate.getMonth(), 1);
    const billingPeriodEnd = new Date(billingDate.getFullYear(), billingDate.getMonth() + 1, 0);
    const estimatedMonth = `${monthNames[billingDate.getMonth()]} ${billingDate.getFullYear()}`;
    
    if (locationPremiums.length === 0) {
      return res.json({
        success: true,
        data: {
          estimatedMonth,
          billingPeriodStart: billingPeriodStart.toISOString().split('T')[0],
          billingPeriodEnd: billingPeriodEnd.toISOString().split('T')[0],
          totalAmount: 0,
          premiumNonProfitTotal: 0,
          premiumForProfitTotal: 0,
          totalFees: 0,
          locations: []
        }
      });
    }
    
    const built = await buildLocationInvoiceResultsFromPremiums(pool, groupId, locationPremiums);
    const { calculateGroupBillingFeeBreakdown } = require('../services/invoiceCalculationService');
    const feeBreakdown = await calculateGroupBillingFeeBreakdown(
      pool, groupId, billingPeriodStart, billingPeriodEnd, sql
    );

    res.json({
      success: true,
      data: {
        estimatedMonth,
        billingPeriodStart: billingPeriodStart.toISOString().split('T')[0],
        billingPeriodEnd: billingPeriodEnd.toISOString().split('T')[0],
        totalAmount: built.totalAmount,
        premiumNonProfitTotal: built.premiumNonProfitTotal,
        premiumForProfitTotal: built.premiumForProfitTotal,
        totalFees: built.totalFees,
        locations: built.locationResults,
        ...feeBreakdown
      }
    });
    
  } catch (error) {
    console.error('Error calculating estimated invoice:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate estimated invoice',
      error: error.message
    });
  }
});

// =============================================
// GET /api/groups/:groupId/billing/premium-breakdown
// Same premium NP/FP + fees breakdown as estimated, for an arbitrary calendar month (query: year, month).
// =============================================
router.get('/:groupId/billing/premium-breakdown', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const year = parseInt(String(req.query.year || ''), 10) || new Date().getFullYear();
    const month = parseInt(String(req.query.month || ''), 10) || (new Date().getMonth() + 1);
    if (month < 1 || month > 12) {
      return res.status(400).json({ success: false, message: 'Invalid month (use 1–12)' });
    }

    const pool = await getPool();
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }

    const groupResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`SELECT GroupId FROM oe.Groups WHERE GroupId = @groupId`);
    if (groupResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    const { calculateLocationPremiums } = require('../services/invoiceCalculationService');
    const billingDate = new Date(year, month - 1, 1);
    // Pass explicit calendar year/month so premium math matches the selected month (no Date/UTC drift).
    const locationPremiums = await calculateLocationPremiums(pool, groupId, { year, month }, sql);

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const billingPeriodStart = new Date(billingDate.getFullYear(), billingDate.getMonth(), 1);
    const billingPeriodEnd = new Date(billingDate.getFullYear(), billingDate.getMonth() + 1, 0);
    const estimatedMonth = `${monthNames[billingDate.getMonth()]} ${billingDate.getFullYear()}`;

    if (locationPremiums.length === 0) {
      const activeMembersResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(
          `SELECT COUNT(*) AS cnt FROM oe.Members WHERE GroupId = @groupId AND Status != 'Terminated'`
        );
      const noActiveMembers = (activeMembersResult.recordset[0]?.cnt || 0) === 0;
      return res.json({
        success: true,
        data: {
          estimatedMonth,
          billingPeriodStart: billingPeriodStart.toISOString().split('T')[0],
          billingPeriodEnd: billingPeriodEnd.toISOString().split('T')[0],
          totalAmount: 0,
          premiumNonProfitTotal: 0,
          premiumForProfitTotal: 0,
          totalFees: 0,
          locations: [],
          noActiveMembers
        }
      });
    }

    const built = await buildLocationInvoiceResultsFromPremiums(pool, groupId, locationPremiums);
    const { calculateGroupBillingFeeBreakdown } = require('../services/invoiceCalculationService');
    const feeBreakdown = await calculateGroupBillingFeeBreakdown(
      pool, groupId, billingPeriodStart, billingPeriodEnd, sql
    );

    res.json({
      success: true,
      data: {
        estimatedMonth,
        billingPeriodStart: billingPeriodStart.toISOString().split('T')[0],
        billingPeriodEnd: billingPeriodEnd.toISOString().split('T')[0],
        totalAmount: built.totalAmount,
        premiumNonProfitTotal: built.premiumNonProfitTotal,
        premiumForProfitTotal: built.premiumForProfitTotal,
        totalFees: built.totalFees,
        locations: built.locationResults,
        noActiveMembers: false,
        ...feeBreakdown
      }
    });
  } catch (error) {
    console.error('Error calculating premium breakdown:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate premium breakdown',
      error: error.message
    });
  }
});

// =============================================
// GET /api/groups/:groupId/billing/sample-invoice
// Generate and download a pending invoice PDF for the first month that has enrollments and no existing invoice
// =============================================
router.get('/:groupId/billing/sample-invoice', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const pool = await getPool();
    const fs = require('fs');
    const path = require('path');
    
    // Verify group access based on role
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    
    // First month (current or future) that has enrollments and no existing invoice (same as estimated)
    const pending = await getPendingInvoiceMonth(pool, groupId, sql);
    if (!pending) {
      return res.status(400).json({
        success: false,
        message: 'No pending invoice: every month in the next 12 either has an existing invoice or no enrollments.'
      });
    }
    const billingDate = pending.billingDate;
    const billingPeriodStart = new Date(billingDate.getFullYear(), billingDate.getMonth(), 1);
    const billingPeriodEnd = new Date(billingDate.getFullYear(), billingDate.getMonth() + 1, 0);
    const dueDate = new Date(billingDate.getFullYear(), billingDate.getMonth(), 5);
    
    // Get group info
    const groupResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT g.GroupId, g.TenantId, g.Name as GroupName, g.Address, g.City, g.State, g.Zip,
               t.Name as TenantName, t.PrimaryAddress as TenantAddress, t.PrimaryCity as TenantCity,
               t.PrimaryState as TenantState, t.PrimaryZip as TenantZip,
               COALESCE(
                 NULLIF(LTRIM(RTRIM(ISNULL(t.CustomLogoUrl, ''))), ''),
                 NULLIF(LTRIM(RTRIM(ISNULL(json_value(t.AdvancedSettings, '$.branding.logoUrl'), ''))), '')
               ) AS TenantLogoUrl
        FROM oe.Groups g
        JOIN oe.Tenants t ON g.TenantId = t.TenantId
        WHERE g.GroupId = @groupId
      `);
    
    if (groupResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }
    
    const group = groupResult.recordset[0];
    
    // Use premiums from pending month (already computed by getPendingInvoiceMonth)
    const locationPremiums = pending.locationPremiums;
    
    // If no enrollments found, generate an empty invoice (no line items)
    // This allows users to preview the invoice format even when there are no active enrollments
    
    // Fetch tenant settings
    const tenantSettingsResult = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, group.TenantId)
      .query(`SELECT SystemFees, PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId`);
    
    let systemFeesSettings = null;
    let paymentProcessorSettings = null;
    
    if (tenantSettingsResult.recordset.length > 0) {
      try {
        systemFeesSettings = tenantSettingsResult.recordset[0].SystemFees ? JSON.parse(tenantSettingsResult.recordset[0].SystemFees) : null;
        paymentProcessorSettings = tenantSettingsResult.recordset[0].PaymentProcessorSettings ? JSON.parse(tenantSettingsResult.recordset[0].PaymentProcessorSettings) : null;
      } catch (e) {
        console.warn(`Failed to parse settings: ${e.message}`);
      }
    }
    
    // Get primary location's payment method type (same logic as estimated invoice endpoint)
    let primaryPaymentMethodType = 'ACH';
    const primaryLocation = locationPremiums.find(lp => lp.LocationIsPrimary);
    if (primaryLocation) {
      const primaryPaymentMethodResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('locationId', sql.UniqueIdentifier, primaryLocation.LocationId)
        .query(`
          SELECT TOP 1 Type
          FROM oe.GroupPaymentMethods
          WHERE GroupId = @groupId 
            AND LocationId = @locationId
            AND IsDefault = 1 
            AND Status = 'Active'
        `);
      
      if (primaryPaymentMethodResult.recordset.length > 0) {
        primaryPaymentMethodType = primaryPaymentMethodResult.recordset[0].Type;
      }
    }
    
    // Calculate fees for each location (same logic as estimated invoice)
    const locationResults = [];
    const locationsChargingToPrimary = [];
    
    for (const location of locationPremiums) {
      // Get payment method for this location to determine processing fee type (same logic as estimated invoice)
      let paymentMethodType = 'ACH'; // Default
      
      if (location.UseLocationACH) {
        // Location pays separately - get its payment method
        const paymentMethodResult = await pool.request()
          .input('groupId', sql.UniqueIdentifier, groupId)
          .input('locationId', sql.UniqueIdentifier, location.LocationId)
          .query(`
            SELECT TOP 1 Type
            FROM oe.GroupPaymentMethods
            WHERE GroupId = @groupId 
              AND LocationId = @locationId
              AND IsDefault = 1 
              AND Status = 'Active'
          `);
        
        if (paymentMethodResult.recordset.length > 0) {
          paymentMethodType = paymentMethodResult.recordset[0].Type;
        }
      } else {
        // Location charges to primary - use primary location's payment method
        paymentMethodType = primaryPaymentMethodType;
      }
      
      // Use PaymentProcessingFee and SystemFee from database enrollments ONLY (oe.Enrollments)
      // Never calculate from settings - all fees must be in oe.Enrollments
      const unpaidSetupFees = location.UnpaidSetupFees || 0;
      const dbPaymentProcessingFee = location.PaymentProcessingFeeAmount || 0;
      const dbSystemFee = location.SystemFeeAmount || 0;
      
      if (dbPaymentProcessingFee === 0 && dbSystemFee === 0) {
        console.warn(`⚠️ WARNING: No fee enrollments found in oe.Enrollments for location ${location.LocationName} (SystemFee=$${dbSystemFee.toFixed(2)}, PaymentProcessingFee=$${dbPaymentProcessingFee.toFixed(2)})`);
      }
      
      const subtotalWithSystemFees = location.BasePremium + dbSystemFee;
      const fees = {
        systemFeesAmount: dbSystemFee,
        paymentProcessingFee: dbPaymentProcessingFee,
        setupFeesAmount: unpaidSetupFees,
        totalAmount: Math.round((subtotalWithSystemFees + dbPaymentProcessingFee + unpaidSetupFees) * 100) / 100,
        processingFees: Math.round((dbSystemFee + dbPaymentProcessingFee) * 100) / 100,
        subtotalWithSystemFees: subtotalWithSystemFees
      };
      
      if (!location.UseLocationACH) {
        locationsChargingToPrimary.push({ location, fees });
        if (location.LocationIsPrimary) {
          locationResults.push({
            location,
            fees,
            totalAmount: fees.totalAmount
          });
        }
        continue;
      }
      
      locationResults.push({
        location,
        fees,
        totalAmount: fees.totalAmount
      });
    }
    
    // Consolidate charges to primary location if needed
    const primaryLocationIndex = locationResults.findIndex(lr => lr.location.LocationIsPrimary);
    if (primaryLocationIndex >= 0 && locationsChargingToPrimary.length > 0) {
      const primaryLocationResult = locationResults[primaryLocationIndex];
      const primaryLocationId = primaryLocationResult.location.LocationId;
      
      locationsChargingToPrimary.forEach(charge => {
        if (charge.location.LocationId === primaryLocationId) {
          return;
        }
        primaryLocationResult.location.BasePremium += parseFloat(charge.location.BasePremium || 0);
        primaryLocationResult.location.BasePremiumNonProfit = (primaryLocationResult.location.BasePremiumNonProfit || 0) + parseFloat(charge.location.BasePremiumNonProfit || 0);
        primaryLocationResult.location.BasePremiumForProfit = (primaryLocationResult.location.BasePremiumForProfit || 0) + parseFloat(charge.location.BasePremiumForProfit || 0);
        primaryLocationResult.totalAmount += charge.fees.totalAmount;
        primaryLocationResult.fees.setupFeesAmount += (charge.fees.setupFeesAmount || 0);
        primaryLocationResult.fees.paymentProcessingFee = (primaryLocationResult.fees.paymentProcessingFee || 0) + (charge.fees.paymentProcessingFee || 0);
        primaryLocationResult.fees.systemFeesAmount = (primaryLocationResult.fees.systemFeesAmount || 0) + (charge.fees.systemFeesAmount || 0);
        primaryLocationResult.location.HouseholdCount += (charge.location.HouseholdCount || 0);
        primaryLocationResult.location.MemberCount += (charge.location.MemberCount || 0);
      });
      
      primaryLocationResult.fees.processingFees = Math.round(((primaryLocationResult.fees.systemFeesAmount || 0) + (primaryLocationResult.fees.paymentProcessingFee || 0)) * 100) / 100;
      primaryLocationResult.totalAmount = Math.round((primaryLocationResult.location.BasePremium + primaryLocationResult.fees.systemFeesAmount + primaryLocationResult.fees.paymentProcessingFee + primaryLocationResult.fees.setupFeesAmount) * 100) / 100;
    }
    
    // Calculate total amount (will be 0 if locationResults is empty)
    const totalAmount = locationResults.reduce((sum, loc) => sum + loc.totalAmount, 0);
    const subtotal = locationResults.reduce((sum, loc) => sum + loc.location.BasePremium, 0);
    
    // Generate PDF using shared service
    // If locationResults is empty, the PDF will show no line items and $0.00 total
    const invoiceNumber = `PENDING-${billingDate.getFullYear()}-${String(billingDate.getMonth() + 1).padStart(2, '0')}`;
    const tenantLogoBuffer = await prepareTenantLogoBufferForPdf(group.TenantLogoUrl);
    const doc = generateInvoicePdf({
      invoice: {
        InvoiceType: 'Group',
        TotalAmount: totalAmount,
        SubTotal: subtotal,
        TaxAmount: 0,
        PaymentTerms: 30
      },
      locationResults, // Empty array if no enrollments - PDF will show no line items
      group: {
        Name: group.GroupName,
        Address: group.Address,
        City: group.City,
        State: group.State,
        Zip: group.Zip
      },
      tenant: {
        Name: group.TenantName,
        PrimaryAddress: group.TenantAddress,
        PrimaryCity: group.TenantCity,
        PrimaryState: group.TenantState,
        PrimaryZip: group.TenantZip
      },
      billingDate,
      dueDate,
      billingPeriodStart,
      billingPeriodEnd,
      title: 'PENDING INVOICE',
      invoiceNumber,
      isSample: true,
      tenantLogoBuffer
    });

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=pending-invoice-${group.GroupName.replace(/\s+/g, '-')}-${billingDate.getFullYear()}-${String(billingDate.getMonth() + 1).padStart(2, '0')}.pdf`);
    
    // Pipe the PDF to the response
    doc.pipe(res);
    doc.end();
    
  } catch (error) {
    console.error('Error generating pending invoice:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate pending invoice',
      error: error.message
    });
  }
});

// =============================================
// POST /api/groups/:groupId/billing/send-sample-invoice-email
// Send a pending invoice email for the next payment date
// =============================================
router.post('/:groupId/billing/send-sample-invoice-email', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { recipientEmail } = req.body; // Optional: if not provided, uses location contact email
    const pool = await getPool();
    
    // Verify group access based on role
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    
    // Calculate billing date as 1st of next month (same as estimated invoice)
    const today = new Date();
    const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const billingDate = nextMonth;
    
    // Get group info
    const groupResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT g.GroupId, g.TenantId, g.Name as GroupName, g.Address, g.City, g.State, g.Zip,
               t.Name as TenantName
        FROM oe.Groups g
        JOIN oe.Tenants t ON g.TenantId = t.TenantId
        WHERE g.GroupId = @groupId
      `);
    
    if (groupResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }
    
    const group = groupResult.recordset[0];
    
    // Use the same calculation logic as estimated invoice
    const { calculateLocationPremiums } = require('../services/invoiceCalculationService');
    const locationPremiums = await calculateLocationPremiums(pool, groupId, billingDate, sql);
    
    if (locationPremiums.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No active enrollments found for this group'
      });
    }
    
    // Fetch tenant settings
    const tenantSettingsResult = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, group.TenantId)
      .query(`SELECT SystemFees, PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId`);
    
    let systemFeesSettings = null;
    let paymentProcessorSettings = null;
    
    if (tenantSettingsResult.recordset.length > 0) {
      try {
        systemFeesSettings = tenantSettingsResult.recordset[0].SystemFees ? JSON.parse(tenantSettingsResult.recordset[0].SystemFees) : null;
        paymentProcessorSettings = tenantSettingsResult.recordset[0].PaymentProcessorSettings ? JSON.parse(tenantSettingsResult.recordset[0].PaymentProcessorSettings) : null;
      } catch (e) {
        console.warn(`Failed to parse settings: ${e.message}`);
      }
    }
    
    // Get primary location's payment method type
    let primaryPaymentMethodType = 'ACH';
    const primaryLocation = locationPremiums.find(lp => lp.LocationIsPrimary);
    if (primaryLocation) {
      const primaryPaymentMethodResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('locationId', sql.UniqueIdentifier, primaryLocation.LocationId)
        .query(`
          SELECT TOP 1 Type
          FROM oe.GroupPaymentMethods
          WHERE GroupId = @groupId 
            AND LocationId = @locationId
            AND IsDefault = 1 
            AND Status = 'Active'
        `);
      
      if (primaryPaymentMethodResult.recordset.length > 0) {
        primaryPaymentMethodType = primaryPaymentMethodResult.recordset[0].Type;
      }
    }
    
    // Calculate fees for each location
    const locationResults = [];
    const locationsChargingToPrimary = [];
    
    for (const location of locationPremiums) {
      // Get payment method for this location
      let paymentMethodType = 'ACH';
      
      if (location.UseLocationACH) {
        const paymentMethodResult = await pool.request()
          .input('groupId', sql.UniqueIdentifier, groupId)
          .input('locationId', sql.UniqueIdentifier, location.LocationId)
          .query(`
            SELECT TOP 1 Type
            FROM oe.GroupPaymentMethods
            WHERE GroupId = @groupId 
              AND LocationId = @locationId
              AND IsDefault = 1 
              AND Status = 'Active'
          `);
        
        if (paymentMethodResult.recordset.length > 0) {
          paymentMethodType = paymentMethodResult.recordset[0].Type;
        }
      } else {
        paymentMethodType = primaryPaymentMethodType;
      }
      
      // Use PaymentProcessingFee and SystemFee from database enrollments ONLY (oe.Enrollments)
      // Never calculate from settings - all fees must be in oe.Enrollments
      const unpaidSetupFees = location.UnpaidSetupFees || 0;
      const dbPaymentProcessingFee = location.PaymentProcessingFeeAmount || 0;
      const dbSystemFee = location.SystemFeeAmount || 0;
      
      if (dbPaymentProcessingFee === 0 && dbSystemFee === 0) {
        console.warn(`⚠️ WARNING: No fee enrollments found in oe.Enrollments for location ${location.LocationName} (SystemFee=$${dbSystemFee.toFixed(2)}, PaymentProcessingFee=$${dbPaymentProcessingFee.toFixed(2)})`);
      }
      
      const subtotalWithSystemFees = location.BasePremium + dbSystemFee;
      const fees = {
        systemFeesAmount: dbSystemFee,
        paymentProcessingFee: dbPaymentProcessingFee,
        setupFeesAmount: unpaidSetupFees,
        totalAmount: Math.round((subtotalWithSystemFees + dbPaymentProcessingFee + unpaidSetupFees) * 100) / 100,
        processingFees: Math.round((dbSystemFee + dbPaymentProcessingFee) * 100) / 100,
        subtotalWithSystemFees: subtotalWithSystemFees
      };
      
      // Get payment method details for email
      let paymentMethod = null;
      if (location.UseLocationACH) {
        const paymentMethodResult = await pool.request()
          .input('groupId', sql.UniqueIdentifier, groupId)
          .input('locationId', sql.UniqueIdentifier, location.LocationId)
          .query(`
            SELECT TOP 1 Type, CardBrand, CardLast4, AccountType, AccountNumberLast4
            FROM oe.GroupPaymentMethods
            WHERE GroupId = @groupId 
              AND LocationId = @locationId
              AND IsDefault = 1 
              AND Status = 'Active'
          `);
        
        if (paymentMethodResult.recordset.length > 0) {
          paymentMethod = paymentMethodResult.recordset[0];
        }
      } else {
        // Use primary location's payment method
        if (primaryLocation) {
          const paymentMethodResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('locationId', sql.UniqueIdentifier, primaryLocation.LocationId)
            .query(`
              SELECT TOP 1 Type, CardBrand, CardLast4, AccountType, AccountNumberLast4
              FROM oe.GroupPaymentMethods
              WHERE GroupId = @groupId 
                AND LocationId = @locationId
                AND IsDefault = 1 
                AND Status = 'Active'
            `);
          
          if (paymentMethodResult.recordset.length > 0) {
            paymentMethod = paymentMethodResult.recordset[0];
          }
        }
      }
      
      if (!location.UseLocationACH) {
        locationsChargingToPrimary.push({ location, fees });
        if (location.LocationIsPrimary) {
          locationResults.push({
            location,
            fees,
            paymentMethod,
            totalAmount: fees.totalAmount
          });
        }
        continue;
      }
      
      locationResults.push({
        location,
        fees,
        paymentMethod,
        totalAmount: fees.totalAmount
      });
    }
    
    // Consolidate charges to primary location if needed
    const primaryLocationIndex = locationResults.findIndex(lr => lr.location.LocationIsPrimary);
    if (primaryLocationIndex >= 0 && locationsChargingToPrimary.length > 0) {
      const primaryLocationResult = locationResults[primaryLocationIndex];
      const primaryLocationId = primaryLocationResult.location.LocationId;
      
      locationsChargingToPrimary.forEach(charge => {
        if (charge.location.LocationId === primaryLocationId) {
          return;
        }
        primaryLocationResult.location.BasePremium += parseFloat(charge.location.BasePremium || 0);
        primaryLocationResult.totalAmount += charge.fees.totalAmount;
        primaryLocationResult.fees.setupFeesAmount += (charge.fees.setupFeesAmount || 0);
        primaryLocationResult.fees.paymentProcessingFee = (primaryLocationResult.fees.paymentProcessingFee || 0) + (charge.fees.paymentProcessingFee || 0);
        primaryLocationResult.fees.systemFeesAmount = (primaryLocationResult.fees.systemFeesAmount || 0) + (charge.fees.systemFeesAmount || 0);
        primaryLocationResult.location.HouseholdCount += (charge.location.HouseholdCount || 0);
        primaryLocationResult.location.MemberCount += (charge.location.MemberCount || 0);
      });
      
      primaryLocationResult.fees.processingFees = Math.round(((primaryLocationResult.fees.systemFeesAmount || 0) + (primaryLocationResult.fees.paymentProcessingFee || 0)) * 100) / 100;
      primaryLocationResult.totalAmount = Math.round((primaryLocationResult.location.BasePremium + primaryLocationResult.fees.systemFeesAmount + primaryLocationResult.fees.paymentProcessingFee + primaryLocationResult.fees.setupFeesAmount) * 100) / 100;
    }
    
    // Send email for each location (or primary location if consolidated)
    const emailResults = [];
    
    for (const locResult of locationResults) {
      const location = locResult.location;
      const fees = locResult.fees;
      const paymentMethod = locResult.paymentMethod;
      
      // Determine recipient email
      const emailToSend = recipientEmail || location.LocationContactEmail;
      if (!emailToSend) {
        emailResults.push({
          locationId: location.LocationId,
          locationName: location.LocationName,
          success: false,
          message: 'No email address available for this location'
        });
        continue;
      }
      
      // Build additional locations info for primary location
      const additionalLocationsInfo = location.LocationIsPrimary && locationsChargingToPrimary.length > 0 
        ? locationsChargingToPrimary
            .filter(c => c.location.LocationId !== location.LocationId)
            .map(c => ({
                name: c.location.LocationName,
                basePremium: c.location.BasePremium,
                totalAmount: c.fees.totalAmount,
                processingFees: c.fees.processingFees,
                memberCount: c.location.MemberCount,
                householdCount: c.location.HouseholdCount,
                fees: c.fees,
                location: c.location
              }))
        : [];
      
      // Generate email HTML using shared service
      // Primary locations always use normal invoice template (even if UseLocationACH is false)
      const isPrimaryLocation = location.LocationIsPrimary || location.IsPrimary;
      const shouldUseNormalTemplate = isPrimaryLocation || location.UseLocationACH;
      
      const emailHtml = generateInvoiceEmailHtml({
        group: {
          GroupName: group.GroupName
        },
        location,
        fees,
        paymentMethod,
        billingDate,
        useLocationACH: shouldUseNormalTemplate, // Pass true for primary locations or locations with UseLocationACH=true
        additionalLocations: additionalLocationsInfo
      });
      
      // Queue email with "SAMPLE" prefix in subject
      // Only add "Premium Covered by Primary Location" suffix for non-primary locations with UseLocationACH=false
      const subjectSuffix = shouldUseNormalTemplate ? '' : ' (Premium Covered by Primary Location)';
      const subject = `[PENDING] Monthly Invoice - ${location.LocationName}${subjectSuffix}`;
      
      try {
        const messageId = await MessageQueueService.queueEmail({
          tenantId: group.TenantId,
          toEmail: emailToSend,
          toName: location.LocationContactName || location.LocationName || 'Team',
          subject: subject,
          htmlContent: emailHtml,
          messageType: 'Email',
          createdBy: req.user?.UserId || null,
          recipientId: null,
          ...MessageQueueService.billingNotificationQueueOptions(),
        });
        
        emailResults.push({
          locationId: location.LocationId,
          locationName: location.LocationName,
          email: emailToSend,
          messageId: messageId,
          success: true
        });
      } catch (emailError) {
        console.error(`Error sending pending invoice email for location ${location.LocationId}:`, emailError);
        emailResults.push({
          locationId: location.LocationId,
          locationName: location.LocationName,
          email: emailToSend,
          success: false,
          message: emailError.message
        });
      }
    }
    
    res.json({
      success: true,
      message: `Pending invoice email(s) sent successfully`,
      data: {
        emailsSent: emailResults.filter(r => r.success).length,
        emailsFailed: emailResults.filter(r => !r.success).length,
        results: emailResults
      }
    });
    
  } catch (error) {
    console.error('Error sending pending invoice email:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send pending invoice email',
      error: error.message
    });
  }
});

// =============================================
// POST /api/groups/:groupId/billing/cancel-scheduled-payment
// Cancel a DIME recurring/scheduled payment for this group (TenantAdmin, SysAdmin only).
// ACID: DB update only after DIME confirms; all DB steps in one transaction (backend-system.md).
// =============================================
router.post('/:groupId/billing/cancel-scheduled-payment', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { scheduleId } = req.body;
    if (!scheduleId) {
      return res.status(400).json({
        success: false,
        message: 'scheduleId is required'
      });
    }
    const pool = await getPool();
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    const groupResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`SELECT GroupId, TenantId FROM oe.Groups WHERE GroupId = @groupId`);
    if (groupResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }
    const group = groupResult.recordset[0];

    // ACID: multi-step DB ops in one transaction (backend-system.md)
    const transaction = pool.transaction();
    await transaction.begin();
    try {
      // Verify schedule belongs to this group (inside transaction for ACID with update)
      const planResult = await transaction.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('scheduleId', sql.NVarChar(255), String(scheduleId))
        .query(`
          SELECT PlanId FROM oe.GroupRecurringPaymentPlans
          WHERE GroupId = @groupId AND DimeScheduleId = @scheduleId AND IsActive = 1
        `);
      if (planResult.recordset.length === 0) {
        await transaction.rollback();
        console.log('⚠️ [cancel-scheduled-payment] Schedule not found or already inactive in DB:', { groupId, scheduleId });
        return res.status(404).json({
          success: false,
          message: 'Scheduled payment not found for this group'
        });
      }
      // Only update DB after DIME confirms cancellation (never mark cancelled without processor confirmation)
      console.log('📤 [cancel-scheduled-payment] Calling DIME to cancel recurring schedule:', { scheduleId, tenantId: group.TenantId });
      const cancelResult = await DimeService.cancelRecurringPayment(String(scheduleId), group.TenantId);
      console.log('📥 [cancel-scheduled-payment] DIME cancel result:', { success: cancelResult.success, error: cancelResult.error, wasAlreadyCanceled: cancelResult.wasAlreadyCanceled });
      if (!cancelResult.success) {
        await transaction.rollback();
        return res.status(502).json({
          success: false,
          message: cancelResult.error || 'Failed to cancel schedule in DIME'
        });
      }
      await transaction.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('scheduleId', sql.NVarChar(255), String(scheduleId))
        .query(`
          UPDATE oe.GroupRecurringPaymentPlans
          SET IsActive = 0, ModifiedDate = GETUTCDATE()
          WHERE GroupId = @groupId AND DimeScheduleId = @scheduleId
        `);
      await transaction.commit();
    } catch (txError) {
      await transaction.rollback();
      throw txError;
    }
    res.json({
      success: true,
      message: 'Scheduled payment canceled successfully'
    });
  } catch (error) {
    console.error('Error canceling scheduled payment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel scheduled payment',
      error: error.message
    });
  }
});

// =============================================
// PUT /api/groups/:groupId/billing/scheduled-payment/:scheduleId/status
// Manually set schedule status in DB only (no DIME). SysAdmin only.
// =============================================
router.put('/:groupId/billing/scheduled-payment/:scheduleId/status', authorize(['SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, scheduleId } = req.params;
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive (boolean) is required'
      });
    }
    const pool = await getPool();
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('scheduleId', sql.NVarChar(255), String(scheduleId))
      .input('isActive', sql.Bit, isActive ? 1 : 0)
      .query(`
        UPDATE oe.GroupRecurringPaymentPlans
        SET IsActive = @isActive, ModifiedDate = GETUTCDATE()
        WHERE GroupId = @groupId AND DimeScheduleId = @scheduleId
      `);
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Scheduled payment not found for this group'
      });
    }
    res.json({
      success: true,
      message: isActive ? 'Marked as active in our records' : 'Marked as cancelled in our records',
      data: { isActive }
    });
  } catch (error) {
    console.error('Error updating scheduled payment status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update status',
      error: error.message
    });
  }
});

// =============================================
// PUT /api/groups/:groupId/billing/scheduled-payment/:scheduleId/amount
// Manually set scheduled payment amount in DB (our records only; DIME syncs on 1st of month). SysAdmin only.
// =============================================
router.put('/:groupId/billing/scheduled-payment/:scheduleId/amount', authorize(['SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, scheduleId } = req.params;
    const { monthlyAmount } = req.body;
    const amount = parseFloat(monthlyAmount);
    if (typeof amount !== 'number' || Number.isNaN(amount) || amount < 0) {
      return res.status(400).json({
        success: false,
        message: 'monthlyAmount (non-negative number) is required'
      });
    }
    const pool = await getPool();
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('scheduleId', sql.NVarChar(255), String(scheduleId))
      .input('monthlyAmount', sql.Decimal(10, 2), amount)
      .query(`
        UPDATE oe.GroupRecurringPaymentPlans
        SET MonthlyAmount = @monthlyAmount, ModifiedDate = GETUTCDATE()
        WHERE GroupId = @groupId AND DimeScheduleId = @scheduleId
      `);
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Scheduled payment not found for this group'
      });
    }
    res.json({
      success: true,
      message: 'Scheduled payment amount updated in our records (DIME will sync on 1st of month)',
      data: { monthlyAmount: amount }
    });
  } catch (error) {
    console.error('Error updating scheduled payment amount:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update amount',
      error: error.message
    });
  }
});

// =============================================
// PUT /api/groups/:groupId/payment-method/:paymentMethodId/set-default
// Set a payment method as the default
// =============================================
router.put('/:groupId/payment-method/:paymentMethodId/set-default', async (req, res) => {
  try {
    const { groupId, paymentMethodId } = req.params;
    const userId = req.user?.userId || req.headers['x-user-id'];

    const pool = await getPool();
    
    // First, remove default from all other payment methods
    await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        UPDATE oe.GroupPaymentMethods
        SET IsDefault = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
        WHERE GroupId = @groupId AND IsDefault = 1
      `);

    // Set the specified payment method as default
    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        UPDATE oe.GroupPaymentMethods
        SET IsDefault = 1, ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
        WHERE GroupId = @groupId AND PaymentMethodId = @paymentMethodId AND Status = 'Active'
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment method not found or inactive'
      });
    }

    res.json({
      success: true,
      message: 'Default payment method updated successfully'
    });
  } catch (error) {
    console.error('Error setting default payment method:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to set default payment method',
      error: error.message
    });
  }
});

// =============================================
// PUT /api/groups/:groupId/payment-method/:paymentMethodId
// Update a specific payment method (billing + location only, or full replace of account/card details)
// =============================================
router.put('/:groupId/payment-method/:paymentMethodId', async (req, res) => {
  try {
    const { groupId, paymentMethodId } = req.params;
    const {
      billingAddress,
      billingCity,
      billingState,
      billingZip,
      locationId,
      type,
      bankName,
      accountType,
      accountHolderName,
      routingNumber,
      accountNumber,
      cardNumber,
      expiryMonth,
      expiryYear,
      cvv,
      cardholderName,
      phoneNumber
    } = req.body;
    const userId = req.user?.UserId || req.user?.userId || req.headers['x-user-id'];

    if (!billingAddress || !billingCity || !billingState || !billingZip) {
      return res.status(400).json({
        success: false,
        message: 'Billing address, city, state, and zip are required'
      });
    }

    const pool = await getPool();

    // Load existing payment method and group (include ContactEmail for ensureDimeCustomer if needed)
    const existingResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
      .query(`
        SELECT gpm.PaymentMethodId, gpm.Type, gpm.ProcessorPaymentMethodId, gpm.ProcessorToken,
               ISNULL(gpm.ProcessorCustomerId, g.ProcessorCustomerId) as ProcessorCustomerId,
               g.TenantId, g.PrimaryContact as PrimaryContactName, g.ContactPhone as PrimaryContactPhone,
               g.ContactEmail as PrimaryContactEmail
        FROM oe.GroupPaymentMethods gpm
        INNER JOIN oe.Groups g ON g.GroupId = gpm.GroupId
        WHERE gpm.GroupId = @groupId AND gpm.PaymentMethodId = @paymentMethodId AND gpm.Status = 'Active'
      `);

    if (existingResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment method not found or inactive'
      });
    }

    const existing = existingResult.recordset[0];
    const tenantId = existing.TenantId;

    const hasNewAccountDetails = type === 'ACH' && routingNumber && accountNumber;
    const hasNewCardDetails = (type === 'CreditCard' || type === 'card') && cardNumber && expiryMonth && expiryYear && cvv && cardholderName;

    if (hasNewAccountDetails || hasNewCardDetails) {
      // Full replace: create new payment method in DIME, update DB row, delete old from DIME
      let dimeCustomerId = existing.ProcessorCustomerId;

      // Verify DIME customer exists; if 404/stale, clear and ensure (get-or-create)
      if (dimeCustomerId) {
        const customerCheck = await DimeService.getCustomer(dimeCustomerId, tenantId);
        if (!customerCheck.success) {
          console.warn('DIME customer not found (stale ID), will ensure customer:', dimeCustomerId, customerCheck.error?.status || customerCheck.error?.message);
          await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query('UPDATE oe.Groups SET ProcessorCustomerId = NULL, ModifiedDate = GETUTCDATE() WHERE GroupId = @groupId');
          dimeCustomerId = null;
        }
      }
      if (!dimeCustomerId) {
        const customerData = {
          firstName: existing.PrimaryContactName?.split(' ')[0] || 'Group',
          lastName: existing.PrimaryContactName?.split(' ').slice(1).join(' ') || 'Admin',
          email: existing.PrimaryContactEmail || 'group@example.com',
          phone: existing.PrimaryContactPhone || '+17707892072',
          billingAddress: billingAddress || '',
          billingCity: billingCity || '',
          billingState: billingState || '',
          billingZip: billingZip || '',
          billingCountry: 'US'
        };
        const customerResult = await PaymentMethodService.ensureDimeCustomer(customerData, 'group', groupId, tenantId);
        if (!customerResult.success) {
          return res.status(400).json({
            success: false,
            message: customerResult.error?.message || 'Could not ensure payment processor customer'
          });
        }
        dimeCustomerId = customerResult.customerId;
      }

      const paymentMethodData = {
        paymentMethodType: type === 'card' ? 'CreditCard' : type,
        billingAddress: billingAddress || '',
        billingCity: billingCity || '',
        billingState: billingState || '',
        billingZip: billingZip || '',
        billingCountry: 'US',
        ...(hasNewAccountDetails
          ? {
              bankName: bankName || '',
              accountType: accountType || 'Checking',
              routingNumber,
              accountNumber,
              accountHolderName: (accountHolderName || '').toString().trim() || existing.PrimaryContactName || 'Group'
            }
          : { cardNumber: String(cardNumber).replace(/\D/g, ''), expiryMonth: parseInt(expiryMonth, 10), expiryYear: parseInt(expiryYear, 10), cvv, cardholderName }
        )
      };

      const validation = PaymentMethodService.validatePaymentMethodData(paymentMethodData, paymentMethodData.paymentMethodType);
      if (!validation.isValid) {
        return res.status(400).json({
          success: false,
          message: 'Invalid payment method data',
          error: { details: validation.errors }
        });
      }

      let newToken, newProcessorId, newLast4, dimeResult;
      const panDigits = cardNumber ? String(cardNumber).replace(/\D/g, '') : '';
      const updatePayloadForDime = {
        type: hasNewAccountDetails ? 'ach' : 'cc',
        billingAddress,
        billingCity,
        billingState,
        billingZip,
        ...(hasNewAccountDetails
          ? {
              bankName,
              accountType,
              routingNumber,
              accountNumber,
              accountHolderName: (accountHolderName || '').toString().trim() || existing.PrimaryContactName || 'Group'
            }
          : {
              cardholderName,
              cardNumber: String(cardNumber).replace(/\D/g, ''),
              expiryMonth: parseInt(expiryMonth, 10),
              expiryYear: parseInt(expiryYear, 10),
              cvv,
              cardBrand: panDigits.length >= 13 ? dimeCardBrand.getCardBrandOrNull(panDigits) : undefined
            }
        )
      };

      // Prefer DIME PATCH update when we have an existing payment method
      if (existing.ProcessorPaymentMethodId) {
        dimeResult = await DimeService.updatePaymentMethod(dimeCustomerId, existing.ProcessorPaymentMethodId, updatePayloadForDime, tenantId);
        if (dimeResult.success) {
          newToken = dimeResult.token || existing.ProcessorToken || '';
          newProcessorId = String(dimeResult.paymentMethodId || existing.ProcessorPaymentMethodId);
          newLast4 = dimeResult.last4 || (hasNewAccountDetails ? String(accountNumber).slice(-4) : String(cardNumber).replace(/\s/g, '').slice(-4));
        }
      }

      if (!dimeResult || !dimeResult.success) {
        dimeResult = await PaymentMethodService.createPaymentMethod(paymentMethodData, dimeCustomerId, tenantId);
        if (!dimeResult.success) {
          return res.status(500).json({
            success: false,
            message: dimeResult.error?.message || 'Failed to create new payment method with processor',
            error: dimeResult.error
          });
        }
        newToken = String(dimeResult.token || dimeResult.paymentMethodId || '');
        newProcessorId = String(dimeResult.paymentMethodId || dimeResult.token || '');
        newLast4 = dimeResult.last4 || (hasNewAccountDetails ? String(accountNumber).slice(-4) : String(cardNumber).replace(/\s/g, '').slice(-4));
      }

      const updateReq = pool.request()
        .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('billingAddress', sql.NVarChar(255), billingAddress)
        .input('billingCity', sql.NVarChar(100), billingCity)
        .input('billingState', sql.NVarChar(50), billingState)
        .input('billingZip', sql.NVarChar(20), billingZip)
        .input('processorToken', sql.NVarChar, newToken)
        .input('processorPaymentMethodId', sql.NVarChar, newProcessorId)
        .input('userId', sql.UniqueIdentifier, userId);

      let setExtras = '';
      if (hasNewAccountDetails) {
        updateReq.input('bankName', sql.NVarChar, bankName || null);
        updateReq.input('accountType', sql.NVarChar, accountType || 'Checking');
        updateReq.input('accountHolderName', sql.NVarChar, (accountHolderName || '').toString().trim() || null);
        updateReq.input('accountNumberLast4', sql.NVarChar, String(accountNumber).slice(-4));
        updateReq.input('routingNumber', sql.NVarChar, routingNumber);
        setExtras = ', BankName = @bankName, AccountType = @accountType, AccountHolderName = @accountHolderName, AccountNumberLast4 = @accountNumberLast4, RoutingNumber = @routingNumber, CardBrand = NULL, CardLast4 = NULL, ExpiryMonth = NULL, ExpiryYear = NULL, CardholderName = NULL';
      } else {
        updateReq.input('cardBrand', sql.NVarChar, dimeResult.cardBrand || 'Visa');
        updateReq.input('cardLast4', sql.NVarChar, newLast4);
        updateReq.input('expiryMonth', sql.Int, parseInt(expiryMonth, 10));
        updateReq.input('expiryYear', sql.Int, parseInt(expiryYear, 10));
        updateReq.input('cardholderName', sql.NVarChar, cardholderName || null);
        setExtras = ', CardBrand = @cardBrand, CardLast4 = @cardLast4, ExpiryMonth = @expiryMonth, ExpiryYear = @expiryYear, CardholderName = @cardholderName, BankName = NULL, AccountType = NULL, AccountNumberLast4 = NULL, RoutingNumber = NULL';
      }

      if (locationId !== undefined) {
        updateReq.input('locationId', sql.UniqueIdentifier, locationId);
        setExtras += ', LocationId = @locationId';
      }

      await updateReq.query(`
        UPDATE oe.GroupPaymentMethods
        SET BillingAddress = @billingAddress, BillingCity = @billingCity, BillingState = @billingState, BillingZip = @billingZip,
            ProcessorToken = @processorToken, ProcessorPaymentMethodId = @processorPaymentMethodId,
            ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
            ${setExtras}
        WHERE GroupId = @groupId AND PaymentMethodId = @paymentMethodId AND Status = 'Active'
      `);

      if (existing.ProcessorPaymentMethodId && newProcessorId !== String(existing.ProcessorPaymentMethodId)) {
        try {
          await DimeService.deletePaymentMethod(existing.ProcessorPaymentMethodId, tenantId);
        } catch (delErr) {
          console.warn('Failed to delete old payment method from DIME:', delErr.message);
        }
      }

      return res.json({
        success: true,
        message: 'Payment method updated successfully (account/card details replaced)'
      });
    }

    // Billing and location only
    const updateRequest = pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
      .input('billingAddress', sql.NVarChar(255), billingAddress)
      .input('billingCity', sql.NVarChar(100), billingCity)
      .input('billingState', sql.NVarChar(50), billingState)
      .input('billingZip', sql.NVarChar(20), billingZip)
      .input('userId', sql.UniqueIdentifier, userId);

    let setLocation = '';
    if (locationId !== undefined) {
      updateRequest.input('locationId', sql.UniqueIdentifier, locationId);
      setLocation = ', LocationId = @locationId';
    }

    const result = await updateRequest.query(`
      UPDATE oe.GroupPaymentMethods
      SET
        BillingAddress = @billingAddress,
        BillingCity = @billingCity,
        BillingState = @billingState,
        BillingZip = @billingZip,
        ModifiedDate = GETUTCDATE(),
        ModifiedBy = @userId
        ${setLocation}
      WHERE GroupId = @groupId AND PaymentMethodId = @paymentMethodId AND Status = 'Active'
    `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment method not found or inactive'
      });
    }

    res.json({
      success: true,
      message: 'Payment method updated successfully'
    });
  } catch (error) {
    console.error('Error updating payment method:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update payment method',
      error: error.message
    });
  }
});

// =============================================
// POST /api/groups/:groupId/payment-method/:paymentMethodId/add-to-processor
// Re-tokenize an existing group payment method at DIME using the encrypted
// details on file. Mirrors the member-side route in members.js — used to
// recover from DIME error 23 (saved card token couldn't be resolved) without
// asking the group to re-enter their card / bank details.
//
// PCI DSS 3.2.2: optional `cvv` in the request body is forwarded to DIME and
// never persisted (not logged, not written to DB, not returned).
// =============================================
router.post('/:groupId/payment-method/:paymentMethodId/add-to-processor', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, paymentMethodId } = req.params;
    const userId = req.user?.UserId || req.user?.userId || req.headers['x-user-id'];

    const retryCvvRaw = req.body?.cvv;
    const retryCvv = typeof retryCvvRaw === 'string' ? retryCvvRaw.trim() : null;
    if (retryCvv && !/^\d{3,4}$/.test(retryCvv)) {
      return res.status(400).json({
        success: false,
        message: 'CVV must be 3 or 4 digits.',
        code: 'CVV_INVALID'
      });
    }

    const forceReplaceProcessorPaymentMethod =
      req.body?.forceReplaceProcessorPaymentMethod === true ||
      req.body?.replaceProcessorPaymentMethod === true;

    const pool = await getPool();

    const isDimeServerError = (errLike) => {
      const status = Number(
        errLike?.error?.statusCode ??
        errLike?.error?.status ??
        errLike?.statusCode ??
        errLike?.status
      );
      const msg = String(errLike?.error?.message || errLike?.message || '').toLowerCase();
      return status === 500 || msg.includes('server error');
    };

    const existingResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
      .query(`
        SELECT
          gpm.PaymentMethodId, gpm.GroupId, gpm.Type, gpm.Status,
          gpm.CardBrand, gpm.CardLast4, gpm.ExpiryMonth, gpm.ExpiryYear, gpm.CardholderName,
          gpm.BankName, gpm.AccountType, gpm.AccountNumberLast4, gpm.AccountHolderName, gpm.RoutingNumber,
          gpm.BillingAddress, gpm.BillingAddress2, gpm.BillingCity, gpm.BillingState, gpm.BillingZip, gpm.BillingCountry,
          gpm.ProcessorToken, gpm.ProcessorPaymentMethodId,
          ISNULL(gpm.ProcessorCustomerId, g.ProcessorCustomerId) AS ProcessorCustomerId,
          gpm.CardNumberEncrypted, gpm.AccountNumberEncrypted, gpm.RoutingNumberEncrypted,
          g.TenantId, g.PrimaryContact AS PrimaryContactName,
          g.ContactPhone AS PrimaryContactPhone, g.ContactEmail AS PrimaryContactEmail,
          g.Address AS GroupAddress, g.City AS GroupCity, g.State AS GroupState, g.Zip AS GroupZip
        FROM oe.GroupPaymentMethods gpm
        INNER JOIN oe.Groups g ON g.GroupId = gpm.GroupId
        WHERE gpm.GroupId = @groupId
          AND gpm.PaymentMethodId = @paymentMethodId
          AND gpm.Status IN ('Active', 'PendingProcessorVault')
      `);

    const existing = existingResult.recordset?.[0];
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Payment method not found' });
    }

    if (
      existing.ProcessorCustomerId &&
      existing.ProcessorPaymentMethodId &&
      !forceReplaceProcessorPaymentMethod
    ) {
      return res.json({
        success: true,
        message: 'Payment method is already saved to payment processor.',
        data: {
          paymentMethodId: existing.PaymentMethodId,
          processorCustomerId: existing.ProcessorCustomerId,
          processorPaymentMethodId: existing.ProcessorPaymentMethodId
        }
      });
    }

    const tenantId = existing.TenantId;
    const previousProcessorPaymentMethodId = existing.ProcessorPaymentMethodId
      ? String(existing.ProcessorPaymentMethodId)
      : null;

    let dimeCustomerId = existing.ProcessorCustomerId || null;
    if (!dimeCustomerId) {
      const customerData = {
        firstName: existing.PrimaryContactName?.split(' ')[0] || 'Group',
        lastName: existing.PrimaryContactName?.split(' ').slice(1).join(' ') || 'Admin',
        email: existing.PrimaryContactEmail || '',
        phone: existing.PrimaryContactPhone || '',
        billingAddress: existing.BillingAddress || existing.GroupAddress || '',
        billingCity: existing.BillingCity || existing.GroupCity || '',
        billingState: existing.BillingState || existing.GroupState || '',
        billingZip: existing.BillingZip || existing.GroupZip || '',
        billingCountry: existing.BillingCountry || 'US'
      };
      const customerResult = await PaymentMethodService.ensureDimeCustomer(customerData, 'group', groupId, tenantId);
      if (!customerResult?.success || !customerResult.customerId) {
        const msg = customerResult?.error?.message || customerResult?.message || 'Failed to ensure payment processor customer';
        return res.status(isDimeServerError(customerResult) ? 503 : 400).json({
          success: false,
          message: msg
        });
      }
      dimeCustomerId = customerResult.customerId;
    }

    let decrypted = {};
    try {
      decrypted = encryptionService.decryptPaymentData({
        cardNumberEncrypted: existing.CardNumberEncrypted,
        accountNumberEncrypted: existing.AccountNumberEncrypted,
        routingNumberEncrypted: existing.RoutingNumberEncrypted
      }) || {};
    } catch (_) {}

    const paymentMethodType = existing.Type === 'ACH' ? 'ACH' : 'Card';
    const cardholderFallback =
      existing.CardholderName ||
      existing.PrimaryContactName ||
      'Group';
    const accountHolderFallback =
      existing.AccountHolderName ||
      existing.PrimaryContactName ||
      'Group';

    const payload = {
      paymentMethodType,
      cardNumber: decrypted.cardNumber || null,
      expiryMonth: existing.ExpiryMonth || null,
      expiryYear: existing.ExpiryYear || null,
      cvv: paymentMethodType === 'Card' ? (retryCvv || undefined) : undefined,
      cardholderName: cardholderFallback,
      bankName: existing.BankName || null,
      accountType: existing.AccountType || 'Checking',
      routingNumber: resolveAchRoutingForCharge(
        existing.RoutingNumber,
        existing.RoutingNumberEncrypted
      ),
      accountNumber: decrypted.accountNumber || null,
      accountHolderName: accountHolderFallback,
      billingAddress: existing.BillingAddress || '',
      billingAddress2: existing.BillingAddress2 || '',
      billingCity: existing.BillingCity || '',
      billingState: existing.BillingState || '',
      billingZip: existing.BillingZip || '',
      billingCountry: existing.BillingCountry || 'US'
    };

    if (paymentMethodType === 'Card') {
      if (!payload.cardNumber || !payload.expiryMonth || !payload.expiryYear) {
        return res.status(400).json({
          success: false,
          message: 'Stored card details are incomplete for processor sync. Re-add the payment method and try again.'
        });
      }
    } else if (!payload.routingNumber || !payload.accountNumber) {
      return res.status(400).json({
        success: false,
        message: 'Stored bank account details are incomplete for processor sync. Re-add the payment method and try again.'
      });
    }

    const dimeResult = await PaymentMethodService.createPaymentMethod(
      payload,
      dimeCustomerId,
      tenantId,
      { requireTokenization: true }
    );
    if (!dimeResult.success || !dimeResult.paymentMethodId) {
      const errMsg = String(dimeResult.error?.rawMessage || dimeResult.error?.message || '').toLowerCase();
      const needsCvv = paymentMethodType === 'Card'
        && !retryCvv
        && /cvv|cvc|cv2|security code/.test(errMsg);
      if (needsCvv) {
        return res.status(400).json({
          success: false,
          code: 'CVV_REQUIRED',
          message: 'This card requires a CVV to re-save to the payment processor. Please enter the CVV to continue.'
        });
      }
      return res.status(isDimeServerError(dimeResult) ? 503 : 400).json({
        success: false,
        code: dimeResult.error?.code || 'PAYMENT_METHOD_SYNC_FAILED',
        message: dimeResult.error?.message || 'Failed to save payment method to payment processor'
      });
    }

    const newProcessorPaymentMethodId = String(dimeResult.paymentMethodId);
    const newProcessorToken = dimeResult.token ? String(dimeResult.token) : (existing.ProcessorToken || '');
    const newProcessorCustomerId = String(dimeResult.customerId || dimeCustomerId);

    await pool.request()
      .input('paymentMethodId', sql.UniqueIdentifier, existing.PaymentMethodId)
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('processorCustomerId', sql.NVarChar(255), newProcessorCustomerId)
      .input('processorPaymentMethodId', sql.NVarChar(255), newProcessorPaymentMethodId)
      .input('processorToken', sql.NVarChar(255), newProcessorToken)
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        UPDATE oe.GroupPaymentMethods
        SET ProcessorCustomerId = @processorCustomerId,
            ProcessorPaymentMethodId = @processorPaymentMethodId,
            ProcessorToken = @processorToken,
            Status = CASE WHEN Status = 'PendingProcessorVault' THEN 'Active' ELSE Status END,
            ModifiedDate = GETUTCDATE(),
            ModifiedBy = @userId
        WHERE GroupId = @groupId AND PaymentMethodId = @paymentMethodId
      `);

    if (
      previousProcessorPaymentMethodId &&
      previousProcessorPaymentMethodId !== newProcessorPaymentMethodId
    ) {
      try {
        await DimeService.deletePaymentMethod(previousProcessorPaymentMethodId, tenantId);
      } catch (delErr) {
        console.warn('Failed to delete old processor payment method after re-tokenization:', delErr.message);
      }
    }

    return res.json({
      success: true,
      message: forceReplaceProcessorPaymentMethod
        ? 'Payment method re-tokenized with payment processor. Confirm DIME recurring still references this method before retrying the charge.'
        : 'Payment method saved to payment processor.',
      data: {
        paymentMethodId: existing.PaymentMethodId,
        processorCustomerId: newProcessorCustomerId,
        processorPaymentMethodId: newProcessorPaymentMethodId
      }
    });
  } catch (error) {
    console.error('❌ Error syncing group payment method to processor:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to save payment method to payment processor'
    });
  }
});

// =============================================
// GET /api/groups/:groupId/payment-method/:paymentMethodId/reveal
// Reveal decrypted routing and account numbers for ACH (edit mode only)
// =============================================
router.get('/:groupId/payment-method/:paymentMethodId/reveal', async (req, res) => {
  try {
    const { groupId, paymentMethodId } = req.params;
    const pool = await getPool();

    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
      .query(`
        SELECT Type, RoutingNumber, RoutingNumberEncrypted, AccountNumberEncrypted
        FROM oe.GroupPaymentMethods
        WHERE GroupId = @groupId AND PaymentMethodId = @paymentMethodId AND Status = 'Active'
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment method not found' });
    }
    const pm = result.recordset[0];
    if (pm.Type !== 'ACH') {
      return res.status(400).json({ success: false, message: 'Reveal is only for ACH payment methods' });
    }

    let routingNumber = pm.RoutingNumber ? String(pm.RoutingNumber).replace(/\D/g, '') : null;
    let accountNumber = null;

    if (!routingNumber && pm.RoutingNumberEncrypted) {
      try {
        routingNumber = encryptionService.decrypt(pm.RoutingNumberEncrypted).replace(/\D/g, '');
      } catch (e) {
        // ignore
      }
    }
    if (pm.AccountNumberEncrypted) {
      try {
        accountNumber = encryptionService.decrypt(pm.AccountNumberEncrypted);
      } catch (e) {
        // ignore
      }
    }

    res.json({
      success: true,
      data: { routingNumber: routingNumber || null, accountNumber: accountNumber || null }
    });
  } catch (error) {
    console.error('Error revealing payment method:', error);
    res.status(500).json({ success: false, message: 'Failed to reveal payment method' });
  }
});

// =============================================
// DELETE /api/groups/:groupId/payment-method/:paymentMethodId
// Delete a payment method
// =============================================
router.delete('/:groupId/payment-method/:paymentMethodId', async (req, res) => {
  try {
    const { groupId, paymentMethodId } = req.params;
    const userId = req.user?.userId || req.headers['x-user-id'];

    const pool = await getPool();
    
    // Get tenantId from group
    const groupResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query('SELECT TenantId FROM oe.Groups WHERE GroupId = @groupId');
    const tenantId = groupResult.recordset[0]?.TenantId;
    
    // Get payment method details including DIME tokens
    const paymentMethodQuery = `
      SELECT 
        PaymentMethodId, 
        IsDefault, 
        ProcessorToken, 
        ProcessorPaymentMethodId
      FROM oe.GroupPaymentMethods
      WHERE GroupId = @groupId 
        AND PaymentMethodId = @paymentMethodId 
        AND Status = 'Active'
    `;
    const paymentMethodResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
      .query(paymentMethodQuery);

    if (paymentMethodResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment method not found or inactive'
      });
    }

    const paymentMethod = paymentMethodResult.recordset[0];
    const isDefault = paymentMethod.IsDefault;

    // Delete from DIME if it has processor tokens
    if (paymentMethod.ProcessorToken && paymentMethod.ProcessorPaymentMethodId) {
      try {
        const dimeResult = await DimeService.deletePaymentMethod(
          paymentMethod.ProcessorToken,
          paymentMethod.ProcessorPaymentMethodId,
          tenantId
        );
        
        if (!dimeResult.success) {
          console.warn(`⚠️ Failed to delete payment method from DIME: ${dimeResult.message}`);
          // Continue with local deletion even if DIME deletion fails
        } else {
          console.log(`✅ Payment method deleted from DIME successfully`);
        }
      } catch (dimeError) {
        console.error('Error deleting payment method from DIME:', dimeError);
        // Continue with local deletion
      }
    }

    // Delete the payment method (soft delete by setting status to Inactive)
    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        UPDATE oe.GroupPaymentMethods
        SET Status = 'Inactive', ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
        WHERE GroupId = @groupId AND PaymentMethodId = @paymentMethodId
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment method not found'
      });
    }

    // If we deleted the default payment method, set another one as default
    if (isDefault) {
      const nextDefault = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
          SELECT TOP 1 PaymentMethodId FROM oe.GroupPaymentMethods
          WHERE GroupId = @groupId AND Status = 'Active'
          ORDER BY CreatedDate DESC
        `);

      if (nextDefault.recordset.length > 0) {
        await pool.request()
          .input('groupId', sql.UniqueIdentifier, groupId)
          .input('paymentMethodId', sql.UniqueIdentifier, nextDefault.recordset[0].PaymentMethodId)
          .input('userId', sql.UniqueIdentifier, userId)
          .query(`
            UPDATE oe.GroupPaymentMethods
            SET IsDefault = 1, ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
            WHERE GroupId = @groupId AND PaymentMethodId = @paymentMethodId
          `);
      }
    }

    res.json({
      success: true,
      message: 'Payment method deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting payment method:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete payment method',
      error: error.message
    });
  }
});

module.exports = router;
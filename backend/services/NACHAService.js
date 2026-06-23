// backend/services/NACHAService.js
/**
 * COHORT COMPATIBILITY NOTE: NACHA generation treats oe.Invoices.BillingPeriodStart
 * and BillingPeriodEnd as opaque date ranges, not calendar-month windows. 15th-14th
 * billing periods are handled correctly without code change here.
 */
const { getPool, sql } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const commissionCalculatorService = require('./CommissionCalculatorService');
const { getProductOverridePayoutsByPayment } = require('./productOverridePayouts.service');
const achService = require('./ACHService');
const logger = require('../config/logger');
const Nacha = require('@midlandsbank/node-nacha').default;
const {
  PAID_PAYMENT_STATUSES_SQL,
  paymentInWindowSql,
  fundingGateSql,
  invoiceCoversWindowSql,
  invoicePayoutWindowSql,
  FUNDING_SOURCE,
} = require('./payoutFunding.service');

// Load commission helpers (optional - for agent commission payouts using oe.Commissions)
let getEligibleCommissions, commissionsToPayoutBreakdown;
try {
  const commissionHelpers = require('./NACHAService.commissions');
  getEligibleCommissions = commissionHelpers.getEligibleCommissions;
  commissionsToPayoutBreakdown = commissionHelpers.commissionsToPayoutBreakdown;
} catch (error) {
  // Fallback: will use existing payment-based calculation
  // Don't use logger here as it may not be initialized yet
  console.warn('⚠️ NACHAService.commissions not available, using legacy calculation method:', error.message);
  getEligibleCommissions = null;
  commissionsToPayoutBreakdown = null;
}

const TIER_LEVEL_SQL = sql.Decimal(9, 4);

/**
 * Normalize Company Identification for NACHA: stored as 9-digit EIN or 10-digit format.
 * NACHA requires 10 digits; if stored as 9-digit EIN, prepend "1" per standard convention.
 * @param {string} companyId - Raw value from DB (9 or 10 digits)
 * @returns {string} 10-digit value for NACHA
 */
function normalizeCompanyIdForNacha(companyId) {
  const raw = (companyId || '').toString().trim().replace(/\D/g, '');
  if (raw.length === 9) return '1' + raw; // EIN: prepend 1 for NACHA 10-digit format
  if (raw.length === 10) return raw;
  throw new Error(`Invalid companyIdentification. Expected 9 (EIN) or 10 digits, got: ${raw || '(empty)'}`);
}

/**
 * NACHA Service - Generate NACHA ACH files for commission payouts
 * Implements standard NACHA file format for ACH transactions
 */
class NACHAService {
  normalizeEnrollmentLookupWindow(paymentDate, billingPeriodStart = null, billingPeriodEnd = null) {
    const fallback = paymentDate ? new Date(paymentDate) : new Date();
    const start = billingPeriodStart ? new Date(billingPeriodStart) : fallback;
    const end = billingPeriodEnd ? new Date(billingPeriodEnd) : fallback;

    if (start <= end) {
      return { lookupStartDate: start, lookupEndDate: end };
    }
    return { lookupStartDate: end, lookupEndDate: start };
  }

  async resolveEnrollmentLookupWindow(paymentId, paymentDate = null) {
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
      logger.warn('Failed to resolve invoice enrollment lookup window in NACHA, using payment date fallback', {
        paymentId,
        error: error.message
      }, 'NACHA');
      return { ...fallbackWindow, source: 'paymentDateFallback' };
    }
  }

  /**
   * Generate NACHA file for commission payouts
   * @param {Object} options - Generation options
   * @param {string} options.payoutType - 'Agent Commission Payouts', 'Vendor Payouts', 'Product Owner Payouts'
   * @param {Date} options.startDate - Start date for payment range
   * @param {Date} options.endDate - End date for payment range
   * @param {string} options.tenantId - Tenant ID filter (optional)
   * @param {string[]} options.vendorIds - Vendor IDs to include (optional, for Vendor Payouts only)
   * @param {string} options.userId - User ID generating the file
   * @returns {Promise<Object>} NACHA generation record
   */
  async generateNACHA(options) {
    const { payoutType, startDate, endDate, tenantId, vendorIds, agentIds, agencyIds, fundingAchAccountId, companyIdentification, userId, payoutBasis, excludedPaymentIds, excludedInvoiceIds } = options;
    // Build exclusion lookups so we filter out payouts whose anchoring payment or invoice was unchecked in preview.
    const excludedPaymentIdSet = new Set((Array.isArray(excludedPaymentIds) ? excludedPaymentIds : []).filter(Boolean).map(id => String(id).toUpperCase()));
    const excludedInvoiceIdSet = new Set((Array.isArray(excludedInvoiceIds) ? excludedInvoiceIds : []).filter(Boolean).map(id => String(id).toUpperCase()));

    try {
      // Overlap handling:
      // We can safely ALLOW overlapping generations because settlement is tracked per (PaymentId + Recipient) in oe.NACHAPaymentDetails
      // and we only treat rows linked to oe.NACHAGenerations.Status='Sent' as paid.
      //
      // markNACHAasSent also performs a final "double-pay" conflict check across Sent files.
      // Therefore overlap is a warning, not a hard stop.
      const warnings = [];
      const overlap = await this.validateNoOverlap(startDate, endDate, payoutType, tenantId);
      if (overlap) {
        const warningMessage =
          `Overlapping NACHA file exists for date range ${overlap.StartDate} to ${overlap.EndDate}. ` +
          `Continuing anyway (safe due to ledger-based tracking). Existing file ID: ${overlap.NACHAId}.`;

        warnings.push({
          code: 'OVERLAPPING_DATE_RANGE',
          message: warningMessage,
          existingNachaId: overlap.NACHAId,
          existingStartDate: overlap.StartDate,
          existingEndDate: overlap.EndDate
        });

        logger.warn('Overlapping NACHA generation detected (allowed)', {
          payoutType,
          startDate,
          endDate,
          tenantId: tenantId || null,
          overlap
        }, 'NACHA');
      }

    // For Agent Commission Payouts, use oe.Commissions table (respects advance balances)
    // For Vendor/Product Owner payouts, use existing payment-based calculation
    let payoutBreakdown;
    
    if (payoutType === 'Agent Commission Payouts') {
      // CRITICAL: Agent Commission Payouts MUST use oe.Commissions table
      // NO FALLBACK - if no commissions found, that's a data issue, not a reason to calculate differently
      if (!getEligibleCommissions || !commissionsToPayoutBreakdown) {
        throw new Error('Commission helpers not available. Agent Commission Payouts require oe.Commissions table.');
      }
      
      logger.info('Using oe.Commissions table for agent payouts', {
        startDate,
        endDate,
        tenantId: tenantId || 'all'
      }, 'NACHA');
      
      // Use oe.Commissions table - Amount field already represents actual payout after advance recovery
      const eligibleCommissions = await getEligibleCommissions(startDate, endDate, tenantId, payoutType);
      
      if (eligibleCommissions.length === 0) {
        throw new Error('No eligible commissions found in the specified date range. Ensure commissions exist in oe.Commissions table with Status = \'Pending\' and Amount > 0.');
      }

      logger.info('Eligible commissions found', {
        commissionCount: eligibleCommissions.length,
        startDate,
        endDate
      }, 'NACHA');

      // Apply per-row exclusions from the preview UI (excludedPaymentIds / excludedInvoiceIds)
      const filteredCommissions = (excludedPaymentIdSet.size > 0 || excludedInvoiceIdSet.size > 0)
        ? eligibleCommissions.filter(c => {
            const pid = c.PaymentId ? String(c.PaymentId).toUpperCase() : null;
            const iid = c.InvoiceId ? String(c.InvoiceId).toUpperCase() : null;
            if (pid && excludedPaymentIdSet.has(pid)) return false;
            if (iid && excludedInvoiceIdSet.has(iid)) return false;
            return true;
          })
        : eligibleCommissions;

      if (filteredCommissions.length === 0) {
        throw new Error('All eligible commissions were excluded by the per-row exclusion filter');
      }

      // Use stored commissions from oe.Commissions table (no dynamic recalculation)
      // This includes both agent commissions AND agency overflow commissions (stored with AgencyId)
      payoutBreakdown = commissionsToPayoutBreakdown(filteredCommissions);
    } else {
      // For Vendor/Product Owner payouts, use existing payment-based calculation
      const effectiveBasis = payoutBasis || (payoutType === 'Vendor Payouts' ? 'effectiveEnrollment' : 'paymentReceived');
      const payments = await this.getUnpaidPayments(startDate, endDate, tenantId, effectiveBasis, payoutType);
      
      if (payments.length === 0) {
        throw new Error('No unpaid payments found in the specified date range');
      }

      // Apply per-row exclusions from the preview UI
      const filteredPayments = (excludedPaymentIdSet.size > 0 || excludedInvoiceIdSet.size > 0)
        ? payments.filter(p => {
            const pid = p.PaymentId ? String(p.PaymentId).toUpperCase() : null;
            const iid = p.InvoiceId ? String(p.InvoiceId).toUpperCase() : null;
            if (pid && excludedPaymentIdSet.has(pid)) return false;
            if (iid && excludedInvoiceIdSet.has(iid)) return false;
            return true;
          })
        : payments;

      if (filteredPayments.length === 0) {
        throw new Error('All unpaid payments were excluded by the per-row exclusion filter');
      }

      // Calculate commissions for all payments
      if (payoutType === 'Vendor Payouts') {
        payoutBreakdown = await this.calculateVendorPayoutBreakdown(filteredPayments);
      } else {
        payoutBreakdown = await this.calculateCommissionPayoutBreakdown(filteredPayments, payoutType);
      }
    }

      // Filter payouts by type
      const filteredPayouts = this.filterPayoutsByType(payoutBreakdown, payoutType);

      // Group payouts by recipient
      let groupedPayouts = this.groupPayoutsByRecipient(filteredPayouts);

      // Phase 6e — Vendor + Tenant override netting from oe.PayoutClawbacks.
      //
      // Commission clawbacks live in oe.Commissions and net automatically via
      // the Phase 6a getEligibleCommissions filter (positive + negative both
      // get included, sums per recipient).
      //
      // Vendor + Tenant override clawbacks live in oe.PayoutClawbacks. For each
      // Vendor / Tenant grouped payout, look up Available/PartiallyApplied
      // clawback balance and reduce the amount. The actual RemainingAmount /
      // Status drain happens after the NACHA row is saved so we can stamp
      // AppliedToNACHAId. If the NACHA is later marked Not Sent, the drain is
      // reversed in markNACHAasNotSent.
      try {
        const PayoutClawbacks = require('./payoutClawbacks.service');
        for (const payout of groupedPayouts) {
          if (payout.entityType !== 'Vendor' && payout.entityType !== 'Tenant') continue;
          const payoutTypeKey = payout.entityType === 'Vendor'
            ? PayoutClawbacks.PAYOUT_TYPES.VENDOR
            : PayoutClawbacks.PAYOUT_TYPES.TENANT_OVERRIDE;
          const available = await PayoutClawbacks.listAvailableForRecipient({
            tenantId: payout.tenantId || tenantId,
            payoutType: payoutTypeKey,
            recipientEntityId: payout.entityId
          });
          if (!available || available.length === 0) continue;
          const totalAvailable = available.reduce((s, r) => s + Number(r.RemainingAmount || 0), 0);
          if (totalAvailable <= 0) continue;
          const reduceBy = Math.min(Number(payout.amount) || 0, totalAvailable);
          if (reduceBy <= 0) continue;
          payout.amount = Math.round((Number(payout.amount) - reduceBy) * 100) / 100;
          payout._payoutClawbackApplied = Math.round(reduceBy * 100) / 100;
          payout._payoutClawbackPayoutType = payoutTypeKey;
          logger.info('Vendor/override clawback netted into NACHA payout', {
            recipientEntityType: payout.entityType,
            recipientEntityId: payout.entityId,
            reducedBy: payout._payoutClawbackApplied,
            netAmount: payout.amount
          }, 'NACHA');
        }
      } catch (clawErr) {
        logger.warn('Phase 6e vendor/override netting skipped', { error: clawErr.message }, 'NACHA');
      }

      // Phase 6c — Non-negative ACH guard.
      //
      // After netting, a recipient's grouped amount can be <= 0 (clawback >=
      // positive payout). ACH files cannot carry zero or negative entries, so
      // we drop those grouped payouts here. The underlying negative
      // oe.Commissions rows stay Status='Pending' and AppliedToNACHAId NULL,
      // which means they automatically carry forward to the next NACHA cycle.
      //
      // We log per-recipient so finance has visibility into who's carrying
      // a negative balance.
      const carryForwardLog = [];
      groupedPayouts = groupedPayouts.filter((p) => {
        const amount = Number(p.amount) || 0;
        if (amount > 0.005) return true;
        carryForwardLog.push({
          entityType: p.entityType,
          entityId: p.entityId,
          netAmount: Math.round(amount * 100) / 100,
          payoutCount: Array.isArray(p.payoutDetails) ? p.payoutDetails.length : 0
        });
        return false;
      });
      if (carryForwardLog.length > 0) {
        logger.info('Non-negative ACH guard: carrying forward zero/negative recipients to next NACHA cycle', {
          payoutType,
          carriedForwardCount: carryForwardLog.length,
          recipients: carryForwardLog
        }, 'NACHA');
      }

      // Filter vendors if vendorIds are provided (for Vendor Payouts only)
      if (payoutType === 'Vendor Payouts' && vendorIds && Array.isArray(vendorIds) && vendorIds.length > 0) {
        const vendorIdsSet = new Set(vendorIds.map(id => id.toString().toUpperCase()));
        groupedPayouts = groupedPayouts.filter(payout => {
          if (payout.entityType === 'Vendor') {
            return vendorIdsSet.has(payout.entityId.toString().toUpperCase());
          }
          return true; // Keep non-vendor payouts (shouldn't happen for Vendor Payouts, but be safe)
        });
        
        logger.info('Filtered vendors for NACHA generation', {
          requestedVendorIds: vendorIds.length,
          filteredPayouts: groupedPayouts.length,
          vendorIds: vendorIds
        }, 'NACHA');
      }

      // Filter Agent/Agency recipients if agentIds/agencyIds are provided (for Agent Commission Payouts only)
      if (payoutType === 'Agent Commission Payouts') {
        const hasAgentFilter = agentIds && Array.isArray(agentIds) && agentIds.length > 0;
        const hasAgencyFilter = agencyIds && Array.isArray(agencyIds) && agencyIds.length > 0;

        if (hasAgentFilter || hasAgencyFilter) {
          const agentIdsSet = new Set((agentIds || []).map(id => id.toString().toUpperCase()));
          const agencyIdsSet = new Set((agencyIds || []).map(id => id.toString().toUpperCase()));

          groupedPayouts = groupedPayouts.filter(payout => {
            if (payout.entityType === 'Agent') {
              return hasAgentFilter ? agentIdsSet.has(payout.entityId.toString().toUpperCase()) : false;
            }
            if (payout.entityType === 'Agency') {
              return hasAgencyFilter ? agencyIdsSet.has(payout.entityId.toString().toUpperCase()) : false;
            }
            // Keep any unexpected entity types (shouldn't happen for Agent Commission Payouts)
            return true;
          });

          logger.info('Filtered Agent/Agency recipients for NACHA generation', {
            hasAgentFilter,
            hasAgencyFilter,
            requestedAgentIds: (agentIds || []).length,
            requestedAgencyIds: (agencyIds || []).length,
            filteredPayouts: groupedPayouts.length
          }, 'NACHA');
        }
      }

      // Get ACH information for all recipients
      const { payoutsWithACH, excludedPayouts } = await this.enhancePayoutsWithACH(groupedPayouts, payoutType);

      // Enhanced logging with detailed exclusion reasons
      logger.info('Payouts summary after ACH enhancement', {
        groupedPayoutsCount: groupedPayouts.length,
        payoutsWithACHCount: payoutsWithACH.length,
        excludedPayoutsCount: excludedPayouts.length,
        groupedTotalAmount: groupedPayouts.reduce((sum, p) => sum + p.amount, 0),
        achTotalAmount: payoutsWithACH.reduce((sum, p) => sum + p.amount, 0),
        excludedTotalAmount: excludedPayouts.reduce((sum, p) => sum + p.amount, 0),
        excludedDetails: excludedPayouts.map(p => ({
          entityType: p.entityType,
          entityId: p.entityId,
          entityName: p.entityName || 'Unknown',
          amount: p.amount,
          reason: p.reason || 'No ACH account found'
        }))
      }, 'NACHA');

      console.log('📊 Payouts summary:', {
        groupedPayoutsCount: groupedPayouts.length,
        payoutsWithACHCount: payoutsWithACH.length,
        excludedPayoutsCount: excludedPayouts.length,
        groupedTotalAmount: groupedPayouts.reduce((sum, p) => sum + p.amount, 0),
        achTotalAmount: payoutsWithACH.reduce((sum, p) => sum + p.amount, 0),
        excludedTotalAmount: excludedPayouts.reduce((sum, p) => sum + p.amount, 0),
        excludedDetails: excludedPayouts.map(p => ({
          entityType: p.entityType,
          entityId: p.entityId,
          entityName: p.entityName || 'Unknown',
          amount: p.amount,
          reason: p.reason || 'No ACH account found'
        }))
      });

      // Calculate totals from grouped payouts (before ACH filtering)
      // This ensures we capture totals even if some recipients don't have ACH accounts
      const totalAmount = groupedPayouts.reduce((sum, p) => sum + p.amount, 0);
      const totalPayouts = groupedPayouts.length;
      
      // Track excluded payouts for warnings
      const excludedAmount = excludedPayouts.reduce((sum, p) => sum + p.amount, 0);
      const excludedCount = excludedPayouts.length;

      // CRITICAL: Validate that we have payouts with ACH accounts before generating file
      if (payoutsWithACH.length === 0) {
        const excludedDetails = excludedPayouts.map(p => ({
          entityType: p.entityType,
          entityId: p.entityId,
          entityName: p.entityName || 'Unknown',
          amount: p.amount,
          reason: p.reason || 'No ACH account found'
        }));

        logger.error('Cannot generate NACHA file: No payouts with ACH accounts', {
          payoutType,
          groupedPayoutsCount: groupedPayouts.length,
          excludedPayoutsCount: excludedCount,
          excludedAmount,
          excludedDetails
        }, 'NACHA');

        throw new Error(
          `Cannot generate NACHA file: No payouts with active ACH accounts found. ` +
          `${excludedCount} payout(s) totaling $${excludedAmount.toFixed(2)} were excluded. ` +
          `All recipients must have active ACH accounts configured.`
        );
      }

      // Get tenant ACH account for file header information
      // If tenantId is provided, use it; otherwise, determine from grouped payouts or payments
      let fileHeaderTenantId = tenantId;
      
      // If no tenantId provided, try to get it from grouped payouts (even if they don't have ACH)
      if (!fileHeaderTenantId && groupedPayouts.length > 0) {
        // Try to get tenantId from the first payout's entity if it's a tenant
        // For other entity types, we'll need to query payments to get the tenant
        const firstPayout = groupedPayouts[0];
        if (firstPayout.entityType === 'Tenant') {
          fileHeaderTenantId = firstPayout.entityId;
        } else {
          // For non-tenant payouts, get tenantId from payments
          // Get the first payment's tenantId by querying payments
          try {
            const headerBasis = payoutBasis || (payoutType === 'Vendor Payouts' ? 'effectiveEnrollment' : 'paymentReceived');
            const payments = await this.getUnpaidPayments(startDate, endDate, null, headerBasis, payoutType);
            if (payments.length > 0) {
              const first = payments[0];
              if (first.TenantId) {
                fileHeaderTenantId = first.TenantId;
              } else if (first.PaymentId) {
                const pool = await getPool();
                const request = pool.request();
                request.input('PaymentId', sql.UniqueIdentifier, first.PaymentId);
                const paymentTenantResult = await request.query(`
                  SELECT TOP 1
                    COALESCE(g.TenantId, p.ProductOwnerId) as TenantId
                  FROM oe.Payments pay
                  LEFT JOIN oe.Enrollments e ON pay.EnrollmentId = e.EnrollmentId
                  LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
                  LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
                  LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
                  WHERE pay.PaymentId = @PaymentId
                    AND (g.TenantId IS NOT NULL OR p.ProductOwnerId IS NOT NULL)
                `);
                if (paymentTenantResult.recordset.length > 0 && paymentTenantResult.recordset[0].TenantId) {
                  fileHeaderTenantId = paymentTenantResult.recordset[0].TenantId;
                }
              } else if (first.InvoiceId) {
                const pool = await getPool();
                const invReq = pool.request();
                invReq.input('InvoiceId', sql.UniqueIdentifier, first.InvoiceId);
                const invTen = await invReq.query(`
                  SELECT TenantId FROM oe.Invoices WHERE InvoiceId = @InvoiceId
                `);
                if (invTen.recordset.length > 0 && invTen.recordset[0].TenantId) {
                  fileHeaderTenantId = invTen.recordset[0].TenantId;
                }
              }
            }
          } catch (error) {
            logger.warn('Could not determine tenantId from payments', { error: error.message }, 'NACHA');
          }
        }
      }
      
      if (!fileHeaderTenantId) {
        throw new Error('tenantId is required for NACHA file generation. The tenant\'s ACH account is used for file header information.');
      }

      // Determine the ACH account that will FUND the NACHA file (file header account).
      // IMPORTANT: Funding source varies by payoutType:
      // - Agent Commission Payouts: funded by tenant's commissions processor / TPA (when configured), then fallback to tenant ACH.
      // - Vendor Payouts: funded by tenant's PRIMARY AGENCY ACH (preferred), then fallback to tenant ACH.
      // - Product Owner Payouts / Product Override Distributions: funded by tenant ACH (or ProductOverrideACH fallback).
      let tenantACHAccount = null;
      const pool = await getPool();
      const request = pool.request();
      request.input('TenantId', sql.UniqueIdentifier, fileHeaderTenantId);
      
      // If fundingAchAccountId is provided, use it directly
      // First check if it's a TenantPayoutACH account, then try ACHAccounts
      if (fundingAchAccountId) {
        try {
          // First, try TenantPayoutACH table
          const tenantPayoutRequest = pool.request();
          tenantPayoutRequest.input('FundingAchAccountId', sql.UniqueIdentifier, fundingAchAccountId);
          tenantPayoutRequest.input('TenantId', sql.UniqueIdentifier, fileHeaderTenantId);
          
          const tenantPayoutCheck = await tenantPayoutRequest.query(`
            SELECT TOP 1
              TenantPayoutACHId,
              AccountHolderName,
              BankName,
              BankAccountType,
              RoutingNumberEncrypted,
              AccountNumberEncrypted,
              IsActive
            FROM oe.TenantPayoutACH
            WHERE TenantPayoutACHId = @FundingAchAccountId
              AND TenantId = @TenantId
              AND IsActive = 1
          `);
          
          if (tenantPayoutCheck.recordset.length > 0) {
            // It's a TenantPayoutACH account
            const tenantAccount = tenantPayoutCheck.recordset[0];
            const encryptionService = require('./encryptionService');
            
            let routingNumber = null;
            let accountNumber = null;
            
            try {
              if (tenantAccount.RoutingNumberEncrypted) {
                routingNumber = encryptionService.decrypt(tenantAccount.RoutingNumberEncrypted);
              }
              if (tenantAccount.AccountNumberEncrypted) {
                accountNumber = encryptionService.decrypt(tenantAccount.AccountNumberEncrypted);
              }
            } catch (decryptError) {
              logger.warn('Failed to decrypt TenantPayoutACH', {
                error: decryptError.message,
                fundingAchAccountId
              }, 'NACHA');
            }
            
            if (routingNumber && accountNumber) {
              tenantACHAccount = {
                ACHAccountId: tenantAccount.TenantPayoutACHId,
                AccountHolderName: tenantAccount.AccountHolderName,
                BankName: tenantAccount.BankName,
                AccountType: tenantAccount.BankAccountType,
                RoutingNumber: routingNumber,
                AccountNumber: accountNumber,
                Status: tenantAccount.IsActive ? 'Active' : 'Inactive'
              };
              
              logger.info('Using provided TenantPayoutACH account', {
                fundingAchAccountId,
                accountHolderName: tenantACHAccount.AccountHolderName,
                bankName: tenantACHAccount.BankName,
                payoutType
              }, 'NACHA');
            }
          } else {
            // Try ACHAccounts table (for Agency, Tenant, Vendor accounts)
            tenantACHAccount = await achService.getACHAccountById(fundingAchAccountId, true);
            if (tenantACHAccount && tenantACHAccount.Status === 'Active') {
              logger.info('Using provided funding ACH account from ACHAccounts', {
                fundingAchAccountId,
                accountHolderName: tenantACHAccount.AccountHolderName,
                bankName: tenantACHAccount.BankName,
                payoutType
              }, 'NACHA');
            } else {
              logger.warn('Provided funding ACH account is not active, falling back to default logic', {
                fundingAchAccountId,
                status: tenantACHAccount?.Status
              }, 'NACHA');
              tenantACHAccount = null; // Fall through to default logic
            }
          }
        } catch (error) {
          logger.warn('Failed to get provided funding ACH account, falling back to default logic', {
            fundingAchAccountId,
            error: error.message
          }, 'NACHA');
          tenantACHAccount = null; // Fall through to default logic
        }
      }
      
      // Vendor Payouts: prefer TenantPayoutACH table, then primary agency ACH, then fallback to tenant ACH.
      if (!tenantACHAccount && payoutType === 'Vendor Payouts') {
        // First, try TenantPayoutACH table (new dedicated table for vendor payouts)
        try {
          const tenantPayoutResult = await request.query(`
            SELECT TOP 1
              TenantPayoutACHId,
              AccountHolderName,
              BankName,
              BankAccountType,
              RoutingNumberEncrypted,
              AccountNumberEncrypted,
              IsActive,
              IsDefault
            FROM oe.TenantPayoutACH
            WHERE TenantId = @TenantId
              AND IsActive = 1
            ORDER BY IsDefault DESC, CreatedDate DESC
          `);
          
          if (tenantPayoutResult.recordset.length > 0) {
            const tenantAccount = tenantPayoutResult.recordset[0];
            const encryptionService = require('./encryptionService');
            
            // Decrypt account and routing numbers
            let routingNumber = null;
            let accountNumber = null;
            
            try {
              if (tenantAccount.RoutingNumberEncrypted) {
                routingNumber = encryptionService.decrypt(tenantAccount.RoutingNumberEncrypted);
              }
              if (tenantAccount.AccountNumberEncrypted) {
                accountNumber = encryptionService.decrypt(tenantAccount.AccountNumberEncrypted);
              }
            } catch (decryptError) {
              logger.warn('Failed to decrypt TenantPayoutACH routing/account numbers', {
                error: decryptError.message,
                tenantId: fileHeaderTenantId
              }, 'NACHA');
            }
            
            if (routingNumber && accountNumber) {
              tenantACHAccount = {
                ACHAccountId: tenantAccount.TenantPayoutACHId,
                AccountHolderName: tenantAccount.AccountHolderName,
                BankName: tenantAccount.BankName,
                AccountType: tenantAccount.BankAccountType,
                RoutingNumber: routingNumber,
                AccountNumber: accountNumber,
                Status: tenantAccount.IsActive ? 'Active' : 'Inactive',
                IsDefault: tenantAccount.IsDefault === true || tenantAccount.IsDefault === 1
              };
              
              logger.info('Using TenantPayoutACH account for Vendor Payouts file header', {
                tenantId: fileHeaderTenantId,
                accountHolderName: tenantACHAccount.AccountHolderName,
                bankName: tenantACHAccount.BankName
              }, 'NACHA');
            }
          }
        } catch (error) {
          logger.warn('Failed to query TenantPayoutACH table, falling back to primary agency ACH', {
            error: error.message,
            tenantId: fileHeaderTenantId
          }, 'NACHA');
        }
        
        // Fallback: primary agency ACH
        if (!tenantACHAccount || tenantACHAccount.Status !== 'Active') {
          try {
            const primaryAgencyResult = await request.query(`
              SELECT TOP 1
                AgencyId,
                AgencyName
              FROM oe.Agencies
              WHERE TenantId = @TenantId
                AND Status = 'Active'
                AND IsPrimary = 1
              ORDER BY CreatedDate DESC
            `);
            
            if (primaryAgencyResult.recordset.length > 0 && primaryAgencyResult.recordset[0].AgencyId) {
              const primaryAgencyId = primaryAgencyResult.recordset[0].AgencyId;
              const primaryAgencyName = primaryAgencyResult.recordset[0].AgencyName;
              
              logger.info('Using primary agency ACH account for Vendor Payouts file header (fallback)', {
                tenantId: fileHeaderTenantId,
                primaryAgencyId,
                primaryAgencyName
              }, 'NACHA');
              
              tenantACHAccount = await achService.getACHAccount('Agency', primaryAgencyId, true);
            }
          } catch (error) {
            logger.warn('Failed to resolve primary agency ACH account for Vendor Payouts; will fallback to tenant ACH', {
              tenantId: fileHeaderTenantId,
              error: error.message
            }, 'NACHA');
          }
        }
      }
      
      // Agent Commission Payouts: prefer vendor TPA with commissions processing enabled, then fallback to tenant ACH.
      if (!tenantACHAccount && payoutType === 'Agent Commission Payouts') {
          const vendorTpaResult = await request.query(`
            SELECT TOP 1
              vtps.TpaAchAccountId,
              v.VendorName
            FROM oe.VendorTenantTpaServices vtps
            INNER JOIN oe.Vendors v ON vtps.VendorId = v.VendorId
            WHERE vtps.TenantId = @TenantId
              AND vtps.TpaCommissionsProcessing = 1
            ORDER BY vtps.CreatedDate DESC
          `);
          
          if (vendorTpaResult.recordset.length > 0 && vendorTpaResult.recordset[0].TpaAchAccountId) {
            const tpaAchAccountId = vendorTpaResult.recordset[0].TpaAchAccountId;
            const vendorName = vendorTpaResult.recordset[0].VendorName;
            
            logger.info('Found vendor TPA with commissions processing, using ACH account for Agent Commission Payouts file header', {
              tenantId: fileHeaderTenantId,
              vendorName,
              tpaAchAccountId
            }, 'NACHA');
            
            tenantACHAccount = await achService.getACHAccountById(tpaAchAccountId, true);
            
            if (tenantACHAccount) {
              logger.info('Using vendor TPA ACH account for Agent Commission Payouts file header', {
                tenantId: fileHeaderTenantId,
                vendorName,
                accountHolderName: tenantACHAccount.AccountHolderName,
                bankName: tenantACHAccount.BankName
              }, 'NACHA');
            }
          }
      }
      
      // Fallback: Try tenant's ACH account in oe.ACHAccounts
      if (!tenantACHAccount || tenantACHAccount.Status !== 'Active') {
        logger.info('No preferred funding ACH account found (or inactive), trying tenant ACH account', {
          tenantId: fileHeaderTenantId
        }, 'NACHA');
        
        tenantACHAccount = await achService.getACHAccount('Tenant', fileHeaderTenantId, true);
        
        // If no tenant ACH account in oe.ACHAccounts, try ProductOverrideACH as fallback (product-owner style funding)
        // Note: We allow this fallback for non-vendor payouts. Vendor Payouts should be funded by Agency/Tenant ACH.
        if (!tenantACHAccount || tenantACHAccount.Status !== 'Active') {
          if (payoutType === 'Vendor Payouts') {
            // Do NOT use ProductOverrideACH for Vendor Payouts
            tenantACHAccount = null;
          }
        }
        
        if (!tenantACHAccount || tenantACHAccount.Status !== 'Active') {
          if (payoutType === 'Vendor Payouts') {
            throw new Error(
              `Tenant (${fileHeaderTenantId}) does not have an active funding ACH account configured for Vendor Payouts. ` +
              `Please configure the tenant's primary agency ACH account (EntityType='Agency') or a tenant ACH account (EntityType='Tenant').`
            );
          }
          logger.info('No tenant ACH account in oe.ACHAccounts, checking ProductOverrideACH as fallback', {
            tenantId: fileHeaderTenantId
          }, 'NACHA');
          
          const overrideRequest = pool.request();
          overrideRequest.input('TenantId', sql.UniqueIdentifier, fileHeaderTenantId);
          
          const overrideResult = await overrideRequest.query(`
            SELECT TOP 1
              OverrideACHId,
              TenantId,
              AccountHolderName,
              BankName,
              BankAccountType,
              RoutingNumberEncrypted,
              AccountNumberEncrypted,
              IsActive,
              IsDefault
            FROM oe.ProductOverrideACH
            WHERE TenantId = @TenantId
              AND IsActive = 1
            ORDER BY IsDefault DESC, CreatedDate DESC
          `);
          
          if (overrideResult.recordset.length > 0) {
            const overrideAccount = overrideResult.recordset[0];
            
            // Decrypt routing and account numbers
            const encryptionService = require('./encryptionService');
            let routingNumber = null;
            let accountNumber = null;
            
            if (overrideAccount.RoutingNumberEncrypted) {
              try {
                routingNumber = encryptionService.decrypt(overrideAccount.RoutingNumberEncrypted);
              } catch (error) {
                logger.warn('Failed to decrypt ProductOverrideACH routing number', {
                  tenantId: fileHeaderTenantId,
                  error: error.message
                }, 'NACHA');
              }
            }
            
            if (overrideAccount.AccountNumberEncrypted) {
              try {
                accountNumber = encryptionService.decrypt(overrideAccount.AccountNumberEncrypted);
              } catch (error) {
                logger.warn('Failed to decrypt ProductOverrideACH account number', {
                  tenantId: fileHeaderTenantId,
                  error: error.message
                }, 'NACHA');
              }
            }
            
            // Calculate last 4 digits from decrypted account number
            let accountNumberLast4 = null;
            if (accountNumber && accountNumber.length >= 4) {
              accountNumberLast4 = accountNumber.slice(-4);
            }
            
            // Create tenantACHAccount object in the same format as oe.ACHAccounts
            tenantACHAccount = {
              ACHAccountId: overrideAccount.OverrideACHId,
              EntityType: 'Tenant',
              EntityId: overrideAccount.TenantId,
              AccountHolderName: overrideAccount.AccountHolderName,
              BankName: overrideAccount.BankName,
              AccountType: overrideAccount.BankAccountType,
              RoutingNumber: routingNumber,
              AccountNumber: accountNumber,
              AccountNumberLast4: accountNumberLast4,
              Status: overrideAccount.IsActive ? 'Active' : 'Inactive',
              IsDefault: overrideAccount.IsDefault === true || overrideAccount.IsDefault === 1,
              VerificationStatus: null,
              // Mark that this came from ProductOverrideACH
              _source: 'ProductOverrideACH'
            };
            
            logger.info('Using ProductOverrideACH account for tenant file header', {
              tenantId: fileHeaderTenantId,
              accountHolderName: tenantACHAccount.AccountHolderName,
              bankName: tenantACHAccount.BankName
            }, 'NACHA');
          }
        }
      }
      
      if (!tenantACHAccount || tenantACHAccount.Status !== 'Active') {
        throw new Error(
          `Tenant (${fileHeaderTenantId}) does not have an active ACH account configured for commissions processing. ` +
          `Please configure a vendor TPA service with Commissions Processing enabled, ` +
          `or configure an ACH account in oe.ACHAccounts (EntityType='Tenant') or oe.ProductOverrideACH for this tenant.`
        );
      }

      // Validate tenant ACH account has required fields
      if (!tenantACHAccount.RoutingNumber || !tenantACHAccount.AccountHolderName) {
        throw new Error(
          `Tenant ACH account is missing required information. ` +
          `Routing number and account holder name are required for NACHA file generation.`
        );
      }

      logger.info('Using tenant ACH account for file header', {
        tenantId: fileHeaderTenantId,
        accountHolderName: tenantACHAccount.AccountHolderName,
        bankName: tenantACHAccount.BankName,
        hasRoutingNumber: !!tenantACHAccount.RoutingNumber
      }, 'NACHA');

      // Generate NACHA file content (only for payouts with ACH accounts)
      let nachaFileContent;
      // IMPORTANT:
      // We intentionally prefer the in-house fixed-width formatter:
      // - It supports File Header Immediate Origin as the 10-digit Company Identification (EIN/TIN) (pos 14-23),
      // - It uses PPD as the SEC code for commission/vendor payouts (pos 51-53 of the Batch Header),
      // - It enforces 94-char records and proper control/padding.
      //
      // The node-nacha formatter is kept in the codebase for potential future use, but some banks/validators
      // require the Immediate Origin to be the Company ID (not the bank routing) and may also scrutinize ID fields.
      nachaFileContent = this.formatNACHAFile(payoutsWithACH, {
        payoutType,
        startDate,
        endDate,
        tenantACHAccount,
        companyIdentification
      });

      // Final validation: every record must be exactly 94 characters.
      // (Banks are very strict; this catches formatting regressions early.)
      const _nachaLines = String(nachaFileContent).split(/\r?\n/).filter((l) => l.length > 0);
      const _badLines = _nachaLines
        .map((line, idx) => ({ idx: idx + 1, len: line.length }))
        .filter((x) => x.len !== 94);
      if (_badLines.length > 0) {
        throw new Error(
          `Invalid NACHA output: ${_badLines.length} line(s) are not 94 characters. ` +
          _badLines.slice(0, 10).map((x) => `Line ${x.idx} len=${x.len}`).join(', ')
        );
      }

      // Save to database
      const nachaId = uuidv4();
      const fileName = this.generateFileName(payoutType, startDate, endDate);

      await this.saveNACHAGeneration({
        nachaId,
        payoutType,
        startDate,
        endDate,
        tenantId,
        userId,
        fileName,
        fileContent: nachaFileContent,
        totalAmount,
        totalPayouts,
        payoutsWithACH,
        payoutBasis: payoutBasis || (payoutType === 'Vendor Payouts' ? 'effectiveEnrollment' : 'paymentReceived')
      });

      console.log('✅ NACHA saved with totals:', {
        nachaId,
        totalPayouts,
        totalAmount
      });

      // Create payment detail records (filtered and split)
      await this.createPaymentDetails(nachaId, payoutsWithACH);

      // Phase 6e — drain payout clawbacks now that we have nachaId. Each
      // grouped payout that picked up `_payoutClawbackApplied` during the
      // netting step gets the corresponding amount drawn from FIFO clawback
      // rows and stamped with AppliedToNACHAId.
      try {
        const PayoutClawbacks = require('./payoutClawbacks.service');
        const drainPool = await getPool();
        const drainTxn = drainPool.transaction();
        await drainTxn.begin();
        try {
          for (const payout of payoutsWithACH) {
            if (!payout._payoutClawbackApplied || payout._payoutClawbackApplied <= 0) continue;
            await PayoutClawbacks.applyClawbacksToRecipient({
              tenantId: payout.tenantId || tenantId,
              payoutType: payout._payoutClawbackPayoutType,
              recipientEntityId: payout.entityId,
              amountToApply: payout._payoutClawbackApplied,
              nachaId
            }, drainTxn);
          }
          await drainTxn.commit();
        } catch (drainErr) {
          await drainTxn.rollback();
          throw drainErr;
        }
      } catch (drainErr) {
        // Non-blocking: NACHA generation already wrote oe.NACHAGenerations and
        // oe.NACHAPaymentDetails with the netted amounts. If the drain failed
        // we'll get a duplicate netting next cycle — better to log and move on
        // than to fail the whole generation.
        logger.warn('Phase 6e clawback drain failed (will retry next cycle)', { nachaId, error: drainErr.message }, 'NACHA');
      }

      logger.info('NACHA file generated', {
        nachaId,
        payoutType,
        totalPayouts,
        totalAmount,
        startDate,
        endDate
      }, 'NACHA');

      return {
        nachaId,
        fileName,
        totalPayouts,
        totalAmount,
        status: 'Pending',
        generatedDate: new Date(),
        includedPayouts: payoutsWithACH.length,
        includedAmount: payoutsWithACH.reduce((sum, p) => sum + p.amount, 0),
        excludedPayouts: excludedCount,
        excludedAmount: excludedAmount,
        excludedPayoutDetails: excludedPayouts.map(p => ({
          entityType: p.entityType,
          entityId: p.entityId,
          amount: p.amount
        })),
        warnings
      };
    } catch (error) {
      logger.error('Error generating NACHA file', {
        error: error.message,
        payoutType,
        startDate,
        endDate
      }, 'NACHA');
      throw error;
    }
  }

  /**
   * Get detailed export data for a specific entity (Agent/Agency)
   * Returns aggregated data for:
   * 1. Summary (Total Revenue, Commission, Payment Count)
   * 2. Payments (Detailed list)
   * 3. Groups (Aggregated by group)
   * 4. Individuals (Aggregated by member)
   * 5. Products (Aggregated by product/tier)
   * 
   * @param {string} entityType - 'Agent' or 'Agency'
   * @param {string} entityId - Entity ID
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @param {string} nachaId - Optional NACHA ID filter
   */
  async getExportDetails(entityType, entityId, startDate, endDate, nachaId = null) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      // Set parameters
      request.input('EntityId', sql.UniqueIdentifier, entityId);
      request.input('EntityType', sql.VarChar, entityType);
      
      if (startDate) request.input('StartDate', sql.Date, startDate);
      if (endDate) request.input('EndDate', sql.Date, endDate);
      // Always bind NACHAId
      request.input('NACHAId', sql.UniqueIdentifier, nachaId || null);

      // Filter Logic:
      // Two modes:
      //   - nachaId provided: pull rows from oe.NACHAPaymentDetails (already-sent NACHA).
      //   - preview (no nachaId): pull rows from oe.Commissions (pending dry-run).
      // In both modes we now UNION the payment-anchored spine with an invoice-anchored
      // spine so credit-funded payouts (PaymentId IS NULL, InvoiceId IS NOT NULL) show
      // up in the export. Pre-shift the query started FROM oe.Payments only and silently
      // dropped credit-funded rows.
      let paymentsQuery;
      if (nachaId) {
        paymentsQuery = `
          -- Branch 1: Payment-anchored NACHA details (existing behavior)
          SELECT DISTINCT
            p.PaymentId,
            CAST(NULL AS UNIQUEIDENTIFIER) as InvoiceId,
            p.PaymentDate,
            p.Amount as PaymentAmount,
            (SELECT SUM(Amount) FROM oe.NACHAPaymentDetails
             WHERE NACHAId = @NACHAId
               AND PaymentId = p.PaymentId
               AND RecipientEntityId = @EntityId
               AND RecipientEntityType = @EntityType) as CommissionAmount,
            CASE
              WHEN p.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN pg.Name
              WHEN m.MemberId IS NOT NULL THEN u.FirstName + ' ' + u.LastName
              ELSE 'Unknown'
            END as Name,
            CASE
              WHEN p.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN 'Group'
              WHEN m.MemberId IS NOT NULL THEN 'Individual'
              ELSE 'Unknown'
            END as Type,
            u.FirstName + ' ' + u.LastName as MemberName,
            m.MemberId,
            COALESCE(pg.Name, g.Name) as GroupName,
            COALESCE(p.GroupId, g.GroupId) as GroupId,
            m.Tier as MemberTier
          FROM oe.Payments p
          LEFT JOIN oe.Groups pg ON p.GroupId = pg.GroupId
          LEFT JOIN oe.Enrollments e ON (p.EnrollmentId IS NOT NULL AND e.EnrollmentId = p.EnrollmentId)
          LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
          INNER JOIN oe.NACHAPaymentDetails npd ON p.PaymentId = npd.PaymentId
          LEFT JOIN oe.CommissionRules cr ON npd.CommissionRuleId = cr.RuleId
          WHERE npd.NACHAId = @NACHAId
            AND npd.RecipientEntityType = @EntityType
            AND npd.RecipientEntityId = @EntityId

          UNION ALL

          -- Branch 2: Invoice-anchored credit-funded NACHA details (npd.PaymentId IS NULL).
          SELECT DISTINCT
            CAST(NULL AS UNIQUEIDENTIFIER) as PaymentId,
            inv.InvoiceId as InvoiceId,
            inv.BillingPeriodStart as PaymentDate,
            inv.TotalAmount as PaymentAmount,
            (SELECT SUM(Amount) FROM oe.NACHAPaymentDetails
             WHERE NACHAId = @NACHAId
               AND InvoiceId = inv.InvoiceId
               AND PaymentId IS NULL
               AND RecipientEntityId = @EntityId
               AND RecipientEntityType = @EntityType) as CommissionAmount,
            CASE
              WHEN inv.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN pg.Name
              WHEN m.MemberId IS NOT NULL THEN u.FirstName + ' ' + u.LastName
              ELSE 'Unknown'
            END as Name,
            CASE
              WHEN inv.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN 'Group'
              WHEN m.MemberId IS NOT NULL THEN 'Individual'
              ELSE 'Unknown'
            END as Type,
            u.FirstName + ' ' + u.LastName as MemberName,
            m.MemberId,
            COALESCE(pg.Name, g.Name) as GroupName,
            COALESCE(inv.GroupId, g.GroupId) as GroupId,
            m.Tier as MemberTier
          FROM oe.Invoices inv
          LEFT JOIN oe.Groups pg ON inv.GroupId = pg.GroupId
          LEFT JOIN oe.Members m ON (inv.HouseholdId IS NOT NULL AND m.HouseholdId = inv.HouseholdId AND m.RelationshipType = 'P')
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
          INNER JOIN oe.NACHAPaymentDetails npd ON npd.InvoiceId = inv.InvoiceId AND npd.PaymentId IS NULL
          WHERE npd.NACHAId = @NACHAId
            AND npd.RecipientEntityType = @EntityType
            AND npd.RecipientEntityId = @EntityId

          ORDER BY PaymentDate DESC
        `;
      } else {
        paymentsQuery = `
          -- Branch 1: Payment-anchored pending commissions (existing behavior)
          SELECT DISTINCT
            p.PaymentId,
            CAST(NULL AS UNIQUEIDENTIFIER) as InvoiceId,
            p.PaymentDate,
            p.Amount as PaymentAmount,
            (SELECT SUM(Amount) FROM oe.Commissions
             WHERE PaymentId = p.PaymentId
               AND Status = 'Pending'
               AND ((@EntityType = 'Agent'  AND AgentId  = @EntityId)
                 OR (@EntityType = 'Agency' AND AgencyId = @EntityId)
                 OR (@EntityType = 'Vendor' AND VendorId = @EntityId))) as CommissionAmount,
            CASE
              WHEN p.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN pg.Name
              WHEN m.MemberId IS NOT NULL THEN u.FirstName + ' ' + u.LastName
              ELSE 'Unknown'
            END as Name,
            CASE
              WHEN p.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN 'Group'
              WHEN m.MemberId IS NOT NULL THEN 'Individual'
              ELSE 'Unknown'
            END as Type,
            u.FirstName + ' ' + u.LastName as MemberName,
            m.MemberId,
            COALESCE(pg.Name, g.Name) as GroupName,
            COALESCE(p.GroupId, g.GroupId) as GroupId,
            m.Tier as MemberTier
          FROM oe.Payments p
          LEFT JOIN oe.Groups pg ON p.GroupId = pg.GroupId
          LEFT JOIN oe.Enrollments e ON (p.EnrollmentId IS NOT NULL AND e.EnrollmentId = p.EnrollmentId)
          LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
          INNER JOIN oe.Commissions c ON p.PaymentId = c.PaymentId
          WHERE c.Status = 'Pending'
            AND c.TransactionType IN ('Advance', 'Commission')
            AND ((@EntityType = 'Agent'  AND c.AgentId  = @EntityId)
              OR (@EntityType = 'Agency' AND c.AgencyId = @EntityId)
              OR (@EntityType = 'Vendor' AND c.VendorId = @EntityId))
            AND p.PaymentDate >= @StartDate AND p.PaymentDate <= @EndDate

          UNION ALL

          -- Branch 2: Invoice-anchored pending commissions (credit-funded).
          SELECT DISTINCT
            CAST(NULL AS UNIQUEIDENTIFIER) as PaymentId,
            inv.InvoiceId as InvoiceId,
            inv.BillingPeriodStart as PaymentDate,
            inv.TotalAmount as PaymentAmount,
            (SELECT SUM(Amount) FROM oe.Commissions
             WHERE InvoiceId = inv.InvoiceId
               AND PaymentId IS NULL
               AND Status = 'Pending'
               AND ((@EntityType = 'Agent'  AND AgentId  = @EntityId)
                 OR (@EntityType = 'Agency' AND AgencyId = @EntityId)
                 OR (@EntityType = 'Vendor' AND VendorId = @EntityId))) as CommissionAmount,
            CASE
              WHEN inv.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN pg.Name
              WHEN m.MemberId IS NOT NULL THEN u.FirstName + ' ' + u.LastName
              ELSE 'Unknown'
            END as Name,
            CASE
              WHEN inv.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN 'Group'
              WHEN m.MemberId IS NOT NULL THEN 'Individual'
              ELSE 'Unknown'
            END as Type,
            u.FirstName + ' ' + u.LastName as MemberName,
            m.MemberId,
            COALESCE(pg.Name, g.Name) as GroupName,
            COALESCE(inv.GroupId, g.GroupId) as GroupId,
            m.Tier as MemberTier
          FROM oe.Invoices inv
          LEFT JOIN oe.Groups pg ON inv.GroupId = pg.GroupId
          LEFT JOIN oe.Members m ON (inv.HouseholdId IS NOT NULL AND m.HouseholdId = inv.HouseholdId AND m.RelationshipType = 'P')
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
          INNER JOIN oe.Commissions c ON c.InvoiceId = inv.InvoiceId AND c.PaymentId IS NULL
          WHERE c.Status = 'Pending'
            AND c.TransactionType IN ('Advance', 'Commission')
            AND ((@EntityType = 'Agent'  AND c.AgentId  = @EntityId)
              OR (@EntityType = 'Agency' AND c.AgencyId = @EntityId)
              OR (@EntityType = 'Vendor' AND c.VendorId = @EntityId))
            AND inv.Status = N'Paid'
            AND inv.BillingPeriodStart <= @EndDate
            AND COALESCE(inv.BillingPeriodEnd, DATEADD(DAY, -1, DATEADD(MONTH, 1, inv.BillingPeriodStart))) >= @StartDate

          ORDER BY PaymentDate DESC
        `;
      }

      const paymentsResult = await request.query(paymentsQuery);

      // Deduplicate by PaymentId, falling back to InvoiceId for credit-funded rows
      // (PaymentId IS NULL when the invoice was paid from household credit, so the
      // invoice itself becomes the unique anchor). Pre-shift this used `paymentId`
      // only and silently dropped invoice-only rows via the `if (!paymentId) return`
      // guard.
      const paymentsMap = new Map();
      paymentsResult.recordset.forEach(row => {
        const paymentId = row.PaymentId ? row.PaymentId.toString() : null;
        const invoiceId = row.InvoiceId ? row.InvoiceId.toString() : null;
        const dedupKey = paymentId
          ? `payment:${paymentId.toUpperCase()}`
          : (invoiceId ? `invoice:${invoiceId.toUpperCase()}` : null);
        if (!dedupKey) return;

        if (!paymentsMap.has(dedupKey)) {
          paymentsMap.set(dedupKey, {
            paymentId: paymentId,
            invoiceId: invoiceId,
            paymentDate: row.PaymentDate,
            paymentAmount: Number(row.PaymentAmount),
            commissionAmount: Number(row.CommissionAmount),
            name: row.Name || 'Unknown',
            type: row.Type || 'Unknown',
            memberName: row.MemberName,
            memberId: row.MemberId,
            groupName: row.GroupName,
            groupId: row.GroupId,
            memberTier: row.MemberTier
          });
        }
      });
      
      const payments = Array.from(paymentsMap.values());

      const { groups, individuals, products, summary } = await this._buildExportSectionsFromPayments(pool, payments, entityType);

      return {
        summary,
        payments,
        groups,
        individuals,
        products
      };
    } catch (error) {
      logger.error('Error in getExportDetails', {
        error: error.message,
        entityType,
        entityId,
        startDate,
        endDate,
        nachaId
      }, 'NACHA');
      throw error;
    }
  }

  /**
   * Build groups, individuals, products, and summary from a payments list.
   * Shared by getExportDetails and getExportDetailsForAccountant (NACHA XLSX export logic).
   * @param {Object} pool - DB pool
   * @param {Array} payments - Array of { paymentId, paymentDate, paymentAmount, commissionAmount, name, type, memberName, memberId, groupName, groupId, memberTier }
   * @param {string} entityType - 'Agent' or 'Agency'
   * @returns {Promise<{ groups, individuals, products, summary }>}
   */
  async _buildExportSectionsFromPayments(pool, payments, entityType) {
    const request = pool.request();
    // 2. Groups Aggregation
    const groupsMap = new Map();
    payments.forEach(p => {
      if (p.type !== 'Group') return;
      const key = p.groupId ? p.groupId.toString() : null;
      if (!key) return;
      const name = p.name || p.groupName || 'Unknown Group';
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          groupId: key,
          groupName: name,
          householdCount: 0,
          totalPremium: 0,
          totalCommission: 0
        });
      }
      const group = groupsMap.get(key);
      group.totalPremium += p.paymentAmount;
      group.totalCommission += p.commissionAmount;
    });

    const groupIds = Array.from(groupsMap.keys()).filter(id => id && id !== 'INDIVIDUAL');
    if (groupIds.length > 0) {
      const groupIdsStr = groupIds.map(id => {
        const uuidStr = typeof id === 'string' ? id : id.toString();
        return `'${uuidStr.replace(/'/g, "''")}'`;
      }).join(', ');
      const breakdownQuery = `
        SELECT 
          e.GroupId,
          pr.Name as ProductName,
          COALESCE(pp.Label, m.Tier) as TierName,
          COUNT(DISTINCT m.MemberId) as HouseholdCount
        FROM oe.Enrollments e
        JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
        LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
        WHERE e.GroupId IN (${groupIdsStr})
          AND e.Status = 'Active'
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
          AND m.RelationshipType = 'P'
          AND pr.Name IS NOT NULL
          AND pr.Name != 'All Products'
        GROUP BY e.GroupId, pr.Name, COALESCE(pp.Label, m.Tier)
        ORDER BY e.GroupId, pr.Name, COALESCE(pp.Label, m.Tier)
      `;
      const breakdownResult = await request.query(breakdownQuery);
      const householdCountQuery = `
        SELECT e.GroupId, COUNT(DISTINCT m.MemberId) as HouseholdCount
        FROM oe.Enrollments e
        JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
        WHERE e.GroupId IN (${groupIdsStr})
          AND e.Status = 'Active'
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
          AND m.RelationshipType = 'P'
          AND pr.Name IS NOT NULL
          AND pr.Name != 'All Products'
        GROUP BY e.GroupId
      `;
      const householdResult = await request.query(householdCountQuery);
      householdResult.recordset.forEach(row => {
        const groupId = row.GroupId ? row.GroupId.toString() : null;
        if (groupId && groupsMap.has(groupId)) {
          groupsMap.get(groupId).householdCount = Number(row.HouseholdCount || 0);
        }
      });
      breakdownResult.recordset.forEach(row => {
        const groupId = row.GroupId ? row.GroupId.toString() : null;
        if (groupId && groupsMap.has(groupId)) {
          const group = groupsMap.get(groupId);
          if (!group.productBreakdown) group.productBreakdown = {};
          const productName = row.ProductName || 'Unknown Product';
          if (!group.productBreakdown[productName]) group.productBreakdown[productName] = {};
          group.productBreakdown[productName][row.TierName || 'Standard'] = row.HouseholdCount;
        }
      });
    }
    const allProductNames = new Set();
    Array.from(groupsMap.values()).forEach(g => {
      if (g.productBreakdown) {
        Object.keys(g.productBreakdown).forEach(productName => allProductNames.add(productName));
      }
    });
    const groups = Array.from(groupsMap.values()).map(g => {
      const productColumns = {};
      allProductNames.forEach(productName => {
        if (g.productBreakdown && g.productBreakdown[productName]) {
          productColumns[productName] = Object.entries(g.productBreakdown[productName])
            .map(([tierName, count]) => `${tierName}: ${count}`)
            .join(', ');
        } else {
          productColumns[productName] = '';
        }
      });
      return {
        ...g,
        householdCount: Number(g.householdCount || 0),
        productBreakdown: productColumns
      };
    });

    // 3. Individuals Aggregation
    const individualsMap = new Map();
    payments.forEach(p => {
      if (p.type !== 'Individual') return;
      const key = p.memberId;
      if (!key) return;
      if (!individualsMap.has(key)) {
        individualsMap.set(key, {
          memberId: key,
          memberName: p.memberName || 'Unknown',
          totalPremium: 0,
          totalCommission: 0,
          enrollments: []
        });
      }
      const ind = individualsMap.get(key);
      ind.totalPremium += p.paymentAmount;
      ind.totalCommission += p.commissionAmount;
    });
    const memberIds = Array.from(individualsMap.keys());
    if (memberIds.length > 0) {
      const memberIdsStr = memberIds.map(id => `'${(typeof id === 'string' ? id : id.toString()).replace(/'/g, "''")}'`).join(', ');
      const individualEnrollmentsQuery = `
        SELECT e.MemberId, pr.Name as ProductName, COALESCE(pp.Label, m.Tier) as TierName
        FROM oe.Enrollments e
        JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
        LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
        WHERE e.MemberId IN (${memberIdsStr})
          AND e.Status = 'Active'
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
          AND m.RelationshipType = 'P'
          AND pr.Name IS NOT NULL
          AND pr.Name != 'All Products'
        ORDER BY e.MemberId, pr.Name
      `;
      const enrollmentsResult = await request.query(individualEnrollmentsQuery);
      enrollmentsResult.recordset.forEach(row => {
        const memberId = row.MemberId ? row.MemberId.toString() : null;
        if (memberId && individualsMap.has(memberId)) {
          const ind = individualsMap.get(memberId);
          ind.enrollments.push({
            productName: row.ProductName || 'Unknown Product',
            tier: row.TierName || row.Tier || 'Standard'
          });
        }
      });
    }
    const individuals = Array.from(individualsMap.values()).map(ind => {
      const primaryTier = ind.enrollments && ind.enrollments.length > 0 ? ind.enrollments[0].tier : 'N/A';
      const productBreakdownStr = (ind.enrollments && ind.enrollments.length > 0)
        ? ind.enrollments.map(e => `${e.productName} (${e.tier})`).join('; ')
        : '';
      return {
        ...ind,
        tier: primaryTier,
        productBreakdown: productBreakdownStr,
        enrollments: ind.enrollments
      };
    });

    // 4. Products Aggregation (ProductCommissions + flat rules - same as NACHA XLSX)
    const paymentIds = payments.map(p => p.paymentId.toString()).filter(id => id);
    const productsMap = new Map();
    if (paymentIds.length > 0) {
      const paymentIdsStr = paymentIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
      const productTierStatsQuery = `
        SELECT e.ProductId as ProductId, pr.Name as ProductName, m.Tier as TierType,
          COALESCE(pp.Label, m.Tier) as TierName, COUNT(DISTINCT m.MemberId) as HouseholdCount,
          SUM(COALESCE(e.PremiumAmount, 0)) as TotalRevenue
        FROM oe.Payments p
        LEFT JOIN oe.Enrollments e ON (
          (p.EnrollmentId IS NOT NULL AND e.EnrollmentId = p.EnrollmentId)
          OR (p.GroupId IS NOT NULL AND e.GroupId = p.GroupId)
        )
        LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
        LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
        WHERE p.PaymentId IN (${paymentIdsStr})
          AND e.Status = 'Active'
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
          AND m.RelationshipType = 'P'
          AND pr.Name IS NOT NULL
          AND pr.Name != 'All Products'
        GROUP BY e.ProductId, pr.Name, m.Tier, COALESCE(pp.Label, m.Tier)
        ORDER BY pr.Name, COALESCE(pp.Label, m.Tier)
      `;
      const payoutByProduct = new Map();
      const recipientPayoutByPaymentId = new Map();
      const enrollmentFallbacks = [];
      payments.forEach(p => {
        if (p?.paymentId) recipientPayoutByPaymentId.set(p.paymentId.toString(), Number(p.commissionAmount || 0));
      });
      const paymentInfoQuery = `SELECT PaymentId, Commission, ProductCommissions, EnrollmentId, GroupId FROM oe.Payments WHERE PaymentId IN (${paymentIdsStr})`;
      const paymentInfoResult = await request.query(paymentInfoQuery);
      const productIdsSet = new Set();
      const perPaymentPools = new Map();
      paymentInfoResult.recordset.forEach(row => {
        const paymentId = row.PaymentId ? row.PaymentId.toString() : null;
        if (!paymentId) return;
        const productCommissionsRaw = row.ProductCommissions;
        if (!productCommissionsRaw) return;
        try {
          const parsed = typeof productCommissionsRaw === 'string' ? JSON.parse(productCommissionsRaw) : productCommissionsRaw;
          const pools = [];
          if (parsed && typeof parsed === 'object') {
            Object.keys(parsed).forEach(productId => {
              const pool = Number(parsed?.[productId]?.commissionAmount || 0);
              pools.push({ productId, pool });
              productIdsSet.add(productId);
            });
          }
          perPaymentPools.set(paymentId, pools);
        } catch (e) { /* ignore */ }
      });
      const productIdToName = new Map();
      if (productIdsSet.size > 0) {
        const productIdsStr = Array.from(productIdsSet).map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
        const productsResult = await request.query(`SELECT ProductId, Name FROM oe.Products WHERE ProductId IN (${productIdsStr})`);
        productsResult.recordset.forEach(r => {
          if (r.ProductId && r.Name) productIdToName.set(r.ProductId.toString(), r.Name);
        });
      }
      paymentInfoResult.recordset.forEach(row => {
        const paymentId = row.PaymentId ? row.PaymentId.toString() : null;
        if (!paymentId) return;
        const recipientPayout = Number(recipientPayoutByPaymentId.get(paymentId) || 0);
        if (!recipientPayout || recipientPayout === 0) return;
        const pools = perPaymentPools.get(paymentId) || [];
        const totalPoolFromJson = pools.reduce((sum, p) => sum + (Number(p.pool) || 0), 0);
        const totalPool = Number(row.Commission || 0) || totalPoolFromJson;
        if (pools.length > 0 && totalPool > 0) {
          pools.forEach(({ productId, pool }) => {
            const productName = productIdToName.get(String(productId)) || null;
            if (!productName || productName === 'All Products') return;
            const share = Number(pool || 0) / totalPool;
            if (!isFinite(share) || share <= 0) return;
            payoutByProduct.set(productName, (payoutByProduct.get(productName) || 0) + recipientPayout * share);
          });
          return;
        }
        if (row.EnrollmentId) {
          enrollmentFallbacks.push({
            enrollmentId: row.EnrollmentId.toString(),
            payout: recipientPayout
          });
        }
      });
      if (enrollmentFallbacks.length > 0) {
        const enrollmentIdsStr = [...new Set(enrollmentFallbacks.map(e => e.enrollmentId))].map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
        const enrollmentProductsResult = await request.query(`
          SELECT e.EnrollmentId, pr.Name as ProductName FROM oe.Enrollments e
          LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
          WHERE e.EnrollmentId IN (${enrollmentIdsStr})
        `);
        const enrollmentIdToProduct = new Map();
        enrollmentProductsResult.recordset.forEach(r => {
          if (r.EnrollmentId && r.ProductName) enrollmentIdToProduct.set(r.EnrollmentId.toString(), r.ProductName);
        });
        enrollmentFallbacks.forEach(f => {
          const productName = enrollmentIdToProduct.get(f.enrollmentId);
          if (productName && productName !== 'All Products') {
            payoutByProduct.set(productName, (payoutByProduct.get(productName) || 0) + Number(f.payout || 0));
          }
        });
      }
      const statsResult = await request.query(productTierStatsQuery);
      const tierRows = statsResult.recordset.map(r => ({
        productId: r.ProductId ? r.ProductId.toString() : null,
        productName: r.ProductName,
        tierType: r.TierType || null,
        tier: r.TierName || r.TierType || 'Standard',
        count: Number(r.HouseholdCount || 0),
        totalPremium: Number(r.TotalRevenue || 0)
      }));
      const entityTierLevel = entityType === 'Agency' ? 1 : entityType === 'Agent' ? 0 : null;
      const flatAmountByProductTier = new Map();
      const uniqueProductIds = [...new Set(tierRows.map(r => r.productId).filter(Boolean))];
      if (entityTierLevel !== null && uniqueProductIds.length > 0) {
        const productIdsSql = uniqueProductIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
        const rulesResult = await request.query(`
          SELECT RuleId, RuleName, ProductId, CommissionJson, EffectiveDate, TerminationDate, Status
          FROM oe.CommissionRules
          WHERE Status = 'Active' AND EntityType = 'Tier' AND ProductId IN (${productIdsSql})
        `);
        rulesResult.recordset.forEach(rule => {
          const productId = rule.ProductId ? rule.ProductId.toString() : null;
          if (!productId || !rule.CommissionJson) return;
          try {
            const json = typeof rule.CommissionJson === 'string' ? JSON.parse(rule.CommissionJson) : rule.CommissionJson;
            const tiers = Array.isArray(json?.tiers) ? json.tiers : [];
            const tierObj = tiers.find(t => Number(t?.level) === Number(entityTierLevel));
            const productTiers = tierObj?.productTiers || {};
            Object.keys(productTiers).forEach(tierTypeKey => {
              const flatAmount = productTiers?.[tierTypeKey]?.flatAmount;
              if (flatAmount === null || flatAmount === undefined) return;
              flatAmountByProductTier.set(`${productId}_${tierTypeKey}`, Number(flatAmount));
            });
          } catch (e) { /* ignore */ }
        });
      }
      const productTotals = new Map();
      tierRows.forEach(tr => {
        if (!productTotals.has(tr.productName)) productTotals.set(tr.productName, { revenue: 0, count: 0 });
        const t = productTotals.get(tr.productName);
        t.revenue += tr.totalPremium;
        t.count += tr.count;
      });
      tierRows.forEach(tr => {
        const productName = tr.productName;
        const tierName = tr.tier;
        const key = `${productName}_${tierName}`;
        const totals = productTotals.get(productName) || { revenue: 0, count: 0 };
        const productPayout = payoutByProduct.get(productName) || 0;
        let tierPayout = 0;
        const flatKey = tr.productId && tr.tierType ? `${tr.productId}_${tr.tierType}` : null;
        const flatAmount = flatKey ? flatAmountByProductTier.get(flatKey) : null;
        if (flatAmount !== null && flatAmount !== undefined) {
          tierPayout = Number(flatAmount) * Number(tr.count || 0);
        } else if (productPayout > 0) {
          if (totals.revenue > 0) tierPayout = productPayout * (tr.totalPremium / totals.revenue);
          else if (totals.count > 0) tierPayout = productPayout * (tr.count / totals.count);
        }
        productsMap.set(key, {
          productName,
          tier: tierName,
          count: tr.count,
          totalPremium: tr.totalPremium,
          totalCommission: Math.round(tierPayout * 100) / 100
        });
      });
    }
    const products = Array.from(productsMap.values()).sort((a, b) => {
      if (a.productName !== b.productName) return a.productName.localeCompare(b.productName);
      return (a.tier || '').localeCompare(b.tier || '');
    });
    const summary = {
      totalRevenue: payments.reduce((sum, p) => sum + p.paymentAmount, 0),
      totalCommission: payments.reduce((sum, p) => sum + p.commissionAmount, 0),
      paymentCount: payments.length
    };
    return { groups, individuals, products, summary };
  }

  /**
   * Get export details for Tenant Accounting Commission Breakdown (same shape as NACHA XLSX).
   * Uses Completed payments in date range and all non-Deleted commissions for the entity.
   * Reuses ProductCommissions + CommissionRules flat-amount logic so XLSX matches NACHA export.
   */
  async getExportDetailsForAccountant(tenantId, entityType, entityId, startDate, endDate, options = {}) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('TenantId', sql.UniqueIdentifier, tenantId);
      request.input('EntityId', sql.UniqueIdentifier, entityId);
      request.input('EntityType', sql.NVarChar(50), entityType);
      request.input('StartDate', sql.Date, startDate || null);
      request.input('EndDate', sql.Date, endDate || null);
      if (options.groupId) request.input('GroupId', sql.UniqueIdentifier, options.groupId);
      if (options.householdId) request.input('HouseholdId', sql.UniqueIdentifier, options.householdId);

      const entityCondition = entityType === 'Agent'
        ? 'c.AgentId = @EntityId AND c.AgencyId IS NULL'
        : 'c.AgencyId = @EntityId';
      const c2EntityCondition = entityType === 'Agent'
        ? 'c2.AgentId = @EntityId AND c2.AgencyId IS NULL'
        : 'c2.AgencyId = @EntityId';

      // Branch 1: payment-anchored filters (existing behavior).
      let paymentWhere = `
        AND p.TenantId = @TenantId AND p.Status = 'Completed'
        AND p.PaymentDate >= @StartDate AND p.PaymentDate < DATEADD(day, 1, @EndDate)
        AND c.Status != 'Deleted' AND c.TransactionType IN ('Advance', 'Commission')
        AND ${entityCondition}
      `;
      if (options.groupId) paymentWhere += ' AND p.GroupId = @GroupId';
      if (options.householdId) paymentWhere += ' AND p.HouseholdId = @HouseholdId';
      if (options.individuals === 'true') paymentWhere += ' AND p.GroupId IS NULL';

      // Branch 2: invoice-anchored filters (credit-funded commissions where
      // c.PaymentId IS NULL, c.InvoiceId IS NOT NULL).
      let invoiceWhere = `
        AND inv.TenantId = @TenantId AND inv.Status = N'Paid'
        AND c.Status != 'Deleted' AND c.TransactionType IN ('Advance','Commission')
        AND c.PaymentId IS NULL AND c.InvoiceId IS NOT NULL
        AND ${entityCondition}
        AND inv.BillingPeriodStart < DATEADD(day, 1, @EndDate)
        AND COALESCE(inv.BillingPeriodEnd, DATEADD(DAY, -1, DATEADD(MONTH, 1, inv.BillingPeriodStart))) >= @StartDate
      `;
      if (options.groupId) invoiceWhere += ' AND inv.GroupId = @GroupId';
      if (options.householdId) invoiceWhere += ' AND inv.HouseholdId = @HouseholdId';
      if (options.individuals === 'true') invoiceWhere += ' AND inv.GroupId IS NULL';

      const paymentsQuery = `
        -- Branch 1: payment-anchored
        SELECT DISTINCT
          p.PaymentId,
          CAST(NULL AS UNIQUEIDENTIFIER) as InvoiceId,
          p.PaymentDate,
          p.Amount as PaymentAmount,
          (SELECT SUM(Amount) FROM oe.Commissions c2 WHERE c2.PaymentId = p.PaymentId AND c2.Status != 'Deleted' AND c2.TransactionType IN ('Advance','Commission') AND (${c2EntityCondition})) as CommissionAmount,
          CASE WHEN p.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN pg.Name WHEN m.MemberId IS NOT NULL THEN u.FirstName + ' ' + u.LastName ELSE 'Unknown' END as Name,
          CASE WHEN p.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN 'Group' WHEN m.MemberId IS NOT NULL THEN 'Individual' ELSE 'Unknown' END as Type,
          u.FirstName + ' ' + u.LastName as MemberName, m.MemberId, COALESCE(pg.Name, g.Name) as GroupName, COALESCE(p.GroupId, g.GroupId) as GroupId, m.Tier as MemberTier
        FROM oe.Payments p
        INNER JOIN oe.Commissions c ON c.PaymentId = p.PaymentId AND c.Status != 'Deleted' AND c.TransactionType IN ('Advance','Commission') AND ${entityCondition}
        LEFT JOIN oe.Groups pg ON p.GroupId = pg.GroupId
        LEFT JOIN oe.Enrollments e ON (p.EnrollmentId IS NOT NULL AND e.EnrollmentId = p.EnrollmentId)
        LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        WHERE 1=1 ${paymentWhere}

        UNION ALL

        -- Branch 2: invoice-anchored (credit-funded). The "PaymentDate" surfaced for
        -- these rows is the invoice billing period start so accountant filters /
        -- date-grouping behave consistently with the payment-anchored set.
        SELECT DISTINCT
          CAST(NULL AS UNIQUEIDENTIFIER) as PaymentId,
          inv.InvoiceId as InvoiceId,
          inv.BillingPeriodStart as PaymentDate,
          inv.TotalAmount as PaymentAmount,
          (SELECT SUM(Amount) FROM oe.Commissions c2 WHERE c2.InvoiceId = inv.InvoiceId AND c2.PaymentId IS NULL AND c2.Status != 'Deleted' AND c2.TransactionType IN ('Advance','Commission') AND (${c2EntityCondition})) as CommissionAmount,
          CASE WHEN inv.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN pg.Name WHEN m.MemberId IS NOT NULL THEN u.FirstName + ' ' + u.LastName ELSE 'Unknown' END as Name,
          CASE WHEN inv.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN 'Group' WHEN m.MemberId IS NOT NULL THEN 'Individual' ELSE 'Unknown' END as Type,
          u.FirstName + ' ' + u.LastName as MemberName, m.MemberId, COALESCE(pg.Name, g.Name) as GroupName, COALESCE(inv.GroupId, g.GroupId) as GroupId, m.Tier as MemberTier
        FROM oe.Invoices inv
        INNER JOIN oe.Commissions c ON c.InvoiceId = inv.InvoiceId AND c.PaymentId IS NULL AND c.Status != 'Deleted' AND c.TransactionType IN ('Advance','Commission') AND ${entityCondition}
        LEFT JOIN oe.Groups pg ON inv.GroupId = pg.GroupId
        LEFT JOIN oe.Members m ON (inv.HouseholdId IS NOT NULL AND m.HouseholdId = inv.HouseholdId AND m.RelationshipType = 'P')
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        WHERE 1=1 ${invoiceWhere}

        ORDER BY PaymentDate DESC
      `;
      const paymentsResult = await request.query(paymentsQuery);
      const paymentsMap = new Map();
      paymentsResult.recordset.forEach(row => {
        const paymentId = row.PaymentId ? row.PaymentId.toString() : null;
        const invoiceId = row.InvoiceId ? row.InvoiceId.toString() : null;
        const dedupKey = paymentId
          ? `payment:${paymentId.toUpperCase()}`
          : (invoiceId ? `invoice:${invoiceId.toUpperCase()}` : null);
        if (!dedupKey) return;
        if (!paymentsMap.has(dedupKey)) {
          paymentsMap.set(dedupKey, {
            paymentId,
            invoiceId,
            paymentDate: row.PaymentDate,
            paymentAmount: Number(row.PaymentAmount),
            commissionAmount: Number(row.CommissionAmount),
            name: row.Name || 'Unknown',
            type: row.Type || 'Unknown',
            memberName: row.MemberName,
            memberId: row.MemberId,
            groupName: row.GroupName,
            groupId: row.GroupId,
            memberTier: row.MemberTier
          });
        }
      });
      const payments = Array.from(paymentsMap.values());
      if (payments.length === 0) {
        return {
          summary: { totalRevenue: 0, totalCommission: 0, paymentCount: 0 },
          payments: [],
          groups: [],
          individuals: [],
          products: []
        };
      }
      const { groups, individuals, products, summary } = await this._buildExportSectionsFromPayments(pool, payments, entityType);
      // IMPORTANT: Commission breakdown UI expects tier labels (e.g. ProductPricing.Label like "EE 1500").
      // _buildProductsFromCalculator currently aggregates at product-level only and defaults tier to "Standard",
      // which makes the UI tier column misleading. Use the tier-aware export aggregation for accountant breakdown.
      return { summary, payments, groups, individuals, products };
    } catch (error) {
      logger.error('Error in getExportDetailsForAccountant', {
        error: error.message,
        tenantId,
        entityType,
        entityId,
        startDate,
        endDate
      }, 'NACHA');
      throw error;
    }
  }

  /**
   * Build products array by running CommissionCalculatorService per payment (same as NACHA) and aggregating by product.
   * Ensures commission breakdown applies the same rules as the backend calculator.
   * @param {Object} pool - DB pool
   * @param {Array} payments - List from getExportDetailsForAccountant ({ paymentId, paymentAmount, commissionAmount, ... })
   * @param {string} entityType - 'Agent' or 'Agency'
   * @param {string} entityId - AgentId or AgencyId to filter to
   * @returns {Promise<Array>} products array [{ productName, tier, count, totalCommission }]
   */
  async _buildProductsFromCalculator(pool, payments, entityType, entityId) {
    if (!payments || payments.length === 0) return [];
    const paymentIds = payments.map(p => p.paymentId).filter(Boolean);
    if (paymentIds.length === 0) return [];

    const paymentIdsStr = paymentIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');

    const paymentRowsResult = await pool.request().query(`
      SELECT
        p.PaymentId,
        p.Amount,
        COALESCE(inv.Commission, p.Commission) as Commission,
        COALESCE(inv.NetRate, p.NetRate) as NetRate,
        COALESCE(inv.OverrideRate, p.OverrideRate) as OverrideRate,
        p.EnrollmentId,
        p.GroupId,
        p.HouseholdId,
        p.TenantId,
        p.PaymentDate,
        p.CreatedDate,
        COALESCE(inv.ProductCommissions, p.ProductCommissions) as ProductCommissions
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      WHERE p.PaymentId IN (${paymentIdsStr})
    `);
    const paymentRows = paymentRowsResult.recordset || [];
    if (paymentRows.length === 0) return [];

    const agentIdResult = await pool.request().query(`
      SELECT p.PaymentId,
        CASE
          WHEN p.EnrollmentId IS NOT NULL THEN (SELECT AgentId FROM oe.Enrollments WHERE EnrollmentId = p.EnrollmentId)
          WHEN p.GroupId IS NOT NULL THEN (SELECT TOP 1 e.AgentId FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = p.GroupId)
          ELSE NULL
        END AS AgentId
      FROM oe.Payments p
      WHERE p.PaymentId IN (${paymentIdsStr})
    `);
    const paymentIdToAgentId = new Map();
    (agentIdResult.recordset || []).forEach(row => {
      const pid = row.PaymentId ? row.PaymentId.toString() : null;
      const aid = row.AgentId ? row.AgentId.toString() : null;
      if (pid) paymentIdToAgentId.set(pid, aid);
    });

    const paymentsForNacha = paymentRows
      .map(row => {
        return {
          PaymentId: row.PaymentId,
          Amount: row.Amount,
          Commission: row.Commission,
          NetRate: row.NetRate,
          OverrideRate: row.OverrideRate,
          EnrollmentId: row.EnrollmentId,
          GroupId: row.GroupId,
          HouseholdId: row.HouseholdId,
          TenantId: row.TenantId,
          PaymentDate: row.PaymentDate,
          CreatedDate: row.CreatedDate,
          AgentId: paymentIdToAgentId.get(row.PaymentId ? row.PaymentId.toString() : '')
        };
      })
      .filter(p => p.AgentId);
    if (paymentsForNacha.length === 0) return [];

    let breakdown;
    try {
      breakdown = await this.calculateCommissionPayoutBreakdown(paymentsForNacha, 'Agent Commission Payouts');
    } catch (e) {
      logger.warn('_buildProductsFromCalculator: calculatePayoutBreakdown failed', { error: e.message }, 'NACHA');
      return [];
    }

    const allAgentIds = new Set();
    breakdown.forEach(item => {
      (item.calculation?.distribution?.agents || []).forEach(a => {
        if (a.agentId) allAgentIds.add(a.agentId);
      });
    });
    let agentToAgency = new Map();
    if (entityType === 'Agency' && allAgentIds.size > 0) {
      const agentIdsStr = [...allAgentIds].map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
      const agencyResult = await pool.request().query(`
        SELECT AgentId, AgencyId FROM oe.Agents WHERE AgentId IN (${agentIdsStr})
      `);
      (agencyResult.recordset || []).forEach(row => {
        const aid = row.AgentId ? row.AgentId.toString() : null;
        const agid = row.AgencyId ? row.AgencyId.toString() : null;
        if (aid) agentToAgency.set(aid, agid);
      });
    }

    const entityIdNorm = entityId ? String(entityId).toLowerCase().replace(/[{}]/g, '').trim() : '';
    const productToTotal = new Map();
    breakdown.forEach(item => {
      const agents = item.calculation?.distribution?.agents || [];
      agents.forEach(a => {
        const agentIdNorm = a.agentId ? String(a.agentId).toLowerCase().replace(/[{}]/g, '').trim() : '';
        let include = false;
        if (entityType === 'Agent') {
          include = agentIdNorm === entityIdNorm;
        } else if (entityType === 'Agency') {
          const agencyId = agentToAgency.get(a.agentId);
          const agencyIdNorm = agencyId ? String(agencyId).toLowerCase().replace(/[{}]/g, '').trim() : '';
          include = agencyIdNorm === entityIdNorm;
        }
        if (!include) return;
        const amount = Number(a.amount) || 0;
        if (amount <= 0) return;
        const productKey = (a.ruleProductId && a.ruleProductId !== '00000000-0000-0000-0000-000000000000')
          ? String(a.ruleProductId).toLowerCase().replace(/[{}]/g, '').trim()
          : 'ALL';
        productToTotal.set(productKey, (productToTotal.get(productKey) || 0) + amount);
      });
    });

    const productIds = [...productToTotal.keys()].filter(k => k !== 'ALL');
    const productIdToName = new Map();
    if (productIds.length > 0) {
      const productIdsStr = productIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
      const nameResult = await pool.request().query(`
        SELECT ProductId, Name FROM oe.Products WHERE ProductId IN (${productIdsStr})
      `);
      (nameResult.recordset || []).forEach(row => {
        const pid = row.ProductId ? row.ProductId.toString().toLowerCase().replace(/[{}]/g, '').trim() : null;
        if (pid && row.Name) productIdToName.set(pid, row.Name);
      });
    }

    const products = [];
    productToTotal.forEach((totalCommission, productKey) => {
      const productName = productKey === 'ALL' ? 'All Products' : (productIdToName.get(productKey) || productKey);
      products.push({
        productName,
        tier: 'Standard',
        count: 1,
        totalCommission: Math.round(totalCommission * 100) / 100
      });
    });
    return products.sort((a, b) => (a.productName || '').localeCompare(b.productName || ''));
  }

  /**
   * Get detailed export data for ALL entities in the current selection/NACHA
   * Used for "Export All" functionality.
   */
  async getAllExportDetails(startDate, endDate, nachaId = null, entityTypes = []) {
    try {
      console.log('🔍 getAllExportDetails called:', { startDate, endDate, nachaId, entityTypes });
      const pool = await getPool();
      const request = pool.request();
      
      // Always bind date parameters (even if null) to avoid SQL errors in preview mode
      request.input('StartDate', sql.Date, startDate || null);
      request.input('EndDate', sql.Date, endDate || null);
      
      // Ensure nachaId is treated as nullable properly
      // Note: If nachaId is 'undefined', we pass null.
      request.input('NACHAId', sql.UniqueIdentifier, nachaId || null);

      let finalQuery = '';
      
      if (nachaId) {
          finalQuery = `
            SELECT DISTINCT
              p.PaymentId,
              p.PaymentDate,
              p.Amount as PaymentAmount,
              npd.RecipientEntityType as RecipientType,
              npd.RecipientEntityId as RecipientId,
              npd.Amount as CommissionAmount,
              -- Determine if Group or Individual and get appropriate name
              CASE 
                WHEN p.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN pg.Name
                WHEN m.MemberId IS NOT NULL THEN u.FirstName + ' ' + u.LastName
                ELSE 'Unknown'
              END as Name,
              CASE 
                WHEN p.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN 'Group'
                WHEN m.MemberId IS NOT NULL THEN 'Individual'
                ELSE 'Unknown'
              END as Type,
              -- Legacy fields for backward compatibility (but we'll use Name/Type in export)
              u.FirstName + ' ' + u.LastName as MemberName,
              m.MemberId,
              COALESCE(pg.Name, g.Name) as GroupName,
              COALESCE(p.GroupId, g.GroupId) as GroupId,
              NULL as ProductName,
              NULL as RuleName,
              m.Tier as MemberTier,
              -- Resolve Recipient Names
              CASE 
                WHEN npd.RecipientEntityType = 'Agent' THEN au.FirstName + ' ' + au.LastName
                WHEN npd.RecipientEntityType = 'Agency' THEN ag.AgencyName
                WHEN npd.RecipientEntityType = 'Vendor' THEN v.VendorName
                ELSE 'Unknown'
              END as RecipientName
            FROM oe.NACHAPaymentDetails npd
            JOIN oe.Payments p ON npd.PaymentId = p.PaymentId
            -- Join to Groups directly from Payment (for group payments)
            LEFT JOIN oe.Groups pg ON p.GroupId = pg.GroupId
            -- Join through Enrollments (for individual member payments only)
            LEFT JOIN oe.Enrollments e ON (p.EnrollmentId IS NOT NULL AND e.EnrollmentId = p.EnrollmentId)
            LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
            LEFT JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            
            -- Name Resolution Joins for Recipients
            LEFT JOIN oe.Agents a ON npd.RecipientEntityType = 'Agent' AND npd.RecipientEntityId = a.AgentId
            LEFT JOIN oe.Users au ON a.UserId = au.UserId
            LEFT JOIN oe.Agencies ag ON npd.RecipientEntityType = 'Agency' AND npd.RecipientEntityId = ag.AgencyId
            LEFT JOIN oe.Vendors v ON npd.RecipientEntityType = 'Vendor' AND npd.RecipientEntityId = v.VendorId
            
            WHERE npd.NACHAId = @NACHAId
            ${entityTypes && entityTypes.length > 0 ? `AND npd.RecipientEntityType IN (${entityTypes.map(t => `'${t.replace(/'/g, "''")}'`).join(',')})` : ''}
            ORDER BY npd.RecipientEntityType, 
              CASE 
                WHEN npd.RecipientEntityType = 'Agent' THEN au.FirstName + ' ' + au.LastName
                WHEN npd.RecipientEntityType = 'Agency' THEN ag.AgencyName
                WHEN npd.RecipientEntityType = 'Vendor' THEN v.VendorName
                ELSE 'Unknown'
              END, 
              p.PaymentDate
          `;
      } else {
          // Preview Mode (Commission centric)
          // We iterate over Commissions pending
          finalQuery = `
            SELECT DISTINCT
              p.PaymentId,
              p.PaymentDate,
              p.Amount as PaymentAmount,
              CASE WHEN c.AgentId IS NOT NULL THEN 'Agent' WHEN c.AgencyId IS NOT NULL THEN 'Agency' WHEN c.VendorId IS NOT NULL THEN 'Vendor' ELSE 'Unknown' END as RecipientType,
              COALESCE(c.AgentId, c.AgencyId, c.VendorId) as RecipientId,
              c.Amount as CommissionAmount,
              -- Determine if Group or Individual and get appropriate name
              CASE 
                WHEN p.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN pg.Name
                WHEN m.MemberId IS NOT NULL THEN u.FirstName + ' ' + u.LastName
                ELSE 'Unknown'
              END as Name,
              CASE 
                WHEN p.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN 'Group'
                WHEN m.MemberId IS NOT NULL THEN 'Individual'
                ELSE 'Unknown'
              END as Type,
              -- Legacy fields
              u.FirstName + ' ' + u.LastName as MemberName,
              m.MemberId,
              COALESCE(pg.Name, g.Name) as GroupName,
              COALESCE(p.GroupId, g.GroupId) as GroupId,
              NULL as RuleName,
              m.Tier as MemberTier,
              -- Resolve Names
              CASE 
                WHEN c.AgentId IS NOT NULL THEN au.FirstName + ' ' + au.LastName
                WHEN c.AgencyId IS NOT NULL THEN ag.AgencyName
                WHEN c.VendorId IS NOT NULL THEN v.VendorName
                ELSE 'Unknown'
              END as RecipientName
            FROM oe.Commissions c
            JOIN oe.Payments p ON c.PaymentId = p.PaymentId
            -- Join to Groups directly from Payment (for group payments)
            LEFT JOIN oe.Groups pg ON p.GroupId = pg.GroupId
            -- Join through Enrollments (for individual member payments only)
            LEFT JOIN oe.Enrollments e ON (p.EnrollmentId IS NOT NULL AND e.EnrollmentId = p.EnrollmentId)
            LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
            LEFT JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            
            -- Name Resolution Joins
            LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
            LEFT JOIN oe.Users au ON a.UserId = au.UserId
            LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
            LEFT JOIN oe.Vendors v ON c.VendorId = v.VendorId
            
            WHERE c.Status = 'Pending'
              AND c.TransactionType IN ('Advance', 'Commission')
              AND p.PaymentDate >= @StartDate AND p.PaymentDate <= @EndDate
          ORDER BY 
            CASE WHEN c.AgentId IS NOT NULL THEN 'Agent' WHEN c.AgencyId IS NOT NULL THEN 'Agency' WHEN c.VendorId IS NOT NULL THEN 'Vendor' ELSE 'Unknown' END,
            CASE 
              WHEN c.AgentId IS NOT NULL THEN au.FirstName + ' ' + au.LastName
              WHEN c.AgencyId IS NOT NULL THEN ag.AgencyName
              WHEN c.VendorId IS NOT NULL THEN v.VendorName
              ELSE 'Unknown'
            END,
            p.PaymentDate
        `;
      }

      console.log('📝 Executing getAllExportDetails query with nachaId:', nachaId);
      const result = await request.query(finalQuery);
      console.log('✅ Query executed successfully, rows returned:', result.recordset.length);
      
      // Deduplicate payments by PaymentId/RecipientId combination to avoid double-counting
      const paymentsMap = new Map();
      result.recordset.forEach(row => {
        const paymentId = row.PaymentId ? row.PaymentId.toString() : null;
        const recipientId = row.RecipientId ? row.RecipientId.toString() : null;
        if (!paymentId || !recipientId) return;
        
        const key = `${paymentId}_${recipientId}`;
        
        // If we've seen this payment/recipient combination before, keep the first one
        if (!paymentsMap.has(key)) {
          paymentsMap.set(key, {
            paymentId: paymentId,
            paymentDate: row.PaymentDate,
            paymentAmount: Number(row.PaymentAmount),
            recipientType: row.RecipientType,
            recipientId: recipientId,
            recipientName: row.RecipientName,
            commissionAmount: Number(row.CommissionAmount),
            name: row.Name || 'Unknown',
            type: row.Type || 'Unknown',
            memberName: row.MemberName,
            groupName: row.GroupName,
            memberTier: row.MemberTier
          });
        }
      });
      
      const allPayments = Array.from(paymentsMap.values());

      const summaryMap = new Map();
      allPayments.forEach(p => {
          const key = `${p.recipientType}_${p.recipientId}`;
          if (!summaryMap.has(key)) {
              summaryMap.set(key, {
                  recipientName: p.recipientName,
                  recipientType: p.recipientType,
                  count: 0,
                  totalCommission: 0,
                  totalRevenue: 0
              });
          }
          const s = summaryMap.get(key);
          s.count++;
          s.totalCommission += p.commissionAmount;
          s.totalRevenue += p.paymentAmount;
      });
      
      return {
          summary: Array.from(summaryMap.values()),
          payments: allPayments
      };
    } catch (error) {
      console.error('❌ Error in getAllExportDetails:', error);
      console.error('❌ Error stack:', error.stack);
      logger.error('Error in getAllExportDetails', {
        error: error.message,
        stack: error.stack,
        startDate,
        endDate,
        nachaId,
        entityTypes
      }, 'NACHA');
      throw error;
    }
  }

  /**
   * Validate no overlapping NACHA exists for date range
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @param {string} payoutType - Payout type
   * @param {string} tenantId - Tenant ID (optional)
   * @returns {Promise<Object|null>} Overlap record if found, otherwise null
   */
  async validateNoOverlap(startDate, endDate, payoutType, tenantId = null) {
    const pool = await getPool();
    const request = pool.request();

    // Use DateTime2 to preserve time component
    request.input('StartDate', sql.DateTime2, startDate);
    request.input('EndDate', sql.DateTime2, endDate);
    request.input('PayoutType', sql.NVarChar, payoutType);
    if (tenantId) {
      request.input('TenantId', sql.UniqueIdentifier, tenantId);
    }

    const result = await request.query(`
      EXEC oe.sp_CheckNACHADateOverlap 
        @StartDate = @StartDate,
        @EndDate = @EndDate,
        @PayoutType = @PayoutType,
        @TenantId = ${tenantId ? '@TenantId' : 'NULL'},
        @ExcludeNACHAId = NULL
    `);

    if (result.recordset.length > 0) {
      return result.recordset[0];
    }
    return null;
  }

  /**
   * Get unpaid payments in date range
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @param {string} tenantId - Tenant ID filter (optional)
   * @param {string} payoutBasis - 'effectiveEnrollment' (BillingPeriod) or 'paymentReceived' (PaymentDate)
   * @param {string|null} payoutTypeForSource - When 'Vendor Payouts', sources are Paid oe.Invoices only (invoice-anchored; PaymentId NULL).
   * @returns {Promise<Array>} Array of payment records
   */
  async getUnpaidPayments(startDate, endDate, tenantId = null, payoutBasis = 'effectiveEnrollment', payoutTypeForSource = null) {
    console.log('🔍 getUnpaidPayments called:', { startDate, endDate, tenantId, payoutBasis, payoutTypeForSource });
    const pool = await getPool();
    const request = pool.request();

    // Use DateTime2 to preserve time component for accurate comparisons
    // Dates should already be in UTC with startDate at 00:00:00.000 and endDate at 23:59:59.999
    request.input('StartDate', sql.DateTime2, startDate);
    request.input('EndDate', sql.DateTime2, endDate);

    let tenantFilter = '';
    if (tenantId) {
      request.input('TenantId', sql.UniqueIdentifier, tenantId);
      tenantFilter = 'AND p.TenantId = @TenantId';
    }

    console.log('📊 Executing SQL query for unpaid payments...');
    let result;
    try {
      // Tenant filter for invoice-anchored branches references inv directly.
      const invTenantFilter = tenantId ? 'AND inv.TenantId = @TenantId' : '';
      // Synthetic PaymentDate on invoice-anchored rows: billing-period start for
      // effectiveEnrollment runs; fulfillment signal for paymentReceived.
      const creditSyntheticPaymentDateSql =
        payoutBasis === 'paymentReceived'
          ? 'COALESCE(inv.PaymentReceivedDate, inv.ModifiedDate, inv.BillingPeriodStart)'
          : 'inv.BillingPeriodStart';

      const vendorInvoicesOnlySql = `
        -- Vendor Payouts: invoice-anchored only (one logical source row per Paid invoice).
        -- Avoids per-Payment double-count when multiple Completed Payments hit the same invoice.
        SELECT
          CAST(NULL AS UNIQUEIDENTIFIER) as PaymentId,
          inv.InvoiceId,
          '${FUNDING_SOURCE.CREDIT}' as FundingSource,
          inv.TotalAmount as Amount,
          ${creditSyntheticPaymentDateSql} as PaymentDate,
          inv.ProductCommissions,
          inv.ProductVendorAmounts,
          inv.ProductOwnerAmounts,
          CAST(NULL AS UNIQUEIDENTIFIER) as EnrollmentId,
          inv.HouseholdId,
          inv.GroupId,
          CAST(NULL AS UNIQUEIDENTIFIER) as AgentId,
          inv.TenantId,
          CAST(NULL AS UNIQUEIDENTIFIER) as MemberId,
          ISNULL(inv.Commission, 0) as Commission,
          0 as CommissionPaid,
          ISNULL(inv.OverrideRate, 0) as OverrideRate,
          0 as OverridePaid,
          ISNULL(inv.NetRate, 0) as NetRate,
          ISNULL(inv.SystemFees, 0) as SystemFees,
          0 as VendorCommissionPaid,
          (SELECT TOP 1 pr3.ProductOwnerId
           FROM oe.Enrollments e3
           INNER JOIN oe.Products pr3 ON e3.ProductId = pr3.ProductId
           WHERE (
              (inv.HouseholdId IS NOT NULL AND e3.HouseholdId = inv.HouseholdId)
              OR (inv.GroupId IS NOT NULL AND EXISTS (
                  SELECT 1 FROM oe.Members m3 WHERE m3.MemberId = e3.MemberId AND m3.GroupId = inv.GroupId))
             )
             AND e3.Status = 'Active'
             AND e3.EffectiveDate <= inv.BillingPeriodEnd
             AND (e3.TerminationDate IS NULL OR e3.TerminationDate > inv.BillingPeriodStart)
           ORDER BY e3.CreatedDate ASC) as ProductOwnerId
        FROM oe.Invoices inv
        WHERE inv.Status = N'Paid'
          AND ${invoicePayoutWindowSql({ payoutBasis })}
          ${invTenantFilter}
        ORDER BY PaymentDate ASC
      `;

      const paymentPlusCreditUnionSql = `
        -- Branch 1: Payment-anchored (Product Owner Payouts and legacy flows).
        SELECT
          p.PaymentId,
          COALESCE(p.InvoiceId, inv.InvoiceId) as InvoiceId,
          '${FUNDING_SOURCE.PAYMENT}' as FundingSource,
          p.Amount,
          p.PaymentDate,
          COALESCE(inv.ProductCommissions, p.ProductCommissions) as ProductCommissions,
          COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts) as ProductVendorAmounts,
          COALESCE(inv.ProductOwnerAmounts, p.ProductOwnerAmounts) as ProductOwnerAmounts,
          p.EnrollmentId,
          p.HouseholdId,
          p.GroupId,
          p.AgentId,
          p.TenantId,
          e.MemberId,
          ISNULL(COALESCE(inv.Commission, p.Commission), 0) as Commission,
          ISNULL(p.CommissionPaid, 0) as CommissionPaid,
          ISNULL(COALESCE(inv.OverrideRate, p.OverrideRate), 0) as OverrideRate,
          ISNULL(p.OverridePaid, 0) as OverridePaid,
          ISNULL(COALESCE(inv.NetRate, p.NetRate), 0) as NetRate,
          ISNULL(COALESCE(inv.SystemFees, p.SystemFees), 0) as SystemFees,
          ISNULL(p.VendorCommissionPaid, 0) as VendorCommissionPaid,
          COALESCE(
            pr.ProductOwnerId,
            (SELECT TOP 1 pr2.ProductOwnerId
             FROM oe.Enrollments e2
             INNER JOIN oe.Members m2 ON e2.MemberId = m2.MemberId
             INNER JOIN oe.Products pr2 ON e2.ProductId = pr2.ProductId
             WHERE m2.GroupId = p.GroupId
               AND e2.Status = 'Active'
               AND e2.EffectiveDate <= COALESCE(inv.BillingPeriodEnd, p.PaymentDate)
               AND (e2.TerminationDate IS NULL OR e2.TerminationDate > COALESCE(inv.BillingPeriodStart, p.PaymentDate))
             ORDER BY e2.CreatedDate ASC)
          ) as ProductOwnerId
        FROM oe.Payments p
        LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
        LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
        LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
        WHERE p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
          AND ${paymentInWindowSql({ payoutBasis })}
          AND ${fundingGateSql()}
          ${tenantFilter}

        UNION ALL

        -- Branch 2: Invoice settled with no Completed oe.Payments row (credit / write-off).
        SELECT
          CAST(NULL AS UNIQUEIDENTIFIER) as PaymentId,
          inv.InvoiceId,
          '${FUNDING_SOURCE.CREDIT}' as FundingSource,
          inv.TotalAmount as Amount,
          ${creditSyntheticPaymentDateSql} as PaymentDate,
          inv.ProductCommissions,
          inv.ProductVendorAmounts,
          inv.ProductOwnerAmounts,
          CAST(NULL AS UNIQUEIDENTIFIER) as EnrollmentId,
          inv.HouseholdId,
          inv.GroupId,
          CAST(NULL AS UNIQUEIDENTIFIER) as AgentId,
          inv.TenantId,
          CAST(NULL AS UNIQUEIDENTIFIER) as MemberId,
          ISNULL(inv.Commission, 0) as Commission,
          0 as CommissionPaid,
          ISNULL(inv.OverrideRate, 0) as OverrideRate,
          0 as OverridePaid,
          ISNULL(inv.NetRate, 0) as NetRate,
          ISNULL(inv.SystemFees, 0) as SystemFees,
          0 as VendorCommissionPaid,
          (SELECT TOP 1 pr3.ProductOwnerId
           FROM oe.Enrollments e3
           INNER JOIN oe.Products pr3 ON e3.ProductId = pr3.ProductId
           WHERE (
              (inv.HouseholdId IS NOT NULL AND e3.HouseholdId = inv.HouseholdId)
              OR (inv.GroupId IS NOT NULL AND EXISTS (
                  SELECT 1 FROM oe.Members m3 WHERE m3.MemberId = e3.MemberId AND m3.GroupId = inv.GroupId))
             )
             AND e3.Status = 'Active'
             AND e3.EffectiveDate <= inv.BillingPeriodEnd
             AND (e3.TerminationDate IS NULL OR e3.TerminationDate > inv.BillingPeriodStart)
           ORDER BY e3.CreatedDate ASC) as ProductOwnerId
        FROM oe.Invoices inv
        WHERE inv.Status = N'Paid'
          AND ${invoicePayoutWindowSql({ payoutBasis })}
          AND NOT EXISTS (
            SELECT 1 FROM oe.Payments p2
            WHERE p2.InvoiceId = inv.InvoiceId
              AND p2.Status IN ${PAID_PAYMENT_STATUSES_SQL}
          )
          ${invTenantFilter}

        ORDER BY PaymentDate ASC
      `;

      result = await request.query(
        payoutTypeForSource === 'Vendor Payouts' ? vendorInvoicesOnlySql : paymentPlusCreditUnionSql
      );
      console.log('✅ SQL query completed, records:', result.recordset.length);
    } catch (sqlError) {
      console.error('❌ SQL query error:', sqlError);
      throw sqlError;
    }

    logger.info('getUnpaidPayments query result', {
      count: result.recordset.length,
      startDate,
      endDate,
      tenantFilter: !!tenantId
    }, 'NACHA');

    // Funding-gate shadow log: count how many payments in the same date window
    // were blocked because their linked invoice is not yet Paid. This lets ops
    // monitor whether fulfillment lag is affecting payout throughput.
    try {
      const heldReq = pool.request();
      heldReq.input('StartDate', sql.DateTime2, startDate);
      heldReq.input('EndDate', sql.DateTime2, endDate);
      if (tenantId) heldReq.input('TenantId', sql.UniqueIdentifier, tenantId);
      const heldResult = await heldReq.query(`
        SELECT COUNT(*) AS HeldCount
        FROM oe.Payments p
        LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
        WHERE p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
          AND ${paymentInWindowSql({ payoutBasis })}
          AND p.InvoiceId IS NOT NULL
          AND (inv.Status IS NULL OR inv.Status <> N'Paid')
          ${tenantFilter}
      `);
      const heldCount = heldResult.recordset[0]?.HeldCount || 0;
      if (heldCount > 0) {
        logger.info('getUnpaidPayments funding gate held payments', {
          heldCount,
          startDate,
          endDate,
          tenantFilter: !!tenantId
        }, 'NACHA');
      }
    } catch (heldErr) {
      console.warn('[getUnpaidPayments] funding-gate held-count query failed (non-blocking):', heldErr.message);
    }

    return result.recordset;
  }

  /**
   * Calculate payout breakdown for payments
   * @param {Array} payments - Array of payment records
   * @param {string} payoutType - Payout type filter
   * @returns {Promise<Array>} Payout breakdown
   */
  async calculateVendorPayoutBreakdown(payments) {
    return this.calculatePayoutBreakdownInternal(payments, 'Vendor Payouts');
  }

  async calculateCommissionPayoutBreakdown(payments, payoutType) {
    return this.calculatePayoutBreakdownInternal(payments, payoutType);
  }

  async calculatePayoutBreakdownInternal(payments, payoutType) {
    const breakdown = [];
    const paymentsWithDetail = [];
    const productToVendorCache = new Map(); // ProductId -> VendorId

    const poolForPaidBatch = await getPool();
    /** @type {Map<string, Map<string, number>>} */
    const invoicePaidAggregates = new Map();
    if (payoutType === 'Vendor Payouts' && payments.length > 0) {
      const invoiceIdSet = new Set();
      for (const p of payments) {
        if (p.InvoiceId) invoiceIdSet.add(String(p.InvoiceId).toUpperCase());
      }
      const invoiceIds = [...invoiceIdSet];
      if (invoiceIds.length > 0) {
        const invoiceIdsStr = invoiceIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
        const batchRes = await poolForPaidBatch.request().query(`
          SELECT
            COALESCE(npd.InvoiceId, p.InvoiceId) AS ResolvedInvoiceId,
            npd.RecipientEntityType,
            npd.RecipientEntityId,
            SUM(npd.Amount) AS PaidAmount
          FROM oe.NACHAPaymentDetails npd
          LEFT JOIN oe.Payments p ON p.PaymentId = npd.PaymentId
          INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
          WHERE ng.Status = N'Sent'
            AND COALESCE(npd.InvoiceId, p.InvoiceId) IN (${invoiceIdsStr})
          GROUP BY COALESCE(npd.InvoiceId, p.InvoiceId), npd.RecipientEntityType, npd.RecipientEntityId
        `);
        for (const row of batchRes.recordset || []) {
          if (!row.ResolvedInvoiceId) continue;
          const invKey = String(row.ResolvedInvoiceId).toUpperCase();
          if (!invoicePaidAggregates.has(invKey)) {
            invoicePaidAggregates.set(invKey, new Map());
          }
          const sub = invoicePaidAggregates.get(invKey);
          const rkey = `${row.RecipientEntityType}_${row.RecipientEntityId}`.toUpperCase();
          sub.set(rkey, (sub.get(rkey) || 0) + Number(row.PaidAmount));
        }
      }
    }

    console.log('📋 calculatePayoutBreakdown called with', {
      paymentCount: payments.length,
      payoutType,
      paymentIds: payments.map(p => p.PaymentId)
    });

    for (const payment of payments) {
      try {
        console.log('🔄 Processing payment:', {
          paymentId: payment.PaymentId,
          enrollmentId: payment.EnrollmentId,
          householdId: payment.HouseholdId,
          groupId: payment.GroupId,
          amount: payment.Amount
        });
        
        const pool = await getPool();

        // Get agent ID from enrollment if not in payment
        let agentId = payment.AgentId;
        if (!agentId && payment.EnrollmentId) {
          const enrollRequest = pool.request();
          enrollRequest.input('EnrollmentId', sql.UniqueIdentifier, payment.EnrollmentId);
          const enrollResult = await enrollRequest.query(`
            SELECT AgentId FROM oe.Enrollments WHERE EnrollmentId = @EnrollmentId
          `);
          if (enrollResult.recordset.length > 0) {
            agentId = enrollResult.recordset[0].AgentId;
          }
        }

        // For Agent Commission Payouts, we need an agentId
        // For Vendor/Product Owner payouts, agentId is optional (we can use a placeholder)
        if (!agentId && payoutType === 'Agent Commission Payouts') {
          logger.info('Skipping payment - no agent (required for Agent Commission Payouts)', {
            paymentId: payment.PaymentId
          }, 'NACHA');
          continue; // Skip payments without agents for Agent Commission Payouts
        }
        
        // For Vendor/Product Owner payouts, use a placeholder agentId if missing
        // The commission calculation will still work and return vendor/tenant distributions
        if (!agentId && (payoutType === 'Vendor Payouts' || payoutType === 'Product Owner Payouts')) {
          agentId = '00000000-0000-0000-0000-000000000000'; // Placeholder - won't be used for vendor/tenant calculations
          logger.info('Using placeholder agentId for Vendor/Product Owner payout calculation', {
            paymentId: payment.PaymentId
          }, 'NACHA');
        }

        // NOTE: Payments may include multiple products (especially group payments). Do not rely on a single
        // ProductId on the payment record. For Vendor/Product Owner payouts we trust snapshot JSON on oe.Payments.

        // Credit-funded rows have no oe.Payments row to re-query and no PaymentId
        // to dedup against. Their JSON breakdowns + scope already came from the
        // invoice on the recordset row, so we skip the re-query and dedup by
        // InvoiceId on the NACHAPaymentDetails ledger instead.
        const isCreditFunded = payment.FundingSource === FUNDING_SOURCE.CREDIT
          || (!payment.PaymentId && payment.InvoiceId);

        // Check previously paid amounts to calculate remaining balance
        // (Sent NACHAs only). Vendor Payouts: one batched query per preview batch.
        /** @type {Map<string, number>} */
        let paidAmounts;
        if (payoutType === 'Vendor Payouts' && payment.InvoiceId) {
          const invKey = String(payment.InvoiceId).toUpperCase();
          paidAmounts = invoicePaidAggregates.has(invKey)
            ? new Map(invoicePaidAggregates.get(invKey))
            : new Map();
        } else {
          const paidRequest = pool.request();
          let paidResult;
          if (isCreditFunded) {
            paidRequest.input('InvoiceId', sql.UniqueIdentifier, payment.InvoiceId);
            paidResult = await paidRequest.query(`
              SELECT npd.RecipientEntityType, npd.RecipientEntityId, SUM(npd.Amount) as PaidAmount
              FROM oe.NACHAPaymentDetails npd
              INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
              WHERE npd.InvoiceId = @InvoiceId
                AND ng.Status = 'Sent'
              GROUP BY npd.RecipientEntityType, npd.RecipientEntityId
            `);
          } else {
            paidRequest.input('PaymentId', sql.UniqueIdentifier, payment.PaymentId);
            paidResult = await paidRequest.query(`
              SELECT npd.RecipientEntityType, npd.RecipientEntityId, SUM(npd.Amount) as PaidAmount
              FROM oe.NACHAPaymentDetails npd
              INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
              WHERE npd.PaymentId = @PaymentId
                AND ng.Status = 'Sent'
              GROUP BY npd.RecipientEntityType, npd.RecipientEntityId
            `);
          }
          paidAmounts = new Map();
          for (const row of paidResult.recordset) {
            const key = `${row.RecipientEntityType}_${row.RecipientEntityId}`.toUpperCase();
            paidAmounts.set(key, (paidAmounts.get(key) || 0) + Number(row.PaidAmount));
          }
        }

        // Resolve household/group/enrollment scope and JSON breakdowns. Credit-
        // funded rows already carry these on the recordset row (sourced from the
        // invoice), so we skip the oe.Payments re-query for them.
        let householdId, groupId, paymentEnrollmentId;
        let paymentProductCommissions, paymentProductVendorAmounts, paymentProductOwnerAmounts;

        if (isCreditFunded) {
          householdId = payment.HouseholdId || null;
          groupId = payment.GroupId || null;
          paymentEnrollmentId = payment.EnrollmentId || null;
          paymentProductCommissions = payment.ProductCommissions || null;
          paymentProductVendorAmounts = payment.ProductVendorAmounts || null;
          paymentProductOwnerAmounts = payment.ProductOwnerAmounts || null;
        } else {
          // Get enrollment product IDs and commission amounts per product for this payment.
          // Invoice-anchored payouts: prefer the invoice's snapshot JSON (current source
          // of truth) and fall back to the payment's snapshot for legacy rows. Same
          // COALESCE pattern used by the preview SQL in nacha.js so payment-funded rows
          // still see the up-to-date breakdown when invoices were resnapshotted post-payment.
          const paymentRequest = pool.request();
          paymentRequest.input('PaymentId', sql.UniqueIdentifier, payment.PaymentId);
          const paymentDetails = await paymentRequest.query(`
            SELECT
              p.HouseholdId,
              p.GroupId,
              p.EnrollmentId,
              COALESCE(inv.ProductCommissions,   p.ProductCommissions)   AS ProductCommissions,
              COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts) AS ProductVendorAmounts,
              COALESCE(inv.ProductOwnerAmounts,  p.ProductOwnerAmounts)  AS ProductOwnerAmounts
            FROM oe.Payments p
            LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
            WHERE p.PaymentId = @PaymentId
          `);
          const paymentDetail = paymentDetails.recordset[0] || {};
          householdId = paymentDetail.HouseholdId || null;
          groupId = paymentDetail.GroupId || null;
          paymentEnrollmentId = paymentDetail.EnrollmentId || null;
          paymentProductCommissions = paymentDetail.ProductCommissions || null;
          paymentProductVendorAmounts = paymentDetail.ProductVendorAmounts || null;
          paymentProductOwnerAmounts = paymentDetail.ProductOwnerAmounts || null;
        }
        
        logger.info('Read payment JSON columns', {
          paymentId: payment.PaymentId,
          hasProductCommissions: !!paymentProductCommissions,
          hasProductVendorAmounts: !!paymentProductVendorAmounts,
          hasProductOwnerAmounts: !!paymentProductOwnerAmounts,
          productVendorAmountsLength: paymentProductVendorAmounts ? paymentProductVendorAmounts.length : 0,
          productOwnerAmountsLength: paymentProductOwnerAmounts ? paymentProductOwnerAmounts.length : 0
        }, 'NACHA');
        
        // Get enrollments linked to this payment (via EnrollmentId, HouseholdId, or GroupId)
        const enrollmentRequest = pool.request();
        if (payment.PaymentId) {
          enrollmentRequest.input('PaymentId', sql.UniqueIdentifier, payment.PaymentId);
        }
        if (paymentEnrollmentId) {
          enrollmentRequest.input('EnrollmentId', sql.UniqueIdentifier, paymentEnrollmentId);
        }
        if (householdId) {
          enrollmentRequest.input('HouseholdId', sql.UniqueIdentifier, householdId);
        }
        if (groupId) {
          enrollmentRequest.input('GroupId', sql.UniqueIdentifier, groupId);
        }
        
        // Build WHERE conditions
        let whereConditions = [];
        if (paymentEnrollmentId) {
          whereConditions.push('e.EnrollmentId = @EnrollmentId');
        }
        if (householdId) {
          whereConditions.push('e.HouseholdId = @HouseholdId');
        }
        if (groupId) {
          whereConditions.push('m.GroupId = @GroupId');
        }
        
        let enrollmentProductIds = [];
        let commissionByProduct = new Map();
        let productTier = null; // Product tier (EE, ES, EC, EF) from member's Tier field
        
        // Only query if we have at least one identifier
        if (whereConditions.length > 0) {
          const enrollmentQuery = `
            SELECT DISTINCT
              e.ProductId,
              e.Commission,
              m.Tier
            FROM oe.Enrollments e
            LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE e.Status = 'Active'
              AND e.Commission IS NOT NULL
              AND (${whereConditions.join(' OR ')})
          `;
          
          const enrollmentResult = await enrollmentRequest.query(enrollmentQuery);
          
          // Extract enrollment product IDs (filter out placeholder "All Products" GUID)
          enrollmentProductIds = enrollmentResult.recordset
            .map(row => row.ProductId?.toString())
            .filter(pid => pid && pid !== '00000000-0000-0000-0000-000000000000');
          
          // Get commission amounts per product
          commissionByProduct = enrollmentResult.recordset.reduce((acc, row) => {
            const productId = row.ProductId?.toString();
            if (productId && productId !== '00000000-0000-0000-0000-000000000000') {
              const current = acc.get(productId) || 0;
              acc.set(productId, current + (parseFloat(row.Commission) || 0));
            }
            return acc;
          }, new Map());
          
          // Get product tier from first enrollment's member (for tier-specific commission amounts)
          if (enrollmentResult.recordset.length > 0 && enrollmentResult.recordset[0].Tier) {
            productTier = enrollmentResult.recordset[0].Tier; // EE, ES, EC, or EF
          }
        }

        // Read ProductCommissions JSON from payment to get enrollment counts AND commission amounts per product
        // This is the source of truth for commission amounts per product, calculated at payment time
        let productEnrollmentCounts = new Map(); // Map<ProductId, enrolledHouseholdsCount>
        if (paymentProductCommissions) {
          try {
            const productCommissions = typeof paymentProductCommissions === 'string'
              ? JSON.parse(paymentProductCommissions)
              : paymentProductCommissions;
            
            // Handle both object and array formats
            let productCommissionsObj = productCommissions;
            if (Array.isArray(productCommissions)) {
              productCommissionsObj = {};
              for (const item of productCommissions) {
                if (item && item.ProductId) {
                  productCommissionsObj[item.ProductId.toString().toUpperCase()] = {
                    enrolledHouseholdsCount: item.EnrolledHouseholdsCount !== undefined ? item.EnrolledHouseholdsCount : 0,
                    commissionAmount: parseFloat(item.CommissionAmount) || 0
                  };
                }
              }
            }
            
            for (const [productIdStr, data] of Object.entries(productCommissionsObj)) {
              if (data && typeof data === 'object') {
                // Store enrolled households count - support both naming conventions
                const householdsCount = data.enrolledHouseholdsCount !== undefined
                  ? (data.enrolledHouseholdsCount || 0)
                  : (data.enrollmentCount !== undefined ? (data.enrollmentCount || 0) : 0);

                if (householdsCount > 0) {
                  if (householdsCount > 0) {
                    productEnrollmentCounts.set(productIdStr.toUpperCase(), householdsCount);
                  }
                }
                // Override commissionByProduct with commissionAmount from JSON (source of truth)
                if (data.commissionAmount !== undefined && data.commissionAmount > 0) {
                  commissionByProduct.set(productIdStr.toUpperCase(), parseFloat(data.commissionAmount) || 0);
                }
              }
            }
            logger.info('Read ProductCommissions from payment', {
              paymentId: payment.PaymentId,
              productEnrollmentCounts: Object.fromEntries(productEnrollmentCounts),
              commissionByProduct: Object.fromEntries(commissionByProduct)
            }, 'NACHA');
            console.log('✅ Updated commissionByProduct from ProductCommissions JSON:', {
              paymentId: payment.PaymentId,
              commissionByProduct: Object.fromEntries(commissionByProduct)
            });
          } catch (e) {
            logger.warn('Could not parse ProductCommissions JSON from payment', {
              paymentId: payment.PaymentId,
              error: e.message
            }, 'NACHA');
          }
        }

        // Read ProductVendorAmounts and ProductOwnerAmounts JSON from payment
        // Store per-product vendor amounts for splitting vendor payouts by product
        let productVendorAmountsMap = new Map(); // Map<ProductId, {vendorAmount, enrolledHouseholdsCount}>
        let productOwnerAmountsMap = new Map(); // Map<ProductId, {overrideAmount, enrolledHouseholdsCount}>
        let totalVendorAmount = null; // null means JSON wasn't found/parsed, 0+ means parsed successfully
        let totalOverrideAmount = null;
        let hasVendorAmountsJSON = false;
        let hasOwnerAmountsJSON = false;
        
        if (paymentProductVendorAmounts) {
          console.log('🔍 Found ProductVendorAmounts JSON for payment:', payment.PaymentId);
          try {
            let productVendorAmounts = typeof paymentProductVendorAmounts === 'string'
              ? JSON.parse(paymentProductVendorAmounts)
              : paymentProductVendorAmounts;
            
            // Handle both object and array formats
            if (Array.isArray(productVendorAmounts)) {
              const vendorAmountsObj = {};
              for (const item of productVendorAmounts) {
                if (item && item.ProductId) {
                  vendorAmountsObj[item.ProductId.toString().toUpperCase()] = {
                    enrolledHouseholdsCount: item.EnrolledHouseholdsCount !== undefined ? item.EnrolledHouseholdsCount : 0,
                    vendorAmount: parseFloat(item.VendorAmount) || 0
                  };
                }
              }
              productVendorAmounts = vendorAmountsObj;
            }
            
            // Store per-product vendor amounts AND sum total
            totalVendorAmount = 0; // Initialize to 0 if JSON was successfully parsed
            hasVendorAmountsJSON = true; // Mark that we successfully parsed JSON
            for (const [productIdStr, data] of Object.entries(productVendorAmounts)) {
              if (data && typeof data === 'object' && data.vendorAmount) {
                const vendorAmount = parseFloat(data.vendorAmount) || 0;
                // Handle both naming conventions
                const householdsCount = data.enrolledHouseholdsCount !== undefined 
                  ? data.enrolledHouseholdsCount 
                  : (data.enrollmentCount !== undefined ? data.enrollmentCount : 0);
                  
                if (householdsCount === 0) {
                  logger.warn('Missing or zero enrolledHouseholdsCount in ProductVendorAmounts JSON', {
                    paymentId: payment.PaymentId,
                    productId: productIdStr,
                    data
                  }, 'NACHA');
                }
                
                productVendorAmountsMap.set(productIdStr.toUpperCase(), {
                  vendorAmount,
                  enrolledHouseholdsCount: householdsCount
                });
                totalVendorAmount += vendorAmount;
              }
            }
            console.log('✅ Read ProductVendorAmounts from payment:', {
              paymentId: payment.PaymentId,
              totalVendorAmount,
              productCount: Object.keys(productVendorAmounts).length,
              productVendorAmounts: Object.fromEntries(productVendorAmountsMap)
            });
            logger.info('Read ProductVendorAmounts from payment', {
              paymentId: payment.PaymentId,
              totalVendorAmount,
              productCount: Object.keys(productVendorAmounts).length,
              productVendorAmounts: Object.fromEntries(productVendorAmountsMap)
            }, 'NACHA');
          } catch (e) {
            logger.warn('Could not parse ProductVendorAmounts JSON from payment', {
              paymentId: payment.PaymentId,
              error: e.message
            }, 'NACHA');
          }
        }

        if (paymentProductOwnerAmounts) {
          console.log('🔍 Found ProductOwnerAmounts JSON for payment:', payment.PaymentId);
          try {
            let productOwnerAmounts = typeof paymentProductOwnerAmounts === 'string'
              ? JSON.parse(paymentProductOwnerAmounts)
              : paymentProductOwnerAmounts;
            
            // Handle both object and array formats
            if (Array.isArray(productOwnerAmounts)) {
              const ownerAmountsObj = {};
              for (const item of productOwnerAmounts) {
                if (item && item.ProductId) {
                  ownerAmountsObj[item.ProductId.toString().toUpperCase()] = {
                    enrolledHouseholdsCount: item.EnrolledHouseholdsCount !== undefined ? item.EnrolledHouseholdsCount : 0,
                    overrideAmount: parseFloat(item.OverrideAmount) || 0
                  };
                }
              }
              productOwnerAmounts = ownerAmountsObj;
            }
            
            // Store per-product override amounts AND sum total
            totalOverrideAmount = 0; // Initialize to 0 if JSON was successfully parsed
            hasOwnerAmountsJSON = true; // Mark that we successfully parsed JSON
            for (const [productIdStr, data] of Object.entries(productOwnerAmounts)) {
              if (data && typeof data === 'object' && data.overrideAmount) {
                const overrideAmount = parseFloat(data.overrideAmount) || 0;
                if (data.enrolledHouseholdsCount === undefined) {
                  logger.warn('Missing enrolledHouseholdsCount in ProductOwnerAmounts JSON', {
                    paymentId: payment.PaymentId,
                    productId: productIdStr
                  }, 'NACHA');
                }
                const householdsCount = data.enrolledHouseholdsCount !== undefined ? data.enrolledHouseholdsCount : 0;
                productOwnerAmountsMap.set(productIdStr.toUpperCase(), {
                  overrideAmount,
                  enrolledHouseholdsCount: householdsCount
                });
                totalOverrideAmount += overrideAmount;
              }
            }
            console.log('✅ Read ProductOwnerAmounts from payment:', {
              paymentId: payment.PaymentId,
              totalOverrideAmount,
              productCount: Object.keys(productOwnerAmounts).length,
              productOwnerAmounts: Object.fromEntries(productOwnerAmountsMap)
            });
            logger.info('Read ProductOwnerAmounts from payment', {
              paymentId: payment.PaymentId,
              totalOverrideAmount,
              productCount: Object.keys(productOwnerAmounts).length,
              productOwnerAmounts: Object.fromEntries(productOwnerAmountsMap)
            }, 'NACHA');
          } catch (e) {
            logger.warn('Could not parse ProductOwnerAmounts JSON from payment', {
              paymentId: payment.PaymentId,
              error: e.message
            }, 'NACHA');
          }
        }

        // If this is a group payment and we DO NOT have per-product snapshot data on the payment,
        // recompute pools from enrollments at PaymentDate using ProductPricing as a fallback.
        //
        // IMPORTANT: When snapshot JSON exists on oe.Payments (ProductCommissions/ProductVendorAmounts/ProductOwnerAmounts),
        // we must trust it. Those snapshots represent what was actually charged/recorded at the time and must align with
        // oe.NACHAPaymentDetails history (already-paid amounts). Recomputing from enrollments can over/under-count and
        // cause already-paid vendor payouts to appear "still owed".
        if (groupId && !hasVendorAmountsJSON && !hasOwnerAmountsJSON && commissionByProduct.size === 0) {
          try {
            const enrollmentLookupWindow = await this.resolveEnrollmentLookupWindow(
              payment.PaymentId,
              payment.PaymentDate || payment.CreatedDate
            );
            const aggReq = pool.request();
            aggReq.input('GroupId', sql.UniqueIdentifier, groupId);
            aggReq.input('EnrollmentLookupStartDate', sql.DateTime2, enrollmentLookupWindow.lookupStartDate);
            aggReq.input('EnrollmentLookupEndDate', sql.DateTime2, enrollmentLookupWindow.lookupEndDate);

            const aggResult = await aggReq.query(`
              SELECT
                e.ProductId,
                COUNT(DISTINCT m.HouseholdId) as EnrollmentCount,
                SUM(COALESCE(pp.VendorCommission, e.Commission, 0)) as CommissionAmount,
                SUM(COALESCE(pp.NetRate, e.NetRate, 0)) as VendorAmount,
                SUM(COALESCE(pp.OverrideRate, e.OverrideRate, 0)) as OverrideAmount
              FROM oe.Members m
              INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
                AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                AND e.Status = 'Active'
                AND e.CreatedDate <= @EnrollmentLookupEndDate
                AND e.EffectiveDate <= @EnrollmentLookupEndDate
                AND (e.TerminationDate IS NULL OR e.TerminationDate > @EnrollmentLookupStartDate)
                AND e.ProductId IS NOT NULL
                AND e.ProductId != '00000000-0000-0000-0000-000000000000'
                AND e.ProductId NOT IN (
                  SELECT DISTINCT BundleProductId
                  FROM oe.ProductBundles
                  WHERE BundleProductId IS NOT NULL
                )
              LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
              WHERE m.GroupId = @GroupId
                AND m.RelationshipType = 'P'
              GROUP BY e.ProductId
            `);

            // Reset and rebuild maps based on aggregates
            commissionByProduct = new Map();
            productEnrollmentCounts = new Map();
            productVendorAmountsMap = new Map();
            productOwnerAmountsMap = new Map();
            totalVendorAmount = 0;
            totalOverrideAmount = 0;
            hasVendorAmountsJSON = true;
            hasOwnerAmountsJSON = true;

            for (const row of aggResult.recordset || []) {
              const productIdStr = row.ProductId ? row.ProductId.toString().toUpperCase() : null;
              if (!productIdStr) continue;

              const enrollmentCount = Number(row.EnrollmentCount || 0);
              const commissionAmount = Number(row.CommissionAmount || 0);
              const vendorAmountAgg = Number(row.VendorAmount || 0);
              const overrideAmountAgg = Number(row.OverrideAmount || 0);

              if (enrollmentCount > 0) {
                productEnrollmentCounts.set(productIdStr, enrollmentCount);
              }
              if (commissionAmount > 0) {
                commissionByProduct.set(productIdStr, Math.round(commissionAmount * 100) / 100);
              }

              productVendorAmountsMap.set(productIdStr, {
                vendorAmount: Math.round(vendorAmountAgg * 100) / 100,
                enrolledHouseholdsCount: enrollmentCount
              });
              productOwnerAmountsMap.set(productIdStr, {
                overrideAmount: Math.round(overrideAmountAgg * 100) / 100,
                enrolledHouseholdsCount: enrollmentCount
              });

              totalVendorAmount += vendorAmountAgg;
              totalOverrideAmount += overrideAmountAgg;
            }

            logger.info('Recomputed group payment pools from enrollments/ProductPricing', {
              paymentId: payment.PaymentId,
              groupId,
              enrollmentLookupSource: enrollmentLookupWindow.source,
              enrollmentLookupStartDate: enrollmentLookupWindow.lookupStartDate,
              enrollmentLookupEndDate: enrollmentLookupWindow.lookupEndDate,
              totalVendorAmount,
              totalOverrideAmount,
              productEnrollmentCounts: Object.fromEntries(productEnrollmentCounts),
              commissionByProduct: Object.fromEntries(commissionByProduct)
            }, 'NACHA');
          } catch (e) {
            logger.warn('Failed to recompute group payment pools; falling back to payment JSON', {
              paymentId: payment.PaymentId,
              groupId,
              error: e.message
            }, 'NACHA');
          }
        }

        // For group payments, recompute per-product tier distribution (EE/ES/EC/EF household counts)
        // and correct the enrollment counts to use COUNT(DISTINCT HouseholdId) so that
        // CommissionCalculatorService.calculateComplexTieredCommission uses the per-tier branch
        // instead of the flat `totalFlatAmount * enrollmentCount` shortcut.
        if (groupId && groupId !== '00000000-0000-0000-0000-000000000000') {
          try {
            const tierDistLookupWindow = await this.resolveEnrollmentLookupWindow(
              payment.PaymentId,
              payment.PaymentDate || payment.CreatedDate
            );
            const tierDistReq = pool.request();
            tierDistReq.input('TierDistGroupId', sql.UniqueIdentifier, groupId);
            tierDistReq.input('TierDistLookupStart', sql.DateTime2, tierDistLookupWindow.lookupStartDate);
            tierDistReq.input('TierDistLookupEnd', sql.DateTime2, tierDistLookupWindow.lookupEndDate);

            const tierDistResult = await tierDistReq.query(`
              SELECT e.ProductId, m.Tier, COUNT(DISTINCT e.HouseholdId) AS HouseholdCount
              FROM oe.Enrollments e
              INNER JOIN oe.Members m ON e.MemberId = m.MemberId
              WHERE (e.GroupId = @TierDistGroupId OR m.GroupId = @TierDistGroupId)
                AND m.RelationshipType = 'P'
                AND m.Tier IN ('EE','EC','ES','EF')
                AND e.Status = 'Active'
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

              logger.info('NACHA: Recomputed TIER_DIST for group payment', {
                paymentId: payment.PaymentId,
                groupId,
                tierDistKeys: Array.from(productEnrollmentCounts.keys()).filter(k => k.startsWith('TIER_DIST:')),
                correctedCounts: Object.fromEntries(correctCountByProduct)
              }, 'NACHA');
            }
          } catch (tierDistErr) {
            logger.warn('NACHA: Could not recompute TIER_DIST for group payment', {
              paymentId: payment.PaymentId,
              groupId,
              error: tierDistErr.message
            }, 'NACHA');
          }
        }

        // Use calculated totals from JSON if available, otherwise fall back to aggregated columns
        // Check if JSON was successfully parsed (not just if total > 0, since 0 could be a valid amount)
        const vendorAmount = hasVendorAmountsJSON 
          ? totalVendorAmount 
          : (payment.NetRate || 0);
        const overrideAmount = hasOwnerAmountsJSON
          ? totalOverrideAmount
          : (payment.OverrideRate || 0);
        
        console.log('💰 Vendor and Override amounts determined:', {
          paymentId: payment.PaymentId,
          hasVendorAmountsJSON,
          totalVendorAmount,
          vendorAmount,
          fallbackNetRate: payment.NetRate || 0,
          hasOwnerAmountsJSON,
          totalOverrideAmount,
          overrideAmount,
          fallbackOverrideRate: payment.OverrideRate || 0
        });
        logger.info('Vendor and Override amounts determined', {
          paymentId: payment.PaymentId,
          hasVendorAmountsJSON,
          totalVendorAmount,
          vendorAmount,
          fallbackNetRate: payment.NetRate || 0,
          hasOwnerAmountsJSON,
          totalOverrideAmount,
          overrideAmount,
          fallbackOverrideRate: payment.OverrideRate || 0
        }, 'NACHA');

        // Pick any real product ID so CommissionCalculatorService can load a product record.
        // Vendor/Product Owner payouts are driven by the per-product snapshot maps (or enrollmentProductIds fallback),
        // so the choice of this anchor product does not change payout math.
        const calculationProductId =
          Array.from(productVendorAmountsMap.keys())[0] ||
          Array.from(productOwnerAmountsMap.keys())[0] ||
          Array.from(productEnrollmentCounts.keys())[0] ||
          Array.from(commissionByProduct.keys())[0] ||
          (Array.isArray(enrollmentProductIds) ? enrollmentProductIds[0] : null) ||
          null;

        if (!calculationProductId) {
          logger.warn('Skipping payment - could not resolve productId for calculation', {
            paymentId: payment.PaymentId,
            payoutType,
            hasProductVendorAmounts: productVendorAmountsMap.size > 0,
            hasProductOwnerAmounts: productOwnerAmountsMap.size > 0,
            enrollmentProductIdsCount: Array.isArray(enrollmentProductIds) ? enrollmentProductIds.length : 0
          }, 'NACHA');
          continue;
        }

        // Fast path for Vendor Payouts: derive vendor distribution directly from ProductVendorAmounts snapshot
        // and subtract already-paid amounts from Sent NACHA files. This avoids unnecessary commission-engine work.
        if (payoutType === 'Vendor Payouts' && productVendorAmountsMap.size > 0) {
          const productIds = Array.from(productVendorAmountsMap.keys())
            .filter((id) => id && id !== '00000000-0000-0000-0000-000000000000');

          // Resolve missing product->vendor mappings once per payment (with function-level cache).
          const missingProductIds = productIds.filter((id) => !productToVendorCache.has(String(id).toUpperCase()));
          if (missingProductIds.length > 0) {
            const productIdsStr = missingProductIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
            const vendorMapResult = await pool.request().query(`
              SELECT ProductId, VendorId
              FROM oe.Products
              WHERE ProductId IN (${productIdsStr})
            `);
            (vendorMapResult.recordset || []).forEach((row) => {
              if (!row.ProductId) return;
              productToVendorCache.set(String(row.ProductId).toUpperCase(), row.VendorId ? String(row.VendorId) : null);
            });
          }

          const vendorAmountByVendorId = new Map();
          for (const [productId, data] of productVendorAmountsMap.entries()) {
            const vendorId = productToVendorCache.get(String(productId).toUpperCase());
            if (!vendorId) continue;
            const amount = Number(data?.vendorAmount || 0);
            if (!amount || amount <= 0) continue;
            vendorAmountByVendorId.set(vendorId, Number(vendorAmountByVendorId.get(vendorId) || 0) + amount);
          }

          const vendorDistribution = [];
          for (const [vendorId, rawAmount] of vendorAmountByVendorId.entries()) {
            const roundedAmount = Math.round(Number(rawAmount || 0) * 100) / 100;
            const paidKey = `VENDOR_${vendorId}`.toUpperCase();
            const alreadyPaid = Number(paidAmounts.get(paidKey) || 0);
            const remaining = Math.round(Math.max(0, roundedAmount - alreadyPaid) * 100) / 100;
            if (remaining > 0) {
              vendorDistribution.push({
                vendorId,
                amount: remaining,
                ruleId: null,
                ruleName: 'Payment snapshot'
              });
            }
          }

          if (vendorDistribution.length === 0) {
            continue;
          }

          breakdown.push({
            paymentId: payment.PaymentId,
            invoiceId: payment.InvoiceId || null,
            fundingSource: payment.FundingSource || (payment.PaymentId ? FUNDING_SOURCE.PAYMENT : FUNDING_SOURCE.CREDIT),
            calculation: {
              paymentId: payment.PaymentId,
              invoiceId: payment.InvoiceId || null,
              fundingSource: payment.FundingSource || (payment.PaymentId ? FUNDING_SOURCE.PAYMENT : FUNDING_SOURCE.CREDIT),
              productId: calculationProductId,
              paymentAmount: payment.Amount,
              vendorCommissionAmount: vendorAmount,
              totalCommissionAllocation: payment.Commission || 0,
              distribution: {
                agents: [],
                vendors: vendorDistribution,
                tenants: []
              },
              totalCommissionsPaid: vendorDistribution.reduce((sum, v) => sum + Number(v.amount || 0), 0),
              remainingAmount: 0,
              overflowToProductOwner: 0
            },
            paymentAmount: payment.Amount,
            revenue: payment.Amount,
            commissionPool: payment.Commission || 0
          });
          continue;
        }

        // Calculate commissions (fallback/default path)
        logger.info('Calculating commission for payment', {
          paymentId: payment.PaymentId,
          calculationProductId,
          amount: payment.Amount,
          agentId,
          tenantId: payment.TenantId,
          enrollmentProductIds: enrollmentProductIds.length > 0 ? enrollmentProductIds : null,
          productCommissionAmounts: Object.fromEntries(commissionByProduct),
          productEnrollmentCounts: Object.fromEntries(productEnrollmentCounts),
          vendorAmount,
          overrideAmount,
          householdId,
          groupId
        }, 'NACHA');

        const calculation = await commissionCalculatorService.calculateCommissions(
          payment.PaymentId,
          calculationProductId,
          payment.Amount,
          agentId,
          payment.TenantId,
          payment.EnrollmentId, // Pass enrollmentId for fallback calculation
          overrideAmount, // Use calculated override amount from ProductOwnerAmounts JSON (or fallback to OverrideRate)
          payment.Commission || null, // Use Commission (Agent Commission Pool) from oe.Payments
          vendorAmount, // Use calculated vendor amount from ProductVendorAmounts JSON (or fallback to NetRate)
          householdId, // Pass householdId for rule filtering and product commission lookup
          groupId, // Pass groupId for rule filtering and product commission lookup
          payment.PaymentDate || payment.CreatedDate, // Pass paymentDate to determine which rules are effective
          false, // allowUnlockedRules: false for production
          null, // overrideAgentRuleId
          productTier, // Pass product tier (EE, ES, EC, EF) for tier-specific commission amounts
          enrollmentProductIds.length > 0 ? enrollmentProductIds : null, // Pass enrollment ProductIds for rule lookup
          commissionByProduct.size > 0 ? commissionByProduct : null, // Pass commission amounts per product
          productEnrollmentCounts.size > 0 ? productEnrollmentCounts : null, // Pass enrollment counts per product from ProductCommissions JSON
          null, // useCurrentDateForRuleEffectiveness (default false)
          productVendorAmountsMap.size > 0 ? productVendorAmountsMap : null, // Pass per-product vendor amounts for splitting vendor payouts
          productOwnerAmountsMap.size > 0 ? productOwnerAmountsMap : null // Pass per-product owner amounts for splitting product owner payouts
        );

        // Trim non-needed payout branches early so downstream processing/logging stays focused by payoutType.
        if (payoutType === 'Vendor Payouts' && calculation.distribution) {
          calculation.distribution.agents = [];
          calculation.distribution.tenants = [];
        } else if (payoutType === 'Agent Commission Payouts' && calculation.distribution) {
          calculation.distribution.vendors = [];
          // Keep ANY agency row (primary-overflow, override-Agency, tier-slot
          // Agency). Real-Tenant rows (entityType 'Tenant' / undefined) drop.
          calculation.distribution.tenants = (calculation.distribution.tenants || [])
            .filter((t) => t && (t.entityType === 'Agency' || t.isPrimaryAgency));
        } else if ((payoutType === 'Product Owner Payouts' || payoutType === 'Product Override Distributions') && calculation.distribution) {
          calculation.distribution.agents = [];
          calculation.distribution.vendors = [];
        }

        logger.info('Commission calculation result', {
          paymentId: payment.PaymentId,
          payoutType,
          totalCommissionsPaid: calculation.totalCommissionsPaid,
          agentPayouts: calculation.distribution?.agents?.length || 0,
          vendorPayouts: calculation.distribution?.vendors?.length || 0,
          tenantPayouts: calculation.distribution?.tenants?.length || 0
        }, 'NACHA');
        
        console.log('💰 Commission calculation:', {
          paymentId: payment.PaymentId,
          totalCommissionsPaid: calculation.totalCommissionsPaid,
          hasDistribution: !!calculation.distribution,
          agents: calculation.distribution?.agents?.length || 0,
          vendors: calculation.distribution?.vendors?.length || 0,
          tenants: calculation.distribution?.tenants?.length || 0,
          distributionKeys: calculation.distribution ? Object.keys(calculation.distribution) : []
        });

        // Apply paid amounts to distribution to determine remaining balance
        if (calculation.distribution) {
          // Vendors
          if (calculation.distribution.vendors) {
            calculation.distribution.vendors = calculation.distribution.vendors.map(v => {
              const key = `VENDOR_${v.vendorId}`.toUpperCase();
              const paid = paidAmounts.get(key) || 0;
              const remaining = Math.round(Math.max(0, v.amount - paid) * 100) / 100;
              
              if (paid > 0) {
                logger.info('Adjusting vendor payout for previous payments', { 
                  paymentId: payment.PaymentId, 
                  vendorId: v.vendorId, 
                  original: v.amount, 
                  paid, 
                  remaining 
                }, 'NACHA');
              }
              return { ...v, amount: remaining };
            }).filter(v => v.amount > 0);
          }

          // Agents
          if (calculation.distribution.agents) {
            calculation.distribution.agents = calculation.distribution.agents.map(a => {
              const key = `AGENT_${a.agentId}`.toUpperCase();
              const paid = paidAmounts.get(key) || 0;
              const remaining = Math.round(Math.max(0, a.amount - paid) * 100) / 100;
              
              if (paid > 0) {
                logger.info('Adjusting agent payout for previous payments', { 
                  paymentId: payment.PaymentId, 
                  agentId: a.agentId, 
                  original: a.amount, 
                  paid, 
                  remaining 
                }, 'NACHA');
              }
              return { ...a, amount: remaining };
            }).filter(a => a.amount > 0);
          }

          // Tenants (Overrides/Overflow)
          if (calculation.distribution.tenants) {
            calculation.distribution.tenants = calculation.distribution.tenants.map(t => {
              const key = `TENANT_${t.tenantId}`.toUpperCase();
              const paid = paidAmounts.get(key) || 0;
              const remaining = Math.round(Math.max(0, t.amount - paid) * 100) / 100;
              
              if (paid > 0) {
                logger.info('Adjusting tenant payout for previous payments', { 
                  paymentId: payment.PaymentId, 
                  tenantId: t.tenantId, 
                  original: t.amount, 
                  paid, 
                  remaining 
                }, 'NACHA');
              }
              return { ...t, amount: remaining };
            }).filter(t => t.amount > 0);
          }
        }

        // Collect payment scope only when product-owner override payout calculations are needed.
        if (payoutType === 'Product Owner Payouts' || payoutType === 'Product Override Distributions') {
          paymentsWithDetail.push({
            PaymentId: payment.PaymentId,
            HouseholdId: paymentDetail.HouseholdId || null,
            GroupId: paymentDetail.GroupId || null,
            PaymentDate: payment.PaymentDate || payment.CreatedDate
          });
        }

        // Add to breakdown
        breakdown.push({
          paymentId: payment.PaymentId,
          invoiceId: payment.InvoiceId || null,
          fundingSource: payment.FundingSource || (payment.PaymentId ? FUNDING_SOURCE.PAYMENT : FUNDING_SOURCE.CREDIT),
          calculation,
          // Store payment amount for revenue calculation
          paymentAmount: payment.Amount,
          // Store commission pool and revenue for payout aggregation
          revenue: payment.Amount,
          commissionPool: payment.Commission || 0
        });
      } catch (error) {
        logger.error('Error calculating commission for payment', {
          error: error.message,
          paymentId: payment.PaymentId
        }, 'NACHA');
      }
    }

    // Product Owner payout flow only: use exact same logic as Product Overrides tab.
    if (
      (payoutType === 'Product Owner Payouts' || payoutType === 'Product Override Distributions') &&
      paymentsWithDetail.length > 0 &&
      payments.length > 0 &&
      payments[0].TenantId
    ) {
      const pool = await getPool();
      const overrideByPayment = await getProductOverridePayoutsByPayment(
        pool,
        paymentsWithDetail,
        payments[0].TenantId.toString()
      );
      for (const item of breakdown) {
        const overflow = (item.calculation?.distribution?.tenants || []).filter((t) => t.isPrimaryAgency);
        const overrideEntries = overrideByPayment.get(item.paymentId?.toString()) || [];
        if (item.calculation?.distribution) {
          item.calculation.distribution.tenants = [...overflow, ...overrideEntries];
        }
      }
    }

    // Agent-to-agent overrides: for commission payout previews, redirect a portion of
    // the source agent's commission to the recipient agent so the NACHA preview totals
    // match post-generation reality.
    if (payoutType === 'Agent Commission Payouts' && breakdown.length > 0) {
      try {
        const pool = await getPool();
        for (const item of breakdown) {
          const distAgents = item?.calculation?.distribution?.agents;
          if (!Array.isArray(distAgents) || distAgents.length === 0) continue;
          const matchingPayment = payments.find((p) => p.PaymentId?.toString() === item.paymentId?.toString());
          const tenantId = matchingPayment?.TenantId;
          if (!tenantId) continue;

          const agentTotals = new Map();
          for (const line of distAgents) {
            if (!line.agentId) continue;
            const prev = agentTotals.get(line.agentId) || 0;
            agentTotals.set(line.agentId, prev + Number(line.amount || 0));
          }
          const sourceIds = Array.from(agentTotals.keys()).filter((id) => (agentTotals.get(id) || 0) > 0);
          if (sourceIds.length === 0) continue;

          const ovReq = pool.request();
          ovReq.input('TenantId', sql.UniqueIdentifier, tenantId);
          ovReq.input('PaymentDate', sql.Date, matchingPayment.PaymentDate || matchingPayment.CreatedDate || new Date());
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
            if (ovErr?.message && /Invalid object name|AgentCommissionOverrides/i.test(ovErr.message)) {
              ovRows = [];
            } else {
              throw ovErr;
            }
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
            if (amount <= 0 || amount > sourceTotal) {
              continue;
            }
            agentTotals.set(srcId, sourceTotal - amount);
            const ruleIds = `AGENT_OVERRIDE:${ov.OverrideId}`;
            distAgents.push({
              agentId: srcId,
              amount: -amount,
              ruleId: ruleIds,
              ruleName: 'Agent Override (deduction)',
              tierLevel: null
            });
            distAgents.push({
              agentId: ov.RecipientAgentId,
              amount: amount,
              ruleId: ruleIds,
              ruleName: 'Agent Override (credit)',
              tierLevel: null
            });
          }
        }
      } catch (err) {
        logger.warn('Failed to apply agent overrides to NACHA commission preview', {
          error: err.message
        }, 'NACHA');
      }
    }

    return breakdown;
  }

  /**
   * Filter payouts by type
   * @param {Array} breakdown - Payout breakdown
   * @param {string} payoutType - Payout type
   * @returns {Array} Filtered payouts
   */
  filterPayoutsByType(breakdown, payoutType) {
    const payouts = [];

    console.log('🔍 filterPayoutsByType called with:', {
      breakdownLength: breakdown.length,
      payoutType
    });

    for (const item of breakdown) {
      const { calculation } = item;
      
      console.log('📋 Processing breakdown item:', {
        paymentId: item.paymentId,
        hasCalculation: !!calculation,
        hasDistribution: !!calculation?.distribution,
        distributionKeys: calculation?.distribution ? Object.keys(calculation.distribution) : [],
        agentsArray: calculation?.distribution?.agents ? calculation.distribution.agents.length : 0,
        vendorsArray: calculation?.distribution?.vendors ? calculation.distribution.vendors.length : 0,
        tenantsArray: calculation?.distribution?.tenants ? calculation.distribution.tenants.length : 0
      });

      // Surface invoice anchor + funding source on every payout line so
      // downstream (createPaymentDetails) can write InvoiceId and the UI can
      // badge credit-funded rows.
      const itemInvoiceId = item.invoiceId || item.calculation?.invoiceId || null;
      const itemFundingSource = item.fundingSource
        || item.calculation?.fundingSource
        || (item.paymentId ? FUNDING_SOURCE.PAYMENT : (itemInvoiceId ? FUNDING_SOURCE.CREDIT : FUNDING_SOURCE.PAYMENT));

      if (payoutType === 'Agent Commission Payouts') {
        // Add all agent payouts
        const agents = calculation.distribution?.agents || [];
        console.log('🤖 Agent payouts found:', agents.length, agents);

        // Track agency IDs that appear in agent payouts (from tiered distribution)
        // These will be combined with agency overflow payouts later in groupPayoutsByRecipient
        const agencyIdsInAgents = new Set();
        for (const agentPayout of agents) {
          payouts.push({
            paymentId: item.paymentId,
            invoiceId: itemInvoiceId,
            fundingSource: itemFundingSource,
            entityType: 'Agent', // Will be corrected to 'Agency' in groupPayoutsByRecipient if it's actually an Agency
            entityId: agentPayout.agentId,
            amount: agentPayout.amount,
            tierLevel: agentPayout.tierLevel,
            ruleId: agentPayout.ruleId,
            ruleName: agentPayout.ruleName,
            // Preserve commission details from breakdown item
            revenue: item.revenue,
            commissionPool: item.commissionPool,
            ruleIds: agentPayout.ruleIds,
            commissionType: agentPayout.commissionType,
            commissionId: item.commissionId
          });
        }

        // Also add ANY agency payout (primary overflow, Override-Agency, or
        // tier-slot Agency) — they all belong to Agent Commission Payouts.
        const tenants = calculation.distribution?.tenants || [];
        for (const tenantPayout of tenants) {
          const isAgencyRow = tenantPayout && (tenantPayout.entityType === 'Agency' || tenantPayout.isPrimaryAgency);
          if (isAgencyRow) {
            payouts.push({
              paymentId: item.paymentId,
              invoiceId: itemInvoiceId,
              fundingSource: itemFundingSource,
              entityType: 'Agency',
              entityId: tenantPayout.tenantId, // Actually AgencyId
              amount: tenantPayout.amount,
              isOverflow: !!tenantPayout.isOverflow,
              isPrimaryAgency: !!tenantPayout.isPrimaryAgency,
              isOverride: !!tenantPayout.isOverride,
              ruleId: tenantPayout.ruleId,
              ruleName: tenantPayout.ruleName,
              tierLevel: tenantPayout.tierLevel ?? null,
              // Include revenue (payment amount) for display - use item.revenue from commissionsToPayoutBreakdown
              revenue: item.revenue || item.paymentAmount || calculation.paymentAmount || 0,
              // Agencies don't have commission pools, only overflow / tier-slot
              commissionPool: 0
            });
          }
        }
      } else if (payoutType === 'Vendor Payouts') {
        // Add vendor payouts
        for (const vendorPayout of calculation.distribution.vendors || []) {
          payouts.push({
            paymentId: item.paymentId,
            invoiceId: itemInvoiceId,
            fundingSource: itemFundingSource,
            entityType: 'Vendor',
            entityId: vendorPayout.vendorId,
            amount: vendorPayout.amount,
            ruleId: vendorPayout.ruleId,
            ruleName: vendorPayout.ruleName,
            // Include revenue (payment amount) for display
            revenue: calculation.paymentAmount || 0
          });
        }
      } else if (payoutType === 'Product Owner Payouts' || payoutType === 'Product Override Distributions') {
        // Product Owner Payouts: ONLY real-Tenant overrides. Skip any agency
        // row (primary-overflow, Override-Agency, tier-slot Agency) — those
        // belong to Agent Commission Payouts.
        for (const tenantPayout of calculation.distribution.tenants || []) {
          if (tenantPayout?.entityType === 'Agency' || tenantPayout?.isPrimaryAgency) {
            continue;
          }

          // Only include OverrideRate payouts (Tenants/Product Owners)
          if (!tenantPayout.isOverride) {
            continue;
          }
          
          console.log('💰 Product Owner payout:', {
            paymentId: item.paymentId,
            tenantId: tenantPayout.tenantId,
            amount: tenantPayout.amount,
            isOverride: tenantPayout.isOverride,
            ruleName: tenantPayout.ruleName,
            paymentAmount: calculation.paymentAmount
          });
          
          // Log if tenantId is null or invalid
          if (!tenantPayout.tenantId || tenantPayout.tenantId === '00000000-0000-0000-0000-000000000000') {
            console.error('❌ Invalid tenantId in product owner payout:', {
              paymentId: item.paymentId,
              tenantId: tenantPayout.tenantId,
              amount: tenantPayout.amount,
              productId: calculation.productId,
              paymentAmount: calculation.paymentAmount
            });
          }
          
          // Group by OverrideACHId when present so each override account is a separate recipient (match Product Overrides tab)
          const entityId = tenantPayout.overrideAchId || tenantPayout.tenantId;
          payouts.push({
            paymentId: item.paymentId,
            invoiceId: itemInvoiceId,
            fundingSource: itemFundingSource,
            entityType: 'Tenant',
            entityId,
            amount: tenantPayout.amount, // OverrideRate only
            isOverride: true,
            ruleId: tenantPayout.ruleId,
            ruleName: tenantPayout.ruleName,
            // Include revenue (payment amount) for display
            revenue: item.paymentAmount || calculation.paymentAmount || 0,
            // Preserve product information for Unknown entries
            productId: tenantPayout.productId || null,
            productName: tenantPayout.productName || null,
            missingOverrideDestination: tenantPayout.missingOverrideDestination || false,
            isUnknownDestination: tenantPayout.tenantId === 'UNKNOWN' || tenantPayout.tenantId === 'unknown',
            // So ACH lookup uses the specific override account, not TOP 1 per tenant
            overrideAchId: tenantPayout.overrideAchId || null,
            tenantId: tenantPayout.tenantId || null
          });
        }
      }
    }

    return payouts;
  }

  /**
   * Group payouts by recipient
   * @param {Array} payouts - Individual payouts
   * @returns {Array} Grouped payouts
   */
  groupPayoutsByRecipient(payouts) {
    const grouped = {};
    // Track which entityIds are actually Agencies (to correct entityType)
    const agencyIds = new Set();

    // First pass: identify all AgencyIds from Agency entityType payouts
    for (const payout of payouts) {
      if (payout.entityType === 'Agency') {
        agencyIds.add(payout.entityId);
      }
    }

    for (const payout of payouts) {
      // If this entityId is actually an Agency, use 'Agency' as entityType for grouping
      // This ensures tiered distribution AgencyIds combine with overflow Agency payouts
      const effectiveEntityType = agencyIds.has(payout.entityId) ? 'Agency' : payout.entityType;
      const key = `${effectiveEntityType}_${payout.entityId}`;
      
      if (!grouped[key]) {
        grouped[key] = {
          entityType: effectiveEntityType, // Use corrected entityType
          entityId: payout.entityId,
          amount: 0,
          payoutDetails: [],
          // Commission details (for Agent Commission Payouts)
          revenue: 0,
          commissionPool: 0,
          ruleIds: [],
          ruleNames: [],
          commissionIds: [],
          isOverflow: false, // Track if this is an overflow-only payout
          isOverride: !!payout.isOverride, // Product Override Distributions (so createPaymentDetails can set CommissionRuleId = NULL)
          // Preserve product information for Unknown entries
          productId: payout.productId || null,
          productName: payout.productName || null,
          missingOverrideDestination: payout.missingOverrideDestination || false,
          isUnknownDestination: payout.isUnknownDestination || payout.entityId === 'UNKNOWN' || payout.entityId === 'unknown',
          // Product Owner: specific override ACH account (so lookup uses OverrideACHId not TenantId TOP 1)
          overrideAchId: payout.overrideAchId || null,
          tenantId: payout.tenantId || null,
          // Funding source / invoice anchor (preserved from first contributor; per-line
          // values still live on entries within payoutDetails). 'mixed' is set if a
          // single recipient receives both Payment- and Credit-funded contributions.
          fundingSource: payout.fundingSource || null,
          invoiceId: payout.invoiceId || null,
        };
      } else if (payout.fundingSource && grouped[key].fundingSource && grouped[key].fundingSource !== payout.fundingSource) {
        grouped[key].fundingSource = 'mixed';
      }
      grouped[key].amount += payout.amount;
      grouped[key].payoutDetails.push(payout);
      if (payout.isOverride) grouped[key].isOverride = true;

      // Preserve product information from first payout (for Unknown entries)
      if (!grouped[key].productId && payout.productId) {
        grouped[key].productId = payout.productId;
      }
      if (!grouped[key].productName && payout.productName) {
        grouped[key].productName = payout.productName;
      }
      if (!grouped[key].missingOverrideDestination && payout.missingOverrideDestination) {
        grouped[key].missingOverrideDestination = true;
      }
      if (!grouped[key].isUnknownDestination && payout.isUnknownDestination) {
        grouped[key].isUnknownDestination = true;
      }
      
      // Track if this grouped payout contains overflow (for display purposes)
      if (payout.isOverflow || payout.isPrimaryAgency) {
        grouped[key].isOverflow = true;
      }
      
      // Debug logging for product owner payouts
      if (payout.entityType === 'Tenant') {
        console.log('🔍 Grouping tenant payout:', {
          entityId: payout.entityId,
          payoutAmount: payout.amount,
          revenue: payout.revenue,
          isOverflow: payout.isOverflow,
          isOverride: payout.isOverride,
          ruleName: payout.ruleName,
          accumulatedAmount: grouped[key].amount
        });
      }
      
      // Aggregate commission details
      // Revenue = sum of payment amounts (same for agents and agencies)
      // Different payments have different amounts, so we sum them
      if (payout.revenue !== undefined && payout.revenue > 0) {
        grouped[key].revenue = (grouped[key].revenue || 0) + payout.revenue;
      } else if (payout.paymentAmount !== undefined && payout.paymentAmount > 0) {
        // Fallback: use paymentAmount if revenue is not set
        grouped[key].revenue = (grouped[key].revenue || 0) + payout.paymentAmount;
      }
      // Commission pool applies to both agents and agencies (agencies can get commission pool via tiered distribution)
      // When combining agency payouts from tiered distribution + overflow, use the commission pool from tiered portion
      if (payout.commissionPool !== undefined && payout.commissionPool > 0) {
        // For agencies: if this payout has commissionPool, it's from tiered distribution (not overflow)
        // Set commission pool to the maximum (should be same across payouts for same payment)
        grouped[key].commissionPool = Math.max(grouped[key].commissionPool || 0, payout.commissionPool);
      }
      // Collect ruleIds from array (if available) or single ruleId
      // Skip ruleIds for overflow payouts (they don't have rules)
      if (!payout.isOverflow) {
        if (payout.ruleIds && Array.isArray(payout.ruleIds)) {
          for (const ruleId of payout.ruleIds) {
            if (ruleId && !grouped[key].ruleIds.includes(ruleId)) {
              grouped[key].ruleIds.push(ruleId);
            }
          }
        } else if (payout.ruleId && !grouped[key].ruleIds.includes(payout.ruleId)) {
          grouped[key].ruleIds.push(payout.ruleId);
        }
      }
      if (payout.ruleName && !grouped[key].ruleNames.includes(payout.ruleName)) {
        grouped[key].ruleNames.push(payout.ruleName);
      }
      if (payout.commissionId && !grouped[key].commissionIds.includes(payout.commissionId)) {
        grouped[key].commissionIds.push(payout.commissionId);
      }
      // Keep first rule details for display
      if (!grouped[key].ruleId && payout.ruleId) {
        grouped[key].ruleId = payout.ruleId;
        grouped[key].ruleName = payout.ruleName;
        grouped[key].commissionType = payout.commissionType;
        grouped[key].tierLevel = payout.tierLevel;
      }
    }

    return Object.values(grouped);
  }

  /**
   * Enhance payouts with ACH information
   * @param {Array} groupedPayouts - Grouped payouts
   * @param {string} payoutType - Payout type
   * @returns {Promise<Object>} Object with payoutsWithACH and excludedPayouts
   */
  async enhancePayoutsWithACH(groupedPayouts, payoutType) {
    const enhanced = [];
    const excluded = [];

    for (const payout of groupedPayouts) {
      try {
        // For vendors, get all active ACH accounts to handle distribution splits
        if (payout.entityType === 'Vendor') {
          const achAccounts = await achService.getAllACHAccounts(
            payout.entityType,
            payout.entityId,
            true // include decrypted
          );

          // Filter to only active accounts
          const activeAccounts = achAccounts.filter(acc => acc.Status === 'Active');

          if (activeAccounts.length === 0) {
            // No active ACH accounts - add to excluded list
            const entityName = await this.getEntityName(
              payout.entityType,
              payout.entityId
            ).catch(() => payout.entityId);
            
            excluded.push({
              ...payout,
              entityName,
              reason: 'No active ACH accounts found'
            });
            continue;
          }

          // Get entity name
          const entityName = await this.getEntityName(
            payout.entityType,
            payout.entityId
          );

          // Calculate total distribution percentage
          const totalDistribution = activeAccounts.reduce((sum, acc) => {
            return sum + (Number(acc.DistributionPercentage) || 0);
          }, 0);

          // If total distribution is 0 or invalid, use equal distribution
          const useEqualDistribution = totalDistribution === 0 || totalDistribution > 100;
          const distributionPerAccount = useEqualDistribution 
            ? 100 / activeAccounts.length 
            : null;

          // Create a payout entry for each ACH account
          for (const achAccount of activeAccounts) {
            const distributionPct = useEqualDistribution 
              ? distributionPerAccount 
              : (Number(achAccount.DistributionPercentage) || 0);
            
            // Calculate split amount
            const splitAmount = Math.round((payout.amount * distributionPct / 100) * 100) / 100;

            // Only add if split amount is greater than 0
            if (splitAmount > 0) {
              enhanced.push({
                ...payout,
                // Override amount with split amount
                amount: splitAmount,
                // Store original amount for reference
                originalAmount: payout.amount,
                // Store split information
                distributionPercentage: distributionPct,
                achAccountId: achAccount.ACHAccountId,
                accountHolderName: achAccount.AccountHolderName || entityName,
                routingNumber: achAccount.RoutingNumber,
                accountNumber: achAccount.AccountNumber,
                accountType: achAccount.AccountType,
                bankName: achAccount.BankName,
                accountNumberLast4: achAccount.AccountNumberLast4 || (achAccount.AccountNumber && achAccount.AccountNumber.length >= 4 ? achAccount.AccountNumber.slice(-4) : null),
                entityName,
                // Indicate this is a split payout
                isSplit: activeAccounts.length > 1,
                splitIndex: activeAccounts.indexOf(achAccount),
                totalSplits: activeAccounts.length
              });
            }
          }
        } else if (payout.entityType === 'Agent') {
          // For agents, check oe.AgentBankInfo table (not oe.ACHAccounts)
          const pool = await getPool();
          const request = pool.request();
          request.input('AgentId', sql.UniqueIdentifier, payout.entityId);

          const bankInfoResult = await request.query(`
            SELECT 
              BankInfoId,
              AgentId,
              BankName,
              AccountName,
              AccountType,
              RoutingNumber,
              AccountNumberEncrypted,
              AccountNumberLast4,
              Status,
              IsDefault
            FROM oe.AgentBankInfo
            WHERE AgentId = @AgentId 
              AND Status = 'Active'
            ORDER BY IsDefault DESC, CreatedDate DESC
          `);

          if (bankInfoResult.recordset.length === 0) {
            // No active bank info - add to excluded list
            const entityName = await this.getEntityName(
              payout.entityType,
              payout.entityId
            ).catch(() => payout.entityId);
            
            excluded.push({
              ...payout,
              entityName,
              reason: 'No active bank information found in oe.AgentBankInfo'
            });
            continue;
          }

          // Get the default or first active bank info
          const bankInfo = bankInfoResult.recordset[0];

          // Decrypt account number using smartDecryptAccountNumber, which
          // handles all three legacy storage formats produced by historical
          // bank-info paths: AES-256-GCM (correct), base64 (legacy), and
          // plaintext (legacy). This is what was making NACHA files contain
          // raw base64 strings like "NTI1OTEwNzU=" instead of digits.
          let accountNumber = null;
          if (bankInfo.AccountNumberEncrypted) {
            try {
              const encryptionService = require('./encryptionService');
              accountNumber = encryptionService.smartDecryptAccountNumber(
                bankInfo.AccountNumberEncrypted
              );
            } catch (error) {
              logger.warn('Failed to decode agent account number', {
                agentId: payout.entityId,
                bankInfoId: bankInfo.BankInfoId,
                error: error.message
              }, 'NACHA');
              accountNumber = bankInfo.AccountNumberEncrypted;
            }
          }

          // Get entity name
          const entityName = await this.getEntityName(
            payout.entityType,
            payout.entityId
          );

          enhanced.push({
            ...payout,
            accountHolderName: bankInfo.AccountName || entityName,
            routingNumber: bankInfo.RoutingNumber, // Not encrypted in AgentBankInfo
            accountNumber: accountNumber,
            accountType: bankInfo.AccountType,
            bankName: bankInfo.BankName,
            entityName
          });
        } else if (payout.entityType === 'Tenant' && (payoutType === 'Product Owner Payouts' || payoutType === 'Product Override Distributions')) {
          // For product owner payouts, use ProductOverrideACH. When overrideAchId is set, use that specific account (one per override destination). Otherwise fall back to TenantId + TOP 1.
          const pool = await getPool();
          const request = pool.request();
          let overrideResult;

          if (payout.overrideAchId) {
            request.input('OverrideACHId', sql.UniqueIdentifier, payout.overrideAchId);
            overrideResult = await request.query(`
              SELECT
                OverrideACHId,
                TenantId,
                AccountName,
                AccountHolderName,
                BankName,
                BankAccountType,
                RoutingNumberEncrypted,
                AccountNumberEncrypted,
                IsActive,
                IsDefault,
                VerificationStatus
              FROM oe.ProductOverrideACH
              WHERE OverrideACHId = @OverrideACHId
                AND IsActive = 1
            `);
          } else {
            request.input('TenantId', sql.UniqueIdentifier, payout.tenantId || payout.entityId);
            overrideResult = await request.query(`
              SELECT TOP 1
                OverrideACHId,
                TenantId,
                AccountName,
                AccountHolderName,
                BankName,
                BankAccountType,
                RoutingNumberEncrypted,
                AccountNumberEncrypted,
                IsActive,
                IsDefault,
                VerificationStatus
              FROM oe.ProductOverrideACH
              WHERE TenantId = @TenantId
                AND IsActive = 1
              ORDER BY IsDefault DESC, CreatedDate DESC
            `);
          }

          if (overrideResult.recordset.length === 0) {
            // No active override ACH account - add to excluded list
            const entityName = payout.overrideAchId
              ? (payout.entityId || 'Unknown')
              : await this.getEntityName(payout.entityType, payout.tenantId || payout.entityId).catch(() => payout.entityId);
            
            excluded.push({
              ...payout,
              entityName,
              reason: 'No active bank information found in oe.ProductOverrideACH'
            });
            continue;
          }

          const overrideAccount = overrideResult.recordset[0];

          // Decrypt routing and account numbers
          const encryptionService = require('./encryptionService');
          let routingNumber = null;
          let accountNumber = null;
          
          if (overrideAccount.RoutingNumberEncrypted) {
            try {
              routingNumber = encryptionService.decrypt(overrideAccount.RoutingNumberEncrypted);
            } catch (error) {
              logger.warn('Failed to decrypt product override routing number', {
                tenantId: payout.entityId,
                overrideACHId: overrideAccount.OverrideACHId,
                error: error.message
              }, 'NACHA');
            }
          }
          
          if (overrideAccount.AccountNumberEncrypted) {
            try {
              accountNumber = encryptionService.decrypt(overrideAccount.AccountNumberEncrypted);
            } catch (error) {
              logger.warn('Failed to decrypt product override account number', {
                tenantId: payout.entityId,
                overrideACHId: overrideAccount.OverrideACHId,
                error: error.message
              }, 'NACHA');
            }
          }

          // Validate we have the required decrypted data
          if (!routingNumber || !accountNumber) {
            const entityName = overrideAccount.AccountName || overrideAccount.AccountHolderName
              || await this.getEntityName(payout.entityType, payout.tenantId || payout.entityId).catch(() => payout.entityId);
            
            excluded.push({
              ...payout,
              entityName,
              reason: routingNumber && !accountNumber 
                ? 'Failed to decrypt account number from ProductOverrideACH'
                : !routingNumber && accountNumber
                ? 'Failed to decrypt routing number from ProductOverrideACH'
                : 'Failed to decrypt routing and account numbers from ProductOverrideACH'
            });
            continue;
          }

          // Display name: ACH AccountName or AccountHolderName (match Product Overrides tab), fallback to tenant name
          const entityName = overrideAccount.AccountName || overrideAccount.AccountHolderName
            || await this.getEntityName('Tenant', overrideAccount.TenantId).catch(() => payout.entityId);

          enhanced.push({
            ...payout,
            accountHolderName: overrideAccount.AccountHolderName || overrideAccount.AccountName || entityName,
            routingNumber: routingNumber,
            accountNumber: accountNumber,
            accountType: overrideAccount.BankAccountType,
            bankName: overrideAccount.BankName,
            entityName
          });
        } else {
          // For other Tenants and entities, use existing ACHAccounts logic
          const achAccount = await achService.getACHAccount(
            payout.entityType,
            payout.entityId,
            true // include decrypted
          );

          if (achAccount && achAccount.Status === 'Active') {
            // Get entity name
            const entityName = await this.getEntityName(
              payout.entityType,
              payout.entityId
            );

            enhanced.push({
              ...payout,
              accountHolderName: achAccount.AccountHolderName || entityName,
              routingNumber: achAccount.RoutingNumber,
              accountNumber: achAccount.AccountNumber,
              accountType: achAccount.AccountType,
              bankName: achAccount.BankName,
              entityName
            });
          } else {
            // No active ACH account - add to excluded list
            const entityName = await this.getEntityName(
              payout.entityType,
              payout.entityId
            ).catch(() => payout.entityId);
            
            excluded.push({
              ...payout,
              entityName,
              reason: achAccount ? `ACH account status: ${achAccount.Status}` : 'No ACH account found'
            });
          }
        }
      } catch (error) {
        // No ACH account found - add to excluded list
        logger.warn('No active ACH account found for payout', {
          entityType: payout.entityType,
          entityId: payout.entityId,
          error: error.message
        }, 'NACHA');
        
        const entityName = await this.getEntityName(
          payout.entityType,
          payout.entityId
        ).catch(() => payout.entityId);
        
        excluded.push({
          ...payout,
          entityName,
          reason: 'No ACH account found'
        });
      }
    }

    return {
      payoutsWithACH: enhanced,
      excludedPayouts: excluded
    };
  }

  /**
   * Get entity name for display
   * @param {string} entityType - Entity type
   * @param {string} entityId - Entity ID
   * @returns {Promise<string>} Entity name
   */
  async getEntityName(entityType, entityId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('EntityId', sql.UniqueIdentifier, entityId);

      let query = '';
      if (entityType === 'Agent') {
        query = `
          SELECT u.FirstName + ' ' + u.LastName as Name
          FROM oe.Agents a
          JOIN oe.Users u ON a.UserId = u.UserId
          WHERE a.AgentId = @EntityId
        `;
        
        const result = await request.query(query);
        if (result.recordset.length > 0) {
          const name = result.recordset[0].Name;
          if (name && name.trim()) {
            return name.trim();
          }
        }
        
        // If not found as Agent, try as Agency (sometimes AgencyIds are incorrectly passed as AgentIds)
        const agencyRequest = pool.request();
        agencyRequest.input('AgencyId', sql.UniqueIdentifier, entityId);
        const agencyQuery = `
          SELECT AgencyName as Name
          FROM oe.Agencies
          WHERE AgencyId = @AgencyId
        `;
        const agencyResult = await agencyRequest.query(agencyQuery);
        if (agencyResult.recordset.length > 0) {
          const name = agencyResult.recordset[0].Name;
          if (name && name.trim()) {
            logger.info('Found entity as Agency instead of Agent', {
              entityId,
              name: name.trim()
            }, 'NACHA');
            return name.trim();
          }
        }
        
        return 'Unknown';
      } else if (entityType === 'Vendor') {
        query = `SELECT VendorName as Name FROM oe.Vendors WHERE VendorId = @EntityId`;
      } else if (entityType === 'Agency') {
        query = `SELECT AgencyName as Name FROM oe.Agencies WHERE AgencyId = @EntityId`;
      } else if (entityType === 'Tenant') {
        // First try as Tenant
        query = `SELECT Name FROM oe.Tenants WHERE TenantId = @EntityId`;
        
        const result = await request.query(query);
        if (result.recordset.length > 0) {
          const name = result.recordset[0].Name;
          if (name && name.trim()) {
            return name.trim();
          }
        }
        
        // If not found as Tenant, try as Agency (overflow can go to agencies)
        const agencyRequest = pool.request();
        agencyRequest.input('AgencyId', sql.UniqueIdentifier, entityId);
        const agencyQuery = `
          SELECT AgencyName as Name
          FROM oe.Agencies
          WHERE AgencyId = @AgencyId
        `;
        const agencyResult = await agencyRequest.query(agencyQuery);
        if (agencyResult.recordset.length > 0) {
          const name = agencyResult.recordset[0].Name;
          if (name && name.trim()) {
            logger.info('Found entity as Agency instead of Tenant', {
              entityId,
              name: name.trim()
            }, 'NACHA');
            return name.trim();
          }
        }
        
        // Log when entity is not found in database
        logger.warn('Entity not found in database (checked as Tenant and Agency)', {
          entityType,
          entityId
        }, 'NACHA');
        
        return 'Unknown';
      }

      if (query) {
        const result = await request.query(query);
        if (result.recordset.length > 0) {
          const name = result.recordset[0].Name;
          if (name && name.trim()) {
            return name.trim();
          }
        } else {
          // Log when entity is not found in database
          logger.warn('Entity not found in database', {
            entityType,
            entityId
          }, 'NACHA');
        }
      } else {
        // Log when entity type is not recognized
        logger.warn('Unknown entity type for name lookup', {
          entityType,
          entityId
        }, 'NACHA');
      }

      return 'Unknown';
    } catch (error) {
      logger.error('Error getting entity name', {
        entityType,
        entityId,
        error: error.message
      }, 'NACHA');
      throw error; // Re-throw so caller can handle
    }
  }

  /**
   * Format NACHA file content
   * Implements standard NACHA ACH file format
   * @param {Array} payouts - Payouts with ACH info
   * @param {Object} metadata - File metadata
   * @returns {string} NACHA file content
   */
  formatNACHAFile(payouts, metadata) {
    const lines = [];
    const now = new Date();

    // File Header Record (Record Type 1)
    lines.push(this.formatFileHeader(now, metadata.tenantACHAccount, metadata.companyIdentification));

    // Batch Header Record (Record Type 5)
    const batchNumber = 1;
    lines.push(this.formatBatchHeader(batchNumber, now, metadata));

    // Entry Detail Records (Record Type 6) - one per payout
    let entryCount = 0;
    let totalDebit = 0;
    let totalCredit = 0;
    let entryHashSum = 0;

    // Get tenant routing number for trace number generation
    const tenantRoutingNumber = metadata.tenantACHAccount?.RoutingNumber 
      ? metadata.tenantACHAccount.RoutingNumber.replace(/-/g, '').replace(/\s/g, '').substring(0, 8)
      : '00000000';

    for (const payout of payouts) {
      // Trace number: 8-digit Originating DFI (from tenant) + 7-digit sequence
      const traceNumber = tenantRoutingNumber + String(entryCount + 1).padStart(7, '0');
      lines.push(this.formatEntryDetail(payout, traceNumber));
      entryCount++;
      totalCredit += payout.amount;

      // Entry Hash: sum of first 8 digits of Receiving DFI routing numbers (from each Entry Detail)
      // Store as 10-digit right-justified (per NACHA spec). We compute using payout routing numbers.
      if (payout.routingNumber) {
        const receivingRouting = payout.routingNumber.replace(/-/g, '').replace(/\s/g, '');
        if (/^\d{9}$/.test(receivingRouting)) {
          entryHashSum += parseInt(receivingRouting.substring(0, 8), 10);
        }
      }
    }

    // Entry hash field is 10 digits; keep rightmost 10 digits of sum
    const entryHash = String(entryHashSum % 10000000000).padStart(10, '0');

    // Batch Control Record (Record Type 8)
    lines.push(this.formatBatchControl(
      batchNumber,
      entryCount,
      totalCredit,
      totalDebit,
      metadata.tenantACHAccount,
      metadata.companyIdentification,
      entryHash
    ));

    // File Control Record (Record Type 9) + padding (records must be multiple of 10)
    // Total records = File Header (1) + Batch Header (1) + Entry Details (entryCount) + Batch Control (1) + File Control (1) + padding
    const baseRecordCount = 1 + 1 + entryCount + 1 + 1;
    const paddingCount = (10 - (baseRecordCount % 10)) % 10;
    const totalRecordCount = baseRecordCount + paddingCount;
    const blockCount = totalRecordCount / 10;

    lines.push(this.formatFileControl(totalRecordCount, blockCount, entryCount, totalCredit, totalDebit, entryHash));

    // Padding records: '9' * 94 lines
    if (paddingCount > 0) {
      const paddingLine = '9'.repeat(94);
      for (let i = 0; i < paddingCount; i++) {
        lines.push(paddingLine);
      }
    }

    // Use CRLF line endings for maximum bank compatibility
    return lines.join('\r\n');
  }

  /**
   * Generate NACHA file using @assetval/nachos for strict formatting (94-char lines, proper controls, padding).
   * We still use our existing payout calculation + ACH decryption/fetching; this is only the file formatter.
   */
  async formatNACHAFileWithNachos(payouts, metadata) {
    throw new Error('formatNACHAFileWithNachos is deprecated (switched to node-nacha).');
  }

  /**
   * Generate NACHA file using @midlandsbank/node-nacha (actively maintained).
   * This only handles file formatting — payouts + ACH decryption stay in our code.
   */
  formatNACHAFileWithNodeNacha(payouts, metadata) {
    const funding = metadata?.tenantACHAccount;
    if (!funding?.RoutingNumber || !funding?.AccountHolderName) {
      throw new Error('Funding ACH account missing RoutingNumber/AccountHolderName');
    }

    const bankRouting9 = funding.RoutingNumber.replace(/-/g, '').replace(/\s/g, '');
    if (!/^\d{9}$/.test(bankRouting9)) {
      throw new Error(`Invalid funding routing number: ${bankRouting9}`);
    }

    const companyIdRaw = normalizeCompanyIdForNacha(metadata?.companyIdentification);

    const payoutType = metadata?.payoutType || '';
    const entryDesc =
      payoutType === 'Vendor Payouts'
        ? 'VENDOR PAY'
        : payoutType === 'Agent Commission Payouts'
          ? 'COMMISSIONS'
          : payoutType === 'Product Owner Payouts'
            ? 'PRODUCTOWN'
            : payoutType === 'Product Override Distributions'
              ? 'OVERRIDE'
              : 'PAYOUT';

    // NOTE: node-nacha validates file header origin/destination as ABA routing numbers.
    // So we use the funding bank routing for both (validators commonly expect ODFI routing here).
    const nachaFile = new Nacha({
      origin: {
        name: (funding.AccountHolderName || '').substring(0, 23),
        routing: bankRouting9
      },
      destination: {
        name: (funding.BankName || funding.AccountHolderName || '').substring(0, 23),
        routing: bankRouting9
      },
      referenceCode: ' '
    })
      .ccd({
        company: {
          name: (funding.AccountHolderName || '').substring(0, 16),
          id: companyIdRaw
        },
        entryDescription: entryDesc.substring(0, 10),
        // Batch header originating DFI identification is 8 digits
        origin: bankRouting9.substring(0, 8)
      });

    const odfi8 = bankRouting9.substring(0, 8);
    let seq = 1;

    for (const payout of payouts) {
      const rr = (payout.routingNumber || '').replace(/-/g, '').replace(/\s/g, '');
      const an = (payout.accountNumber || '').replace(/-/g, '').replace(/\s/g, '');
      if (!/^\d{9}$/.test(rr)) throw new Error(`Invalid recipient routing number: ${rr}`);
      if (!an) throw new Error('Missing recipient account number');

      const amountDollars = Number(payout.amount);
      if (!Number.isFinite(amountDollars) || amountDollars <= 0) {
        throw new Error(`Invalid payout amount: ${payout.amount}`);
      }

      const traceNumber = `${odfi8}${String(seq).padStart(7, '0')}`;
      seq += 1;

      nachaFile.addEntry({
        direction: 'credit',
        amount: amountDollars,
        routingNumber: rr,
        accountNumber: an,
        accountType: payout.accountType === 'Savings' ? 'Savings' : 'Checking',
        name: (payout.accountHolderName || payout.entityName || '').toString().substring(0, 22),
        idNumber: (payout.entityId || '').toString().replace(/[^a-zA-Z0-9]/g, '').substring(0, 15),
        discretionaryData: '  ',
        traceNumber
      });
    }

    return nachaFile.done().toString();
  }

  /**
   * Format File Header Record (Type 1)
   * @param {Date} date - File creation date
   * @returns {string} File header line
   */
  formatFileHeader(date, tenantACHAccount) {
    // NACHA File Header Record (Type 1) - 94 characters exactly
    // CRITICAL: Use tenant ACH account from database - no environment variables
    if (!tenantACHAccount) {
      throw new Error('Tenant ACH account is required for file header. This should be retrieved from the database.');
    }
    if (!tenantACHAccount.RoutingNumber) {
      throw new Error('Tenant ACH account is missing routing number. This is required for NACHA file header.');
    }
    if (!tenantACHAccount.AccountHolderName) {
      throw new Error('Tenant ACH account is missing account holder name. This is required for NACHA file header.');
    }

    // Validate routing number is 9 digits
    const routingNumberClean = tenantACHAccount.RoutingNumber.replace(/-/g, '').replace(/\s/g, '');
    if (!/^\d{9}$/.test(routingNumberClean)) {
      throw new Error(`Invalid tenant routing number format. Expected 9 digits, got: ${routingNumberClean}`);
    }

    const recordType = '1';
    const priorityCode = '01';
    // Immediate Destination: 9-digit routing number (ODFI / receiving point for the file)
    const immediateDestination = routingNumberClean.substring(0, 9);
    // Immediate Origin: Company Identification (10 digits). Accepts 9-digit EIN (prepends "1") or 10 digits.
    const companyIdRaw = normalizeCompanyIdForNacha(arguments.length >= 3 ? arguments[2] : '');
    const immediateOrigin = companyIdRaw;
    
    // File date: YYMMDD format
    const yy = String(date.getFullYear()).substring(2);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const fileDate = yy + mm + dd;
    // File time: HHMM format
    const fileTime = String(date.getHours()).padStart(2, '0') + String(date.getMinutes()).padStart(2, '0');
    const fileIDModifier = 'A';
    const recordSize = '094';
    const blockingFactor = '10';
    const formatCode = '1';
    // Immediate Destination Name: Tenant's bank name (or account holder name if bank name not available)
    const immediateDestinationName = (tenantACHAccount.BankName || tenantACHAccount.AccountHolderName || '').padEnd(23, ' ').substring(0, 23);
    // Immediate Origin Name: Tenant's account holder name (company name)
    const immediateOriginName = tenantACHAccount.AccountHolderName.padEnd(23, ' ').substring(0, 23);
    const referenceCode = ''.padEnd(8, ' ');

    // Build record exactly 94 characters
    const record = 
      recordType +                              // 1 char (pos 1)
      priorityCode +                            // 2 chars (pos 2-3)
      ' ' +                                     // 1 char (pos 4)
      immediateDestination +                    // 9 chars (pos 5-13)
      immediateOrigin +                         // 10 chars (pos 14-23)
      fileDate +                                // 6 chars (pos 24-29)
      fileTime +                                // 4 chars (pos 30-33)
      fileIDModifier +                          // 1 char (pos 34)
      recordSize +                              // 3 chars (pos 35-37)
      blockingFactor +                          // 2 chars (pos 38-39)
      formatCode +                              // 1 char (pos 40)
      immediateDestinationName +                // 23 chars (pos 41-63)
      immediateOriginName +                     // 23 chars (pos 64-86)
      referenceCode;                            // 8 chars (pos 87-94)

    return record.padEnd(94, ' ').substring(0, 94);
  }

  /**
   * Format Batch Header Record (Type 5)
   * @param {number} batchNumber - Batch number
   * @param {Date} date - Batch date
   * @param {Object} metadata - Batch metadata
   * @returns {string} Batch header line
   */
  formatBatchHeader(batchNumber, date, metadata) {
    // NACHA Batch Header Record (Type 5) - 94 characters exactly
    // CRITICAL: Use tenant ACH account from database - no environment variables
    const tenantACHAccount = metadata.tenantACHAccount;
    if (!tenantACHAccount) {
      throw new Error('Tenant ACH account is required for batch header. This should be retrieved from the database.');
    }
    if (!tenantACHAccount.RoutingNumber) {
      throw new Error('Tenant ACH account is missing routing number.');
    }
    if (!tenantACHAccount.AccountHolderName) {
      throw new Error('Tenant ACH account is missing account holder name.');
    }

    const routingNumberClean = tenantACHAccount.RoutingNumber.replace(/-/g, '').replace(/\s/g, '');
    if (!/^\d{9}$/.test(routingNumberClean)) {
      throw new Error(`Invalid tenant routing number format. Expected 9 digits, got: ${routingNumberClean}`);
    }

    const recordType = '5';
    // NOTE:
    // Some ODFIs (banks) permission originators to a specific Service Class Code.
    // Even for "credits only" files, the user/profile may only be entitled for '200' (mixed debits/credits).
    // We default to '200' to match common bank entitlements and the known-good sample.
    const serviceClassCode = '200';
    const companyName = tenantACHAccount.AccountHolderName.padEnd(16, ' ').substring(0, 16);
    const companyDiscretionaryData = ''.padEnd(20, ' ').substring(0, 20);
    // Company Identification: 10 digits (required). Accepts 9-digit EIN (prepends "1") or 10 digits.
    const companyIdentification = normalizeCompanyIdForNacha(metadata?.companyIdentification);
    const standardEntryClass = 'PPD'; // Prearranged Payment and Deposit
    
    // Create better entry description abbreviations (10 characters max)
    let entryDescription = '';
    if (metadata.payoutType === 'Agent Commission Payouts') {
      entryDescription = 'AGENT COMM';
    } else if (metadata.payoutType === 'Vendor Payouts') {
      entryDescription = 'VENDOR PAY';
    } else if (metadata.payoutType === 'Product Owner Payouts' || metadata.payoutType === 'Product Override Distributions') {
      entryDescription = 'OVERRIDE';
    } else {
      // Fallback: use first 10 characters of payout type, uppercase
      entryDescription = metadata.payoutType.toUpperCase().substring(0, 10);
    }
    entryDescription = entryDescription.padEnd(10, ' ').substring(0, 10);
    
    // Dates: YYMMDD format
    const yy = String(date.getFullYear()).substring(2);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const companyDescriptiveDate = yy + mm + dd;
    // Effective Entry Date: same as company descriptive date (today). Same-day ACH is valid; some validators optionally require "at least tomorrow."
    const effectiveEntryDate = companyDescriptiveDate;
    // Settlement Date (Julian) - left blank per NACHA spec (3 spaces)
    const settlementDate = '   ';
    const originatorStatusCode = '1'; // Live production (1) or test (2)
    const originatingDFIId = routingNumberClean.substring(0, 8);
    const batchNumberStr = String(batchNumber).padStart(7, '0').substring(0, 7);

    // Build record exactly 94 characters
    const record = 
      recordType +                              // 1 char (pos 1)
      serviceClassCode +                        // 3 chars (pos 2-4)
      companyName +                             // 16 chars (pos 5-20)
      companyDiscretionaryData +                // 20 chars (pos 21-40)
      companyIdentification +                   // 10 chars (pos 41-50)
      standardEntryClass +                      // 3 chars (pos 51-53)
      entryDescription +                        // 10 chars (pos 54-63)
      companyDescriptiveDate +                  // 6 chars (pos 64-69)
      effectiveEntryDate +                      // 6 chars (pos 70-75)
      settlementDate +                          // 3 chars (pos 76-78, blank)
      originatorStatusCode +                    // 1 char (pos 79)
      originatingDFIId +                        // 8 chars (pos 80-87)
      batchNumberStr;                           // 7 chars (pos 88-94)

    return record.padEnd(94, ' ').substring(0, 94);
  }

  /**
   * Format Entry Detail Record (Type 6)
   * @param {Object} payout - Payout details
   * @param {number} traceNumber - Trace number
   * @returns {string} Entry detail line
   */
  formatEntryDetail(payout, traceNumber) {
    // NACHA Entry Detail Record (Type 6) - 94 characters exactly
    // CRITICAL: Validate required ACH data
    if (!payout.routingNumber || payout.routingNumber.trim() === '') {
      throw new Error(`Missing routing number for payout: ${payout.entityType} ${payout.entityId} (${payout.entityName || 'Unknown'})`);
    }
    if (!payout.accountNumber || payout.accountNumber.trim() === '') {
      throw new Error(`Missing account number for payout: ${payout.entityType} ${payout.entityId} (${payout.entityName || 'Unknown'})`);
    }
    if (!payout.accountHolderName || payout.accountHolderName.trim() === '') {
      throw new Error(`Missing account holder name for payout: ${payout.entityType} ${payout.entityId}`);
    }

    // Validate routing number is 9 digits
    const routingNumberClean = payout.routingNumber.replace(/-/g, '').replace(/\s/g, '');
    if (!/^\d{9}$/.test(routingNumberClean)) {
      throw new Error(`Invalid routing number format for payout: ${payout.entityType} ${payout.entityId} (${payout.entityName || 'Unknown'}). Expected 9 digits, got: ${routingNumberClean}`);
    }

    const recordType = '6';
    const transactionCode = payout.accountType === 'Savings' ? '32' : '22'; // 22=Checking Credit, 32=Savings Credit
    const receivingDFIId = routingNumberClean.substring(0, 8);
    const checkDigit = routingNumberClean.substring(8, 9);
    const DFIAccountNumber = payout.accountNumber.replace(/-/g, '').replace(/\s/g, '').padEnd(17, ' ').substring(0, 17);
    const amount = Math.round(payout.amount * 100).toString().padStart(10, '0'); // Amount in cents, right-justified
    const individualName = (payout.accountHolderName || payout.entityName || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').padEnd(22, ' ').substring(0, 22);
    const discretionaryData = ''.padEnd(2, ' ');
    const addendaRecordIndicator = '0'; // No addenda records
    // Trace number: 8-digit Originating DFI + 7-digit sequence
    const traceNumberStr = String(traceNumber).padStart(15, '0').substring(0, 15);
    // Individual ID Number: numeric-only (15 chars). Using trace number is deterministic, digits-only, and unique per file.
    const individualIdentificationNumber = traceNumberStr.padEnd(15, ' ').substring(0, 15);

    // Build record exactly 94 characters
    const record = 
      recordType +                              // 1 char (pos 1)
      transactionCode.padStart(2, '0') +        // 2 chars (pos 2-3)
      receivingDFIId +                          // 8 chars (pos 4-11)
      checkDigit +                              // 1 char (pos 12)
      DFIAccountNumber +                        // 17 chars (pos 13-29)
      amount +                                  // 10 chars (pos 30-39)
      individualIdentificationNumber +          // 15 chars (pos 40-54)
      individualName +                          // 22 chars (pos 55-76)
      ' ' +                                     // 1 space (pos 77)
      ' ' +                                     // 1 space (pos 78)
      addendaRecordIndicator +                  // 1 char (pos 79)
      traceNumberStr;                           // 15 chars (pos 80-94)

    return record.padEnd(94, ' ').substring(0, 94);
  }

  /**
   * Format Batch Control Record (Type 8)
   * @param {number} batchNumber - Batch number
   * @param {number} entryCount - Entry count
   * @param {number} totalCredit - Total credit amount
   * @param {number} totalDebit - Total debit amount
   * @returns {string} Batch control line
   */
  formatBatchControl(batchNumber, entryCount, totalCredit, totalDebit, tenantACHAccount, companyIdentificationOverride, entryHashOverride) {
    // NACHA Batch Control Record (Type 8) - 94 characters exactly
    // CRITICAL: Use tenant ACH account from database - no environment variables
    if (!tenantACHAccount || !tenantACHAccount.RoutingNumber) {
      throw new Error('Tenant ACH account is required for batch control.');
    }
    
    const recordType = '8';
    // Must match Batch Header service class code.
    // See note in formatBatchHeader regarding bank entitlements.
    const serviceClassCode = '200';
    const entryAddendaCount = String(entryCount).padStart(6, '0').substring(0, 6);
    // Entry hash: sum of first 8 digits of all receiving DFI routing numbers (10 digits, right-justified)
    const entryHash = (entryHashOverride || '0000000000').toString().padStart(10, '0').substring(0, 10);
    const totalDebitAmount = Math.round(totalDebit * 100).toString().padStart(12, '0').substring(0, 12);
    const totalCreditAmount = Math.round(totalCredit * 100).toString().padStart(12, '0').substring(0, 12);
    
    const routingNumberClean = tenantACHAccount.RoutingNumber.replace(/-/g, '').replace(/\s/g, '');
    const companyIdentification = normalizeCompanyIdForNacha(companyIdentificationOverride);
    const messageAuthenticationCode = ''.padEnd(19, ' ').substring(0, 19);
    const reserved = ''.padEnd(6, ' ').substring(0, 6);
    const originatingDFIId = routingNumberClean.substring(0, 8);
    const batchNumberStr = String(batchNumber).padStart(7, '0').substring(0, 7);

    // Build record exactly 94 characters
    const record = 
      recordType +                              // 1 char (pos 1)
      serviceClassCode +                        // 3 chars (pos 2-4)
      entryAddendaCount +                       // 6 chars (pos 5-10)
      entryHash +                               // 10 chars (pos 11-20)
      totalDebitAmount +                        // 12 chars (pos 21-32)
      totalCreditAmount +                       // 12 chars (pos 33-44)
      companyIdentification +                   // 10 chars (pos 45-54)
      messageAuthenticationCode +               // 19 chars (pos 55-73)
      reserved +                                // 6 chars (pos 74-79)
      originatingDFIId +                        // 8 chars (pos 80-87)
      batchNumberStr;                           // 7 chars (pos 88-94)

    return record.padEnd(94, ' ').substring(0, 94);
  }

  /**
   * Format File Control Record (Type 9)
   * @param {number} recordCount - Total record count
   * @param {number} entryCount - Entry count
   * @param {number} totalCredit - Total credit amount
   * @param {number} totalDebit - Total debit amount
   * @returns {string} File control line
   */
  formatFileControl(recordCount, blockCountOverride, entryCount, totalCredit, totalDebit, entryHashOverride) {
    // NACHA File Control Record (Type 9) - 94 characters exactly
    const recordType = '9';
    const batchCount = '1'.padStart(6, '0').substring(0, 6);
    const blockCount = String(blockCountOverride ?? Math.ceil(recordCount / 10)).padStart(6, '0').substring(0, 6);
    const entryAddendaCount = String(entryCount).padStart(8, '0').substring(0, 8);
    // Entry hash: sum of first 8 digits of all receiving DFI routing numbers (10 digits, right-justified)
    const entryHash = (entryHashOverride || '0000000000').toString().padStart(10, '0').substring(0, 10);
    const totalDebitAmount = Math.round(totalDebit * 100).toString().padStart(12, '0').substring(0, 12);
    const totalCreditAmount = Math.round(totalCredit * 100).toString().padStart(12, '0').substring(0, 12);
    const reserved = ''.padEnd(39, ' ').substring(0, 39);

    // Build record exactly 94 characters
    const record = 
      recordType +                              // 1 char (pos 1)
      batchCount +                              // 6 chars (pos 2-7)
      blockCount +                              // 6 chars (pos 8-13)
      entryAddendaCount +                       // 8 chars (pos 14-21)
      entryHash +                               // 10 chars (pos 22-31)
      totalDebitAmount +                        // 12 chars (pos 32-43)
      totalCreditAmount +                       // 12 chars (pos 44-55)
      reserved;                                 // 39 chars (pos 56-94)

    return record.padEnd(94, ' ').substring(0, 94);
  }

  /**
   * Generate file name for NACHA file
   * @param {string} payoutType - Payout type
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @returns {string} File name
   */
  generateFileName(payoutType, startDate, endDate) {
    const typeToken = ({
      // Requested: use COMMISSIONS instead of AGENT
      'Agent Commission Payouts': 'COMMISSIONS',
      'Vendor Payouts': 'VENDOR',
      'Product Owner Payouts': 'PRODUCT_OVERRIDES',
      'Product Override Distributions': 'PRODUCT_OVERRIDES'
    }[payoutType] || 'NACHA')
      .toString()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    // Use UTC timestamp for stable server-side naming (prefix AA per document naming conventions)
    const dt = new Date();
    const yyyymmdd = dt.toISOString().slice(0, 10).replace(/-/g, '');
    const hhmmss = dt.toISOString().slice(11, 19).replace(/:/g, '');

    return `AA_${typeToken}_${yyyymmdd}_${hhmmss}.txt`;
  }

  /**
   * Save NACHA generation to database
   * @param {Object} data - NACHA generation data
   * @returns {Promise<void>}
   */
  async saveNACHAGeneration(data) {
    const pool = await getPool();
    const request = pool.request();

    request.input('NACHAId', sql.UniqueIdentifier, data.nachaId);
    request.input('PayoutType', sql.NVarChar, data.payoutType);
    request.input('StartDate', sql.Date, data.startDate);
    request.input('EndDate', sql.Date, data.endDate);
    request.input('TenantId', sql.UniqueIdentifier, data.tenantId || null);
    request.input('Status', sql.NVarChar, 'Pending');
    request.input('TotalPayouts', sql.Int, data.totalPayouts);
    request.input('TotalAmount', sql.Decimal(18, 2), data.totalAmount);
    request.input('FileContent', sql.NVarChar(sql.MAX), data.fileContent);
    request.input('FileName', sql.NVarChar, data.fileName);
    request.input('GeneratedBy', sql.UniqueIdentifier, data.userId);
    request.input('PayoutBasis', sql.NVarChar(50), data.payoutBasis || null);
    request.input('ReissueOfNACHAId', sql.UniqueIdentifier, data.reissueOfNachaId || null);

    await request.query(`
      INSERT INTO oe.NACHAGenerations (
        NACHAId, PayoutType, StartDate, EndDate, TenantId, Status,
        TotalPayouts, TotalAmount, FileContent, FileName, GeneratedBy,
        GeneratedDate, CreatedDate, ModifiedDate, PayoutBasis, ReissueOfNACHAId
      )
      VALUES (
        @NACHAId, @PayoutType, @StartDate, @EndDate, @TenantId, @Status,
        @TotalPayouts, @TotalAmount, @FileContent, @FileName, @GeneratedBy,
        GETUTCDATE(), GETUTCDATE(), GETUTCDATE(), @PayoutBasis, @ReissueOfNACHAId
      )
    `);
  }

  /**
   * Create payment detail records for NACHA
   * @param {string} nachaId - NACHA ID
   * @param {Array} payouts - Enhanced payouts list (payoutsWithACH)
   * @returns {Promise<void>}
   */
  async createPaymentDetails(nachaId, payouts) {
    const pool = await getPool();
    const transaction = pool.transaction();

    try {
      await transaction.begin();

      for (const payout of payouts) {
        // payout is the ACH-enhanced, filtered, grouped payout
        // It contains payoutDetails array with the original payments
        
        const distributionPercentage = payout.distributionPercentage !== undefined ? Number(payout.distributionPercentage) : 100;
        
        // Iterate through the original payments that made up this group
        if (payout.payoutDetails && Array.isArray(payout.payoutDetails)) {
          for (const detail of payout.payoutDetails) {
            // detail is the original payout object from calculatePayoutBreakdown
            
            // Calculate amount for this specific payment detail
            // Use the same split logic as the group to ensure consistency
            let amount = detail.amount;
            if (payout.isSplit) {
                amount = Math.round((detail.amount * distributionPercentage / 100) * 100) / 100;
            }

            // Skip 0 amounts
            if (amount === 0) continue;

            // CommissionRuleId FK references oe.CommissionRules; Product Override payouts use OverrideId, not RuleId — store NULL
            const isProductOverridePayout = payout.entityType === 'Tenant' && (payout.isOverride || payout.overrideAchId);
            const commissionRuleIdForInsert = isProductOverridePayout ? null : (detail.ruleId || null);

            // Anchor: payment-funded rows carry PaymentId; credit-funded rows
            // carry InvoiceId. The CHECK constraint requires at least one to be
            // non-null. detail.invoiceId / detail.fundingSource are surfaced
            // by filterPayoutsByType from the source row.
            const detailPaymentId = detail.paymentId || null;
            const detailInvoiceId = detail.invoiceId || (detailPaymentId ? null : payout.invoiceId || null);

            const detailRequest = transaction.request();
            detailRequest.input('NACHAPaymentDetailId', sql.UniqueIdentifier, uuidv4());
            detailRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
            detailRequest.input('PaymentId', sql.UniqueIdentifier, detailPaymentId);
            detailRequest.input('InvoiceId', sql.UniqueIdentifier, detailInvoiceId);
            detailRequest.input('RecipientEntityType', sql.NVarChar, payout.entityType);
            detailRequest.input('RecipientEntityId', sql.UniqueIdentifier, payout.entityId);
            detailRequest.input('CommissionRuleId', sql.UniqueIdentifier, commissionRuleIdForInsert);
            detailRequest.input('TierLevel', TIER_LEVEL_SQL, detail.tierLevel !== undefined ? detail.tierLevel : null);
            detailRequest.input('Amount', sql.Decimal(18, 2), amount);
            detailRequest.input('ACHAccountId', sql.UniqueIdentifier, payout.achAccountId || null);
            // Retry Bounces: when this detail row is a re-issue of a prior NACHAPaymentDetail
            // (i.e. it was selected from a bounced NACHA and is being repaid here), record the
            // source detail id so markNACHAasSent / markNACHAasNotSent can skip ledger side-effects
            // and the duplicate-line check can ignore it.
            detailRequest.input(
              'ReissueOfNACHAPaymentDetailId',
              sql.UniqueIdentifier,
              detail.reissueOfDetailId || null
            );

            await detailRequest.query(`
              INSERT INTO oe.NACHAPaymentDetails (
                NACHAPaymentDetailId, NACHAId, PaymentId, InvoiceId, RecipientEntityType,
                RecipientEntityId, CommissionRuleId, TierLevel, Amount, ACHAccountId, CreatedDate,
                ReissueOfNACHAPaymentDetailId
              )
              VALUES (
                @NACHAPaymentDetailId, @NACHAId, @PaymentId, @InvoiceId, @RecipientEntityType,
                @RecipientEntityId, @CommissionRuleId, @TierLevel, @Amount, @ACHAccountId, GETUTCDATE(),
                @ReissueOfNACHAPaymentDetailId
              )
            `);
          }
        }
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  /**
   * Resolve a funding ACH account by id (TenantPayoutACH first, then oe.ACHAccounts).
   * Returns the same shape used by the file/batch header formatters
   * (ACHAccountId, AccountHolderName, BankName, AccountType, RoutingNumber, AccountNumber, Status).
   *
   * Used by generateRetryNACHA where the caller passes an explicit funding source.
   * Throws if the account isn't found, isn't active, or can't be decrypted.
   *
   * @param {string} tenantId
   * @param {string} fundingAchAccountId
   * @returns {Promise<Object>} ACH account suitable for use as `tenantACHAccount` in formatNACHAFile.
   */
  async resolveFundingACHAccount(tenantId, fundingAchAccountId) {
    if (!fundingAchAccountId) {
      throw new Error('fundingAchAccountId is required');
    }
    const pool = await getPool();
    const encryptionService = require('./encryptionService');

    const tenantPayoutRequest = pool.request();
    tenantPayoutRequest.input('FundingAchAccountId', sql.UniqueIdentifier, fundingAchAccountId);
    tenantPayoutRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
    const tpResult = await tenantPayoutRequest.query(`
      SELECT TOP 1
        TenantPayoutACHId, AccountHolderName, BankName, BankAccountType,
        RoutingNumberEncrypted, AccountNumberEncrypted, IsActive
      FROM oe.TenantPayoutACH
      WHERE TenantPayoutACHId = @FundingAchAccountId
        AND TenantId = @TenantId
        AND IsActive = 1
    `);

    if (tpResult.recordset.length > 0) {
      const a = tpResult.recordset[0];
      const routingNumber = a.RoutingNumberEncrypted ? encryptionService.decrypt(a.RoutingNumberEncrypted) : null;
      const accountNumber = a.AccountNumberEncrypted ? encryptionService.decrypt(a.AccountNumberEncrypted) : null;
      if (!routingNumber || !accountNumber) {
        throw new Error('Failed to decrypt funding TenantPayoutACH account');
      }
      return {
        ACHAccountId: a.TenantPayoutACHId,
        AccountHolderName: a.AccountHolderName,
        BankName: a.BankName,
        AccountType: a.BankAccountType,
        RoutingNumber: routingNumber,
        AccountNumber: accountNumber,
        Status: 'Active'
      };
    }

    const achAccount = await achService.getACHAccountById(fundingAchAccountId, true);
    if (!achAccount || achAccount.Status !== 'Active') {
      throw new Error(`Funding ACH account ${fundingAchAccountId} not found or not active`);
    }
    return achAccount;
  }

  /**
   * Generate a NACHA file that re-issues specific bounced payouts from a previous NACHA.
   *
   * Behavior is intentionally minimal:
   *   - Picks the EXACT same recipients + line amounts from the original NACHA's
   *     NACHAPaymentDetails rows that the caller selected.
   *   - Looks up each recipient's CURRENT bank info (so updated ACH wins automatically).
   *   - Persists the new NACHA with ReissueOfNACHAId set, and each new line with
   *     ReissueOfNACHAPaymentDetailId pointing back at the original line.
   *   - Does NOT touch oe.Commissions or oe.Payments paid totals — markNACHAasSent
   *     is reissue-aware and skips ledger updates for these rows.
   *
   * @param {Object} options
   * @param {string} options.originalNachaId
   * @param {string[]} options.paymentDetailIds  NACHAPaymentDetailId values from the original NACHA
   * @param {string} options.fundingAchAccountId  Required — funding bank for the retry file
   * @param {string} options.companyIdentification 9 (EIN) or 10 digit company identification
   * @param {string} options.userId
   * @returns {Promise<Object>} { nachaId, fileName, totalPayouts, totalAmount, ... }
   */
  async generateRetryNACHA(options) {
    const {
      originalNachaId,
      paymentDetailIds,
      fundingAchAccountId,
      companyIdentification,
      userId
    } = options || {};

    if (!originalNachaId) {
      throw new Error('originalNachaId is required');
    }
    if (!Array.isArray(paymentDetailIds) || paymentDetailIds.length === 0) {
      throw new Error('paymentDetailIds must be a non-empty array');
    }
    if (!fundingAchAccountId) {
      throw new Error('fundingAchAccountId is required for retry NACHA generation');
    }
    if (!companyIdentification) {
      throw new Error('companyIdentification is required for retry NACHA generation');
    }

    const pool = await getPool();

    // 1. Load original NACHA to copy PayoutType / TenantId / dates.
    const origRequest = pool.request();
    origRequest.input('OriginalNACHAId', sql.UniqueIdentifier, originalNachaId);
    const origResult = await origRequest.query(`
      SELECT NACHAId, PayoutType, StartDate, EndDate, TenantId, FileName, PayoutBasis
      FROM oe.NACHAGenerations
      WHERE NACHAId = @OriginalNACHAId
    `);

    if (origResult.recordset.length === 0) {
      throw new Error(`Original NACHA file ${originalNachaId} not found`);
    }
    const original = origResult.recordset[0];

    // 2. Load the selected payment-detail rows from the original.
    const detailsRequest = pool.request();
    detailsRequest.input('OriginalNACHAId', sql.UniqueIdentifier, originalNachaId);
    paymentDetailIds.forEach((id, i) => {
      detailsRequest.input(`pdid${i}`, sql.UniqueIdentifier, id);
    });
    const inList = paymentDetailIds.map((_, i) => `@pdid${i}`).join(',');
    const detailsResult = await detailsRequest.query(`
      SELECT
        NACHAPaymentDetailId,
        PaymentId,
        RecipientEntityType,
        RecipientEntityId,
        CommissionRuleId,
        TierLevel,
        Amount,
        ACHAccountId
      FROM oe.NACHAPaymentDetails
      WHERE NACHAId = @OriginalNACHAId
        AND NACHAPaymentDetailId IN (${inList})
        AND Amount > 0
    `);

    if (detailsResult.recordset.length === 0) {
      throw new Error('No matching payment-detail rows found on the original NACHA file');
    }

    // 3. Group selected details by recipient so we produce one NACHA entry per
    //    recipient (summing across all selected lines for that recipient).
    //    payoutDetails preserves the per-line breakdown so createPaymentDetails
    //    can still write one new NACHAPaymentDetails row per original line and
    //    set ReissueOfNACHAPaymentDetailId correctly.
    const groupKey = (r) => `${r.RecipientEntityType}|${String(r.RecipientEntityId).toUpperCase()}`;
    const grouped = new Map();
    for (const row of detailsResult.recordset) {
      const key = groupKey(row);
      if (!grouped.has(key)) {
        grouped.set(key, {
          entityType: row.RecipientEntityType,
          entityId: row.RecipientEntityId,
          amount: 0,
          payoutDetails: []
        });
      }
      const g = grouped.get(key);
      const lineAmount = parseFloat(row.Amount);
      g.amount = Math.round((g.amount + lineAmount) * 100) / 100;
      g.payoutDetails.push({
        paymentId: row.PaymentId,
        ruleId: row.CommissionRuleId || null,
        tierLevel: row.TierLevel != null ? Number(row.TierLevel) : null,
        amount: lineAmount,
        // Pin the new line back to the original detail row so markNACHAasSent
        // knows to skip ledger side-effects for these rows.
        reissueOfDetailId: row.NACHAPaymentDetailId
      });
    }

    const groupedPayouts = Array.from(grouped.values());

    // 4. Resolve funding ACH (file/batch header) — must be supplied explicitly.
    const tenantACHAccount = await this.resolveFundingACHAccount(
      original.TenantId,
      fundingAchAccountId
    );

    // 5. Enhance each grouped payout with CURRENT bank info (uses live AgentBankInfo
    //    + smartDecryptAccountNumber, so any updated ACH for the recipient flows through).
    const { payoutsWithACH, excludedPayouts } = await this.enhancePayoutsWithACH(
      groupedPayouts,
      original.PayoutType
    );

    if (payoutsWithACH.length === 0) {
      const reasons = excludedPayouts.map((p) => ({
        entityType: p.entityType,
        entityId: p.entityId,
        entityName: p.entityName || 'Unknown',
        amount: p.amount,
        reason: p.reason || 'No active ACH account found'
      }));
      throw new Error(
        `Cannot generate retry NACHA: none of the ${groupedPayouts.length} selected ` +
        `recipient(s) have an active ACH account on file. ` +
        reasons.map((r) => `${r.entityName}: ${r.reason}`).join('; ')
      );
    }

    // 6. Format the NACHA file. Note vendor splits in enhancePayoutsWithACH may
    //    produce more entries than groupedPayouts (one per active vendor ACH);
    //    that's fine — payoutsWithACH carries everything formatNACHAFile expects.
    const fileContent = this.formatNACHAFile(payoutsWithACH, {
      payoutType: original.PayoutType,
      startDate: original.StartDate,
      endDate: original.EndDate,
      tenantACHAccount,
      companyIdentification
    });

    // Same final 94-char validation production uses.
    const lines = String(fileContent).split(/\r?\n/).filter((l) => l.length > 0);
    const badLines = lines
      .map((line, idx) => ({ idx: idx + 1, len: line.length }))
      .filter((x) => x.len !== 94);
    if (badLines.length > 0) {
      throw new Error(
        `Invalid NACHA output: ${badLines.length} line(s) are not 94 chars: ` +
        badLines.slice(0, 5).map((x) => `Line ${x.idx} len=${x.len}`).join(', ')
      );
    }

    // 7. Persist.
    const newNachaId = uuidv4();
    const fileName = this.generateFileName(original.PayoutType, original.StartDate, original.EndDate)
      .replace(/^AA_/, 'AA_RETRY_');

    const totalPayouts = payoutsWithACH.length;
    const totalAmount = Math.round(
      payoutsWithACH.reduce((sum, p) => sum + Number(p.amount || 0), 0) * 100
    ) / 100;

    await this.saveNACHAGeneration({
      nachaId: newNachaId,
      payoutType: original.PayoutType,
      startDate: original.StartDate,
      endDate: original.EndDate,
      tenantId: original.TenantId,
      userId,
      fileName,
      fileContent,
      totalAmount,
      totalPayouts,
      payoutBasis: original.PayoutBasis || null,
      reissueOfNachaId: originalNachaId
    });

    await this.createPaymentDetails(newNachaId, payoutsWithACH);

    logger.info('Retry NACHA generated', {
      newNachaId,
      originalNachaId,
      totalPayouts,
      totalAmount,
      includedRecipients: groupedPayouts.length,
      excludedRecipients: excludedPayouts.length
    }, 'NACHA');

    return {
      nachaId: newNachaId,
      fileName,
      totalPayouts,
      totalAmount,
      status: 'Pending',
      generatedDate: new Date(),
      reissueOfNachaId: originalNachaId,
      excludedPayouts: excludedPayouts.map((p) => ({
        entityType: p.entityType,
        entityId: p.entityId,
        entityName: p.entityName || 'Unknown',
        amount: p.amount,
        reason: p.reason || 'No active ACH account found'
      }))
    };
  }

  /**
   * Mark commissions as Paid after NACHA generation
   * @param {string} nachaId - NACHA ID
   * @returns {Promise<void>}
   */
  async markCommissionsAsPaid(nachaId) {
    const pool = await getPool();
    const transaction = pool.transaction();

    try {
      await transaction.begin();

      // Get commission IDs from NACHAPaymentDetails
      const detailRequest = transaction.request();
      detailRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      
      // Get payment details to find which commissions to mark as paid
      const detailsResult = await detailRequest.query(`
        SELECT DISTINCT PaymentId, RecipientEntityId as AgentId, RecipientEntityType
        FROM oe.NACHAPaymentDetails
        WHERE NACHAId = @NACHAId
          AND (RecipientEntityType = 'Agent' OR RecipientEntityType = 'Agency')
      `);

      // Mark commissions as Paid
      for (const detail of detailsResult.recordset) {
        const updateRequest = transaction.request();
        updateRequest.input('PaymentId', sql.UniqueIdentifier, detail.PaymentId);
        updateRequest.input('AgentId', sql.UniqueIdentifier, detail.RecipientEntityType === 'Agent' ? detail.AgentId : null);
        updateRequest.input('AgencyId', sql.UniqueIdentifier, detail.RecipientEntityType === 'Agency' ? detail.AgentId : null);
        updateRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);

        let whereClause = "PaymentId = @PaymentId AND Status = 'Pending' AND TransactionType IN ('Advance', 'Commission')";
        if (detail.RecipientEntityType === 'Agent') {
            whereClause += " AND AgentId = @AgentId";
        } else {
            whereClause += " AND AgencyId = @AgencyId";
        }

        await updateRequest.query(`
          UPDATE oe.Commissions
          SET Status = 'Paid',
              ModifiedDate = GETUTCDATE()
          WHERE ${whereClause}
        `);
      }

      await transaction.commit();
      
      logger.info('Marked commissions as Paid', {
        nachaId,
        commissionCount: detailsResult.recordset.length
      }, 'NACHA');
    } catch (error) {
      await transaction.rollback();
      logger.error('Error marking commissions as Paid', {
        error: error.message,
        nachaId
      }, 'NACHA');
      throw error;
    }
  }

  /**
   * Mark NACHA as sent and update payment records
   * @param {string} nachaId - NACHA ID
   * @param {string} userId - User ID marking as sent
   * @returns {Promise<void>}
   */
  async markNACHAasSent(nachaId, userId) {
    const pool = await getPool();
    const transaction = pool.transaction();

    try {
      await transaction.begin();

      // CRITICAL: Prevent duplicate payouts.
      // Allow legitimate top-ups for same payment+recipient across files.
      // Block only exact duplicate payout lines (same payment+recipient+rule+tier+amount).
      //
      // Retry Bounces exception: rows where ReissueOfNACHAPaymentDetailId IS NOT NULL are
      // re-issues of previously-bounced payouts. They intentionally pay the same amount
      // as the original line (which is still tracked as Paid), so they must be exempt
      // from the duplicate-line check on BOTH sides — they neither block, nor are blocked by,
      // a normal NACHA with a matching (PaymentId + Recipient + Rule + Tier + Amount).
      const validationRequest = transaction.request();
      validationRequest.input('CurrentNACHAId', sql.UniqueIdentifier, nachaId);
      const validationResult = await validationRequest.query(`
        -- Dedup key is COALESCE(PaymentId, InvoiceId) so payment-anchored
        -- and credit-funded (invoice-anchored) rows are both protected from
        -- double-pay. AnchorId/AnchorType are computed once on each row so
        -- the join is symmetrical and SQL Server can short-circuit cleanly.
        WITH CurrentPairs AS (
          SELECT
            COALESCE(d.PaymentId, d.InvoiceId) AS AnchorId,
            CASE WHEN d.PaymentId IS NOT NULL THEN 'P' ELSE 'I' END AS AnchorType,
            d.RecipientEntityId,
            d.RecipientEntityType,
            d.CommissionRuleId,
            d.TierLevel,
            SUM(COALESCE(d.Amount, 0)) AS Amount
          FROM oe.NACHAPaymentDetails d
          WHERE d.NACHAId = @CurrentNACHAId
            AND d.ReissueOfNACHAPaymentDetailId IS NULL
            AND COALESCE(d.PaymentId, d.InvoiceId) IS NOT NULL
          GROUP BY COALESCE(d.PaymentId, d.InvoiceId),
                   CASE WHEN d.PaymentId IS NOT NULL THEN 'P' ELSE 'I' END,
                   d.RecipientEntityId, d.RecipientEntityType, d.CommissionRuleId, d.TierLevel
        ),
        SentPairs AS (
          SELECT
            COALESCE(d.PaymentId, d.InvoiceId) AS AnchorId,
            CASE WHEN d.PaymentId IS NOT NULL THEN 'P' ELSE 'I' END AS AnchorType,
            d.RecipientEntityId,
            d.RecipientEntityType,
            d.CommissionRuleId,
            d.TierLevel,
            g.FileName,
            SUM(COALESCE(d.Amount, 0)) AS Amount
          FROM oe.NACHAPaymentDetails d
          INNER JOIN oe.NACHAGenerations g ON d.NACHAId = g.NACHAId
          WHERE g.Status = 'Sent'
            AND d.NACHAId != @CurrentNACHAId
            AND d.ReissueOfNACHAPaymentDetailId IS NULL
            AND COALESCE(d.PaymentId, d.InvoiceId) IS NOT NULL
          GROUP BY COALESCE(d.PaymentId, d.InvoiceId),
                   CASE WHEN d.PaymentId IS NOT NULL THEN 'P' ELSE 'I' END,
                   d.RecipientEntityId, d.RecipientEntityType, d.CommissionRuleId, d.TierLevel, g.FileName
        )
        SELECT TOP 1
          c.AnchorId,
          c.AnchorType,
          c.RecipientEntityId,
          c.RecipientEntityType,
          s.FileName as ConflictingFile
        FROM CurrentPairs c
        INNER JOIN SentPairs s
          ON c.AnchorId = s.AnchorId
         AND c.AnchorType = s.AnchorType
         AND c.RecipientEntityId = s.RecipientEntityId
         AND c.RecipientEntityType = s.RecipientEntityType
         AND (
           (c.CommissionRuleId = s.CommissionRuleId)
           OR (c.CommissionRuleId IS NULL AND s.CommissionRuleId IS NULL)
         )
         AND (
           (c.TierLevel = s.TierLevel)
           OR (c.TierLevel IS NULL AND s.TierLevel IS NULL)
         )
         AND ABS(COALESCE(c.Amount, 0) - COALESCE(s.Amount, 0)) < 0.01
      `);

      if (validationResult.recordset.length > 0) {
        const conflict = validationResult.recordset[0];
        const anchorLabel = conflict.AnchorType === 'I' ? `Invoice ${conflict.AnchorId}` : `Payment ${conflict.AnchorId}`;
        throw new Error(`Payout conflict detected: ${anchorLabel} to ${conflict.RecipientEntityType} ${conflict.RecipientEntityId} was already paid in file '${conflict.ConflictingFile}'. Cannot mark as sent.`);
      }

      const invoiceStatusRequest = transaction.request();
      invoiceStatusRequest.input('CurrentNACHAId', sql.UniqueIdentifier, nachaId);
      // Block only when we would pay out positive dollars against an invoice that is no
      // longer Paid (prevents commission on unfunded premium). Refund/clawback lines
      // (negative Amount) on Unpaid invoices are expected after a reversal.
      const invoiceStatusResult = await invoiceStatusRequest.query(`
        SELECT TOP 1 i.InvoiceId, i.Status
        FROM oe.Invoices i
        WHERE i.Status <> N'Paid'
          AND EXISTS (
            SELECT 1
            FROM oe.NACHAPaymentDetails d
            WHERE d.NACHAId = @CurrentNACHAId
              AND d.InvoiceId = i.InvoiceId
              AND d.ReissueOfNACHAPaymentDetailId IS NULL
              AND COALESCE(d.Amount, 0) > 0.005
          )
      `);
      if (invoiceStatusResult.recordset.length > 0) {
        const row = invoiceStatusResult.recordset[0];
        throw new Error(
          `Cannot mark Sent: invoice ${row.InvoiceId} flipped to Status=${row.Status} since generation. Regenerate batch.`
        );
      }

      // Get payment details for this NACHA
      // Retry Bounces: skip rows that are re-issues of previously-Paid payouts
      // so we don't double-increment CommissionPaid / OverridePaid / VendorCommissionPaid.
      const detailRequest = transaction.request();
      detailRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      const detailsResult = await detailRequest.query(`
        SELECT
          PaymentId,
          InvoiceId,
          RecipientEntityType,
          Amount,
          CommissionRuleId
        FROM oe.NACHAPaymentDetails
        WHERE NACHAId = @NACHAId
          AND ReissueOfNACHAPaymentDetailId IS NULL
      `);

      // Group by payment ID, separating vendor, agent, and tenant payouts.
      // Credit-funded rows have PaymentId IS NULL — they are anchored on
      // InvoiceId only and have no oe.Payments bucket to increment, so we
      // skip them here. The NACHAPaymentDetails ledger is the source of
      // truth for those.
      const paymentUpdates = {};
      for (const detail of detailsResult.recordset) {
        if (!detail.PaymentId) continue; // credit-funded line — no Payments row to update
        const paymentId = detail.PaymentId.toString();
        if (!paymentUpdates[paymentId]) {
          paymentUpdates[paymentId] = {
            paymentId,
            vendorCommissionPaid: 0,
            commissionPaid: 0,
            overridePaid: 0
          };
        }

        // Separate vendor commissions from agent commissions
        if (detail.RecipientEntityType === 'Vendor') {
          paymentUpdates[paymentId].vendorCommissionPaid += parseFloat(detail.Amount);
        } else if (detail.RecipientEntityType === 'Agent') {
          paymentUpdates[paymentId].commissionPaid += parseFloat(detail.Amount);
        } else if (detail.RecipientEntityType === 'Tenant') {
          paymentUpdates[paymentId].overridePaid += parseFloat(detail.Amount);
        }
      }

      // Update each payment
      for (const update of Object.values(paymentUpdates)) {
        const updateRequest = transaction.request();
        updateRequest.input('PaymentId', sql.UniqueIdentifier, update.paymentId);
        updateRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
        updateRequest.input('VendorCommissionPaid', sql.Decimal(18, 2), update.vendorCommissionPaid);
        updateRequest.input('CommissionPaid', sql.Decimal(18, 2), update.commissionPaid);
        updateRequest.input('OverridePaid', sql.Decimal(18, 2), update.overridePaid);

        // Update payment with all payout amounts (DO NOT set NACHAId on oe.Payments as it prevents partial payments)
        await updateRequest.query(`
          UPDATE oe.Payments
          SET 
            CommissionPaid = ISNULL(CommissionPaid, 0) + @CommissionPaid,
            OverridePaid = ISNULL(OverridePaid, 0) + @OverridePaid,
            VendorCommissionPaid = ISNULL(VendorCommissionPaid, 0) + @VendorCommissionPaid,
            ModifiedDate = GETUTCDATE()
          WHERE PaymentId = @PaymentId
        `);
      }

      // Update NACHA status
      const nachaRequest = transaction.request();
      nachaRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      nachaRequest.input('UserId', sql.UniqueIdentifier, userId);

      await nachaRequest.query(`
        UPDATE oe.NACHAGenerations
        SET 
          Status = 'Sent',
          SentDate = GETUTCDATE(),
          ModifiedDate = GETUTCDATE()
        WHERE NACHAId = @NACHAId
      `);

      // Mark commissions as Paid ONLY when NACHA is marked as Sent (not at generation time)
      // Note: NACHAPaymentDetails uses RecipientEntityType = 'Agent' for both agent + agency payouts
      // Retry Bounces: re-issue rows reference an already-Paid commission, so we must skip them
      // here — otherwise we'd be flipping commissions that should already be Paid (no-op) or,
      // worse, masking commissions that should still be Pending.
      //
      // Phase 6b: also flip Refund/Chargeback rows (negative amounts) that were
      // netted into this NACHA, AND stamp AppliedToNACHAId so we can audit which
      // cycle settled which clawback. Anything that didn't settle stays
      // Status='Pending' for the next cycle (carry-forward).
      const commissionsPaidRequest = transaction.request();
      commissionsPaidRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      await commissionsPaidRequest.query(`
        UPDATE c
        SET
          c.Status = 'Paid',
          c.AppliedToNACHAId = @NACHAId,
          c.ModifiedDate = GETUTCDATE()
        FROM oe.Commissions c
        WHERE c.Status = 'Pending'
          AND c.TransactionType IN ('Advance', 'Commission', 'Refund', 'Chargeback')
          AND EXISTS (
            SELECT 1
            FROM oe.NACHAPaymentDetails d
            WHERE d.NACHAId = @NACHAId
              AND d.ReissueOfNACHAPaymentDetailId IS NULL
              AND d.RecipientEntityType IN ('Agent', 'Agency')
              -- Match payment-anchored OR invoice-anchored (credit-funded) commissions.
              AND (
                (d.PaymentId IS NOT NULL AND d.PaymentId = c.PaymentId)
                OR (d.PaymentId IS NULL AND d.InvoiceId IS NOT NULL AND d.InvoiceId = c.InvoiceId)
              )
              AND (
                (c.AgentId IS NOT NULL AND d.RecipientEntityId = c.AgentId)
                OR
                (c.AgencyId IS NOT NULL AND d.RecipientEntityId = c.AgencyId)
              )
          );
      `);

      await transaction.commit();

      logger.info('NACHA marked as sent', { nachaId, userId }, 'NACHA');

      setImmediate(() => {
        try {
          const VendorExportService = require('./vendorExportService');
          VendorExportService.runPayablesJobsTriggeredByNachaSent(nachaId).then((r) => {
            if (r && r.triggered > 0) {
              logger.info('NACHA-sent payables export jobs finished', { nachaId, triggered: r.triggered }, 'NACHA');
            }
            if (r && r.errors && r.errors.length > 0) {
              logger.warn('NACHA-sent payables export jobs had errors', { nachaId, errors: r.errors }, 'NACHA');
            }
          }).catch((err) => {
            logger.warn('NACHA-sent payables export jobs failed', { nachaId, error: err.message }, 'NACHA');
          });
        } catch (reqErr) {
          logger.warn('Could not start NACHA-sent payables jobs', { nachaId, error: reqErr.message }, 'NACHA');
        }
      });
    } catch (error) {
      await transaction.rollback();
      logger.error('Error marking NACHA as sent', {
        error: error.message,
        nachaId
      }, 'NACHA');
      throw error;
    }
  }

  /**
   * Mark NACHA as NOT sent (reverts markNACHAasSent side-effects)
   * - Sets oe.NACHAGenerations.Status back to 'Pending' and clears SentDate
   * - Reverts oe.Payments paid buckets that were incremented when marked sent (only for Payments with this NACHAId)
   * - Reverts oe.Commissions Status back to 'Pending' for commissions included in this NACHA (agent+agency)
   *
   * @param {string} nachaId - NACHA ID
   * @param {string} userId - User ID performing the action (audit only)
   * @returns {Promise<void>}
   */
  async markNACHAasNotSent(nachaId, userId) {
    const pool = await getPool();
    const transaction = pool.transaction();

    try {
      await transaction.begin();

      // Ensure NACHA exists (and is currently Sent)
      const statusRequest = transaction.request();
      statusRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      const statusResult = await statusRequest.query(`
        SELECT Status
        FROM oe.NACHAGenerations
        WHERE NACHAId = @NACHAId
      `);

      if (statusResult.recordset.length === 0) {
        throw new Error('NACHA file not found');
      }

      // Still allow reverting even if status isn't Sent, but this prevents accidental subtracts
      const currentStatus = statusResult.recordset[0].Status;
      if (currentStatus !== 'Sent') {
        throw new Error(`Cannot mark NACHA as not sent when Status = '${currentStatus}'`);
      }

      // Get payment details for this NACHA
      // Retry Bounces: re-issue rows never incremented oe.Payments paid totals (markNACHAasSent
      // skips them) — so we must NOT subtract them here either, otherwise we'd negative-shift
      // the paid totals.
      const detailRequest = transaction.request();
      detailRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      const detailsResult = await detailRequest.query(`
        SELECT
          PaymentId,
          InvoiceId,
          RecipientEntityType,
          Amount
        FROM oe.NACHAPaymentDetails
        WHERE NACHAId = @NACHAId
          AND ReissueOfNACHAPaymentDetailId IS NULL
      `);

      // Group by payment ID, separating vendor, agent, and tenant payouts (same as markNACHAasSent).
      // Credit-funded rows have PaymentId IS NULL — markNACHAasSent skipped
      // them, so we skip them here too.
      const paymentUpdates = {};
      for (const detail of detailsResult.recordset) {
        if (!detail.PaymentId) continue;
        const paymentId = detail.PaymentId.toString();
        if (!paymentUpdates[paymentId]) {
          paymentUpdates[paymentId] = {
            paymentId,
            vendorCommissionPaid: 0,
            commissionPaid: 0,
            overridePaid: 0
          };
        }

        if (detail.RecipientEntityType === 'Vendor') {
          paymentUpdates[paymentId].vendorCommissionPaid += parseFloat(detail.Amount);
        } else if (detail.RecipientEntityType === 'Agent') {
          paymentUpdates[paymentId].commissionPaid += parseFloat(detail.Amount);
        } else if (detail.RecipientEntityType === 'Tenant') {
          paymentUpdates[paymentId].overridePaid += parseFloat(detail.Amount);
        }
      }

      // Revert each payment (only where NACHAId matches this nachaId)
      for (const update of Object.values(paymentUpdates)) {
        const updateRequest = transaction.request();
        updateRequest.input('PaymentId', sql.UniqueIdentifier, update.paymentId);
        updateRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
        updateRequest.input('VendorCommissionPaid', sql.Decimal(18, 2), update.vendorCommissionPaid);
        updateRequest.input('CommissionPaid', sql.Decimal(18, 2), update.commissionPaid);
        updateRequest.input('OverridePaid', sql.Decimal(18, 2), update.overridePaid);

        await updateRequest.query(`
          UPDATE oe.Payments
          SET
            CommissionPaid = CASE WHEN ISNULL(CommissionPaid, 0) - @CommissionPaid < 0 THEN 0 ELSE ISNULL(CommissionPaid, 0) - @CommissionPaid END,
            OverridePaid = CASE WHEN ISNULL(OverridePaid, 0) - @OverridePaid < 0 THEN 0 ELSE ISNULL(OverridePaid, 0) - @OverridePaid END,
            VendorCommissionPaid = CASE WHEN ISNULL(VendorCommissionPaid, 0) - @VendorCommissionPaid < 0 THEN 0 ELSE ISNULL(VendorCommissionPaid, 0) - @VendorCommissionPaid END,
            ModifiedDate = GETUTCDATE()
          WHERE PaymentId = @PaymentId
        `);
      }

      // Revert commissions that were marked Paid by this NACHA (agent + agency)
      // Retry Bounces: re-issue rows did NOT mark any commission Paid in markNACHAasSent,
      // so we must skip them here too. Otherwise we'd flip a commission that's still
      // legitimately Paid by the original NACHA back to Pending.
      //
      // Phase 6b: also revert Refund/Chargeback rows pinned to this NACHA via
      // AppliedToNACHAId, and clear that linkage so the next cycle can pick
      // them up again.
      const commissionsRequest = transaction.request();
      commissionsRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      await commissionsRequest.query(`
        UPDATE c
        SET
          c.Status = 'Pending',
          c.AppliedToNACHAId = NULL,
          c.ModifiedDate = GETUTCDATE()
        FROM oe.Commissions c
        WHERE c.Status = 'Paid'
          AND c.TransactionType IN ('Advance', 'Commission', 'Refund', 'Chargeback')
          AND (
            c.AppliedToNACHAId = @NACHAId
            OR EXISTS (
              SELECT 1
              FROM oe.NACHAPaymentDetails d
              WHERE d.NACHAId = @NACHAId
                AND d.ReissueOfNACHAPaymentDetailId IS NULL
                AND d.RecipientEntityType = 'Agent'
                -- Match payment-anchored OR invoice-anchored (credit-funded).
                AND (
                  (d.PaymentId IS NOT NULL AND d.PaymentId = c.PaymentId)
                  OR (d.PaymentId IS NULL AND d.InvoiceId IS NOT NULL AND d.InvoiceId = c.InvoiceId)
                )
                AND (
                  (c.AgentId IS NOT NULL AND d.RecipientEntityId = c.AgentId)
                  OR
                  (c.AgencyId IS NOT NULL AND d.RecipientEntityId = c.AgencyId)
                )
            )
          );
      `);

      // Phase 6e — restore oe.PayoutClawbacks RemainingAmount for any vendor/
      // tenant clawbacks that were drained at generation. Since drains stamp
      // AppliedToNACHAId, we can find them and reverse. The original Amount
      // tells us the full magnitude; we replenish RemainingAmount up to that
      // ceiling.
      const restoreClawbacksReq = transaction.request();
      restoreClawbacksReq.input('NACHAId', sql.UniqueIdentifier, nachaId);
      try {
        await restoreClawbacksReq.query(`
          IF OBJECT_ID(N'oe.PayoutClawbacks', N'U') IS NOT NULL
          BEGIN
            UPDATE oe.PayoutClawbacks
            SET RemainingAmount = Amount,
                Status = N'Available',
                AppliedToNACHAId = NULL,
                ModifiedDate = GETUTCDATE()
            WHERE AppliedToNACHAId = @NACHAId;
          END
        `);
      } catch (restoreErr) {
        logger.warn('PayoutClawbacks restore on markNACHAasNotSent failed (table may not exist yet)', { nachaId, error: restoreErr.message }, 'NACHA');
      }

      // Update NACHA status back to Pending
      const nachaRequest = transaction.request();
      nachaRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      nachaRequest.input('UserId', sql.UniqueIdentifier, userId);
      await nachaRequest.query(`
        UPDATE oe.NACHAGenerations
        SET
          Status = 'Pending',
          SentDate = NULL,
          ModifiedDate = GETUTCDATE()
        WHERE NACHAId = @NACHAId
      `);

      await transaction.commit();
      logger.info('NACHA marked as not sent', { nachaId, userId }, 'NACHA');
    } catch (error) {
      await transaction.rollback();
      logger.error('Error marking NACHA as not sent', { error: error.message, nachaId }, 'NACHA');
      throw error;
    }
  }

  /**
   * Get NACHA generation details
   * @param {string} nachaId - NACHA ID
   * @returns {Promise<Object>} NACHA details
   */
  async getNACHADetails(nachaId) {
    const pool = await getPool();
    const request = pool.request();
    request.input('NACHAId', sql.UniqueIdentifier, nachaId);

    const result = await request.query(`
      SELECT 
        NACHAId,
        PayoutType,
        StartDate,
        EndDate,
        TenantId,
        Status,
        TotalPayouts,
        TotalAmount,
        FileName,
        GeneratedDate,
        SentDate,
        GeneratedBy,
        Notes,
        ReissueOfNACHAId
      FROM oe.NACHAGenerations
      WHERE NACHAId = @NACHAId
    `);

    if (!result.recordset[0]) return null;
    
    const nacha = result.recordset[0];
    // Convert PascalCase to camelCase for frontend compatibility
    return {
      nachaId: nacha.NACHAId,
      fileName: nacha.FileName,
      totalPayouts: nacha.TotalPayouts,
      totalAmount: nacha.TotalAmount,
      status: nacha.Status,
      generatedDate: nacha.GeneratedDate,
      payoutType: nacha.PayoutType,
      startDate: nacha.StartDate,
      endDate: nacha.EndDate,
      sentDate: nacha.SentDate,
      reissueOfNachaId: nacha.ReissueOfNACHAId || null
    };
  }

  /**
   * Delete NACHA generation (only if Pending)
   * @param {string} nachaId - NACHA ID
   * @returns {Promise<void>}
   */
  async deleteNACHA(nachaId) {
    const pool = await getPool();
    const transaction = pool.transaction();

    try {
      await transaction.begin();

      // Check status first
      const checkRequest = transaction.request();
      checkRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      const checkResult = await checkRequest.query(`
        SELECT Status FROM oe.NACHAGenerations WHERE NACHAId = @NACHAId
      `);

      if (checkResult.recordset.length === 0) {
        throw new Error('NACHA file not found');
      }

      if (checkResult.recordset[0].Status !== 'Pending') {
        throw new Error('Cannot delete NACHA file that has been sent');
      }

      // 0. Refund-time vendor/tenant clawbacks tied to detail rows in this batch:
      // void them before removing NACHAPaymentDetails so we never double-claw after
      // regeneration. Matches payment-anchored OR invoice-anchored details.
      const voidClawbacksReq = transaction.request();
      voidClawbacksReq.input('NACHAId', sql.UniqueIdentifier, nachaId);
      await voidClawbacksReq.query(`
          IF OBJECT_ID(N'oe.PayoutClawbacks', N'U') IS NOT NULL
          BEGIN
            UPDATE pc
            SET
              Status = N'Voided',
              RemainingAmount = 0,
              ModifiedDate = GETUTCDATE(),
              Notes = LEFT(CONCAT(
                ISNULL(pc.Notes, N''),
                N' [voided by deleteNACHA ',
                CAST(@NACHAId AS NVARCHAR(36)),
                N']'
              ), 500)
            FROM oe.PayoutClawbacks pc
            INNER JOIN oe.NACHAPaymentDetails npd ON npd.NACHAId = @NACHAId
              AND npd.RecipientEntityType = pc.RecipientEntityType
              AND npd.RecipientEntityId = pc.RecipientEntityId
              AND (
               (npd.PaymentId IS NOT NULL AND npd.PaymentId = pc.SourcePaymentId)
               OR (
                 npd.PaymentId IS NULL
                 AND npd.InvoiceId IS NOT NULL
                 AND EXISTS (
                   SELECT 1 FROM oe.Payments p2
                   WHERE p2.PaymentId = pc.SourcePaymentId
                     AND p2.InvoiceId = npd.InvoiceId
                 )
               )
              )
            WHERE pc.Status IN (N'Available', N'PartiallyApplied');
          END
        `);

      // 1. Unlink payments (for legacy records where NACHAId was set on oe.Payments)
      const unlinkRequest = transaction.request();
      unlinkRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      await unlinkRequest.query(`
        UPDATE oe.Payments
        SET NACHAId = NULL
        WHERE NACHAId = @NACHAId
      `);

      // 2. Delete payment details (Ledger)
      const detailsRequest = transaction.request();
      detailsRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      await detailsRequest.query(`
        DELETE FROM oe.NACHAPaymentDetails WHERE NACHAId = @NACHAId
      `);

      // 3. Delete NACHA generation
      const deleteRequest = transaction.request();
      deleteRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      await deleteRequest.query(`
        DELETE FROM oe.NACHAGenerations WHERE NACHAId = @NACHAId
      `);

      await transaction.commit();
      logger.info('NACHA deleted', { nachaId }, 'NACHA');
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}

module.exports = new NACHAService();


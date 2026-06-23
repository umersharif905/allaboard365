// backend/services/NACHAService.js
const { getPool, sql } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const commissionCalculatorService = require('./CommissionCalculatorService');
const achService = require('./ACHService');
const logger = require('../config/logger');
const Nacha = require('@midlandsbank/node-nacha').default;

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
 * NACHA Service - Generate NACHA ACH files for commission payouts
 * Implements standard NACHA file format for ACH transactions
 */
class NACHAService {
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
    const { payoutType, startDate, endDate, tenantId, vendorIds, agentIds, agencyIds, fundingAchAccountId, companyIdentification, userId } = options;

    try {
      // Validate no overlapping NACHA exists
      await this.validateNoOverlap(startDate, endDate, payoutType, tenantId);

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

      // Use stored commissions from oe.Commissions table (no dynamic recalculation)
      // This includes both agent commissions AND agency overflow commissions (stored with AgencyId)
      payoutBreakdown = commissionsToPayoutBreakdown(eligibleCommissions);
    } else {
      // For Vendor/Product Owner payouts, use existing payment-based calculation
      const payments = await this.getUnpaidPayments(startDate, endDate, tenantId);
      
      if (payments.length === 0) {
        throw new Error('No unpaid payments found in the specified date range');
      }

      // Calculate commissions for all payments
      payoutBreakdown = await this.calculatePayoutBreakdown(payments, payoutType);
    }

      // Filter payouts by type
      const filteredPayouts = this.filterPayoutsByType(payoutBreakdown, payoutType);

      // Group payouts by recipient
      let groupedPayouts = this.groupPayoutsByRecipient(filteredPayouts);
      
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
            const payments = await this.getUnpaidPayments(startDate, endDate, null);
            if (payments.length > 0) {
              // Get tenantId from the first payment's enrollments
              const pool = await getPool();
              const request = pool.request();
              request.input('PaymentId', sql.UniqueIdentifier, payments[0].PaymentId);
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
        payoutsWithACH
      });

      console.log('✅ NACHA saved with totals:', {
        nachaId,
        totalPayouts,
        totalAmount
      });

      // Create payment detail records (filtered and split)
      await this.createPaymentDetails(nachaId, payoutsWithACH);

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
        }))
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
    let baseFilter = '';
    if (nachaId) {
      baseFilter = `
        INNER JOIN oe.NACHAPaymentDetails npd ON p.PaymentId = npd.PaymentId
        WHERE npd.NACHAId = @NACHAId
          AND npd.RecipientEntityType = @EntityType
          AND npd.RecipientEntityId = @EntityId
      `;
    } else {
      // Preview mode - look for pending commissions
      baseFilter = `
        INNER JOIN oe.Commissions c ON p.PaymentId = c.PaymentId
        WHERE c.Status = 'Pending'
          AND c.TransactionType IN ('Advance', 'Commission')
          AND (
            (@EntityType = 'Agent' AND c.AgentId = @EntityId)
            OR
            (@EntityType = 'Agency' AND c.AgencyId = @EntityId)
          )
          AND p.PaymentDate >= @StartDate AND p.PaymentDate <= @EndDate
      `;
    }

    // 1. Detailed Payments Query
    const paymentsQuery = `
      SELECT 
        p.PaymentId,
        p.PaymentDate,
        p.Amount as PaymentAmount,
        -- Commission paid/owed to this entity for this payment
        COALESCE(
          (SELECT SUM(Amount) FROM oe.NACHAPaymentDetails WHERE NACHAId = @NACHAId AND PaymentId = p.PaymentId AND RecipientEntityId = @EntityId),
          (SELECT SUM(Amount) FROM oe.Commissions WHERE PaymentId = p.PaymentId AND Status = 'Pending' AND ((@EntityType = 'Agent' AND AgentId = @EntityId) OR (@EntityType = 'Agency' AND AgencyId = @EntityId)))
        ) as CommissionAmount,
        -- Member/Group Info
        u.FirstName + ' ' + u.LastName as MemberName,
        m.MemberId,
        g.Name as GroupName,
        g.GroupId,
        -- Product Info (Primary Product)
        pr.Name as ProductName,
        -- Rule/Commission Type
        cr.RuleName,
        cr.CommissionType,
        m.Tier as MemberTier
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
      LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
      LEFT JOIN oe.CommissionRules cr ON e.CommissionRuleId = cr.RuleId
      ${baseFilter}
      ORDER BY p.PaymentDate DESC
    `;

    const paymentsResult = await request.query(paymentsQuery);
    const payments = paymentsResult.recordset.map(row => ({
      paymentId: row.PaymentId,
      paymentDate: row.PaymentDate,
      paymentAmount: Number(row.PaymentAmount),
      commissionAmount: Number(row.CommissionAmount),
      memberName: row.MemberName,
      memberId: row.MemberId,
      groupName: row.GroupName,
      groupId: row.GroupId,
      productName: row.ProductName,
      ruleName: row.RuleName,
      commissionType: row.CommissionType,
      memberTier: row.MemberTier
    }));

    // 2. Groups Aggregation
    const groupsMap = new Map();
    payments.forEach(p => {
      const key = p.groupId || 'INDIVIDUAL';
      const name = p.groupName || 'Individual';
      
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          groupId: key,
          groupName: name,
          householdCount: new Set(),
          totalPremium: 0,
          totalCommission: 0
        });
      }
      
      const group = groupsMap.get(key);
      group.householdCount.add(p.memberId);
      group.totalPremium += p.paymentAmount;
      group.totalCommission += p.commissionAmount;
    });

    const groups = Array.from(groupsMap.values()).map(g => ({
      ...g,
      householdCount: g.householdCount.size
    }));

    // 3. Individuals Aggregation
    const individualsMap = new Map();
    payments.forEach(p => {
      const key = p.memberId;
      if (!key) return; 

      if (!individualsMap.has(key)) {
        individualsMap.set(key, {
          memberId: key,
          memberName: p.memberName,
          totalPremium: 0,
          totalCommission: 0
        });
      }
      const ind = individualsMap.get(key);
      ind.totalPremium += p.paymentAmount;
      ind.totalCommission += p.commissionAmount;
    });

    const individuals = Array.from(individualsMap.values());

    // 4. Products Aggregation
    const productsMap = new Map();
    payments.forEach(p => {
      const prodName = p.productName || 'Unknown Product';
      const tier = p.memberTier || 'Standard';
      const key = `${prodName}_${tier}`;

      if (!productsMap.has(key)) {
        productsMap.set(key, {
          productName: prodName,
          tier: tier,
          count: 0,
          totalPremium: 0,
          totalCommission: 0
        });
      }
      const prod = productsMap.get(key);
      prod.count += 1;
      prod.totalPremium += p.paymentAmount;
      prod.totalCommission += p.commissionAmount;
    });

    const products = Array.from(productsMap.values());

    // 5. Summary
    const summary = {
      totalRevenue: payments.reduce((sum, p) => sum + p.paymentAmount, 0),
      totalCommission: payments.reduce((sum, p) => sum + p.commissionAmount, 0),
      paymentCount: payments.length
    };

    return {
      summary,
      payments,
      groups,
      individuals,
      products
    };
  }

  /**
   * Get detailed export data for ALL entities in the current selection/NACHA
   * Used for "Export All" functionality.
   */
  async getAllExportDetails(startDate, endDate, nachaId = null, entityTypes = []) {
    const pool = await getPool();
    const request = pool.request();
    
    if (startDate) request.input('StartDate', sql.Date, startDate);
    if (endDate) request.input('EndDate', sql.Date, endDate);
    request.input('NACHAId', sql.UniqueIdentifier, nachaId || null);

    let finalQuery = '';
    
    if (nachaId) {
        finalQuery = `
          SELECT 
            p.PaymentId,
            p.PaymentDate,
            p.Amount as PaymentAmount,
            npd.RecipientEntityType as RecipientType,
            npd.RecipientEntityId as RecipientId,
            npd.Amount as CommissionAmount,
            u.FirstName + ' ' + u.LastName as MemberName,
            m.MemberId,
            g.Name as GroupName,
            g.GroupId,
            pr.Name as ProductName,
            cr.RuleName,
            m.Tier as MemberTier,
            -- Resolve Names
            CASE 
              WHEN npd.RecipientEntityType = 'Agent' THEN au.FirstName + ' ' + au.LastName
              WHEN npd.RecipientEntityType = 'Agency' THEN ag.AgencyName
              WHEN npd.RecipientEntityType = 'Vendor' THEN v.VendorName
              ELSE 'Unknown'
            END as RecipientName
          FROM oe.NACHAPaymentDetails npd
          JOIN oe.Payments p ON npd.PaymentId = p.PaymentId
          LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
          LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
          LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
          LEFT JOIN oe.CommissionRules cr ON e.CommissionRuleId = cr.RuleId
          
          -- Name Resolution Joins
          LEFT JOIN oe.Agents a ON npd.RecipientEntityType = 'Agent' AND npd.RecipientEntityId = a.AgentId
          LEFT JOIN oe.Users au ON a.UserId = au.UserId
          LEFT JOIN oe.Agencies ag ON npd.RecipientEntityType = 'Agency' AND npd.RecipientEntityId = ag.AgencyId
          LEFT JOIN oe.Vendors v ON npd.RecipientEntityType = 'Vendor' AND npd.RecipientEntityId = v.VendorId
          
          WHERE npd.NACHAId = @NACHAId
          ${entityTypes && entityTypes.length > 0 ? `AND npd.RecipientEntityType IN (${entityTypes.map(t => `'${t.replace(/'/g, "''")}'`).join(',')})` : ''}
          ORDER BY npd.RecipientEntityType, RecipientName, p.PaymentDate
        `;
    } else {
        // Preview Mode (Commission centric)
        // We iterate over Commissions pending
        finalQuery = `
          SELECT 
            p.PaymentId,
            p.PaymentDate,
            p.Amount as PaymentAmount,
            CASE WHEN c.AgentId IS NOT NULL THEN 'Agent' ELSE 'Agency' END as RecipientType,
            COALESCE(c.AgentId, c.AgencyId) as RecipientId,
            c.Amount as CommissionAmount,
            u.FirstName + ' ' + u.LastName as MemberName,
            m.MemberId,
            g.Name as GroupName,
            g.GroupId,
            pr.Name as ProductName,
            cr.RuleName,
            m.Tier as MemberTier,
            -- Resolve Names
            CASE 
              WHEN c.AgentId IS NOT NULL THEN au.FirstName + ' ' + au.LastName
              WHEN c.AgencyId IS NOT NULL THEN ag.AgencyName
              ELSE 'Unknown'
            END as RecipientName
          FROM oe.Commissions c
          JOIN oe.Payments p ON c.PaymentId = p.PaymentId
          LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
          LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
          LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
          LEFT JOIN oe.CommissionRules cr ON e.CommissionRuleId = cr.RuleId
          
          -- Name Resolution Joins
          LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
          LEFT JOIN oe.Users au ON a.UserId = au.UserId
          LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
          
          WHERE c.Status = 'Pending'
            AND c.TransactionType IN ('Advance', 'Commission')
            AND p.PaymentDate >= @StartDate AND p.PaymentDate <= @EndDate
          ORDER BY RecipientType, RecipientName, p.PaymentDate
        `;
    }

    const result = await request.query(finalQuery);
    
    const allPayments = result.recordset.map(row => ({
      paymentId: row.PaymentId,
      paymentDate: row.PaymentDate,
      paymentAmount: Number(row.PaymentAmount),
      recipientType: row.RecipientType,
      recipientId: row.RecipientId,
      recipientName: row.RecipientName,
      commissionAmount: Number(row.CommissionAmount),
      memberName: row.MemberName,
      groupName: row.GroupName || 'Individual',
      productName: row.ProductName,
      ruleName: row.RuleName,
      memberTier: row.MemberTier
    }));

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
  }

  /**
   * Validate no overlapping NACHA exists for date range
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @param {string} payoutType - Payout type
   * @param {string} tenantId - Tenant ID (optional)
   * @throws {Error} If overlap exists
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
      const overlap = result.recordset[0];
      throw new Error(
        `Overlapping NACHA file exists for date range ${overlap.StartDate} to ${overlap.EndDate}. ` +
        `Please remove or send the existing file (ID: ${overlap.NACHAId}) before creating a new one.`
      );
    }
  }

  /**
   * Get unpaid payments in date range
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @param {string} tenantId - Tenant ID filter (optional)
   * @returns {Promise<Array>} Array of payment records
   */
  async getUnpaidPayments(startDate, endDate, tenantId = null) {
    console.log('🔍 getUnpaidPayments called:', { startDate, endDate, tenantId });
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
      result = await request.query(`
        SELECT 
          p.PaymentId,
          p.Amount,
          p.PaymentDate,
          p.EnrollmentId,
          p.HouseholdId,
          p.GroupId,
          p.AgentId,
          p.TenantId,
          -- For individual/household payments, get ProductId from enrollment
          -- For group payments, get ProductId from first enrollment in the group
          COALESCE(
            e.ProductId,
            (SELECT TOP 1 e2.ProductId 
             FROM oe.Enrollments e2
             INNER JOIN oe.Members m2 ON e2.MemberId = m2.MemberId
             WHERE m2.GroupId = p.GroupId 
               AND e2.Status = 'Active'
               AND e2.EffectiveDate <= GETUTCDATE()
               AND (e2.TerminationDate IS NULL OR e2.TerminationDate > GETUTCDATE())
             ORDER BY e2.CreatedDate ASC)
          ) as ProductId,
          e.MemberId,
          ISNULL(p.Commission, 0) as Commission,
          ISNULL(p.CommissionPaid, 0) as CommissionPaid,
          ISNULL(p.OverrideRate, 0) as OverrideRate,
          ISNULL(p.OverridePaid, 0) as OverridePaid,
          ISNULL(p.NetRate, 0) as NetRate,
          ISNULL(p.SystemFees, 0) as SystemFees,
          ISNULL(p.VendorCommissionPaid, 0) as VendorCommissionPaid,
          -- Join to product to get product owner tenant (for hold period)
          -- For group payments, use the first product's owner
          COALESCE(
            pr.ProductOwnerId,
            (SELECT TOP 1 pr2.ProductOwnerId
             FROM oe.Enrollments e2
             INNER JOIN oe.Members m2 ON e2.MemberId = m2.MemberId
             INNER JOIN oe.Products pr2 ON e2.ProductId = pr2.ProductId
             WHERE m2.GroupId = p.GroupId 
               AND e2.Status = 'Active'
               AND e2.EffectiveDate <= GETUTCDATE()
               AND (e2.TerminationDate IS NULL OR e2.TerminationDate > GETUTCDATE())
             ORDER BY e2.CreatedDate ASC)
          ) as ProductOwnerId
        FROM oe.Payments p
        LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
        LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
        LEFT JOIN oe.Tenants t ON t.TenantId = COALESCE(
          pr.ProductOwnerId,
          (SELECT TOP 1 pr2.ProductOwnerId
           FROM oe.Enrollments e2
           INNER JOIN oe.Members m2 ON e2.MemberId = m2.MemberId
           INNER JOIN oe.Products pr2 ON e2.ProductId = pr2.ProductId
           WHERE m2.GroupId = p.GroupId 
             AND e2.Status = 'Active'
             AND e2.EffectiveDate <= GETUTCDATE()
             AND (e2.TerminationDate IS NULL OR e2.TerminationDate > GETUTCDATE())
           ORDER BY e2.CreatedDate ASC)
        )
        WHERE p.Status IN ('Completed', 'APPROVAL', 'succeeded')
          -- Capture all historical unpaid items up to the EndDate (ignore StartDate for eligibility)
          -- AND CAST(p.PaymentDate AS DATE) >= CAST(@StartDate AS DATE)
          -- Apply commission hold period: PaymentDate + holdDays (+ 1 if countFrom = 'nextDay') <= EndDate
          -- Default holdDays = 0, default holdDaysCountFrom = 'paymentDate' (no extra day)
          AND DATEADD(day, 
             ISNULL(CAST(JSON_VALUE(t.AdvancedSettings, '$.commissions.holdDays') AS INT), 0) + 
             CASE WHEN JSON_VALUE(t.AdvancedSettings, '$.commissions.holdDaysCountFrom') = 'nextDay' THEN 1 ELSE 0 END,
             CAST(p.PaymentDate AS DATE)
           ) <= CAST(@EndDate AS DATE)
          ${tenantFilter}
        ORDER BY p.PaymentDate ASC
      `);
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

    return result.recordset;
  }

  /**
   * Calculate payout breakdown for payments
   * @param {Array} payments - Array of payment records
   * @param {string} payoutType - Payout type filter
   * @returns {Promise<Array>} Payout breakdown
   */
  async calculatePayoutBreakdown(payments, payoutType) {
    const breakdown = [];

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

        // Do not rely on a single ProductId on the payment record. Vendor/Product Owner payouts use
        // snapshot JSON (ProductVendorAmounts/ProductOwnerAmounts) and enrollmentProductIds fallback.

        // Check previously paid amounts to calculate remaining balance
        // Only count payments from NACHA files that have been marked as 'Sent'
        const paidRequest = pool.request();
        paidRequest.input('PaymentId', sql.UniqueIdentifier, payment.PaymentId);
        const paidResult = await paidRequest.query(`
          SELECT npd.RecipientEntityType, npd.RecipientEntityId, SUM(npd.Amount) as PaidAmount
          FROM oe.NACHAPaymentDetails npd
          INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
          WHERE npd.PaymentId = @PaymentId
            AND ng.Status = 'Sent'
          GROUP BY npd.RecipientEntityType, npd.RecipientEntityId
        `);
        
        const paidAmounts = new Map(); // Key: `${Type}_${Id}`, Value: Amount
        for (const row of paidResult.recordset) {
          const key = `${row.RecipientEntityType}_${row.RecipientEntityId}`.toUpperCase();
          paidAmounts.set(key, (paidAmounts.get(key) || 0) + Number(row.PaidAmount));
        }

        // Get enrollment product IDs and commission amounts per product for this payment
        // Also get payment's householdId, groupId, ProductCommissions, ProductVendorAmounts, and ProductOwnerAmounts JSON
        const paymentRequest = pool.request();
        paymentRequest.input('PaymentId', sql.UniqueIdentifier, payment.PaymentId);
        const paymentDetails = await paymentRequest.query(`
          SELECT HouseholdId, GroupId, EnrollmentId, ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts 
          FROM oe.Payments 
          WHERE PaymentId = @PaymentId
        `);
        const paymentDetail = paymentDetails.recordset[0] || {};
        const householdId = paymentDetail.HouseholdId || null;
        const groupId = paymentDetail.GroupId || null;
        const paymentEnrollmentId = paymentDetail.EnrollmentId || null;
        const paymentProductCommissions = paymentDetail.ProductCommissions || null;
        const paymentProductVendorAmounts = paymentDetail.ProductVendorAmounts || null;
        const paymentProductOwnerAmounts = paymentDetail.ProductOwnerAmounts || null;
        
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
        enrollmentRequest.input('PaymentId', sql.UniqueIdentifier, payment.PaymentId);
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
                // Store enrolled households count - require enrolledHouseholdsCount field
                if (data.enrolledHouseholdsCount !== undefined) {
                  const householdsCount = data.enrolledHouseholdsCount || 0;
                  if (householdsCount > 0) {
                    productEnrollmentCounts.set(productIdStr.toUpperCase(), householdsCount);
                  }
                } else {
                  logger.warn('Missing enrolledHouseholdsCount in ProductCommissions JSON', {
                    paymentId: payment.PaymentId,
                    productId: productIdStr
                  }, 'NACHA');
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

        // Calculate commissions
        const calculationProductId =
          Array.from(productVendorAmountsMap.keys())[0] ||
          Array.from(productOwnerAmountsMap.keys())[0] ||
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

        logger.info('Commission calculation result', {
          paymentId: payment.PaymentId,
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

        // Add to breakdown
        breakdown.push({
          paymentId: payment.PaymentId,
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
        
        // Also add Primary Agency overflow payouts (Agencies are part of Agent Commission Payouts)
        const tenants = calculation.distribution?.tenants || [];
        for (const tenantPayout of tenants) {
          if (tenantPayout.isPrimaryAgency) {
            payouts.push({
              paymentId: item.paymentId,
              entityType: 'Agency',
              entityId: tenantPayout.tenantId, // Actually AgencyId
              amount: tenantPayout.amount,
              isOverflow: true,
              isPrimaryAgency: true,
              ruleId: tenantPayout.ruleId,
              ruleName: tenantPayout.ruleName,
              // Include revenue (payment amount) for display - use item.revenue from commissionsToPayoutBreakdown
              revenue: item.revenue || item.paymentAmount || calculation.paymentAmount || 0,
              // Agencies don't have commission pools, only overflow
              commissionPool: 0
            });
          }
        }
      } else if (payoutType === 'Vendor Payouts') {
        // Add vendor payouts
        for (const vendorPayout of calculation.distribution.vendors || []) {
          payouts.push({
            paymentId: item.paymentId,
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
        // Product Owner Payouts: ONLY Tenants (OverrideRate), exclude Primary Agency overflow
        // Primary Agency overflow goes to Agent Commission Payouts instead
        for (const tenantPayout of calculation.distribution.tenants || []) {
          // Skip Primary Agency overflow - that goes to Agent Commission Payouts
          if (tenantPayout.isPrimaryAgency) {
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
          
          payouts.push({
            paymentId: item.paymentId,
            entityType: 'Tenant',
            entityId: tenantPayout.tenantId,
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
            isUnknownDestination: tenantPayout.tenantId === 'UNKNOWN' || tenantPayout.tenantId === 'unknown'
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
          // Preserve product information for Unknown entries
          productId: payout.productId || null,
          productName: payout.productName || null,
          missingOverrideDestination: payout.missingOverrideDestination || false,
          isUnknownDestination: payout.isUnknownDestination || payout.entityId === 'UNKNOWN' || payout.entityId === 'unknown'
        };
      }
      grouped[key].amount += payout.amount;
      grouped[key].payoutDetails.push(payout);
      
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
          // For product owner payouts, check ProductOverrideACH table instead of regular ACHAccounts
          const pool = await getPool();
          const request = pool.request();
          request.input('TenantId', sql.UniqueIdentifier, payout.entityId);

          const overrideResult = await request.query(`
            SELECT TOP 1
              OverrideACHId,
              TenantId,
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

          if (overrideResult.recordset.length === 0) {
            // No active override ACH account - add to excluded list
            const entityName = await this.getEntityName(
              payout.entityType,
              payout.entityId
            ).catch(() => payout.entityId);
            
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
            const entityName = await this.getEntityName(
              payout.entityType,
              payout.entityId
            ).catch(() => payout.entityId);
            
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

          // Get entity name
          const entityName = await this.getEntityName(
            payout.entityType,
            payout.entityId
          );

          enhanced.push({
            ...payout,
            accountHolderName: overrideAccount.AccountHolderName || entityName,
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

    const companyIdRaw = (metadata?.companyIdentification || '').toString().trim();
    if (!/^\d{10}$/.test(companyIdRaw)) {
      throw new Error(`Invalid companyIdentification. Expected exactly 10 digits, got: ${companyIdRaw}`);
    }

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
    // Immediate Origin: Company Identification (10 digits)
    // NOTE: This is required by many bank validators and should be explicitly provided by the user.
    const companyIdRaw = (arguments.length >= 3 ? arguments[2] : '').toString().trim();
    if (!/^\d{10}$/.test(companyIdRaw)) {
      throw new Error(`Invalid companyIdentification. Expected exactly 10 digits, got: ${companyIdRaw}`);
    }
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
    // Company Identification: 10 digits (required)
    const companyIdRaw = (metadata?.companyIdentification || '').toString().trim();
    if (!/^\d{10}$/.test(companyIdRaw)) {
      throw new Error(`Invalid companyIdentification. Expected exactly 10 digits, got: ${companyIdRaw}`);
    }
    const companyIdentification = companyIdRaw;
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
    const companyIdRaw = (companyIdentificationOverride || '').toString().trim();
    if (!/^\d{10}$/.test(companyIdRaw)) {
      throw new Error(`Invalid companyIdentification. Expected exactly 10 digits, got: ${companyIdRaw}`);
    }
    const companyIdentification = companyIdRaw;
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

    await request.query(`
      INSERT INTO oe.NACHAGenerations (
        NACHAId, PayoutType, StartDate, EndDate, TenantId, Status,
        TotalPayouts, TotalAmount, FileContent, FileName, GeneratedBy,
        GeneratedDate, CreatedDate, ModifiedDate
      )
      VALUES (
        @NACHAId, @PayoutType, @StartDate, @EndDate, @TenantId, @Status,
        @TotalPayouts, @TotalAmount, @FileContent, @FileName, @GeneratedBy,
        GETUTCDATE(), GETUTCDATE(), GETUTCDATE()
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

            const detailRequest = transaction.request();
            detailRequest.input('NACHAPaymentDetailId', sql.UniqueIdentifier, uuidv4());
            detailRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
            detailRequest.input('PaymentId', sql.UniqueIdentifier, detail.paymentId);
            detailRequest.input('RecipientEntityType', sql.NVarChar, payout.entityType);
            detailRequest.input('RecipientEntityId', sql.UniqueIdentifier, payout.entityId);
            detailRequest.input('CommissionRuleId', sql.UniqueIdentifier, detail.ruleId || null);
            detailRequest.input('TierLevel', TIER_LEVEL_SQL, detail.tierLevel !== undefined ? detail.tierLevel : null);
            detailRequest.input('Amount', sql.Decimal(18, 2), amount);
            detailRequest.input('ACHAccountId', sql.UniqueIdentifier, payout.achAccountId || null);

            await detailRequest.query(`
              INSERT INTO oe.NACHAPaymentDetails (
                NACHAPaymentDetailId, NACHAId, PaymentId, RecipientEntityType,
                RecipientEntityId, CommissionRuleId, TierLevel, Amount, ACHAccountId, CreatedDate
              )
              VALUES (
                @NACHAPaymentDetailId, @NACHAId, @PaymentId, @RecipientEntityType,
                @RecipientEntityId, @CommissionRuleId, @TierLevel, @Amount, @ACHAccountId, GETUTCDATE()
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

      // CRITICAL: Prevent double-payments (Race Condition Check)
      // Check if any payment details in this NACHA file have already been marked as 'Sent' in another NACHA file
      const validationRequest = transaction.request();
      validationRequest.input('CurrentNACHAId', sql.UniqueIdentifier, nachaId);
      const validationResult = await validationRequest.query(`
        SELECT TOP 1 
          d1.PaymentId, 
          d1.RecipientEntityId, 
          d1.RecipientEntityType,
          g2.FileName as ConflictingFile
        FROM oe.NACHAPaymentDetails d1
        INNER JOIN oe.NACHAPaymentDetails d2 ON 
          d1.PaymentId = d2.PaymentId AND 
          d1.RecipientEntityId = d2.RecipientEntityId AND 
          d1.RecipientEntityType = d2.RecipientEntityType
        INNER JOIN oe.NACHAGenerations g2 ON d2.NACHAId = g2.NACHAId
        WHERE d1.NACHAId = @CurrentNACHAId
          AND g2.Status = 'Sent'
          AND g2.NACHAId != @CurrentNACHAId
      `);

      if (validationResult.recordset.length > 0) {
        const conflict = validationResult.recordset[0];
        throw new Error(`Payment conflict detected: Payment ${conflict.PaymentId} to ${conflict.RecipientEntityType} ${conflict.RecipientEntityId} was already paid in file '${conflict.ConflictingFile}'. Cannot mark as sent.`);
      }

      // Get payment details for this NACHA
      const detailRequest = transaction.request();
      detailRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      const detailsResult = await detailRequest.query(`
        SELECT 
          PaymentId,
          RecipientEntityType,
          Amount,
          CommissionRuleId
        FROM oe.NACHAPaymentDetails
        WHERE NACHAId = @NACHAId
      `);

      // Group by payment ID, separating vendor, agent, and tenant payouts
      const paymentUpdates = {};
      for (const detail of detailsResult.recordset) {
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
      const commissionsPaidRequest = transaction.request();
      commissionsPaidRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      await commissionsPaidRequest.query(`
        UPDATE c
        SET
          c.Status = 'Paid',
          c.ModifiedDate = GETUTCDATE()
        FROM oe.Commissions c
        WHERE c.Status = 'Pending'
          AND c.TransactionType IN ('Advance', 'Commission')
          AND EXISTS (
            SELECT 1
            FROM oe.NACHAPaymentDetails d
            WHERE d.NACHAId = @NACHAId
              AND d.RecipientEntityType IN ('Agent', 'Agency')
              AND d.PaymentId = c.PaymentId
              AND (
                (c.AgentId IS NOT NULL AND d.RecipientEntityId = c.AgentId)
                OR
                (c.AgencyId IS NOT NULL AND d.RecipientEntityId = c.AgencyId)
              )
          );
      `);

      await transaction.commit();

      logger.info('NACHA marked as sent', { nachaId, userId }, 'NACHA');
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
      const detailRequest = transaction.request();
      detailRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      const detailsResult = await detailRequest.query(`
        SELECT
          PaymentId,
          RecipientEntityType,
          Amount
        FROM oe.NACHAPaymentDetails
        WHERE NACHAId = @NACHAId
      `);

      // Group by payment ID, separating vendor, agent, and tenant payouts (same as markNACHAasSent)
      const paymentUpdates = {};
      for (const detail of detailsResult.recordset) {
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
      const commissionsRequest = transaction.request();
      commissionsRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
      await commissionsRequest.query(`
        UPDATE c
        SET
          c.Status = 'Pending',
          c.ModifiedDate = GETUTCDATE()
        FROM oe.Commissions c
        WHERE c.Status = 'Paid'
          AND c.TransactionType IN ('Advance', 'Commission')
          AND EXISTS (
            SELECT 1
            FROM oe.NACHAPaymentDetails d
            WHERE d.NACHAId = @NACHAId
              AND d.RecipientEntityType = 'Agent'
              AND d.PaymentId = c.PaymentId
              AND (
                (c.AgentId IS NOT NULL AND d.RecipientEntityId = c.AgentId)
                OR
                (c.AgencyId IS NOT NULL AND d.RecipientEntityId = c.AgencyId)
              )
          );
      `);

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
        Notes
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
      sentDate: nacha.SentDate
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


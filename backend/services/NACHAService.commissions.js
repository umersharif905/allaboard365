// backend/services/NACHAService.commissions.js
// Helper methods for NACHA to query oe.Commissions table
const { getPool, sql } = require('../config/database');
const logger = require('../config/logger');
const {
  PAID_PAYMENT_STATUSES_SQL,
  agentCommissionDueWindowSql,
  agentCommissionClawbackWindowSql,
  agentCommissionCreditBranchWindowSql,
} = require('./payoutFunding.service');

/**
 * Get eligible commissions for NACHA payout
 * Uses oe.Commissions table instead of calculating on-the-fly
 * Returns commissions in the selected PaymentDate range.
 * Hold-period handling is now UI-only; backend no longer excludes by hold date.
 * 
 * @param {Date} startDate - Start date for payment range
 * @param {Date} endDate - End date for payment range
 * @param {string} tenantId - Tenant ID filter (optional)
 * @param {string} payoutType - 'Agent Commission Payouts', 'Vendor Payouts', 'Product Owner Payouts'
 * @returns {Promise<Array>} Array of eligible commission records
 */
async function getEligibleCommissions(startDate, endDate, tenantId = null, payoutType = 'Agent Commission Payouts') {
  const pool = await getPool();
  const request = pool.request();

  // Use DateTime2 to preserve time component for accurate comparisons
  // Dates should already be in UTC with startDate at 00:00:00.000 and endDate at 23:59:59.999
  request.input('StartDate', sql.DateTime2, startDate);
  request.input('EndDate', sql.DateTime2, endDate);

  let tenantFilter = '';
  if (tenantId) {
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    tenantFilter = 'AND t.TenantId = @TenantId';
  }

  // For Agent Commission Payouts, query oe.Commissions
  if (payoutType === 'Agent Commission Payouts') {
    // The selected commission columns and joins are factored out so the
    // payment-anchored and invoice-anchored branches can share the same SELECT
    // shape. (Final SELECT * AS-IS to keep the recordset shape exactly the
    // same as before for downstream commissionsToPayoutBreakdown.)
    const commissionSelectAndJoins = `
      SELECT
        c.CommissionId,
        c.AgentId,
        c.AgencyId,
        c.Amount,
        c.Status,
        c.TransactionType,
        c.OriginalCommissionId,
        c.AdvanceBalance,
        c.PeriodStartDate,
        c.PeriodEndDate,
        c.PaymentId,
        c.CreatedDate,
        c.RuleIds,
        COALESCE(a.TenantId, ag.TenantId) as TenantId,
        COALESCE(au.FirstName + ' ' + au.LastName, ag.AgencyName) as AgentName,
        CASE WHEN c.AgencyId IS NOT NULL THEN 'Agency' ELSE 'Agent' END as EntityType,
        COALESCE(c.AgentId, c.AgencyId) as EntityId,
        -- Payment data for revenue and commission pool
        -- Invoice-sourced payouts: prefer invoice breakdowns with payment fallback
        COALESCE(p.Amount, inv.TotalAmount) as PaymentAmount,
        COALESCE(inv.Commission, p.Commission) as CommissionPool,
        COALESCE(p.PaymentDate, inv.BillingPeriodStart) as PaymentDate,
        COALESCE(p.EnrollmentId, c.EnrollmentId) as EnrollmentId,
        -- FundingSource: 'Payment' if a payment row backs the commission,
        -- 'Credit' if it's invoice-anchored only.
        CASE WHEN p.PaymentId IS NULL THEN 'Credit' ELSE 'Payment' END as FundingSource,
        c.InvoiceId,
        -- Rule information (first rule from RuleIds JSON array)
        cr.RuleId as FirstRuleId,
        cr.RuleName as FirstRuleName,
        cr.CommissionType as FirstRuleCommissionType,
        cr.TierLevel as FirstRuleTierLevel,
        -- Agent's tier level (from CommissionTierLevel, or hierarchy-based TierLevel as fallback)
        -- This is the agent's actual tier level (0, 1, 2, etc.), not the rule's tier configuration
        ISNULL(a.CommissionTierLevel, upline.HierarchyTierLevel) as AgentTierLevel,
        -- Agency's tier level (from CommissionTierLevel)
        -- Agencies can also receive commissions (overflow), and they have tier levels too
        ag.CommissionTierLevel as AgencyTierLevel
      FROM oe.Commissions c
      LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
      LEFT JOIN oe.Users au ON a.UserId = au.UserId
      -- Also check AgencyId (for agency overflow commissions)
      LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
      -- Join to tenants for both agents and agencies (using COALESCE to get the correct tenant)
      LEFT JOIN oe.Tenants t ON t.TenantId = COALESCE(a.TenantId, ag.TenantId)
      LEFT JOIN oe.Payments p ON c.PaymentId = p.PaymentId
      -- Invoice can be reached via the payment OR (for credit-funded commissions)
      -- directly from c.InvoiceId.
      LEFT JOIN oe.Invoices inv ON inv.InvoiceId = COALESCE(p.InvoiceId, c.InvoiceId)
      -- Get agent's tier level from upline function (for hierarchy-based tier level)
      OUTER APPLY (
        SELECT TOP 1 u.TierLevel as HierarchyTierLevel
        FROM oe.fn_GetAgentUplineForCommission(c.AgentId) u
        WHERE u.AgentId = c.AgentId
      ) upline
      LEFT JOIN oe.CommissionRules cr ON (
        -- Extract first rule ID from RuleIds JSON array (handle null/empty).
        -- NOTE: oe.Commissions.RuleIds also carries non-JSON sentinel strings
        -- like 'AGENT_OVERRIDE:<id>' (see commissionService.advances.resolveAgentOverrides).
        -- SQL Server doesn't guarantee AND short-circuit in JOIN/WHERE, so an
        -- AND ISJSON(...) = 1 guard isn't enough — JSON_VALUE still runs and
        -- bombs ("JSON text is not properly formatted. Unexpected character 'A'
        -- is found at position 0."). CASE WHEN is the only way to gate it
        -- safely; CASE expressions are guaranteed short-circuit evaluation.
        cr.RuleId = CAST(
          CASE
            WHEN c.RuleIds IS NOT NULL
              AND c.RuleIds <> ''
              AND c.RuleIds <> '[]'
              AND ISJSON(c.RuleIds) = 1
            THEN JSON_VALUE(c.RuleIds, '$[0]')
            ELSE NULL
          END
          AS UNIQUEIDENTIFIER
        )
      )
    `;

    const commissionStatusFilter = `
      c.Status = 'Pending'
      -- Phase 6a: include negative Refund/Chargeback rows so NACHA cycle nets
      -- them against positive Advance/Commission rows for the same recipient.
      -- Carry-forward across cycles is automatic — anything that doesn't
      -- settle stays Status='Pending' for the next run.
      AND c.TransactionType IN ('Advance', 'Commission', 'Refund', 'Chargeback')
      AND c.Amount != 0
    `;

    const query = `
      -- Branch 1: Payment-anchored commissions (existing behavior).
      ${commissionSelectAndJoins}
      WHERE ${commissionStatusFilter}
        AND c.PaymentId IS NOT NULL
        AND (
          (c.TransactionType IN ('Refund', 'Chargeback')
            AND ${agentCommissionClawbackWindowSql()})
          OR (c.TransactionType NOT IN ('Refund', 'Chargeback')
            AND p.PaymentDate IS NOT NULL
            AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
            AND ${agentCommissionDueWindowSql()})
        )
        ${tenantFilter}

      UNION ALL

      -- Branch 2: Invoice-anchored / credit-funded commissions.
      -- Commission row was created when an invoice flipped to Status='Paid'
      -- via household credit (no oe.Payments row). The commission carries
      -- InvoiceId instead of PaymentId.
      ${commissionSelectAndJoins}
      WHERE ${commissionStatusFilter}
        AND c.PaymentId IS NULL
        AND c.InvoiceId IS NOT NULL
        AND inv.Status = N'Paid'
        AND ${agentCommissionCreditBranchWindowSql('inv')}
        ${tenantFilter}

      ORDER BY CreatedDate ASC
    `;

    const result = await request.query(query);
    
    logger.info('getEligibleCommissions query result', {
      count: result.recordset.length,
      startDate,
      endDate,
      payoutType,
      tenantFilter: !!tenantId
    }, 'NACHA');

    return result.recordset;
  }

  // For Vendor/Product Owner payouts, still use existing payment-based calculation
  // (these are not stored in oe.Commissions)
  return [];
}

/**
 * Convert commission records to payout breakdown format
 * Compatible with existing NACHA filterPayoutsByType logic
 * Includes revenue, commission pool, and rule details for display
 * 
 * @param {Array} commissions - Commission records from oe.Commissions
 * @returns {Array} Payout breakdown in format expected by NACHA
 */
function commissionsToPayoutBreakdown(commissions) {
  const breakdown = [];

  // Track commission pools per anchor (PaymentId for payment-funded commissions,
  // InvoiceId for credit-funded invoice-anchored commissions) to validate totals
  // don't exceed the allocated commission pool.
  // Pre-shift this was keyed by PaymentId only; invoice-only commissions all have
  // PaymentId=NULL, so they collided into one bucket and false warnings/errors fired.
  const anchorCommissionPools = new Map();
  const anchorCommissionTotals = new Map();
  // For warnings/logs, keep the original PaymentId (or InvoiceId fallback) handy.
  const getAnchor = (c) => c.PaymentId
    ? `payment:${String(c.PaymentId).toUpperCase()}`
    : (c.InvoiceId ? `invoice:${String(c.InvoiceId).toUpperCase()}` : 'unknown');

  for (const commission of commissions) {
    const anchor = getAnchor(commission);
    const commissionPool = parseFloat(commission.CommissionPool) || 0;
    const actualPayout = parseFloat(commission.Amount) || 0;

    // Track commission pool per anchor (should be the same across commissions from
    // the same payment OR the same invoice).
    if (!anchorCommissionPools.has(anchor)) {
      anchorCommissionPools.set(anchor, commissionPool);
    } else {
      const existingPool = anchorCommissionPools.get(anchor);
      if (Math.abs(existingPool - commissionPool) > 0.01) {
        logger.warn('Inconsistent commission pool for anchor', {
          anchor,
          paymentId: commission.PaymentId || null,
          invoiceId: commission.InvoiceId || null,
          existingPool,
          newPool: commissionPool,
          commissionId: commission.CommissionId
        }, 'NACHA');
      }
    }

    if (!anchorCommissionTotals.has(anchor)) {
      anchorCommissionTotals.set(anchor, 0);
    }
    anchorCommissionTotals.set(anchor, anchorCommissionTotals.get(anchor) + actualPayout);
  }

  // Validate totals don't exceed commission pools
  for (const [anchor, totalCommissions] of anchorCommissionTotals.entries()) {
    const commissionPool = anchorCommissionPools.get(anchor) || 0;
    if (totalCommissions > commissionPool + 0.01) { // Allow small rounding differences
      logger.error('Commission total exceeds commission pool', {
        anchor,
        totalCommissions,
        commissionPool,
        difference: totalCommissions - commissionPool
      }, 'NACHA');
    }
  }

  for (const commission of commissions) {
    // Parse RuleIds JSON array
    let ruleIds = [];
    let firstRuleId = null;
    try {
      if (commission.RuleIds) {
        ruleIds = typeof commission.RuleIds === 'string' 
          ? JSON.parse(commission.RuleIds) 
          : commission.RuleIds;
        firstRuleId = Array.isArray(ruleIds) && ruleIds.length > 0 ? ruleIds[0] : null;
      }
    } catch (error) {
      logger.warn('Error parsing RuleIds JSON', { 
        commissionId: commission.CommissionId, 
        ruleIds: commission.RuleIds 
      }, 'NACHA');
    }

    // Use first rule ID from parsed array, or fallback to FirstRuleId from query
    const ruleId = firstRuleId || commission.FirstRuleId;
    const ruleName = commission.FirstRuleName || null;
    // Revenue = Payment amount
    const revenue = parseFloat(commission.PaymentAmount) || 0;
    // Commission pool = Commission field from Payments (agent commission pool)
    const commissionPool = parseFloat(commission.CommissionPool) || 0;
    // Actual payout = Amount from Commissions (after advance balance recovery)
    const actualPayout = parseFloat(commission.Amount) || 0;

    // Check if this is an agency commission (AgencyId set, AgentId NULL) or agent commission
    const isAgencyCommission = commission.AgencyId && !commission.AgentId;
    
    // Tier level comes from the agent's or agency's CommissionTierLevel (or hierarchy-based TierLevel for agents)
    // NOT from the rule's TierLevel field (which is the rule configuration, not the entity's level)
    // Use agency tier level if it's an agency commission, otherwise use agent tier level
    const tierLevel = isAgencyCommission 
      ? (commission.AgencyTierLevel ?? 0)
      : (commission.AgentTierLevel ?? 0);
    
    if (isAgencyCommission) {
      // Agency commission (overflow) - put in tenants array with proper flags
      breakdown.push({
        paymentId: commission.PaymentId,
        invoiceId: commission.InvoiceId || null, // Carry invoice anchor for credit-funded rows
        commissionId: commission.CommissionId,
        revenue: revenue,
        commissionPool: commissionPool, // Agencies don't have commission pools, only overflow
        actualPayout: actualPayout,
        calculation: {
          distribution: {
            agents: [],
            vendors: [],
            tenants: [{
              tenantId: commission.AgencyId, // Actually AgencyId, stored as tenantId for compatibility
              amount: actualPayout,
              ruleId: null, // Overflow has no rule
              ruleName: 'Overflow',
              tierLevel: tierLevel, // Agency's tier level
              isPrimaryAgency: true,
              isOverflow: true
            }]
          },
          totalCommissionsPaid: actualPayout
        }
      });
    } else {
      // Agent commission - put in agents array
      breakdown.push({
        paymentId: commission.PaymentId,
        invoiceId: commission.InvoiceId || null, // Carry invoice anchor for credit-funded rows
        commissionId: commission.CommissionId,
        revenue: revenue,
        commissionPool: commissionPool,
        actualPayout: actualPayout,
        calculation: {
          distribution: {
            agents: [{
              agentId: commission.AgentId,
              amount: actualPayout,
              ruleId: ruleId,
              ruleName: ruleName,
              tierLevel: tierLevel,
              ruleIds: ruleIds, // Full array of rule IDs
              commissionType: commission.FirstRuleCommissionType || null
            }],
            vendors: [],
            tenants: []
          },
          totalCommissionsPaid: actualPayout
        }
      });
    }
  }

  return breakdown;
}

module.exports = {
  getEligibleCommissions,
  commissionsToPayoutBreakdown
};

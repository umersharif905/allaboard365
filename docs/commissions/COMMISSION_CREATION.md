# Commission Creation - Complete Guide

## Overview

This document covers how to create commissions when payments come in, including trigger options, implementation code, and testing strategies.

## Key Clarifications

### 1. Balance is Per Agent + Household/Group
- Each agent has a **unique advance balance per household or group**
- Agent 0 can have:
  - $300 advance balance for Household A
  - $600 advance balance for Group B
  - $0 advance balance for Household C (no advance)
- When querying balance, we must specify both `AgentId` AND `HouseholdId`/`GroupId`

### 2. Multiple Commission Rows Per Payment
- One payment → Multiple commission rows (one per agent in hierarchy)
- Example: Payment of $50 creates:
  - Commission row for Agent 0: $30
  - Commission row for Agent 1: $5
  - Commission row for Agent 2: $5
- Each commission row is independent and can have different advance balances

## Trigger Options

### Option 1: Azure SQL Trigger (Recommended for Decoupling)

**Location:** Separate Azure Function with SQL trigger binding

**Approach:** Use Azure SQL change tracking to monitor `oe.Payments` table and trigger commission creation when payments are inserted.

**How It Works:**
- SQL change tracking monitors `oe.Payments` table for inserts
- Azure Function with SQL trigger binding polls for changes (default: every 1 second)
- When payment is inserted, trigger fires and creates commissions
- Automatic retry logic for failed commission creation

**Pros:**
- ✅ **Decoupled** - Payment processing completely separate from commission creation
- ✅ **Fast** - Default 1 second polling (configurable down to 100ms)
- ✅ **Automatic retries** - Built-in retry logic for failed commission creation
- ✅ **Scales automatically** - Based on number of pending changes
- ✅ **Payment succeeds** - Even if commission creation fails (can retry later)
- ✅ **No code changes** - Just add new Azure Function, no changes to webhook handler

**Cons:**
- ⚠️ Small delay (1 second default, configurable)
- ⚠️ Requires change tracking setup on database
- ⚠️ Additional Azure Function (but minimal cost)

**Setup Required:**
1. Enable change tracking on database and `oe.Payments` table
2. Create Azure Function with SQL trigger binding
3. Configure polling interval (default 1 second)

**Reference:** [Azure SQL Trigger Documentation](https://learn.microsoft.com/en-us/azure/azure-functions/functions-bindings-azure-sql-trigger)

**Implementation:**

```javascript
// commissionTrigger/index.js
const { app } = require('@azure/functions');
const CommissionService = require('../../backend/services/commissionService');

app.sql('CommissionTrigger', {
  connectionStringSetting: 'SqlConnectionString',
  commandText: 'SELECT * FROM oe.Payments WHERE Status = ''Completed''',
  // Triggers on INSERT to oe.Payments
}, async (request, context) => {
  context.log('SQL trigger fired for payment changes');
  
  const changes = request.triggerMetadata.changes;
  
  for (const change of changes) {
    if (change.operation === 'Insert') {
      const payment = change.item;
      
      try {
        await CommissionService.createCommissionsForPayment({
          paymentId: payment.PaymentId,
          householdId: payment.HouseholdId,
          groupId: payment.GroupId,
          paymentDate: payment.PaymentDate,
          enrollmentId: payment.EnrollmentId,
          productId: payment.ProductId,
          paymentAmount: payment.Amount,
          agentId: payment.AgentId,
          tenantId: payment.TenantId
        });
        
        context.log(`Commissions created for payment: ${payment.PaymentId}`);
      } catch (error) {
        context.log.error(`Failed to create commissions for payment ${payment.PaymentId}:`, error);
        // Automatic retry will happen in 60 seconds
        throw error; // Will trigger retry
      }
    }
  }
});
```

**Change Tracking Setup:**

```sql
-- Enable change tracking on database
ALTER DATABASE [YourDatabaseName]
SET CHANGE_TRACKING = ON
(CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON);

-- Enable change tracking on oe.Payments table
ALTER TABLE [oe].[Payments]
ENABLE CHANGE_TRACKING;
```

**Configuration (host.json):**

```json
{
  "version": "2.0",
  "extensions": {
    "Sql": {
      "MaxBatchSize": 100,
      "PollingIntervalMs": 1000,  // 1 second (can be reduced to 100ms for faster processing)
      "MaxChangesPerWorker": 1000
    }
  }
}
```

**Key Points:**
- Polling interval can be set as low as 100ms for near-instant processing
- Default 1 second is usually fine (minimal delay)
- Automatic retry for failed commission creation
- Scales based on pending changes

### Option 2: Direct in Webhook Handler (Simplest)

**Location:** `oe_payment_manager/DimeWebhookHandler/index.js`

**Approach:** Add commission creation directly in the existing webhook handler after payment is stored.

**Pros:**
- ✅ **Instant processing** - No delay
- ✅ **Already in Azure Function** - No additional infrastructure
- ✅ **Simple** - Just add one function call
- ✅ **Same pattern** - Follows existing webhook handler pattern
- ✅ **Cost-effective** - No additional queue costs
- ✅ **Easy to test** - Can test immediately

**Cons:**
- ⚠️ Adds processing time to webhook (but commission creation is fast)
- ⚠️ If commission creation fails, payment still succeeds (but we can retry)

**Implementation:**

```javascript
// In oe_payment_manager/DimeWebhookHandler/index.js
const CommissionService = require('../../backend/services/commissionService');

async function handleRecurringPaymentSuccess(pool, data, webhookEventId, logger) {
  // ... existing payment storage code ...
  
  // After payment is successfully stored in oe.Payments:
  const paymentId = result.recordset[0].PaymentId;
  
  logger.success(`Recurring payment success processed for ${isIndividualRecurring ? 'household' : 'group'}: ${isIndividualRecurring ? householdId : groupId}`);
  
  // ✅ ADD COMMISSION CREATION HERE
  try {
    await CommissionService.createCommissionsForPayment({
      paymentId,
      householdId,
      groupId,
      paymentDate: paymentDate,
      enrollmentId,
      productId,
      paymentAmount: amount,
      agentId,
      tenantId
    });
    logger.success(`Commissions created for payment: ${paymentId}`);
  } catch (commissionError) {
    logger.error(`Failed to create commissions for payment ${paymentId}:`, {
      error: commissionError.message,
      stack: commissionError.stack
    });
    // Don't fail the webhook - payment succeeded, commissions can be retried
    // TODO: Could add to retry queue or log for manual processing
  }
  
  // ... rest of existing code (invoice updates, etc.) ...
}
```

**Why This Works:**
- Payment webhook handler is already an Azure Function
- It already processes payments synchronously
- Adding commission creation here is the simplest approach
- No additional infrastructure needed

## Recommendation

### For Decoupling: Azure SQL Trigger (Option 1)

**Best when:**
- You want complete decoupling between payment and commission processing
- You want automatic retry logic for failed commission creation
- You want to scale commission processing independently
- Small delay (1 second) is acceptable

**Why:**
1. ✅ **Complete decoupling** - Payment and commission processing are separate
2. ✅ **Automatic retries** - Built-in retry logic for failed commission creation
3. ✅ **Fast enough** - 1 second delay (configurable to 100ms)
4. ✅ **Scales automatically** - Based on pending changes
5. ✅ **No webhook changes** - Payment processing unchanged
6. ✅ **Production-ready** - Microsoft-supported approach

### For Simplicity: Direct in Webhook Handler (Option 2)

**Best when:**
- You want instant processing (no delay)
- You want simplest implementation
- You're okay with payment and commission processing being coupled
- You want minimal infrastructure

**Why:**
1. ✅ **Instant processing** - No delay
2. ✅ **Simplest** - Just add one function call
3. ✅ **No additional infrastructure** - Uses existing webhook handler
4. ✅ **Cost-effective** - No additional Azure Function costs
5. ✅ **Easy to test** - Can test immediately

## Comparison

| Feature | Azure SQL Trigger | Direct in Webhook |
|---------|------------------|-------------------|
| **Delay** | 1 second (configurable) | Instant |
| **Decoupling** | ✅ Complete | ❌ Coupled |
| **Retry Logic** | ✅ Automatic | ⚠️ Manual |
| **Infrastructure** | Additional Function | Existing Function |
| **Complexity** | Medium | Low |
| **Scalability** | ✅ Auto-scales | ⚠️ Scales with webhook |
| **Cost** | Additional Function | No additional cost |
| **Setup** | Change tracking + Function | Just code change |

## Final Recommendation

**For Production:** **Azure SQL Trigger** - Better decoupling, automatic retries, scales independently

**For Development/Testing:** **Direct in Webhook Handler** - Instant, simple, easy to test

**Hybrid Approach:** Use direct in webhook handler for now, migrate to SQL trigger later if needed

## Implementation Code

### Commission Service

**File:** `backend/services/commissionService.js`

```javascript
const { getPool, sql } = require('../config/database');
const commissionCalculatorService = require('./CommissionCalculatorService');
const logger = require('../config/logger');

class CommissionService {
  /**
   * Create commissions for a payment
   * @param {Object} paymentData - Payment data
   * @returns {Promise<Object>} Commission creation result
   */
  static async createCommissionsForPayment(paymentData) {
    const {
      paymentId,
      householdId,
      groupId,
      paymentDate,
      enrollmentId,
      productId,
      paymentAmount,
      agentId,
      tenantId
    } = paymentData;

    try {
      // 1. Get enrollments for this household/group
      const enrollments = await this.getEnrollmentsForHousehold(householdId, groupId);

      if (!enrollments || enrollments.length === 0) {
        logger.warn('No enrollments found for payment', { paymentId, householdId, groupId });
        return { success: true, commissionsCreated: 0 };
      }

      let totalCommissionsCreated = 0;

      // 2. For each enrollment, create commissions
      for (const enrollment of enrollments) {
        const commissions = await this.createCommissionsForEnrollment({
          paymentId,
          enrollmentId: enrollment.EnrollmentId,
          householdId,
          groupId,
          paymentDate,
          productId: enrollment.ProductId || productId,
          paymentAmount,
          agentId: enrollment.AgentId || agentId,
          tenantId: enrollment.TenantId || tenantId
        });

        totalCommissionsCreated += commissions.length;
      }

      logger.info('Commissions created for payment', {
        paymentId,
        commissionsCreated: totalCommissionsCreated
      });

      return {
        success: true,
        commissionsCreated: totalCommissionsCreated
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
      enrollmentId,
      householdId,
      groupId,
      paymentDate,
      productId,
      paymentAmount,
      agentId,
      tenantId
    } = enrollmentData;

    // 1. Calculate commission distribution using commission rules
    const commissionDistribution = await this.calculateCommissionDistribution(
      enrollmentId,
      productId,
      paymentAmount,
      agentId,
      tenantId
    );

    const createdCommissions = [];

    // 2. For each agent in the distribution
    for (const agentPayout of commissionDistribution) {
      const { agentId: payoutAgentId, amount, ruleId, ruleName } = agentPayout;

      // 3. Check if agent has active advance balance
      const advanceCommission = await this.getAdvanceCommissionForAgent(
        payoutAgentId,
        enrollmentId,
        householdId,
        groupId
      );

      if (advanceCommission && advanceCommission.Balance > 0) {
        // 4. Agent has advance balance - apply to balance first
        const balanceResult = await this.applyCommissionToBalance(
          payoutAgentId,
          amount,
          advanceCommission,
          enrollmentId,
          householdId,
          groupId
        );

        // 5. Get enrollment effective date for period calculation
        const enrollmentEffectiveDate = await this.getEnrollmentEffectiveDate(enrollmentId);
        
        // 6. Calculate period dates (based on effective date, not payment date)
        const periodStartDate = new Date(Math.min(
          new Date(enrollmentEffectiveDate).getTime(),
          new Date(paymentDate).getTime()
        ));
        const periodEndDate = this.addMonths(periodStartDate, 1);
        
        // 7. Create commission row (full amount from rules)
        const commissionId = await this.createCommissionRow({
          agentId: payoutAgentId,
          enrollmentId,
          householdId,
          groupId,
          paymentId,
          amount: amount,
          balance: null,
          status: 'Pending',
          transactionType: 'Commission',
          originalCommissionId: advanceCommission.CommissionId,
          periodStartDate: periodStartDate,
          periodEndDate: periodEndDate,
          ruleId,
          ruleName
        });

        createdCommissions.push(commissionId);

        // 8. If balance reached 0, mark commissions as eligible for payout
        if (balanceResult.newBalance <= 0) {
          await this.markCommissionsAsEligible(advanceCommission.CommissionId);
        }

        // 9. If there's remaining payout (after balance recovery)
        if (balanceResult.remainingPayout > 0) {
          // Use same period dates as above
          const payoutCommissionId = await this.createCommissionRow({
            agentId: payoutAgentId,
            enrollmentId,
            householdId,
            groupId,
            paymentId,
            amount: balanceResult.remainingPayout,
            balance: null,
            status: 'Pending',
            transactionType: 'Commission',
            periodStartDate: periodStartDate,
            periodEndDate: periodEndDate,
            ruleId,
            ruleName
          });

          createdCommissions.push(payoutCommissionId);
        }
      } else {
        // 10. No advance balance - create normal commission
        // Get enrollment effective date for period calculation
        const enrollmentEffectiveDate = await this.getEnrollmentEffectiveDate(enrollmentId);
        
        // Calculate period dates (based on effective date, not payment date)
        const periodStartDate = new Date(Math.min(
          new Date(enrollmentEffectiveDate).getTime(),
          new Date(paymentDate).getTime()
        ));
        const periodEndDate = this.addMonths(periodStartDate, 1);
        
        const commissionId = await this.createCommissionRow({
          agentId: payoutAgentId,
          enrollmentId,
          householdId,
          groupId,
          paymentId,
          amount: amount,
          balance: null,
          status: 'Pending',
          transactionType: 'Commission',
          periodStartDate: periodStartDate,
          periodEndDate: periodEndDate,
          ruleId,
          ruleName
        });

        createdCommissions.push(commissionId);
      }
    }

    return createdCommissions;
  }

  /**
   * Calculate commission distribution using commission rules
   */
  static async calculateCommissionDistribution(enrollmentId, productId, paymentAmount, agentId, tenantId) {
    const calculation = await commissionCalculatorService.calculateCommissions(
      null,
      productId,
      paymentAmount,
      agentId,
      tenantId,
      enrollmentId
    );

    const distribution = [];
    if (calculation.distribution && calculation.distribution.agents) {
      for (const agentPayout of calculation.distribution.agents) {
        distribution.push({
          agentId: agentPayout.agentId,
          amount: agentPayout.amount,
          ruleId: agentPayout.ruleId,
          ruleName: agentPayout.ruleName,
          tierLevel: agentPayout.tierLevel
        });
      }
    }

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
        Balance,
        PeriodStartDate,
        PeriodEndDate
      FROM oe.Commissions
      WHERE AgentId = @AgentId
        AND TransactionType = 'Advance'
        AND Balance > 0
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
  static async applyCommissionToBalance(agentId, commissionAmount, advanceCommission, enrollmentId, householdId, groupId) {
    const currentBalance = parseFloat(advanceCommission.Balance);
    const appliedToBalance = Math.min(currentBalance, commissionAmount);
    const newBalance = currentBalance - appliedToBalance;
    const remainingPayout = commissionAmount - appliedToBalance;

    const pool = await getPool();
    const request = pool.request();

    request.input('CommissionId', sql.UniqueIdentifier, advanceCommission.CommissionId);
    request.input('AppliedAmount', sql.Decimal(18, 2), appliedToBalance);

    await request.query(`
      UPDATE oe.Commissions
      SET Balance = Balance - @AppliedAmount
      WHERE CommissionId = @CommissionId
    `);

    return {
      appliedToBalance,
      remainingPayout,
      newBalance
    };
  }

  /**
   * Get enrollment effective date for period calculations
   * @param {string} enrollmentId - Enrollment ID
   * @returns {Promise<Date>} Effective date
   */
  static async getEnrollmentEffectiveDate(enrollmentId) {
    const pool = await getPool();
    const request = pool.request();

    request.input('EnrollmentId', sql.UniqueIdentifier, enrollmentId);

    const result = await request.query(`
      SELECT EffectiveDate
      FROM oe.Enrollments
      WHERE EnrollmentId = @EnrollmentId
    `);

    if (result.recordset.length === 0) {
      throw new Error(`Enrollment not found: ${enrollmentId}`);
    }

    return result.recordset[0].EffectiveDate;
  }

  /**
   * Calculate period dates for advance commissions
   * IMPORTANT: Period dates are based on plan's effective date, not when advance is paid
   * 
   * @param {Date} planEffectiveDate - Plan effective date from oe.Enrollments.EffectiveDate
   * @param {Date} advancePaymentDate - When the advance was paid
   * @param {number} advanceMonths - Number of months for advance
   * @returns {Object} Period dates
   * 
   * Example:
   * - Advance paid: Nov 1, 2025
   * - Plan effective date: Jan 1, 2026 (2 months later)
   * - 6-month advance
   * - PeriodStartDate: Jan 1, 2026 (plan effective date, or first payment if earlier)
   * - PeriodEndDate: July 1, 2026 (Jan 1 + 6 months, NOT Nov 1 + 6 months)
   */
  static calculateAdvancePeriodDates(planEffectiveDate, advancePaymentDate, advanceMonths) {
    // PeriodStartDate: Use earlier of effective date or first payment date
    // This handles cases where advance is paid before plan goes into effect
    const periodStartDate = new Date(Math.min(
      new Date(planEffectiveDate).getTime(),
      new Date(advancePaymentDate).getTime()
    ));

    // PeriodEndDate: Plan effective date + advance months
    // This ensures the period is based on when the plan is active, not when advance was paid
    const endDate = new Date(planEffectiveDate);
    endDate.setMonth(endDate.getMonth() + advanceMonths);
    // Get last day of that month
    const lastDay = new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0);

    return {
      periodStartDate: periodStartDate,
      periodEndDate: lastDay
    };
  }

  /**
   * Create commission row
   */
  static async createCommissionRow(commissionData) {
    const pool = await getPool();
    const commissionId = require('crypto').randomUUID();
    const request = pool.request();

    request.input('CommissionId', sql.UniqueIdentifier, commissionId);
    request.input('AgentId', sql.UniqueIdentifier, commissionData.agentId);
    request.input('EnrollmentId', sql.UniqueIdentifier, commissionData.enrollmentId);
    request.input('HouseholdId', sql.UniqueIdentifier, commissionData.householdId);
    request.input('GroupId', sql.UniqueIdentifier, commissionData.groupId);
    request.input('PaymentId', sql.UniqueIdentifier, commissionData.paymentId);
    request.input('Amount', sql.Decimal(18, 2), commissionData.amount);
    request.input('Balance', sql.Decimal(18, 2), commissionData.balance);
    request.input('Status', sql.NVarChar, commissionData.status);
    request.input('TransactionType', sql.NVarChar, commissionData.transactionType);
    request.input('OriginalCommissionId', sql.UniqueIdentifier, commissionData.originalCommissionId);
    request.input('PeriodStartDate', sql.Date, commissionData.periodStartDate);
    request.input('PeriodEndDate', sql.Date, commissionData.periodEndDate);
    request.input('RuleId', sql.UniqueIdentifier, commissionData.ruleId);
    request.input('RuleName', sql.NVarChar, commissionData.ruleName);

    await request.query(`
      INSERT INTO oe.Commissions (
        CommissionId, AgentId, EnrollmentId, HouseholdId, GroupId,
        PaymentId, Amount, Balance, Status, TransactionType,
        OriginalCommissionId, PeriodStartDate, PeriodEndDate,
        RuleId, RuleName, CreatedDate
      ) VALUES (
        @CommissionId, @AgentId, @EnrollmentId, @HouseholdId, @GroupId,
        @PaymentId, @Amount, @Balance, @Status, @TransactionType,
        @OriginalCommissionId, @PeriodStartDate, @PeriodEndDate,
        @RuleId, @RuleName, GETDATE()
      )
    `);

    return commissionId;
  }

  /**
   * Mark commissions as eligible for payout
   */
  static async markCommissionsAsEligible(advanceCommissionId) {
    const pool = await getPool();
    const request = pool.request();

    request.input('OriginalCommissionId', sql.UniqueIdentifier, advanceCommissionId);

    await request.query(`
      UPDATE oe.Commissions
      SET Status = 'Pending'
      WHERE OriginalCommissionId = @OriginalCommissionId
        AND Status = 'Pending'
        AND Balance IS NULL
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
        SELECT EnrollmentId, ProductId, AgentId, TenantId
        FROM oe.Enrollments
        WHERE HouseholdId = @HouseholdId
          AND Status = 'Active'
      `);
      return result.recordset;
    } else if (groupId) {
      request.input('GroupId', sql.UniqueIdentifier, groupId);
      const result = await request.query(`
        SELECT EnrollmentId, ProductId, AgentId, TenantId
        FROM oe.Enrollments
        WHERE GroupId = @GroupId
          AND Status = 'Active'
      `);
      return result.recordset;
    }

    return [];
  }

  /**
   * Add months to a date
   */
  static addMonths(date, months) {
    const result = new Date(date);
    result.setMonth(result.getMonth() + months);
    return result;
  }
}

module.exports = CommissionService;
```

## Testing

### Instant Processing (Both Dev & Prod)

Commissions are created immediately when payments are stored (in webhook handler). This allows for:

1. **Immediate Testing:** See commission results right away
2. **Debugging:** Can step through commission creation logic
3. **No Delays:** Perfect for development and testing
4. **Same Behavior:** Development and production work the same way

### Testing Flow

1. **Create a payment** (via webhook or manual entry)
2. **Commissions created immediately**
3. **Check `oe.Commissions` table** to verify commissions
4. **Test advance balance recovery** by creating multiple payments
5. **Test hierarchy splits** by using multiple agents

## Key Points

1. **Instant Processing:** Commissions created immediately in webhook handler (both dev & prod)
2. **No Queue Needed:** Webhook handler already processes synchronously
3. **Cost-Effective:** No additional infrastructure or queue costs
4. **Error Handling:** Payment succeeds even if commission creation fails (can retry later)
5. **Multiple Rows:** One payment can create multiple commission rows (one per agent in hierarchy)
6. **Per-Agent Balance:** Each agent has unique advance balance per household/group
7. **Early Payouts:** When balance = 0, commissions pay out immediately even if PeriodEndDate hasn't arrived (handles plan increases)


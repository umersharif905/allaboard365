# Advances and Chargebacks Implementation Plan

> **STATUS: SUPERSEDED — April 2026.**
>
> The chargeback flow described below has been replaced by the **Credits and
> Clawback Ledger** plan
> ([.cursor/plans/credits_and_clawback_ledger_0655b4cc.plan.md]). Commission
> chargebacks are no longer triggered manually via `POST /api/commissions/chargeback`
> or the legacy `oe.ProcessCommissionChargeback` stored procedure. Instead:
>
> - All refunds (manual + webhook) flow through `RefundService.processRefund()`.
> - Inside that single DB transaction, `CommissionService.clawBackForRefund()`
>   cancels Pending advance/commission rows and inserts negative-amount
>   `Refund`/`Chargeback` rows with `Status='Pending'` for the next NACHA cycle.
> - Negative balances carry forward across NACHA cycles via netting (Phase 6).
> - The legacy `processChargeback` stub in `commissionService.js`, the
>   `/api/commissions/chargeback` route, and the frontend
>   `commissionsService.processChargeback` method now all return 410 Gone /
>   throw deprecation errors.
>
> The remainder of this document is kept for historical context only — do not
> use it as guidance for new development.

## Overview

This document outlines the implementation plan for agent commission advances and chargebacks using the `oe.Commissions` table with date ranges and household/group linking.

## Architecture Decision

**Approach:** Use `oe.Commissions` table only - no changes to `oe.Payments` or `oe.Enrollments`

**Rationale:**
- Single source of truth for all commission data
- Clean separation of concerns (Payments = member payments, Commissions = agent commissions)
- Date-based logic is intuitive and reliable
- Natural handling of advances, regular commissions, and chargebacks

## Database Schema

### New Fields in `oe.Commissions`

| Field | Type | Purpose |
|-------|------|---------|
| `HouseholdId` | UNIQUEIDENTIFIER | Link commission to household (for individual enrollments) |
| `GroupId` | UNIQUEIDENTIFIER | Link commission to group (for group enrollments) |
| `PeriodStartDate` | DATE | Start date of commission period |
| `PeriodEndDate` | DATE | End date of commission period (commission pays out after this date) |
| `TransactionType` | NVARCHAR(50) | 'Commission', 'Advance', 'Chargeback', 'Refund' |
| `OriginalCommissionId` | UNIQUEIDENTIFIER | Links chargebacks to original commission(s) |
| `PaymentId` | UNIQUEIDENTIFIER | Links commission to payment (optional) |
| `AdvanceBalance` | DECIMAL(18,2) | Remaining advance balance (only on advance commissions, NULL for monthly commissions) |
| `Amount` | DECIMAL(18,2) | **Actual payout amount to agent** (after advance balance recovery). For advances, this is the total advance amount. For commissions, this is the amount after balance recovery (will be $0 if all goes to balance). |
| `SplitPartnerAgentId` | UNIQUEIDENTIFIER | The other agent in a split commission (nullable) |
| `SplitPercentage` | DECIMAL(5,4) | This agent's percentage in the split (0.4000 = 40%, nullable) |
| `IsPrimaryInSplit` | BIT | Whether this agent is the primary (true) or partner (false) in the split (nullable) |
| `RuleIds` | NVARCHAR(MAX) | JSON array of RuleIds that contributed to this commission |

### New Fields in `oe.Agents`

| Field | Type | Purpose |
|-------|------|---------|
| `AdvanceMonths` | INT (1-12) | Number of months to advance pay commission (NULL = disabled) |

## Split Commission Rules

### Overview
Split commission rules allow a primary agent to share their commission with one or more partner agents. Split rules are applied **LAST**, after all regular commission rules have been calculated.

### How Split Rules Work

1. **Regular Rules Applied First:** All regular commission rules (Percentage, Flat, Tiered) are applied to calculate each agent's total commission.

2. **Split Rules Applied Last:** After all regular rules are applied, the system checks for split rules that match the payment's HouseholdId or GroupId.

3. **Split Application:**
   - Find the primary agent's total commission from regular rules
   - For each split partner in the rule:
     - Calculate split amount: `primaryAgentTotal × partnerPercentage`
     - Reduce primary agent's commission by the split amount
     - Add split amount to partner agent's commission (or create new entry if partner has no other commission)

4. **GroupId Specificity:**
   - Split rules can be scoped to a specific GroupId
   - If a rule has a GroupId, it only applies to payments for that group
   - If a rule has no GroupId, it applies globally (to all groups/households)
   - **Note:** CommissionRules currently only has `GroupId` column (not `HouseholdId`). For household-specific split rules, consider adding `HouseholdId` to `oe.CommissionRules` in the future.

### Database Storage
Split commission details are stored in `oe.Commissions`:
- `SplitPartnerAgentId`: The other agent in the split
- `SplitPercentage`: This agent's percentage (0.4000 = 40%)
- `IsPrimaryInSplit`: true = primary agent, false = split partner, NULL = not a split

### UI Display
When clicking "X Rules" on a commission, the modal displays:
- Split commission rule details
- List of all agents in the split with their names and percentages
- Indication of which agent is primary

## Draft Payments & Commissions

### Overview
Draft payments and commissions represent expected future payments and commissions that are subject to change before finalization.

### Status Values
- `oe.Payments.Status`: `'Draft'` - Expected payment, subject to change
- `oe.Commissions.Status`: `'Draft'` - Estimated commission, subject to change

### Flow

**Day 1 (MonthlyPaymentScheduler):**
- Create `oe.Payments` with `Status='Draft'` (expected payment amount)
- Azure SQL Trigger fires → Creates `oe.Commissions` with `Status='Draft'` (estimated commissions)

**Day 5 (Webhook Handler):**
- When payment succeeds, check if Draft payment exists for GroupId/HouseholdId
- UPDATE `oe.Payments` SET `Status='Completed'`, `Amount=actualAmount`, `Commission=actualCommission`, etc.
- Azure SQL Trigger fires (UPDATE operation) → Updates existing Draft commissions:
  - Delete existing Draft commissions for this PaymentId
  - Recalculate and create new commissions with updated amounts
  - Set `Status='Pending'` for new commissions

### Recalculation Logic
When a webhook fires that marks a payment as successful:
1. Check if Draft payment exists for the payment's GroupId/HouseholdId
2. If exists, UPDATE the Draft payment (overwrite entire record with new amounts)
3. Azure SQL Trigger detects UPDATE and:
   - Deletes existing Draft commissions for this PaymentId
   - Recalculates commissions with new payment amounts
   - Creates new commission rows with `Status='Pending'`

### Azure SQL Trigger UPDATE Support
The commission trigger (`oe_payment_manager/CommissionTrigger/`) handles both:
- **INSERT operations:** Create new commissions for new payments
- **UPDATE operations:** Recalculate commissions when Draft payments are finalized

## Commission Creation Triggers

### Current State
Commissions are currently calculated **on-demand** when needed (NACHA generation, reporting). They are NOT automatically created when payments come in.

### Proposed Approach: Decoupled Commission Creation (Recommended)

**Option 1: Azure Queue (Recommended)**
- Trigger: When payment webhook is received and payment is successfully stored
- Location: `backend/services/paymentDatabaseService.js` or `backend/routes/webhooks/dime.js`
- Action: After `storePaymentRecord()` succeeds, queue commission creation message

**Pros:**
- Decoupled from payment processing (payment succeeds even if commission creation fails)
- Can retry failed commission creation
- Better error handling and monitoring
- Industry best practice
- Small delay (5-15 minutes) is acceptable

**Cons:**
- Requires Azure Queue infrastructure
- Slight delay in commission creation

**Implementation:**
```javascript
// In paymentDatabaseService.js
async function processPayment(paymentData) {
  // 1. Store payment record
  const payment = await PaymentDatabaseService.storePaymentRecord(paymentData);
  
  // 2. Queue commission creation (decoupled)
  await queueService.sendMessage('commission-creation', {
    paymentId: payment.PaymentId,
    householdId: payment.HouseholdId,
    groupId: payment.GroupId,
    paymentDate: payment.PaymentDate,
    agentId: payment.AgentId
  });
  
  return payment;
}

// Azure Function processes queue
async function processCommissionCreation(message) {
  const { paymentId, householdId, groupId, paymentDate } = message;
  await CommissionService.createCommissionsForPayment({
    paymentId,
    householdId,
    groupId,
    paymentDate
  });
}
```

**Option 2: Direct Payment Webhook Handler**
- Trigger: When payment webhook is received and payment is successfully stored
- Location: `backend/routes/webhooks/dime.js` or `backend/services/paymentDatabaseService.js`
- Action: After `storePaymentRecord()` succeeds, call `createCommissionsForPayment()` directly

**Pros:**
- Real-time commission creation
- No external dependencies
- Works with existing payment flow
- Easy to debug and test

**Cons:**
- Adds processing time to payment webhook
- If commission creation fails, payment still succeeds but commissions aren't created
- Less resilient

### Recommendation: **Option 1 - Azure Queue (Decoupled)**

**Rationale:**
- Better practice for production systems
- Small delay (5-15 minutes) is acceptable
- More resilient and scalable
- Can retry failures without affecting payments

## Commission Creation Logic

### Regular Commissions (Monthly)

When a payment comes in on **Nov 1, 2025**:

```sql
-- Create commission for the period covered by this payment
INSERT INTO oe.Commissions (
    CommissionId, AgentId, EnrollmentId, HouseholdId, GroupId,
    PaymentId, Amount, Status, PeriodStartDate, PeriodEndDate, 
    TransactionType, CreatedDate
) VALUES (
    NEWID(), @agentId, @enrollmentId, @householdId, @groupId,
    @paymentId, 100.00, 'Pending', '2025-11-01', '2025-11-30', 
    'Commission', GETDATE()
);
```

**Key Points:**
- `Status = 'Pending'` until next payment comes in
- `PeriodEndDate = PaymentDate + 1 month`
- Commission pays out when next payment arrives AFTER `PeriodEndDate`

### Advances (6 Months Example)

**Important:** Period dates are based on the **plan's effective date**, not when the advance is paid.

**Scenario:**
- Advance paid: **Nov 1, 2025**
- Plan effective date: **Jan 1, 2026** (2 months later)
- 6-month advance period

**Period Calculation:**
- `PeriodStartDate`: Earlier of plan effective date or first payment date
  - If advance paid Nov 1, plan effective Jan 1: `PeriodStartDate = Jan 1, 2026` (plan effective date)
  - If first payment comes in Dec 15, plan effective Jan 1: `PeriodStartDate = Dec 15, 2025` (first payment)
- `PeriodEndDate`: Plan effective date + 6 months = **June 30, 2026** (last day of June, which is Jan 1 + 6 months)
  - NOT Nov 1 + 6 months = May 1
  - This ensures the period reflects when the plan is actually active

```sql
-- 1. Get enrollment effective date
DECLARE @planEffectiveDate DATE = (
    SELECT EffectiveDate 
    FROM oe.Enrollments 
    WHERE EnrollmentId = @enrollmentId
);

-- 2. Calculate period dates
-- PeriodStartDate: Earlier of effective date or first payment date
DECLARE @periodStartDate DATE = CASE 
    WHEN @planEffectiveDate < '2025-11-01' THEN @planEffectiveDate
    ELSE '2025-11-01'  -- First payment date
END;

-- PeriodEndDate: Plan effective date + advance months (NOT advance payment date + months)
DECLARE @periodEndDate DATE = DATEADD(MONTH, @advanceMonths, @planEffectiveDate);
-- Get last day of that month
SET @periodEndDate = DATEADD(DAY, -1, DATEADD(MONTH, 1, DATEFROMPARTS(YEAR(@periodEndDate), MONTH(@periodEndDate), 1)));

-- 3. Create the advance commission (paid immediately)
INSERT INTO oe.Commissions (
    CommissionId, AgentId, EnrollmentId, HouseholdId, GroupId,
    PaymentId, Amount, Status, PeriodStartDate, PeriodEndDate,
    TransactionType, PaymentDate, CreatedDate
) VALUES (
    @advanceCommissionId, @agentId, @enrollmentId, @householdId, @groupId,
    @paymentId, 600.00, 'Paid', @periodStartDate, @periodEndDate,
    'Advance', '2025-11-01', GETDATE()
);

-- 4. Monthly commissions are created as payments come in (not pre-created)
-- Each monthly commission's PeriodStartDate/PeriodEndDate is based on:
-- - PeriodStartDate: Earlier of plan effective date or payment date
-- - PeriodEndDate: PeriodStartDate + 1 month
```

**Key Points:**
- `PeriodStartDate`: Plan effective date (or first payment date if earlier)
- `PeriodEndDate`: Plan effective date + advance months (e.g., Jan 1 + 6 months = July 1)
- Advance commission: `Status = 'Paid'`, covers full period based on effective date
- Future commissions: `Status = 'Pending'`, link back via `OriginalCommissionId`
- Future commissions pay out when balance = 0 (regardless of PeriodEndDate for early payouts)

### Chargebacks

When refund happens on **Nov 15, 2025**:

```sql
-- Create negative commission for chargeback
INSERT INTO oe.Commissions (
    CommissionId, AgentId, EnrollmentId, HouseholdId, GroupId,
    Amount, Status, PeriodStartDate, PeriodEndDate, TransactionType,
    OriginalCommissionId, PaymentDate, CreatedDate
) VALUES (
    NEWID(), @agentId, @enrollmentId, @householdId, @groupId,
    -75.00, 'Paid', '2025-11-01', '2025-11-30', 'Chargeback',
    @originalCommissionId, '2025-11-15', GETDATE()
);
```

**Key Points:**
- `Amount` is negative
- `Status = 'Paid'` (chargeback is immediate)
- Links back to original commission(s) via `OriginalCommissionId`

## Payment Processing Logic

When a payment comes in for a household/group:

```sql
-- Mark all eligible commissions as Paid
-- Logic: 
-- 1. No advance: Pay out after PeriodEndDate passes
-- 2. Advance exists: Pay out when balance = 0 (regardless of PeriodEndDate - allows early payouts)
UPDATE oe.Commissions 
SET Status = 'Paid', 
    PaymentDate = @paymentDate,
    PaymentId = @paymentId
WHERE (HouseholdId = @householdId OR GroupId = @groupId)
  AND Status = 'Pending'
  AND TransactionType IN ('Commission', 'Advance')
  AND (
    -- No advance: pay out after PeriodEndDate passes
    (OriginalCommissionId IS NULL AND PeriodEndDate < @paymentDate)
    OR
    -- Advance exists: pay out when balance = 0 (even if PeriodEndDate hasn't arrived yet)
    (OriginalCommissionId IS NOT NULL AND 
     (SELECT AdvanceBalance FROM oe.Commissions WHERE CommissionId = OriginalCommissionId) = 0)
  );
```

**Logic:**
- **No Advance Commissions:** Find pending commissions where `PeriodEndDate < PaymentDate`
- **Advance Commissions:** Find pending commissions where advance `AdvanceBalance = 0` (regardless of PeriodEndDate)
- This allows early payouts when plan increases cause balance to be paid off before PeriodEndDate
- Mark them as `Paid` and link to the payment via `PaymentId`

**Important:** The `Amount` field in `oe.Commissions` represents the **actual payout amount** to the agent:
- For **Advance** commissions: `Amount` = total advance amount (e.g., $87.60 for 5 months)
- For **Commission** commissions: `Amount` = actual payout after advance balance recovery (e.g., $0 if all goes to balance, or remaining amount if balance is paid off)
- This ensures NACHA can directly use `Amount` to determine payout amounts without additional calculations

## Estimated Commission Payouts (Future Phase)

### Purpose
Show agents estimated future commission payouts assuming no plan changes.

### Approach
Query pending commissions with future `PeriodEndDate`:

```sql
SELECT 
    AgentId,
    SUM(Amount) as EstimatedPayout,
    MIN(PeriodEndDate) as NextPayoutDate,
    COUNT(*) as PendingCommissions
FROM oe.Commissions
WHERE AgentId = @agentId
  AND Status = 'Pending'
  AND PeriodEndDate > GETDATE()
  AND TransactionType = 'Commission'
GROUP BY AgentId;
```

**Key Points:**
- Only shows commissions with `PeriodEndDate > GETDATE()`
- Assumes no plan changes (static estimate)
- Updates automatically as payments come in and commissions are marked Paid

## Plan Changes During Advance Period

### Balance-Based Approach

**Key Concept:** Balance is tracked on the original advance commission. When plan changes, we update how much the balance decreases each month, but the balance recovery happens naturally.

### Scenario 1: Plan Increase

**Example:**
- Advance: $600, Balance: $500 (after 1 payment)
- Plan increases: $100 → $150/month on Dec 15
- New monthly commission: $150 (from commission rules)

**Approach:**
```sql
-- 1. Calculate new monthly commission (from commission rules)
DECLARE @newMonthlyCommission = 150.00;

-- 2. When next payment comes in, update advance balance
-- Balance decreases by NEW amount (faster recovery)
UPDATE oe.Commissions 
SET Balance = Balance - @newMonthlyCommission  -- 500 - 150 = 350
WHERE CommissionId = @advanceCommissionId;

-- 3. Create commission row with new amount
INSERT INTO oe.Commissions (
  Amount = 150.00,  -- New amount from commission rules
  Balance = NULL,   -- Monthly commissions don't have balance
  Status = 'Pending',
  OriginalCommissionId = @advanceCommissionId,
  ...
);
```

**Key Points:**
- Balance decreases faster (more per month)
- Agent gets overage monthly as payments come in
- No separate "overage commissions" needed - just higher monthly commissions
- Natural recovery

### Scenario 2: Plan Decrease

**Example:**
- Advance: $600, Balance: $500
- Plan decreases: $100 → $75/month on Dec 15
- New monthly commission: $75
- Shortfall: $25/month

**Approach:**
```sql
-- 1. Calculate new monthly commission
DECLARE @newMonthlyCommission = 75.00;
DECLARE @shortfall = 25.00;

-- 2. When next payment comes in, update advance balance
-- Balance decreases by new amount (slower recovery)
UPDATE oe.Commissions 
SET Balance = Balance - @newMonthlyCommission  -- 500 - 75 = 425
WHERE CommissionId = @advanceCommissionId;

-- 3. Create commission row with new amount
INSERT INTO oe.Commissions (
  Amount = 75.00,
  Balance = NULL,
  Status = 'Pending',
  OriginalCommissionId = @advanceCommissionId,
  ...
);

-- 4. Create chargeback commission (negative) for shortfall
INSERT INTO oe.Commissions (
  Amount = -25.00,  -- Negative for chargeback
  Balance = NULL,   -- Chargebacks don't affect advance balance
  Status = 'Paid',   -- Chargeback is immediate
  TransactionType = 'Chargeback',
  OriginalCommissionId = @advanceCommissionId,
  ...
);
```

**Key Points:**
- Balance decreases slower (less per month)
- Chargeback recovers overpayment
- Both apply to agent's total payout
- Agent keeps advance (already paid)

### Scenario 3: Cancellation

**Example:**
- Advance paid: $600 (6 months @ $100/month) on Nov 1
- Plan cancels: Dec 15 (after 1.5 months)
- Original advance: $600 for Nov-Apr
- Used: 1.5 months = $150
- Unused: 4.5 months = $450

**Approach: Full Chargeback**

1. **Calculate Unused Advance:**
   - Total advance: $600
   - Used period: Nov 1 - Dec 15 = 1.5 months
   - Used amount: $150
   - Unused amount: $450

2. **Create Full Chargeback:**
   ```sql
   -- Create full chargeback for unused advance
   INSERT INTO oe.Commissions (
       CommissionId, AgentId, EnrollmentId, HouseholdId, GroupId,
       Amount, Status, PeriodStartDate, PeriodEndDate, TransactionType,
       OriginalCommissionId, PaymentDate, CreatedDate
   ) VALUES (
       NEWID(), @agentId, @enrollmentId, @householdId, @groupId,
       -450.00, 'Paid', '2025-12-15', '2025-12-15', 'Chargeback',
       @advanceCommissionId, '2025-12-15', GETDATE()
   );
   ```

3. **Cancel Future Commissions:**
   - Cancel all pending commissions for Dec-Apr
   - Mark advance commission as cancelled (or leave as-is for audit)

**Key Points:**
- Full chargeback for unused advance
- Immediate impact on agent's balance
- Recovered in next NACHA payout (subject to $0 minimum)

## Balance vs Period Logic

### Question: Rely on advance period to end, or balance to be covered, or both?

### Recommendation: **Balance-Based (Primary) with Period Tracking (Secondary)**

**Approach:**
1. **Track Advance Balance on Original Commission:**
   ```sql
   -- Get advance balance directly from advance commission
   SELECT Balance
   FROM oe.Commissions
   WHERE CommissionId = @advanceCommissionId
     AND TransactionType = 'Advance';
   ```

2. **Payout Eligibility:**
   ```sql
   -- Commissions can pay out when:
   -- 1. No advance: Pay out after PeriodEndDate passes
   -- 2. Advance exists: Pay out when balance = 0 (regardless of PeriodEndDate - allows early payouts)
   UPDATE oe.Commissions 
   SET Status = 'Paid', PaymentDate = @paymentDate
   WHERE (HouseholdId = @householdId OR GroupId = @groupId)
     AND Status = 'Pending'
     AND (
       -- No advance: pay out after PeriodEndDate passes
       (OriginalCommissionId IS NULL AND PeriodEndDate < @paymentDate)
       OR
       -- Advance exists: pay out when balance = 0 (even if PeriodEndDate hasn't arrived yet)
       (OriginalCommissionId IS NOT NULL AND 
        (SELECT Balance FROM oe.Commissions WHERE CommissionId = OriginalCommissionId) = 0)
     );
   ```

3. **Period End Date:**
   - Used for display purposes ("Advance period ends Apr 30")
   - Used for estimated payouts
   - Used for payout eligibility for NON-advance commissions (must pass before commission can pay out)
   - **NOT required for advance commissions** - if balance = 0, pay out immediately (handles plan increases)

4. **Balance Recovery:**
   - Balance decreases as payments come in
   - When balance = 0, commissions become eligible for payout **immediately** (even if PeriodEndDate is in the future)
   - This allows early payouts when plan increases cause faster balance recovery

**Key Points:**
- **Primary Logic:** Balance-based (balance must = 0 for advance commissions)
- **Secondary Logic:** Period-based (period must end for non-advance commissions)
- **Early Payouts:** If balance = 0 before PeriodEndDate, commissions pay out immediately (handles plan increases)
- **Recovery:** Happens naturally as payments come in
- **Completion:** When balance = $0 (period date is informational only for advances)

## Implementation Phases

### Phase 1: Database Schema ✅
- [x] Migration script created
- [ ] Run migration script
- [ ] Verify schema changes

### Phase 2: Commission Creation
- [ ] Add commission creation to payment processing
- [ ] Implement regular commission creation
- [ ] Implement advance commission creation
- [ ] Test commission creation flow

### Phase 3: Payment Processing Updates
- [ ] Update payment processing to mark commissions as Paid
- [ ] Implement date-based payout logic
- [ ] Test payment processing flow

### Phase 4: Plan Change Handling
- [ ] Implement plan increase logic (overage commissions)
- [ ] Implement plan decrease logic (chargeback commissions)
- [ ] Implement cancellation logic (full chargeback)
- [ ] Test plan change scenarios

### Phase 5: Estimated Payouts (UI)
- [ ] Create API endpoint for estimated payouts
- [ ] Update agent portal to show estimated payouts
- [ ] Test estimated payout display

### Phase 6: NACHA Integration
- [ ] Update NACHA generation to use `oe.Commissions`
- [ ] Handle chargebacks in NACHA payouts
- [ ] Ensure payouts don't go below $0
- [ ] Test NACHA file generation

## Questions Resolved

1. **Commission Creation Trigger:** Payment webhook handler vs Azure Queue vs Database trigger?
   - **Decision:** Azure Queue (decoupled) - See `IMPLEMENTATION_ANALYSIS.md` for details
   - **Rationale:** Better practice, more resilient, small delay acceptable

2. **Balance vs Period:** Which takes precedence?
   - **Decision:** Balance-based (primary) with period tracking (secondary)
   - **Rationale:** Balance must = 0 AND period must end before payout

3. **Plan Decrease:** Keep advance or chargeback immediately?
   - **Decision:** Keep advance, chargeback for shortfall only (not full advance)
   - **Rationale:** Balance decreases slower, chargeback recovers shortfall

4. **Plan Increase:** Pay overage immediately or monthly?
   - **Decision:** Monthly overage payments (as payments come in)
   - **Rationale:** Balance decreases faster, natural recovery

5. **Balance Tracking:** Where to track balance?
   - **Decision:** On original advance commission only (monthly commissions have Balance = NULL)
   - **Rationale:** Single source of truth, simpler queries

6. **Commission Creation:** Create new row or update existing?
   - **Decision:** Always create new commission row for each payment
   - **Rationale:** Better audit trail, handles commission rule changes

7. **NACHA Generation:** Use `oe.Commissions` or `oe.Payments`?
   - **Decision:** Hybrid - `oe.Commissions` for agents, `oe.Payments` for vendors/tenants
   - **Rationale:** Agents have advances, vendors/tenants don't

8. **Chargebacks:** When are they needed?
   - **Decision:** Only for cancellations and refunds (not for regular plan decreases)
   - **Rationale:** Plan decreases handled by slower balance recovery

5. **Cancellation:** Full chargeback or prorated?
   - **Recommendation:** Full chargeback for unused advance

## Next Steps

1. Review and approve this plan
2. Run migration script
3. Implement commission creation in payment processing
4. Test with sample data
5. Implement plan change handling
6. Update UI to show advances and chargebacks


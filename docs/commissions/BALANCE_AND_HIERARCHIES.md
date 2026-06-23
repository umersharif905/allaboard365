# Balance and Hierarchies - Complete Guide

## Overview

This document covers how advance balances work with commission hierarchies, including per-agent balance tracking, balance recovery, and all scenarios.

## Key Concepts

### 1. Per-Agent + Household/Group Balance

Each agent has a **unique advance balance per household or group combination**. An agent can have multiple advance balances:
- One advance balance for Household A
- Another advance balance for Group B
- Another advance balance for Household C
- etc.

**Example:**
- Agent 0 has $300 advance balance for Household 1
- Agent 0 has $600 advance balance for Group 2
- Agent 0 has $0 advance balance for Household 3 (no advance)

### 2. Multiple Commission Rows Per Payment

One payment → Multiple commission rows (one per agent in hierarchy)

**Example:** Payment of $50 creates:
- Commission row for Agent 0: $30
- Commission row for Agent 1: $5
- Commission row for Agent 2: $5

Each commission row is independent and can have different advance balances.

## Database Structure

### Advance Commissions

When advance is paid, create commission for EACH agent in hierarchy. Each agent gets their portion of the advance based on commission rules:

```sql
-- Example: $300 advance, rules say Agent 0 gets 80%, Agent 1 gets 10%, Agent 2 gets 10%
INSERT INTO oe.Commissions (
    CommissionId, AgentId, EnrollmentId, HouseholdId, GroupId,
    Amount, Balance, Status, TransactionType, PeriodStartDate, PeriodEndDate,
    CreatedDate
) VALUES 
    -- Agent 0's advance: $240
    (NEWID(), @agent0Id, @enrollmentId, @householdId, @groupId, 240.00, 240.00, 'Paid', 'Advance', '2025-01-01', '2025-06-30', GETDATE()),
    -- Agent 1's advance: $30
    (NEWID(), @agent1Id, @enrollmentId, @householdId, @groupId, 30.00, 30.00, 'Paid', 'Advance', '2025-01-01', '2025-06-30', GETDATE()),
    -- Agent 2's advance: $30
    (NEWID(), @agent2Id, @enrollmentId, @householdId, @groupId, 30.00, 30.00, 'Paid', 'Advance', '2025-01-01', '2025-06-30', GETDATE());
```

**Key Points:**
- Each agent gets their own advance commission row **per household/group**
- Each agent has their own `Balance` field **per household/group**
- Balance is tracked per agent + household/group combination
- One agent can have multiple advance balances (one per household/group they have advances for)

## Balance Tracking Approach

### Balance on Original Advance Only (Recommended)

**Original Advance Commission:**
```sql
CommissionId = @advanceCommissionId
Amount = 600.00
Balance = 600.00  -- Updated as payments come in
Status = 'Paid'
TransactionType = 'Advance'
```

**Monthly Commissions:**
```sql
CommissionId = NEWID()
Amount = 100.00  -- Calculated from commission rules
Balance = NULL   -- No balance field needed
Status = 'Pending'
TransactionType = 'Commission'
OriginalCommissionId = @advanceCommissionId
```

**When Payment Comes In:**
```sql
-- 1. Get current advance balance
DECLARE @currentBalance = (
  SELECT Balance 
  FROM oe.Commissions 
  WHERE CommissionId = @advanceCommissionId
);

-- 2. Calculate commission amount (from commission rules)
DECLARE @monthlyCommission = 100.00; -- From commission calculation

-- 3. Update advance balance
UPDATE oe.Commissions 
SET Balance = Balance - @monthlyCommission
WHERE CommissionId = @advanceCommissionId;

-- 4. Get new balance
DECLARE @newBalance = @currentBalance - @monthlyCommission;

-- 5. Create monthly commission
INSERT INTO oe.Commissions (
  Amount, Balance, Status, OriginalCommissionId, ...
) VALUES (
  @monthlyCommission, NULL, 'Pending', @advanceCommissionId, ...
);

-- 6. If balance reached 0, mark eligible commissions as Paid
IF @newBalance <= 0
BEGIN
  UPDATE oe.Commissions 
  SET Status = 'Paid', PaymentDate = @paymentDate
  WHERE OriginalCommissionId = @advanceCommissionId
    AND Status = 'Pending'
    AND Balance IS NULL;
END
```

**Key Points:**
- Balance only on original advance commission
- Monthly commissions don't need balance field
- Simpler queries and logic
- Single source of truth

## Commission Creation Flow

**When Payment Comes In:**

```javascript
async function createCommissionsForPayment(paymentData) {
  const { paymentId, householdId, groupId, paymentDate, enrollmentId } = paymentData;
  
  // 1. Calculate commission distribution using commission rules
  const commissionDistribution = await calculateCommissionDistribution(
    enrollmentId,
    paymentAmount,
    productId
  );
  
  // Result: [
  //   { agentId: 'agent0', amount: 30.00 },
  //   { agentId: 'agent1', amount: 5.00 },
  //   { agentId: 'agent2', amount: 5.00 }
  // ]
  
  // 2. For each agent in the distribution
  for (const agentPayout of commissionDistribution) {
    const { agentId, amount } = agentPayout;
    
    // 3. Check if agent has active advance balance
    const advanceCommission = await getAdvanceCommissionForAgent(
      agentId,
      enrollmentId,
      householdId,
      groupId
    );
    
    if (advanceCommission && advanceCommission.Balance > 0) {
      // 4. Agent has advance balance - apply to balance first
      const currentBalance = advanceCommission.Balance;
      const appliedToBalance = Math.min(currentBalance, amount);
      const newBalance = currentBalance - appliedToBalance;
      const remainingPayout = amount - appliedToBalance;
      
      // 5. Update advance balance
      await updateAdvanceBalance(
        advanceCommission.CommissionId,
        appliedToBalance
      );
      
      // 6. Create commission row (full amount from rules)
      await createCommissionRow({
        agentId,
        enrollmentId,
        householdId,
        groupId,
        paymentId,
        amount: amount, // Full amount from rules ($30)
        balance: NULL, // Monthly commissions don't have balance
        status: 'Pending',
        originalCommissionId: advanceCommission.CommissionId,
        periodStartDate: paymentDate,
        periodEndDate: DATEADD(MONTH, 1, paymentDate)
      });
      
      // 7. If balance reached 0, mark commissions as eligible for payout
      if (newBalance <= 0) {
        await markCommissionsAsEligible(advanceCommission.CommissionId);
      }
      
      // 8. If there's remaining payout (after balance recovery)
      if (remainingPayout > 0) {
        // Create additional commission row for payout
        await createCommissionRow({
          agentId,
          enrollmentId,
          householdId,
          groupId,
          paymentId,
          amount: remainingPayout,
          balance: NULL,
          status: 'Pending', // Can pay out immediately (no advance balance)
          periodStartDate: paymentDate,
          periodEndDate: DATEADD(MONTH, 1, paymentDate)
        });
      }
    } else {
      // 9. No advance balance - create normal commission
      await createCommissionRow({
        agentId,
        enrollmentId,
        householdId,
        groupId,
        paymentId,
        amount: amount,
        balance: NULL,
        status: 'Pending', // Pays out when next payment arrives
        periodStartDate: paymentDate,
        periodEndDate: DATEADD(MONTH, 1, paymentDate)
      });
    }
  }
}
```

## Detailed Example Scenarios

### Scenario 1: Partial Balance Recovery

**Setup:**
- Agent 0 should get: $30 (from commission rules)
- Agent 0's advance balance: $20

**Processing:**
```javascript
const amount = 30.00;  // What agent should get
const currentBalance = 20.00;  // Current advance balance

const appliedToBalance = Math.min(20.00, 30.00);  // = $20
const newBalance = 20.00 - 20.00;  // = $0 (balance fully recovered!)
const remainingPayout = 30.00 - 20.00;  // = $10 (agent gets this)
```

**Result:**
- $20 goes to balance recovery (balance reduced to $0)
- $10 goes to agent as payout
- Agent gets $10 ✅

**Confirmed:** Yes, if Agent 0 should get $30 and their balance is $20, they get $10 payout ($20 to balance, $10 remaining).

### Scenario 2: Full Balance Recovery

**Setup:**
- Month 6: Agent 0 has $40 balance remaining, Agent 1 has $0, Agent 2 has $0
- Month 7: $40 payment comes in
- Commission rules: Agent 0 gets $30, Agent 1 gets $5, Agent 2 gets $5

**Processing:**

**Agent 0:**
- Should get: $30
- Advance balance: $40
- Applied to balance: $30 (reduces balance to $10)
- Remaining payout: $0
- Commission row created: `Amount = $30, Status = 'Pending'` (won't pay out until balance = $0)

**Agent 1:**
- Should get: $5
- Advance balance: $0
- Applied to balance: $0
- Remaining payout: $5
- Commission row created: `Amount = $5, Status = 'Pending'` (can pay out immediately)

**Agent 2:**
- Should get: $5
- Advance balance: $0
- Applied to balance: $0
- Remaining payout: $5
- Commission row created: `Amount = $5, Status = 'Pending'` (can pay out immediately)

**Result:**
- Agent 0: $0 payout (all goes to balance recovery)
- Agent 1: $5 payout
- Agent 2: $5 payout
- Total payout: $10

### Scenario 3: Plan Increase - Overpayment

**Setup:**
- Jan: $50/mo commission, 6mo advance = $300
- Commission rules: Agent 0 gets 80% ($240), Agent 1 gets 10% ($30), Agent 2 gets 10% ($30)
- March: Plan increases to $60/mo
- Month 5: Agent 0 has $20 balance remaining, Agent 1 has $0, Agent 2 has $0
- Month 5: $60 payment comes in

**Commission Rules Calculate:**
- Agent 0: $48 (80% of $60 commission pool)
- Agent 1: $6 (10% of $60 commission pool)
- Agent 2: $6 (10% of $60 commission pool)

**Processing:**

**Agent 0:**
- Should get: $48
- Advance balance: $20
- Applied to balance: $20 (reduces balance to $0)
- Remaining payout: $28
- Commission row created: `Amount = $48, Status = 'Pending'` (balance = 0, can pay out)
- Additional commission row: `Amount = $28, Status = 'Pending'` (immediate payout)

**Agent 1:**
- Should get: $6
- Advance balance: $0
- Applied to balance: $0
- Remaining payout: $6
- Commission row created: `Amount = $6, Status = 'Pending'` (can pay out immediately)

**Agent 2:**
- Should get: $6
- Advance balance: $0
- Applied to balance: $0
- Remaining payout: $6
- Commission row created: `Amount = $6, Status = 'Pending'` (can pay out immediately)

**Result:**
- Agent 0: $28 payout (after $20 balance recovery)
- Agent 1: $6 payout
- Agent 2: $6 payout
- Total payout: $40

### Scenario 4: Flat Rate Rules

**Setup:**
- Jan: $50/mo commission, 6mo advance = $300
- Commission rules: Agent 0 gets $30 flat, Agent 1 gets $5 flat, Agent 2 gets $5 flat
- March: Plan changes to $40/mo
- Month 6: Agent 0 has $40 balance remaining
- Month 7: $40 payment comes in

**Commission Rules Calculate:**
- Agent 0: $30 (flat rate)
- Agent 1: $5 (flat rate)
- Agent 2: $5 (flat rate)
- Total: $40 (matches payment commission pool)

**Processing:**

**Agent 0:**
- Should get: $30
- Advance balance: $40
- Applied to balance: $30 (reduces balance to $10)
- Remaining payout: $0
- Commission row created: `Amount = $30, Status = 'Pending'`

**Agent 1:**
- Should get: $5
- Advance balance: $0
- Applied to balance: $0
- Remaining payout: $5
- Commission row created: `Amount = $5, Status = 'Pending'` (can pay out)

**Agent 2:**
- Should get: $5
- Advance balance: $0
- Applied to balance: $0
- Remaining payout: $5
- Commission row created: `Amount = $5, Status = 'Pending'` (can pay out)

**Result:**
- Agent 0: $0 payout (all goes to balance)
- Agent 1: $5 payout
- Agent 2: $5 payout
- Total payout: $10

**Key Point:** Even with flat rates, the logic works the same way. Each agent's portion is calculated from rules, then applied to their individual advance balance.

## Implementation Details

### Advance Commission Creation

When advance is paid, create advance commissions for each agent based on commission rules:

```javascript
async function createAdvanceCommissions(enrollmentId, advanceMonths, paymentDate) {
  // 1. Calculate monthly commission distribution
  const monthlyDistribution = await calculateCommissionDistribution(
    enrollmentId,
    monthlyPaymentAmount,
    productId
  );
  
  // 2. Calculate total advance per agent
  const advanceDistribution = monthlyDistribution.map(agent => ({
    agentId: agent.agentId,
    monthlyAmount: agent.amount,
    totalAdvance: agent.amount * advanceMonths
  }));
  
  // 3. Create advance commission for each agent
  for (const agentAdvance of advanceDistribution) {
    await createAdvanceCommission({
      agentId: agentAdvance.agentId,
      enrollmentId,
      amount: agentAdvance.totalAdvance,
      balance: agentAdvance.totalAdvance,
      periodStartDate: paymentDate,
      periodEndDate: DATEADD(MONTH, advanceMonths, paymentDate)
    });
  }
}
```

### Balance Recovery Logic

```javascript
async function applyCommissionToBalance(agentId, commissionAmount, enrollmentId, householdId, groupId) {
  // 1. Get agent's advance commission for this enrollment/household/group
  const advanceCommission = await getAdvanceCommissionForAgent(
    agentId,
    enrollmentId,
    householdId,
    groupId
  );
  
  if (!advanceCommission || advanceCommission.Balance <= 0) {
    // No advance balance - full payout
    return {
      appliedToBalance: 0,
      remainingPayout: commissionAmount,
      newBalance: 0
    };
  }
  
  // 2. Calculate balance recovery
  const currentBalance = advanceCommission.Balance;
  const appliedToBalance = Math.min(currentBalance, commissionAmount);
  const newBalance = currentBalance - appliedToBalance;
  const remainingPayout = commissionAmount - appliedToBalance;
  
  // 3. Update advance balance
  await updateAdvanceBalance(advanceCommission.CommissionId, appliedToBalance);
  
  return {
    appliedToBalance,
    remainingPayout,
    newBalance
  };
}
```

## Database Queries

### Get Agent's Advance Balance for Specific Household/Group

```sql
-- Get advance balance for a specific agent + household/group combination
SELECT Balance
FROM oe.Commissions
WHERE AgentId = @agentId
  AND TransactionType = 'Advance'
  AND (
    (HouseholdId = @householdId AND @householdId IS NOT NULL)
    OR
    (GroupId = @groupId AND @groupId IS NOT NULL)
  )
  AND Balance > 0
ORDER BY CreatedDate DESC;
```

**Important:** This query gets the balance for a **specific** household or group. An agent can have multiple advance balances (one per household/group).

### Get All Agents with Advance Balances

```sql
SELECT 
    AgentId,
    SUM(Balance) as TotalBalance
FROM oe.Commissions
WHERE TransactionType = 'Advance'
  AND Balance > 0
GROUP BY AgentId;
```

## Key Takeaways

1. **Per-Agent Balance:** Each agent has their own advance balance, not per enrollment
2. **Per Household/Group:** Each agent can have multiple advance balances (one per household/group)
3. **Rule Calculation First:** Commission rules calculate what each agent SHOULD get
4. **Balance Recovery Second:** Each agent's portion is applied to their balance first
5. **Payout Last:** Only what's left after balance recovery gets paid out
6. **Works for All Rule Types:** Percentage, flat rate, tiered - all work the same way
7. **Natural Handling:** No special logic needed - just apply each agent's portion to their balance


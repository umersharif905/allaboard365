# Commission Tier Rules – Hierarchy Behavior

Describes how **tiered** commission rules distribute payouts by hierarchy level in `CommissionCalculatorService` (backend). See `backend/services/CommissionCalculatorService.js`.

## Intended behavior (tiered rules)

For a **tiered** commission rule (e.g. Essential ShareWELL with Level 0 = $17, Level 1 = $20, Level 2 = $25):

### 1. Direct sales

- Agent Level 0 sells → gets $17 (their tier amount).
- Agent Level 1 sells → gets $20 (their tier amount).
- Agent Level 2 sells → gets $25 (their tier amount).

### 2. Override / downline sales (differential)

When a downline agent sells, each upline gets only the **difference** between their tier amount and the tier amount of the person **below** them in the chain (not the full tier amount).

- **Level 0 sells**
  - Level 0 (seller): $17
  - Level 1 (upline): $20 − $17 = **$3**
  - Level 2 (upline of Level 1): $25 − $20 = **$5**
  - **Total = $25** (top tier amount).

- **Level 1 sells**
  - Level 1 (seller): $20
  - Level 2 (upline): $25 − $20 = **$5**
  - **Total = $25**.

- **Level 0 sells, and Level 0’s direct upline is Level 2** (no Level 1 in between)
  - Level 0 (seller): $17
  - Level 2 (direct upline): $25 − $17 = **$8** (entire remainder)
  - **Total = $25**.

**Summary:**

- **Total commission** for the sale = the **top tier amount** in the chain (the highest tier level that appears in the selling agent + upline chain).
- Each person in the chain gets: **their tier amount minus the tier amount of the person below them** (treat “below” as 0 for the selling agent).

## Previous implementation (incorrect)

- **Total**: Sum of **full** tier amounts for every level present in the upline (e.g. $20 + $25 = $45 when Level 1 and Level 2 were in upline), so total could exceed the top tier amount.
- **Selling agent**: Not included in the upline array, so Level 0 (seller) often got **$0**.
- **Upline**: Each upline got their **full** tier amount instead of the **differential** (e.g. Level 1 got $20 instead of $3).

## Implementation

### `getAgentUpline(agentId)` (CommissionCalculatorService)

Returns the **commission chain**: selling agent first (with their `CommissionTierLevel`), then upline ordered by tier. So tier distribution can pay the selling agent and upline by level.

### `calculateComplexTieredCommission`

The rule total is the **top tier amount only** (the configured amount for the highest tier level present in the chain), not the sum of all tier amounts. That total is capped by `availableCommission`.

### `applyRule` case `'Tier'`

**Differential distribution:**

1. Build `amountForLevel`: tier level → configured amount (from rule `CommissionJson`).
2. Sort chain (selling agent + upline) by tier level ascending.
3. For each agent in order: `amount = amountForLevel(level) - amountForLevel(prevLevel)` (prevLevel for the seller is 0).
4. Scale so the sum of amounts equals `ruleAmount` when needed (e.g. when capped by available commission).

## See also

- `docs/commissions/BALANCE_AND_HIERARCHIES.md` – balance tracking and hierarchy handling
- `docs/commissions/COMMISSION_FLOW_DOCUMENTATION.md` – overall commission flow
- `docs/commissions/RECENT_FINDINGS_2026.md` – tier-specific amounts, tiered rules, etc.

# Commissions Documentation

This directory contains documentation for the commission system, including advances, chargebacks, and refunds.

## Documents

### 1. `ADVANCES_CHARGEBACKS_PLAN.md`
**Comprehensive implementation plan** for advances and chargebacks using the `oe.Commissions` table.

**Key Topics:**
- Database schema changes
- Commission creation triggers
- Balance-based advance recovery
- Plan change handling
- NACHA integration
- Implementation phases
- All Q&A from implementation analysis

### 2. `BALANCE_AND_HIERARCHIES.md`
**Complete guide** for balance tracking and commission hierarchies.

**Key Topics:**
- Per-agent + household/group balance tracking
- Commission distribution with hierarchies
- Partial balance recovery scenarios
- Flat rate vs percentage rules
- All example scenarios
- Implementation details

### 3. `COMMISSION_CREATION.md`
**Complete guide** for creating commissions when payments come in.

**Key Topics:**
- Trigger options (Azure SQL Trigger vs Direct in Webhook)
- Full implementation code
- Commission service class
- Testing strategies
- Setup instructions

### 4. `COMMISSION_FLOW_DOCUMENTATION.md`
**Existing commission flow documentation** (moved here for reference).

### 5. `RULE_EFFECTIVENESS_AND_PAYMENT_DATES.md`
**Rule effectiveness date logic and payment date handling** (January 2026).

**Key Topics:**
- Payment date fields and their meanings (`PaymentDate` vs `CreatedDate`)
- Rule effectiveness date logic (current date vs payment date)
- Commission hold period calculations
- Common scenarios and examples

### 6. `RECENT_FINDINGS_2026.md`
**Recent findings and fixes** (January 2026).

**Key Topics:**
- Product-specific rules for bundles
- Tier-specific commission amounts (EE, ES, EC, EF)
- Flat-rate per-enrollment commissions (`ProductCommissions` JSON)
- `EnrollmentId` nullability
- Rule effectiveness date logic
- Locked vs unlocked rules
- Agent tier level determination
- Complex tiered commission rules
- Batch rule fetching

### 7. `VENDOR_BREAKDOWN_ENROLLMENT_MATCHING.md`
**Vendor Breakdown enrollment matching logic** (January 2026).

**Key Topics:**
- Date-based enrollment matching (not status-based)
- Including terminated enrollments that were active during payment period
- Group vs individual payment logic
- Handling mid-month terminations
- Common scenarios and examples

### 8. `TIER_HIERARCHY.md`
**Tiered commission rules – hierarchy behavior** (CommissionCalculatorService).

**Key Topics:**
- How tiered rules distribute by level (direct sales vs downline/override)
- Differential distribution: each agent gets (their tier amount − tier amount below)
- Total = top tier amount only (not sum of all tiers)
- Selling agent included in chain; `getAgentUpline`, `calculateComplexTieredCommission`, `applyRule` Tier case

## Quick Reference

### Balance Tracking
- **AdvanceBalance field:** Only on original advance commission (`TransactionType = 'Advance'`)
- **Monthly commissions:** `AdvanceBalance = NULL` (no balance field needed)
- **Recovery:** Balance decreases as payments come in, payouts resume when `AdvanceBalance = $0`
- **Amount field:** Represents actual payout to agent (after advance balance recovery)
  - For advances: `Amount` = total advance amount
  - For commissions: `Amount` = actual payout ($0 if all goes to balance, or remaining amount if balance is paid off)

### Commission Creation
- **Recommended (Decoupled):** Azure SQL Trigger (1 second delay, automatic retries, scales independently)
- **Alternative (Simplest):** Direct in webhook handler (instant, no delay, simplest implementation)
- **Logic:** Always create new commission row for each payment
- **Rules:** Commission rules calculate `Amount`, balance determines payout eligibility

### NACHA Generation
- **Agents:** Uses `oe.Commissions` table directly - `Amount` field represents actual payout (after advance balance recovery)
  - Only commissions with `Status = 'Pending'` and `Amount > 0` are included
  - Respects advance balances (only pays out when `AdvanceBalance = 0`)
  - Automatically marks commissions as `Paid` after NACHA generation
- **Vendors/Tenants:** Uses `oe.Payments` table (no advances, calculated on-the-fly)

### Chargebacks
- **When needed:** Only for cancellations and refunds
- **Plan decreases:** Handled by slower balance recovery (no chargeback needed)

### Tiered rules (hierarchy)
- **Total:** Top tier amount only (highest level in selling agent + upline chain), not sum of all tier amounts
- **Distribution:** Differential — each agent gets (their tier amount − tier amount of person below); seller gets full tier amount
- **Chain:** Selling agent first, then upline (by tier); see `TIER_HIERARCHY.md`

### Split Commissions
- **Application Order:** Split rules are applied **LAST**, after all regular commission rules
- **How it works:** 
  - All regular rules are applied first to calculate each agent's total commission
  - Then, if a split rule exists for the payment's HouseholdId/GroupId, it takes from the primary agent's total and distributes to split partners
  - Split rules are HouseholdId or GroupId specific (or global if no HouseholdId/GroupId specified)
- **Storage:** Split details stored in `oe.Commissions`:
  - `SplitPartnerAgentId` - The other agent in the split
  - `SplitPercentage` - This agent's percentage of the split
  - `IsPrimaryInSplit` - Whether this agent is the primary (true) or partner (false)
- **UI Display:** Split commission details shown in commission rules modal with agent names and percentages

### Draft Payments & Commissions
- **Purpose:** Track expected payments and commissions before they're finalized
- **Status Values:** 
  - `oe.Payments.Status`: `'Draft'` (expected payment, subject to change)
  - `oe.Commissions.Status`: `'Draft'` (estimated commission, subject to change)
- **Flow:**
  - Day 1: Create Draft payment and Draft commissions (via Azure SQL Trigger)
  - Day 5: When payment succeeds, UPDATE Draft payment to `'Completed'` and Draft commissions to `'Pending'`
  - Azure SQL Trigger handles UPDATE operations to recalculate commissions
- **Recalculation:** When webhook fires, check for existing Draft payment and update it (overwrite amounts, commission, netrate, etc.)
- **Commission Updates:** Delete existing Draft commissions and recreate with updated amounts

## Migration Script

See `backend/migrations/add-advances-chargebacks-refunds.sql` for database schema changes.

## Commission Creation Options

**Two main approaches:**

1. **Azure SQL Trigger (Recommended for Decoupling)**
   - Uses SQL change tracking to monitor `oe.Payments` table
   - Triggers Azure Function when payments are inserted
   - Default 1 second delay (configurable to 100ms)
   - Automatic retry logic for failed commission creation
   - Scales independently based on pending changes
   - See `COMMISSION_CREATION_TRIGGER.md` for details

2. **Direct in Webhook Handler (Simplest)**
   - Add commission creation directly in payment webhook handler
   - Instant processing (no delay)
   - Simplest implementation
   - See `COMMISSION_CREATION_TRIGGER.md` for details

See `COMMISSION_CREATION_TRIGGER.md` for full comparison and implementation details.

## Next Steps

1. Review `ADVANCES_CHARGEBACKS_PLAN.md` for comprehensive implementation plan
2. Review `BALANCE_AND_HIERARCHIES.md` for balance tracking and hierarchy handling
3. Review `COMMISSION_CREATION.md` for trigger options and implementation code
4. Run migration script when ready
5. Implement commission creation logic
6. Update NACHA generation


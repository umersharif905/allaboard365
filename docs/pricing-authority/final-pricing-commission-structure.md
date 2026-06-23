# FINAL PRICING & COMMISSION STRUCTURE

## **CRITICAL CLARIFICATION - FIELD DEFINITIONS**

### From `oe.ProductPricing` (per tier/age band):

1. **`NetRate`** → Base cost component
   - This is the base cost/premium component
   - Used in MSRP calculation: MSRP = NetRate + OverrideRate + VendorCommission + SystemFees
   - NOT a direct payout field - it represents the cost component

2. **`OverrideRate`** → 100% goes to **Tenant/Product Owner**
   - Fixed dollar amount paid to the tenant who owns the product
   - Separate from commission pool

3. **`VendorCommission`** → **Agent Commission Pool** (ignore the name, it's confusing)
   - This is the allocated commission amount for agents
   - Commission rules apply to this pool
   - Any overflow/leftover from this pool goes to the Tenant/Product Owner
   - **TODO**: Rename this field to `AgentCommissionPool` in the future (not today)

4. **`SystemFees`** → 100% goes to **Platform** (OpenEnroll)
   - Fees for processing and administration

### Formula:
```
MSRP = NetRate + OverrideRate + VendorCommission + SystemFees
```

---

## Payout Distribution Flow

### When a payment is received:

1. **Vendor gets**: Payment includes `NetRate` component (cost of goods)
2. **Tenant gets**: 100% of `OverrideRate` (from ProductPricing) **+** overflow from agent commission pool
3. **Agents get**: Distributed from `VendorCommission` pool based on commission rules
4. **Platform gets**: 100% of `SystemFees` (from ProductPricing)

**Note**: `NetRate` is a premium component, not a direct payout. The total `PaymentAmount` received includes all components.

---

## Database Schema Changes Needed

### 1. `oe.Enrollments` - Add new fields:
```sql
- ProductPricingId (uniqueidentifier) - Link to specific pricing tier
- NetRate (decimal(19,4)) - Snapshot of base cost component
- OverrideRate (decimal(19,4)) - Snapshot of tenant override
- Commission (decimal(19,4)) - Snapshot of agent commission pool (from VendorCommission)
- SystemFees (decimal(19,4)) - Snapshot of system fees
```

### 2. `oe.Payments` - Update fields for consistency:
```sql
- NetRate (decimal(19,4)) - Base cost component
- Commission (decimal(19,4)) - Agent commission pool amount
- OverrideRate (decimal(19,4)) - Tenant override amount
- [Rename existing fields to match?]
```

---

## Migration Plan

### Phase 1: Documentation & Code Updates ✅
- [x] Update documentation to reflect correct field definitions
- [ ] Update CommissionCalculatorService comments/logging
- [ ] Update NACHAService comments/logging

### Phase 2: `oe.Enrollments` Schema ✅
- [x] Add new fields to `oe.Enrollments` table
- [x] Create SQL migration script
- [x] Run SQL migration script

### Phase 3: Enrollment Creation Logic ✅
- [x] Update EnrollmentCompletionService to populate new fields
- [x] Update enrollment-links.js createOrUpdateEnrollment to populate new fields
- [x] Test new enrollment creation to verify pricing fields populate correctly - SUCCESS!

### Phase 4: Payment Processing Logic
- [ ] Update `oe.Payments` fields
- [ ] Update payment creation to aggregate from enrollments
- [ ] Update NACHA generation to use new field structure

### Phase 5: Cleanup
- [ ] Backfill existing enrollments with pricing snapshots
- [ ] Backfill existing payments
- [ ] Verify all commission calculations work correctly

---

## Field Name Confusion

**PROBLEM**: `oe.ProductPricing.VendorCommission` is a MISLEADING name.

**REALITY**: It's the **agent commission pool**, not a vendor payout.

**WORKAROUND**: For now, use `VendorCommission` in the database but understand in code/documentation that it represents the agent commission pool.

**FUTURE**: Rename the database field from `VendorCommission` to `AgentCommissionPool` (separate migration task).

---

## Commission Calculation Logic

### Current Implementation:
1. Get `VendorCommission` from `oe.ProductPricing` (this is the **agent commission pool**)
2. Apply commission rules to this pool
3. Any leftover goes to Tenant/Product Owner

### Payout Order:
1. **Vendor**: Gets `NetRate` (100%)
2. **Override**: Gets `OverrideRate` (100%) to Tenant
3. **Agents**: Get distribution from `VendorCommission` pool via rules
4. **Tenant**: Gets overflow from `VendorCommission` pool

---

## AddProductWizard Field Mapping

| UI Field Label | Database Field | Actual Purpose |
|----------------|----------------|----------------|
| **"Vendor"** | `oe.ProductPricing.NetRate` | Base cost to vendor |
| **"Commission"** | `oe.ProductPricing.VendorCommission` | **Agent commission pool** (confusing name!) |
| **"Override"** | `oe.ProductPricing.OverrideRate` | Tenant override payout |
| **"System Fees"** | `oe.ProductPricing.SystemFees` | Platform fees |

---

## Examples

### Example 1: Simple Product
```
ProductPricing:
- NetRate: $50 (cost component)
- VendorCommission: $20 (agent pool)
- OverrideRate: $15 (tenant override)
- SystemFees: $5 (platform)
- MSRP: $90

Payment Received: $90

Distribution:
- Payment includes: $50 NetRate component (covers vendor cost)
- Tenant gets: $15 (OverrideRate) + overflow from agent pool
- Agents get: Distributed from $20 pool via commission rules
- Platform gets: $5 (SystemFees)

Total Payouts: $15 (tenant) + $X (agents) + $5 (platform) + overflow
```

### Example 2: Agent Commission Pool Exhausted
```
Commission Pool: $20
Commission Rules payout: $18
Overflow to Tenant: $2

Final:
- Vendor: $50
- Agents: $18 (from pool)
- Tenant: $15 (override) + $2 (overflow) = $17
- Platform: $5
Total: $90 ✅
```

---

## Code Locations to Update

### Backend:
1. `backend/services/CommissionCalculatorService.js`
   - Update comments to clarify `VendorCommission` = agent pool
   - Update variable names in logging

2. `backend/services/NACHAService.js`
   - Update comments for clarity

3. `backend/routes/enrollment-links.js`
   - Add logic to populate new `oe.Enrollments` fields

4. `backend/services/paymentDatabaseService.js`
   - Update to use new field structure

5. `backend/routes/products.js`
   - Already fixed to save `OverrideRate` ✅

### Frontend:
1. `frontend/src/components/forms/AddProductWizard.tsx`
   - Update tooltips to clarify field purposes (already partially done)

2. `frontend/src/components/forms/steps/Step4Pricing.tsx`
   - Update field tooltips for clarity

---

## Important Notes

1. **DO NOT** rename `oe.ProductPricing.VendorCommission` yet - that's a future migration
2. **DO** update all documentation and comments to refer to it as "agent commission pool"
3. **DO** update `oe.Enrollments` and `oe.Payments` to use consistent naming
4. **DO** snapshot pricing fields in enrollments at enrollment time
5. **DO** aggregate from enrollments when creating payments

---

## Testing Checklist

- [ ] Create a new product with pricing tiers
- [ ] Create a new enrollment - verify fields populate
- [ ] Create a payment - verify commission calculation
- [ ] Generate NACHA - verify payouts are correct
- [ ] Edit product pricing - verify existing enrollments aren't affected
- [ ] View payment details - verify all fields display correctly

---

## Breaking Changes

**None yet** - this is preparing for the migration. Existing code should continue to work during transition.


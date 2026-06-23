# Applying Included Processing Fee to Proposals

Proposal PDFs and business-proposal calculations currently use **PricingEngine** (and BundleProcessor) only, so they show **base premium** and do not apply the tenant’s “included processing fee” (or round-up) settings. The enrollment wizard does apply that via the enrollment product-pricing API. This doc describes how to make proposals use the same display logic so amounts match.

## Prerequisite: Shared util (already in place)

- **`backend/utils/includedProcessingFee.js`** is the single source of truth for included-fee display logic.
- **`getDisplayPremiumForProduct(tenantId, productId, basePremium)`**  
  Loads tenant `PaymentProcessorSettings` and product `TenantProductSubscriptions` (IncludeProcessingFee, RoundUpProcessingFee), applies the same formula as enrollment-links, and returns:
  - `productBasePremium`, `includeProcessingFee`, `roundUpProcessingFee`, `includedProcessingFeeAmount`, `totalProductPremium`
- Use this when you have a **base premium** (from PricingEngine/BundleProcessor) and want the **display total** (base + included fee when configured). If you already have tenant settings and product flags in scope, you can use **`calculateIncludedProcessingFeeForDisplay(baseAmount, tenantSettings, roundUpEnabled)`** instead.

Do **not** duplicate the fee formula in proposal code; always go through this util.

---

## 1. Proposal generator (individual proposal PDFs)

**File:** `backend/services/proposalGenerator.service.js`

**Goal:** Price fields in the PDF should show the same amount as the enrollment wizard (base + included fee when the tenant has it enabled).

1. **Return `tenantId` from agent info**  
   In `getAgentInfo(agentId)`:
   - Add `a.TenantId` to the SELECT from `oe.Agents` (with the rest of the agent fields).
   - Include `tenantId: agent.TenantId || null` in the returned object.

2. **Use the util in `calculatePriceForField`**  
   - Add an optional 4th parameter: `tenantId` (e.g. `calculatePriceForField(productId, configValue, memberCriteria, tenantId)`).
   - After you compute the **base** premium (from PricingEngine or BundleProcessor), if `tenantId` is provided:
     - `const includedProcessingFee = require('../utils/includedProcessingFee');`
     - `const display = await includedProcessingFee.getDisplayPremiumForProduct(tenantId, productId, base);`
     - Return `display.totalProductPremium` instead of `base`.
   - If `tenantId` is not provided, return the base as today (backward compatible).
   - Apply this in every branch where you currently return a number (single product with `pricingDetails`, bundle sum, fallback `monthlyPremium`).

3. **Pass `tenantId` when calling `calculatePriceForField`**  
   In `generateProposalPDF`, when you build the price cache for price fields, you already have `agentInfo`. Call:
   - `this.calculatePriceForField(field.ProductId, field.ConfigValue, memberCriteria, agentInfo.tenantId)`  
   so the cached price uses the display total when the agent’s tenant has included fee enabled.

**Result:** Individual proposal PDF price fields show base + included processing fee when configured, matching enrollment wizard.

---

## 2. Proposal calculation service (business proposal tier prices)

**File:** `backend/services/proposalCalculation.service.js`

**Goal:** Tier prices used in business proposal calculations (e.g. `calcMwTierPrice_EE`) should be display totals (base + included fee when configured).

1. **Allow optional `tenantId` in `calcMwTierPrice`**  
   - Change signature to: `calcMwTierPrice(productId, oopLevel, tier, tenantId)` (`tenantId` optional).
   - Compute the **base** premium exactly as you do now (PricingEngine/BundleProcessor, then sum netRate + overrideRate + vendorCommission or bundle included products, etc.). Store in a variable, e.g. `base`.
   - If `tenantId` is provided:
     - `const includedProcessingFee = require('../utils/includedProcessingFee');`
     - `const display = await includedProcessingFee.getDisplayPremiumForProduct(tenantId, productId, base);`
     - Return `Math.round(display.totalProductPremium)` (or your usual rounding).
   - If `tenantId` is not provided, return `base` (or current rounding of it) so behavior is unchanged when `tenantId` is missing.

2. **Pass `tenantId` from `computeAllCalculations`**  
   - In `computeAllCalculations(inputs, documentCalcTypes, productSlots)`:
     - Destructure `tenantId` from `inputs` (e.g. `tenantId: inputTenantId`).
     - Where you call `calcMwTierPrice(slot.productId, oopLevel, tier)`, change to:
       - `calcMwTierPrice(slot.productId, oopLevel, tier, inputTenantId)`.

**Result:** Business proposal tier prices and downstream calculations use display premium (with included fee when configured).

---

## 3. Business proposal send route (provide `tenantId` in inputs)

**File:** `backend/routes/business-proposal-sends.js`

**Goal:** When generating business proposals, `computeAllCalculations` must receive `tenantId` so it can pass it to `calcMwTierPrice`.

1. **Resolve agent’s tenant once per request**  
   After you have `agentId` (and before the loop over documents), load the agent’s tenant, e.g.:
   - `SELECT TenantId FROM oe.Agents WHERE AgentId = @agentId`
   - Store in a variable such as `agentTenantId` (null if not found).

2. **Include `tenantId` in the `inputs` object passed to `computeAllCalculations`**  
   When you build `inputs` for each document (companyName, totalEmployees, contribution values, etc.), add:
   - `tenantId: agentTenantId`
   so that `proposalCalculation.service.js` can use it when calling `calcMwTierPrice(..., inputTenantId)`.

**Result:** Business proposal PDFs use the same display tier prices as enrollment wizard for that tenant.

---

## 4. Backward compatibility and testing

- **Optional `tenantId`:** Every new use of the util is gated on `tenantId` being present. If it’s missing (e.g. old callers or no agent), keep returning the base premium so existing behavior does not change.
- **Enrollment wizard:** No change required; it already uses the enrollment product-pricing API, which applies the fee.
- **Testing:**  
  - For a tenant that has “include processing fee” (and optionally “round up”) enabled on a product, compare:  
    - Enrollment wizard product-pricing (or contribution-preview) for that product.  
    - Individual proposal PDF price field for that product.  
    - Business proposal tier price for that product.  
  - They should match. With included fee disabled (or no `tenantId`), proposal amounts should match current (base-only) behavior.

---

## 5. Summary of touch points

| File | Change |
|------|--------|
| `backend/utils/includedProcessingFee.js` | Already exists; do not modify for this feature. |
| `backend/services/proposalGenerator.service.js` | `getAgentInfo` return `tenantId`; `calculatePriceForField(..., tenantId)` use `getDisplayPremiumForProduct` when `tenantId` set; `generateProposalPDF` pass `agentInfo.tenantId` into `calculatePriceForField`. |
| `backend/services/proposalCalculation.service.js` | `calcMwTierPrice(..., tenantId)` use `getDisplayPremiumForProduct` when `tenantId` set; `computeAllCalculations` read `inputs.tenantId` and pass to `calcMwTierPrice`. |
| `backend/routes/business-proposal-sends.js` | Load agent’s `TenantId` by `agentId`; add `tenantId: agentTenantId` to `inputs` for `computeAllCalculations`. |

Once these are applied, proposal prices will align with enrollment wizard display (base + included processing fee when configured), without changing behavior when `tenantId` is absent.

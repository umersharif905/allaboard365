/**
 * Agent pricing TYPES ONLY.
 *
 * Prior to the pricing-authority migration this module also exported the helpers
 * `getMemberPricingBreakdown`, `getDisplayedMemberPremiumForRow`,
 * `getBundleTierSystemFees`, and `getProductTabPremiumDisplay`. Those functions
 * duplicated backend fee math in TypeScript (hardcoded `paymentMethod: 'ACH'`,
 * re-implemented round-up, etc.) and were the exact drift pattern Task 2.1
 * eliminated on the backend.
 *
 * Phase 2 (Task 2.2) removed every caller: the agent product list, product tab,
 * bundle simulator, and pricing list now render price from the backend-computed
 * `authority` block (bundle-simulator, quick-quote) or the per-row
 * `computedMemberDisplay` field (catalog endpoint). This file is intentionally
 * types-only going forward — the backend `pricingAuthority` service is the
 * single source of truth for pricing math.
 *
 * New fee-math primitives MUST live in `backend/services/pricing/pricingAuthority.service.js`.
 * Do NOT re-introduce computation helpers here; add the required field to the
 * authority response instead.
 */

import type { PaymentProcessorSettings } from '../types/paymentProcessorSettings';
import type { SystemFeesSettings } from '../services/systemFeesCalculator';

/**
 * Per-product subscription fee flags as returned by
 * `GET /api/me/agent/products/:productId/pricing` under `feeContext.feesByProductId[productId]`.
 * Consumers should treat this as opaque fee configuration — use the backend-computed
 * `computedMemberDisplay` on each pricing row for display, never reconstruct the math here.
 */
export interface ProductFeeConfig {
  includeProcessingFee: boolean;
  roundUpProcessingFee: boolean;
  zeroFeeForACH: boolean;
  customSystemFeeEnabled: boolean;
  customSystemFeeAmount: number | null;
}

/** Matches backend `feeCfgDefaults` when no subscription row exists. */
export const DEFAULT_PRODUCT_FEE_CONFIG: ProductFeeConfig = {
  includeProcessingFee: false,
  roundUpProcessingFee: true,
  zeroFeeForACH: false,
  customSystemFeeEnabled: false,
  customSystemFeeAmount: null,
};

/**
 * Shape returned by the agent pricing endpoints as `feeContext`. Kept for type parity
 * with the backend payload; callers should not pass this into any TS math helper
 * (there are none) — it exists so components can display fee policy metadata when the
 * backend has not pre-computed a display field.
 */
export interface AgentPricingFeeContext {
  chargeFeeToMember: boolean;
  paymentProcessorSettings: PaymentProcessorSettings | null;
  systemFeesSettings: SystemFeesSettings | null;
  feesByProductId: Record<string, ProductFeeConfig>;
}

/**
 * Per-product row inside `authority.products[]` as emitted by
 * `backend/services/pricing/pricingAuthority.service.js::computePricing`.
 *
 * Returned by:
 *   - POST /api/me/agent/products/:productId/pricing/bundle-simulator (per tier)
 *   - POST /api/me/agent/quick-quote/calculate (per scenario)
 *
 * `displayPremium` is the authoritative member-facing premium (base + included
 * processing fee using the 'Highest' policy). Render this verbatim — do NOT
 * add or recompute fees on the client.
 */
export interface AuthorityProductRow {
  productId: string;
  productName: string;
  isBundle: boolean;
  basePremium: number;
  includedFee: number;
  displayPremium: number;
  includedProducts: Array<{
    productId: string;
    productName: string;
    basePremium: number;
    includedFee: number;
    displayPremium: number;
  }>;
}

/**
 * Totals block inside the authority payload. `monthlyContribution` is the final
 * number the member will be billed (displayPremiumTotal + nonIncludedFeeTotal + systemFees).
 */
export interface AuthorityTotals {
  basePremiumTotal: number;
  includedFeeTotal: number;
  nonIncludedFeeTotal: number;
  systemFees: number;
  displayPremiumTotal: number;
  monthlyContribution: number;
}

/**
 * Pre-formatted display block the UI renders verbatim — every `amount` / `value`
 * is already a currency string (e.g. "$157.00"). Prefer this over raw numbers
 * when the component is a straight render; fall back to `AuthorityTotals` when
 * arithmetic is needed (comparisons, charts).
 */
export interface AuthorityDisplay {
  lineItems: Array<{
    productId: string;
    label: string;
    isBundle: boolean;
    amount: string;
    includedProducts?: Array<{
      productId: string;
      label: string;
      amount: string;
    }>;
  }>;
  summary: {
    rows: Array<{
      // Narrowed to the exact keys the backend's buildDisplayBlock emits
      // (see backend/services/pricing/pricingAuthority.service.js). Adding a
      // fourth key here must be done alongside the backend change.
      key: 'premium' | 'fees' | 'total';
      label: string;
      value: string;
      emphasis?: boolean;
    }>;
  };
  policies: {
    includedFeeMethod: 'Highest';
    nonIncludedFeeMethod: 'ACH' | 'Card';
    chargeFeeToMember: boolean;
  };
}

/**
 * Top-level `authority` block attached to pricing responses. The client should
 * send `pricingFingerprint` back to the backend on submit so the server can
 * verify it will bill exactly what was quoted.
 */
export interface AuthorityBlock {
  products: AuthorityProductRow[];
  totals: AuthorityTotals;
  display: AuthorityDisplay;
  pricingFingerprint: string;
  /**
   * Backend-internal debug state (payment method, fee config, etc.). Do NOT
   * consume from UI code — if you need a specific value, add a proper field to
   * the authority output instead. Typed as `unknown` to force an explicit cast
   * for anyone who reaches for it.
   */
  _raw?: unknown;
}

import { describe, expect, it } from 'vitest';
import * as agentPricingDisplay from '../agentPricingDisplay';
import {
  DEFAULT_PRODUCT_FEE_CONFIG,
  type AgentPricingFeeContext,
  type AuthorityBlock,
  type AuthorityDisplay,
  type AuthorityProductRow,
  type AuthorityTotals,
  type ProductFeeConfig,
} from '../agentPricingDisplay';

/**
 * Regression guard for Task 2.2 of the pricing authority migration.
 *
 * `agentPricingDisplay.ts` MUST remain types-only. Any computation helper
 * re-introduced here would reinstate the client-side fee math drift that
 * the backend `pricingAuthority` service was built to eliminate — new fee
 * primitives belong in the backend, exposed via the `authority` response
 * block. If this test fails because someone added a function export, move
 * the logic to `backend/services/pricing/pricingAuthority.service.js`
 * instead of extending this module.
 */
describe('agentPricingDisplay module surface', () => {
  it('exports only the DEFAULT_PRODUCT_FEE_CONFIG value (no computation helpers)', () => {
    const valueExports = Object.keys(agentPricingDisplay).filter((key) => {
      const value = (agentPricingDisplay as Record<string, unknown>)[key];
      return typeof value !== 'undefined';
    });
    expect(valueExports).toEqual(['DEFAULT_PRODUCT_FEE_CONFIG']);
  });

  it('does not export any function (all fee math lives in the backend authority service)', () => {
    const functionExports = Object.entries(agentPricingDisplay).filter(
      ([, value]) => typeof value === 'function'
    );
    expect(functionExports).toEqual([]);
  });

  it('DEFAULT_PRODUCT_FEE_CONFIG matches the backend feeCfgDefaults shape', () => {
    expect(DEFAULT_PRODUCT_FEE_CONFIG).toEqual({
      includeProcessingFee: false,
      roundUpProcessingFee: true,
      zeroFeeForACH: false,
      customSystemFeeEnabled: false,
      customSystemFeeAmount: null,
    });
  });
});

describe('agentPricingDisplay types mirror the authority response shape', () => {
  it('AgentPricingFeeContext accepts a populated context', () => {
    const ctx: AgentPricingFeeContext = {
      chargeFeeToMember: true,
      paymentProcessorSettings: null,
      systemFeesSettings: null,
      feesByProductId: {
        'product-abc': DEFAULT_PRODUCT_FEE_CONFIG,
      },
    };
    expect(ctx.feesByProductId['product-abc']).toBe(DEFAULT_PRODUCT_FEE_CONFIG);
  });

  it('ProductFeeConfig allows the known fee flags', () => {
    const cfg: ProductFeeConfig = {
      includeProcessingFee: true,
      roundUpProcessingFee: false,
      zeroFeeForACH: true,
      customSystemFeeEnabled: true,
      customSystemFeeAmount: 12.5,
    };
    expect(cfg.customSystemFeeAmount).toBe(12.5);
  });

  it('AuthorityBlock carries products, totals, display, pricingFingerprint', () => {
    const product: AuthorityProductRow = {
      productId: 'p1',
      productName: 'Standalone',
      isBundle: false,
      basePremium: 100,
      includedFee: 7,
      displayPremium: 107,
      includedProducts: [],
    };
    const totals: AuthorityTotals = {
      basePremiumTotal: 100,
      includedFeeTotal: 7,
      nonIncludedFeeTotal: 0,
      systemFees: 0,
      displayPremiumTotal: 107,
      monthlyContribution: 107,
    };
    const display: AuthorityDisplay = {
      lineItems: [
        { productId: 'p1', label: 'Standalone', isBundle: false, amount: '$107.00' },
      ],
      summary: {
        rows: [
          { key: 'premium', label: 'Monthly Premium', value: '$107.00' },
          { key: 'total', label: 'Your Monthly Contribution', value: '$107.00', emphasis: true },
        ],
      },
      policies: {
        includedFeeMethod: 'Highest',
        nonIncludedFeeMethod: 'ACH',
        chargeFeeToMember: true,
      },
    };
    const block: AuthorityBlock = {
      products: [product],
      totals,
      display,
      pricingFingerprint: 'sha256:deadbeef',
    };
    expect(block.display.summary.rows[1].emphasis).toBe(true);
    expect(block.totals.monthlyContribution).toBe(107);
    expect(block.products[0].displayPremium).toBe(107);
  });

  it('AuthorityProductRow supports bundle rows with includedProducts', () => {
    const row: AuthorityProductRow = {
      productId: 'bundle-1',
      productName: 'Gold Bundle',
      isBundle: true,
      basePremium: 200,
      includedFee: 12,
      displayPremium: 212,
      includedProducts: [
        {
          productId: 'comp-1',
          productName: 'Component A',
          basePremium: 120,
          includedFee: 8,
          displayPremium: 128,
        },
        {
          productId: 'comp-2',
          productName: 'Component B',
          basePremium: 80,
          includedFee: 4,
          displayPremium: 84,
        },
      ],
    };
    expect(row.includedProducts).toHaveLength(2);
    expect(row.includedProducts[0].displayPremium).toBe(128);
  });
});

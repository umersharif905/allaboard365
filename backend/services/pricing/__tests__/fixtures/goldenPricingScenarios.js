/**
 * Golden pricing scenarios — prod-shaped fixtures for cross-surface parity tests.
 * Each scenario models real bundle/product fee semantics (Concierge, Copay Silver, APEX Copay).
 */

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

const DEFAULT_TENANT_ROW = {
  PaymentProcessorSettings: JSON.stringify({
    chargeFeeToMember: true,
    activeProcessor: 'openenroll',
    processors: {
      openenroll: {
        fees: {
          ach: { percentageFee: 0.008, flatFee: 0 },
          creditCard: { percentageFee: 0.03, flatFee: 0 }
        }
      }
    }
  }),
  SystemFees: JSON.stringify({ enabled: false })
};

function buildPricingRow({ productId, productName, tier, premium, overrides = {} }) {
  return {
    ProductPricingId: `${productId}-${tier}`,
    ProductId: productId,
    PricingProductId: productId,
    NetRate: premium,
    OverrideRate: 0,
    VendorCommission: 0,
    SystemFees: 0,
    MSRPRate: premium,
    MinAge: 0,
    MaxAge: 999,
    TobaccoStatus: 'N/A',
    TierType: tier,
    Label: 'Standard',
    ConfigField1: null,
    ConfigField2: null,
    ConfigField3: null,
    ConfigField4: null,
    ConfigField5: null,
    ConfigValue1: null,
    ConfigValue2: null,
    ConfigValue3: null,
    ConfigValue4: null,
    ConfigValue5: null,
    Status: 'Active',
    EffectiveDate: '2024-01-01T00:00:00.000Z',
    TerminationDate: null,
    IsVendorPrice: false,
    ProductName: productName,
    RequiredDataFields: null,
    AllowedConfigOptions: null,
    IncludedProcessingFee: 0,
    ...overrides
  };
}

function subRow(overrides = {}) {
  return {
    IncludeProcessingFee: false,
    RoundUpProcessingFee: false,
    ZeroFeeForACH: false,
    CustomSystemFeeEnabled: false,
    CustomSystemFeeAmount: null,
    ...overrides
  };
}

/** MightyWELL / ShareWELL Concierge membership bundle (mixed component fee flags + platform fees). */
const CONCIERGE_MEMBERSHIP = {
  key: 'conciergeMembership',
  label: 'MightyWELL Concierge membership bundle',
  isBundle: true,
  bundleId: '11111111-1111-1111-1111-111111111101',
  bundleName: 'MightyWELL Health Concierge Membership Bundle',
  componentIds: [
    '11111111-1111-1111-1111-111111111102',
    '11111111-1111-1111-1111-111111111103'
  ],
  criteria: {
    age: 35,
    tobaccoUse: 'N',
    tier: 'EE',
    paymentMethod: 'ACH',
    configValue: '1500'
  },
  configValues: { 1: ['1500'] },
  configLabels: { 1: 'Unshared Amount' },
  tenantRow: {
    ...DEFAULT_TENANT_ROW,
    SystemFees: JSON.stringify({
      platformFee: { enabled: true, MemberPaid: true, MemberPaidAmount: 2 },
      mobileAppFee: { enabled: true, MemberPaid: true, MemberPaidAmount: 1 },
      aiAssistantFee: { enabled: true, MemberPaid: true, MemberPaidAmount: 0.5 }
    })
  },
  subscriptions: {
    '11111111-1111-1111-1111-111111111101': subRow(),
    '11111111-1111-1111-1111-111111111102': subRow({
      IncludeProcessingFee: false,
      ZeroFeeForACH: false,
      RoundUpProcessingFee: true
    }),
    '11111111-1111-1111-1111-111111111103': subRow({
      IncludeProcessingFee: false,
      ZeroFeeForACH: true,
      RoundUpProcessingFee: false
    })
  },
  pricingRowsForProduct(productId) {
    const [lyricId, essentialId] = this.componentIds;
    if (productId === lyricId) {
      return ['EE', 'ES', 'EC', 'EF'].map((tier) =>
        buildPricingRow({
          productId: lyricId,
          productName: 'Lyric Concierge',
          tier,
          premium: 24,
          overrides: {
            NetRate: 3.25,
            OverrideRate: 10.75,
            VendorCommission: 10,
            MSRPRate: 24,
            TobaccoStatus: 'N/A',
            IncludedProcessingFee: 0
          }
        })
      );
    }
    if (productId === essentialId) {
      return ['EE', 'ES', 'EC', 'EF'].map((tier, idx) =>
        buildPricingRow({
          productId: essentialId,
          productName: 'Essential (ShareWELL)',
          tier,
          premium: 220 + idx * 190,
          overrides: {
            ConfigField1: 'Unshared Amount $',
            ConfigValue1: '1500',
            NetRate: 194 + idx * 190,
            OverrideRate: 0,
            VendorCommission: 26,
            MSRPRate: 220 + idx * 190,
            TobaccoStatus: 'No',
            IncludedProcessingFee: 0
          }
        })
      );
    }
    return [];
  },
  /** Catalog-normalized parts (matches buildPricingProductFromCatalogRow output). */
  catalogParts() {
    const [lyricId, essentialId] = this.componentIds;
    return [
      {
        productId: lyricId,
        productName: 'Lyric Concierge',
        basePremium: 24,
        pricingDetails: undefined
      },
      {
        productId: essentialId,
        productName: 'Essential (ShareWELL)',
        basePremium: 220,
        pricingDetails: undefined
      }
    ];
  }
};

/** MightyWELL Copay Silver bundle — included fees stored on catalog rows. */
const COPAY_SILVER_BUNDLE = {
  key: 'copaySilverBundle',
  label: 'MightyWELL Copay Silver bundle',
  isBundle: true,
  bundleId: '11111111-1111-1111-1111-111111111201',
  bundleName: 'MightyWELL Copay Silver Bundle',
  componentIds: [
    '11111111-1111-1111-1111-111111111202',
    '11111111-1111-1111-1111-111111111203'
  ],
  criteria: {
    age: 35,
    tobaccoUse: 'N',
    tier: 'EE',
    paymentMethod: 'ACH',
    configValue: ''
  },
  configValues: {},
  configLabels: {},
  tenantRow: DEFAULT_TENANT_ROW,
  subscriptions: {
    '11111111-1111-1111-1111-111111111201': subRow(),
    '11111111-1111-1111-1111-111111111202': subRow({
      IncludeProcessingFee: true,
      RoundUpProcessingFee: true
    }),
    '11111111-1111-1111-1111-111111111203': subRow({
      IncludeProcessingFee: true,
      RoundUpProcessingFee: true
    })
  },
  pricingRowsForProduct(productId) {
    const [mwId, swId] = this.componentIds;
    if (productId === mwId) {
      return ['EE', 'ES', 'EC', 'EF'].map((tier, idx) =>
        buildPricingRow({
          productId: mwId,
          productName: 'MightyWELL Copay Silver',
          tier,
          premium: 215 + idx * 50,
          overrides: {
            NetRate: 200 + idx * 50,
            MSRPRate: 215 + idx * 50,
            IncludedProcessingFee: 15,
            TobaccoStatus: 'N/A'
          }
        })
      );
    }
    if (productId === swId) {
      return ['EE', 'ES', 'EC', 'EF'].map((tier, idx) =>
        buildPricingRow({
          productId: swId,
          productName: 'ShareWELL Silver',
          tier,
          premium: 194 + idx * 50,
          overrides: {
            NetRate: 180 + idx * 50,
            MSRPRate: 194 + idx * 50,
            IncludedProcessingFee: 14,
            TobaccoStatus: 'N/A'
          }
        })
      );
    }
    return [];
  },
  catalogParts() {
    const [mwId, swId] = this.componentIds;
    return [
      {
        productId: mwId,
        productName: 'MightyWELL Copay Silver',
        basePremium: 200,
        pricingDetails: { includedProcessingFee: 15 }
      },
      {
        productId: swId,
        productName: 'ShareWELL Silver',
        basePremium: 180,
        pricingDetails: { includedProcessingFee: 14 }
      }
    ];
  }
};

/** APEX Copay Basic — standalone individual product with non-included ACH fee. */
const APEX_COPAY_STANDALONE = {
  key: 'apexCopayStandalone',
  label: 'APEX Copay Basic (individual)',
  isBundle: false,
  bundleId: '11111111-1111-1111-1111-111111111301',
  bundleName: 'APEX Copay Basic',
  componentIds: [],
  criteria: {
    age: 35,
    tobaccoUse: 'N',
    tier: 'EE',
    paymentMethod: 'ACH',
    configValue: ''
  },
  configValues: {},
  configLabels: {},
  tenantRow: DEFAULT_TENANT_ROW,
  subscriptions: {
    '11111111-1111-1111-1111-111111111301': subRow({
      IncludeProcessingFee: false,
      RoundUpProcessingFee: false,
      ZeroFeeForACH: false
    })
  },
  pricingRowsForProduct(productId) {
    if (productId !== this.bundleId) return [];
    return ['EE', 'ES', 'EC', 'EF'].map((tier, idx) =>
      buildPricingRow({
        productId,
        productName: 'APEX Copay Basic',
        tier,
        premium: 108 + idx * 40,
        overrides: {
          NetRate: 105 + idx * 40,
          MSRPRate: 105 + idx * 40,
          IncludedProcessingFee: 0,
          TobaccoStatus: 'N/A'
        }
      })
    );
  },
  catalogParts() {
    return [
      {
        productId: this.bundleId,
        productName: 'APEX Copay Basic',
        basePremium: 105,
        pricingDetails: undefined
      }
    ];
  }
};

const GOLDEN_PRICING_SCENARIOS = [
  CONCIERGE_MEMBERSHIP,
  COPAY_SILVER_BUNDLE,
  APEX_COPAY_STANDALONE
];

module.exports = {
  TENANT_ID,
  DEFAULT_TENANT_ROW,
  buildPricingRow,
  GOLDEN_PRICING_SCENARIOS,
  CONCIERGE_MEMBERSHIP,
  COPAY_SILVER_BUNDLE,
  APEX_COPAY_STANDALONE
};

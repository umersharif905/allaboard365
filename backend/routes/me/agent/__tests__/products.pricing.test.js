/**
 * Integration tests for agent product pricing routes.
 *
 * Phase 2 of the pricingAuthority migration: verify each handler that previously called the fee
 * primitives directly now returns an `authority` block produced by `pricingAuthority.computePricing`.
 *
 * Strategy:
 *   - Mock `getPool` to return a scripted response per SQL statement so the real
 *     `pricingAuthority.service` runs end-to-end (we want fee-policy drift to fail tests).
 *   - Mock the `authorize` + `requireTenantAccess` middleware to skip the DB-backed auth path.
 *   - DO NOT mock `pricingAuthority` itself — the whole point is regression coverage of the
 *     service's fee semantics.
 */

const request = require('supertest');
const express = require('express');

// -----------------------------------------------------------------------------
// Scripted fake mssql pool.
// -----------------------------------------------------------------------------
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const BUNDLE_PRODUCT_ID = '22222222-2222-2222-2222-222222222222';
const COMPONENT_A_ID = '33333333-3333-3333-3333-333333333333';
const COMPONENT_B_ID = '44444444-4444-4444-4444-444444444444';
const STANDALONE_PRODUCT_ID = '55555555-5555-5555-5555-555555555555';

const TENANT_ROW = {
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

// Default: included-fee enabled on every product so drift tests have signal.
const SUBSCRIPTION_ROWS = {
  [COMPONENT_A_ID]: {
    ProductId: COMPONENT_A_ID,
    IncludeProcessingFee: true,
    RoundUpProcessingFee: true,
    ZeroFeeForACH: false,
    CustomSystemFeeEnabled: false,
    CustomSystemFeeAmount: null
  },
  [COMPONENT_B_ID]: {
    ProductId: COMPONENT_B_ID,
    IncludeProcessingFee: true,
    RoundUpProcessingFee: true,
    ZeroFeeForACH: false,
    CustomSystemFeeEnabled: false,
    CustomSystemFeeAmount: null
  },
  [STANDALONE_PRODUCT_ID]: {
    ProductId: STANDALONE_PRODUCT_ID,
    IncludeProcessingFee: false,
    RoundUpProcessingFee: false,
    ZeroFeeForACH: false,
    CustomSystemFeeEnabled: false,
    CustomSystemFeeAmount: null
  },
  [BUNDLE_PRODUCT_ID]: {
    ProductId: BUNDLE_PRODUCT_ID,
    IncludeProcessingFee: false,
    RoundUpProcessingFee: false,
    ZeroFeeForACH: false,
    CustomSystemFeeEnabled: false,
    CustomSystemFeeAmount: null
  }
};

function buildPricingRow({ productId, productName, tier, premium }) {
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
    ConfigField1: null, ConfigField2: null, ConfigField3: null, ConfigField4: null, ConfigField5: null,
    ConfigValue1: null, ConfigValue2: null, ConfigValue3: null, ConfigValue4: null, ConfigValue5: null,
    Status: 'Active',
    EffectiveDate: '2024-01-01T00:00:00.000Z',
    TerminationDate: null,
    IsVendorPrice: false,
    ProductName: productName,
    RequiredDataFields: null,
    AllowedConfigOptions: null
  };
}

/** ShareWELL Concierge prod-shape pricing rows (bundle simulator + quick quote). */
function sharewellConciergePricingRecordset(includedProductId) {
  const isLyric = includedProductId === COMPONENT_A_ID;
  const productName = isLyric ? 'Lyric Concierge' : 'Essential (ShareWELL)';
  if (isLyric) {
    return ['EE', 'ES', 'EC', 'EF'].map((tier) => ({
      ...buildPricingRow({ productId: COMPONENT_A_ID, productName, tier, premium: 24 }),
      NetRate: 3.25,
      OverrideRate: 10.75,
      VendorCommission: 10,
      MSRPRate: 24,
      TobaccoStatus: 'N/A',
      IncludedProcessingFee: 0
    }));
  }
  return ['EE', 'ES', 'EC', 'EF'].map((tier, idx) => ({
    ...buildPricingRow({ productId: COMPONENT_B_ID, productName, tier, premium: 220 + idx * 190 }),
    ConfigField1: 'Unshared Amount $',
    ConfigValue1: '1500',
    NetRate: 194 + idx * 190,
    OverrideRate: 0,
    VendorCommission: 26,
    MSRPRate: 220 + idx * 190,
    TobaccoStatus: 'No',
    IncludedProcessingFee: 0
  }));
}

function applySharewellConciergeFixture(originalQuery) {
  const originalTenantRow = { ...TENANT_ROW };
  const originalSubB = { ...SUBSCRIPTION_ROWS[COMPONENT_B_ID] };
  const originalSubA = { ...SUBSCRIPTION_ROWS[COMPONENT_A_ID] };
  TENANT_ROW.SystemFees = JSON.stringify({
    platformFee: { enabled: true, MemberPaid: true, MemberPaidAmount: 2 },
    mobileAppFee: { enabled: true, MemberPaid: true, MemberPaidAmount: 1 },
    aiAssistantFee: { enabled: true, MemberPaid: true, MemberPaidAmount: 0.5 }
  });
  SUBSCRIPTION_ROWS[COMPONENT_B_ID] = {
    ...SUBSCRIPTION_ROWS[COMPONENT_B_ID],
    IncludeProcessingFee: false,
    ZeroFeeForACH: true,
    RoundUpProcessingFee: false
  };
  SUBSCRIPTION_ROWS[COMPONENT_A_ID] = {
    ...SUBSCRIPTION_ROWS[COMPONENT_A_ID],
    IncludeProcessingFee: false,
    ZeroFeeForACH: false,
    RoundUpProcessingFee: true
  };

  const sharewellQuery = (sqlText, params) => {
    if (/FROM oe\.ProductPricing\b/i.test(sqlText)) {
      if (/LEFT JOIN oe\.ProductBundles\b/i.test(sqlText)) {
        return { recordset: sharewellConciergePricingRecordset(params.includedProductId) };
      }
      if (/WHERE pp\.ProductId = @productId/i.test(sqlText)) {
        return { recordset: sharewellConciergePricingRecordset(params.productId) };
      }
    }
    return originalQuery(sqlText, params);
  };

  getPool.mockImplementation(async () => ({
    request() {
      const params = {};
      const self = {
        input(name, _type, value) { params[name] = value; return self; },
        async query(text) { return sharewellQuery(text, params); }
      };
      return self;
    }
  }));

  return () => {
    TENANT_ROW.SystemFees = originalTenantRow.SystemFees;
    SUBSCRIPTION_ROWS[COMPONENT_B_ID] = originalSubB;
    SUBSCRIPTION_ROWS[COMPONENT_A_ID] = originalSubA;
    getPool.mockImplementation(async () => makeFakePool());
  };
}

// SQL router: inspects the text + bound params and returns a scripted recordset.
function scriptedQuery(sqlText, params) {
  // Tenants: fee settings fetch (used by both pricingAuthority + loadAgentPricingFeeContext + quick-quote).
  if (/FROM oe\.Tenants\b/i.test(sqlText) && /PaymentProcessorSettings/i.test(sqlText)) {
    return { recordset: [TENANT_ROW] };
  }
  // Products: IsBundle check.
  if (/FROM oe\.Products\b/i.test(sqlText) && /IsBundle/i.test(sqlText) && /WHERE ProductId = @productId\s*$/i.test(sqlText.trim())) {
    const pid = params.productId;
    if (pid === BUNDLE_PRODUCT_ID) return { recordset: [{ IsBundle: true }] };
    if (pid === STANDALONE_PRODUCT_ID) return { recordset: [{ IsBundle: false }] };
    return { recordset: [{ IsBundle: false }] };
  }
  // Products: catalog IncludeProcessingFee flags (loadFeeSettingsByProductId).
  if (/FROM oe\.Products\b/i.test(sqlText) && /IncludeProcessingFee/i.test(sqlText) && /ProductId IN/i.test(sqlText)) {
    const ids = Object.keys(params).filter((k) => k.startsWith('productId_')).map((k) => params[k]);
    return {
      recordset: ids.map((id) => {
        const sub = SUBSCRIPTION_ROWS[id];
        return {
          ProductId: id,
          IncludeProcessingFee: sub?.IncludeProcessingFee === true,
          RoundUpProcessingFee: sub?.RoundUpProcessingFee === true,
          ProcessingFeePercentage: null
        };
      })
    };
  }
  // Products: selected-products metadata (quick-quote).
  if (/FROM oe\.Products\b/i.test(sqlText) && /ProductId IN/i.test(sqlText)) {
    const ids = Object.keys(params).filter((k) => k.startsWith('pid_')).map((k) => params[k]);
    const rows = ids.map((id) => {
      if (id === BUNDLE_PRODUCT_ID) return { ProductId: BUNDLE_PRODUCT_ID, Name: 'Bundle', IsBundle: true };
      if (id === STANDALONE_PRODUCT_ID) return { ProductId: STANDALONE_PRODUCT_ID, Name: 'Standalone', IsBundle: false };
      return null;
    }).filter(Boolean);
    return { recordset: rows };
  }
  // ProductBundles: included products list.
  if (/FROM oe\.ProductBundles\b/i.test(sqlText)) {
    if (params.bundleProductId === BUNDLE_PRODUCT_ID) {
      return { recordset: [
        { IncludedProductId: COMPONENT_A_ID },
        { IncludedProductId: COMPONENT_B_ID }
      ] };
    }
    return { recordset: [] };
  }
  // ProductPricing (bundle-included form with LEFT JOIN ProductBundles).
  if (/FROM oe\.ProductPricing\b/i.test(sqlText) && /LEFT JOIN oe\.ProductBundles\b/i.test(sqlText)) {
    const productName = params.includedProductId === COMPONENT_A_ID ? 'Component A' : 'Component B';
    const premium = params.includedProductId === COMPONENT_A_ID ? 210 : 220;
    return {
      recordset: [
        buildPricingRow({ productId: params.includedProductId, productName, tier: 'EE', premium }),
        buildPricingRow({ productId: params.includedProductId, productName, tier: 'ES', premium: premium + 50 }),
        buildPricingRow({ productId: params.includedProductId, productName, tier: 'EC', premium: premium + 100 }),
        buildPricingRow({ productId: params.includedProductId, productName, tier: 'EF', premium: premium + 150 })
      ]
    };
  }
  // ProductPricing (single product form).
  if (/FROM oe\.ProductPricing\b/i.test(sqlText) && /WHERE pp\.ProductId = @productId/i.test(sqlText)) {
    const premium = params.productId === STANDALONE_PRODUCT_ID ? 100 : 50;
    return {
      recordset: [
        buildPricingRow({ productId: params.productId, productName: 'Standalone', tier: 'EE', premium })
      ]
    };
  }
  // TenantProductSubscriptions: subscription flags fetch (pricingAuthority + loadAgentPricingFeeContext + quick-quote).
  if (/FROM oe\.TenantProductSubscriptions\b/i.test(sqlText)) {
    if (params.bundleParentProductId && /ProductId = @bundleParentProductId/i.test(sqlText)) {
      const row = SUBSCRIPTION_ROWS[params.bundleParentProductId];
      return {
        recordset: row
          ? [{
              IncludeProcessingFee: row.IncludeProcessingFee,
              RoundUpProcessingFee: row.RoundUpProcessingFee,
              ZeroFeeForACH: row.ZeroFeeForACH
            }]
          : []
      };
    }
    // Accept any param whose name starts with productId_ (authority / util) or sub_pid_ (quick-quote).
    const ids = Object.keys(params)
      .filter((k) => k.startsWith('productId_') || k.startsWith('sub_pid_'))
      .map((k) => params[k]);
    const rows = ids.map((id) => SUBSCRIPTION_ROWS[id]).filter(Boolean);
    return { recordset: rows };
  }
  throw new Error(`[test fake pool] Unexpected SQL:\n${sqlText}\nparams=${JSON.stringify(params)}`);
}

function makeFakePool() {
  return {
    request() {
      const params = {};
      const self = {
        input(name, _type, value) { params[name] = value; return self; },
        async query(text) { return scriptedQuery(text, params); }
      };
      return self;
    }
  };
}

// -----------------------------------------------------------------------------
// Module mocks — must be declared before requiring the route module.
// -----------------------------------------------------------------------------
jest.mock('../../../../config/database', () => ({
  getPool: jest.fn(),
  sql: new Proxy({}, { get: () => 'MOCK_SQL_TYPE' })
}));

jest.mock('../../../../middleware/auth', () => ({
  authorize: () => (_req, _res, next) => next(),
  authenticate: (req, _res, next) => {
    req.user = req.user || {
      UserId: 'user-1',
      TenantId: '11111111-1111-1111-1111-111111111111',
      roles: ['Agent'],
      currentRole: 'Agent'
    };
    next();
  },
  getUserRoles: (user) => {
    if (!user) return [];
    if (Array.isArray(user.roles) && user.roles.length) return user.roles;
    if (user.currentRole) return [user.currentRole];
    return ['Agent'];
  }
}));

jest.mock('../../../../middleware/requireTenantAccess', () => {
  return (req, _res, next) => {
    req.user = req.user || { UserId: 'user-1', TenantId: '11111111-1111-1111-1111-111111111111' };
    req.tenantId = '11111111-1111-1111-1111-111111111111';
    next();
  };
});

// Other heavy deps that are imported at top of the route but unused by the handlers we exercise.
jest.mock('../../../uploads', () => ({
  authenticateUrls: jest.fn(),
  authenticateProductDocumentsArray: jest.fn()
}));
jest.mock('../../../../services/shared/product-documents.service', () => ({
  getProductDocumentsForProductIds: jest.fn()
}));
jest.mock('../../../../services/agentProductCommissionPreview.service', () => ({
  getAgentProductCommissionPreview: jest.fn(),
  getTenantProductCommissionPreview: jest.fn(),
  listTenantCommissionGroups: jest.fn()
}));
jest.mock('../../../../services/quickQuotePdf.service', () => ({
  generateQuickQuotePdfBuffer: jest.fn()
}));
jest.mock('../../../../services/proposalGenerator.service', () => ({}));
jest.mock('../../../../services/sendGridEmailService', () => ({}));
jest.mock('../../../../services/sendGridEmailDeliveryTracking.service', () => ({}));
jest.mock('../../../../services/messageQueue.service', () => ({}));

const { getPool } = require('../../../../config/database');

function buildApp() {
  const routes = require('../products');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { UserId: 'user-1', TenantId: TENANT_ID, roles: ['Agent'], currentRole: 'Agent' };
    req.tenantId = TENANT_ID;
    next();
  });
  app.use('/api/me/agent/products', routes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  getPool.mockImplementation(async () => makeFakePool());
});

// -----------------------------------------------------------------------------
// /quick-quote/calculate — the scenario quote handler.
// -----------------------------------------------------------------------------
describe('POST /api/me/agent/products/quick-quote/calculate', () => {
  const baseBody = {
    criteria: { age: 35, tobaccoUse: 'N', tier: 'EE', paymentMethod: 'ACH' },
    selectedProducts: [
      { productId: STANDALONE_PRODUCT_ID, configValues: {} }
    ]
  };

  test('returns an authority block with a sha256 pricing fingerprint', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/me/agent/products/quick-quote/calculate').send(baseBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.authority).toBeDefined();
    expect(res.body.data.authority.pricingFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('authority.totals.monthlyContribution is a finite number', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/me/agent/products/quick-quote/calculate').send(baseBody);

    expect(res.status).toBe(200);
    const total = res.body.data.authority.totals.monthlyContribution;
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBeGreaterThan(0);
  });

  test('authority.display.lineItems is non-empty when products were priced', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/me/agent/products/quick-quote/calculate').send(baseBody);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.authority.display.lineItems)).toBe(true);
    expect(res.body.data.authority.display.lineItems.length).toBeGreaterThan(0);
  });

  test('fingerprint is deterministic across identical requests', async () => {
    const app = buildApp();
    const first = await request(app).post('/api/me/agent/products/quick-quote/calculate').send(baseBody);
    const second = await request(app).post('/api/me/agent/products/quick-quote/calculate').send(baseBody);

    expect(first.body.data.authority.pricingFingerprint).toBe(second.body.data.authority.pricingFingerprint);
  });

  test('legacy fields remain populated alongside authority block (backward-compat)', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/me/agent/products/quick-quote/calculate').send(baseBody);

    expect(res.body.data.criteria).toBeDefined();
    expect(res.body.data.breakdown).toBeDefined();
    expect(res.body.data.totals).toBeDefined();
    expect(res.body.data.totals.totalPremium).toBeGreaterThan(0);
  });

  test('multiple unshared-amount options on one product → per-product comparison, no combined total', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/me/agent/products/quick-quote/calculate')
      .send({
        criteria: { age: 35, tobaccoUse: 'N', tier: 'EE', paymentMethod: 'ACH' },
        selectedProducts: [
          { productId: STANDALONE_PRODUCT_ID, configValues: { 1: ['5000', '2500'] }, configLabels: { 1: 'Unshared Amount' } }
        ]
      });

    expect(res.status).toBe(200);
    // comparison mode: each amount option shown on its own, no cartesian explosion
    expect(res.body.data.comparison).toBe(true);
    // every amount option is present in the breakdown, not just the first scenario
    expect(res.body.data.breakdown).toHaveLength(2);
    // no "Totals by option" cartesian boxes
    expect(res.body.data.quoteOptions).toEqual([]);
    // a combined total is ambiguous across amount choices, so it is omitted
    expect(res.body.data.totals.totalPremium).toBe(0);
    expect(res.body.data.authority).toBeNull();
    // each option carries its own authority-sourced Total + Fees (so the UI can show
    // Total/Fees per option, not just the base display premium)
    for (const item of res.body.data.breakdown) {
      expect(item.premiumWithIncludedFee).toBeGreaterThan(0);
      expect(item.optionTotals).toBeDefined();
      expect(item.optionTotals.totalPremium).toBeGreaterThan(0);
      expect(item.optionTotals).toHaveProperty('processingFee');
      expect(item.optionTotals).toHaveProperty('systemFees');
      // total must cover the display premium plus any separate fees
      expect(item.optionTotals.totalPremium).toBeGreaterThanOrEqual(item.premiumWithIncludedFee);
    }
  });

  test('ShareWELL Concierge prod shape: quick-quote total matches bundle-simulator EE total', async () => {
    const restore = applySharewellConciergeFixture(scriptedQuery);
    try {
      const app = buildApp();
      const simRes = await request(app)
        .post(`/api/me/agent/products/${BUNDLE_PRODUCT_ID}/pricing/bundle-simulator`)
        .send({ tobacco: 'N', age: 35, configValue: '1500', paymentMethod: 'ACH' });
      expect(simRes.status).toBe(200);
      const eeSim = simRes.body.data.bundleTotalsByTier.find((t) => t.tier === 'EE');
      expect(eeSim.totalPremium).toBe(247.7);

      const qqRes = await request(app)
        .post('/api/me/agent/products/quick-quote/calculate')
        .send({
          criteria: { age: 35, tobaccoUse: 'N', tier: 'EE', paymentMethod: 'ACH' },
          selectedProducts: [
            { productId: BUNDLE_PRODUCT_ID, configValues: { 1: ['1500'] }, configLabels: { 1: 'Unshared Amount' } }
          ]
        });
      expect(qqRes.status).toBe(200);
      expect(qqRes.body.data.breakdown).toHaveLength(1);
      const item = qqRes.body.data.breakdown[0];
      expect(item.optionTotals.totalPremium).toBe(eeSim.totalPremium);
      expect(item.premiumWithIncludedFee).toBe(eeSim.subtotalWithIncluded);
      expect(item.optionTotals.processingFee).toBe(eeSim.processingFee);
      expect(item.optionTotals.systemFees).toBe(eeSim.systemFees);
    } finally {
      restore();
    }
  });

  test('does not double-count stored included processing fee on retail MSRP', async () => {
    const originalQuery = scriptedQuery;
    const includedFeeQuery = (sqlText, params) => {
      if (/FROM oe\.ProductPricing\b/i.test(sqlText) && /WHERE pp\.ProductId = @productId/i.test(sqlText)) {
        if (params.productId === STANDALONE_PRODUCT_ID) {
          return {
            recordset: [{
              ...buildPricingRow({ productId: STANDALONE_PRODUCT_ID, productName: 'Concierge Component', tier: 'EE', premium: 360 }),
              NetRate: 360,
              OverrideRate: 0,
              VendorCommission: 0,
              MSRPRate: 360,
              IncludedProcessingFee: 0
            }]
          };
        }
      }
      return originalQuery(sqlText, params);
    };

    getPool.mockImplementation(async () => ({
      request() {
        const params = {};
        const self = {
          input(name, _type, value) { params[name] = value; return self; },
          async query(text) { return includedFeeQuery(text, params); }
        };
        return self;
      }
    }));

    try {
      const app = buildApp();
      const res = await request(app)
        .post('/api/me/agent/products/quick-quote/calculate')
        .send({
          criteria: { age: 35, tobaccoUse: 'N', tier: 'EE', paymentMethod: 'ACH' },
          selectedProducts: [{ productId: STANDALONE_PRODUCT_ID, configValues: {} }]
        });
      expect(res.status).toBe(200);
      const item = res.body.data.breakdown[0];
      expect(item.premiumWithIncludedFee).toBe(360);
      expect(item.optionTotals.processingFee).toBeCloseTo(2.88, 2);
      expect(item.optionTotals.totalPremium).toBeCloseTo(362.88, 2);
    } finally {
      getPool.mockImplementation(async () => makeFakePool());
    }
  });
});

// -----------------------------------------------------------------------------
// /:productId/pricing/bundle-simulator — bundle pricing simulator.
// -----------------------------------------------------------------------------
describe('POST /api/me/agent/products/:productId/pricing/bundle-simulator', () => {
  const baseBody = { tobacco: 'N', age: 35, paymentMethod: 'ACH' };

  test('returns an authority block with sha256 fingerprint', async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/me/agent/products/${BUNDLE_PRODUCT_ID}/pricing/bundle-simulator`)
      .send(baseBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.authority).toBeDefined();
    expect(res.body.data.authority.pricingFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('authority.totals.monthlyContribution is a finite positive number', async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/me/agent/products/${BUNDLE_PRODUCT_ID}/pricing/bundle-simulator`)
      .send(baseBody);

    const total = res.body.data.authority.totals.monthlyContribution;
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBeGreaterThan(0);
  });

  test('authority.display.lineItems is non-empty', async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/me/agent/products/${BUNDLE_PRODUCT_ID}/pricing/bundle-simulator`)
      .send(baseBody);

    expect(res.body.data.authority.display.lineItems.length).toBeGreaterThan(0);
  });

  test('fingerprint is deterministic', async () => {
    const app = buildApp();
    const a = await request(app)
      .post(`/api/me/agent/products/${BUNDLE_PRODUCT_ID}/pricing/bundle-simulator`)
      .send(baseBody);
    const b = await request(app)
      .post(`/api/me/agent/products/${BUNDLE_PRODUCT_ID}/pricing/bundle-simulator`)
      .send(baseBody);
    expect(a.body.data.authority.pricingFingerprint).toBe(b.body.data.authority.pricingFingerprint);
  });

  test('ES tier: authority displayPremiumTotal matches subtotalWithIncluded (parity)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/me/agent/products/${BUNDLE_PRODUCT_ID}/pricing/bundle-simulator`)
      .send(baseBody);
    const es = res.body.data.bundleTotalsByTier.find((t) => t.tier === 'ES');
    expect(es).toBeDefined();
    expect(es.authority?.totals?.displayPremiumTotal).toBeDefined();
    expect(Number(es.subtotalWithIncluded)).toBeCloseTo(Number(es.authority.totals.displayPremiumTotal), 4);
  });

  test('Highest-policy bundle: ACH vs Card produce identical displayPremiumTotal for ES tier', async () => {
    const app = buildApp();
    const achRes = await request(app)
      .post(`/api/me/agent/products/${BUNDLE_PRODUCT_ID}/pricing/bundle-simulator`)
      .send({ tobacco: 'N', age: 35, paymentMethod: 'ACH' });
    const cardRes = await request(app)
      .post(`/api/me/agent/products/${BUNDLE_PRODUCT_ID}/pricing/bundle-simulator`)
      .send({ tobacco: 'N', age: 35, paymentMethod: 'Card' });
    const esAch = achRes.body.data.bundleTotalsByTier.find((t) => t.tier === 'ES');
    const esCard = cardRes.body.data.bundleTotalsByTier.find((t) => t.tier === 'ES');
    expect(esAch.authority.totals.displayPremiumTotal).toBeCloseTo(esCard.authority.totals.displayPremiumTotal, 4);
  });

  test('legacy bundleTotalsByTier remains populated', async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/me/agent/products/${BUNDLE_PRODUCT_ID}/pricing/bundle-simulator`)
      .send(baseBody);
    expect(Array.isArray(res.body.data.bundleTotalsByTier)).toBe(true);
  });

  test('configValue with zero-premium UA stub still returns positive EE total via fallback', async () => {
    const originalQuery = scriptedQuery;
    const scriptedQueryWithUaStub = (sqlText, params) => {
      if (/FROM oe\.ProductPricing\b/i.test(sqlText) && /LEFT JOIN oe\.ProductBundles\b/i.test(sqlText)) {
        const productName = params.includedProductId === COMPONENT_A_ID ? 'Component A' : 'Component B';
        const premium = params.includedProductId === COMPONENT_A_ID ? 210 : 220;
        const rows = [
          buildPricingRow({ productId: params.includedProductId, productName, tier: 'EE', premium }),
          buildPricingRow({ productId: params.includedProductId, productName, tier: 'ES', premium: premium + 50 }),
          buildPricingRow({ productId: params.includedProductId, productName, tier: 'EC', premium: premium + 100 }),
          buildPricingRow({ productId: params.includedProductId, productName, tier: 'EF', premium: premium + 150 })
        ];
        if (params.includedProductId === COMPONENT_A_ID) {
          rows.push({
            ...buildPricingRow({ productId: params.includedProductId, productName, tier: 'EE', premium: 0 }),
            ConfigField1: 'Unshared Amount $',
            ConfigValue1: '2500',
            MSRPRate: 0,
            NetRate: 0
          });
        }
        return { recordset: rows };
      }
      return originalQuery(sqlText, params);
    };

    getPool.mockImplementation(async () => ({
      request() {
        const params = {};
        const self = {
          input(name, _type, value) { params[name] = value; return self; },
          async query(text) { return scriptedQueryWithUaStub(text, params); }
        };
        return self;
      }
    }));

    const app = buildApp();
    const res = await request(app)
      .post(`/api/me/agent/products/${BUNDLE_PRODUCT_ID}/pricing/bundle-simulator`)
      .send({ ...baseBody, configValue: '2500' });

    expect(res.status).toBe(200);
    const ee = res.body.data.bundleTotalsByTier.find((t) => t.tier === 'EE');
    expect(ee).toBeDefined();
    expect(Number(ee.totalPremium)).toBeGreaterThan(0);
  });

  test('ShareWELL Concierge prod shape: premium 244; all-in adds platform + Lyric ACH fees', async () => {
    const restore = applySharewellConciergeFixture(scriptedQuery);
    try {
      const app = buildApp();
      const res = await request(app)
        .post(`/api/me/agent/products/${BUNDLE_PRODUCT_ID}/pricing/bundle-simulator`)
        .send({ tobacco: 'N', age: 35, configValue: '1500', paymentMethod: 'ACH' });
      expect(res.status).toBe(200);
      const ee = res.body.data.bundleTotalsByTier.find((t) => t.tier === 'EE');
      // Enrollment product-selection premium (no platform/processing lines)
      expect(ee.subtotalWithIncluded).toBe(244);
      expect(ee.processingFee).toBe(0.2);
      expect(ee.systemFees).toBe(3.5);
      // All-in monthly contribution (confirmation-step total)
      expect(ee.totalPremium).toBe(247.7);
    } finally {
      restore();
    }
  });
});

// -----------------------------------------------------------------------------
// /:productId/pricing — agent product-tab pricing (catalog of tiers).
// The endpoint returns a list of tier rows, not a single quote; applying a top-level
// authority quote block is not meaningful for a catalog. What matters here is that
// the per-row `computedMemberDisplay.includedProcessingFee` uses the authority's
// 'Highest' policy — NOT a hardcoded ACH path — so agent-quoted prices match what
// members are later charged.
// -----------------------------------------------------------------------------
describe('GET /api/me/agent/products/:productId/pricing', () => {
  test('legacy enriched pricing array remains populated', async () => {
    const app = buildApp();
    const res = await request(app).get(`/api/me/agent/products/${STANDALONE_PRODUCT_ID}/pricing`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  test('tier MSRPRate is shown directly even when component base differs', async () => {
    const originalQuery = scriptedQuery;
    const scriptedWithFlatMsrp = (sqlText, params) => {
      if (/FROM oe\.ProductPricing\b/i.test(sqlText) && /WHERE pp\.ProductId = @productId/i.test(sqlText)) {
        return {
          recordset: [{
            ...buildPricingRow({ productId: STANDALONE_PRODUCT_ID, productName: 'MEC', tier: 'EE', premium: 135.75 }),
            NetRate: 75,
            OverrideRate: 10.75,
            VendorCommission: 50,
            SystemFees: 0,
            MSRPRate: 141,
            IncludedProcessingFee: 5.25
          }]
        };
      }
      return originalQuery(sqlText, params);
    };
    getPool.mockImplementation(async () => ({
      request() {
        const params = {};
        const self = {
          input(name, _type, value) { params[name] = value; return self; },
          async query(text) { return scriptedWithFlatMsrp(text, params); }
        };
        return self;
      }
    }));

    const app = buildApp();
    const res = await request(app).get(`/api/me/agent/products/${STANDALONE_PRODUCT_ID}/pricing`);
    expect(res.status).toBe(200);
    const row = res.body.data.find((r) => r.computedMemberDisplay);
    expect(row.computedMemberDisplay.displayPremium).toBe(141);
    expect(row.computedMemberDisplay.basePremium).toBe(135.75);
  });

  test('tier stored IncludedProcessingFee shows retail without product IncludeProcessingFee flag', async () => {
    const originalQuery = scriptedQuery;
    const scriptedWithCatalogTier = (sqlText, params) => {
      if (/FROM oe\.ProductPricing\b/i.test(sqlText) && /WHERE pp\.ProductId = @productId/i.test(sqlText)) {
        return {
          recordset: [{
            ...buildPricingRow({ productId: STANDALONE_PRODUCT_ID, productName: 'MEC', tier: 'EE', premium: 100 }),
            NetRate: 100,
            MSRPRate: 103,
            IncludedProcessingFee: 3
          }]
        };
      }
      return originalQuery(sqlText, params);
    };
    getPool.mockImplementation(async () => ({
      request() {
        const params = {};
        const self = {
          input(name, _type, value) { params[name] = value; return self; },
          async query(text) { return scriptedWithCatalogTier(text, params); }
        };
        return self;
      }
    }));

    const app = buildApp();
    const res = await request(app).get(`/api/me/agent/products/${STANDALONE_PRODUCT_ID}/pricing`);
    expect(res.status).toBe(200);
    const row = res.body.data.find((r) => r.computedMemberDisplay);
    expect(row.computedMemberDisplay.displayPremium).toBe(103);
    expect(row.computedMemberDisplay.includedProcessingFee).toBe(3);
    expect(row.computedMemberDisplay.basePremium).toBe(100);
  });

  test('product-level include uses Highest policy when tier has no MSRP', async () => {
    const originalInclude = SUBSCRIPTION_ROWS[STANDALONE_PRODUCT_ID].IncludeProcessingFee;
    SUBSCRIPTION_ROWS[STANDALONE_PRODUCT_ID].IncludeProcessingFee = true;
    const originalQuery = scriptedQuery;
    const scriptedNoMsrp = (sqlText, params) => {
      if (/FROM oe\.ProductPricing\b/i.test(sqlText) && /WHERE pp\.ProductId = @productId/i.test(sqlText)) {
        return {
          recordset: [{
            ...buildPricingRow({ productId: STANDALONE_PRODUCT_ID, productName: 'Standalone', tier: 'EE', premium: 100 }),
            MSRPRate: 0,
            NetRate: 100
          }]
        };
      }
      return originalQuery(sqlText, params);
    };
    getPool.mockImplementation(async () => ({
      request() {
        const params = {};
        const self = {
          input(name, _type, value) { params[name] = value; return self; },
          async query(text) { return scriptedNoMsrp(text, params); }
        };
        return self;
      }
    }));
    try {
      const app = buildApp();
      const res = await request(app).get(`/api/me/agent/products/${STANDALONE_PRODUCT_ID}/pricing`);
      expect(res.status).toBe(200);
      const row = res.body.data.find((r) => r.computedMemberDisplay);
      expect(row).toBeDefined();
      // $100 * Card 3% = $3.00. Hardcoded-ACH would produce $0.80 (or $0 with zeroFeeForACH).
      expect(row.computedMemberDisplay.includedProcessingFee).toBe(3);
      expect(row.computedMemberDisplay.displayPremium).toBe(103);
    } finally {
      SUBSCRIPTION_ROWS[STANDALONE_PRODUCT_ID].IncludeProcessingFee = originalInclude;
    }
  });

  test('product-level include applies dynamic fee when MSRPRate equals component base', async () => {
    const originalInclude = SUBSCRIPTION_ROWS[STANDALONE_PRODUCT_ID].IncludeProcessingFee;
    const originalRoundUp = SUBSCRIPTION_ROWS[STANDALONE_PRODUCT_ID].RoundUpProcessingFee;
    SUBSCRIPTION_ROWS[STANDALONE_PRODUCT_ID].IncludeProcessingFee = true;
    SUBSCRIPTION_ROWS[STANDALONE_PRODUCT_ID].RoundUpProcessingFee = true;
    const originalQuery = scriptedQuery;
    const scriptedBaseMsrp = (sqlText, params) => {
      if (/FROM oe\.ProductPricing\b/i.test(sqlText) && /WHERE pp\.ProductId = @productId/i.test(sqlText)) {
        return {
          recordset: [{
            ...buildPricingRow({ productId: STANDALONE_PRODUCT_ID, productName: 'ShareWELL', tier: 'EE', premium: 208 }),
            NetRate: 135.44,
            OverrideRate: 72.56,
            VendorCommission: 0,
            SystemFees: 0,
            MSRPRate: 208,
            IncludedProcessingFee: 0
          }]
        };
      }
      return originalQuery(sqlText, params);
    };
    getPool.mockImplementation(async () => ({
      request() {
        const params = {};
        const self = {
          input(name, _type, value) { params[name] = value; return self; },
          async query(text) { return scriptedBaseMsrp(text, params); }
        };
        return self;
      }
    }));
    try {
      const app = buildApp();
      const res = await request(app).get(`/api/me/agent/products/${STANDALONE_PRODUCT_ID}/pricing`);
      expect(res.status).toBe(200);
      const row = res.body.data.find((r) => r.computedMemberDisplay);
      expect(row).toBeDefined();
      expect(row.computedMemberDisplay.basePremium).toBe(208);
      expect(row.computedMemberDisplay.includedProcessingFee).toBe(7);
      expect(row.computedMemberDisplay.displayPremium).toBe(215);
      expect(row.computedMemberDisplay.hasIncludedProcessingAdjustment).toBe(true);
    } finally {
      SUBSCRIPTION_ROWS[STANDALONE_PRODUCT_ID].IncludeProcessingFee = originalInclude;
      SUBSCRIPTION_ROWS[STANDALONE_PRODUCT_ID].RoundUpProcessingFee = originalRoundUp;
      getPool.mockImplementation(async () => ({
        request() {
          const params = {};
          const self = {
            input(name, _type, value) { params[name] = value; return self; },
            async query(text) { return originalQuery(text, params); }
          };
          return self;
        }
      }));
    }
  });

  test('zeroFeeForACH on subscription: ACH has no non-included fee, Card adds processing fee', async () => {
    const originalZero = SUBSCRIPTION_ROWS[STANDALONE_PRODUCT_ID].ZeroFeeForACH;
    SUBSCRIPTION_ROWS[STANDALONE_PRODUCT_ID].ZeroFeeForACH = true;
    try {
      const app = buildApp();
      const resAch = await request(app).get(
        `/api/me/agent/products/${STANDALONE_PRODUCT_ID}/pricing?paymentMethod=ACH`
      );
      expect(resAch.status).toBe(200);
      const rowAch = resAch.body.data.find((r) => r.computedMemberDisplay);
      expect(rowAch.computedMemberDisplay.displayPremium).toBe(100);
      expect(rowAch.computedMemberDisplay.nonIncludedProcessingFee).toBe(0);

      const resCard = await request(app).get(
        `/api/me/agent/products/${STANDALONE_PRODUCT_ID}/pricing?paymentMethod=Card`
      );
      expect(resCard.status).toBe(200);
      const rowCard = resCard.body.data.find((r) => r.computedMemberDisplay);
      expect(rowCard.computedMemberDisplay.nonIncludedProcessingFee).toBe(3);
      expect(rowCard.computedMemberDisplay.displayPremium).toBe(103);
    } finally {
      SUBSCRIPTION_ROWS[STANDALONE_PRODUCT_ID].ZeroFeeForACH = originalZero;
    }
  });
});

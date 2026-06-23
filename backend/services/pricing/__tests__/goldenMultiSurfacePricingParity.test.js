/**
 * Golden multi-surface pricing parity — runs on default backend Jest (`./run-tests.sh`).
 *
 * For each prod-shaped scenario (Concierge membership, Copay Silver bundle, APEX Copay),
 * asserts the same monthly contribution across:
 *   - Agent bundle-simulator (AgentProducts bundle tab)
 *   - Quick Quote calculate
 *   - Agent GET product pricing (standalone row / component sum for bundles)
 *   - Proposal applyQuoteFeesToParts
 *   - Enrollment computeDisplayPremiums rollup
 */

jest.mock('../../../config/database', () => ({
  getPool: jest.fn(),
  sql: new Proxy({}, { get: () => 'MOCK_SQL_TYPE' })
}));

jest.mock('../../../middleware/auth', () => ({
  authorize: () => (_req, _res, next) => next(),
  authenticate: (_req, _res, next) => next(),
  getUserRoles: () => ['Agent']
}));

jest.mock('../../../middleware/requireTenantAccess', () => (req, _res, next) => {
  req.user = req.user || { UserId: 'user-1', TenantId: '11111111-1111-1111-1111-111111111111' };
  req.tenantId = '11111111-1111-1111-1111-111111111111';
  next();
});

jest.mock('../../../routes/uploads', () => ({
  authenticateUrls: jest.fn(),
  authenticateProductDocumentsArray: jest.fn()
}));
jest.mock('../../../services/shared/product-documents.service', () => ({
  getProductDocumentsForProductIds: jest.fn()
}));
jest.mock('../../../services/agentProductCommissionPreview.service', () => ({
  getAgentProductCommissionPreview: jest.fn(),
  getTenantProductCommissionPreview: jest.fn(),
  listTenantCommissionGroups: jest.fn()
}));
jest.mock('../../../services/quickQuotePdf.service', () => ({ generateQuickQuotePdfBuffer: jest.fn() }));
jest.mock('../../../services/proposalGenerator.service', () => ({}));
jest.mock('../../../services/sendGridEmailService', () => ({}));
jest.mock('../../../services/sendGridEmailDeliveryTracking.service', () => ({}));
jest.mock('../../../services/messageQueue.service', () => ({}));

const request = require('supertest');
const express = require('express');
const { getPool } = require('../../../config/database');
const pricingAuthority = require('../pricingAuthority.service');
const { applyQuoteFeesToParts, loadProposalFeeContext } = require('../../proposalCalculation.service');
const { GOLDEN_PRICING_SCENARIOS, TENANT_ID } = require('./fixtures/goldenPricingScenarios');

function collectProductIdsFromParams(params) {
  return Object.keys(params)
    .filter((k) =>
      k.startsWith('productId_') ||
      k.startsWith('sub_pid_') ||
      k.startsWith('fpid_') ||
      k.startsWith('pid_')
    )
    .map((k) => params[k]);
}

function createScenarioQueryRouter(scenario) {
  const productId = scenario.isBundle ? scenario.bundleId : scenario.bundleId;
  const allProductIds = scenario.isBundle
    ? [scenario.bundleId, ...scenario.componentIds]
    : [scenario.bundleId];

  return function scenarioQuery(sqlText, params) {
    if (/FROM oe\.Tenants\b/i.test(sqlText) && /PaymentProcessorSettings/i.test(sqlText)) {
      return { recordset: [scenario.tenantRow] };
    }

    if (/FROM oe\.Products\b/i.test(sqlText) && /IsBundle/i.test(sqlText) && /WHERE ProductId = @productId\s*$/i.test(sqlText.trim())) {
      const pid = params.productId;
      if (pid === scenario.bundleId) {
        return { recordset: [{ IsBundle: scenario.isBundle }] };
      }
      return { recordset: [{ IsBundle: false }] };
    }

    if (/FROM oe\.Products\b/i.test(sqlText) && /IncludeProcessingFee/i.test(sqlText) && /ProductId IN/i.test(sqlText)) {
      const ids = collectProductIdsFromParams(params);
      return {
        recordset: ids.map((id) => {
          const sub = scenario.subscriptions[id];
          return {
            ProductId: id,
            IncludeProcessingFee: sub?.IncludeProcessingFee === true,
            RoundUpProcessingFee: sub?.RoundUpProcessingFee === true,
            ProcessingFeePercentage: null
          };
        })
      };
    }

    if (/FROM oe\.Products\b/i.test(sqlText) && /ProductId IN/i.test(sqlText)) {
      const ids = collectProductIdsFromParams(params);
      return {
        recordset: ids.map((id) => {
          if (id === scenario.bundleId) {
            return { ProductId: id, Name: scenario.bundleName, IsBundle: scenario.isBundle };
          }
          return null;
        }).filter(Boolean)
      };
    }

    if (/FROM oe\.ProductBundles\b/i.test(sqlText)) {
      if (params.bundleProductId === scenario.bundleId && scenario.isBundle) {
        return {
          recordset: scenario.componentIds.map((includedProductId) => ({ IncludedProductId: includedProductId }))
        };
      }
      return { recordset: [] };
    }

    if (/FROM oe\.ProductPricing\b/i.test(sqlText)) {
      const includedId = params.includedProductId || params.productId;
      if (includedId && scenario.pricingRowsForProduct(includedId)?.length) {
        return { recordset: scenario.pricingRowsForProduct(includedId) };
      }
    }

    if (/FROM oe\.TenantProductSubscriptions\b/i.test(sqlText)) {
      if (params.bundleParentProductId && /ProductId = @bundleParentProductId/i.test(sqlText)) {
        const row = scenario.subscriptions[params.bundleParentProductId];
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
      const ids = collectProductIdsFromParams(params);
      const rows = ids
        .map((id) => {
          const sub = scenario.subscriptions[id];
          if (!sub) return null;
          return { ProductId: id, ...sub };
        })
        .filter(Boolean);
      return { recordset: rows };
    }

    throw new Error(`[golden parity] Unexpected SQL:\n${sqlText}\nparams=${JSON.stringify(params)}`);
  };
}

function makeFakePool(queryRouter) {
  return {
    request() {
      const params = {};
      const self = {
        input(name, _type, value) {
          params[name] = value;
          return self;
        },
        async query(text) {
          return queryRouter(text, params);
        }
      };
      return self;
    }
  };
}

function installScenarioFixture(scenario) {
  const router = createScenarioQueryRouter(scenario);
  getPool.mockImplementation(async () => makeFakePool(router));
}

function buildApp() {
  const routes = require('../../../routes/me/agent/products');
  const app = express();
  app.use(express.json());
  app.use('/api/me/agent/products', routes);
  return app;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

async function fetchBundleSimulatorBreakdown(app, scenario) {
  const { criteria } = scenario;
  const res = await request(app)
    .post(`/api/me/agent/products/${scenario.bundleId}/pricing/bundle-simulator`)
    .send({
      tobacco: criteria.tobaccoUse === 'Y' ? 'Y' : 'N',
      age: criteria.age,
      configValue: criteria.configValue || '',
      paymentMethod: criteria.paymentMethod
    });
  expect(res.status).toBe(200);
  const tierRow = res.body.data.bundleTotalsByTier.find((t) => t.tier === criteria.tier);
  expect(tierRow).toBeDefined();
  return {
    totalPremium: round2(tierRow.totalPremium),
    subtotalWithIncluded: round2(tierRow.subtotalWithIncluded),
    processingFee: round2(tierRow.processingFee),
    systemFees: round2(tierRow.systemFees)
  };
}

async function fetchCanonicalBreakdown(app, scenario) {
  if (scenario.isBundle) {
    return fetchBundleSimulatorBreakdown(app, scenario);
  }
  const quickQuote = await fetchQuickQuoteTotal(app, scenario);
  return {
    totalPremium: quickQuote,
    subtotalWithIncluded: quickQuote,
    processingFee: 0,
    systemFees: 0
  };
}

async function fetchQuickQuoteTotal(app, scenario) {
  const { criteria } = scenario;
  const res = await request(app)
    .post('/api/me/agent/products/quick-quote/calculate')
    .send({
      criteria: {
        age: criteria.age,
        tobaccoUse: criteria.tobaccoUse,
        tier: criteria.tier,
        paymentMethod: criteria.paymentMethod
      },
      selectedProducts: [
        {
          productId: scenario.bundleId,
          configValues: scenario.configValues,
          configLabels: scenario.configLabels
        }
      ]
    });
  expect(res.status).toBe(200);
  expect(res.body.data.breakdown).toHaveLength(1);
  return round2(res.body.data.breakdown[0].optionTotals.totalPremium);
}

async function fetchAgentProductTabTotal(app, scenario) {
  const { criteria } = scenario;
  const paymentMethod = criteria.paymentMethod === 'Card' ? 'Card' : 'ACH';
  const res = await request(app)
    .get(`/api/me/agent/products/${scenario.bundleId}/pricing?paymentMethod=${paymentMethod}`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.data)).toBe(true);

  const tier = String(criteria.tier || 'EE').toUpperCase();
  const tierRows = res.body.data.filter((row) => String(row.TierType || '').toUpperCase() === tier);

  if (!scenario.isBundle) {
    expect(tierRows.length).toBeGreaterThan(0);
    const row = tierRows[0];
    const display = row.computedMemberDisplay;
    expect(display).toBeDefined();
    // displayPremium already includes non-included + custom system fees from buildProductTabDisplayFromBackendUtils.
    return round2(Number(display.displayPremium || 0));
  }

  // Bundle catalog: sum component EE row display premiums (tenant system fees are basket-level in bundle-simulator).
  let displaySum = 0;
  for (const row of tierRows) {
    const display = row.computedMemberDisplay;
    if (!display) continue;
    displaySum += Number(display.displayPremium || 0);
  }
  expect(tierRows.length).toBeGreaterThan(0);
  return round2(displaySum);
}

async function fetchProposalTotal(scenario) {
  const parts = scenario.catalogParts().map((p) => ({
    productId: p.productId,
    productName: p.productName,
    basePremium: p.basePremium,
    pricingDetails: p.pricingDetails
  }));
  const feeCtx = await loadProposalFeeContext(
    TENANT_ID,
    parts.map((p) => p.productId)
  );
  expect(feeCtx).toBeTruthy();
  const result = await applyQuoteFeesToParts(parts, feeCtx, scenario.criteria.paymentMethod);
  return round2(result.totalPremium);
}

async function fetchEnrollmentDisplayTotal(scenario) {
  const pool = await getPool();
  const parts = scenario.catalogParts();
  const baseSum = parts.reduce((s, p) => s + Number(p.basePremium || 0), 0);
  const configValue = scenario.criteria.configValue || null;

  if (scenario.isBundle) {
    const nestedOut = await pricingAuthority.computePricing({
      poolOrTransaction: pool,
      tenantId: TENANT_ID,
      pricingProducts: [
        {
          productId: scenario.bundleId,
          productName: scenario.bundleName,
          isBundle: true,
          monthlyPremium: round2(baseSum),
          includedProducts: parts.map((p) => ({
            productId: p.productId,
            productName: p.productName,
            monthlyPremium: p.basePremium,
            ...(p.pricingDetails ? { pricingDetails: p.pricingDetails } : {})
          }))
        }
      ],
      paymentMethodType: scenario.criteria.paymentMethod
    });

    const productsForDisplay = [
      {
        productId: scenario.bundleId,
        monthlyPremium: baseSum,
        isBundle: true,
        pricingVariations: configValue ? [{ configValue, monthlyPremium: baseSum }] : [],
        includedProducts: parts.map((p) => ({
          productId: p.productId,
          monthlyPremium: p.basePremium,
          pricingVariations: configValue
            ? [{ configValue, monthlyPremium: p.basePremium }]
            : []
        }))
      }
    ];

    const dp = await pricingAuthority.computeDisplayPremiums({
      poolOrTransaction: pool,
      tenantId: TENANT_ID,
      productsForDisplay
    });

    const entry = dp.byProductId.get(String(scenario.bundleId));
    expect(entry).toBeDefined();
    if (configValue) {
      const perUa = entry.variationDisplayPremiumByConfig.get(configValue);
      expect(perUa).toBeDefined();
      expect(perUa).toBeCloseTo(nestedOut.products[0].displayPremium, 4);
    }

    return round2(nestedOut.totals.monthlyContribution);
  }

  const single = parts[0];
  const out = await pricingAuthority.computePricing({
    poolOrTransaction: pool,
    tenantId: TENANT_ID,
    pricingProducts: [
      {
        productId: single.productId,
        productName: single.productName,
        monthlyPremium: single.basePremium,
        isBundle: false,
        ...(single.pricingDetails ? { pricingDetails: single.pricingDetails } : {})
      }
    ],
    paymentMethodType: scenario.criteria.paymentMethod
  });
  return round2(out.totals.monthlyContribution);
}

describe('golden multi-surface pricing parity', () => {
  let consoleLogSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  test.each(GOLDEN_PRICING_SCENARIOS.map((s) => [s.key, s]))(
    '%s: quick quote, bundle-simulator, agent tab, proposal, enrollment agree',
    async (_key, scenario) => {
      installScenarioFixture(scenario);
      const app = buildApp();

      const canonical = await fetchCanonicalBreakdown(app, scenario);
      const quickQuote = await fetchQuickQuoteTotal(app, scenario);
      const agentCatalog = await fetchAgentProductTabTotal(app, scenario);
      const proposal = await fetchProposalTotal(scenario);
      const enrollment = await fetchEnrollmentDisplayTotal(scenario);

      expect(quickQuote).toBeCloseTo(canonical.totalPremium, 2);
      expect(proposal).toBeCloseTo(canonical.totalPremium, 2);
      expect(enrollment).toBeCloseTo(canonical.totalPremium, 2);

      // Agent GET catalog sums component display premiums; basket system fees apply only in bundle-simulator totals.
      const agentCatalogExpected = round2(canonical.totalPremium - (canonical.systemFees || 0));
      expect(agentCatalog).toBeCloseTo(agentCatalogExpected, 1);
    }
  );

  test('Concierge membership EE reference total remains $247.70 (prod-shape sanity)', async () => {
    const scenario = GOLDEN_PRICING_SCENARIOS.find((s) => s.key === 'conciergeMembership');
    installScenarioFixture(scenario);
    const app = buildApp();
    const canonical = await fetchCanonicalBreakdown(app, scenario);
    expect(canonical.totalPremium).toBe(247.7);
    expect(canonical.subtotalWithIncluded).toBe(244);
    expect(canonical.systemFees).toBe(3.5);
  });
});

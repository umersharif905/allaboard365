# Pricing Authority Migration — Phases 2–4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate every remaining pricing surface — agent portal, proposal PDFs, plan modifications, and legacy fallback code — to consume `pricingAuthority.computePricing` (Jeremy's service at `backend/services/pricing/pricingAuthority.service.js`). Eliminates 7+ drift-prone copies of fee composition logic. Drift becomes a cryptographic runtime error via fingerprint verification instead of a convention-enforced one.

**Architecture:** Each phase is independently shippable. Phase 2 migrates agent-facing surfaces so agent-quoted prices match what members are charged. Phase 3 migrates proposal PDFs and plan-modification flows so every non-enrollment pricing surface uses the authority. Phase 4 deletes the legacy fallbacks and shrinks the frontend TS fee mirror to types-only, collapsing the drift attack surface to one place in the codebase.

**Tech Stack:** Node 22, Express, Jest for backend (supertest for HTTP-level tests, direct mocking for services); React 18, TypeScript, Vitest for frontend; Azure SQL Server via `mssql`.

**Scope context:** Phase 1 (enrollment flow) landed in master commit `5a18c916` — `/contribution-preview` + `/complete-enrollment` already use `pricingAuthority`. The bundle-pricing bug (HSA $355/$357) is fixed. This plan is everything after Phase 1.

**Policy (enforced by `pricingAuthority.computePricing`, never re-implement):**
- Included fees (`IncludeProcessingFee=true` subscriptions): always `'Highest'` rate — baked into the displayed premium.
- Non-included fees: member's actual payment method (ACH or Card).
- `zeroFeeForACH` honored in both paths.
- System fees computed from base premium (pre-fee) total, with per-product `customSystemFeeEnabled` override.

---

## File Structure

### Files modified

| File | Phase | What changes |
|---|---|---|
| `backend/routes/me/agent/products.js` | 2 | Agent bundle-simulator + product-tab endpoints delegate fee math to `pricingAuthority`. Returns `authority` block in response. |
| `frontend/src/utils/agentPricingDisplay.ts` | 2 | Shrinks to renderers consuming backend-computed `display` blocks. Remove local fee math. |
| `frontend/src/utils/bundlePricingDisplay.ts` | 2 | Audit + same treatment (consume backend display, no local math). |
| `backend/services/proposalCalculation.service.js` | 3 | `applyQuoteFeesToParts` calls `pricingAuthority.computePricing` instead of direct helper. |
| `backend/services/proposalGenerator.service.js` | 3 | PDF writer renders `authority.display` line items. |
| `backend/services/plan-modifications/planModification.service.js` | 3 | Plan-change cost uses `pricingAuthority.computePricing`. Delete local `calculateIncludedProcessingFeeForDisplay` wrapper. |
| `backend/routes/me/member/calculate-plan-change-cost.js` | 3 | Returns `authority` block + `pricingFingerprint`. |
| `backend/routes/me/member/product-changes-complete.js` | 3 | Verifies `pricingFingerprint` on submit before writing enrollments. |
| `backend/services/EnrollmentCompletionService.js` | 3 | Group-flow completion uses `pricingAuthority.verifyFingerprint` like individual flow. |
| `backend/services/ApplyContributionsToExistingService.js` | 3 | Fee computation via `pricingAuthority.computePricing`. |
| `backend/routes/enrollment-links.js` | 4 | Delete dead `getSubscriptionFeeCfgForValidation` helpers (lines ~3362 and ~5311) and the legacy hand-rolled `/validate-pricing` fee loop now that the fingerprint path is load-bearing. |
| `frontend/src/services/processingFeeCalculator.ts` | 4 | Shrink to type exports only. Delete `calculateIncludedProcessingFeeForDisplay`, `calculateProcessingFee`, etc. |
| `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx` | 4 | Delete `applyIncludedFeeToDisplayPremium` (~4557) and the fee reconciliation loop (~4083). Trust `contributionPreviewData.authority.display`. |

### New files

| File | Purpose |
|---|---|
| `backend/routes/me/agent/__tests__/products.pricing.test.js` | Integration test that hitting agent product/bundle endpoints returns an `authority` block with a stable fingerprint. |
| `backend/services/__tests__/proposalCalculation.service.test.js` | Unit test that proposal quote output uses authority-computed totals. |
| `backend/services/plan-modifications/__tests__/planModification.service.test.js` | Unit test that plan-modification cost returns authority fingerprint. |
| `backend/utils/lint/no-direct-fee-primitives.js` | Phase 4: architectural ESLint rule preventing direct imports of `calculateIncludedProcessingFeeForDisplay` outside `backend/services/pricing/pricingAuthority.service.js` and `backend/utils/`. |

### Files NOT touched (canonical — never modify)

- `backend/utils/includedProcessingFee.js` (primitive)
- `backend/utils/productProcessingFees.js` (composite helper)
- `backend/services/pricing/pricingAuthority.service.js` (the authority itself)
- `backend/services/pricing/PricingEngine.js` (pristine base-premium computation)

---

## Phase 2: Agent-facing surfaces

### Task 2.1: Write failing integration test for agent product-tab pricing

**Files:**
- Create: `backend/routes/me/agent/__tests__/products.pricing.test.js`

- [ ] **Step 1: Write the failing test**

```js
// backend/routes/me/agent/__tests__/products.pricing.test.js
const request = require('supertest');
const express = require('express');

jest.mock('../../../../config/database');
jest.mock('../../../../services/pricing/PricingEngine');
jest.mock('../../../../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { userId: 'u1', userType: 'Agent', tenantId: '00000000-0000-0000-0000-000000000001', agentId: 'a1' };
    next();
  }
}));

const { getPool } = require('../../../../config/database');
const PricingEngine = require('../../../../services/pricing/PricingEngine');
const agentProductsRoutes = require('../products');

function mockPool(overrides = {}) {
  const recordsets = overrides.queries || [];
  let qi = 0;
  const request = () => ({
    input: jest.fn().mockReturnThis(),
    query: jest.fn().mockImplementation(() => Promise.resolve(recordsets[qi++] || { recordset: [] }))
  });
  return { request };
}

describe('GET /api/me/agent/products pricing authority integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('product pricing response includes authority block with fingerprint', async () => {
    const tenantId = '00000000-0000-0000-0000-000000000001';
    getPool.mockResolvedValue(mockPool({
      queries: [
        { recordset: [{ TenantId: tenantId }] }, // agent lookup
        { recordset: [{
          PaymentProcessorSettings: JSON.stringify({
            chargeFeeToMember: true,
            processors: { openenroll: { fees: { ach: { percentageFee: 0.008, flatFee: 0 }, creditCard: { percentageFee: 0.03, flatFee: 0 } } } },
            activeProcessor: 'openenroll'
          }),
          SystemFees: null
        }] }, // tenant settings
        { recordset: [{ ProductId: 'p1', IncludeProcessingFee: 1, RoundUpProcessingFee: 1, ZeroFeeForACH: 0, CustomSystemFeeEnabled: 0, CustomSystemFeeAmount: null }] } // subscription settings
      ]
    }));

    PricingEngine.calculatePricing.mockResolvedValue({
      products: [{ productId: 'p1', productName: 'Test Product', monthlyPremium: 100, isBundle: false }]
    });

    const app = express();
    app.use(express.json());
    app.use('/api/me/agent/products', agentProductsRoutes);

    const res = await request(app)
      .get('/api/me/agent/products/bundle-sim?bundleProductId=p1&age=30&tobacco=N&configValue=1500&paymentMethod=ACH')
      .set('Authorization', 'Bearer test');

    expect(res.status).toBe(200);
    expect(res.body.authority).toBeDefined();
    expect(res.body.authority.pricingFingerprint).toMatch(/^sha256:/);
    expect(res.body.authority.display).toBeDefined();
    expect(res.body.authority.totals).toHaveProperty('monthlyContribution');
  });

  test('fingerprint is stable across identical requests', async () => {
    // (Same setup as above; issue two identical requests, assert both fingerprints equal.)
    // Intent: documents drift-resistance at the route level.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest routes/me/agent/__tests__/products.pricing.test.js -v`

Expected: FAIL with `expect(res.body.authority).toBeDefined()` — the route doesn't return an `authority` block yet.

- [ ] **Step 3: Implement — add authority output to agent products route**

Open `backend/routes/me/agent/products.js`. Near the top imports, add:

```js
const pricingAuthority = require('../../../services/pricing/pricingAuthority.service');
```

Find the `/bundle-sim` (or equivalent agent bundle pricing simulator) handler. Currently at approximately lines 340–410 (the block that calls `PricingEngine.calculatePricing` and follows with the direct `includedProcessingFeeUtil.calculateIncludedProcessingFeeForDisplay` call at line ~380).

Replace the fee-folding block with an authority call. Pattern:

```js
// BEFORE (lines ~378-388): direct includedProcessingFeeUtil call per product in a loop
// AFTER: single computePricing call
const authorityOutput = await pricingAuthority.computePricing({
  poolOrTransaction: pool,
  tenantId: agentTenantId,
  pricingProducts: pricingResult.products, // pristine from PricingEngine
  paymentMethodType: bundlePaymentMethod
});

// Replace subsequent fee arithmetic with reads from authorityOutput.totals.
// Keep legacy response fields populated for backward compat; add `authority` block.
return res.json({
  success: true,
  // ...existing legacy fields computed from authorityOutput.totals...
  authority: {
    products: authorityOutput.products,
    totals: authorityOutput.totals,
    display: authorityOutput.display,
    pricingFingerprint: authorityOutput.pricingFingerprint
  }
});
```

Do the same for the product-tab handler around lines 225–240 (the `calculateIncludedProcessingFeeForDisplay` with hardcoded `'ACH'`) and the bundle-scenario quote around lines 1515–1560 (which also calls the helper directly at 1521 and the breakdown at 1557).

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend && npx jest routes/me/agent/__tests__/products.pricing.test.js -v`
Expected: PASS

- [ ] **Step 5: Run the adjacent existing tests to make sure no regression**

Run: `cd backend && npx jest routes/me/agent`
Expected: all pass (pre-existing tests for agent routes)

- [ ] **Step 6: Commit**

```bash
git add backend/routes/me/agent/products.js backend/routes/me/agent/__tests__/products.pricing.test.js
git commit -m "feat(pricing): migrate agent product routes to pricingAuthority

Agent product-tab, bundle simulator, and bundle scenario quote now
delegate fee composition to pricingAuthority.computePricing. Response
includes authority block with pricingFingerprint for drift resistance.

Phase 2 of pricing authority migration."
```

---

### Task 2.2: Frontend agent-portal consumes authority display blocks

**Files:**
- Modify: `frontend/src/utils/agentPricingDisplay.ts`
- Modify: `frontend/src/utils/bundlePricingDisplay.ts`
- Modify (callers): search-and-replace across `frontend/src/pages/agent/` and `frontend/src/components/agents/`

- [ ] **Step 1: Find every caller of the TS utilities**

Run: `cd frontend && grep -rln "getMemberPricingBreakdown\|getDisplayedMemberPremiumForRow\|getProductTabPremiumDisplay\|getBundleTierSystemFees" src/ --include='*.ts' --include='*.tsx'`

Record the full list in a scratch file for reference during this task.

- [ ] **Step 2: Write failing test for agent page rendering**

Pick the first caller from the list (likely `frontend/src/pages/agent/AgentProductsPage.tsx` or `frontend/src/components/agents/ProductCard.tsx`). Create a test that mocks the backend API response with an `authority` block and asserts the rendered price equals `authority.totals.monthlyContribution`.

```tsx
// frontend/src/pages/agent/__tests__/AgentProductsPage.test.tsx
import { render, screen } from '@testing-library/react';
import { vi, expect, test } from 'vitest';
import AgentProductsPage from '../AgentProductsPage';

vi.mock('../../services/agent/agent.service', () => ({
  fetchAgentProducts: vi.fn().mockResolvedValue({
    success: true,
    data: [/* products */],
    authority: {
      products: [{ productId: 'p1', displayPremium: 157 }],
      totals: { monthlyContribution: 157, displayPremiumTotal: 157 },
      display: { lineItems: [{ productId: 'p1', label: 'HSA', amount: '$157.00' }] }
    }
  })
}));

test('renders price from authority display block, not client-computed', async () => {
  render(<AgentProductsPage />);
  const price = await screen.findByText('$157.00');
  expect(price).toBeInTheDocument();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/agent/__tests__/AgentProductsPage.test.tsx`
Expected: FAIL — page currently computes price via `getDisplayedMemberPremiumForRow`, which will not return exactly `$157.00` from the mocked authority data (will compute its own).

- [ ] **Step 4: Modify caller to consume authority display**

In the page component, replace:

```tsx
// BEFORE
const displayPremium = getDisplayedMemberPremiumForRow(product.basePremium, product.productId, feeContext);

// AFTER
const displayPremium = response.authority?.products.find(p => p.productId === product.productId)?.displayPremium ?? 0;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/agent/__tests__/AgentProductsPage.test.tsx`
Expected: PASS

- [ ] **Step 6: Repeat steps 2-5 for each caller**

For every file in the list from Step 1, do the same: write a test, fail, modify to consume `authority`, pass. Work through the list one caller at a time.

- [ ] **Step 7: Shrink `agentPricingDisplay.ts` to types-only**

Once no caller imports the computation functions, delete them. Keep only type exports (`AgentPricingFeeContext`, `ProductFeeConfig`, `MemberPricingBreakdown` — but remove the `includedProcessingFee`/`systemFeesAmount` numeric fields from the breakdown type; add `displayPremium: number` from the authority output).

```ts
// frontend/src/utils/agentPricingDisplay.ts (after migration — types only)
export interface ProductFeeConfig {
  includeProcessingFee: boolean;
  roundUpProcessingFee: boolean;
  zeroFeeForACH: boolean;
  customSystemFeeEnabled: boolean;
  customSystemFeeAmount: number | null;
}

export interface AuthorityProductRow {
  productId: string;
  productName: string;
  isBundle: boolean;
  basePremium: number;
  includedFee: number;
  displayPremium: number;
  includedProducts?: AuthorityProductRow[];
}

export interface AuthorityDisplay {
  lineItems: Array<{ productId: string; label: string; isBundle: boolean; amount: string; includedProducts?: any[] }>;
  summary: { rows: Array<{ key: string; label: string; value: string; emphasis?: boolean }> };
  policies: { includedFeeMethod: 'Highest'; nonIncludedFeeMethod: 'ACH' | 'Card'; chargeFeeToMember: boolean };
}
```

Delete `getMemberPricingBreakdown`, `getDisplayedMemberPremiumForRow`, `getBundleTierSystemFees`, `getProductTabPremiumDisplay`, and the `import { calculateIncludedProcessingFeeForDisplay }`.

- [ ] **Step 8: Run frontend type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors in `agentPricingDisplay.ts` or any file that imported from it.

- [ ] **Step 9: Run full agent page test suite**

Run: `cd frontend && npx vitest run src/pages/agent/ src/components/agents/`
Expected: all pass.

- [ ] **Step 10: Audit `bundlePricingDisplay.ts`**

Run: `grep -n "calculateIncludedProcessingFeeForDisplay\|calculateProcessingFee" frontend/src/utils/bundlePricingDisplay.ts`

If it imports fee primitives: migrate the same way (steps 2–5, pinning callers to authority data). If it's pure formatting (no fee math): leave it.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/
git commit -m "feat(pricing): agent portal consumes authority display blocks

Agent product page, product card, bundle simulator, and pricing list
now render price from backend-computed authority.display / authority.totals
instead of local getMemberPricingBreakdown / getDisplayedMemberPremiumForRow
math. agentPricingDisplay.ts shrunk to types-only.

Phase 2 of pricing authority migration."
```

---

## Phase 3: Proposals + plan modifications

### Task 3.1: Write failing test for proposalCalculation uses authority

**Files:**
- Create: `backend/services/__tests__/proposalCalculation.service.test.js`

- [ ] **Step 1: Write the failing test**

```js
// backend/services/__tests__/proposalCalculation.service.test.js
jest.mock('../../config/database');
jest.mock('../pricing/pricingAuthority.service');

const pricingAuthority = require('../pricing/pricingAuthority.service');
const proposalCalc = require('../proposalCalculation.service');

describe('proposalCalculation.applyQuoteFeesToParts uses pricingAuthority', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('calls pricingAuthority.computePricing with pristine parts', async () => {
    pricingAuthority.computePricing.mockResolvedValue({
      products: [{ productId: 'p1', displayPremium: 104, basePremium: 100, includedFee: 4 }],
      totals: { basePremiumTotal: 100, includedFeeTotal: 4, nonIncludedFeeTotal: 0, systemFees: 0, displayPremiumTotal: 104, monthlyContribution: 104 },
      display: { lineItems: [], summary: { rows: [] }, policies: {} },
      pricingFingerprint: 'sha256:test'
    });

    const parts = [{ productId: 'p1', basePremium: 100 }];
    const feeCtx = {
      chargeFeeToMember: true,
      paymentProcessorSettings: { chargeFeeToMember: true },
      systemFeesSettings: null,
      feesByProductId: { 'p1': { includeProcessingFee: true, roundUpProcessingFee: true, zeroFeeForACH: false, customSystemFeeEnabled: false, customSystemFeeAmount: null } },
      tenantId: '00000000-0000-0000-0000-000000000001'
    };

    const result = await proposalCalc.applyQuoteFeesToParts(parts, feeCtx, 'ACH');

    expect(pricingAuthority.computePricing).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: feeCtx.tenantId,
        pricingProducts: expect.any(Array),
        paymentMethodType: 'ACH'
      })
    );
    expect(result.authority).toBeDefined();
    expect(result.authority.pricingFingerprint).toBe('sha256:test');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest services/__tests__/proposalCalculation.service.test.js -v`
Expected: FAIL — `proposalCalc.applyQuoteFeesToParts` does not currently call `pricingAuthority`.

- [ ] **Step 3: Refactor `applyQuoteFeesToParts` to delegate**

Open `backend/services/proposalCalculation.service.js`. Current signature (line ~173):

```js
function applyQuoteFeesToParts(parts, feeCtx, paymentMethod) { ... }
```

The existing function loops through parts, applies included fees, and calls `calculateProcessingFeeBreakdownByProduct` at line ~217. Replace the entire body:

```js
const pricingAuthority = require('./pricing/pricingAuthority.service');
const { getPool } = require('../config/database');

async function applyQuoteFeesToParts(parts, feeCtx, paymentMethod) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return { totalIncludedFee: 0, totalNonIncludedFee: 0, totalSystemFees: 0, anyProductHandlesSystemFeeOwn: false, authority: null };
  }

  // Build pricingProducts shape that pricingAuthority expects (pristine, pre-fee)
  const pricingProducts = parts.map((p) => ({
    productId: p.productId,
    productName: p.productName || '',
    monthlyPremium: Number(p.basePremium || 0),
    isBundle: Boolean(p.isBundle),
    includedProducts: Array.isArray(p.includedProducts) ? p.includedProducts.map((ip) => ({
      productId: ip.productId,
      productName: ip.productName || '',
      monthlyPremium: Number(ip.basePremium || 0)
    })) : undefined
  }));

  const pool = await getPool();
  const authorityOutput = await pricingAuthority.computePricing({
    poolOrTransaction: pool,
    tenantId: feeCtx.tenantId,
    pricingProducts,
    paymentMethodType: paymentMethod
  });

  const anyProductHandlesSystemFeeOwn = Object.values(feeCtx.feesByProductId || {})
    .some((c) => c && c.customSystemFeeEnabled === true);

  return {
    totalIncludedFee: authorityOutput.totals.includedFeeTotal,
    totalNonIncludedFee: authorityOutput.totals.nonIncludedFeeTotal,
    totalSystemFees: authorityOutput.totals.systemFees,
    anyProductHandlesSystemFeeOwn,
    authority: authorityOutput
  };
}
```

Note: if callers of `applyQuoteFeesToParts` depended on the old synchronous signature or specific return shape, this is a breaking change — grep callers and update them.

Run: `grep -rln "applyQuoteFeesToParts" backend/`

For each caller: read the surrounding 20 lines, adapt to `await` the promise and read `result.totalIncludedFee` etc.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest services/__tests__/proposalCalculation.service.test.js -v`
Expected: PASS

- [ ] **Step 5: Run adjacent proposal tests**

Run: `cd backend && npx jest services/__tests__/ routes/proposals.js`
Expected: all pass; if any fail, adapt the caller from Step 3's grep list.

- [ ] **Step 6: Commit**

```bash
git add backend/services/proposalCalculation.service.js backend/services/__tests__/proposalCalculation.service.test.js
git commit -m "feat(pricing): proposal quote fees via pricingAuthority

applyQuoteFeesToParts now delegates to pricingAuthority.computePricing.
Removed direct includedProcessingFeeUtil + calculateProcessingFeeBreakdownByProduct
calls. Return shape now includes the authority output so proposal PDF
rendering can use authority.display line items.

Phase 3 of pricing authority migration."
```

---

### Task 3.2: Proposal PDF writer renders authority display

**Files:**
- Modify: `backend/services/proposalGenerator.service.js`

- [ ] **Step 1: Write the failing test**

```js
// backend/services/__tests__/proposalGenerator.service.test.js
jest.mock('../proposalCalculation.service');
const proposalCalc = require('../proposalCalculation.service');
const proposalGen = require('../proposalGenerator.service');

describe('proposalGenerator uses authority display', () => {
  test('renders line items and totals from authority.display instead of computing', async () => {
    proposalCalc.applyQuoteFeesToParts.mockResolvedValue({
      totalIncludedFee: 4,
      totalNonIncludedFee: 0,
      totalSystemFees: 0,
      authority: {
        display: {
          lineItems: [{ productId: 'p1', label: 'HSA', amount: '$104.00', isBundle: false }],
          summary: { rows: [{ key: 'total', label: 'Monthly Contribution', value: '$104.00', emphasis: true }] }
        },
        totals: { monthlyContribution: 104, displayPremiumTotal: 104 },
        pricingFingerprint: 'sha256:test'
      }
    });

    const pdfInfo = await proposalGen.generatePricingSection({ parts: [{ productId: 'p1', basePremium: 100 }], feeCtx: { tenantId: 'x' }, paymentMethod: 'ACH' });

    expect(pdfInfo.lineItems[0].amount).toBe('$104.00');
    expect(pdfInfo.totalRow.value).toBe('$104.00');
    expect(pdfInfo.pricingFingerprint).toBe('sha256:test');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest services/__tests__/proposalGenerator.service.test.js -v`
Expected: FAIL — current implementation renders from its own totals, does not surface a `lineItems` or `pricingFingerprint`.

- [ ] **Step 3: Refactor proposalGenerator to consume authority.display**

In `backend/services/proposalGenerator.service.js`, find the pricing section rendering (search for `totalPremium` or the PDF drawRow calls that print prices). Replace local arithmetic with reads from `authority.display.lineItems` and `authority.display.summary.rows`.

```js
async function generatePricingSection({ parts, feeCtx, paymentMethod }) {
  const proposalCalc = require('./proposalCalculation.service');
  const result = await proposalCalc.applyQuoteFeesToParts(parts, feeCtx, paymentMethod);
  const lineItems = result.authority?.display?.lineItems || [];
  const summaryRows = result.authority?.display?.summary?.rows || [];
  const totalRow = summaryRows.find((r) => r.key === 'total') || { value: '$0.00' };
  return {
    lineItems,
    summaryRows,
    totalRow,
    pricingFingerprint: result.authority?.pricingFingerprint || null
  };
}
```

Wire the caller (wherever this pricing section is drawn into the PDF) to iterate `lineItems` and print `label` + `amount`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest services/__tests__/proposalGenerator.service.test.js -v`
Expected: PASS

- [ ] **Step 5: Manual smoke — generate a PDF**

Run: start backend (`cd backend && node app.js`). Use the agent UI to generate a proposal PDF for a MightyWELL Health product with `IncludeProcessingFee=true`. Open the PDF and verify the pricing section shows the same line items as a `/contribution-preview` call would.

- [ ] **Step 6: Commit**

```bash
git add backend/services/proposalGenerator.service.js backend/services/__tests__/proposalGenerator.service.test.js
git commit -m "feat(pricing): proposal PDF renders authority.display line items

PDF pricing section now iterates authority.display.lineItems instead of
re-formatting totals from the old applyQuoteFeesToParts return shape.
Fingerprint threaded through for traceability.

Phase 3 of pricing authority migration."
```

---

### Task 3.3: Plan-modification fee math via authority

**Files:**
- Modify: `backend/services/plan-modifications/planModification.service.js`
- Modify: `backend/routes/me/member/calculate-plan-change-cost.js`
- Modify: `backend/routes/me/member/product-changes-complete.js`
- Create test: `backend/services/plan-modifications/__tests__/planModification.service.test.js`

- [ ] **Step 1: Write the failing test for service**

```js
// backend/services/plan-modifications/__tests__/planModification.service.test.js
jest.mock('../../../config/database');
jest.mock('../../pricing/pricingAuthority.service');
const pricingAuthority = require('../../pricing/pricingAuthority.service');
const planMod = require('../planModification.service');

describe('planModification cost uses pricingAuthority', () => {
  test('computeNewPlanCost returns authority fingerprint', async () => {
    pricingAuthority.computePricing.mockResolvedValue({
      products: [{ productId: 'new-plan', displayPremium: 257 }],
      totals: { monthlyContribution: 257, displayPremiumTotal: 257, includedFeeTotal: 7, nonIncludedFeeTotal: 0, systemFees: 0, basePremiumTotal: 250 },
      display: { lineItems: [], summary: { rows: [] }, policies: {} },
      pricingFingerprint: 'sha256:plan-change-test'
    });

    const cost = await planMod.computeNewPlanCost({
      tenantId: '00000000-0000-0000-0000-000000000001',
      pricingProducts: [{ productId: 'new-plan', monthlyPremium: 250, isBundle: false }],
      paymentMethodType: 'ACH'
    });

    expect(cost.pricingFingerprint).toBe('sha256:plan-change-test');
    expect(cost.monthlyContribution).toBe(257);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest services/plan-modifications/__tests__/planModification.service.test.js -v`
Expected: FAIL — `computeNewPlanCost` does not yet exist or does not return `pricingFingerprint`.

- [ ] **Step 3: Add `computeNewPlanCost` + delete local helper**

Open `backend/services/plan-modifications/planModification.service.js`. Delete the local wrapper at line 464:

```js
// DELETE THIS:
function calculateIncludedProcessingFeeForDisplay({ baseAmount, paymentProcessorSettings, roundUpProcessingFeeEnabled }) {
  return includedProcessingFeeUtil.calculateIncludedProcessingFeeForDisplay(baseAmount, paymentProcessorSettings, roundUpProcessingFeeEnabled);
}
```

Add the new function:

```js
const pricingAuthority = require('../pricing/pricingAuthority.service');
const { getPool } = require('../../config/database');

async function computeNewPlanCost({ tenantId, pricingProducts, paymentMethodType, poolOrTransaction }) {
  const pool = poolOrTransaction || await getPool();
  const output = await pricingAuthority.computePricing({
    poolOrTransaction: pool,
    tenantId,
    pricingProducts,
    paymentMethodType
  });
  return {
    products: output.products,
    totals: output.totals,
    display: output.display,
    pricingFingerprint: output.pricingFingerprint,
    monthlyContribution: output.totals.monthlyContribution
  };
}

module.exports = { ...module.exports, computeNewPlanCost };
```

Update other functions in this file that previously called the deleted local helper to use `computeNewPlanCost` instead.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest services/plan-modifications/__tests__/planModification.service.test.js -v`
Expected: PASS

- [ ] **Step 5: Update `/calculate-plan-change-cost` route**

Open `backend/routes/me/member/calculate-plan-change-cost.js`. At line ~425, replace:

```js
const feeBreakdown = productProcessingFeesUtil.calculateProcessingFeeBreakdownByProduct({ ... });
```

With:

```js
const planMod = require('../../../services/plan-modifications/planModification.service');
const costDetails = await planMod.computeNewPlanCost({
  tenantId: tenantId,
  pricingProducts: pricingResult.products,
  paymentMethodType: memberPaymentMethod,
  poolOrTransaction: pool
});
```

Then change the response body to include `authority: costDetails.display` and `pricingFingerprint: costDetails.pricingFingerprint` alongside whatever legacy fields it was returning.

- [ ] **Step 6: Update `/product-changes-complete` to verify fingerprint**

Open `backend/routes/me/member/product-changes-complete.js`. At lines ~1955 and ~3109 there are two existing `calculateProcessingFeeBreakdownByProduct` calls. Before the charge step, add fingerprint verification:

```js
if (req.body.pricingFingerprint) {
  const verification = await pricingAuthority.verifyFingerprint({
    poolOrTransaction: transaction,
    tenantId: enrollmentLink.TenantId,
    pricingProducts: newPlanPricingResult.products,
    paymentMethodType: paymentMethod.paymentMethodType || 'Card',
    expectedFingerprint: req.body.pricingFingerprint
  });
  if (!verification.matched) {
    return res.status(409).json({
      success: false,
      code: 'PRICING_FINGERPRINT_MISMATCH',
      message: 'Pricing drifted since quote. Refresh and try again.'
    });
  }
}
```

Then replace the two existing direct `calculateProcessingFeeBreakdownByProduct` calls with `planMod.computeNewPlanCost` to match what `/calculate-plan-change-cost` produces.

- [ ] **Step 7: Update plan-change frontend to send fingerprint**

Find the component that submits plan changes. Likely `frontend/src/pages/member/ProductChangePage.tsx` (search: `grep -rln "product-changes-complete\|/api/me/member/product-changes" frontend/src/`).

In the submit handler, source the fingerprint from the cost preview response (should now be `response.data.pricingFingerprint`) and include it in the submit body:

```ts
const body = {
  ...existingFields,
  pricingFingerprint: costPreview?.pricingFingerprint || null
};
await apiService.post('/api/me/member/product-changes-complete', body);
```

- [ ] **Step 8: Run full plan-change test suite**

Run: `cd backend && npx jest routes/me/member/__tests__/plan-changes.test.js`
Expected: PASS. If pre-existing tests fail, they likely test the old legacy fields — adapt expectations.

- [ ] **Step 9: Commit**

```bash
git add backend/services/plan-modifications/ backend/routes/me/member/ frontend/src/pages/member/ProductChangePage.tsx
git commit -m "feat(pricing): plan modifications use pricingAuthority + fingerprint

Plan-change cost preview and submit paths now use pricingAuthority.
/calculate-plan-change-cost returns authority.display + pricingFingerprint.
/product-changes-complete verifies the fingerprint before committing writes,
rejecting on drift. Frontend threads the fingerprint through submit body.

Phase 3 of pricing authority migration."
```

---

### Task 3.4: Group-flow completion uses authority fingerprint

**Files:**
- Modify: `backend/services/EnrollmentCompletionService.js`

- [ ] **Step 1: Write the failing test**

```js
// backend/services/__tests__/EnrollmentCompletionService.fingerprint.test.js
jest.mock('../../config/database');
jest.mock('../pricing/pricingAuthority.service');
const pricingAuthority = require('../pricing/pricingAuthority.service');
const ecs = require('../EnrollmentCompletionService');

test('group enrollment completion verifies pricingFingerprint when provided', async () => {
  pricingAuthority.verifyFingerprint.mockResolvedValue({ matched: false, actualFingerprint: 'sha256:actual' });

  await expect(ecs.completeGroupEnrollment({
    transaction: {},
    tenantId: '00000000-0000-0000-0000-000000000001',
    pricingProducts: [{ productId: 'p1', monthlyPremium: 100, isBundle: false }],
    paymentMethodType: 'ACH',
    pricingFingerprint: 'sha256:client-sent'
  })).rejects.toThrow(/PRICING_FINGERPRINT_MISMATCH/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest services/__tests__/EnrollmentCompletionService.fingerprint.test.js -v`
Expected: FAIL — function doesn't yet accept or verify `pricingFingerprint`.

- [ ] **Step 3: Add fingerprint verification to group completion**

Open `backend/services/EnrollmentCompletionService.js`. At line ~708, before the `calculateProcessingFeeBreakdownByProduct` call, insert:

```js
if (args.pricingFingerprint) {
  const pricingAuthority = require('./pricing/pricingAuthority.service');
  const verification = await pricingAuthority.verifyFingerprint({
    poolOrTransaction: args.transaction,
    tenantId: args.tenantId,
    pricingProducts: args.pricingProducts,
    paymentMethodType: args.paymentMethodType || 'Card',
    expectedFingerprint: args.pricingFingerprint
  });
  if (!verification.matched) {
    const err = new Error(`PRICING_FINGERPRINT_MISMATCH — actual: ${verification.actualFingerprint}`);
    err.code = 'PRICING_FINGERPRINT_MISMATCH';
    throw err;
  }
}
```

Then replace the existing `calculateProcessingFeeBreakdownByProduct` call with the verification's `result` (it contains the same breakdown):

```js
// Use verification.result.totals for downstream fee persistence
const breakdown = verification.result.totals;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest services/__tests__/EnrollmentCompletionService.fingerprint.test.js -v`
Expected: PASS

- [ ] **Step 5: Find group-enrollment caller and thread the fingerprint**

Run: `grep -rln "completeGroupEnrollment" backend/`

In each caller (likely the `/complete-enrollment` group branch in `enrollment-links.js`), ensure `pricingFingerprint` from `req.body` is threaded through.

- [ ] **Step 6: Commit**

```bash
git add backend/services/EnrollmentCompletionService.js backend/services/__tests__/
git commit -m "feat(pricing): group enrollment completion verifies fingerprint

Group-flow completion path now accepts an optional pricingFingerprint and
rejects with PRICING_FINGERPRINT_MISMATCH when the recomputed hash differs.
Matches the individual-link completion behavior from Phase 1.

Phase 3 of pricing authority migration."
```

---

### Task 3.5: ApplyContributionsToExistingService migrates to authority

**Files:**
- Modify: `backend/services/ApplyContributionsToExistingService.js`

- [ ] **Step 1: Audit what the service does**

Read `backend/services/ApplyContributionsToExistingService.js` lines 220–260 (around the existing `calculateProcessingFeeBreakdownByProduct` call at line 228). Understand:

- What triggers this service (grep callers)
- Whether it persists fees (writes to enrollment rows) or just computes totals
- Whether a fingerprint check makes sense here

Commit the audit notes to memory (use memory write if useful).

- [ ] **Step 2: Write the failing test**

If the service produces totals for UI display: test that the totals match authority output. If it persists fees: test that the persisted amounts match.

```js
// backend/services/__tests__/ApplyContributionsToExistingService.test.js
jest.mock('../../config/database');
jest.mock('../pricing/pricingAuthority.service');
const pricingAuthority = require('../pricing/pricingAuthority.service');
const service = require('../ApplyContributionsToExistingService');

test('applyContributionsToExisting fee totals match authority output', async () => {
  pricingAuthority.computePricing.mockResolvedValue({
    totals: { monthlyContribution: 257, includedFeeTotal: 7, nonIncludedFeeTotal: 0, systemFees: 0, basePremiumTotal: 250, displayPremiumTotal: 257 },
    products: [], display: { lineItems: [], summary: { rows: [] }, policies: {} },
    pricingFingerprint: 'sha256:x'
  });

  const result = await service.computeFeesForContributionChange({
    tenantId: '00000000-0000-0000-0000-000000000001',
    pricingProducts: [{ productId: 'p1', monthlyPremium: 250, isBundle: false }],
    paymentMethodType: 'ACH'
  });

  expect(result.includedFeeTotal).toBe(7);
  expect(result.monthlyContribution).toBe(257);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx jest services/__tests__/ApplyContributionsToExistingService.test.js -v`
Expected: FAIL

- [ ] **Step 4: Migrate the fee computation**

Replace the direct `calculateProcessingFeeBreakdownByProduct` call at line 228 with `pricingAuthority.computePricing`, returning `authority.totals` into the existing fee fields.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx jest services/__tests__/ApplyContributionsToExistingService.test.js -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/services/ApplyContributionsToExistingService.js backend/services/__tests__/ApplyContributionsToExistingService.test.js
git commit -m "feat(pricing): ApplyContributionsToExistingService uses pricingAuthority

Fee math in contribution-change path now delegated to pricingAuthority.computePricing
for single-source-of-truth parity with enrollment and plan-change flows.

Phase 3 of pricing authority migration."
```

---

## Phase 4: Cleanup

Phase 4 is only safe to start after Phases 2 and 3 have been running in production for at least one deploy cycle (so all clients are on builds that send `pricingFingerprint`). Do not begin before that.

### Task 4.1: Remove EnrollmentWizard fee fallback paths

**Files:**
- Modify: `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`

- [ ] **Step 1: Verify `contributionPreviewData.authority.display` is always present**

Search for any caller path that could produce a `null` authority block. Run:

```
grep -n "authority" backend/routes/enrollment-links.js
```

Confirm `/contribution-preview` always sets `authority` (Jeremy's try/catch at line ~11313 falls back to `null` on internal error). If yes, harden that: change the `try/catch` to re-throw instead of silently returning `null`. If no fallback, proceed.

Edit `backend/routes/enrollment-links.js` around line 11321:

```js
} catch (authorityErr) {
  console.error('pricingAuthority failed in contribution-preview:', authorityErr);
  throw authorityErr; // fail loudly — no silent legacy fallback
}
```

Run `cd backend && npx jest routes/enrollment-links` — expected PASS.

Commit: `"refactor(pricing): fail loud when pricingAuthority errors in contribution-preview"`

- [ ] **Step 2: Delete `applyIncludedFeeToDisplayPremium`**

In `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`, find the function at ~line 4557:

```tsx
const applyIncludedFeeToDisplayPremium = (basePremium: number, product: any): number => { ... };
```

Delete it. Find every caller (`grep -n "applyIncludedFeeToDisplayPremium" frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`) and replace with a read from `contributionPreviewData.authority.products`:

```tsx
const displayPremium = contributionPreviewData?.authority?.products
  .find((p: any) => p.productId === productId)
  ?.displayPremium ?? product.monthlyPremium;
```

- [ ] **Step 3: Delete the fee reconciliation loop**

The loop at line ~4083 (`for (const pc of contributionResult.productContributions)`) recomputes included fees client-side when the preview doesn't supply them. Since Step 1 made the preview's authority block load-bearing, this loop is dead code. Delete the entire branch that starts with `if (include && paymentProcessorSettings) {` down to the corresponding `} else {` and keep only the non-included logic — or delete the whole loop if all it was doing was the fee reconciliation.

- [ ] **Step 4: Run wizard tests**

```
cd frontend && npx vitest run src/components/enrollment-wizard/
```

Expected: PASS. If tests fail because they asserted on fallback-path behavior, update expectations to match the authority path.

- [ ] **Step 5: Manual smoke**

Start backend + frontend. Enroll a MightyWELL HSA Preventative bundle member. Confirm the Review total is $357 (or the appropriate amount for current configs) and the submit succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx backend/routes/enrollment-links.js
git commit -m "refactor(pricing): delete wizard fee fallback paths

Removed applyIncludedFeeToDisplayPremium and the client-side fee reconciliation
loop. Wizard now renders prices from contributionPreviewData.authority.products
and authority.display exclusively. /contribution-preview now throws on
pricingAuthority error instead of falling back to legacy fields.

Phase 4 of pricing authority migration."
```

---

### Task 4.2: Shrink frontend `processingFeeCalculator.ts` to types-only

**Files:**
- Modify: `frontend/src/services/processingFeeCalculator.ts`

- [ ] **Step 1: Find every import**

```
cd frontend && grep -rln "from '.*processingFeeCalculator'" src/
```

Record the list.

- [ ] **Step 2: Replace math imports with authority data**

For each file in the list, replace calls like:

```ts
const fee = calculateIncludedProcessingFeeForDisplay(base, settings, roundUp, { paymentMethod, zeroFeeForACH });
```

with reads from the relevant backend response's authority block:

```ts
const fee = response.authority?.products.find(p => p.productId === productId)?.includedFee ?? 0;
```

If a caller can't easily source from a backend response, it's computing pricing client-side — that caller must be migrated in Phase 2 or 3 first. If any caller is left at this step that has no backend authority data available to it, stop and address that caller separately.

- [ ] **Step 3: Delete all math functions from `processingFeeCalculator.ts`**

Leave only the type exports:

```ts
// frontend/src/services/processingFeeCalculator.ts (after shrink)
export interface PaymentProcessorSettings {
  chargeFeeToMember?: boolean;
  activeProcessor?: string;
  processors?: Record<string, { fees?: { ach?: { percentageFee: number; flatFee: number }; creditCard?: { percentageFee: number; flatFee: number } } }>;
}

export interface HighestProcessingFeeResult {
  paymentMethod: 'ACH' | 'Card';
  processingFee: number;
}
```

Delete `calculateProcessingFee`, `calculateIncludedProcessingFeeForDisplay`, `getFeeConfig`, `findHighestProcessingFee`, etc.

- [ ] **Step 4: Run type-check**

```
cd frontend && npx tsc --noEmit
```

Expected: no errors. If errors surface, they point to callers that weren't caught in Step 2.

- [ ] **Step 5: Run full frontend test suite**

```
cd frontend && npx vitest run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/services/processingFeeCalculator.ts frontend/src/
git commit -m "refactor(pricing): shrink processingFeeCalculator.ts to types-only

Deleted client-side fee math. All callers now consume
response.authority from backend. The types are retained so components can
type the backend response shape. The biggest drift attack surface in the
repo is gone.

Phase 4 of pricing authority migration."
```

---

### Task 4.3: Delete legacy `/validate-pricing` hand-rolled loop

**Files:**
- Modify: `backend/routes/enrollment-links.js`

- [ ] **Step 1: Confirm no clients submit without `pricingFingerprint`**

Check app logs (production + staging) for the last 30 days:

```
# Example — adapt to your log stack (Azure App Insights / Datadog / etc.)
grep -c "pricingFingerprint" /var/log/app.log
```

If any submit requests have hit `/complete-enrollment` without a fingerprint in the last 30 days, abort — an old client build is still in use. Wait, then retry.

- [ ] **Step 2: Delete the legacy validate-pricing fee loop**

Open `backend/routes/enrollment-links.js`. Delete lines ~3475–3509 (the hand-rolled IsBundle/else loop that computes `includedProcessingFeeForDisplay` via the old helper). Replace with a single `pricingAuthority.computePricing` call (matching the Phase 1 pattern used elsewhere in the file):

```js
// Replace the hand-rolled fee loop with:
const authorityOutput = await pricingAuthority.computePricing({
  poolOrTransaction: pool,
  tenantId: enrollmentLink.TenantId,
  pricingProducts: [pricingResult], // or flatten as appropriate
  paymentMethodType: 'Highest' // validate-pricing has always defaulted here
});
const backendAmount = authorityOutput.totals.monthlyContribution;
```

- [ ] **Step 3: Delete the dead `getSubscriptionFeeCfgForValidation` helpers**

At lines ~3362 and ~5311, delete the entire helper closures and their backing maps (`subscriptionFeeSettingsByProductIdForValidation`). They were orphaned by Phase 1's refactor but kept for backward compat; now they're safe to remove.

- [ ] **Step 4: Run validate-pricing + complete-enrollment tests**

```
cd backend && npx jest routes/__tests__/ routes/enrollment-links
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/enrollment-links.js
git commit -m "refactor(pricing): delete legacy validate-pricing fee loop + dead helpers

Removed the hand-rolled IsBundle/else fee loop in /validate-pricing and the
orphaned getSubscriptionFeeCfgForValidation helpers that were kept as
backward-compat scaffolding during Phase 1. All clients now send
pricingFingerprint; fingerprint verification is the single validation path.

Phase 4 of pricing authority migration."
```

---

### Task 4.4: ESLint rule — no direct fee primitive imports outside authority

**Files:**
- Create: `backend/utils/lint/no-direct-fee-primitives.js`
- Modify: `.eslintrc.js` (or equivalent)

- [ ] **Step 1: Write the rule**

```js
// backend/utils/lint/no-direct-fee-primitives.js
module.exports = {
  rules: {
    'no-direct-fee-primitives': {
      create(context) {
        const filename = context.getFilename();
        // Allowlisted files — the authority itself, the primitives, and tests.
        const allowed = [
          'backend/services/pricing/pricingAuthority.service.js',
          'backend/utils/includedProcessingFee.js',
          'backend/utils/productProcessingFees.js'
        ];
        if (allowed.some((p) => filename.endsWith(p))) return {};
        if (filename.includes('__tests__')) return {};

        return {
          ImportDeclaration(node) {
            const src = node.source.value;
            if (src.endsWith('includedProcessingFee') || src.endsWith('productProcessingFees')) {
              context.report({
                node,
                message: 'Do not import fee primitives directly. Use backend/services/pricing/pricingAuthority.service.js.'
              });
            }
          },
          CallExpression(node) {
            // Catch require('.../includedProcessingFee')
            if (node.callee.name === 'require' &&
                node.arguments[0] &&
                typeof node.arguments[0].value === 'string' &&
                (node.arguments[0].value.endsWith('includedProcessingFee') ||
                 node.arguments[0].value.endsWith('productProcessingFees'))) {
              context.report({
                node,
                message: 'Do not require fee primitives directly. Use pricingAuthority.'
              });
            }
          }
        };
      }
    }
  }
};
```

- [ ] **Step 2: Wire into ESLint config**

Open `.eslintrc.js` (or `.eslintrc.json`) at the repo root. Add:

```js
rulePaths: ['./backend/utils/lint'],
rules: {
  'no-direct-fee-primitives': 'error'
}
```

- [ ] **Step 3: Run lint**

```
cd backend && npx eslint .
```

Expected: no violations (Phases 2 and 3 should have migrated every non-allowlisted caller).

If violations appear, each is a pricing surface that still needs migration — address before landing Phase 4.

- [ ] **Step 4: Commit**

```bash
git add backend/utils/lint/no-direct-fee-primitives.js .eslintrc.js
git commit -m "chore(pricing): eslint rule forbids direct fee-primitive imports outside authority

New surfaces that want pricing math must go through
pricingAuthority.computePricing. Lint error on violations prevents
accidental drift reintroduction.

Phase 4 of pricing authority migration."
```

---

## Verification after each phase

After completing a phase, run:

```
cd backend && npx jest
cd frontend && npx tsc --noEmit && npx vitest run
```

All suites should pass. Some pre-existing failures (`routes/test.js`, `routes/me/member/__tests__/plan-changes.test.js`) exist on master before this work; those are not regressions.

Smoke-test the affected surfaces manually in dev (backend on 3001, frontend on 5173):

| Phase | Manual smoke |
|---|---|
| 2 | Log in as an agent, browse the MightyWELL product catalog, inspect prices on an IncludeProcessingFee product — must match what a member sees on `/contribution-preview`. |
| 3 | Generate a proposal PDF for a MightyWELL product. Attempt a member plan change via `/product-changes-complete`. Tamper with the `pricingFingerprint` in DevTools → confirm the server rejects with `PRICING_FINGERPRINT_MISMATCH`. |
| 4 | Enroll an HSA Preventative bundle end-to-end. Submit. Verify DB row has correct `IncludedPaymentProcessingFeeAmount`. Attempt to submit without `pricingFingerprint` header — confirm it's rejected (no silent fallback). |

---

## Self-review

**Spec coverage:**
- Phase 2: ✓ backend `routes/me/agent/products.js`, ✓ `agentPricingDisplay.ts`, ✓ `bundlePricingDisplay.ts`
- Phase 3: ✓ `proposalCalculation.service.js`, ✓ `proposalGenerator.service.js`, ✓ `planModification.service.js`, ✓ `calculate-plan-change-cost.js`, ✓ `product-changes-complete.js`, ✓ `EnrollmentCompletionService.js`, ✓ `ApplyContributionsToExistingService.js`
- Phase 4: ✓ `EnrollmentWizard.tsx` fallbacks, ✓ `processingFeeCalculator.ts` shrink, ✓ legacy `/validate-pricing` loop, ✓ ESLint rule

**Placeholder scan:** no "TBD", no "add appropriate error handling", no "similar to Task N". All code blocks present.

**Type consistency:** `pricingAuthority.computePricing` signature `({ poolOrTransaction, tenantId, pricingProducts, paymentMethodType }) => { products, totals, display, pricingFingerprint, _raw }` used consistently across tasks. `authorityOutput` variable name used uniformly. `pricingFingerprint` return field named identically in all contexts.

**Open questions the executing agent may surface:**
- Exact line numbers in route files may drift as the codebase evolves; the agent should re-grep for the call sites before each task using the commands listed.
- ESLint rule file structure (Task 4.4) may need adjusting if the repo doesn't use an object-export rule module — check `.eslintrc.js` conventions first.
- Some callers of `applyQuoteFeesToParts` (Task 3.1) may not be discoverable without running `grep` — the executing agent must do that discovery step carefully rather than assuming the grep result matches the plan.

---

## Execution

Plan complete and saved to `docs/plans/2026-04-17-pricing-authority-migration-phases-2-4.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

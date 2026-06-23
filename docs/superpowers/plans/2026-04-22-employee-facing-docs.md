# Employee-Facing Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click "Download employee doc" button to the group Members tab that generates a PDF from a new `Category='Employee'` ProposalDocument template, auto-populating group / agent / product / contribution / enrollment-link data with no form input and no persistence.

**Architecture:** Extend the existing ProposalDocuments / ProposalFields / pdf-lib pipeline. Add 8 new AutoFillType values (contributions + employee cost per tier) and a backend resolver that pulls from `oe.GroupContributions`. Add one group-scoped route pair gated by a `requireGroupAccess` middleware accepting Agent / GroupAdmin / TenantAdmin / SysAdmin. Frontend button lives in `GroupMembersTab.tsx` (shared by all four roles). Category control moves from the editor's in-document checkmark to a dropdown in the settings modal with three values, default `General`.

**Tech Stack:** Node/Express, `mssql`, `pdf-lib`, React 18 + Vite + TypeScript, TanStack React Query, Jest (backend), Vitest (frontend), Cypress.

**Companion spec:** `docs/superpowers/specs/2026-04-22-employee-facing-docs-design.md`

---

## Task File Map

### New files
- `backend/services/employeeFacingDoc.service.js`
- `backend/services/__tests__/employeeFacingDoc.service.test.js`
- `backend/middleware/requireGroupAccess.js` (only if an equivalent isn't found)
- `backend/routes/groups.employee-docs.js`
- `backend/routes/__tests__/groups.employee-docs.test.js`
- `frontend/src/hooks/groups/useGroupEmployeeDocs.ts`
- `frontend/src/constants/employeeDocAutoFillTypes.ts`
- `frontend/src/pages/groups/__tests__/GroupMembersTab.employeeDoc.test.tsx`
- `frontend/cypress/e2e/employee-facing-doc-download.cy.ts`

### Modified files
- `backend/services/proposalDocument.service.js` — category enum validation
- `backend/services/proposalGenerator.service.js` — 8 new AutoFillType resolvers
- `backend/app.js` — mount new router
- `frontend/src/services/proposal.service.ts` — extend `autoFillType` union
- `frontend/src/components/proposal-editor/ProposalEditor.tsx` — remove in-doc category checkmark, apply category-based filter to the field picker
- `frontend/src/components/proposals/ProposalDocumentsManagementModal.tsx` — category dropdown (3 options)
- `frontend/src/pages/groups/GroupMembersTab.tsx` — green button / dropdown

---

## Task 1: Extend AutoFillType union + employee allow-list

**Files:**
- Modify: `frontend/src/services/proposal.service.ts` (around line 38)
- Create: `frontend/src/constants/employeeDocAutoFillTypes.ts`

- [ ] **Step 1: Add the 8 new string literals to the `autoFillType` union**

Edit `frontend/src/services/proposal.service.ts` line 38. Change from:
```ts
autoFillType?: 'AgentName' | 'AgentAddress' | 'AgentPhone' | 'AgentEmail' | 'AgentPhoto' | 'ClientName' | 'ClientAddress' | 'AgencyName' | 'TierDescription' | 'TodaysDate' | 'TodaysDateNumeric' | 'CustomText';
```
to:
```ts
autoFillType?: 'AgentName' | 'AgentAddress' | 'AgentPhone' | 'AgentEmail' | 'AgentPhoto' | 'ClientName' | 'ClientAddress' | 'AgencyName' | 'TierDescription' | 'TodaysDate' | 'TodaysDateNumeric' | 'CustomText'
  | 'GroupContributionEE' | 'GroupContributionES' | 'GroupContributionEC' | 'GroupContributionEF'
  | 'EmployeeCostEE' | 'EmployeeCostES' | 'EmployeeCostEC' | 'EmployeeCostEF';
```

- [ ] **Step 2: Create the category-scoped allow list**

Create `frontend/src/constants/employeeDocAutoFillTypes.ts` with:
```ts
export const EMPLOYEE_AUTOFILL_TYPES = [
  'GroupContributionEE', 'GroupContributionES', 'GroupContributionEC', 'GroupContributionEF',
  'EmployeeCostEE', 'EmployeeCostES', 'EmployeeCostEC', 'EmployeeCostEF',
] as const;

export type EmployeeAutoFillType = typeof EMPLOYEE_AUTOFILL_TYPES[number];

/**
 * AutoFillTypes allowed on templates with Category='Employee'.
 * Includes shared identity/branding types, plus the 8 new group-scoped ones.
 * Excludes business-scenario types that depend on form inputs the employee flow doesn't collect.
 */
export const EMPLOYEE_ALLOWED_AUTOFILL_TYPES = new Set<string>([
  // shared identity/branding (present in the base union)
  'AgentName', 'AgentAddress', 'AgentPhone', 'AgentEmail', 'AgentPhoto',
  'ClientName', 'ClientAddress', 'AgencyName',
  'TierDescription', 'TodaysDate', 'TodaysDateNumeric', 'CustomText',
  // new employee-specific
  ...EMPLOYEE_AUTOFILL_TYPES,
]);

/** Returns true when a given autoFillType value is allowed under the given Category. */
export function isAutoFillTypeAllowed(autoFillType: string, category: string | undefined): boolean {
  if (category !== 'Employee') return true; // General & Business retain full list
  return EMPLOYEE_ALLOWED_AUTOFILL_TYPES.has(autoFillType);
}
```

- [ ] **Step 3: Type-check the frontend**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -E "proposal.service|employeeDocAutoFillTypes" | head -5`
Expected: no output (no errors).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/proposal.service.ts frontend/src/constants/employeeDocAutoFillTypes.ts
git commit -m "feat(employee-docs): extend AutoFillType union with 8 employee-scoped types"
```

---

## Task 2: Backend category validation

**Files:**
- Modify: `backend/services/proposalDocument.service.js`
- Test: `backend/services/__tests__/proposalDocument.service.categoryValidation.test.js` (create)

- [ ] **Step 1: Locate the save path**

Run: `grep -n "saveProposalDocument\|category" backend/services/proposalDocument.service.js | head -20`
Find where `category` is read from input.

- [ ] **Step 2: Write failing test**

Create `backend/services/__tests__/proposalDocument.service.categoryValidation.test.js`:
```js
const proposalDocumentService = require('../proposalDocument.service');

describe('ProposalDocumentService.saveProposalDocument — category validation', () => {
  it('accepts General', () => {
    expect(() => proposalDocumentService.validateCategory('General')).not.toThrow();
  });
  it('accepts Business', () => {
    expect(() => proposalDocumentService.validateCategory('Business')).not.toThrow();
  });
  it('accepts Employee', () => {
    expect(() => proposalDocumentService.validateCategory('Employee')).not.toThrow();
  });
  it('rejects Unknown with a clear error', () => {
    expect(() => proposalDocumentService.validateCategory('Unknown'))
      .toThrow(/Invalid category/);
  });
  it('rejects null', () => {
    expect(() => proposalDocumentService.validateCategory(null))
      .toThrow(/Invalid category/);
  });
});
```

- [ ] **Step 3: Run test — expect failure**

Run: `cd backend && npx jest services/__tests__/proposalDocument.service.categoryValidation.test.js`
Expected: fails — `validateCategory is not a function`.

- [ ] **Step 4: Implement**

Add to `backend/services/proposalDocument.service.js` (export alongside existing methods):
```js
const ALLOWED_CATEGORIES = Object.freeze(['General', 'Business', 'Employee']);

function validateCategory(category) {
  if (!ALLOWED_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category "${category}". Must be one of: ${ALLOWED_CATEGORIES.join(', ')}`);
  }
}

module.exports = {
  // ...existing exports,
  validateCategory,
  ALLOWED_CATEGORIES,
};
```

Then find the `saveProposalDocument` function and add a `validateCategory(data.category || 'General')` call at the top of its input-validation block (near existing input checks). Default null/undefined to `'General'` for legacy compatibility.

- [ ] **Step 5: Run test — expect pass**

Run: `cd backend && npx jest services/__tests__/proposalDocument.service.categoryValidation.test.js`
Expected: all 5 pass.

- [ ] **Step 6: Commit**

```bash
git add backend/services/proposalDocument.service.js backend/services/__tests__/proposalDocument.service.categoryValidation.test.js
git commit -m "feat(employee-docs): add Employee to allowed ProposalDocuments categories"
```

---

## Task 3: Backend autofill resolvers for the 8 new types

**Files:**
- Modify: `backend/services/proposalGenerator.service.js`
- Test: `backend/services/__tests__/proposalGenerator.employeeAutoFills.test.js` (create)

- [ ] **Step 1: Explore existing resolver pattern**

Run: `grep -nE "AutoFillType|resolveAutoFill|autoFillType" backend/services/proposalGenerator.service.js | head -30`
Identify the function that maps an AutoFillType string to a rendered value (likely inside `generateProposalPDF`). Note the function name, signature, and closure data (agent, group, prospectInfo, etc.).

- [ ] **Step 2: Write failing tests**

Create `backend/services/__tests__/proposalGenerator.employeeAutoFills.test.js`:
```js
const { resolveEmployeeDocAutoFill } = require('../proposalGenerator.service');

describe('resolveEmployeeDocAutoFill', () => {
  const ctxBase = {
    tierPricing: { EE: 100, ES: 200, EC: 250, EF: 400 },
    groupContributions: {
      tierContributions: {
        EE: { amount: 50, type: 'dollar' },
        ES: { amount: 25, type: 'percentage' }, // 25% of ES=$200 = $50
        // EC omitted -> $0
        EF: { amount: 0, type: 'dollar' },
      }
    }
  };

  it('GroupContributionEE: dollar type returns raw amount', () => {
    expect(resolveEmployeeDocAutoFill('GroupContributionEE', ctxBase)).toBe(50);
  });
  it('GroupContributionES: percentage type returns price * percent/100', () => {
    expect(resolveEmployeeDocAutoFill('GroupContributionES', ctxBase)).toBe(50);
  });
  it('GroupContributionEC: missing tier returns $0', () => {
    expect(resolveEmployeeDocAutoFill('GroupContributionEC', ctxBase)).toBe(0);
  });
  it('GroupContributionEF: explicit $0 returns 0', () => {
    expect(resolveEmployeeDocAutoFill('GroupContributionEF', ctxBase)).toBe(0);
  });

  it('EmployeeCostEE: price minus contribution', () => {
    expect(resolveEmployeeDocAutoFill('EmployeeCostEE', ctxBase)).toBe(50); // 100 - 50
  });
  it('EmployeeCostES: handles percent contribution', () => {
    expect(resolveEmployeeDocAutoFill('EmployeeCostES', ctxBase)).toBe(150); // 200 - 50
  });
  it('EmployeeCostEC: no contribution -> full price', () => {
    expect(resolveEmployeeDocAutoFill('EmployeeCostEC', ctxBase)).toBe(250);
  });
  it('EmployeeCostEF: never negative', () => {
    const ctx = { ...ctxBase, groupContributions: { tierContributions: { EF: { amount: 9999, type: 'dollar' } } } };
    expect(resolveEmployeeDocAutoFill('EmployeeCostEF', ctx)).toBe(0);
  });

  it('null groupContributions -> contribution 0, cost = price', () => {
    const ctx = { ...ctxBase, groupContributions: null };
    expect(resolveEmployeeDocAutoFill('GroupContributionEE', ctx)).toBe(0);
    expect(resolveEmployeeDocAutoFill('EmployeeCostEE', ctx)).toBe(100);
  });

  it('returns undefined for non-employee-scoped types (pass-through)', () => {
    expect(resolveEmployeeDocAutoFill('AgentName', ctxBase)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests — expect failure**

Run: `cd backend && npx jest services/__tests__/proposalGenerator.employeeAutoFills.test.js`
Expected: `resolveEmployeeDocAutoFill is not a function`.

- [ ] **Step 4: Implement `resolveEmployeeDocAutoFill`**

Add to `backend/services/proposalGenerator.service.js`:
```js
const EMPLOYEE_CONTRIB_TYPES = ['GroupContributionEE', 'GroupContributionES', 'GroupContributionEC', 'GroupContributionEF'];
const EMPLOYEE_COST_TYPES    = ['EmployeeCostEE',       'EmployeeCostES',       'EmployeeCostEC',       'EmployeeCostEF'];
const TIER_KEY = { GroupContributionEE: 'EE', GroupContributionES: 'ES', GroupContributionEC: 'EC', GroupContributionEF: 'EF',
                   EmployeeCostEE: 'EE',       EmployeeCostES: 'ES',       EmployeeCostEC: 'EC',       EmployeeCostEF: 'EF' };

function resolveContributionDollars(tierKey, ctx) {
  const tc = ctx?.groupContributions?.tierContributions?.[tierKey];
  if (!tc || tc.amount == null) return 0;
  const amount = Number(tc.amount) || 0;
  if (tc.type === 'percentage') {
    const price = Number(ctx?.tierPricing?.[tierKey]) || 0;
    return (price * amount) / 100;
  }
  return amount; // 'dollar' or default
}

function resolveEmployeeDocAutoFill(type, ctx) {
  if (EMPLOYEE_CONTRIB_TYPES.includes(type)) {
    return resolveContributionDollars(TIER_KEY[type], ctx);
  }
  if (EMPLOYEE_COST_TYPES.includes(type)) {
    const tier = TIER_KEY[type];
    const price = Number(ctx?.tierPricing?.[tier]) || 0;
    const contribution = resolveContributionDollars(tier, ctx);
    return Math.max(0, price - contribution);
  }
  return undefined;
}

module.exports = {
  // ...existing exports,
  resolveEmployeeDocAutoFill,
};
```

- [ ] **Step 5: Run tests — expect pass**

Run: `cd backend && npx jest services/__tests__/proposalGenerator.employeeAutoFills.test.js`
Expected: all 10 pass.

- [ ] **Step 6: Wire the resolver into the PDF generator**

Find the AutoFillType dispatch inside `generateProposalPDF` (from step 1). Before the existing switch/if ladder falls through, add:
```js
const employeeValue = resolveEmployeeDocAutoFill(field.AutoFillType, { tierPricing, groupContributions });
if (employeeValue !== undefined) {
  return formatCurrency(employeeValue); // use existing currency formatter in this file
}
```
Ensure `tierPricing` and `groupContributions` are plumbed in through the call chain. If the existing `generateProposalPDF` signature doesn't accept them, add them as an options object field (e.g. `options.employeeContext = { tierPricing, groupContributions }`) without breaking existing callers.

- [ ] **Step 7: Commit**

```bash
git add backend/services/proposalGenerator.service.js backend/services/__tests__/proposalGenerator.employeeAutoFills.test.js
git commit -m "feat(employee-docs): add 8 employee autofill resolvers"
```

---

## Task 4: `employeeFacingDoc.service.js` — applicability

**Files:**
- Create: `backend/services/employeeFacingDoc.service.js`
- Create: `backend/services/__tests__/employeeFacingDoc.service.test.js`

- [ ] **Step 1: Write failing tests**

Create `backend/services/__tests__/employeeFacingDoc.service.test.js`:
```js
jest.mock('../../config/database', () => ({ getPool: jest.fn() }));
const { getPool } = require('../../config/database');
const service = require('../employeeFacingDoc.service');

function makePool(recordsets) {
  let call = 0;
  return {
    request: () => ({
      input: function() { return this; },
      query: async () => ({ recordset: recordsets[call++] || [] })
    })
  };
}

describe('getApplicableEmployeeDocsForGroup', () => {
  beforeEach(() => getPool.mockReset());

  it('returns employee docs whose primary product is in the group', async () => {
    getPool.mockResolvedValue(makePool([
      // 1st query — group products
      [{ ProductId: 'p1' }, { ProductId: 'p2' }],
      // 2nd query — employee docs for tenant + their primary products
      [
        { ProposalDocumentId: 'd1', Name: 'Gold', PrimaryProductId: 'p1', ProductName: 'Gold Plan' },
        { ProposalDocumentId: 'd2', Name: 'HSA',  PrimaryProductId: 'p3', ProductName: 'HSA Plan' },
      ]
    ]));

    const result = await service.getApplicableEmployeeDocsForGroup('g1', 't1');
    expect(result).toEqual([
      { proposalDocumentId: 'd1', name: 'Gold', productId: 'p1', productName: 'Gold Plan' }
    ]);
  });

  it('returns [] when group has no products', async () => {
    getPool.mockResolvedValue(makePool([[], []]));
    const result = await service.getApplicableEmployeeDocsForGroup('g1', 't1');
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd backend && npx jest services/__tests__/employeeFacingDoc.service.test.js`
Expected: fails — `Cannot find module '../employeeFacingDoc.service'`.

- [ ] **Step 3: Implement the service — applicability only**

Create `backend/services/employeeFacingDoc.service.js`:
```js
const sql = require('mssql');
const { getPool } = require('../config/database');

/**
 * Returns the employee-facing ProposalDocuments applicable to a given group.
 * A doc is applicable when:
 *   (a) Category='Employee' AND IsActive=1
 *   (b) Scoped to the group's tenant via oe.ProposalDocumentTenants
 *   (c) Its PRIMARY product (ProposalDocumentProducts.IsPrimary=1) is in
 *       oe.GroupProducts for this group with IsActive=1 AND IsHidden=0
 *
 * @param {string} groupId
 * @param {string} tenantId - the group's tenant
 * @returns {Promise<Array<{proposalDocumentId, name, productId, productName}>>}
 */
async function getApplicableEmployeeDocsForGroup(groupId, tenantId) {
  const pool = await getPool();

  const groupProductsResult = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`
      SELECT ProductId FROM oe.GroupProducts
      WHERE GroupId = @groupId AND IsActive = 1 AND IsHidden = 0
    `);
  const groupProductIds = new Set(groupProductsResult.recordset.map(r => String(r.ProductId).toUpperCase()));
  if (groupProductIds.size === 0) return [];

  const docsResult = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT pd.ProposalDocumentId, pd.Name,
             pdp.ProductId AS PrimaryProductId,
             p.Name AS ProductName
      FROM oe.ProposalDocuments pd
      JOIN oe.ProposalDocumentTenants pdt ON pdt.ProposalDocumentId = pd.ProposalDocumentId
      JOIN oe.ProposalDocumentProducts pdp ON pdp.ProposalDocumentId = pd.ProposalDocumentId AND pdp.IsPrimary = 1
      LEFT JOIN oe.Products p ON p.ProductId = pdp.ProductId
      WHERE pd.Category = 'Employee' AND pd.IsActive = 1 AND pdt.TenantId = @tenantId
    `);

  return docsResult.recordset
    .filter(r => groupProductIds.has(String(r.PrimaryProductId).toUpperCase()))
    .map(r => ({
      proposalDocumentId: r.ProposalDocumentId,
      name: r.Name,
      productId: r.PrimaryProductId,
      productName: r.ProductName,
    }));
}

module.exports = {
  getApplicableEmployeeDocsForGroup,
};
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd backend && npx jest services/__tests__/employeeFacingDoc.service.test.js`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services/employeeFacingDoc.service.js backend/services/__tests__/employeeFacingDoc.service.test.js
git commit -m "feat(employee-docs): applicability resolver (group × Employee docs via primary product)"
```

---

## Task 5: `employeeFacingDoc.service.js` — `generateEmployeeFacingPDF`

**Files:**
- Modify: `backend/services/employeeFacingDoc.service.js`
- Modify: `backend/services/__tests__/employeeFacingDoc.service.test.js`

- [ ] **Step 1: Add failing tests for generation shape**

Append to `backend/services/__tests__/employeeFacingDoc.service.test.js`:
```js
describe('generateEmployeeFacingPDF', () => {
  beforeEach(() => getPool.mockReset());

  it('throws 404-style error when doc is not Employee category', async () => {
    getPool.mockResolvedValue(makePool([
      [{ Category: 'Business' }]
    ]));
    await expect(service.generateEmployeeFacingPDF('g1', 'd1', 'u1'))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 409 when doc primary product is no longer on the group', async () => {
    // sequence: doc row, group product check (empty)
    getPool.mockResolvedValue(makePool([
      [{ Category: 'Employee', ProposalDocumentId: 'd1' }],
      [{ PrimaryProductId: 'pX' }],
      [], // no match in group products
    ]));
    await expect(service.generateEmployeeFacingPDF('g1', 'd1', 'u1'))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd backend && npx jest services/__tests__/employeeFacingDoc.service.test.js`
Expected: fails — `generateEmployeeFacingPDF is not a function`.

- [ ] **Step 3: Implement generation**

Add to `backend/services/employeeFacingDoc.service.js`:
```js
const proposalGeneratorService = require('./proposalGenerator.service');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Generates the PDF buffer for an employee-facing doc.
 * Authorization is handled UPSTREAM (requireGroupAccess middleware).
 * This function only validates shape (doc exists, is Employee, primary product still on group),
 * loads the data, and invokes the PDF generator.
 *
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 */
async function generateEmployeeFacingPDF(groupId, proposalDocumentId, requesterUserId) {
  const pool = await getPool();

  // 1. Load the doc header
  const docRes = await pool.request()
    .input('docId', sql.UniqueIdentifier, proposalDocumentId)
    .query(`
      SELECT ProposalDocumentId, Name, Category, IsActive, DocumentId
      FROM oe.ProposalDocuments WHERE ProposalDocumentId = @docId
    `);
  const doc = docRes.recordset[0];
  if (!doc || !doc.IsActive || doc.Category !== 'Employee') {
    throw new HttpError(404, 'Employee document not found');
  }

  // 2. Resolve primary product
  const primaryRes = await pool.request()
    .input('docId', sql.UniqueIdentifier, proposalDocumentId)
    .query(`
      SELECT TOP 1 ProductId FROM oe.ProposalDocumentProducts
      WHERE ProposalDocumentId = @docId AND IsPrimary = 1
    `);
  const primaryProductId = primaryRes.recordset[0]?.ProductId;
  if (!primaryProductId) throw new HttpError(409, 'Employee document has no primary product');

  // 3. Assert group still has the primary product
  const gpRes = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('productId', sql.UniqueIdentifier, primaryProductId)
    .query(`
      SELECT 1 FROM oe.GroupProducts
      WHERE GroupId = @groupId AND ProductId = @productId AND IsActive = 1 AND IsHidden = 0
    `);
  if (gpRes.recordset.length === 0) {
    throw new HttpError(409, 'Primary product is no longer assigned to this group');
  }

  // 4. Load group + agent + tenant + contributions in one pass
  const ctxRes = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`
      SELECT g.GroupId, g.Name AS GroupName, g.AgentId, g.TenantId,
             g.Address1, g.City, g.State, g.Zip
      FROM oe.Groups g WHERE g.GroupId = @groupId
    `);
  const group = ctxRes.recordset[0];
  if (!group) throw new HttpError(404, 'Group not found');

  const contribRes = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('productId', sql.UniqueIdentifier, primaryProductId)
    .query(`
      SELECT TOP 1 * FROM oe.GroupContributions
      WHERE GroupId = @groupId AND (ProductId = @productId OR ProductId IS NULL OR ProductIds LIKE '%' + CAST(@productId AS NVARCHAR(36)) + '%')
        AND Status = 'Active'
      ORDER BY CASE WHEN ProductId = @productId THEN 0 ELSE 1 END, Priority ASC
    `);
  const groupContributions = contribRes.recordset[0] ? {
    tierContributions: safeJsonParse(contribRes.recordset[0].TierContributions) || {}
  } : { tierContributions: {} };

  // 5. Resolve auto-created enrollment link for the group
  const linkRes = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`
      SELECT TOP 1 TemplateId FROM oe.EnrollmentLinkTemplates
      WHERE GroupId = @groupId AND TemplateType = 'Group' AND IsActive = 1
    `);
  const enrollmentLinkTemplateId = linkRes.recordset[0]?.TemplateId || null;

  // 6. Build prospect/company info for the PDF (from the group, not the agent's modal input)
  const companyInfo = {
    companyName: group.GroupName,
    companyAddressLine1: group.Address1 || '',
    companyCity: group.City || '',
    companyState: group.State || '',
    companyZip: group.Zip || '',
  };

  // 7. Hand off to existing PDF generator with employee context
  const pdfBuffer = await proposalGeneratorService.generateProposalPDF(
    proposalDocumentId,
    group.AgentId,
    groupId,
    companyInfo,
    'EE',     // default tier label (template-level pricing fields override)
    false,    // no tobacco
    30,       // default age
    enrollmentLinkTemplateId ? { defaultTemplateId: enrollmentLinkTemplateId } : {},
    {},       // customFieldValues (unused)
    {},       // calculationResults (unused — employee docs don't use calc fields)
    null,     // enrollmentDate
    {
      employeeContext: {
        groupContributions,
        // tierPricing resolved by existing pricing engine inside generateProposalPDF using primaryProductId
      }
    }
  );

  const filename = `${sanitizeFilename(group.GroupName)}-${sanitizeFilename(doc.Name)}.pdf`;
  return { buffer: pdfBuffer, filename };
}

function safeJsonParse(s) {
  if (typeof s !== 'string') return s || null;
  try { return JSON.parse(s); } catch { return null; }
}

function sanitizeFilename(s) {
  return String(s || 'document').replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '-') || 'document';
}

module.exports = {
  getApplicableEmployeeDocsForGroup,
  generateEmployeeFacingPDF,
  HttpError,
};
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd backend && npx jest services/__tests__/employeeFacingDoc.service.test.js`
Expected: all 4 pass (2 applicability + 2 generation error cases).

- [ ] **Step 5: Commit**

```bash
git add backend/services/employeeFacingDoc.service.js backend/services/__tests__/employeeFacingDoc.service.test.js
git commit -m "feat(employee-docs): generateEmployeeFacingPDF service"
```

---

## Task 6: `requireGroupAccess` middleware

**Files:**
- Create: `backend/middleware/requireGroupAccess.js` (only if no existing equivalent)
- Create: `backend/middleware/__tests__/requireGroupAccess.test.js`

- [ ] **Step 1: Check for existing middleware**

Run: `grep -rn "requireGroupAccess\|requireGroupAdmin\|groupAccess" backend/middleware/ 2>/dev/null`
If an equivalent exists (e.g. `requireGroupAccess.js`), skip Task 6 entirely and document it in the route task (Task 7) — use the existing middleware. If nothing, proceed.

- [ ] **Step 2: Write failing test**

Create `backend/middleware/__tests__/requireGroupAccess.test.js`:
```js
jest.mock('../../config/database', () => ({ getPool: jest.fn() }));
const { getPool } = require('../../config/database');
const requireGroupAccess = require('../requireGroupAccess');

function runMiddleware(req) {
  return new Promise((resolve) => {
    const res = { status: (code) => ({ json: (body) => resolve({ code, body }) }) };
    requireGroupAccess(req, res, () => resolve({ nextCalled: true }));
  });
}

function poolWithGroup(group) {
  return {
    request: () => ({
      input: function() { return this; },
      query: async () => ({ recordset: group ? [group] : [] })
    })
  };
}

describe('requireGroupAccess', () => {
  beforeEach(() => getPool.mockReset());

  it('allows the agent owner', async () => {
    getPool.mockResolvedValue(poolWithGroup({ GroupId: 'g1', TenantId: 't1', AgentId: 'a1' }));
    const result = await runMiddleware({ params: { groupId: 'g1' }, user: { userId: 'a1', roles: ['Agent'] } });
    expect(result.nextCalled).toBe(true);
  });

  it('allows SysAdmin of the tenant', async () => {
    getPool.mockResolvedValue(poolWithGroup({ GroupId: 'g1', TenantId: 't1', AgentId: 'a1' }));
    const result = await runMiddleware({ params: { groupId: 'g1' }, user: { userId: 'u2', tenantId: 't1', roles: ['SysAdmin'] } });
    expect(result.nextCalled).toBe(true);
  });

  it('rejects someone from a different tenant', async () => {
    getPool.mockResolvedValue(poolWithGroup({ GroupId: 'g1', TenantId: 't1', AgentId: 'a1' }));
    const result = await runMiddleware({ params: { groupId: 'g1' }, user: { userId: 'u3', tenantId: 't9', roles: ['TenantAdmin'] } });
    expect(result.code).toBe(403);
  });

  it('404s when group does not exist', async () => {
    getPool.mockResolvedValue(poolWithGroup(null));
    const result = await runMiddleware({ params: { groupId: 'gX' }, user: { userId: 'u1', roles: ['Agent'] } });
    expect(result.code).toBe(404);
  });
});
```

- [ ] **Step 3: Run — expect failure**

Run: `cd backend && npx jest middleware/__tests__/requireGroupAccess.test.js`
Expected: `Cannot find module '../requireGroupAccess'`.

- [ ] **Step 4: Implement middleware**

Create `backend/middleware/requireGroupAccess.js`:
```js
const sql = require('mssql');
const { getPool } = require('../config/database');

/**
 * Express middleware. Requires req.user (set by upstream auth) and req.params.groupId.
 * Allows:
 *   - Agent owner of the group (user.userId === group.AgentId)
 *   - GroupAdmin whose assigned group matches
 *   - TenantAdmin / SysAdmin of the group's tenant
 * Attaches req.group = { groupId, tenantId, agentId } on success.
 */
module.exports = async function requireGroupAccess(req, res, next) {
  try {
    const groupId = req.params.groupId;
    if (!groupId) return res.status(400).json({ success: false, message: 'groupId is required' });

    const pool = await getPool();
    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`SELECT GroupId, TenantId, AgentId FROM oe.Groups WHERE GroupId = @groupId`);
    const group = result.recordset[0];
    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    const user = req.user || {};
    const roles = Array.isArray(user.roles) ? user.roles : (user.roles ? [user.roles] : []);
    const isAgentOwner = user.userId && String(user.userId).toLowerCase() === String(group.AgentId || '').toLowerCase();
    const isTenantAdmin = (roles.includes('TenantAdmin') || roles.includes('SysAdmin'))
                          && String(user.tenantId || '').toLowerCase() === String(group.TenantId).toLowerCase();
    const isSysAdmin = roles.includes('SysAdmin'); // SysAdmin can cross tenants
    const isGroupAdmin = roles.includes('GroupAdmin')
                         && user.groupId
                         && String(user.groupId).toLowerCase() === String(group.GroupId).toLowerCase();

    if (isAgentOwner || isTenantAdmin || isSysAdmin || isGroupAdmin) {
      req.group = { groupId: group.GroupId, tenantId: group.TenantId, agentId: group.AgentId };
      return next();
    }
    return res.status(403).json({ success: false, message: 'Forbidden' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
```

- [ ] **Step 5: Run — expect pass**

Run: `cd backend && npx jest middleware/__tests__/requireGroupAccess.test.js`
Expected: 4 pass.

- [ ] **Step 6: Commit**

```bash
git add backend/middleware/requireGroupAccess.js backend/middleware/__tests__/requireGroupAccess.test.js
git commit -m "feat(employee-docs): requireGroupAccess middleware (Agent/GroupAdmin/TenantAdmin/SysAdmin)"
```

---

## Task 7: Routes + route tests + `app.js` mount

**Files:**
- Create: `backend/routes/groups.employee-docs.js`
- Create: `backend/routes/__tests__/groups.employee-docs.test.js`
- Modify: `backend/app.js`

- [ ] **Step 1: Write failing route tests**

Create `backend/routes/__tests__/groups.employee-docs.test.js`:
```js
jest.mock('../../services/employeeFacingDoc.service');
jest.mock('../../middleware/requireGroupAccess', () =>
  jest.fn((req, _res, next) => { req.group = { groupId: req.params.groupId, tenantId: 'T1', agentId: 'A1' }; next(); })
);
jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req, _res, next) => { req.user = { userId: 'A1', roles: ['Agent'], tenantId: 'T1' }; next(); }
}));

const request = require('supertest');
const express = require('express');
const svc = require('../../services/employeeFacingDoc.service');
const router = require('../groups.employee-docs');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe('GET /api/groups/:groupId/employee-docs', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns applicable docs', async () => {
    svc.getApplicableEmployeeDocsForGroup.mockResolvedValue([
      { proposalDocumentId: 'd1', name: 'Gold', productId: 'p1', productName: 'Gold' }
    ]);
    const res = await request(makeApp()).get('/api/groups/g1/employee-docs');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('GET /api/groups/:groupId/employee-docs/:docId/download', () => {
  beforeEach(() => jest.clearAllMocks());

  it('streams PDF with inline disposition on success', async () => {
    svc.generateEmployeeFacingPDF.mockResolvedValue({ buffer: Buffer.from('%PDF-test'), filename: 'G-Gold.pdf' });
    const res = await request(makeApp()).get('/api/groups/g1/employee-docs/d1/download');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/inline/);
    expect(res.headers['content-disposition']).toContain('G-Gold.pdf');
  });

  it('404 when service throws 404', async () => {
    svc.generateEmployeeFacingPDF.mockRejectedValue(Object.assign(new Error('nope'), { statusCode: 404 }));
    const res = await request(makeApp()).get('/api/groups/g1/employee-docs/d1/download');
    expect(res.status).toBe(404);
  });

  it('409 when service throws 409', async () => {
    svc.generateEmployeeFacingPDF.mockRejectedValue(Object.assign(new Error('race'), { statusCode: 409 }));
    const res = await request(makeApp()).get('/api/groups/g1/employee-docs/d1/download');
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd backend && npx jest routes/__tests__/groups.employee-docs.test.js`
Expected: cannot find router.

- [ ] **Step 3: Implement router**

Create `backend/routes/groups.employee-docs.js`:
```js
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const requireGroupAccess = require('../middleware/requireGroupAccess');
const service = require('../services/employeeFacingDoc.service');

const router = express.Router();

router.get('/api/groups/:groupId/employee-docs',
  authenticateToken,
  requireGroupAccess,
  async (req, res) => {
    try {
      const data = await service.getApplicableEmployeeDocsForGroup(req.group.groupId, req.group.tenantId);
      res.json({ success: true, data });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }
);

router.get('/api/groups/:groupId/employee-docs/:proposalDocumentId/download',
  authenticateToken,
  requireGroupAccess,
  async (req, res) => {
    try {
      const { buffer, filename } = await service.generateEmployeeFacingPDF(
        req.group.groupId,
        req.params.proposalDocumentId,
        req.user?.userId
      );
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(buffer);
    } catch (err) {
      const code = err.statusCode || 500;
      res.status(code).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
```

- [ ] **Step 4: Run — expect pass**

Run: `cd backend && npx jest routes/__tests__/groups.employee-docs.test.js`
Expected: 4 pass.

- [ ] **Step 5: Mount the router in `app.js`**

Grep to find the existing route-mounting block:
```bash
grep -n "app.use.*require.*routes" backend/app.js | head -10
```
Add a line alongside the others:
```js
app.use(require('./routes/groups.employee-docs'));
console.log('✅ Mounted /api/groups/:groupId/employee-docs routes');
```

- [ ] **Step 6: Smoke-boot the server**

Run: `cd backend && node -e "require('./app.js')" 2>&1 | head -30` OR start the background server and verify no startup errors.
Expected: no crash, mount log line appears.

- [ ] **Step 7: Commit**

```bash
git add backend/routes/groups.employee-docs.js backend/routes/__tests__/groups.employee-docs.test.js backend/app.js
git commit -m "feat(employee-docs): add GET /api/groups/:groupId/employee-docs and download route"
```

---

## Task 8: Category dropdown in `ProposalDocumentsManagementModal`

**Files:**
- Modify: `frontend/src/components/proposals/ProposalDocumentsManagementModal.tsx`

- [ ] **Step 1: Find the Name/Description form block**

Run: `grep -n "name\|description\|category" frontend/src/components/proposals/ProposalDocumentsManagementModal.tsx | head -30`
Locate where the modal renders its Name + Description inputs.

- [ ] **Step 2: Add category state + dropdown UI**

Next to the existing `name` / `description` state, add:
```tsx
const [category, setCategory] = useState<'General' | 'Business' | 'Employee'>('General');
```

In the form JSX, next to the Name and Description inputs, add:
```tsx
<div>
  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
  <select
    value={category}
    onChange={(e) => setCategory(e.target.value as 'General' | 'Business' | 'Employee')}
    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-oe-primary focus:ring-oe-primary"
  >
    <option value="General">General</option>
    <option value="Business">Business</option>
    <option value="Employee">Employee</option>
  </select>
</div>
```

- [ ] **Step 3: Send `category` in the create/save payload**

Find the POST to `/api/proposal-documents` (should already exist). Add `category` to the body object.

- [ ] **Step 4: When editing an existing document, hydrate the dropdown**

Find where the modal loads existing document data and add `setCategory(existingDoc.category || 'General')` on load.

- [ ] **Step 5: Type-check**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep ProposalDocumentsManagementModal | head -5`
Expected: no errors in this file.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/proposals/ProposalDocumentsManagementModal.tsx
git commit -m "feat(employee-docs): add Category dropdown (General/Business/Employee) to settings modal"
```

---

## Task 9: Remove in-editor category checkmark + apply field-picker filter

**Files:**
- Modify: `frontend/src/components/proposal-editor/ProposalEditor.tsx`

Context: `ProposalEditor.tsx:107` has `const [isBusinessProposal, setIsBusinessProposal] = useState(false);` which is derived from `category === 'Business'` on load (line 376) and written back as `category: isBusinessProposal ? 'Business' : 'General'` on save (line 995). There is also a UI toggle somewhere (likely a checkbox labeled "Business proposal"). We remove that toggle, keep `category` as a read-only prop from parent (already passed at line 83), and wire the field-picker filter.

- [ ] **Step 1: Grep for the checkmark UI**

Run: `grep -n "isBusinessProposal\|Business Proposal\|Business proposal" frontend/src/components/proposal-editor/ProposalEditor.tsx | head -20`
Identify the JSX element rendering the checkbox (likely a `<Checkbox>` or `<input type="checkbox">`).

- [ ] **Step 2: Remove the checkbox UI element**

Delete the JSX element for the Business-proposal checkbox. Keep the `isBusinessProposal` state for now (it may still be read by calculation logic); retire `setIsBusinessProposal` usages in UI handlers. The variable continues to be derived from the loaded `category` at line 376 — that derivation stays.

- [ ] **Step 3: Rely on the parent-supplied `category` prop**

Change the save path (line 995) from:
```ts
category: isBusinessProposal ? 'Business' : 'General'
```
to:
```ts
category: category || 'General'
```
where `category` is the prop (already destructured at line 83). This stops the editor from overwriting the value the settings modal set.

- [ ] **Step 4: Import the allow-list helper**

At the top of the file:
```ts
import { isAutoFillTypeAllowed } from '../../constants/employeeDocAutoFillTypes';
```

- [ ] **Step 5: Filter the AutoFillType picker**

Find the `<select>` / dropdown that lets the template author pick an `autoFillType` for a field. Grep:
```bash
grep -n "autoFillType\|AutoFillType" frontend/src/components/proposal-editor/ProposalEditor.tsx | head -30
```
Wrap the `<option>` list so that when category is `'Employee'`, options are filtered through `isAutoFillTypeAllowed`. Example pattern (adapt to the exact JSX in the file):
```tsx
{AUTO_FILL_OPTIONS
  .filter(opt => isAutoFillTypeAllowed(opt.value, category))
  .map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
```

If `AUTO_FILL_OPTIONS` isn't already a constant in the file, define it near the top with the full list from `proposal.service.ts`'s union.

- [ ] **Step 6: Show warning on pre-placed disallowed fields**

For any field on the canvas whose current `autoFillType` is not allowed under the current category, render a small warning badge. A minimal addition near the field card rendering:
```tsx
{category === 'Employee' && field.autoFillType && !isAutoFillTypeAllowed(field.autoFillType, category) && (
  <span className="text-xs text-amber-600 ml-2">⚠ Won't populate</span>
)}
```

- [ ] **Step 7: Type-check**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep ProposalEditor | head -5`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/proposal-editor/ProposalEditor.tsx
git commit -m "feat(employee-docs): remove in-editor category toggle, filter field picker by category"
```

---

## Task 10: `useGroupEmployeeDocs` hook

**Files:**
- Create: `frontend/src/hooks/groups/useGroupEmployeeDocs.ts`
- Create: `frontend/src/hooks/groups/__tests__/useGroupEmployeeDocs.test.tsx`

- [ ] **Step 1: Write failing test**

Create `frontend/src/hooks/groups/__tests__/useGroupEmployeeDocs.test.tsx`:
```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGroupEmployeeDocs } from '../useGroupEmployeeDocs';

jest.mock('../../../services/api.service', () => ({
  apiService: { get: jest.fn() }
}));
const { apiService } = require('../../../services/api.service');

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useGroupEmployeeDocs', () => {
  it('returns the applicable docs list', async () => {
    apiService.get.mockResolvedValue({ success: true, data: [{ proposalDocumentId: 'd1', name: 'Gold', productId: 'p1', productName: 'Gold' }] });
    const { result } = renderHook(() => useGroupEmployeeDocs('g1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(apiService.get).toHaveBeenCalledWith('/api/groups/g1/employee-docs');
  });

  it('does not fire when groupId is null', async () => {
    apiService.get.mockClear();
    renderHook(() => useGroupEmployeeDocs(null), { wrapper: wrapper() });
    expect(apiService.get).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd frontend && npx vitest run src/hooks/groups/__tests__/useGroupEmployeeDocs.test.tsx`
Expected: cannot find module.

- [ ] **Step 3: Implement hook**

Create `frontend/src/hooks/groups/useGroupEmployeeDocs.ts`:
```ts
import { useQuery } from '@tanstack/react-query';
import { apiService } from '../../services/api.service';

export interface ApplicableEmployeeDoc {
  proposalDocumentId: string;
  name: string;
  productId: string;
  productName: string;
}

export function useGroupEmployeeDocs(groupId: string | null) {
  return useQuery<ApplicableEmployeeDoc[], Error>({
    queryKey: ['groupEmployeeDocs', groupId],
    queryFn: async () => {
      const res = await apiService.get<{ success: boolean; data?: ApplicableEmployeeDoc[]; message?: string }>(
        `/api/groups/${groupId}/employee-docs`
      );
      if (!res.success) throw new Error(res.message || 'Failed to load employee docs');
      return res.data ?? [];
    },
    enabled: !!groupId,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
  });
}

export function getEmployeeDocDownloadUrl(groupId: string, proposalDocumentId: string): string {
  return `/api/groups/${groupId}/employee-docs/${proposalDocumentId}/download`;
}
```

- [ ] **Step 4: Run — expect pass**

Run: `cd frontend && npx vitest run src/hooks/groups/__tests__/useGroupEmployeeDocs.test.tsx`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/groups/useGroupEmployeeDocs.ts frontend/src/hooks/groups/__tests__/useGroupEmployeeDocs.test.tsx
git commit -m "feat(employee-docs): useGroupEmployeeDocs hook + download URL helper"
```

---

## Task 11: Green button / dropdown in `GroupMembersTab`

**Files:**
- Modify: `frontend/src/pages/groups/GroupMembersTab.tsx`

- [ ] **Step 1: Read the existing button stack**

Open the file between lines 3390-3523. Confirm the button stack is MUI (`<Stack>`, `<Button>`). The new button goes between "Send Message" and "Add Member".

- [ ] **Step 2: Wire the hook**

Near the top of the component (after existing hooks), add:
```tsx
import MenuItem from '@mui/material/MenuItem';
import Menu from '@mui/material/Menu';
import DownloadIcon from '@mui/icons-material/Download';
import Tooltip from '@mui/material/Tooltip';
import { useGroupEmployeeDocs, getEmployeeDocDownloadUrl } from '../../hooks/groups/useGroupEmployeeDocs';

const { data: employeeDocs = [], isLoading: empDocsLoading } = useGroupEmployeeDocs(groupId);
const [empDocMenuAnchor, setEmpDocMenuAnchor] = useState<HTMLElement | null>(null);
```

- [ ] **Step 3: Add the button/dropdown between Send Message and Add Member**

Insert this JSX inside the existing button `<Stack>`:
```tsx
{employeeDocs.length === 0 ? (
  <Tooltip title="No employee documents are configured for this group's products.">
    <span>
      <Button
        variant="contained"
        color="success"
        startIcon={<DownloadIcon />}
        disabled
      >
        Download employee doc
      </Button>
    </span>
  </Tooltip>
) : employeeDocs.length === 1 ? (
  <Button
    variant="contained"
    color="success"
    startIcon={<DownloadIcon />}
    onClick={() => window.open(getEmployeeDocDownloadUrl(groupId, employeeDocs[0].proposalDocumentId), '_blank', 'noopener')}
  >
    Download employee doc
  </Button>
) : (
  <>
    <Button
      variant="contained"
      color="success"
      startIcon={<DownloadIcon />}
      onClick={(e) => setEmpDocMenuAnchor(e.currentTarget)}
    >
      Download employee doc ▾
    </Button>
    <Menu
      anchorEl={empDocMenuAnchor}
      open={Boolean(empDocMenuAnchor)}
      onClose={() => setEmpDocMenuAnchor(null)}
    >
      {employeeDocs.map(doc => (
        <MenuItem
          key={doc.proposalDocumentId}
          onClick={() => {
            window.open(getEmployeeDocDownloadUrl(groupId, doc.proposalDocumentId), '_blank', 'noopener');
            setEmpDocMenuAnchor(null);
          }}
        >
          {doc.name}
        </MenuItem>
      ))}
    </Menu>
  </>
)}
```

- [ ] **Step 4: Type-check**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep GroupMembersTab | head -5`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/groups/GroupMembersTab.tsx
git commit -m "feat(employee-docs): green Download employee doc button/dropdown on Members tab"
```

---

## Task 12: Cypress smoke test

**Files:**
- Create: `frontend/cypress/e2e/employee-facing-doc-download.cy.ts`

- [ ] **Step 1: Write the spec**

Create `frontend/cypress/e2e/employee-facing-doc-download.cy.ts`:
```ts
/// <reference types="cypress" />

describe('Employee facing doc download', () => {
  beforeEach(() => {
    cy.intercept('GET', '/api/groups/*/employee-docs', {
      statusCode: 200,
      body: { success: true, data: [
        { proposalDocumentId: 'd1', name: 'Employee Facing (Gold)', productId: 'p1', productName: 'Gold' }
      ] }
    }).as('listDocs');
    cy.intercept('GET', '/api/groups/*/employee-docs/*/download', {
      statusCode: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="Group-Gold.pdf"' },
      body: '%PDF-1.4 test'
    }).as('downloadDoc');
  });

  it('shows button and fires download on click', () => {
    cy.login('agent@allaboard365.com'); // use the existing cypress login command
    cy.visit('/my-groups');
    cy.contains('My Groups').should('exist');
    // Pick any visible group — adjust selector if your app differs
    cy.get('[data-testid="group-list-item"]').first().click();
    cy.contains('Members').click();
    cy.wait('@listDocs');

    cy.window().then((win) => {
      cy.stub(win, 'open').as('winOpen');
    });
    cy.contains('button', 'Download employee doc').click();
    cy.get('@winOpen').should('have.been.calledWithMatch', /\/api\/groups\/.+\/employee-docs\/d1\/download/);
  });
});
```

- [ ] **Step 2: Run the Cypress spec against the dev stack**

Backend on 3002, frontend on 5174. Run:
```bash
cd frontend && npx cypress run --spec "cypress/e2e/employee-facing-doc-download.cy.ts" --browser chrome
```
Expected: spec passes. If the `[data-testid="group-list-item"]` selector doesn't match the actual app, update to the real selector found in `frontend/src/pages/groups/`.

- [ ] **Step 3: Commit**

```bash
git add frontend/cypress/e2e/employee-facing-doc-download.cy.ts
git commit -m "test(employee-docs): cypress smoke — list + download click"
```

---

## Task 13: Final sanity + PR

**Files:** none (verification + PR)

- [ ] **Step 1: Run all new tests together**

```bash
cd backend && npx jest services/__tests__/employeeFacingDoc.service.test.js services/__tests__/proposalGenerator.employeeAutoFills.test.js services/__tests__/proposalDocument.service.categoryValidation.test.js middleware/__tests__/requireGroupAccess.test.js routes/__tests__/groups.employee-docs.test.js
cd ../frontend && npx vitest run src/hooks/groups/__tests__/useGroupEmployeeDocs.test.tsx
```
Expected: all green.

- [ ] **Step 2: Manual smoke in browser**

Visit http://localhost:5174. Log in as an agent, open My Groups → a group with a matching Employee template configured in testing DB → Members tab → confirm green button renders; click → new tab opens the download URL and renders a PDF.

If testing DB has no Employee templates yet, insert one manually via db-query for verification:
```sql
-- pick a known tenant and product
INSERT INTO oe.ProposalDocuments (ProposalDocumentId, Name, Category, IsActive, DocumentId, CreatedDate, ModifiedDate)
VALUES (NEWID(), 'Employee Facing (Test)', 'Employee', 1, <an-existing-file-upload-id>, GETUTCDATE(), GETUTCDATE());
-- plus a row in oe.ProposalDocumentProducts with IsPrimary=1 pointing at a product the group owns
-- plus a row in oe.ProposalDocumentTenants for the tenant
```

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin employee-facing-docs
gh pr create --base master --title "feat(employee-docs): one-click employee-facing document generator" --body "$(cat <<'EOF'
## Summary

Adds a one-click "Download employee doc" button to the group Members tab. When an admin has uploaded a ProposalDocument with the new \`Category='Employee'\` setting and linked it to a primary product via \`ProposalDocumentProducts.IsPrimary=1\`, agents / GroupAdmins / TenantAdmins / SysAdmins can download a PDF for any group whose products intersect that primary product. The PDF auto-populates from the group's contribution rules, the group's agent, product pricing, tenant branding, and the group's auto-created enrollment link — no form inputs, no persistence, no \`ProposalSends\` row.

## Files changed

**Backend**
- \`backend/services/proposalDocument.service.js\` — add \`Employee\` to allowed categories + service-layer enum validator.
- \`backend/services/proposalGenerator.service.js\` — register 8 new \`AutoFillType\` resolvers (\`GroupContributionEE/ES/EC/EF\`, \`EmployeeCostEE/ES/EC/EF\`). Contribution resolver handles dollar/percentage; cost = \`max(0, price − contribution)\`.
- \`backend/services/employeeFacingDoc.service.js\` — NEW. Two functions: \`getApplicableEmployeeDocsForGroup\` (intersect group's products × Employee-category docs via IsPrimary) and \`generateEmployeeFacingPDF\` (validates category + primary-product-still-on-group, loads group/agent/tenant/contributions/enrollmentLinkTemplate, delegates to existing ProposalGeneratorService).
- \`backend/middleware/requireGroupAccess.js\` — NEW. Allows Agent owner, GroupAdmin assigned to the group, or TenantAdmin/SysAdmin of the group's tenant. Returns 403 otherwise.
- \`backend/routes/groups.employee-docs.js\` — NEW. \`GET /api/groups/:groupId/employee-docs\` (list) and \`GET /api/groups/:groupId/employee-docs/:docId/download\` (inline PDF stream).
- \`backend/app.js\` — mount the new router.

**Frontend**
- \`frontend/src/services/proposal.service.ts\` — extend the \`autoFillType\` union with the 8 new identifiers.
- \`frontend/src/constants/employeeDocAutoFillTypes.ts\` — NEW. Allow-list + \`isAutoFillTypeAllowed(type, category)\` helper used by the editor field picker.
- \`frontend/src/components/proposals/ProposalDocumentsManagementModal.tsx\` — Category dropdown with three options (General default / Business / Employee); sends \`category\` in the save payload; hydrates on edit.
- \`frontend/src/components/proposal-editor/ProposalEditor.tsx\` — removes the in-editor "Business proposal" checkbox (category now lives in the settings modal); AutoFillType picker filtered by category; disallowed pre-placed fields show a \`⚠ Won't populate\` badge.
- \`frontend/src/hooks/groups/useGroupEmployeeDocs.ts\` — NEW. React Query hook + download URL helper.
- \`frontend/src/pages/groups/GroupMembersTab.tsx\` — green MUI \`color="success"\` button between "Send Message" and "Add Member". 0 results → disabled + tooltip; 1 result → single button opens the URL in a new tab; N results → dropdown menu. Works for Agent / GroupAdmin / TenantAdmin / SysAdmin (same component is reused by all four).

**Tests**
- Unit tests for every new backend service + middleware + route (Jest).
- Unit test for the hook (Vitest).
- Cypress smoke test for the list + click flow.
EOF
)"
```
Return the PR URL.

---

## Self-Review

- Spec coverage: every section of `docs/superpowers/specs/2026-04-22-employee-facing-docs-design.md` maps to at least one task. ✅
- Placeholder scan: no TBD/TODO/"implement later". Steps that defer to grep (Task 9 Step 5, Task 11 Step 1) do so to adapt to the exact existing file structure — this is unavoidable for "find the right line to insert", not a placeholder.
- Type consistency: autofill identifiers are spelled consistently (`GroupContributionEE`, `EmployeeCostEE`, etc.) across frontend constants, backend resolver, and the TS union.
- File name consistency: `groups.employee-docs.js` used everywhere for the router; `employeeFacingDoc.service.js` for the service.

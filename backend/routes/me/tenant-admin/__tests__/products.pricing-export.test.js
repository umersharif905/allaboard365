/**
 * Tests for GET /api/me/tenant-admin/my-products/:productId/pricing-export
 *
 * Strategy:
 *   - Mock getPool with a scripted fake that routes SQL by keyword
 *   - Mock auth/requireTenantAccess middleware to skip DB-backed checks
 *   - Let pricingExport.service run end-to-end against the fake pool
 *   - Use a custom binary supertest parser so res.body is a real Buffer for XLSX inspection
 */

const request = require('supertest');
const express = require('express');
const XLSX = require('xlsx');

// ── Fixture IDs ──────────────────────────────────────────────────────────────
const TENANT_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PRODUCT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const BUNDLE_ID  = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const COMP_A_ID  = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const COMP_B_ID  = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const OTHER_ID   = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

// ── Binary parser — required because supertest doesn't auto-parse XLSX ────────
const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

// ── Fake pricing row builder ──────────────────────────────────────────────────
function makePricingRow({
  tierType = 'EE',
  minAge = 18,
  maxAge = 64,
  tobaccoStatus = 'Non-Tobacco',
  msrp = 115
} = {}) {
  return {
    TierLabel:    'Standard',
    TierType:     tierType,
    MinAge:       minAge,
    MaxAge:       maxAge,
    TobaccoStatus: tobaccoStatus,
    VendorRate:   100,
    OverrideRate: 10,
    Commission:   5,
    IncludedFee:  2,
    MSRPRate:     msrp
  };
}

// ── Scripted SQL router ───────────────────────────────────────────────────────
function scriptedQuery(sqlText, params) {
  // Access check: oe.Products WHERE ProductOwnerId = tenant
  if (/FROM oe\.Products/i.test(sqlText) && /ProductOwnerId/i.test(sqlText)) {
    const pid = params.ProductId;
    const tid = params.TenantId;
    if (pid === PRODUCT_ID && tid === TENANT_ID) {
      return { recordset: [{ ProductId: PRODUCT_ID, Name: 'Test Product', IsBundle: false }] };
    }
    if (pid === BUNDLE_ID && tid === TENANT_ID) {
      return { recordset: [{ ProductId: BUNDLE_ID, Name: 'Test Bundle', IsBundle: true }] };
    }
    return { recordset: [] };
  }

  // ProductBundles — component list
  if (/FROM oe\.ProductBundles/i.test(sqlText)) {
    if (params.BundleProductId === BUNDLE_ID) {
      return {
        recordset: [
          { IncludedProductId: COMP_A_ID, SortOrder: 1, IsRequired: true,  HidePricing: false, ProductName: 'Component A' },
          { IncludedProductId: COMP_B_ID, SortOrder: 2, IsRequired: false, HidePricing: true,  ProductName: 'Component B' }
        ]
      };
    }
    return { recordset: [] };
  }

  // ProductPricing — active tiers
  if (/FROM oe\.ProductPricing/i.test(sqlText)) {
    const pid = params.ProductId;
    if ([PRODUCT_ID, COMP_A_ID, COMP_B_ID].includes(pid)) {
      return {
        recordset: [
          makePricingRow({ tierType: 'EE', minAge: 18, maxAge: 64 }),
          makePricingRow({ tierType: 'ES', minAge: 18, maxAge: 64 })
        ]
      };
    }
    return { recordset: [] };
  }

  // Default: empty (other queries from unrelated routes in my-products)
  return { recordset: [] };
}

function makeFakePool() {
  return {
    request() {
      const params = {};
      return {
        input(name, _type, value) { params[name] = value; return this; },
        async query(sqlText) { return scriptedQuery(sqlText, params); }
      };
    }
  };
}

// ── Module mocks (Jest hoists these before any requires) ──────────────────────
jest.mock('../../../../config/database', () => ({
  getPool: jest.fn(),
  sql: new Proxy({}, { get: () => 'MOCK_SQL_TYPE' })
}));

jest.mock('../../../../middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  authorize:    () => (_req, _res, next) => next()
}));

jest.mock('../../../../middleware/requireTenantAccess', () => {
  return (req, _res, next) => {
    req.user     = req.user || { UserId: 'user-1', TenantId: TENANT_ID };
    req.tenantId = TENANT_ID;
    next();
  };
});

// Stub heavy deps imported at the top of my-products.js that aren't exercised here
jest.mock('../../../uploads', () => ({
  authenticateProductUrls: jest.fn(async (product) => product)
}));

jest.mock('../../../../constants/uploadLimits', () => ({
  MAX_UPLOAD_FILE_BYTES: 10 * 1024 * 1024
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
const { getPool } = require('../../../../config/database');

let app;

beforeAll(() => {
  getPool.mockResolvedValue(makeFakePool());
  const routes = require('../my-products');
  app = express();
  app.use(express.json());
  app.use('/api/me/tenant-admin/my-products', routes);
});

// Shorthand for a binary-parsed GET request
function getExport(productId, customPool) {
  if (customPool) {
    getPool.mockResolvedValueOnce(customPool);
  }
  return request(app)
    .get(`/api/me/tenant-admin/my-products/${productId}/pricing-export`)
    .parse(binaryParser);
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('GET /api/me/tenant-admin/my-products/:productId/pricing-export', () => {

  describe('single product — success', () => {
    let res;

    beforeAll(async () => {
      res = await getExport(PRODUCT_ID);
    });

    it('returns 200', () => {
      expect(res.status).toBe(200);
    });

    it('sets XLSX Content-Type', () => {
      expect(res.headers['content-type']).toMatch(
        /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/
      );
    });

    it('sets Content-Disposition with .xlsx filename', () => {
      expect(res.headers['content-disposition']).toMatch(/attachment.*\.xlsx/);
    });

    it('response body is a valid XLSX workbook with >= 2 sheets', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      expect(wb.SheetNames.length).toBeGreaterThanOrEqual(2);
    });

    it('contains an Overview sheet', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      expect(wb.SheetNames).toContain('Overview');
    });

    it('contains a sheet named after the product', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      expect(wb.SheetNames.some(n => n.includes('Test Product'))).toBe(true);
    });

    it('pricing sheet includes the standard column headers', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      const sheetName = wb.SheetNames.find(n => n.includes('Test Product'));
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
      const headerRow = rows.find(r => Array.isArray(r) && r.includes('Tier Type'));
      expect(headerRow).toBeDefined();
    });
  });

  // ── No access ────────────────────────────────────────────────────────────────
  describe('product not accessible to tenant', () => {
    it('returns 404 with success:false', async () => {
      const res = await request(app)
        .get(`/api/me/tenant-admin/my-products/${OTHER_ID}/pricing-export`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/not found|access denied/i);
    });
  });

  // ── No tiers ─────────────────────────────────────────────────────────────────
  describe('product with no active pricing tiers', () => {
    it('returns 400 with success:false', async () => {
      const emptyTierPool = {
        request() {
          const params = {};
          return {
            input(name, _type, value) { params[name] = value; return this; },
            async query(sqlText) {
              if (/FROM oe\.Products/i.test(sqlText) && /ProductOwnerId/i.test(sqlText)) {
                return { recordset: [{ ProductId: PRODUCT_ID, Name: 'Empty Product', IsBundle: false }] };
              }
              return { recordset: [] }; // no pricing rows
            }
          };
        }
      };
      getPool.mockResolvedValueOnce(emptyTierPool);

      // Use plain request (no binaryParser) so res.body is parsed as JSON
      const res = await request(app)
        .get(`/api/me/tenant-admin/my-products/${PRODUCT_ID}/pricing-export`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/no active pricing tiers/i);
    });
  });

  // ── Bundle success ────────────────────────────────────────────────────────────
  describe('bundle product — success', () => {
    let res;

    beforeAll(async () => {
      res = await getExport(BUNDLE_ID);
    });

    it('returns 200', () => {
      expect(res.status).toBe(200);
    });

    it('workbook has >= 3 sheets (components + totals + overview)', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      expect(wb.SheetNames.length).toBeGreaterThanOrEqual(3);
    });

    it('contains a sheet for Component A', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      expect(wb.SheetNames.some(n => n.includes('Component A'))).toBe(true);
    });

    it('contains a sheet for Component B', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      expect(wb.SheetNames.some(n => n.includes('Component B'))).toBe(true);
    });

    it('contains a Bundle sheet', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      expect(wb.SheetNames).toContain('Bundle');
    });

    it('Overview is the last sheet', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      expect(wb.SheetNames[wb.SheetNames.length - 1]).toBe('Overview');
    });

    it('Bundle sheet uses per-product columns and Bundle Total (115 + 115 = 230)', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      const bundleSheet = wb.Sheets.Bundle;
      const rows = XLSX.utils.sheet_to_json(bundleSheet, { header: 1, defval: '' });
      const headerRow = rows.find(
        r => Array.isArray(r) && r.includes('Component A') && r.includes('Bundle Total')
      );
      expect(headerRow).toBeDefined();
      expect(headerRow).not.toContain('Vendor (Net Rate)');
      const eeRow = rows.find(r => r[0] === 'EE');
      expect(eeRow).toBeDefined();
      expect(eeRow[1]).toBe(115); // Component A MSRP
      expect(eeRow[2]).toBe(115); // Component B MSRP
      expect(eeRow[3]).toBe(230); // Bundle Total
    });

    it('Component B sheet has a HidePricing note in the first row', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      const sheetName = wb.SheetNames.find(n => n.includes('Component B'));
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
      expect(rows[0][0]).toMatch(/Note|linked/i);
    });
  });

  // ── TenantId isolation ────────────────────────────────────────────────────────
  describe('TenantId isolation', () => {
    it('passes TenantId to the product access-check query', async () => {
      const seenParams = [];
      const trackingPool = {
        request() {
          const params = {};
          return {
            input(name, _type, value) { params[name] = value; return this; },
            async query(sqlText) {
              seenParams.push({ sqlText, params: { ...params } });
              return scriptedQuery(sqlText, params);
            }
          };
        }
      };

      await getExport(PRODUCT_ID, trackingPool);

      const accessCheck = seenParams.find(
        c => /FROM oe\.Products/i.test(c.sqlText) && /ProductOwnerId/i.test(c.sqlText)
      );
      expect(accessCheck).toBeDefined();
      expect(accessCheck.params.TenantId).toBe(TENANT_ID);
    });
  });

  // ── AC: all 5 dollar column headers ──────────────────────────────────────────
  describe('single product — all 5 dollar column headers present', () => {
    let res;
    beforeAll(async () => { res = await getExport(PRODUCT_ID); });

    it('pricing sheet header row contains all 5 dollar column labels', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      const sheetName = wb.SheetNames.find(n => n.includes('Test Product'));
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
      const headerRow = rows.find(r => Array.isArray(r) && r.includes('Tier Type'));
      expect(headerRow).toBeDefined();
      ['Vendor (Net Rate)', 'Override', 'Commission', 'Included Fee', 'MSRP'].forEach(col => {
        expect(headerRow).toContain(col);
      });
    });
  });

  // ── AC: tobacco/age section grouping ─────────────────────────────────────────
  describe('single product — tobacco section separator rows', () => {
    let res;
    beforeAll(async () => { res = await getExport(PRODUCT_ID); });

    it('pricing sheet contains a Non-Tobacco or Tobacco section separator', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      const sheetName = wb.SheetNames.find(n => n.includes('Test Product'));
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
      const hasSectionHeader = rows.some(
        r => Array.isArray(r) && typeof r[0] === 'string' && /Tobacco/i.test(r[0])
      );
      expect(hasSectionHeader).toBe(true);
    });
  });

  // ── AC: currency format ($#,##0.00) on dollar cells ──────────────────────────
  describe('single product — currency format on dollar cells', () => {
    let res;
    beforeAll(async () => { res = await getExport(PRODUCT_ID); });

    it('dollar cells in pricing sheet carry the $#,##0.00 number format', () => {
      const wb = XLSX.read(res.body, { type: 'buffer', cellNF: true });
      const sheetName = wb.SheetNames.find(n => n.includes('Test Product'));
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const firstDataRowIdx = rows.findIndex(
        r => Array.isArray(r) && typeof r[2] === 'number'
      );
      expect(firstDataRowIdx).toBeGreaterThan(0);
      const cellAddr = XLSX.utils.encode_cell({ r: firstDataRowIdx, c: 2 });
      expect(ws[cellAddr].z).toBe('"$"#,##0.00');
    });
  });

  // ── AC: included fee footnote ─────────────────────────────────────────────────
  describe('single product — included fee footnote', () => {
    let res;
    beforeAll(async () => { res = await getExport(PRODUCT_ID); });

    it('pricing sheet includes an Included Fee footnote when IncludedFee > 0', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      const sheetName = wb.SheetNames.find(n => n.includes('Test Product'));
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
      const footnoteRow = rows.find(
        r => Array.isArray(r) && typeof r[0] === 'string' && /Included Fee/i.test(r[0])
      );
      expect(footnoteRow).toBeDefined();
    });
  });

  // ── AC: age band section headers ─────────────────────────────────────────────
  describe('single product — age band section headers', () => {
    it('emits separate age section headers (e.g. Up to 45, Age 46–64) under each tobacco section', async () => {
      const multiAgePool = {
        request() {
          const params = {};
          return {
            input(name, _type, value) { params[name] = value; return this; },
            async query(sqlText) {
              if (/FROM oe\.Products/i.test(sqlText) && /ProductOwnerId/i.test(sqlText)) {
                return { recordset: [{ ProductId: PRODUCT_ID, Name: 'Test Product', IsBundle: false }] };
              }
              if (/FROM oe\.ProductPricing/i.test(sqlText)) {
                return {
                  recordset: [
                    makePricingRow({ tierType: 'EE', minAge: 0, maxAge: 45, tobaccoStatus: 'Non-Tobacco' }),
                    makePricingRow({ tierType: 'EE', minAge: 46, maxAge: 64, tobaccoStatus: 'Non-Tobacco' })
                  ]
                };
              }
              return { recordset: [] };
            }
          };
        }
      };

      const res = await getExport(PRODUCT_ID, multiAgePool);
      const wb = XLSX.read(res.body, { type: 'buffer' });
      const sheetName = wb.SheetNames.find(n => n.includes('Test Product'));
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
      const sectionHeaders = rows
        .filter(r => Array.isArray(r) && typeof r[0] === 'string' && r[0].startsWith('\u2014'))
        .map(r => r[0]);
      expect(sectionHeaders.some(h => /Tobacco.*No/i.test(h))).toBe(true);
      expect(sectionHeaders).toContain('\u2014 Up to 45 \u2014');
      expect(sectionHeaders.some(h => /Age 46/i.test(h) && /64/i.test(h))).toBe(true);
    });
  });

  // ── AC: family tier order EE → ES → EC → EF ─────────────────────────────────
  describe('single product — family tier order EE, ES, EC, EF', () => {
    it('lists Tier Type rows in EE → ES → EC → EF order regardless of DB order', async () => {
      const scrambledPool = {
        request() {
          const params = {};
          return {
            input(name, _type, value) { params[name] = value; return this; },
            async query(sqlText) {
              if (/FROM oe\.Products/i.test(sqlText) && /ProductOwnerId/i.test(sqlText)) {
                return { recordset: [{ ProductId: PRODUCT_ID, Name: 'Test Product', IsBundle: false }] };
              }
              if (/FROM oe\.ProductPricing/i.test(sqlText)) {
                return {
                  recordset: [
                    makePricingRow({ tierType: 'EF' }),
                    makePricingRow({ tierType: 'EC' }),
                    makePricingRow({ tierType: 'ES' }),
                    makePricingRow({ tierType: 'EE' })
                  ]
                };
              }
              return { recordset: [] };
            }
          };
        }
      };

      const res = await getExport(PRODUCT_ID, scrambledPool);
      const wb = XLSX.read(res.body, { type: 'buffer' });
      const sheetName = wb.SheetNames.find(n => n.includes('Test Product'));
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
      const tierTypes = rows
        .filter(r => Array.isArray(r) && ['EE', 'ES', 'EC', 'EF'].includes(r[1]))
        .map(r => r[1]);
      expect(tierTypes).toEqual(['EE', 'ES', 'EC', 'EF']);
    });
  });

  // ── AC: Bundle tab — fallback tier when age/tobacco bands differ ─────────────
  describe('bundle product — fills columns from covering age band', () => {
    it('uses N/A 18–64 tier in a No 18–45 row when that is the only band for the product', async () => {
      const wideBandPool = {
        request() {
          const params = {};
          return {
            input(name, _type, value) { params[name] = value; return this; },
            async query(sqlText) {
              if (/FROM oe\.Products/i.test(sqlText) && /ProductOwnerId/i.test(sqlText)) {
                if (params.ProductId === BUNDLE_ID) {
                  return { recordset: [{ ProductId: BUNDLE_ID, Name: 'Wide Bundle', IsBundle: true }] };
                }
                return { recordset: [] };
              }
              if (/FROM oe\.ProductBundles/i.test(sqlText)) {
                return {
                  recordset: [
                    { IncludedProductId: COMP_A_ID, SortOrder: 1, HidePricing: false, ProductName: 'Wide Product' },
                    { IncludedProductId: COMP_B_ID, SortOrder: 2, HidePricing: false, ProductName: 'Narrow Product' }
                  ]
                };
              }
              if (/FROM oe\.ProductPricing/i.test(sqlText)) {
                if (params.ProductId === COMP_A_ID) {
                  return {
                    recordset: [makePricingRow({
                      tierType: 'EE',
                      tobaccoStatus: 'N/A',
                      minAge: 18,
                      maxAge: 64,
                      msrp: 200
                    })]
                  };
                }
                if (params.ProductId === COMP_B_ID) {
                  return {
                    recordset: [makePricingRow({
                      tierType: 'EE',
                      tobaccoStatus: 'No',
                      minAge: 18,
                      maxAge: 45,
                      msrp: 80
                    })]
                  };
                }
              }
              return { recordset: [] };
            }
          };
        }
      };

      const res = await getExport(BUNDLE_ID, wideBandPool);
      const wb = XLSX.read(res.body, { type: 'buffer' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets.Bundle, { header: 1, defval: '' });
      const noSectionIdx = rows.findIndex(
        r => Array.isArray(r) && typeof r[0] === 'string' && /Tobacco.*No/i.test(r[0])
      );
      expect(noSectionIdx).toBeGreaterThan(-1);
      const age45Idx = rows.findIndex(
        (r, i) => i > noSectionIdx && Array.isArray(r) && /Up to 45|18.*45/i.test(String(r[0]))
      );
      expect(age45Idx).toBeGreaterThan(-1);
      const eeRow = rows.slice(age45Idx).find(r => r[0] === 'EE');
      expect(eeRow).toBeDefined();
      expect(eeRow[1]).toBe(200); // Wide Product (18–64 N/A applies to 18–45 No)
      expect(eeRow[2]).toBe(80);  // Narrow Product exact match
      expect(eeRow[3]).toBe(280);
    });
  });

  describe('bundle product — N/A section uses No tiers and overlapping age bands', () => {
    it('fills Essential in Tobacco N/A Age 18–64 from No 18–45 and 46–64 tiers', async () => {
      const naSectionPool = {
        request() {
          const params = {};
          return {
            input(name, _type, value) { params[name] = value; return this; },
            async query(sqlText) {
              if (/FROM oe\.Products/i.test(sqlText) && /ProductOwnerId/i.test(sqlText)) {
                if (params.ProductId === BUNDLE_ID) {
                  return { recordset: [{ ProductId: BUNDLE_ID, Name: 'Mix Bundle', IsBundle: true }] };
                }
                return { recordset: [] };
              }
              if (/FROM oe\.ProductBundles/i.test(sqlText)) {
                return {
                  recordset: [
                    { IncludedProductId: COMP_A_ID, SortOrder: 1, HidePricing: false, ProductName: 'Wide NA' },
                    { IncludedProductId: COMP_B_ID, SortOrder: 2, HidePricing: false, ProductName: 'Split No' }
                  ]
                };
              }
              if (/FROM oe\.ProductPricing/i.test(sqlText)) {
                if (params.ProductId === COMP_A_ID) {
                  return {
                    recordset: [makePricingRow({
                      tierType: 'EE',
                      tobaccoStatus: 'N/A',
                      minAge: 18,
                      maxAge: 64,
                      msrp: 230
                    })]
                  };
                }
                if (params.ProductId === COMP_B_ID) {
                  return {
                    recordset: [
                      makePricingRow({ tierType: 'EE', tobaccoStatus: 'No', minAge: 18, maxAge: 45, msrp: 130 }),
                      makePricingRow({ tierType: 'EE', tobaccoStatus: 'No', minAge: 46, maxAge: 64, msrp: 215 })
                    ]
                  };
                }
              }
              return { recordset: [] };
            }
          };
        }
      };

      const res = await getExport(BUNDLE_ID, naSectionPool);
      const rows = XLSX.utils.sheet_to_json(
        XLSX.read(res.body, { type: 'buffer' }).Sheets.Bundle,
        { header: 1, defval: '' }
      );
      const naIdx = rows.findIndex(
        r => Array.isArray(r) && /Tobacco.*N\/A/i.test(String(r[0]))
      );
      const age64Idx = rows.findIndex(
        (r, i) => i > naIdx && Array.isArray(r) && /18.*64/i.test(String(r[0]))
      );
      const eeRow = rows.slice(age64Idx).find(r => r[0] === 'EE');
      expect(eeRow[1]).toBe(230);
      expect(eeRow[2]).toBe(215); // max of overlapping No 18–45 / 46–64
      expect(eeRow[3]).toBe(445);
    });
  });

  // ── AC: Bundle tab — per-product totals ─────────────────────────────────────
  describe('bundle product — Bundle tab per-product columns', () => {
    let res;
    beforeAll(async () => { res = await getExport(BUNDLE_ID); });

    it('Bundle EE row lists each component MSRP and summed Bundle Total', () => {
      const wb = XLSX.read(res.body, { type: 'buffer' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets.Bundle, { header: 1, defval: '' });
      const eeRow = rows.find(r => r[0] === 'EE');
      expect(eeRow).toBeDefined();
      expect(eeRow[1]).toBe(115);
      expect(eeRow[2]).toBe(115);
      expect(eeRow[3]).toBe(230);
    });
  });
});

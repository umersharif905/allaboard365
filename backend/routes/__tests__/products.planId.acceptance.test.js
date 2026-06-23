/**
 * Acceptance tests — AC1: Plan ID on Products
 *
 * Criteria covered:
 *   AC1a — GET /api/products list returns PlanId per product (pass-through from DB)
 *   AC1b — GET /api/products/:id returns PlanId when set, null when absent
 *   AC1c — POST /api/products sends PlanId as a SQL parameter in the INSERT
 *   AC1d — PUT /api/products/:id sends PlanId as a SQL parameter in the UPDATE
 *
 * AC2 (export Plan ID column) is tested via vendorExportService.locationAndPlanId.test.js.
 */

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
    console.log.mockRestore?.();
    console.error.mockRestore?.();
    console.warn.mockRestore?.();
});

// ---- Multer passthrough (products route inlines its own multer setup) ----
jest.mock('multer', () => {
    const m = () => ({
        fields: () => (req, res, next) => next(),
        single: () => (req, res, next) => next(),
        array: () => (req, res, next) => next(),
    });
    m.memoryStorage = () => ({});
    return m;
});

// ---- Azure Blob (used only at module init) ----
jest.mock('@azure/storage-blob', () => ({
    BlobServiceClient: { fromConnectionString: jest.fn(() => null) },
}));

// ---- Auth ----
const USER_ID   = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const TENANT_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';
const VENDOR_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

jest.mock('../../middleware/auth', () => ({
    authenticate: (req, _res, next) => {
        req.user = { UserId: USER_ID, TenantId: TENANT_ID, userType: 'SysAdmin', roles: ['SysAdmin'] };
        next();
    },
    authorize: () => (_req, _res, next) => next(),
    requireTenantAccess: () => (_req, _res, next) => next(),
    getUserRoles: jest.fn(() => ['SysAdmin']),
}));

// ---- Uploads ----
jest.mock('../uploads', () => ({
    authenticateProductUrls: jest.fn(async (p) => p),
    processNestedImageUrls: jest.fn(async (d) => d),
    authenticateProductDocumentsArray: jest.fn(async (a) => a),
}));

// ---- extractionQueue ----
jest.mock('../../services/extractionQueue', () => ({
    enqueueExtraction: jest.fn().mockResolvedValue(undefined),
}));

// ---- productVendorGroupId util ----
jest.mock('../../utils/productVendorGroupId', () => ({
    resolveShowGroupIdOnIDCardBit: jest.fn(() => 0),
}));

// ---- productMsrpBandSave util ----
jest.mock('../../utils/productMsrpBandSave', () => ({
    resolveMsrpAndIncludedFromWizardBand: jest.fn(() => ({ msrp: null, includedProcessingFee: false })),
}));

// ---- includedProcessingFee util ----
jest.mock('../../utils/includedProcessingFee', () => ({}));

// ---- DB + transaction mocks ----
// We track every `.input(name, type, value)` call on any transaction request
// so we can assert PlanId was sent with the right value.
const capturedInputs = [];

const makeMockRequest = () => {
    const req = {
        input: jest.fn().mockImplementation(function (name, _type, value) {
            capturedInputs.push({ name, value });
            return this;
        }),
        query: jest.fn().mockResolvedValue({ recordset: [], rowsAffected: [1] }),
    };
    return req;
};

const mockTransaction = {
    begin: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    request: jest.fn().mockImplementation(makeMockRequest),
};

// Pool request sequence — overridden per test via mockPoolResponses
let poolResponses = [];
let poolCallIndex = 0;

const mockPoolRequest = jest.fn().mockImplementation(() => {
    const resp = poolResponses[poolCallIndex++] || { recordset: [], rowsAffected: [1] };
    return {
        input: jest.fn().mockReturnThis(),
        query: jest.fn().mockResolvedValue(resp),
    };
});

const mockPool = {
    request: mockPoolRequest,
    transaction: jest.fn(() => mockTransaction),
};

jest.mock('../../config/database', () => ({
    getPool: jest.fn(async () => mockPool),
    sql: {
        NVarChar: jest.fn((n) => (n ? `NVarChar(${n})` : 'NVarChar')),
        UniqueIdentifier: 'UniqueIdentifier',
        Bit: 'Bit',
        Int: 'Int',
        DateTime2: 'DateTime2',
        Date: 'Date',
        Decimal: jest.fn(() => 'Decimal'),
        MAX: 'MAX',
        VarChar: 'VarChar',
    },
}));
jest.mock('mssql', () => ({
    NVarChar: jest.fn((n) => (n ? `NVarChar(${n})` : 'NVarChar')),
    UniqueIdentifier: 'UniqueIdentifier',
    Bit: 'Bit',
    Int: 'Int',
    DateTime2: 'DateTime2',
    Date: 'Date',
    Decimal: jest.fn(() => 'Decimal'),
    MAX: 'MAX',
    VarChar: 'VarChar',
}));

// ---- Load router after all mocks ----
const supertest = require('supertest');
const express  = require('express');
const productsRouter = require('../products');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/products', productsRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    poolCallIndex = 0;
    poolResponses = [];
    capturedInputs.length = 0;
    mockTransaction.begin.mockResolvedValue(undefined);
    mockTransaction.commit.mockResolvedValue(undefined);
    mockTransaction.rollback.mockResolvedValue(undefined);
    mockTransaction.request.mockImplementation(makeMockRequest);
    mockPool.transaction.mockReturnValue(mockTransaction);
});

// ----------------------------------------------------------------
// AC1a — GET /api/products list returns PlanId per product
// ----------------------------------------------------------------
describe('GET /api/products — AC1a: PlanId included in list response', () => {
    test('returns PlanId field for each product', async () => {
        poolResponses = [{
            recordset: [{
                ProductId: PRODUCT_ID,
                VendorId: VENDOR_ID,
                Name: 'Test Plan',
                Status: 'Active',
                PlanId: 'PLAN-ABC',
                ProductOwnerName: 'Acme',
                ProductOwnerId: TENANT_ID,
                VendorName: 'Test Vendor',
            }],
        }];

        const res = await supertest(makeApp()).get('/api/products');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.products[0].PlanId).toBe('PLAN-ABC');
    });

    test('returns null PlanId when product has no plan ID set', async () => {
        poolResponses = [{
            recordset: [{
                ProductId: PRODUCT_ID,
                VendorId: VENDOR_ID,
                Name: 'No Plan',
                Status: 'Active',
                PlanId: null,
                ProductOwnerName: 'Acme',
                ProductOwnerId: TENANT_ID,
            }],
        }];

        const res = await supertest(makeApp()).get('/api/products');

        expect(res.status).toBe(200);
        const product = res.body.products[0];
        expect(Object.prototype.hasOwnProperty.call(product, 'PlanId')).toBe(true);
        expect(product.PlanId).toBeNull();
    });
});

// ----------------------------------------------------------------
// AC1b — GET /api/products/:id returns PlanId
// ----------------------------------------------------------------
describe('GET /api/products/:id — AC1b: PlanId returned in product detail', () => {
    test('returns PlanId when set', async () => {
        // Call 1: product query; Call 2: docs query
        poolResponses = [
            {
                recordset: [{
                    ProductId: PRODUCT_ID,
                    PlanId: 'PLAN-XYZ',
                    Name: 'My Product',
                    ProductOwnerName: 'Acme',
                    ProductOwnerId: TENANT_ID,
                    VendorName: 'Vendor',
                }],
            },
            { recordset: [] }, // ProductDocuments (empty)
        ];

        const res = await supertest(makeApp()).get(`/api/products/${PRODUCT_ID}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.product.PlanId).toBe('PLAN-XYZ');
    });

    test('returns null PlanId when not set on product', async () => {
        poolResponses = [
            {
                recordset: [{
                    ProductId: PRODUCT_ID,
                    PlanId: null,
                    Name: 'No Plan Product',
                    ProductOwnerName: 'Acme',
                    ProductOwnerId: TENANT_ID,
                }],
            },
            { recordset: [] },
        ];

        const res = await supertest(makeApp()).get(`/api/products/${PRODUCT_ID}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.product.PlanId).toBeNull();
    });

    test('404 when product not found', async () => {
        poolResponses = [{ recordset: [] }, { recordset: [] }];

        const res = await supertest(makeApp()).get(`/api/products/${PRODUCT_ID}`);

        expect(res.status).toBe(404);
    });
});

// ----------------------------------------------------------------
// AC1c — POST /api/products passes planId to INSERT SQL
// ----------------------------------------------------------------
describe('POST /api/products — AC1c: planId bound as @PlanId in INSERT', () => {
    const validBody = {
        vendorId: VENDOR_ID,
        productOwnerId: TENANT_ID,
        name: 'New Product',
        productType: 'Medical',
        salesType: 'Both',
        planId: 'PLAN-NEW-001',
    };

    test('passes planId value to SQL input when provided', async () => {
        // Pool requests outside transaction: normalizeEligibilityVendorGroupFallbackProductId check
        poolResponses = [{ recordset: [] }];

        // Transaction request query always resolves (INSERT + any sub-inserts)
        mockTransaction.request.mockImplementation(() => ({
            input: jest.fn().mockImplementation(function (name, _type, value) {
                capturedInputs.push({ name, value });
                return this;
            }),
            query: jest.fn().mockResolvedValue({ recordset: [], rowsAffected: [1] }),
        }));

        await supertest(makeApp())
            .post('/api/products')
            .send(validBody);

        const planIdInput = capturedInputs.find(i => i.name === 'PlanId');
        expect(planIdInput).toBeDefined();
        expect(planIdInput.value).toBe('PLAN-NEW-001');
    });

    test('passes null for PlanId when planId is omitted', async () => {
        poolResponses = [{ recordset: [] }];

        const { planId: _, ...bodyWithoutPlanId } = validBody;

        mockTransaction.request.mockImplementation(() => ({
            input: jest.fn().mockImplementation(function (name, _type, value) {
                capturedInputs.push({ name, value });
                return this;
            }),
            query: jest.fn().mockResolvedValue({ recordset: [], rowsAffected: [1] }),
        }));

        await supertest(makeApp())
            .post('/api/products')
            .send(bodyWithoutPlanId);

        const planIdInput = capturedInputs.find(i => i.name === 'PlanId');
        expect(planIdInput).toBeDefined();
        expect(planIdInput.value).toBeNull();
    });
});

// ----------------------------------------------------------------
// AC1d — PUT /api/products/:id passes planId to UPDATE SQL
// ----------------------------------------------------------------
describe('PUT /api/products/:id — AC1d: planId bound as @PlanId in UPDATE', () => {
    test('passes planId to SQL input when updating a product', async () => {
        // Pool response 1: fetch current product for update; Pool response 2: normalizeEligibility
        poolResponses = [
            {
                recordset: [{
                    ProductId: PRODUCT_ID,
                    VendorId: VENDOR_ID,
                    Name: 'Existing Product',
                    Status: 'Active',
                    PlanId: 'OLD-PLAN',
                    IncludeProcessingFee: false,
                    RoundUpProcessingFee: false,
                    ProcessingFeePercentage: null,
                    ManualIncludedProcessingFee: false,
                }],
            },
            { recordset: [] }, // normalizeEligibility check
        ];

        mockTransaction.request.mockImplementation(() => ({
            input: jest.fn().mockImplementation(function (name, _type, value) {
                capturedInputs.push({ name, value });
                return this;
            }),
            query: jest.fn().mockResolvedValue({ recordset: [], rowsAffected: [1] }),
        }));

        await supertest(makeApp())
            .put(`/api/products/${PRODUCT_ID}`)
            .send({ planId: 'NEW-PLAN-999' });

        const planIdInput = capturedInputs.find(i => i.name === 'PlanId');
        expect(planIdInput).toBeDefined();
        expect(planIdInput.value).toBe('NEW-PLAN-999');
    });

    test('passes null for PlanId when planId is empty string', async () => {
        poolResponses = [
            {
                recordset: [{
                    ProductId: PRODUCT_ID,
                    VendorId: VENDOR_ID,
                    Name: 'Existing Product',
                    Status: 'Active',
                    PlanId: 'OLD-PLAN',
                    IncludeProcessingFee: false,
                    RoundUpProcessingFee: false,
                    ProcessingFeePercentage: null,
                    ManualIncludedProcessingFee: false,
                }],
            },
            { recordset: [] },
        ];

        mockTransaction.request.mockImplementation(() => ({
            input: jest.fn().mockImplementation(function (name, _type, value) {
                capturedInputs.push({ name, value });
                return this;
            }),
            query: jest.fn().mockResolvedValue({ recordset: [], rowsAffected: [1] }),
        }));

        await supertest(makeApp())
            .put(`/api/products/${PRODUCT_ID}`)
            .send({ planId: '   ' }); // whitespace-only → null

        const planIdInput = capturedInputs.find(i => i.name === 'PlanId');
        expect(planIdInput).toBeDefined();
        expect(planIdInput.value).toBeNull();
    });
});

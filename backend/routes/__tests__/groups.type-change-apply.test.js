/**
 * POST /api/groups/:id/type-change/apply
 *
 * Covers:
 *   - 400 when productIds is not an array
 *   - 404 when group is not found
 *   - 400 when no Approved type-change request exists
 *   - Happy path (target=ListBill): hides old products, inserts new,
 *     clears HouseholdMemberIds, cancels future enrollments — returns four counts
 *   - Unhides + reactivates existing product (does not insert)
 *   - Hides all when productIds is empty
 *   - Rolls back on transaction error (returns 500)
 *
 * Bootstrap: matches groups.type-change-preview.test.js pattern.
 *
 * Run: npx jest routes/__tests__/groups.type-change-apply
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

const express = require('express');
const supertest = require('supertest');

// ---------- Database mock ----------
// Pool requests (non-transactional) use mockQuery.
// Transaction requests use mockTxQuery.
// Both are jest.fn() on an object so they survive jest.clearAllMocks().

const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));

const mockTxQuery = jest.fn();
const mockTxInput = jest.fn().mockReturnThis();
const mockTxRequest = jest.fn(() => ({ input: mockTxInput, query: mockTxQuery }));

const mockBegin = jest.fn().mockResolvedValue(undefined);
const mockCommit = jest.fn().mockResolvedValue(undefined);
const mockRollback = jest.fn().mockResolvedValue(undefined);
const mockTransaction = jest.fn(() => ({
  begin: mockBegin,
  commit: mockCommit,
  rollback: mockRollback,
  request: mockTxRequest
}));

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => ({
    request: mockRequest,
    transaction: mockTransaction
  })),
  sql: {
    NVarChar: 'NVarChar',
    UniqueIdentifier: 'UniqueIdentifier',
    DateTime2: 'DateTime2',
    Date: 'Date',
    Decimal: jest.fn(() => 'Decimal'),
    Int: 'Int',
    Bit: 'Bit',
    Float: 'Float',
    VarChar: 'VarChar',
    MAX: 'MAX'
  }
}));

// ---------- Auth middleware mock ----------
jest.mock('../../middleware/auth', () => ({
  authorize: () => (req, res, next) => next(),
  requireTenantAccess: (req, res, next) => {
    req.tenantId = req.user?.TenantId || 'tenant-1';
    next();
  },
  getUserRoles: jest.fn((user) => user?.roles || ['TenantAdmin'])
}));

// ---------- Logger mock ----------
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

// ---------- householdMemberIdService mock ----------
jest.mock('../../services/householdMemberIdService', () => ({
  clearForMembers: jest.fn().mockResolvedValue(0)
}));

// ---------- Other groups.js dependencies ----------
jest.mock('../uploads', () => ({ authenticateUrls: jest.fn() }));
jest.mock('../../services/shared', () => ({ EnrollmentLinkService: jest.fn() }));
jest.mock('../../constants/linkExpiration', () => ({ DEFAULT_LINK_EXPIRATION_HOURS: 72 }));
jest.mock('../../services/PaymentMethodService', () => ({}));
jest.mock('../../services/aiCensusParser.service', () => ({}));
jest.mock('../../services/dimeService', () => ({}));
jest.mock('../../utils/agentGroupAccess', () => ({
  getAccessibleAgentIdsForUser: jest.fn(async () => ['agent-1']),
  buildAgentScopeClause: jest.fn((request, ids, col, prefix) => `${col} IN ('agent-1')`)
}));

// ---------- Optional sub-routers ----------
jest.mock('../groupContributions', () => {
  const r = require('express').Router();
  return r;
}, { virtual: true });
jest.mock('../groupProducts', () => {
  const r = require('express').Router();
  return r;
}, { virtual: true });
jest.mock('../groupMembers', () => {
  const r = require('express').Router();
  return r;
}, { virtual: true });
jest.mock('../groupLocations', () => {
  const r = require('express').Router();
  return r;
}, { virtual: true });
jest.mock('../group-user-management', () => {
  const r = require('express').Router();
  return r;
}, { virtual: true });
jest.mock('../employee-docs', () => {
  const r = require('express').Router();
  return r;
}, { virtual: true });

// ---------- Build app (single instance — avoids resetModules complexity) ----------
function buildApp(userOverrides = {}) {
  const router = require('../groups');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = {
      UserId: 'user-1',
      TenantId: 'tenant-1',
      roles: ['TenantAdmin'],
      currentRole: 'TenantAdmin',
      ...userOverrides
    };
    next();
  });
  app.use('/api/groups', router);
  return app;
}

// ---------- Factories ----------
function makeGroupRow(overrides = {}) {
  return {
    GroupId: 'group-1',
    TenantId: 'tenant-1',
    GroupType: 'Standard',
    AgentId: 'agent-1',
    ...overrides
  };
}

function makeApprovedRequest(overrides = {}) {
  return {
    RequestId: 'req-1',
    RequestedType: 'ListBill',
    ...overrides
  };
}

// ---------- Setup ----------
beforeEach(() => {
  // Restore default mocked implementations
  mockQuery.mockReset();
  mockTxQuery.mockReset();
  mockInput.mockReturnThis();
  mockTxInput.mockReturnThis();
  mockRequest.mockImplementation(() => ({ input: mockInput, query: mockQuery }));
  mockTxRequest.mockImplementation(() => ({ input: mockTxInput, query: mockTxQuery }));
  mockBegin.mockResolvedValue(undefined);
  mockCommit.mockResolvedValue(undefined);
  mockRollback.mockResolvedValue(undefined);
  jest.clearAllMocks();
  // Re-apply return this on inputs after clearAllMocks
  mockInput.mockReturnThis();
  mockTxInput.mockReturnThis();
  mockRequest.mockImplementation(() => ({ input: mockInput, query: mockQuery }));
  mockTxRequest.mockImplementation(() => ({ input: mockTxInput, query: mockTxQuery }));
  mockBegin.mockResolvedValue(undefined);
  mockCommit.mockResolvedValue(undefined);
  mockRollback.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(() => ({
    begin: mockBegin,
    commit: mockCommit,
    rollback: mockRollback,
    request: mockTxRequest
  }));
});

// =============================================================================
// POST /api/groups/:id/type-change/apply
// =============================================================================

describe('POST /api/groups/:id/type-change/apply', () => {

  // ---------- 400: productIds not array ----------

  test('returns 400 when productIds is not an array', async () => {
    // Pool: group access, approved request
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] })
      .mockResolvedValueOnce({ recordset: [makeApprovedRequest()] });

    const app = buildApp();
    const res = await supertest(app)
      .post('/api/groups/group-1/type-change/apply')
      .send({ productIds: 'not-an-array', memberIdsToReEnroll: [] });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/productIds must be an array/i);
  });

  // ---------- 404: group not found ----------

  test('returns 404 when group does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [] }); // group not found

    const app = buildApp();
    const res = await supertest(app)
      .post('/api/groups/missing-group/type-change/apply')
      .send({ productIds: [], memberIdsToReEnroll: [] });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/not found|access denied/i);
  });

  // ---------- 400: no Approved request ----------

  test('returns 400 when no Approved type-change request exists', async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] })
      .mockResolvedValueOnce({ recordset: [] }); // no approved request

    const app = buildApp();
    const res = await supertest(app)
      .post('/api/groups/group-1/type-change/apply')
      .send({ productIds: ['product-1'], memberIdsToReEnroll: [] });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/no approved type change request/i);
  });

  // ---------- Happy path ----------

  test('happy path: hides old, inserts new, clears IDs, cancels enrollments', async () => {
    // Pool queries: group access + approved request
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] })
      .mockResolvedValueOnce({ recordset: [makeApprovedRequest()] });

    // Transaction queries (in order):
    //  1. UPDATE ... NOT IN (hide old) → 2 rows
    //  2. SELECT to check product-1 exists → not found
    //  3. INSERT new GroupProduct → rowsAffected [1]
    //  4. UPDATE clear HouseholdMemberIds → 3 rows
    //  5. SELECT tenant prefixes → empty (single-prefix tenant; swap skipped)
    //  6. UPDATE cancel enrollments → 1 row
    //  7. UPDATE Groups SET GroupType → ok
    //  8. UPDATE GroupTypeChangeRequests SET AppliedAt → ok
    mockTxQuery
      .mockResolvedValueOnce({ rowsAffected: [2] })
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ rowsAffected: [1] })
      .mockResolvedValueOnce({ rowsAffected: [3] })
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ rowsAffected: [1] })
      .mockResolvedValueOnce({ rowsAffected: [1] })
      .mockResolvedValueOnce({ rowsAffected: [1] });

    const app = buildApp();
    const res = await supertest(app)
      .post('/api/groups/group-1/type-change/apply')
      .send({
        productIds: ['product-1'],
        memberIdsToReEnroll: ['member-1', 'member-2', 'member-3']
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const { productsHidden, productsAdded, householdIdsCleared, enrollmentsCancelled } = res.body.data;
    expect(productsHidden).toBe(2);
    expect(productsAdded).toBe(1);
    expect(householdIdsCleared).toBe(3);
    expect(enrollmentsCancelled).toBe(1);
    expect(mockCommit).toHaveBeenCalledTimes(1);
    expect(mockRollback).not.toHaveBeenCalled();
  });

  // ---------- Existing product: update not insert ----------

  test('unhides + reactivates existing product, does not count as added', async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] })
      .mockResolvedValueOnce({ recordset: [makeApprovedRequest()] });

    mockTxQuery
      .mockResolvedValueOnce({ rowsAffected: [1] })                          // hide old
      .mockResolvedValueOnce({ recordset: [{ GroupProductId: 'gp-1' }] })    // product exists
      .mockResolvedValueOnce({ rowsAffected: [1] })                          // update (unhide)
      .mockResolvedValueOnce({ rowsAffected: [0] })                          // clear households (0)
      .mockResolvedValueOnce({ rowsAffected: [0] });                         // cancel enrollments (0)

    const app = buildApp();
    const res = await supertest(app)
      .post('/api/groups/group-1/type-change/apply')
      .send({ productIds: ['existing-product-1'], memberIdsToReEnroll: [] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.productsAdded).toBe(0);
    expect(mockCommit).toHaveBeenCalledTimes(1);
  });

  // ---------- Empty productIds: hide all ----------

  test('hides all existing group products when productIds is empty', async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] })
      .mockResolvedValueOnce({ recordset: [makeApprovedRequest()] });

    // With empty productIds, only the "hide all" UPDATE runs (no per-product loop)
    mockTxQuery
      .mockResolvedValueOnce({ rowsAffected: [5] }); // hide all 5

    const app = buildApp();
    const res = await supertest(app)
      .post('/api/groups/group-1/type-change/apply')
      .send({ productIds: [], memberIdsToReEnroll: [] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.productsHidden).toBe(5);
    expect(res.body.data.productsAdded).toBe(0);
    expect(mockCommit).toHaveBeenCalledTimes(1);
  });

  // ---------- Bug #1 regression: cancel filter must include 'Active' ----------

  test("reEnroll cancel SQL includes 'Active' status (Bug #1 regression)", async () => {
    // Future-dated enrollments are sometimes inserted with Status='Active'
    // (not 'Pending'). Without this status in the IN clause, the wizard's
    // cancel step silently no-ops on those rows and the old enrollment
    // remains active alongside the re-enroll link sent to the member.
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] })
      .mockResolvedValueOnce({ recordset: [makeApprovedRequest()] });

    mockTxQuery
      .mockResolvedValueOnce({ rowsAffected: [1] })   // hide old
      .mockResolvedValueOnce({ recordset: [] })       // exists check (none)
      .mockResolvedValueOnce({ rowsAffected: [1] })   // insert new
      .mockResolvedValueOnce({ rowsAffected: [2] })   // clear households
      .mockResolvedValueOnce({ recordset: [] })       // tenant prefixes (skip swap)
      .mockResolvedValueOnce({ rowsAffected: [2] })   // cancel enrollments
      .mockResolvedValueOnce({ rowsAffected: [1] })   // flip GroupType
      .mockResolvedValueOnce({ rowsAffected: [1] }); // mark request applied

    const app = buildApp();
    const res = await supertest(app)
      .post('/api/groups/group-1/type-change/apply')
      .send({
        productIds: ['product-1'],
        memberIdsToReEnroll: ['member-1', 'member-2']
      });

    expect(res.status).toBe(200);
    expect(res.body.data.enrollmentsCancelled).toBe(2);

    // Find the cancel UPDATE in the captured SQL strings
    const sqlStrings = mockTxQuery.mock.calls.map((c) => c[0] || '');
    const cancelSql = sqlStrings.find(
      (s) => /UPDATE\s+oe\.Enrollments/i.test(s) && /Cancelled/i.test(s)
    );
    expect(cancelSql).toBeDefined();
    expect(cancelSql).toMatch(/Status\s+IN\s*\(\s*'Active'\s*,\s*'Pending'\s*,\s*'Pending Payment'\s*\)/i);
    // EffectiveDate guard must still be present
    expect(cancelSql).toMatch(/EffectiveDate\s*>\s*CAST\s*\(\s*GETUTCDATE\(\)\s+AS\s+DATE\s*\)/i);
  });

  // ---------- ListBill prefix swap: MW → SW for affected households ----------

  test('Standard → ListBill swaps household prefix from MW to SW', async () => {
    // Tenant configures both prefixes (MW = group, SW = individual). The
    // wizard apply step should walk every member in each affected household
    // and rewrite the leading prefix so customer-facing IDs reflect the new
    // group type. Preserve members keep their enrollment AND their suffix —
    // just the prefix swaps.
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] })
      .mockResolvedValueOnce({ recordset: [makeApprovedRequest()] }); // → ListBill

    mockTxQuery
      .mockResolvedValueOnce({ rowsAffected: [0] })                            // hide old
      .mockResolvedValueOnce({ recordset: [] })                                // exists check
      .mockResolvedValueOnce({ rowsAffected: [1] })                            // insert
      .mockResolvedValueOnce({ rowsAffected: [1] })                            // 3c: repoint preserve enrollment
      // Preserve mapping → enrollment-to-MemberId lookup
      .mockResolvedValueOnce({ recordset: [{ MemberId: 'member-1' }] })
      // No re-enroll / let-finish → no clear-households UPDATE happens
      // Tenant prefixes
      .mockResolvedValueOnce({ recordset: [{ MemberIDPrefix: 'MW', IndividualMemberIDPrefix: 'SW' }] })
      // Household members (primary + 1 dependent, both MW)
      .mockResolvedValueOnce({ recordset: [
        { MemberId: 'member-1', HouseholdMemberID: 'MW100' },
        { MemberId: 'dep-1',    HouseholdMemberID: 'MW100-1' }
      ]})
      .mockResolvedValueOnce({ rowsAffected: [1] })   // swap UPDATE for member-1
      .mockResolvedValueOnce({ rowsAffected: [1] })   // swap UPDATE for dep-1
      // No re-enroll → cancel UPDATE skipped
      .mockResolvedValueOnce({ rowsAffected: [1] })   // flip GroupType
      .mockResolvedValueOnce({ rowsAffected: [1] }); // mark request applied

    const app = buildApp();
    const res = await supertest(app)
      .post('/api/groups/group-1/type-change/apply')
      .send({
        productIds: ['product-1'],
        memberIdsToReEnroll: [],
        memberIdsToLetFinish: [],
        preserveMappings: [{ enrollmentId: 'enr-1', newProductId: 'product-1' }]
      });

    expect(res.status).toBe(200);
    expect(res.body.data.prefixUpdates).toBe(2);
    expect(res.body.data.groupType).toBe('ListBill');

    // Confirm a swap UPDATE actually ran with the new SW-prefixed IDs
    const sqlStrings = mockTxQuery.mock.calls.map((c) => c[0] || '');
    const swapSql = sqlStrings.find(
      (s) => /UPDATE\s+oe\.Members/i.test(s) && /HouseholdMemberID\s*=\s*@householdMemberID/i.test(s)
    );
    expect(swapSql).toBeDefined();
    const swapInputs = mockTxInput.mock.calls.filter((c) => c[0] === 'householdMemberID').map((c) => c[2]);
    expect(swapInputs).toEqual(expect.arrayContaining(['SW100', 'SW100-1']));
  });

  // ---------- ListBill prefix swap: no-op when tenant has no individual prefix ----------

  test('skips prefix swap when tenant has no individualMemberIDPrefix configured', async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] })
      .mockResolvedValueOnce({ recordset: [makeApprovedRequest()] });

    mockTxQuery
      .mockResolvedValueOnce({ rowsAffected: [0] })                            // hide old
      .mockResolvedValueOnce({ recordset: [] })                                // exists check
      .mockResolvedValueOnce({ rowsAffected: [1] })                            // insert
      .mockResolvedValueOnce({ rowsAffected: [1] })                            // repoint preserve enrollment
      .mockResolvedValueOnce({ recordset: [{ MemberId: 'member-1' }] })        // preserve → memberId lookup
      // Tenant has only the group prefix, no individual → swap is null,
      // household select is skipped entirely.
      .mockResolvedValueOnce({ recordset: [{ MemberIDPrefix: 'MW', IndividualMemberIDPrefix: null }] })
      .mockResolvedValueOnce({ rowsAffected: [1] })   // flip GroupType
      .mockResolvedValueOnce({ rowsAffected: [1] }); // mark request applied

    const app = buildApp();
    const res = await supertest(app)
      .post('/api/groups/group-1/type-change/apply')
      .send({
        productIds: ['product-1'],
        memberIdsToReEnroll: [],
        memberIdsToLetFinish: [],
        preserveMappings: [{ enrollmentId: 'enr-1', newProductId: 'product-1' }]
      });

    expect(res.status).toBe(200);
    expect(res.body.data.prefixUpdates).toBe(0);
  });

  // ---------- Rolls back on transaction error ----------

  test('rolls back and returns 500 when a transaction query throws', async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] })
      .mockResolvedValueOnce({ recordset: [makeApprovedRequest()] });

    // First tx query throws
    mockTxQuery.mockRejectedValueOnce(new Error('DB failure'));

    const app = buildApp();
    const res = await supertest(app)
      .post('/api/groups/group-1/type-change/apply')
      .send({ productIds: ['product-1'], memberIdsToReEnroll: [] });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/rolled back/i);
    expect(mockRollback).toHaveBeenCalledTimes(1);
    expect(mockCommit).not.toHaveBeenCalled();
  });
});

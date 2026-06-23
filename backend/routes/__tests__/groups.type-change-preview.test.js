/**
 * GET /api/groups/:id/type-change/preview
 *
 * Covers:
 *   - 400 when no Approved type-change request exists for the group
 *   - 404 when group is not found
 *   - 'preserve' action: target=ListBill and a matching Individual/Both product exists
 *   - 'reEnroll' action: no matching product and EffectiveDate is in the future
 *   - 'letFinishThenCancel' action: no matching product, EffectiveDate in past, Status=Active
 *   - Access: Agent who does not own the group is denied
 *
 * Bootstrap pattern: agent-groups.grouptype.test.js
 *
 * Run: npx jest routes/__tests__/groups.type-change-preview
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
const request = require('supertest');

// ---------- Database mock ----------
const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => ({ request: mockRequest })),
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
  getUserRoles: jest.fn((user) => user?.roles || ['Agent'])
}));

// ---------- Logger mock ----------
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
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

// ---------- Build app ----------
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

// ---------- Common date helpers ----------
const FUTURE_DATE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST_DATE = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

// ---------- Mock data factories ----------

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

function makeMemberRow(overrides = {}) {
  return {
    MemberId: 'member-1',
    FirstName: 'Alice',
    LastName: 'Smith',
    EnrollmentId: 'enroll-1',
    ProductId: 'product-1',
    VendorId: 'vendor-1',
    ProductType: 'Medical',
    EffectiveDate: FUTURE_DATE,
    EnrollmentStatus: 'Active',
    ...overrides
  };
}

function makeMatchingProduct(overrides = {}) {
  return {
    ProductId: 'individual-product-1',
    Name: 'Individual Medical Plan',
    SalesType: 'Individual',
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
});

// =============================================================================
// GET /api/groups/:id/type-change/preview
// =============================================================================

describe('GET /api/groups/:id/type-change/preview', () => {

  // ---------- 400: no Approved request ----------

  test('returns 400 when no Approved type-change request exists', async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] }) // group lookup
      .mockResolvedValueOnce({ recordset: [] }); // no Approved request

    const app = buildApp();
    const res = await request(app)
      .get('/api/groups/group-1/type-change/preview')
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/no approved type change request/i);
  });

  // ---------- 404: group not found ----------

  test('returns 404 when group does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [] }); // group not found

    const app = buildApp();
    const res = await request(app)
      .get('/api/groups/missing-group/type-change/preview')
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/not found|access denied/i);
  });

  // ---------- 'reEnroll' action (future EffectiveDate) ----------
  //
  // Bug #2 fix (2026-04-27): the preview endpoint no longer attempts to
  // auto-match existing enrollments to an "Individual" variant of the same
  // product. The strict (VendorId, ProductType) match almost never hit in
  // real tenant data because Individual variants live under a different
  // VendorId AND a different ProductType. Now every enrollment is bucketed
  // purely on EffectiveDate; explicit preserve mappings are passed by the
  // agent on the apply step.

  test("returns action='reEnroll' when EffectiveDate is in the future", async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] })
      .mockResolvedValueOnce({ recordset: [makeApprovedRequest()] })
      .mockResolvedValueOnce({ recordset: [makeMemberRow({ EffectiveDate: FUTURE_DATE })] })
      .mockResolvedValueOnce({ recordset: [] }); // membersWithoutEnrollments

    const app = buildApp();
    const res = await request(app)
      .get('/api/groups/group-1/type-change/preview')
      .expect(200);

    expect(res.body.success).toBe(true);
    const members = res.body.data.members;
    expect(members).toHaveLength(1);
    expect(members[0].action).toBe('reEnroll');
    expect(members[0].enrollments[0].matchingIndividualProduct).toBeNull();
  });

  // ---------- 'letFinishThenCancel' action (past/current EffectiveDate) ----------

  test("returns action='letFinishThenCancel' when EffectiveDate is past, Status=Active", async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] })
      .mockResolvedValueOnce({ recordset: [makeApprovedRequest()] })
      .mockResolvedValueOnce({ recordset: [makeMemberRow({
        EffectiveDate: PAST_DATE,
        EnrollmentStatus: 'Active'
      })] })
      .mockResolvedValueOnce({ recordset: [] }); // membersWithoutEnrollments

    const app = buildApp();
    const res = await request(app)
      .get('/api/groups/group-1/type-change/preview')
      .expect(200);

    expect(res.body.success).toBe(true);
    const members = res.body.data.members;
    expect(members).toHaveLength(1);
    expect(members[0].action).toBe('letFinishThenCancel');
    expect(members[0].enrollments[0].matchingIndividualProduct).toBeNull();
  });

  // ---------- preserve auto-matching is intentionally disabled ----------

  test("never auto-buckets as 'preserve', even with target=ListBill (Bug #2 regression)", async () => {
    // Even though the agent's target is ListBill and the existing enrollment
    // is on a Group product, the preview must NOT issue any vendor/type match
    // SQL and must NOT label the action as 'preserve'. Manual mapping happens
    // at apply time via preserveMappings.
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] })
      .mockResolvedValueOnce({ recordset: [makeApprovedRequest({ RequestedType: 'ListBill' })] })
      .mockResolvedValueOnce({ recordset: [makeMemberRow({ EffectiveDate: FUTURE_DATE })] })
      .mockResolvedValueOnce({ recordset: [] }); // membersWithoutEnrollments

    const app = buildApp();
    const res = await request(app)
      .get('/api/groups/group-1/type-change/preview')
      .expect(200);

    const members = res.body.data.members;
    expect(members[0].action).not.toBe('preserve');
    expect(members[0].enrollments[0].matchingIndividualProduct).toBeNull();

    // Exactly 4 pool queries: group, approved request, members enrollments,
    // members-without-enrollments. NO 5th vendor/type match query.
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });

  // ---------- empty member list ----------

  test('returns empty members array when group has no active/future enrollments', async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] })
      .mockResolvedValueOnce({ recordset: [makeApprovedRequest()] })
      .mockResolvedValueOnce({ recordset: [] })   // no members with enrollments
      .mockResolvedValueOnce({ recordset: [] }); // membersWithoutEnrollments

    const app = buildApp();
    const res = await request(app)
      .get('/api/groups/group-1/type-change/preview')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.members).toHaveLength(0);
  });

  // ---------- multiple members, mixed actions ----------

  test('correctly buckets multiple members on EffectiveDate (future → reEnroll, past → letFinishThenCancel)', async () => {
    const member1 = makeMemberRow({ MemberId: 'm1', FirstName: 'Alice', EffectiveDate: FUTURE_DATE });
    const member2 = makeMemberRow({ MemberId: 'm2', FirstName: 'Bob',   EffectiveDate: FUTURE_DATE });
    const member3 = makeMemberRow({ MemberId: 'm3', FirstName: 'Carol', EffectiveDate: PAST_DATE, EnrollmentStatus: 'Active' });

    mockQuery
      .mockResolvedValueOnce({ recordset: [makeGroupRow()] })
      .mockResolvedValueOnce({ recordset: [makeApprovedRequest()] })
      .mockResolvedValueOnce({ recordset: [member1, member2, member3] })
      .mockResolvedValueOnce({ recordset: [] }); // membersWithoutEnrollments

    const app = buildApp();
    const res = await request(app)
      .get('/api/groups/group-1/type-change/preview')
      .expect(200);

    const members = res.body.data.members;
    expect(members).toHaveLength(3);

    const byMemberId = Object.fromEntries(members.map((m) => [m.memberId, m]));
    expect(byMemberId['m1'].action).toBe('reEnroll');
    expect(byMemberId['m2'].action).toBe('reEnroll');
    expect(byMemberId['m3'].action).toBe('letFinishThenCancel');
    // No auto-preserve any more — agent must explicitly map at apply time.
    for (const m of members) {
      for (const e of m.enrollments) {
        expect(e.matchingIndividualProduct).toBeNull();
      }
    }
  });
});

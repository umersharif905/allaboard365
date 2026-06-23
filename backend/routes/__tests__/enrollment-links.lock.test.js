/**
 * GET /api/enrollment-links/:linkToken/enrollment-data — below-minimum T-5 lock
 *
 * Covers:
 *   - mid-flow enrollee (existing Pending enrollment) passes through
 *   - new enrollee is blocked when group is below minimum inside T-5 window
 *   - ListBill groups are never locked regardless of count
 *   - no lock when currentMembers >= minimum
 *   - no lock when daysRemaining > 5
 *
 * The route delegates the lock check to enrollmentLockService, which is mocked
 * here. This avoids date-manipulation complexity and keeps the route tests
 * focused on the HTTP boundary (response shape, status code, short-circuit).
 *
 * Bootstrap follows enrollment-links.send-verification-code.test.js.
 *
 * Run: npx jest enrollment-links.lock
 */

// Silence route-level console noise.
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

// ---------- enrollmentLockService mock ----------
// Mocking the whole service lets us control lock outcomes without date faking.
const mockIsGroupLockedForNewEnrollment = jest.fn();
jest.mock('../../services/enrollmentLockService', () => ({
  isGroupLockedForNewEnrollment: (...args) => mockIsGroupLockedForNewEnrollment(...args)
}));

// ---------- Downstream service mocks (not exercised by this route) ----------
jest.mock('../../services/email-verification.service', () => ({
  createVerificationCode: jest.fn(),
  verifyCode: jest.fn()
}));

jest.mock('../../services/messageQueue.service', () => ({
  queueEmail: jest.fn(async () => 'queued-message-id'),
  queueMessage: jest.fn(async () => 'queued-sms-id')
}));

jest.mock('../../services/emailTemplates.service', () => ({
  minifyHtml: (html) => html,
  getTenantEmailConfig: jest.fn(),
  loadTemplate: jest.fn(() => ''),
  processTemplate: jest.fn(() => '')
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn(() => '<html>{{verificationCode}}</html>')
  };
});

jest.mock('../../middleware/auth', () => ({
  authorize: () => (req, res, next) => next(),
  getUserRoles: jest.fn(),
  optionalAuth: (req, res, next) => next()
}));

jest.mock('../uploads', () => ({
  authenticateUrls: jest.fn(),
  authenticateProductDocumentsArray: jest.fn()
}));

jest.mock('../../services/shared/product-documents.service', () => ({
  getProductDocumentsForProductIds: jest.fn()
}));

jest.mock('../../services/shared', () => ({
  EnrollmentLinkService: {}
}));

jest.mock('../../services/pricing', () => ({
  PricingEngine: { calculatePricing: jest.fn(), calculateProductPricing: jest.fn() }
}));

jest.mock('../../services/dimeService', () => ({
  processPayment: jest.fn(),
  createBankAccountPaymentMethod: jest.fn(),
  createCreditCardPaymentMethod: jest.fn()
}));

jest.mock('../../services/paymentAttempt.service', () => ({
  createOrGetAttempt: jest.fn(),
  claimForCharge: jest.fn(),
  complete: jest.fn(),
  fail: jest.fn()
}));

jest.mock('../../services/enrollments/enrollmentWriter.service', () => ({}));
jest.mock('../../services/shared/user-roles.service', () => ({}));
jest.mock('../../services/encryptionService', () => ({
  encrypt: jest.fn((v) => `enc:${v}`),
  decrypt: jest.fn((v) => v)
}));

jest.mock('../../utils/includedProcessingFee', () => ({}));
jest.mock('../../utils/productProcessingFees', () => ({}));
jest.mock('../../services/pricing/pricingAuthority.service', () => ({}));
jest.mock('../../utils/memberAgeFromDob', () => ({ getMemberAgeForPricing: jest.fn() }));
jest.mock('../../utils/validateDateOfBirth', () => ({ validateDateOfBirthInput: jest.fn() }));

jest.mock('../../config/shared-modules', () => ({
  requireShared: () => ({
    mapDimePayloadToPaymentRecordStatus: jest.fn(),
    mapChargeWebhookMappedStatusToDbStatus: jest.fn(),
    isSuccessfulPaymentRecordStatus: jest.fn(),
    isDimePendingFlagTrue: jest.fn()
  })
}));

jest.mock('../../constants/enrollmentStatus', () => ({
  ENROLLMENT_STATUS: { ACTIVE: 'Active', PAYMENT_HOLD: 'PaymentHold' }
}));

jest.mock('../../services/enrollmentPaymentHoldService', () => ({}));
jest.mock('../../services/enrollmentLifecycleErrors.service', () => ({
  recordEnrollmentLifecycleError: jest.fn()
}));
jest.mock('../../services/individualEnrollmentRecurringSetup', () => ({
  setupStoredPaymentMethodAndRecurringForIndividualEnrollment: jest.fn()
}));
jest.mock('../../services/integrationErrorService', () => ({
  recordIntegrationError: jest.fn()
}));
jest.mock('../../services/invoiceService', () => ({}));

// posthog-node is not installed in the test environment; mock the config module.
jest.mock('../../config/posthog', () => ({
  capture: jest.fn()
}));

// ---------- Route under test ----------
const enrollmentLinksRoutes = require('../enrollment-links');

// Build a single app instance and reuse it across all tests.
// supertest internally spins up the server per-request but shares the
// same router instance; this avoids port-allocation noise and listener leaks.
const app = express();
app.use(express.json());
app.use('/api/enrollment-links', enrollmentLinksRoutes);

// ============================================================
// Fixture helpers
// ============================================================

function activeGroupLinkRow(overrides = {}) {
  return {
    LinkId: 'link-1',
    LinkType: 'Group',
    GroupId: 'group-uuid-1',
    MemberId: 'member-uuid-1',
    IsActive: true,
    ExpiresAt: null,
    UsageCount: 1,
    MaxUsage: null,
    TenantId: '11111111-1111-1111-1111-111111111111',
    TenantName: 'Test Tenant',
    TenantLogoUrl: '/logo.png',
    MobileAppEnabled: 'false',
    AppStoreUrl: null,
    PlayStoreUrl: null,
    AppImageUrl: null,
    GroupName: 'Test Group',
    GroupLogoUrl: null,
    ShowEmployeePricingOnTiles: 0,
    ShowContributionStrategy: 0,
    AgentId: null,
    AgencyId: null,
    AgentName: null,
    AgentEmail: null,
    AgentPhone: null,
    AgencyName: null,
    EnrollmentLinkTemplateId: 'tmpl-1',
    TemplateName: 'Standard Template',
    TemplateType: 'Group',
    LinkMetaData: null,
    TemplateGroupId: null,
    LinkToken: 'tok_abc',
    Description: null,
    LinkUrl: null,
    ...overrides
  };
}

function activeMemberRow(overrides = {}) {
  return {
    MemberId: 'member-uuid-1',
    UserId: 'user-1',
    GroupId: 'group-uuid-1',
    Status: 'Active',
    FirstName: 'Jane',
    LastName: 'Doe',
    UserEmail: 'jane@example.com',
    PhoneNumber: null,
    DateOfBirth: '1990-01-01',
    Gender: 'F',
    Address: '123 Main St',
    City: 'Springfield',
    State: 'IL',
    Zip: '62701',
    SSN: null,
    MedicalInfo: null,
    EnrollmentType: null,
    RelationshipType: 'Primary',
    TenantId: '11111111-1111-1111-1111-111111111111',
    AgentId: null,
    TobaccoUse: 0,
    Tier: null,
    JobPosition: null,
    Height: null,
    Weight: null,
    CreatedDate: '2025-01-01',
    ModifiedDate: '2025-01-01',
    HouseholdId: null,
    ...overrides
  };
}

beforeEach(() => {
  // Reset ALL mock implementations and queued values, then restore the ones
  // we need. jest.clearAllMocks() only clears call history — it does NOT clear
  // queued mockResolvedValueOnce values. Leftover queued values from a previous
  // test would bleed into the next test's link-lookup query, returning
  // { recordset: [] } instead of the link row → 404 "not found".
  jest.resetAllMocks();

  // Restore implementations cleared by resetAllMocks():
  //   mockRequest: factory that returns { input, query } objects
  mockRequest.mockImplementation(() => ({ input: mockInput, query: mockQuery }));
  //   getPool: returns the pool stub
  const { getPool } = require('../../config/database');
  getPool.mockResolvedValue({ request: mockRequest });
  //   mockInput: must return `this` for chaining
  mockInput.mockReturnThis();
  //   mockQuery: safe default — empty recordset for any unqueued call
  mockQuery.mockResolvedValue({ recordset: [] });
  //   lock service: not locked by default
  mockIsGroupLockedForNewEnrollment.mockResolvedValue({ locked: false });
});

// ============================================================
// Tests
// ============================================================

describe('GET /api/enrollment-links/:linkToken/enrollment-data — below-minimum lock', () => {

  test('allows mid-flow enrollee (existing Pending enrollment) to continue', async () => {
    // Lock service returns locked:false because member has an existing Pending enrollment.
    // The route should proceed normally and return 200 with valid data.
    mockIsGroupLockedForNewEnrollment.mockResolvedValue({ locked: false });

    // Queue specific responses; unqueued calls fall back to the default
    // mockResolvedValue({ recordset: [] }) set in beforeEach.
    mockQuery
      .mockResolvedValueOnce({ recordset: [activeGroupLinkRow()] })  // link lookup
      .mockResolvedValueOnce({ recordset: [activeMemberRow()] });     // member lookup
    // dependents and tenant settings queries get the default empty response.

    const res = await request(app)
      .get('/api/enrollment-links/tok_abc/enrollment-data')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data?.status).toBe('valid');
    expect(res.body.code).toBeUndefined();

    // Verify the lock service was called with the correct groupId and memberId.
    expect(mockIsGroupLockedForNewEnrollment).toHaveBeenCalledWith(
      'group-uuid-1',
      'member-uuid-1'
    );
  });

  test('blocks new enrollee on same group with success:false + GROUP_BELOW_MINIMUM_LOCKED', async () => {
    // Lock service returns locked:true — group is below minimum inside T-5 window.
    mockIsGroupLockedForNewEnrollment.mockResolvedValue({
      locked: true,
      reason: 'GROUP_BELOW_MINIMUM_LOCKED',
      minimum: 5,
      currentCount: 3
    });

    // Only Q1 (link lookup) fires — lock is engaged before member query.
    mockQuery
      .mockResolvedValueOnce({ recordset: [activeGroupLinkRow()] });  // link lookup

    const res = await request(app)
      .get('/api/enrollment-links/tok_abc/enrollment-data')
      .expect(200);

    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('GROUP_BELOW_MINIMUM_LOCKED');
    expect(res.body.message).toMatch(/temporarily paused/i);
    expect(res.body.data).toMatchObject({ minimum: 5, currentCount: 3 });
  });

  test('no lock for ListBill groups regardless of count', async () => {
    // Lock service returns locked:false (ListBill groups bypass the lock).
    mockIsGroupLockedForNewEnrollment.mockResolvedValue({ locked: false });

    mockQuery
      .mockResolvedValueOnce({ recordset: [activeGroupLinkRow()] })  // link lookup
      .mockResolvedValueOnce({ recordset: [activeMemberRow()] });     // member lookup

    const res = await request(app)
      .get('/api/enrollment-links/tok_abc/enrollment-data')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data?.status).toBe('valid');
  });

  test('no lock if currentMembers >= minimum', async () => {
    // Lock service returns locked:false — count is at or above minimum.
    mockIsGroupLockedForNewEnrollment.mockResolvedValue({ locked: false });

    mockQuery
      .mockResolvedValueOnce({ recordset: [activeGroupLinkRow()] })  // link lookup
      .mockResolvedValueOnce({ recordset: [activeMemberRow()] });     // member lookup

    const res = await request(app)
      .get('/api/enrollment-links/tok_abc/enrollment-data')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data?.status).toBe('valid');
  });

  test('no lock when daysRemaining > 5', async () => {
    // Lock service returns locked:false — outside T-5 window.
    mockIsGroupLockedForNewEnrollment.mockResolvedValue({ locked: false });

    mockQuery
      .mockResolvedValueOnce({ recordset: [activeGroupLinkRow()] })  // link lookup
      .mockResolvedValueOnce({ recordset: [activeMemberRow()] });     // member lookup

    const res = await request(app)
      .get('/api/enrollment-links/tok_abc/enrollment-data')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data?.status).toBe('valid');
  });
});

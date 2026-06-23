jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: 'NVarChar',
    Int: 'Int',
    Bit: 'Bit',
    Date: 'Date',
    DateTime2: 'DateTime2'
  }
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, res, next) => { req.user = { UserId: 'test-user' }; next(); },
  authorize: () => (req, res, next) => next(),
  authMiddleware: () => (req, res, next) => { req.user = { UserId: 'test-user' }; next(); }
}));

const express = require('express');
const request = require('supertest');
const { getPool } = require('../../config/database');
const effectiveDatesRouter = require('../effective-dates');

describe('effective-dates route — characterization (current group path)', () => {
  let app;
  let mockRequest;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-15T12:00:00Z'));

    mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn()
    };
    getPool.mockResolvedValue({ request: jest.fn(() => mockRequest) });

    // Default for the household-cohort lookup (added by the household-cohort
    // lock feature): empty recordset → no cohort → falls back to group flag.
    // Tests that need a different cohort can override before calling.
    mockRequest.query.mockResolvedValue({ recordset: [] });

    app = express();
    app.use(express.json());
    app.use('/api/effective-dates', effectiveDatesRouter);
  });

  afterEach(() => jest.useRealTimers());

  it('returns mustBeFirstOfMonth=true for a group member', async () => {
    // Only ONE DB call: member lookup — group member, no initial enrollment period
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        MemberId: 'mem-1',
        GroupId: 'grp-1',
        HireDate: null,
        IsInInitialEnrollmentPeriod: false,
        InitialEnrollmentPeriodEnd: null,
        EnrollmentWaitingPeriod: 0,
        EarliestEffectiveDate: null,
        MinimumHirePeriod: 0
      }]
    });

    // Route is GET / with ?memberId=<id> query param — not a path param
    const res = await request(app)
      .get('/api/effective-dates?memberId=mem-1')
      .expect(200);

    // Response shape: { success, data: { enrollmentType, memberQualified, qualificationMessage, effectiveDateOptions: { ... } } }
    expect(res.body.success).toBe(true);
    expect(res.body.data.enrollmentType).toBe('Group');
    expect(res.body.data.effectiveDateOptions.restrictions.mustBeFirstOfMonth).toBe(true);
    expect(res.body.data.effectiveDateOptions.type).toBe('dropdown');

    const availableDates = res.body.data.effectiveDateOptions.availableDates;
    expect(Array.isArray(availableDates)).toBe(true);
    expect(availableDates.length).toBeGreaterThan(0);

    for (const dateStr of availableDates) {
      const d = new Date(dateStr);
      expect(d.getUTCDate()).toBe(1);
    }
  });

  it('returns only future 1st-of-month dates when simulated date is mid-April 2026', async () => {
    // Date is fixed to 2026-04-15 — so earliest 1st-of-month should be 2026-05-01
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        MemberId: 'mem-1',
        GroupId: 'grp-1',
        HireDate: null,
        IsInInitialEnrollmentPeriod: false,
        InitialEnrollmentPeriodEnd: null,
        EnrollmentWaitingPeriod: 0,
        EarliestEffectiveDate: null,
        MinimumHirePeriod: 0
      }]
    });

    const res = await request(app)
      .get('/api/effective-dates?memberId=mem-1')
      .expect(200);

    const availableDates = res.body.data.effectiveDateOptions.availableDates;
    // 2026-04-01 is already in the past (today is Apr 15), so first available date must be May 1
    expect(availableDates[0]).toBe('2026-05-01');
    // Within 90 days of Apr 15 → Jun 1 and Jul 1 also fall within the window
    expect(availableDates).toContain('2026-06-01');
    expect(availableDates).toContain('2026-07-01');
    // Aug 1 is 107 days out — outside 90-day window
    expect(availableDates).not.toContain('2026-08-01');
  });

  it('returns 404 when member is not found', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app)
      .get('/api/effective-dates?memberId=nonexistent')
      .expect(404);

    expect(res.body.success).toBe(false);
  });

  it('returns mustBeFirstOfMonth=false and type=calendar for an individual member (no GroupId, no selectedProducts)', async () => {
    // Only ONE DB call: member lookup — individual member (GroupId is null)
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        MemberId: 'mem-ind-1',
        GroupId: null,
        HireDate: null,
        IsInInitialEnrollmentPeriod: false,
        InitialEnrollmentPeriodEnd: null,
        EnrollmentWaitingPeriod: 0,
        EarliestEffectiveDate: null,
        MinimumHirePeriod: 0
      }]
    });

    // No selectedProducts query param — individual path skips the product-rules DB call entirely
    const res = await request(app)
      .get('/api/effective-dates?memberId=mem-ind-1')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.enrollmentType).toBe('Individual');

    const opts = res.body.data.effectiveDateOptions;
    // Individual path with no products selected: calendar picker, not first-of-month only
    expect(opts.restrictions.mustBeFirstOfMonth).toBe(false);
    expect(opts.type).toBe('calendar');
    // Calendar mode: no discrete date list, just a range
    expect(opts.availableDates).toBeNull();
    // Earliest is tomorrow (simulated date is 2026-04-15)
    expect(opts.dateRange.earliest).toBe('2026-04-16');
  });

  it('ignores bundle EffectiveDateLogic and uses included products (calendar when components are SameDay)', async () => {
    const bundleId = 'bundle-mw-concierge';
    mockRequest.query
      .mockResolvedValueOnce({
        recordset: [{
          MemberId: 'mem-ind-1',
          GroupId: null,
          HireDate: null,
          IsInInitialEnrollmentPeriod: false,
          InitialEnrollmentPeriodEnd: null,
          EnrollmentWaitingPeriod: 0,
          EarliestEffectiveDate: null,
          MinimumHirePeriod: 0
        }]
      })
      .mockResolvedValueOnce({
        recordset: [
          { ProductId: 'included-1', Name: 'Component A', EffectiveDateLogic: 'SameDay' },
          { ProductId: 'included-2', Name: 'Component B', EffectiveDateLogic: 'SameDay' }
        ]
      });

    const res = await request(app)
      .get(`/api/effective-dates?memberId=mem-ind-1&selectedProducts=${bundleId}`)
      .expect(200);

    expect(res.body.data.enrollmentType).toBe('Individual');
    expect(res.body.data.effectiveDateOptions.type).toBe('calendar');
    expect(res.body.data.effectiveDateOptions.restrictions.mustBeFirstOfMonth).toBe(false);
  });

  it('requires first of month when an included bundle component is FirstOfMonth', async () => {
    const bundleId = 'bundle-mixed';
    mockRequest.query
      .mockResolvedValueOnce({
        recordset: [{
          MemberId: 'mem-ind-1',
          GroupId: null,
          HireDate: null,
          IsInInitialEnrollmentPeriod: false,
          InitialEnrollmentPeriodEnd: null,
          EnrollmentWaitingPeriod: 0,
          EarliestEffectiveDate: null,
          MinimumHirePeriod: 0
        }]
      })
      .mockResolvedValueOnce({
        recordset: [
          { ProductId: 'included-1', Name: 'Flexible Component', EffectiveDateLogic: 'SameDay' },
          { ProductId: 'included-2', Name: 'FOM Component', EffectiveDateLogic: 'FirstOfMonth' }
        ]
      });

    const res = await request(app)
      .get(`/api/effective-dates?memberId=mem-ind-1&selectedProducts=${bundleId}`)
      .expect(200);

    expect(res.body.data.effectiveDateOptions.type).toBe('dropdown');
    expect(res.body.data.effectiveDateOptions.restrictions.mustBeFirstOfMonth).toBe(true);
  });
});

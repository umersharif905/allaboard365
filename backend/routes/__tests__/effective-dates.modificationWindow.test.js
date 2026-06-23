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
  authenticate: (req, res, next) => { req.user = { UserId: 'u' }; next(); },
  authorize: () => (req, res, next) => next(),
  authMiddleware: () => (req, res, next) => { req.user = { UserId: 'u' }; next(); }
}));

const express = require('express');
const request = require('supertest');
const { getPool } = require('../../config/database');
const router = require('../effective-dates');

describe('effective-dates — modification window (pastMonths/futureMonths)', () => {
  let app, mockRequest;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-04T12:00:00Z'));
    mockRequest = { input: jest.fn().mockReturnThis(), query: jest.fn() };
    getPool.mockResolvedValue({ request: () => mockRequest });
    // Default for any lookup that doesn't have its own mock (including the
    // household-cohort query when not under test).
    mockRequest.query.mockResolvedValue({ recordset: [] });
    app = express();
    app.use('/api/effective-dates', router);
  });
  afterEach(() => jest.useRealTimers());

  it('returns 1st-only dates spanning 2 past months to 3 future months when group disallows mid-month', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        MemberId: 'm1', GroupId: 'g1', HireDate: null,
        IsInInitialEnrollmentPeriod: false, InitialEnrollmentPeriodEnd: null,
        EnrollmentWaitingPeriod: 0, EarliestEffectiveDate: null, MinimumHirePeriod: 0,
        AllowMidMonthEffective: false
      }]
    });

    const res = await request(app)
      .get('/api/effective-dates?memberId=m1&pastMonths=2&futureMonths=3')
      .expect(200);

    const opts = res.body.data.effectiveDateOptions;
    expect(opts.type).toBe('dropdown');
    // 6 months: today is May 2026; -2 = March, +3 = August. So 1sts of Mar..Aug.
    expect(opts.availableDates).toEqual([
      '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01'
    ]);
    expect(opts.restrictions.allowedDays).toEqual([1]);
    expect(opts.restrictions.windowMonthsPast).toBe(2);
    expect(opts.restrictions.windowMonthsFuture).toBe(3);
  });

  it('returns 1st AND 15th dates when group allows mid-month and no cohort lock', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        MemberId: 'm1', GroupId: 'g1', HireDate: null,
        IsInInitialEnrollmentPeriod: false, InitialEnrollmentPeriodEnd: null,
        EnrollmentWaitingPeriod: 0, EarliestEffectiveDate: null, MinimumHirePeriod: 0,
        AllowMidMonthEffective: true
      }]
    });
    // Cohort lookup returns no rows → null cohort.
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app)
      .get('/api/effective-dates?memberId=m1&pastMonths=1&futureMonths=1')
      .expect(200);

    const opts = res.body.data.effectiveDateOptions;
    expect(opts.restrictions.allowedDays).toEqual([1, 15]);
    expect(opts.availableDates).toContain('2026-04-01');
    expect(opts.availableDates).toContain('2026-04-15');
    expect(opts.availableDates).toContain('2026-05-15');
    expect(opts.availableDates).toContain('2026-06-15');
  });

  it('returns 15th-only dates when household cohort is FIFTEENTH (regardless of group flag)', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        MemberId: 'm1', GroupId: 'g1', HireDate: null,
        IsInInitialEnrollmentPeriod: false, InitialEnrollmentPeriodEnd: null,
        EnrollmentWaitingPeriod: 0, EarliestEffectiveDate: null, MinimumHirePeriod: 0,
        AllowMidMonthEffective: true
      }]
    });
    // Cohort lookup returns a 15th-cohort effective date.
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ EffectiveDate: '2026-04-15T00:00:00.000Z' }]
    });

    const res = await request(app)
      .get('/api/effective-dates?memberId=m1&pastMonths=2&futureMonths=2')
      .expect(200);

    const opts = res.body.data.effectiveDateOptions;
    expect(opts.restrictions.allowedDays).toEqual([15]);
    expect(opts.restrictions.householdCohort).toBe('FIFTEENTH');
    expect(opts.availableDates.every((d) => d.endsWith('-15'))).toBe(true);
    expect(opts.availableDates).toContain('2026-04-15');
  });

  it('does not enter modification mode without explicit pastMonths+futureMonths', async () => {
    // Sanity: existing default behavior (today + 90 days) still applies when
    // only memberId is provided.
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        MemberId: 'm1', GroupId: 'g1', HireDate: null,
        IsInInitialEnrollmentPeriod: false, InitialEnrollmentPeriodEnd: null,
        EnrollmentWaitingPeriod: 0, EarliestEffectiveDate: null, MinimumHirePeriod: 0,
        AllowMidMonthEffective: false
      }]
    });

    const res = await request(app).get('/api/effective-dates?memberId=m1').expect(200);
    const opts = res.body.data.effectiveDateOptions;
    expect(opts.restrictions.windowMonthsPast).toBeUndefined();
    expect(opts.restrictions.maxDaysInFuture).toBe(90);
  });
});

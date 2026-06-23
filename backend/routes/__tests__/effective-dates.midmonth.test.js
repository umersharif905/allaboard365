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

describe('effective-dates — AllowMidMonthEffective group path', () => {
  let app, mockRequest;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-14T12:00:00Z'));
    mockRequest = { input: jest.fn().mockReturnThis(), query: jest.fn() };
    getPool.mockResolvedValue({ request: () => mockRequest });
    // Default for subsequent queries (e.g. the household-cohort lookup added
    // by the household-cohort lock feature). Empty recordset → no cohort →
    // falls back to group-flag behavior, which is what each test exercises.
    mockRequest.query.mockResolvedValue({ recordset: [] });
    app = express();
    app.use('/api/effective-dates', router);
  });
  afterEach(() => jest.useRealTimers());

  it('returns 1st and 15th dates when group has AllowMidMonthEffective=true', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        MemberId: 'm1', GroupId: 'g1', HireDate: null,
        IsInInitialEnrollmentPeriod: false, InitialEnrollmentPeriodEnd: null,
        EnrollmentWaitingPeriod: 0, EarliestEffectiveDate: null, MinimumHirePeriod: 0,
        AllowMidMonthEffective: true
      }]
    });

    const res = await request(app).get('/api/effective-dates?memberId=m1').expect(200);

    // Note: the spec said res.body.type and res.body.availableDates; the actual
    // response shape (per characterization test) is res.body.data.effectiveDateOptions.{type,availableDates}.
    // Use the actual shape.
    const opts = res.body.data.effectiveDateOptions;
    expect(opts.type).toBe('dropdown');
    const days = opts.availableDates.map(d => new Date(d).getUTCDate()).sort((a, b) => a - b);
    expect(days).toContain(1);
    expect(days).toContain(15);
  });

  it('includes the current month\'s 15th when today is the 1st (and flag is on)', async () => {
    // Regression guard: a "today is on/after the 1st → bump to next month's
    // 1st" shortcut would silently drop the current month's 15th from the
    // dropdown. Pin behavior so the bump only excludes today and earlier.
    jest.setSystemTime(new Date('2026-05-01T12:00:00Z'));
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        MemberId: 'm1', GroupId: 'g1', HireDate: null,
        IsInInitialEnrollmentPeriod: false, InitialEnrollmentPeriodEnd: null,
        EnrollmentWaitingPeriod: 0, EarliestEffectiveDate: null, MinimumHirePeriod: 0,
        AllowMidMonthEffective: true
      }]
    });

    const res = await request(app).get('/api/effective-dates?memberId=m1').expect(200);
    const opts = res.body.data.effectiveDateOptions;
    expect(opts.availableDates).toContain('2026-05-15');
    expect(opts.availableDates).not.toContain('2026-05-01'); // today must not be offered
    expect(opts.availableDates).toContain('2026-06-01');
  });

  it('returns only 1st dates when group has AllowMidMonthEffective=false', async () => {
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
    const days = opts.availableDates.map(d => new Date(d).getUTCDate());
    expect(days.every(d => d === 1)).toBe(true);
  });
});

const CaseStudyService = require('../services/caseStudyService');

jest.mock('../config/database', () => {
  const fakeReq = { input: jest.fn().mockReturnThis(), query: jest.fn() };
  return {
    sql: { UniqueIdentifier: 'uid', NVarChar: () => 'nvarchar', Int: 'int', Decimal: () => 'dec', Date: 'date', MAX: 'max', Bit: 'bit' },
    getPool: jest.fn(async () => ({ request: () => fakeReq })),
    __fakeReq: fakeReq,
  };
});

const db = require('../config/database');

describe('CaseStudyService.remove', () => {
  beforeEach(() => jest.clearAllMocks());

  it('issues a DELETE scoped by CaseStudyId AND VendorId and returns true when a row is removed', async () => {
    db.__fakeReq.query.mockResolvedValue({ rowsAffected: [1] });

    const ok = await CaseStudyService.remove('cs-1', 'vendor-1');

    const sqlText = db.__fakeReq.query.mock.calls[0][0];
    expect(sqlText).toMatch(/DELETE\s+FROM\s+oe\.CaseStudies/i);
    expect(sqlText).toMatch(/CaseStudyId\s*=\s*@id/);
    expect(sqlText).toMatch(/VendorId\s*=\s*@vendorId/);
    expect(db.__fakeReq.input).toHaveBeenCalledWith('id', 'uid', 'cs-1');
    expect(db.__fakeReq.input).toHaveBeenCalledWith('vendorId', 'uid', 'vendor-1');
    expect(ok).toBe(true);
  });

  it('returns false when nothing matched (wrong vendor or missing id)', async () => {
    db.__fakeReq.query.mockResolvedValue({ rowsAffected: [0] });

    const ok = await CaseStudyService.remove('cs-x', 'other-vendor');

    expect(ok).toBe(false);
  });
});

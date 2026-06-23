const CaseStudyService = require('../services/caseStudyService');

jest.mock('../config/database', () => {
  const fakeReq = { input: jest.fn().mockReturnThis(), query: jest.fn() };
  return {
    sql: { UniqueIdentifier: 'uid', NVarChar: () => 'nvarchar', Int: 'int', Decimal: () => 'dec', Date: 'date', MAX: 'max' },
    getPool: jest.fn(async () => ({ request: () => fakeReq })),
    __fakeReq: fakeReq,
  };
});

const db = require('../config/database');

describe('CaseStudyService.listPublished', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries only published rows for the given brand and maps them', async () => {
    db.__fakeReq.query.mockResolvedValue({
      recordset: [{
        CaseStudyId: 'cs-1', Brand: 'MightyWELL', Headline: 'Saved $25k',
        IsPublished: true, SnapshotCellsJson: '[{"label":"A","value":"1"}]',
        HowItHappenedJson: '[]', PercentValue: 86, PercentLabel: 'SAVED',
      }],
    });

    const out = await CaseStudyService.listPublished({ brand: 'MightyWELL' });

    const sqlText = db.__fakeReq.query.mock.calls[0][0];
    expect(sqlText).toMatch(/IsPublished\s*=\s*1/);
    expect(sqlText).toMatch(/Brand\s*=\s*@brand/);
    expect(out).toHaveLength(1);
    expect(out[0].caseStudyId).toBe('cs-1');
    expect(out[0].snapshotCells).toEqual([{ label: 'A', value: '1' }]);
  });

  it('omits the brand filter and stays vendor-agnostic when no brand is given', async () => {
    db.__fakeReq.query.mockResolvedValue({ recordset: [] });

    await CaseStudyService.listPublished();

    const sqlText = db.__fakeReq.query.mock.calls[0][0];
    expect(sqlText).toMatch(/IsPublished\s*=\s*1/);
    expect(sqlText).not.toMatch(/Brand\s*=\s*@brand/);
    expect(sqlText).not.toMatch(/VendorId\s*=\s*@vendorId/);
    expect(db.__fakeReq.input).not.toHaveBeenCalledWith('brand', expect.anything(), expect.anything());
  });
});

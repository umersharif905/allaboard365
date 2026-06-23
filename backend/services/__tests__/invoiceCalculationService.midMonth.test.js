jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier', Int: 'Int', Date: 'Date',
    DateTime2: 'DateTime2', Decimal: () => 'Decimal', NVarChar: () => 'NVarChar',
    Bit: 'Bit'
  }
}));

const { getPool } = require('../../config/database');

describe('invoiceCalculationService — cohort period parameters', () => {
  let mockRequest;
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({ recordset: [{ Count: 1 }] })
    };
    mockPool = { request: jest.fn(() => mockRequest) };
    getPool.mockResolvedValue(mockPool);
  });

  it('binds periodStart and periodEnd when explicit cohort period is provided', async () => {
    const svc = require('../invoiceCalculationService');

    if (!svc.calculateLocationPremiums) {
      // Export shape changed — clearly flag rather than silently pass.
      throw new Error('calculateLocationPremiums not exported — adapt test for actual function');
    }

    // mssql-style stub passed as the `sql` argument (matches real signature).
    const sqlStub = {
      UniqueIdentifier: 'UniqueIdentifier',
      Int: 'Int',
      Date: 'Date'
    };

    await svc.calculateLocationPremiums(
      mockPool,
      'group-1',
      {
        periodStart: new Date('2026-04-15T00:00:00Z'),
        periodEnd: new Date('2026-05-14T00:00:00Z')
      },
      sqlStub
    );

    const inputCalls = mockRequest.input.mock.calls.map(([name]) => name);
    expect(inputCalls).toContain('periodStart');
    expect(inputCalls).toContain('periodEnd');

    // And the generated SQL should reference @periodStart / @periodEnd rather
    // than DATEFROMPARTS/EOMONTH when the explicit boundaries are in use.
    // First query is the column-existence check; main query is the last one.
    const queryCalls = mockRequest.query.mock.calls;
    const generatedSql = queryCalls[queryCalls.length - 1][0];
    expect(generatedSql).toContain('@periodStart');
    expect(generatedSql).toContain('@periodEnd');
  });

  it('falls back to calendar year/month when no explicit period is provided', async () => {
    const svc = require('../invoiceCalculationService');

    const sqlStub = {
      UniqueIdentifier: 'UniqueIdentifier',
      Int: 'Int',
      Date: 'Date'
    };

    await svc.calculateLocationPremiums(
      mockPool,
      'group-1',
      { year: 2026, month: 4 },
      sqlStub
    );

    const inputCalls = mockRequest.input.mock.calls.map(([name]) => name);
    expect(inputCalls).toContain('billingYear');
    expect(inputCalls).toContain('billingMonth');
    expect(inputCalls).not.toContain('periodStart');
    expect(inputCalls).not.toContain('periodEnd');

    // First query is the column-existence check; main query is the last one.
    const queryCalls = mockRequest.query.mock.calls;
    const generatedSql = queryCalls[queryCalls.length - 1][0];
    expect(generatedSql).toContain('DATEFROMPARTS(@billingYear, @billingMonth, 1)');
  });
});

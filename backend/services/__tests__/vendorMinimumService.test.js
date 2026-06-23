jest.mock('../../config/database');

const mockPool = { request: jest.fn() };
const mockRequest = { input: jest.fn().mockReturnThis(), query: jest.fn() };
mockPool.request.mockReturnValue(mockRequest);

const db = require('../../config/database');
db.getPool = jest.fn().mockResolvedValue(mockPool);

const { computeApplicableMinimum } = require('../vendorMinimumService');

describe('computeApplicableMinimum', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns null for ListBill group regardless of vendor minimums', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ GroupType: 'ListBill' }]
    });
    const result = await computeApplicableMinimum('group-1');
    expect(result).toBeNull();
  });

  test('returns null when no vendor has a minimum', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ GroupType: 'Standard' }] })
      .mockResolvedValueOnce({ recordset: [{ MinimumEmployeesPerGroup: null }, { MinimumEmployeesPerGroup: null }] });
    const result = await computeApplicableMinimum('group-1');
    expect(result).toBeNull();
  });

  test('returns strictest minimum across vendors', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ GroupType: 'Standard' }] })
      .mockResolvedValueOnce({ recordset: [
        { MinimumEmployeesPerGroup: 3 },
        { MinimumEmployeesPerGroup: 5 },
        { MinimumEmployeesPerGroup: null }
      ]});
    const result = await computeApplicableMinimum('group-1');
    expect(result).toBe(5);
  });

  test('returns null when group not found', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });
    const result = await computeApplicableMinimum('missing');
    expect(result).toBeNull();
  });
});

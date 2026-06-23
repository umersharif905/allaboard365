jest.mock('../../config/database');

const mockRequest = { input: jest.fn().mockReturnThis(), query: jest.fn() };
const mockPool = { request: jest.fn().mockReturnValue(mockRequest) };
const db = require('../../config/database');
db.getPool = jest.fn().mockResolvedValue(mockPool);

const { clearForMembers } = require('../householdMemberIdService');

describe('clearForMembers', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 0 and performs no query when memberIds is empty', async () => {
    const result = await clearForMembers([], 'tenant-1');
    expect(result).toBe(0);
    expect(mockRequest.query).not.toHaveBeenCalled();
  });

  test('nulls HouseholdMemberId for provided members scoped to tenant', async () => {
    mockRequest.query.mockResolvedValueOnce({ rowsAffected: [2] });
    const result = await clearForMembers(['m1', 'm2'], 'tenant-1');
    expect(result).toBe(2);
    expect(mockRequest.input).toHaveBeenCalledWith('TenantId', 'tenant-1');
    const sql = mockRequest.query.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE oe\.Members/i);
    expect(sql).toMatch(/SET HouseholdMemberId = NULL/i);
    expect(sql).toMatch(/WHERE TenantId = @TenantId/i);
  });

  test('rejects cross-tenant if tenantId missing', async () => {
    await expect(clearForMembers(['m1'], null)).rejects.toThrow(/tenantId/i);
  });
});

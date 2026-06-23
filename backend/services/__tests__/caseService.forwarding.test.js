jest.mock('../caseForwardingService', () => ({
  resolveTargetsForCases: jest.fn(),
}));

const mockRequest = { input: jest.fn().mockReturnThis(), query: jest.fn() };
const mockPool = { request: jest.fn(() => mockRequest) };
jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => mockPool),
  sql: { UniqueIdentifier: 'UID', NVarChar: 'NVarChar', Int: 'Int' },
}));

const forwarding = require('../caseForwardingService');
const caseService = require('../caseService');

test('listCases attaches ForwardingTarget to rows', async () => {
  mockRequest.query.mockResolvedValueOnce({
    recordsets: [
      [{ CaseId: 'c1' }, { CaseId: 'c2' }],
      [{ Total: 2 }],
    ],
  });
  forwarding.resolveTargetsForCases.mockResolvedValueOnce({
    c1: { targetId: 't1', label: 'ARM', planVendorId: 'v-arm' },
  });

  const result = await caseService.listCases('vendor1', {});
  expect(result.data[0].ForwardingTarget).toEqual({ targetId: 't1', label: 'ARM', planVendorId: 'v-arm' });
  expect(result.data[1].ForwardingTarget).toBeNull();
});

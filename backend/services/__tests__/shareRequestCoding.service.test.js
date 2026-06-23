// backend/services/__tests__/shareRequestCoding.service.test.js
const mockRequest = {
  input: jest.fn().mockReturnThis(),
  output: jest.fn().mockReturnThis(),
  execute: jest.fn(),
  query: jest.fn(),
};
const mockPool = { request: jest.fn(() => mockRequest) };
jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => mockPool),
  // Each type is a callable AND usable as a value, so both `sql.Date` and
  // `sql.NVarChar(500)` / `sql.Decimal(18,2)` work under the mock.
  sql: new Proxy({}, { get: () => () => 'SQLTYPE' }),
}));

const ShareRequestService = require('../shareRequestService');

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.execute.mockResolvedValue({ output: { requestNumber: 'SR-1' } });
  mockRequest.query.mockResolvedValue({ recordset: [] });
});

describe('createShareRequest column hygiene', () => {
  test('INSERT does not reference retired coding columns', async () => {
    await ShareRequestService.createShareRequest('vendor-1', { requestTypeId: 'type-1' }, 'user-1');
    const insertCall = mockRequest.query.mock.calls.find(c => /INSERT INTO oe\.ShareRequests/i.test(c[0]));
    expect(insertCall).toBeDefined();
    const sqlText = insertCall[0];
    expect(sqlText).toMatch(/\bSubType\b/); // SubType retained (holds real per-request data)
    expect(sqlText).not.toMatch(/\bDiagnosisCode\b/);
    expect(sqlText).not.toMatch(/\bDiagnosisDescription\b/);
    expect(sqlText).not.toMatch(/\bRequestType\b(?!Id)/);
  });
});

describe('updateShareRequest column hygiene', () => {
  test('UPDATE never sets retired coding columns even if passed', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ ShareRequestId: 'sr-1', SubType: 'old', DiagnosisCode: 'A00', DiagnosisDescription: 'd', RequestTypeName: 'X' }] })
      .mockResolvedValue({ recordset: [] });
    await ShareRequestService.updateShareRequest('sr-1', 'vendor-1', {
      subType: 'new', diagnosisCode: 'B11', diagnosisDescription: 'changed', nextSteps: 'go',
    }, 'user-1');
    const updateCall = mockRequest.query.mock.calls.find(c => /UPDATE oe\.ShareRequests\s+SET/i.test(c[0]) && /NextSteps/.test(c[0]));
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toMatch(/\bSubType\b/); // SubType retained
    expect(updateCall[0]).not.toMatch(/\bDiagnosisCode\b/);
    expect(updateCall[0]).not.toMatch(/\bDiagnosisDescription\b/);
  });
});

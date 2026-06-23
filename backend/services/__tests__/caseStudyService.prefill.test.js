// Regression test for the case-study prefill 500 after the 2026-06-10 coding revamp:
// DiagnosisCode/DiagnosisDescription were dropped from oe.ShareRequests (moved to
// oe.ShareRequestDiagnoses), but getPrefill still selected them, so prod threw
// "Invalid column name 'DiagnosisDescription'". The mock below simulates the
// post-migration schema and rejects any query touching the dropped columns.

const queryImpl = jest.fn();
const mockPool = {
  request: jest.fn(() => ({
    input: jest.fn().mockReturnThis(),
    query: queryImpl,
  })),
};
jest.mock('../../config/database', () => {
  const NVarChar = Object.assign(function () { return 'NVarChar'; }, { MAX: 'MAX' });
  const Decimal = function () { return 'Decimal'; };
  return {
    getPool: jest.fn(async () => mockPool),
    sql: { UniqueIdentifier: 'UID', NVarChar, Decimal, Int: 'Int', Date: 'Date', Bit: 'Bit', MAX: 'MAX' },
  };
});
jest.mock('../caseStudyAIService', () => ({ generate: jest.fn(async () => null) }));

const CaseStudyService = require('../caseStudyService');
const caseStudyAIService = require('../caseStudyAIService');

const SR_ID = '11111111-1111-1111-1111-111111111111';
const VENDOR_ID = '22222222-2222-2222-2222-222222222222';

// Simulates the production schema after 2026-06-10-sr-drop-legacy-coding-columns.sql.
function prodLikeQuery(sqlText) {
  if (/FROM\s+oe\.ShareRequests\b/i.test(sqlText)) {
    const dropped = ['DiagnosisDescription', 'DiagnosisCode'].find((c) => sqlText.includes(c));
    if (dropped) {
      return Promise.reject(new Error(`Invalid column name '${dropped}'.`));
    }
    return Promise.resolve({
      recordset: [{
        ShareRequestId: SR_ID,
        RequestName: 'Knee MRI',
        ProcedureName: null,
        Description: null,
        EventNarrative: null,
        DateOfService: '2026-04-01',
        DateOfServiceEnd: null,
        CompletedDate: '2026-05-01',
        TotalBilledAmount: 1000,
        TotalDiscounts: null,
        TotalUAAmount: 100,
        IncidentUAAmount: null,
        TotalShareAmount: 800,
        TotalPaidAmount: 900,
        TotalMemberPayments: null,
        MaternityDeliveryStatus: null,
      }],
    });
  }
  if (/FROM\s+oe\.ShareRequestProcedures\b/i.test(sqlText)) {
    return Promise.resolve({ recordset: [{ CPTCode: '73721', Description: 'MRI lower extremity' }] });
  }
  if (/FROM\s+oe\.ShareRequestDiagnoses\b/i.test(sqlText)) {
    return Promise.resolve({
      recordset: [{ ICD10Code: 'M25.561', Description: 'Pain in right knee', IsPrimary: true }],
    });
  }
  return Promise.reject(new Error(`Unexpected query in test: ${sqlText}`));
}

beforeEach(() => {
  queryImpl.mockReset().mockImplementation(prodLikeQuery);
  caseStudyAIService.generate.mockClear();
});

describe('getPrefill against post-coding-revamp schema', () => {
  test('builds a draft without referencing dropped ShareRequests columns', async () => {
    const draft = await CaseStudyService.getPrefill(SR_ID, VENDOR_ID);
    expect(draft).not.toBeNull();
    expect(draft.shareRequestId).toBe(SR_ID);
    expect(draft.cptCodes).toBe('73721');
  });

  test('sources the diagnosis from oe.ShareRequestDiagnoses', async () => {
    const draft = await CaseStudyService.getPrefill(SR_ID, VENDOR_ID);
    // With no narrative/description on the SR, the deterministic fallback
    // should use the primary diagnosis description from the new table.
    expect(draft.briefDescription).toBe('Pain in right knee');
    expect(caseStudyAIService.generate).toHaveBeenCalledWith(
      expect.objectContaining({ diagnosis: 'Pain in right knee' })
    );
  });
});

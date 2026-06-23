'use strict';

jest.mock('../../config/database', () => {
  const requests = [];
  let requestIdx = 0;
  const makeRequest = () => {
    const req = {
      inputs: {},
      input(name, _type, value) {
        this.inputs[name] = value;
        return this;
      },
      async query(sql) {
        requests.push({ sql, inputs: { ...req.inputs } });
        const idx = requestIdx++;
        return requests._responses?.[idx] ?? { recordset: [] };
      },
    };
    return req;
  };
  return {
    getPool: async () => ({
      request: makeRequest,
      _setResponses(responses) {
        requests._responses = responses;
        requestIdx = 0;
      },
    }),
    sql: { UniqueIdentifier: 'uid', Int: 'int', NVarChar: 'nvarchar', MAX: 'max' },
  };
});

const { getPool } = require('../../config/database');
const vendorImportJobRunService = require('../vendorImportJobRunService');

describe('vendorImportJobRunService.cancelJobRuns', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns not found when job missing', async () => {
    const pool = await getPool();
    pool._setResponses([{ recordset: [] }]);
    const result = await vendorImportJobRunService.cancelJobRuns(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002'
    );
    expect(result).toEqual({ found: false, cancelledRuns: 0 });
  });

  test('fails running runs and clears lock', async () => {
    const pool = await getPool();
    const jobId = '11111111-1111-1111-1111-111111111111';
    const vendorId = '22222222-2222-2222-2222-222222222222';
    const runId = '33333333-3333-3333-3333-333333333333';

    pool._setResponses([
      { recordset: [{ JobId: jobId }] },
      { recordset: [{ RunId: runId }] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [] },
    ]);

    const result = await vendorImportJobRunService.cancelJobRuns(jobId, vendorId, {
      reason: 'Cancelled by user',
    });
    expect(result).toEqual({ found: true, cancelledRuns: 1 });
  });
});

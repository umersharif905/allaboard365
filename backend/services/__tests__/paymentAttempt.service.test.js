/**
 * PaymentAttemptService — idempotency + recovery state machine
 * (Plan Phase 7).
 *
 * Pins the contract that complete-enrollment relies on to prevent double
 * charges across retries and crashes:
 *   - getByIdempotencyKey returns the most-recent attempt (or null)
 *   - claimForCharge atomically flips a row to Status=Charging
 *   - claimForCharge returns `claimed: false` when a terminal state is already set
 *   - createOrGetAttempt inserts a new row, or tolerates unique-key collisions
 *     by returning the existing row (no double-insert)
 *   - updateAttemptByKey sets Status + ProcessorTransactionId + ErrorMessage
 *   - updateAttemptByKey uses COALESCE so null fields don't clobber existing
 *     values
 *
 * Run: npx jest paymentAttempt.service
 */

jest.mock('../../config/database', () => {
  const mssql = require('mssql');
  return {
    sql: mssql,
    getPool: jest.fn()
  };
});

const { getPool } = require('../../config/database');
const PaymentAttemptService = require('../paymentAttempt.service');

function buildFakeRequest(queryImpl) {
  const req = {};
  req.input = jest.fn().mockReturnValue(req);
  req.query = jest.fn(queryImpl);
  return req;
}

function buildFakePool(requestFactory) {
  return {
    request: jest.fn(() => requestFactory())
  };
}

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore?.();
  console.error.mockRestore?.();
  console.warn.mockRestore?.();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PaymentAttemptService.getByIdempotencyKey', () => {
  test('returns the most recent attempt when one exists', async () => {
    const req = buildFakeRequest(async () => ({
      recordset: [{ IdempotencyKey: 'k1', Status: 'Charged' }]
    }));
    getPool.mockResolvedValue(buildFakePool(() => req));

    const row = await PaymentAttemptService.getByIdempotencyKey('k1');

    expect(row).toEqual({ IdempotencyKey: 'k1', Status: 'Charged' });
    expect(req.input).toHaveBeenCalledWith('idempotencyKey', expect.anything(), 'k1');
  });

  test('returns null when no attempt exists', async () => {
    const req = buildFakeRequest(async () => ({ recordset: [] }));
    getPool.mockResolvedValue(buildFakePool(() => req));

    const row = await PaymentAttemptService.getByIdempotencyKey('missing');

    expect(row).toBeNull();
  });

  test('uses the provided transaction instead of the pool when given', async () => {
    const txReq = buildFakeRequest(async () => ({ recordset: [] }));
    const fakeTx = { request: jest.fn(() => txReq) };
    const poolReq = buildFakeRequest(async () => ({ recordset: [] }));
    getPool.mockResolvedValue(buildFakePool(() => poolReq));

    await PaymentAttemptService.getByIdempotencyKey('k1', fakeTx);

    expect(fakeTx.request).toHaveBeenCalled();
    // Pool request must be preserved for call-sites that pass transaction=null
    expect(poolReq.input).not.toHaveBeenCalled();
  });
});

describe('PaymentAttemptService.claimForCharge', () => {
  test('returns { claimed: true, attempt } when UPDATE flips a pending row to Charging', async () => {
    const req = buildFakeRequest(async () => ({
      recordsets: [
        [{ claimed: 1 }],
        [{ IdempotencyKey: 'k-claim', Status: 'Charging' }]
      ]
    }));
    getPool.mockResolvedValue(buildFakePool(() => req));

    const { claimed, attempt } = await PaymentAttemptService.claimForCharge('k-claim');

    expect(claimed).toBe(true);
    expect(attempt).toEqual({ IdempotencyKey: 'k-claim', Status: 'Charging' });
  });

  test('returns { claimed: false } when attempt is already in a terminal state', async () => {
    const req = buildFakeRequest(async () => ({
      recordsets: [
        [{ claimed: 0 }],
        [{ IdempotencyKey: 'k-done', Status: 'Completed' }]
      ]
    }));
    getPool.mockResolvedValue(buildFakePool(() => req));

    const { claimed, attempt } = await PaymentAttemptService.claimForCharge('k-done');

    expect(claimed).toBe(false);
    expect(attempt.Status).toBe('Completed');
  });

  test('returns { claimed: false, attempt: null } when the row does not exist', async () => {
    const req = buildFakeRequest(async () => ({
      recordsets: [[{ claimed: 0 }], []]
    }));
    getPool.mockResolvedValue(buildFakePool(() => req));

    const { claimed, attempt } = await PaymentAttemptService.claimForCharge('k-missing');

    expect(claimed).toBe(false);
    expect(attempt).toBeNull();
  });
});

describe('PaymentAttemptService.createOrGetAttempt', () => {
  test('inserts a new attempt row and returns it', async () => {
    const inserted = {
      IdempotencyKey: 'k-new',
      LinkToken: 'enroll_tok',
      Amount: 123.45,
      Status: 'Processing'
    };
    const req = buildFakeRequest(async () => ({ recordset: [inserted] }));
    getPool.mockResolvedValue(buildFakePool(() => req));

    const row = await PaymentAttemptService.createOrGetAttempt({
      idempotencyKey: 'k-new',
      linkToken: 'enroll_tok',
      tenantId: '00000000-0000-0000-0000-000000000001',
      memberId: '00000000-0000-0000-0000-000000000002',
      householdId: '00000000-0000-0000-0000-000000000003',
      amount: 123.45,
      paymentMethodType: 'Card'
    });

    expect(row).toEqual(inserted);
    expect(req.input).toHaveBeenCalledWith('idempotencyKey', expect.anything(), 'k-new');
    expect(req.input).toHaveBeenCalledWith('amount', expect.anything(), 123.45);
    expect(req.input).toHaveBeenCalledWith('status', expect.anything(), 'Processing');
  });

  test('on unique-key violation (err.number === 2627) returns the existing row', async () => {
    const existing = { IdempotencyKey: 'k-dupe', Status: 'Completed' };
    const insertReq = buildFakeRequest(async () => {
      const err = new Error('Violation of PRIMARY KEY');
      err.number = 2627;
      throw err;
    });
    const selectReq = buildFakeRequest(async () => ({ recordset: [existing] }));
    // First request = the failing INSERT, second = the getByIdempotencyKey fallback
    let call = 0;
    getPool.mockResolvedValue(
      buildFakePool(() => (call++ === 0 ? insertReq : selectReq))
    );

    const row = await PaymentAttemptService.createOrGetAttempt({
      idempotencyKey: 'k-dupe',
      amount: 5
    });

    expect(row).toEqual(existing);
  });

  test('on unique-index violation (err.number === 2601) returns the existing row', async () => {
    const existing = { IdempotencyKey: 'k-dupe-idx' };
    const insertReq = buildFakeRequest(async () => {
      const err = new Error('Cannot insert duplicate key row');
      err.number = 2601;
      throw err;
    });
    const selectReq = buildFakeRequest(async () => ({ recordset: [existing] }));
    let call = 0;
    getPool.mockResolvedValue(
      buildFakePool(() => (call++ === 0 ? insertReq : selectReq))
    );

    const row = await PaymentAttemptService.createOrGetAttempt({
      idempotencyKey: 'k-dupe-idx',
      amount: 5
    });

    expect(row).toEqual(existing);
  });

  test('rethrows any non-unique-violation error', async () => {
    const insertReq = buildFakeRequest(async () => {
      const err = new Error('Something else broke');
      err.number = 999;
      throw err;
    });
    getPool.mockResolvedValue(buildFakePool(() => insertReq));

    await expect(
      PaymentAttemptService.createOrGetAttempt({ idempotencyKey: 'k', amount: 1 })
    ).rejects.toThrow(/Something else broke/);
  });

  test('coerces a string amount to a Number for the SQL binding', async () => {
    const req = buildFakeRequest(async () => ({
      recordset: [{ IdempotencyKey: 'k-coerce' }]
    }));
    getPool.mockResolvedValue(buildFakePool(() => req));

    await PaymentAttemptService.createOrGetAttempt({
      idempotencyKey: 'k-coerce',
      amount: '99.50'
    });

    expect(req.input).toHaveBeenCalledWith('amount', expect.anything(), 99.5);
  });
});

describe('PaymentAttemptService.updateAttemptByKey', () => {
  test('updates Status + ProcessorTransactionId and returns the row', async () => {
    const updated = {
      IdempotencyKey: 'k-upd',
      Status: 'Completed',
      ProcessorTransactionId: 'tx_ok'
    };
    const req = buildFakeRequest(async () => ({ recordset: [updated] }));
    getPool.mockResolvedValue(buildFakePool(() => req));

    const row = await PaymentAttemptService.updateAttemptByKey('k-upd', {
      status: 'Completed',
      processorTransactionId: 'tx_ok',
      processorResponse: JSON.stringify({ ok: true })
    });

    expect(row).toEqual(updated);
    expect(req.input).toHaveBeenCalledWith('status', expect.anything(), 'Completed');
    expect(req.input).toHaveBeenCalledWith(
      'processorTransactionId',
      expect.anything(),
      'tx_ok'
    );
  });

  test('preserves existing fields when patch omits them (COALESCE semantics)', async () => {
    // The service passes nulls when fields are absent; the UPDATE uses COALESCE
    // so existing columns survive. We assert the null bindings.
    const req = buildFakeRequest(async () => ({ recordset: [{ IdempotencyKey: 'k' }] }));
    getPool.mockResolvedValue(buildFakePool(() => req));

    await PaymentAttemptService.updateAttemptByKey('k', { status: 'Failed' });

    expect(req.input).toHaveBeenCalledWith('status', expect.anything(), 'Failed');
    expect(req.input).toHaveBeenCalledWith(
      'processorTransactionId',
      expect.anything(),
      null
    );
    expect(req.input).toHaveBeenCalledWith(
      'processorResponse',
      expect.anything(),
      null
    );
    expect(req.input).toHaveBeenCalledWith('errorMessage', expect.anything(), null);
  });

  test('sets errorMessage on a failed attempt', async () => {
    const req = buildFakeRequest(async () => ({ recordset: [{ IdempotencyKey: 'k-fail' }] }));
    getPool.mockResolvedValue(buildFakePool(() => req));

    await PaymentAttemptService.updateAttemptByKey('k-fail', {
      status: 'Failed',
      errorMessage: 'Do Not Honor'
    });

    expect(req.input).toHaveBeenCalledWith('errorMessage', expect.anything(), 'Do Not Honor');
  });
});

/**
 * enrollmentPaymentHoldService — PaymentHold ↔ Active transition + cleanup
 * (Plan Phase 7).
 *
 * Pins the post-commit state machine:
 *   - cleanupPaymentHoldAfterFailedPayment
 *       - runs inside a transaction
 *       - deletes VendorExportTracking (soft-failing warns, doesn't abort)
 *       - deletes Payments for PaymentHold Enrollments
 *       - deletes the PaymentHold Enrollments themselves
 *       - commits on success, rolls back + records a lifecycle error on failure
 *   - activatePaymentHoldEnrollmentsForMemberInTransaction
 *       - updates all PaymentHold rows for a member to Active
 *       - emits a lifecycle warning when detail.expectRows is set but 0 rows update
 *       - no warning when expectRows is not set
 *
 * Run: npx jest enrollmentPaymentHoldService
 */

jest.mock('../../config/database', () => {
  const mssql = require('mssql');
  return {
    sql: mssql,
    getPool: jest.fn()
  };
});

jest.mock('../enrollmentLifecycleErrors.service', () => ({
  recordEnrollmentLifecycleError: jest.fn().mockResolvedValue()
}));

const { getPool } = require('../../config/database');
const { recordEnrollmentLifecycleError } = require('../enrollmentLifecycleErrors.service');
const {
  cleanupPaymentHoldAfterFailedPayment,
  activatePaymentHoldEnrollmentsForMemberInTransaction
} = require('../enrollmentPaymentHoldService');

function buildRequest(queryImpl = async () => ({ recordset: [], rowsAffected: [0] })) {
  const req = {};
  req.input = jest.fn().mockReturnValue(req);
  req.query = jest.fn(queryImpl);
  return req;
}

function buildTransaction(requestFactory) {
  const begin = jest.fn().mockResolvedValue();
  const commit = jest.fn().mockResolvedValue();
  const rollback = jest.fn().mockResolvedValue();
  const tx = {
    begin,
    commit,
    rollback,
    request: jest.fn(() => requestFactory())
  };
  return tx;
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

describe('cleanupPaymentHoldAfterFailedPayment', () => {
  const memberId = '11111111-1111-1111-1111-111111111111';

  test('deletes VendorExportTracking + Payments + Enrollments, commits, returns rowsDeleted', async () => {
    const requests = [];
    const tx = buildTransaction(() => {
      const req = buildRequest(async () => ({
        recordset: [],
        rowsAffected: [2] // 2 PaymentHold enrollments deleted
      }));
      requests.push(req);
      return req;
    });
    getPool.mockResolvedValue({ transaction: jest.fn(() => tx) });

    const res = await cleanupPaymentHoldAfterFailedPayment(memberId);

    expect(tx.begin).toHaveBeenCalled();
    expect(tx.commit).toHaveBeenCalled();
    expect(tx.rollback).not.toHaveBeenCalled();
    // Service now scopes by HouseholdId (post-2026-04-21 Lenar-Cummins fix) and
    // returns the resolved householdId alongside the row counts. Use toMatchObject
    // so the test pins the public contract without breaking on additive fields.
    expect(res).toMatchObject({ success: true, rowsDeleted: 2 });
    expect(res.householdId).toBeDefined();
    // 3 statements: VendorExportTracking, Payments, Enrollments
    expect(tx.request).toHaveBeenCalledTimes(3);
    expect(recordEnrollmentLifecycleError).not.toHaveBeenCalled();
  });

  test('continues when VendorExportTracking cleanup fails (soft failure)', async () => {
    let call = 0;
    const tx = buildTransaction(() => {
      if (call++ === 0) {
        // First (VendorExportTracking) DELETE throws — must be caught internally
        return buildRequest(async () => {
          throw new Error('VendorExportTracking broke');
        });
      }
      return buildRequest(async () => ({ recordset: [], rowsAffected: [1] }));
    });
    getPool.mockResolvedValue({ transaction: jest.fn(() => tx) });

    const res = await cleanupPaymentHoldAfterFailedPayment(memberId);

    expect(res).toMatchObject({ success: true, rowsDeleted: 1 });
    expect(tx.commit).toHaveBeenCalled();
  });

  test('rolls back and records a lifecycle error when the main cleanup throws', async () => {
    // VendorExportTracking succeeds (swallowed), Payments DELETE throws.
    let call = 0;
    const tx = buildTransaction(() => {
      if (call === 0) {
        call++;
        return buildRequest(async () => ({ recordset: [], rowsAffected: [0] }));
      }
      call++;
      return buildRequest(async () => {
        throw new Error('DB offline');
      });
    });
    getPool.mockResolvedValue({ transaction: jest.fn(() => tx) });

    await expect(cleanupPaymentHoldAfterFailedPayment(memberId)).rejects.toThrow(
      /DB offline/
    );

    expect(tx.rollback).toHaveBeenCalled();
    expect(recordEnrollmentLifecycleError).toHaveBeenCalledTimes(1);
    expect(recordEnrollmentLifecycleError.mock.calls[0][0]).toMatchObject({
      category: 'EnrollmentPaymentHold',
      severity: 'error',
      source: expect.stringContaining('cleanupPaymentHoldAfterFailedPayment')
    });
  });
});

describe('activatePaymentHoldEnrollmentsForMemberInTransaction', () => {
  const memberId = '22222222-2222-2222-2222-222222222222';

  test('returns { updated: N } and does NOT warn when rows are updated', async () => {
    const req = buildRequest(async () => ({ rowsAffected: [3] }));
    const tx = { request: jest.fn(() => req) };

    const res = await activatePaymentHoldEnrollmentsForMemberInTransaction(
      tx,
      memberId,
      { expectRows: true }
    );

    // Activation is now household-scoped and returns householdId alongside the
    // row count — use toMatchObject so additive fields don't break the contract.
    expect(res).toMatchObject({ updated: 3 });
    expect(recordEnrollmentLifecycleError).not.toHaveBeenCalled();
  });

  test('records a warning when expectRows=true but 0 rows update', async () => {
    const req = buildRequest(async () => ({ rowsAffected: [0] }));
    const tx = { request: jest.fn(() => req) };

    const res = await activatePaymentHoldEnrollmentsForMemberInTransaction(
      tx,
      memberId,
      { expectRows: true, tenantId: 't-1' }
    );

    expect(res).toMatchObject({ updated: 0 });
    expect(recordEnrollmentLifecycleError).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'EnrollmentActivation',
        severity: 'warning',
        source: expect.stringContaining(
          'activatePaymentHoldEnrollmentsForMemberInTransaction'
        )
      })
    );
  });

  test('does NOT warn on 0 rows when expectRows is unset (idempotent no-op path)', async () => {
    const req = buildRequest(async () => ({ rowsAffected: [0] }));
    const tx = { request: jest.fn(() => req) };

    const res = await activatePaymentHoldEnrollmentsForMemberInTransaction(
      tx,
      memberId
    );

    expect(res).toMatchObject({ updated: 0 });
    expect(recordEnrollmentLifecycleError).not.toHaveBeenCalled();
  });
});

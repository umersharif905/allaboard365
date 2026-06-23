'use strict';

/**
 * Unit tests for the pure decision logic of the weekly DIME ledger reconcile.
 *
 * These encode the exact lessons from the MightyWELL overstatement investigation:
 *   - `*_CREDIT_PENDING` is NOT settled money (ordering bug in the throwaway probe).
 *   - A CREDIT clawed back by a later RETURN on the same txn nets to $0.
 *   - A rejected-then-retried payment (the "Makala" case) must NOT read as unpaid,
 *     and an unrecorded settled retry must surface as UNDERSTATED, not overstated.
 */

// Stub heavy deps so requiring the service is side-effect free.
jest.mock('axios', () => ({ request: jest.fn() }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
jest.mock('../../config/database', () => ({ getPool: jest.fn(), sql: {} }));
jest.mock('../dimeService', () => ({ getHeaders: jest.fn(), getConfigForTenant: jest.fn() }));
jest.mock('../integrationErrorService', () => ({ recordIntegrationError: jest.fn() }));

const {
  classifyDimeStatus,
  netLedger,
  reconcileByTxn
} = require('../dimeLedgerReconcile.service');

describe('classifyDimeStatus', () => {
  it('treats *_CREDIT_PENDING as pending, not settled credit', () => {
    expect(classifyDimeStatus('ACH_PAYMENT_CREDIT_PENDING')).toBe('pending');
  });

  it('treats a settled credit as credit', () => {
    expect(classifyDimeStatus('ACH_PAYMENT_CREDIT')).toBe('credit');
  });

  it('treats returns / rejects / chargebacks as failed', () => {
    expect(classifyDimeStatus('ACH_PAYMENT_RETURNED')).toBe('failed');
    expect(classifyDimeStatus('ACH_PAYMENT_CREDIT_REJECTED')).toBe('failed');
    expect(classifyDimeStatus('CREDIT_CARD_CHARGEBACK')).toBe('failed');
  });

  it('treats refunds and fees in their own buckets', () => {
    expect(classifyDimeStatus('ACH_PAYMENT_REFUND')).toBe('refund');
    expect(classifyDimeStatus('ACH_RETURN_FEE')).toBe('failed'); // RETURN wins over FEE — a return-fee row still signals a bounce
    expect(classifyDimeStatus('MONTHLY_FEE')).toBe('fee');
  });
});

describe('netLedger', () => {
  it('counts a clean settled credit and keys it by txn number', () => {
    const r = netLedger([{ transaction_number: '1', transaction_status: 'ACH_PAYMENT_CREDIT', amount: 823 }]);
    expect(r.settledCents).toBe(82300);
    expect(r.bouncedCents).toBe(0);
    expect(r.byTxn.get('1')).toEqual({ settledCents: 82300, bouncedCents: 0, pendingCents: 0 });
  });

  it('nets a credit clawed back by a later return on the same txn to bounced', () => {
    const r = netLedger([
      { transaction_number: '7', transaction_status: 'ACH_PAYMENT_CREDIT', amount: 565.13 },
      { transaction_number: '7', transaction_status: 'ACH_PAYMENT_RETURNED', amount: 565.13 }
    ]);
    expect(r.settledCents).toBe(0);
    expect(r.bouncedCents).toBe(56513);
    expect(r.byTxn.get('7').bouncedCents).toBe(56513);
  });

  it('counts a separate later retry that settled (Makala case)', () => {
    // Original attempt rejected; a DIFFERENT txn number later settled.
    const r = netLedger([
      { transaction_number: 'A', transaction_status: 'ACH_PAYMENT_CREDIT_REJECTED', amount: 411.5 },
      { transaction_number: 'B', transaction_status: 'ACH_PAYMENT_CREDIT', amount: 411.5 }
    ]);
    expect(r.settledCents).toBe(41150);
    expect(r.byTxn.get('A').bouncedCents).toBe(41150);
    expect(r.byTxn.get('B').settledCents).toBe(41150);
  });

  it('treats a still-pending credit as pending, not settled', () => {
    const r = netLedger([{ transaction_number: '9', transaction_status: 'ACH_PAYMENT_CREDIT_PENDING', amount: 200 }]);
    expect(r.settledCents).toBe(0);
    expect(r.pendingCents).toBe(20000);
  });
});

describe('reconcileByTxn', () => {
  const tol = 100; // $1

  it('flags overstated when a DB Completed txn bounced in DIME', () => {
    const db = new Map([['263', { amountCents: 82300 }]]);
    const all = new Set(['263']);
    const byTxn = new Map([['263', { settledCents: 0, bouncedCents: 82300, pendingCents: 0 }]]);
    const v = reconcileByTxn(db, all, byTxn, tol);
    expect(v.status).toBe('overstated');
    expect(v.overstatedCents).toBe(82300);
  });

  it('flags understated when DIME settled a txn absent from our books entirely (Darcey #462)', () => {
    const db = new Map();
    const all = new Set(); // txn not in our DB under any status
    const byTxn = new Map([['462', { settledCents: 79900, bouncedCents: 0, pendingCents: 0 }]]);
    const v = reconcileByTxn(db, all, byTxn, tol);
    expect(v.status).toBe('understated');
    expect(v.understatedCents).toBe(79900);
  });

  it('does NOT flag understated for a DIME-settled txn we already have as Refunded (Charles #380)', () => {
    const db = new Map(); // not Completed...
    const all = new Set(['380']); // ...but present in our DB as Refunded
    const byTxn = new Map([['380', { settledCents: 81614, bouncedCents: 0, pendingCents: 0 }]]);
    expect(reconcileByTxn(db, all, byTxn, tol).status).toBe('ok');
  });

  it('is OK when DIME settled txns exactly match our Completed txns (date/method skew irrelevant)', () => {
    // Kelly case: #509 recorded as a Mar-31 Card in our DB, credited May-29 ACH in DIME.
    const db = new Map([
      ['336', { amountCents: 31173 }],
      ['509', { amountCents: 31173 }],
      ['689', { amountCents: 31173 }]
    ]);
    const all = new Set(['336', '509', '689']);
    const byTxn = new Map([
      ['336', { settledCents: 31173, bouncedCents: 0, pendingCents: 0 }],
      ['509', { settledCents: 31173, bouncedCents: 0, pendingCents: 0 }],
      ['689', { settledCents: 31173, bouncedCents: 0, pendingCents: 0 }]
    ]);
    expect(reconcileByTxn(db, all, byTxn, tol).status).toBe('ok');
  });

  it('does NOT flag overstated when DIME simply does not list a Completed txn (incomplete window)', () => {
    const db = new Map([['999', { amountCents: 50000 }]]);
    const all = new Set(['999']);
    const byTxn = new Map(); // txn not present in the fetched ledger window
    expect(reconcileByTxn(db, all, byTxn, tol).status).toBe('ok');
  });

  it('does NOT flag understated for a still-pending DIME credit', () => {
    const db = new Map();
    const all = new Set();
    const byTxn = new Map([['P', { settledCents: 0, bouncedCents: 0, pendingCents: 20000 }]]);
    expect(reconcileByTxn(db, all, byTxn, tol).status).toBe('ok');
  });

  it('reports both directions when one txn bounced and another settled-but-unrecorded (Makala)', () => {
    const db = new Map([['393', { amountCents: 29011 }]]);
    const all = new Set(['393']); // we only know about the bounced original, not the retry
    const byTxn = new Map([
      ['393', { settledCents: 0, bouncedCents: 29011, pendingCents: 0 }],
      ['453', { settledCents: 29011, bouncedCents: 0, pendingCents: 0 }]
    ]);
    const v = reconcileByTxn(db, all, byTxn, tol);
    expect(v.status).toBe('both');
    expect(v.overstatedCents).toBe(29011);
    expect(v.understatedCents).toBe(29011);
  });
});

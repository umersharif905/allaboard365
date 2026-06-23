'use strict';

const {
  netLedgerByTransaction,
  classifyLedgerStatus
} = require('../dimeLedgerAudit');

describe('classifyLedgerStatus', () => {
  it('classifies the real DIME statuses seen in prod', () => {
    expect(classifyLedgerStatus('ACH_PAYMENT_CREDIT')).toBe('credit');
    expect(classifyLedgerStatus('ACH_PAYMENT_CREDIT_REJECTED')).toBe('failed');
    expect(classifyLedgerStatus('ACH_PAYMENT_RETURNED')).toBe('failed');
    expect(classifyLedgerStatus('ACH_PAYMENT_CREDIT_REJECTED_FEE')).toBe('fee');
    expect(classifyLedgerStatus('CC_CREDIT')).toBe('credit');
    expect(classifyLedgerStatus('CC_CREDIT_DECLINE')).toBe('failed');
    expect(classifyLedgerStatus('ACH_PAYMENT_PENDING')).toBe('pending');
    expect(classifyLedgerStatus('CK_DEBIT')).toBe('other');
    expect(classifyLedgerStatus('')).toBe('other');
    expect(classifyLedgerStatus(null)).toBe('other');
  });

  it('fee wins over reject so the $25 fee line never nets the principal', () => {
    // REJECTED_FEE contains both REJECT and FEE — must classify as fee
    expect(classifyLedgerStatus('ACH_PAYMENT_CREDIT_REJECTED_FEE')).toBe('fee');
  });

  it('pending wins over credit: in-flight ACH credit is NOT settled money (Willey #794 false alert)', () => {
    expect(classifyLedgerStatus('ACH_PAYMENT_CREDIT_PENDING')).toBe('pending');
  });
});

describe('netLedgerByTransaction pending handling', () => {
  it('an in-flight ACH credit (CREDIT_PENDING) is neither settled nor clawed back', () => {
    const out = netLedgerByTransaction([
      {
        transaction_number: '794',
        transaction_status: 'ACH_PAYMENT_CREDIT_PENDING',
        amount: '712.9200',
        transaction_date: '2026-06-11T09:00:20Z',
        description: 'Annette Willey (MW15990781)'
      }
    ]);
    expect(out[0].settled).toBe(false);
    expect(out[0].clawedBack).toBe(false);
    expect(out[0].credit).toBe(0);
  });
});

describe('netLedgerByTransaction', () => {
  const line = (num, status, amount, date = '2026-05-24T09:00:00Z', description = '') => ({
    transaction_number: num,
    transaction_status: status,
    amount,
    transaction_date: date,
    description
  });

  it('detects the Willey #498 pattern: settled then returned = clawed back, not settled', () => {
    const out = netLedgerByTransaction([
      line('498', 'ACH_PAYMENT_CREDIT', '712.9200', '2026-05-24T09:00:00Z'),
      line('498', 'ACH_PAYMENT_CREDIT_REJECTED_FEE', '25.0000', '2026-06-01T09:00:00Z'),
      line('498', 'ACH_PAYMENT_RETURNED', '712.9200', '2026-06-01T09:00:00Z')
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].transactionNumber).toBe('498');
    expect(out[0].clawedBack).toBe(true);
    expect(out[0].settled).toBe(false);
  });

  it('a clean settled credit stays settled (Beckner #453 pattern)', () => {
    const out = netLedgerByTransaction([
      line('453', 'ACH_PAYMENT_CREDIT', '290.1100', '2026-05-07T07:00:45Z', 'Makala Beckner')
    ]);
    expect(out[0].settled).toBe(true);
    expect(out[0].clawedBack).toBe(false);
    expect(out[0].credit).toBeCloseTo(290.11);
    expect(out[0].creditDate).toBe('2026-05-07');
    expect(out[0].description).toBe('Makala Beckner');
  });

  it('the $25 reject fee alone does NOT claw back a settled principal', () => {
    const out = netLedgerByTransaction([
      line('999', 'ACH_PAYMENT_CREDIT', '712.92'),
      line('999', 'ACH_PAYMENT_CREDIT_REJECTED_FEE', '25.00')
    ]);
    expect(out[0].settled).toBe(true);
    expect(out[0].clawedBack).toBe(false);
  });

  it('a rejected attempt with no credit is neither settled nor clawed back', () => {
    const out = netLedgerByTransaction([
      line('340', 'ACH_PAYMENT_CREDIT_REJECTED', '712.92'),
      line('340', 'ACH_PAYMENT_RETURNED', '712.92')
    ]);
    expect(out[0].settled).toBe(false);
    expect(out[0].clawedBack).toBe(false);
  });

  it('CC declines with $0 amount are ignored as failures of nothing', () => {
    const out = netLedgerByTransaction([
      line('1828387976', 'CC_CREDIT_DECLINE', '0')
    ]);
    expect(out[0].settled).toBe(false);
    expect(out[0].clawedBack).toBe(false);
  });

  it('groups multiple transactions independently', () => {
    const out = netLedgerByTransaction([
      line('401', 'ACH_PAYMENT_CREDIT', '112.31'),
      line('393', 'ACH_PAYMENT_CREDIT_REJECTED', '290.11'),
      line('393', 'ACH_PAYMENT_RETURNED', '290.11'),
      line('765', 'ACH_PAYMENT_CREDIT', '290.11')
    ]);
    const byNum = Object.fromEntries(out.map((g) => [g.transactionNumber, g]));
    expect(byNum['401'].settled).toBe(true);
    expect(byNum['393'].settled).toBe(false);
    expect(byNum['765'].settled).toBe(true);
  });

  it('nets an un-numbered CK_DEBIT refund check against the earliest matching settled credit (B56D2227 pattern)', () => {
    // Customer double-charged $445 (#451 on 5/6, #469 on 5/12), refunded $445 by check 5/13.
    // The check offsets the EARLIEST credit (#451); #469 stays settled.
    const out = netLedgerByTransaction([
      { transaction_number: '', transaction_status: 'CK_DEBIT', amount: '445.0000', transaction_date: '2026-05-13T12:00:00Z' },
      line('469', 'ACH_PAYMENT_CREDIT', '445.0000', '2026-05-12T09:00:00Z'),
      line('451', 'ACH_PAYMENT_CREDIT', '445.0000', '2026-05-06T09:00:00Z')
    ]);
    const byNum = Object.fromEntries(out.map((g) => [g.transactionNumber, g]));
    expect(byNum['451'].settled).toBe(false);
    expect(byNum['451'].refundedByCheck).toBe(true);
    expect(byNum['469'].settled).toBe(true);
    expect(byNum['469'].refundedByCheck).toBe(false);
  });

  it('a settled credit fully refunded by check is not "settled missing money" (Barry #462 pattern)', () => {
    // Barry paid $799 on 5/9, re-billed $823 twice on 6/2, DIME mailed her a $799 check 6/8.
    const out = netLedgerByTransaction([
      { transaction_number: '', transaction_status: 'CK_DEBIT', amount: '799.0000', transaction_date: '2026-06-08T12:00:00Z' },
      line('707', 'ACH_PAYMENT_CREDIT', '823.0000', '2026-06-02T09:00:00Z'),
      line('706', 'ACH_PAYMENT_CREDIT', '823.0000', '2026-06-02T09:00:00Z'),
      line('462', 'ACH_PAYMENT_CREDIT', '799.0000', '2026-05-09T09:00:00Z')
    ]);
    const byNum = Object.fromEntries(out.map((g) => [g.transactionNumber, g]));
    expect(byNum['462'].settled).toBe(false);
    expect(byNum['462'].refundedByCheck).toBe(true);
    expect(byNum['462'].clawedBack).toBe(false);
    expect(byNum['706'].settled).toBe(true);
    expect(byNum['707'].settled).toBe(true);
  });

  it('a CK_DEBIT with no matching credit amount offsets nothing', () => {
    const out = netLedgerByTransaction([
      { transaction_number: '', transaction_status: 'CK_DEBIT', amount: '100.00', transaction_date: '2026-05-13T12:00:00Z' },
      line('469', 'ACH_PAYMENT_CREDIT', '445.00', '2026-05-12T09:00:00Z')
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].settled).toBe(true);
    expect(out[0].refundedByCheck).toBe(false);
  });

  it('handles empty/missing input', () => {
    expect(netLedgerByTransaction([])).toEqual([]);
    expect(netLedgerByTransaction(null)).toEqual([]);
  });
});

describe('module exports', () => {
  it('exports everything the timer imports', () => {
    const mod = require('../dimeLedgerAudit');
    expect(typeof mod.runLedgerAudit).toBe('function');
    expect(typeof mod.netLedgerByTransaction).toBe('function');
    expect(typeof mod.classifyLedgerStatus).toBe('function');
  });

  it('timer module loads without throwing', () => {
    expect(() => require('../../DimePaymentStatusAuditTimer/index.js')).not.toThrow();
  });
});

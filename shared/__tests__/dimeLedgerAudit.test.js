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

  it('skips lines without a transaction number (CK_DEBIT refund checks)', () => {
    const out = netLedgerByTransaction([
      { transaction_number: '', transaction_status: 'CK_DEBIT', amount: '445.00' },
      line('469', 'ACH_PAYMENT_CREDIT', '445.00')
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].transactionNumber).toBe('469');
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

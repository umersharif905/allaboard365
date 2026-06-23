'use strict';

const { inferDimeEventType } = require('../index');

describe('inferDimeEventType — return/reject routing', () => {
  // Regression: typeless ACH returns/rejects were mislabeled as ach_charge (tt.includes('ach')),
  // so the original Completed payment never flipped to Failed -> overstated invoices.
  test('typeless ACH_PAYMENT_RETURNED routes to ach_payment_return (not ach_charge)', () => {
    expect(inferDimeEventType({ transaction_type: 'ACH', transaction_status: 'ACH_PAYMENT_RETURNED' }))
      .toBe('ach_payment_return');
  });

  test('typeless ACH_PAYMENT_CREDIT_REJECTED routes to ach_payment_return', () => {
    expect(inferDimeEventType({ transaction_type: 'ACH', transaction_status: 'ACH_PAYMENT_CREDIT_REJECTED' }))
      .toBe('ach_payment_return');
  });

  test('the $25 NSF fee line is NOT treated as a return', () => {
    expect(inferDimeEventType({ transaction_type: 'ACH', transaction_status: 'ACH_PAYMENT_CREDIT_REJECTED_FEE' }))
      .toBe('ach_charge');
  });

  test('chargeback routes to credit_card_chargeback', () => {
    expect(inferDimeEventType({ transaction_type: 'CC', transaction_status: 'CC_CHARGEBACK' }))
      .toBe('credit_card_chargeback');
  });

  test('ACH refund routes to ach_refund; CC refund to credit_card_refund', () => {
    expect(inferDimeEventType({ transaction_type: 'ACH', transaction_status: 'ACH_PAYMENT_REFUND' }))
      .toBe('ach_refund');
    expect(inferDimeEventType({ transaction_type: 'CC', transaction_status: 'CC_REFUND' }))
      .toBe('credit_card_refund');
  });

  test('a successful ACH credit still routes to ach_charge', () => {
    expect(inferDimeEventType({ transaction_type: 'ACH', transaction_status: 'ACH_PAYMENT_CREDIT' }))
      .toBe('ach_charge');
  });

  test('explicit type/event_type always wins', () => {
    expect(inferDimeEventType({ type: 'credit_card_charge', transaction_status: 'ACH_PAYMENT_RETURNED' }))
      .toBe('credit_card_charge');
  });

  test('recurring hints still map to recurring_payment_success', () => {
    expect(inferDimeEventType({ recurring_payment_id: 'r1', transaction_type: 'ACH', transaction_status: 'ACH_PAYMENT_CREDIT' }))
      .toBe('recurring_payment_success');
  });
});

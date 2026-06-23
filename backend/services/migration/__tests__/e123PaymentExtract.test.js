'use strict';

const {
  extractPaymentFromTransactionPayment,
  pickBestPaymentForUser,
  hasMaskedPaymentHint,
  computeFetchCoverageStats
} = require('../e123PaymentExtract.service');
const { buildHouseholdsFromE123Pages, pickE123Ssn } = require('../householdNormalizer');

describe('e123PaymentExtract.service', () => {
  test('extracts full credit card from transaction payment', () => {
    const payment = extractPaymentFromTransactionPayment({
      paytype: 'CC',
      ccnum: '4111111111111111',
      cclast4: '1111',
      cctype: 'Visa',
      ccexpm: '12',
      ccexpy: '2028',
      firstname: 'Jane',
      lastname: 'Doe',
      address: '1 Main St',
      city: 'Austin',
      state: 'TX',
      zip: '78701'
    }, 'CC');

    expect(payment?.paymentMethodType).toBe('CreditCard');
    expect(payment?.cardNumber).toBe('4111111111111111');
    expect(payment?.expiryMonth).toBe(12);
    expect(payment?.expiryYear).toBe(2028);
  });

  test('rejects masked-only credit card payloads', () => {
    const payment = extractPaymentFromTransactionPayment({
      paytype: 'CC',
      cclast4: '9355',
      ccexpm: '7',
      ccexpy: '2014'
    }, 'CC');
    expect(payment).toBeNull();
  });

  test('rejects masked ACH with mask characters in account field', () => {
    const payment = extractPaymentFromTransactionPayment({
      paytype: 'ACH',
      ckaba: '021000021',
      ckacc: '******1311',
      ckaccounttype: 'Checking'
    }, 'ACH');
    expect(payment).toBeNull();
  });

  test('rejects ACH with last-4-only account digits', () => {
    const payment = extractPaymentFromTransactionPayment({
      paytype: 'ACH',
      ckaba: '021000021',
      ckacc: '1311',
      ckaccounttype: 'Checking'
    }, 'ACH');
    expect(payment).toBeNull();
  });

  test('extracts full ACH from transaction payment', () => {
    const payment = extractPaymentFromTransactionPayment({
      paytype: 'ACH',
      ckaba: '021000021',
      ckacc: '1234567890',
      ckaccounttype: 'Checking',
      firstname: 'John',
      lastname: 'Smith'
    }, 'ACH');

    expect(payment?.paymentMethodType).toBe('ACH');
    expect(payment?.routingNumber).toBe('021000021');
    expect(payment?.accountNumber).toBe('1234567890');
  });

  test('picks most recent usable payment for user', () => {
    const payment = pickBestPaymentForUser([
      {
        userid: '100',
        transdate: '2020-01-01',
        paytype: 'CC',
        transactionpayments: [{ ccnum: '4111111111111111', cclast4: '1111', cctype: 'Visa', ccexpm: '1', ccexpy: '2030' }]
      },
      {
        userid: '100',
        transdate: '2024-06-01',
        paytype: 'ACH',
        transactionpayments: [{ ckaba: '021000021', ckacc: '9876543210', ckaccounttype: 'Checking' }]
      }
    ], '100');

    expect(payment?.paymentMethodType).toBe('ACH');
  });

  test('detects masked-only payment history', () => {
    expect(hasMaskedPaymentHint([
      {
        userid: '100',
        paytype: 'CC',
        transactionpayments: [{ cclast4: '9355', ccexpm: '7', ccexpy: '2014' }]
      }
    ], '100')).toBe(true);

    expect(hasMaskedPaymentHint([
      {
        userid: '100',
        paytype: 'ACH',
        transactionpayments: [{ ckaba: '021000021', ckacc: '******1311' }]
      }
    ], '100')).toBe(true);
  });
});

describe('householdNormalizer payment + SSN', () => {
  test('pickE123Ssn normalizes formatted values', () => {
    expect(pickE123Ssn({ ssn: '123-45-6789' })).toBe('123456789');
    expect(pickE123Ssn({ ssn: '12345' })).toBeNull();
  });

  test('buildHouseholdsFromE123Pages attaches payment method and SSN', () => {
    const households = buildHouseholdsFromE123Pages({
      users: [{
        userid: '100',
        memberid: 'SW123',
        firstname: 'Jane',
        lastname: 'Doe',
        ssn: '123-45-6789'
      }],
      dependents: [],
      products: [{
        userid: '100',
        upid: '5001',
        pdid: '42',
        label: 'Plan 1500',
        dtcancelled: ''
      }],
      transactions: [{
        userid: '100',
        transdate: '2024-01-01',
        paytype: 'CC',
        transactionpayments: [{
          ccnum: '4111111111111111',
          cclast4: '1111',
          cctype: 'Visa',
          ccexpm: '12',
          ccexpy: '2028'
        }]
      }]
    });

    expect(households[0].primary.ssn).toBe('123456789');
    expect(households[0].paymentMethod?.paymentMethodType).toBe('CreditCard');

    const stats = computeFetchCoverageStats(households);
    expect(stats.primarySsnCount).toBe(1);
    expect(stats.paymentMethodCount).toBe(1);
  });
});

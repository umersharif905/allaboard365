/**
 * DimeService.processPayment — decline / error / approval mapping.
 *
 * These tests pin the contract that complete-enrollment depends on to
 * distinguish a clean customer-visible decline (`DIME_DECLINED` with the
 * original `statusCode`) from a platform/infrastructure error
 * (`PAYMENT_ERROR` with HTTP status) from a real success (returns
 * `transactionNumber` + `recordStatus`).
 *
 * Source of truth for the decline amounts is docs/dime-credit-cards
 * (see backend/__tests__/fixtures/dime-test-cards.js).
 *
 * Run: npx jest dimeService.decline
 */

const axios = require('axios');
const { TEST_CARDS, TEST_ACH, AMOUNT_TRIGGERS } = require('../../test-fixtures/dime-test-cards');

jest.mock('axios', () => ({
  post: jest.fn()
}));

const visa = TEST_CARDS.visa;

function cardPayload(overrides = {}) {
  return {
    customerId: 'cust_1',
    paymentMethodId: 'RAW_CARD',
    amount: 499.99,
    description: 'Enrollment charge',
    paymentMethodType: 'Card',
    cardNumber: visa.number,
    expiryDate: `${visa.expMonth}/${visa.expYear}`,
    cvv: visa.cvv,
    cardholderName: 'Test Enrollee',
    billingAddress: visa.address,
    billingCity: 'Atlanta',
    billingState: 'GA',
    billingZip: visa.zip,
    ...overrides
  };
}

function achPayload(overrides = {}) {
  return {
    customerId: 'cust_2',
    paymentMethodId: 'RAW_ACH',
    amount: 499.99,
    description: 'Enrollment ACH charge',
    paymentMethodType: 'ACH',
    accountNumber: TEST_ACH.accountNumber,
    routingNumber: TEST_ACH.routingNumber,
    accountHolderName: 'Test Enrollee',
    accountType: 'Checking',
    ...overrides
  };
}

function dimeDataResponse(data) {
  return { data: { data } };
}

// Silence noisy console.error/log inside DimeService.
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore?.();
  console.error.mockRestore?.();
});

beforeEach(() => {
  jest.clearAllMocks();
});

function loadDimeServiceWithFakeConfig() {
  const DimeService = require('../dimeService');
  DimeService.getConfigForTenant = jest.fn(async () => ({
    apiToken: 'test-token',
    sid: 'test-sid',
    webhookSecret: 'whsec',
    environment: 'demo',
    baseUrl: 'https://demo.dimepayments.com',
    tenantId: 'tenant-1',
    tenantName: 'Tenant'
  }));
  return DimeService;
}

describe('DimeService.processPayment — approved', () => {
  test('returns success + transactionNumber for approved credit card charge', async () => {
    const DimeService = loadDimeServiceWithFakeConfig();
    axios.post.mockResolvedValue(dimeDataResponse({
      transaction_number: 'tx_approved_1',
      transaction_info_id: 'info_1',
      status_code: '00',
      status_text: 'APPROVAL',
      transaction_type: 'CC_SALE',
      amount: '499.99',
      pending: false
    }));

    const res = await DimeService.processPayment(cardPayload(), 'tenant-1');

    expect(res.success).toBe(true);
    expect(res.transactionNumber).toBe('tx_approved_1');
    expect(res.transactionId).toBe('tx_approved_1');
    expect(res.statusCode).toBe('00');
    expect(res.recordStatus).toBe('Completed');
    expect(res.error).toBeUndefined();
  });

  test('maps ACH pending transaction_status to recordStatus=Pending (not Completed, not Failed)', async () => {
    // transaction_status = ACH_PAYMENT_CREDIT_PENDING, pending flag true. This is
    // the case `complete-enrollment` must treat as PaymentHold rather than Failed.
    const DimeService = loadDimeServiceWithFakeConfig();
    axios.post.mockResolvedValue(dimeDataResponse({
      transaction_number: 'tx_ach_pending_1',
      transaction_info_id: 'info_ach_1',
      transaction_type: 'ACH',
      transaction_status: 'ACH_PAYMENT_CREDIT_PENDING',
      amount: '499.99',
      pending: true
    }));

    const res = await DimeService.processPayment(achPayload(), 'tenant-1');

    expect(res.success).toBe(true);
    expect(res.recordStatus).toBe('Pending');
    expect(res.transactionNumber).toBe('tx_ach_pending_1');
  });

  test('maps CC pending:true + CC_CREDIT to recordStatus=Pending (manual charge / Leslie Brothers shape)', async () => {
    const DimeService = loadDimeServiceWithFakeConfig();
    axios.post.mockResolvedValue(dimeDataResponse({
      transaction_number: 'tx_cc_pending_1',
      transaction_info_id: 'info_cc_1',
      transaction_type: 'CC',
      transaction_status: 'CC_CREDIT',
      status_code: '00',
      status_text: 'Approved',
      amount: '499.99',
      pending: true,
    }));

    const res = await DimeService.processPayment(cardPayload(), 'tenant-1');

    expect(res.success).toBe(true);
    expect(res.recordStatus).toBe('Pending');
    expect(res.transactionNumber).toBe('tx_cc_pending_1');
  });
});

describe('DimeService.processPayment — declined', () => {
  test('maps "Do Not Honor" (05) decline to DIME_DECLINED with statusCode preserved', async () => {
    const DimeService = loadDimeServiceWithFakeConfig();
    const trigger = AMOUNT_TRIGGERS['10.25'];
    axios.post.mockResolvedValue(dimeDataResponse({
      transaction_number: null,
      status_code: trigger.code,
      status_text: trigger.text,
      transaction_type: 'CC_SALE',
      amount: '10.25',
      pending: false
    }));

    const res = await DimeService.processPayment(
      cardPayload({ amount: 10.25 }),
      'tenant-1'
    );

    expect(res.success).toBe(false);
    // The raw DIME status_text now lives on `error.statusText`; `error.message`
    // is the user-facing friendly copy (see buildFriendlyDimeDeclineError).
    expect(res.error).toEqual(expect.objectContaining({
      code: 'DIME_DECLINED',
      statusCode: '05',
      statusText: 'DECLINE',
      isBankDecline: true,
      declineReasonCode: '05'
    }));
    expect(typeof res.error.message).toBe('string');
    expect(res.error.message).toMatch(/bank declined/i);
    expect(res.error.details).toBeDefined();
  });

  test('maps "Insufficient Funds" (51) decline to DIME_DECLINED', async () => {
    const DimeService = loadDimeServiceWithFakeConfig();
    const trigger = AMOUNT_TRIGGERS['10.08'];
    axios.post.mockResolvedValue(dimeDataResponse({
      transaction_number: null,
      status_code: trigger.code,
      status_text: trigger.text,
      amount: '10.08',
      pending: false
    }));

    const res = await DimeService.processPayment(
      cardPayload({ amount: 10.08 }),
      'tenant-1'
    );

    expect(res.success).toBe(false);
    expect(res.error.code).toBe('DIME_DECLINED');
    expect(res.error.statusCode).toBe('51');
  });

  test('maps CVV2 mismatch (N7) decline to DIME_DECLINED', async () => {
    const DimeService = loadDimeServiceWithFakeConfig();
    const trigger = AMOUNT_TRIGGERS['10.23'];
    axios.post.mockResolvedValue(dimeDataResponse({
      transaction_number: null,
      status_code: trigger.code,
      status_text: trigger.text,
      amount: '10.23',
      pending: false
    }));

    const res = await DimeService.processPayment(
      cardPayload({ amount: 10.23 }),
      'tenant-1'
    );

    expect(res.success).toBe(false);
    expect(res.error.code).toBe('DIME_DECLINED');
    expect(res.error.statusCode).toBe('N7');
  });

  test('maps expired card (54) decline to DIME_DECLINED', async () => {
    const DimeService = loadDimeServiceWithFakeConfig();
    const trigger = AMOUNT_TRIGGERS['10.32'];
    axios.post.mockResolvedValue(dimeDataResponse({
      transaction_number: null,
      status_code: trigger.code,
      status_text: trigger.text,
      amount: '10.32',
      pending: false
    }));

    const res = await DimeService.processPayment(
      cardPayload({ amount: 10.32 }),
      'tenant-1'
    );

    expect(res.success).toBe(false);
    expect(res.error.code).toBe('DIME_DECLINED');
    expect(res.error.statusCode).toBe('54');
  });

  test('falls back to generic friendly message for unmapped code with no status_text', async () => {
    // Code 'XX' isn't in the ISO-8583 catalogue and there's no status_text to
    // pattern-match — this should land in the truly-unknown fallback branch of
    // buildFriendlyDimeDeclineError, not surface a raw decline word.
    const DimeService = loadDimeServiceWithFakeConfig();
    axios.post.mockResolvedValue(dimeDataResponse({
      transaction_number: null,
      status_code: 'XX',
      pending: false
    }));

    const res = await DimeService.processPayment(
      cardPayload({ amount: 10.25 }),
      'tenant-1'
    );

    expect(res.success).toBe(false);
    expect(res.error.code).toBe('DIME_DECLINED');
    expect(res.error.statusCode).toBe('XX');
    expect(res.error.isBankDecline).toBe(false);
    expect(res.error.message).toMatch(/payment could not be completed/i);
  });
});

describe('DimeService.processPayment — infrastructure errors (NOT declines)', () => {
  test('network error (no response) returns PAYMENT_ERROR with axios error message', async () => {
    const DimeService = loadDimeServiceWithFakeConfig();
    const netErr = new Error('ECONNREFUSED: connection refused');
    axios.post.mockRejectedValue(netErr);

    const res = await DimeService.processPayment(cardPayload(), 'tenant-1');

    expect(res.success).toBe(false);
    expect(res.error.code).toBe('PAYMENT_ERROR');
    expect(res.error.message).toContain('ECONNREFUSED');
    expect(res.error.status).toBeUndefined();
  });

  test('4xx validation error returns PAYMENT_ERROR with flattened validationSummary', async () => {
    const DimeService = loadDimeServiceWithFakeConfig();
    const apiErr = new Error('Request failed with status code 400');
    apiErr.response = {
      status: 400,
      data: {
        message: 'Validation failed',
        errors: {
          card_number: ['Card number is invalid'],
          cvv: ['CVV is required']
        }
      }
    };
    axios.post.mockRejectedValue(apiErr);

    const res = await DimeService.processPayment(cardPayload(), 'tenant-1');

    expect(res.success).toBe(false);
    expect(res.error.code).toBe('PAYMENT_ERROR');
    expect(res.error.status).toBe(400);
    expect(res.error.validationSummary).toEqual(expect.stringContaining('card_number'));
    expect(res.error.validationSummary).toEqual(expect.stringContaining('cvv'));
  });

  test('5xx server error returns PAYMENT_ERROR with status preserved (so complete-enrollment can treat as retryable)', async () => {
    const DimeService = loadDimeServiceWithFakeConfig();
    const serverErr = new Error('Request failed with status code 502');
    serverErr.response = {
      status: 502,
      data: { message: 'Bad Gateway' }
    };
    axios.post.mockRejectedValue(serverErr);

    const res = await DimeService.processPayment(cardPayload(), 'tenant-1');

    expect(res.success).toBe(false);
    expect(res.error.code).toBe('PAYMENT_ERROR');
    expect(res.error.status).toBe(502);
    expect(res.error.message).toBe('Bad Gateway');
  });
});

describe('DimeService.processPayment — request contract', () => {
  test('omits Idempotency-Key header when not provided (opt-in header)', async () => {
    const DimeService = loadDimeServiceWithFakeConfig();
    axios.post.mockResolvedValue(dimeDataResponse({
      transaction_number: 'tx_1',
      status_code: '00',
      status_text: 'APPROVAL',
      pending: false
    }));

    await DimeService.processPayment(cardPayload(), 'tenant-1');

    const headers = axios.post.mock.calls[0][2].headers;
    expect(headers.Authorization).toBe('Bearer test-token');
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  test('forwards Idempotency-Key header when provided', async () => {
    const DimeService = loadDimeServiceWithFakeConfig();
    axios.post.mockResolvedValue(dimeDataResponse({
      transaction_number: 'tx_1',
      status_code: '00',
      status_text: 'APPROVAL',
      pending: false
    }));

    await DimeService.processPayment(
      cardPayload({ idempotencyKey: 'idem_xyz_123' }),
      'tenant-1'
    );

    const headers = axios.post.mock.calls[0][2].headers;
    expect(headers['Idempotency-Key']).toBe('idem_xyz_123');
  });
});

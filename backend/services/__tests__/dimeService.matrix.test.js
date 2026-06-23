/**
 * DimeService.processPayment — parameterized decline matrix.
 *
 * Walks every amount trigger from DP_Test_Card_Information.xlsx (sheet 2 = VISA
 * + sheet 3 MasterCard extras) and asserts that DimeService:
 *   - maps status_code → error.statusCode verbatim
 *   - returns error.code === 'DIME_DECLINED' for any non-00 status_code
 *     with a non-null transaction_number path (i.e. processor responded)
 *   - returns success: false
 *
 * Also runs every card brand (Visa, MC, MC 2-BIN, Discover, Amex, JCB)
 * through the Do-Not-Honor ($10.25 / code 05) trigger to prove the
 * service is card-brand-agnostic — DIME's sandbox decides by amount, not by
 * card number.
 *
 * Run: npx jest dimeService.matrix
 */

const axios = require('axios');
const {
  TEST_CARDS,
  TEST_ACH,
  VISA_AMOUNT_TRIGGERS,
  MASTERCARD_EXTRA_TRIGGERS
} = require('../../test-fixtures/dime-test-cards');

jest.mock('axios', () => ({ post: jest.fn() }));

function cardPayload(card, overrides = {}) {
  return {
    customerId: 'cust_matrix',
    paymentMethodId: 'RAW_CARD',
    amount: 499.99,
    description: 'Matrix charge',
    paymentMethodType: 'Card',
    cardNumber: card.number,
    expiryDate: `${card.expMonth}/${card.expYear}`,
    cvv: card.cvv,
    cardholderName: 'Test Enrollee',
    billingAddress: card.address,
    billingCity: 'Atlanta',
    billingState: 'GA',
    billingZip: card.zip,
    ...overrides
  };
}

function dimeDataResponse(data) {
  return { data: { data } };
}

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

// ─────────────────────────────────────────────────────────────────────────
// VISA amount-trigger matrix — every trigger in the xlsx (~25 cases)
// ─────────────────────────────────────────────────────────────────────────
describe('DimeService.processPayment — full VISA amount-trigger matrix', () => {
  const cases = Object.entries(VISA_AMOUNT_TRIGGERS).map(([amount, trigger]) => ({
    amount: Number(amount),
    code: trigger.code,
    text: trigger.text,
    comment: trigger.comment || ''
  }));

  test.each(cases)(
    '$amount → $code $text $comment',
    async ({ amount, code, text }) => {
      const DimeService = loadDimeServiceWithFakeConfig();
      axios.post.mockResolvedValue(
        dimeDataResponse({
          transaction_number: null,
          status_code: code,
          status_text: text,
          transaction_type: 'CC_SALE',
          amount: amount.toFixed(2),
          pending: false
        })
      );

      const res = await DimeService.processPayment(
        cardPayload(TEST_CARDS.visa, { amount }),
        'tenant-1'
      );

      expect(res.success).toBe(false);
      expect(res.error.code).toBe('DIME_DECLINED');
      expect(res.error.statusCode).toBe(code);
      // The raw DIME status_text is preserved on `error.statusText`; the friendly
      // user-facing copy lives on `error.message` (see buildFriendlyDimeDeclineError).
      if (text) {
        expect(res.error.statusText).toBe(text);
      }
      expect(typeof res.error.message).toBe('string');
      expect(res.error.message.length).toBeGreaterThan(0);
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────
// MasterCard-specific amount triggers (sheet3 values that diverge from Visa)
// ─────────────────────────────────────────────────────────────────────────
describe('DimeService.processPayment — MasterCard-specific amount triggers', () => {
  const cases = Object.entries(MASTERCARD_EXTRA_TRIGGERS).map(([amount, trigger]) => ({
    amount: Number(amount),
    code: trigger.code,
    text: trigger.text,
    comment: trigger.comment || ''
  }));

  test.each(cases)(
    'MC $amount → $code $text $comment',
    async ({ amount, code, text }) => {
      const DimeService = loadDimeServiceWithFakeConfig();
      axios.post.mockResolvedValue(
        dimeDataResponse({
          transaction_number: null,
          status_code: code,
          status_text: text,
          transaction_type: 'CC_SALE',
          amount: amount.toFixed(2),
          pending: false
        })
      );

      const res = await DimeService.processPayment(
        cardPayload(TEST_CARDS.mastercard, { amount }),
        'tenant-1'
      );

      expect(res.success).toBe(false);
      expect(res.error.code).toBe('DIME_DECLINED');
      expect(res.error.statusCode).toBe(code);
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Card brand × "Do Not Honor" — prove DIME sandbox decides by amount, not PAN
// ─────────────────────────────────────────────────────────────────────────
describe('DimeService.processPayment — all card brands × Do Not Honor ($10.25)', () => {
  const brands = [
    ['visa', TEST_CARDS.visa],
    ['mastercard', TEST_CARDS.mastercard],
    ['mastercardBin2', TEST_CARDS.mastercardBin2],
    ['discover', TEST_CARDS.discover],
    ['amex', TEST_CARDS.amex],
    ['jcb', TEST_CARDS.jcb]
  ];

  test.each(brands)('%s → DIME_DECLINED with code 05', async (_name, card) => {
    const DimeService = loadDimeServiceWithFakeConfig();
    axios.post.mockResolvedValue(
      dimeDataResponse({
        transaction_number: null,
        status_code: '05',
        status_text: 'DECLINE',
        transaction_type: 'CC_SALE',
        amount: '10.25',
        pending: false
      })
    );

    const res = await DimeService.processPayment(
      cardPayload(card, { amount: 10.25 }),
      'tenant-1'
    );

    expect(res.success).toBe(false);
    expect(res.error.code).toBe('DIME_DECLINED');
    expect(res.error.statusCode).toBe('05');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Request body carries the correct card number per brand (Amex CVV 4 digits,
// others 3). Pins that DimeService doesn't silently rewrite PANs or truncate
// Amex CVV to 3 digits.
// ─────────────────────────────────────────────────────────────────────────
describe('DimeService.processPayment — request body per card brand', () => {
  const brands = [
    ['visa', TEST_CARDS.visa, 3],
    ['mastercard', TEST_CARDS.mastercard, 3],
    ['mastercardBin2', TEST_CARDS.mastercardBin2, 3],
    ['discover', TEST_CARDS.discover, 3],
    ['amex', TEST_CARDS.amex, 4],
    ['jcb', TEST_CARDS.jcb, 3]
  ];

  test.each(brands)(
    '%s body carries full PAN + correct-length CVV',
    async (_name, card, cvvLen) => {
      const DimeService = loadDimeServiceWithFakeConfig();
      axios.post.mockResolvedValue(
        dimeDataResponse({
          transaction_number: 'tx_ok',
          status_code: '00',
          status_text: 'APPROVAL',
          amount: '1.00',
          pending: false
        })
      );

      await DimeService.processPayment(cardPayload(card, { amount: 1 }), 'tenant-1');

      const body = JSON.stringify(axios.post.mock.calls[0][1]);
      expect(body).toContain(card.number);
      expect(card.cvv.length).toBe(cvvLen);
      // Amex must have a 4-digit CVV in the body; others 3.
      expect(body).toContain(card.cvv);
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────
// ACH approval with full DP ACH sandbox creds
// ─────────────────────────────────────────────────────────────────────────
describe('DimeService.processPayment — DP ACH sandbox approval', () => {
  test('ACH 1357902468 / 122000030 → Completed on status_code=00', async () => {
    const DimeService = loadDimeServiceWithFakeConfig();
    axios.post.mockResolvedValue(
      dimeDataResponse({
        transaction_number: 'tx_ach_dp_ok',
        status_code: '00',
        status_text: 'APPROVAL',
        transaction_type: 'ACH_SALE',
        amount: '250.00',
        pending: false
      })
    );

    const res = await DimeService.processPayment(
      {
        customerId: 'cust_ach',
        paymentMethodId: 'RAW_ACH',
        amount: 250,
        description: 'ACH enrollment',
        paymentMethodType: 'ACH',
        accountNumber: TEST_ACH.accountNumber,
        routingNumber: TEST_ACH.routingNumber,
        accountHolderName: 'Test Enrollee',
        accountType: 'Checking',
        bankName: 'DP ACH'
      },
      'tenant-1'
    );

    expect(res.success).toBe(true);
    expect(res.recordStatus).toBe('Completed');

    const body = JSON.stringify(axios.post.mock.calls[0][1]);
    expect(body).toContain('1357902468');
    expect(body).toContain('122000030');
  });
});

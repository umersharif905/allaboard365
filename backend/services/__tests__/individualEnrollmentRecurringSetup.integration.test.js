/**
 * Integration-ish tests for setupStoredPaymentMethodAndRecurringForIndividualEnrollment:
 * mock DimeService and DB pool, call the service, verify the startDate passed to Dime
 * reflects the chargeFirstPaymentWithRecurring flag.
 */

// Mock external collaborators BEFORE requiring the service.
jest.mock('../dimeService', () => ({
  getCustomerByEmail: jest.fn(async () => ({ success: false })),
  createCustomer: jest.fn(async () => ({ success: true, customerId: 'cust-test' })),
  createBankAccountPaymentMethod: jest.fn(async () => ({
    success: true,
    paymentMethodId: 'pm-ach-test',
    token: 'tok-ach'
  })),
  createCreditCardPaymentMethod: jest.fn(async () => ({
    success: true,
    paymentMethodId: 'pm-card-test',
    token: 'tok-card',
    cardBrand: 'Visa',
    cardLast4: '4242'
  })),
  setupRecurringPayment: jest.fn(async () => ({
    success: true,
    scheduleId: 'sch-test',
    status: 'Active',
    nextBillingDate: null
  }))
}));

jest.mock('../paymentDatabaseService', () => ({
  persistRecurringScheduleAfterDimeSetup: jest.fn(async () => ({ success: true }))
}));

jest.mock('../encryptionService', () => ({
  encrypt: jest.fn((v) => `enc:${v}`)
}));

const DimeService = require('../dimeService');
const {
  setupStoredPaymentMethodAndRecurringForIndividualEnrollment
} = require('../individualEnrollmentRecurringSetup');

function fakeRequest(recordset = []) {
  const req = {
    input: jest.fn(() => req),
    query: jest.fn(async () => ({ recordset }))
  };
  return req;
}

function fakePool({ processorCustomerId = 'existing-cust-id' } = {}) {
  // The service issues 2+ queries. Return sensible defaults.
  return {
    request: () => fakeRequest([{ ProcessorCustomerId: processorCustomerId }])
  };
}

const baseParams = () => ({
  pool: fakePool(),
  sql: { UniqueIdentifier: 'UniqueIdentifier', NVarChar: (n) => `NVarChar(${n})` },
  tenantId: '00000000-0000-0000-0000-000000000001',
  memberId: '00000000-0000-0000-0000-000000000002',
  householdId: '00000000-0000-0000-0000-000000000003',
  memberInfo: { firstName: 'Jane', lastName: 'Doe', email: 'jane@test.com' },
  paymentMethod: {
    paymentMethodType: 'ACH',
    bankName: 'Test',
    routingNumber: '111000025',
    accountNumber: '000123456789',
    accountType: 'Checking',
    accountHolderName: 'Jane Doe',
    email: 'jane@test.com'
  },
  effectiveDate: '2026-06-01',
  basePremium: 200,
  paymentProcessingFeeTotal: 0.50,
  systemFeesAmount: 3.50,
  userId: '00000000-0000-0000-0000-00000000000a'
});

describe('setupStoredPaymentMethodAndRecurringForIndividualEnrollment — Dime recurring startDate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('flag OFF → startDate = effective date + 1 month (legacy)', async () => {
    await setupStoredPaymentMethodAndRecurringForIndividualEnrollment({
      ...baseParams(),
      chargeFirstPaymentWithRecurring: false
    });

    expect(DimeService.setupRecurringPayment).toHaveBeenCalledTimes(1);
    const args = DimeService.setupRecurringPayment.mock.calls[0][0];
    expect(args.startDate.toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  test('flag ON → startDate = effective date itself (first charge deferred)', async () => {
    await setupStoredPaymentMethodAndRecurringForIndividualEnrollment({
      ...baseParams(),
      chargeFirstPaymentWithRecurring: true
    });

    expect(DimeService.setupRecurringPayment).toHaveBeenCalledTimes(1);
    const args = DimeService.setupRecurringPayment.mock.calls[0][0];
    expect(args.startDate.toISOString().slice(0, 10)).toBe('2026-06-01');
    // Recurring amount = premium + processing fee + system fees (no setup fee).
    expect(args.amount).toBeCloseTo(204, 2);
  });

  test('flag ON + December effective date → startDate respects effective date (no year roll)', async () => {
    await setupStoredPaymentMethodAndRecurringForIndividualEnrollment({
      ...baseParams(),
      effectiveDate: '2026-12-15',
      chargeFirstPaymentWithRecurring: true
    });

    const args = DimeService.setupRecurringPayment.mock.calls[0][0];
    expect(args.startDate.toISOString().slice(0, 10)).toBe('2026-12-15');
  });

  test('flag OFF + December effective date → startDate rolls year to next January', async () => {
    await setupStoredPaymentMethodAndRecurringForIndividualEnrollment({
      ...baseParams(),
      effectiveDate: '2026-12-15',
      chargeFirstPaymentWithRecurring: false
    });

    const args = DimeService.setupRecurringPayment.mock.calls[0][0];
    expect(args.startDate.toISOString().slice(0, 10)).toBe('2027-01-15');
  });
});

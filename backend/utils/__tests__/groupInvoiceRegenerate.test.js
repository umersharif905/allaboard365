jest.mock('axios', () => ({
  post: jest.fn()
}));

const axios = require('axios');
const {
  resolvePaymentManagerUrl,
  callPaymentManagerManualRun,
  paymentManagerRunFailed,
  restoreGroupInvoiceSnapshot
} = require('../groupInvoiceRegenerate');

describe('groupInvoiceRegenerate', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.PAYMENT_MANAGER_URL;
    delete process.env.NODE_ENV;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('resolvePaymentManagerUrl defaults to localhost in non-production', () => {
    expect(resolvePaymentManagerUrl()).toBe('http://localhost:7071');
  });

  it('resolvePaymentManagerUrl uses production fallback when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production';
    expect(resolvePaymentManagerUrl()).toContain('allaboard-payment-manager');
  });

  it('callPaymentManagerManualRun returns ok on success', async () => {
    process.env.PAYMENT_MANAGER_URL = 'http://localhost:7071';
    process.env.PAYMENT_MANAGER_ADMIN_API_KEY = 'test-key';
    axios.post.mockResolvedValue({ status: 200, data: { success: true } });

    const result = await callPaymentManagerManualRun('group-1', '2026-06-01');
    expect(result.ok).toBe(true);
    expect(axios.post).toHaveBeenCalledWith(
      'http://localhost:7071/api/manual-run?groupId=group-1&billingDate=2026-06-01',
      {},
      expect.objectContaining({ headers: { 'x-api-key': 'test-key' } })
    );
  });

  it('callPaymentManagerManualRun returns failure with ENOTFOUND hint', async () => {
    process.env.PAYMENT_MANAGER_URL = 'https://dead-host.example.com';
    const err = new Error('getaddrinfo ENOTFOUND dead-host.example.com');
    err.code = 'ENOTFOUND';
    axios.post.mockRejectedValue(err);

    const result = await callPaymentManagerManualRun('group-1', '2026-06-01');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/ENOTFOUND/);
    expect(result.message).toMatch(/allaboard-payment-manager/);
  });

  it('paymentManagerRunFailed when success flag missing', () => {
    expect(paymentManagerRunFailed({ status: 200, data: { success: false } })).toBe(true);
    expect(paymentManagerRunFailed({ status: 500, data: { success: true } })).toBe(true);
    expect(paymentManagerRunFailed({ status: 200, data: { success: true } })).toBe(false);
  });

  it('restoreGroupInvoiceSnapshot skips when invoice already exists', async () => {
    const pool = {
      request: () => ({
        input: () => ({
          query: async () => ({ recordset: [{ n: 1 }] })
        })
      })
    };
    const result = await restoreGroupInvoiceSnapshot(pool, {
      invoice: { InvoiceId: 'id-1', InvoiceNumber: 'INV-1' },
      lineItems: [],
      recurringPlans: []
    });
    expect(result.restored).toBe(false);
    expect(result.reason).toBe('invoice_already_exists');
  });
});

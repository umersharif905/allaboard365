const axios = require('axios');

jest.mock('axios', () => ({
  post: jest.fn()
}));

describe('DimeService.processPayment idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends Idempotency-Key header when provided', async () => {
    const DimeService = require('../dimeService');

    // Bypass DB-backed tenant config lookup
    DimeService.getConfigForTenant = jest.fn(async () => ({
      apiToken: 'test-token',
      sid: 'test-sid',
      webhookSecret: 'whsec',
      environment: 'demo',
      baseUrl: 'https://demo.dimepayments.com',
      tenantId: 'tenant-1',
      tenantName: 'Tenant'
    }));

    axios.post.mockResolvedValue({
      data: {
        data: {
          transaction_number: 'tx_123',
          status_text: 'APPROVAL',
          status_code: '00'
        }
      }
    });

    const res = await DimeService.processPayment({
      customerId: 'cust_1',
      paymentMethodId: 'RAW_CARD',
      amount: 10.0,
      description: 'Test payment',
      paymentMethodType: 'Card',
      idempotencyKey: 'idem_abc',
      cardNumber: '4242424242424242',
      expiryDate: '12/2029',
      cvv: '123',
      cardholderName: 'Test User',
      billingAddress: '123 Main St',
      billingCity: 'Atlanta',
      billingState: 'GA',
      billingZip: '30301'
    }, 'tenant-1');

    expect(res.success).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);

    const call = axios.post.mock.calls[0];
    const axiosConfig = call[2] || {};
    const headers = axiosConfig.headers || {};

    expect(headers.Authorization).toBe('Bearer test-token');
    expect(headers['Idempotency-Key']).toBe('idem_abc');
  });
});


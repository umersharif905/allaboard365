'use strict';

// Internal payment-bounce endpoint: authenticates with EITHER the internal token
// (x-internal-token) OR the scheduled-job key (x-api-key) — the DIME webhook handler
// uses the latter to reuse processBounce instead of its own inline logic.

const express = require('express');
const request = require('supertest');

const mockProcessBounce = jest.fn();
jest.mock('../../services/paymentBounceService', () => ({
  processBounce: (...a) => mockProcessBounce(...a),
  RETURN_TYPE_ACH: 'ACH_Return',
  RETURN_TYPE_CHARGEBACK: 'Chargeback',
}));

const INTERNAL_TOKEN = 'internal-secret';
const API_KEY = 'scheduled-job-secret';

let app;
beforeAll(() => {
  process.env.INTERNAL_API_TOKEN = INTERNAL_TOKEN;
  process.env.SCHEDULED_JOB_API_KEY = API_KEY;
  const router = require('../internal/payment-bounces');
  app = express();
  app.use(express.json());
  app.use('/api/internal/payment-bounces', router);
});

beforeEach(() => {
  mockProcessBounce.mockReset();
});

const validBody = {
  originalProcessorTransactionId: '485',
  returnType: 'ACH_Return',
  amount: 712.92,
  returnCode: 'R01',
  customerUuid: '9f76ff80-bcc8-4252-a2f0-4587af912ca3',
};

describe('POST /api/internal/payment-bounces/process auth', () => {
  test('rejects with no credentials', async () => {
    const res = await request(app).post('/api/internal/payment-bounces/process').send(validBody);
    expect(res.status).toBe(401);
    expect(mockProcessBounce).not.toHaveBeenCalled();
  });

  test('rejects an invalid api key', async () => {
    const res = await request(app)
      .post('/api/internal/payment-bounces/process')
      .set('x-api-key', 'wrong')
      .send(validBody);
    expect(res.status).toBe(401);
    expect(mockProcessBounce).not.toHaveBeenCalled();
  });

  test('accepts the scheduled-job key (x-api-key) and delegates to processBounce', async () => {
    mockProcessBounce.mockResolvedValue({ success: true, alreadyProcessed: false, originalPaymentId: 'p1', invoiceId: 'i1' });
    const res = await request(app)
      .post('/api/internal/payment-bounces/process')
      .set('x-api-key', API_KEY)
      .send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockProcessBounce).toHaveBeenCalledWith(expect.objectContaining({
      originalProcessorTransactionId: '485',
      returnType: 'ACH_Return',
      amount: 712.92,
      customerUuid: '9f76ff80-bcc8-4252-a2f0-4587af912ca3',
    }));
  });

  test('accepts the internal token (x-internal-token)', async () => {
    mockProcessBounce.mockResolvedValue({ success: true });
    const res = await request(app)
      .post('/api/internal/payment-bounces/process')
      .set('x-internal-token', INTERNAL_TOKEN)
      .send(validBody);
    expect(res.status).toBe(200);
    expect(mockProcessBounce).toHaveBeenCalled();
  });

  test('maps ORIGINAL_NOT_FOUND to 404', async () => {
    mockProcessBounce.mockResolvedValue({ success: false, code: 'ORIGINAL_NOT_FOUND', message: 'nope' });
    const res = await request(app)
      .post('/api/internal/payment-bounces/process')
      .set('x-api-key', API_KEY)
      .send(validBody);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

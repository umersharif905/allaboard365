/**
 * GET/POST /api/public/marketing-unsubscribe — public unsubscribe endpoint.
 *
 * Verifies the UX fix: a browser click renders a self-contained branded HTML
 * confirmation page (not raw JSON), while programmatic clients still get JSON,
 * and the RFC 8058 one-click POST returns 200. Also asserts the opt-out is
 * actually recorded for a valid token and that invalid tokens are rejected.
 *
 * Run: npx jest routes/__tests__/marketing-unsubscribe.public.test.js
 */
const request = require('supertest');
const express = require('express');

const mockOptOut = jest.fn(async () => ({ success: true }));
let mockTokenPayload = { memberId: 'mem-1', tenantId: 'ten-1' };

jest.mock('../../services/marketingUnsubscribeToken.service', () => ({
  verifyMarketingUnsubscribeToken: jest.fn((t) => (t === 'good' ? mockTokenPayload : null))
}));
jest.mock('../../services/memberCommunicationPreferences.service', () => ({
  optOutEmailMarketingFromUnsubscribe: (...args) => mockOptOut(...args)
}));
jest.mock('../../services/marketingEmailCompliance.service', () => ({
  frontendBase: () => 'https://app.example.com',
  escapeHtml: (s) => String(s == null ? '' : s)
}));

const router = require('../public/marketing-unsubscribe');

function makeApp() {
  const app = express();
  app.use('/api/public/marketing-unsubscribe', router);
  return app;
}

beforeAll(() => { jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(() => { console.error.mockRestore?.(); });
beforeEach(() => { mockOptOut.mockClear(); mockTokenPayload = { memberId: 'mem-1', tenantId: 'ten-1' }; });

describe('GET — browser click', () => {
  it('renders a branded HTML success page and records the opt-out', async () => {
    const res = await request(makeApp())
      .get('/api/public/marketing-unsubscribe?token=good')
      .set('Accept', 'text/html')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/<!doctype html>/i);
    expect(res.text).toMatch(/unsubscribed/i);
    expect(res.text).not.toMatch(/^\s*\{/); // not raw JSON
    expect(mockOptOut).toHaveBeenCalledWith('mem-1', 'ten-1', 'UnsubscribeLink');
  });

  it('renders an HTML error page (400) for an invalid/expired token', async () => {
    const res = await request(makeApp())
      .get('/api/public/marketing-unsubscribe?token=bad')
      .set('Accept', 'text/html')
      .expect(400);

    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/didn.t work|invalid|expired/i);
    expect(mockOptOut).not.toHaveBeenCalled();
  });

  it('renders an HTML page (400) when the token is missing', async () => {
    const res = await request(makeApp())
      .get('/api/public/marketing-unsubscribe')
      .set('Accept', 'text/html')
      .expect(400);
    expect(res.text).toMatch(/<!doctype html>/i);
  });
});

describe('GET — programmatic client still gets JSON', () => {
  it('returns JSON when Accept: application/json', async () => {
    const res = await request(makeApp())
      .get('/api/public/marketing-unsubscribe?token=good')
      .set('Accept', 'application/json')
      .expect(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ success: true, message: expect.stringMatching(/unsubscribed/i) });
  });
});

describe('POST — RFC 8058 one-click', () => {
  it('records opt-out and returns 200 with a short body', async () => {
    const res = await request(makeApp())
      .post('/api/public/marketing-unsubscribe?token=good')
      .expect(200);
    expect(mockOptOut).toHaveBeenCalledWith('mem-1', 'ten-1', 'UnsubscribeLink');
    expect(res.text).toBe('OK');
  });

  it('returns 400 for an invalid token and does not opt out', async () => {
    await request(makeApp())
      .post('/api/public/marketing-unsubscribe?token=bad')
      .expect(400);
    expect(mockOptOut).not.toHaveBeenCalled();
  });
});

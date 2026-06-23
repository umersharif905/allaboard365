/**
 * marketingEmailCompliance.service — the CAN-SPAM footer + List-Unsubscribe URL
 * that Joey reported as missing on quick-send. Proves the builder appends a
 * footer with an unsubscribe link and emits a one-click List-Unsubscribe URL.
 *
 * Run: npx jest services/__tests__/marketingEmailCompliance.service.test.js
 */

const ORIGINAL_ENV = { ...process.env };

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  console.warn.mockRestore?.();
  process.env = ORIGINAL_ENV;
});

function freshService() {
  jest.resetModules();
  return require('../marketingEmailCompliance.service');
}

describe('buildMarketingFooterAndUnsubscribeUrl', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.API_PUBLIC_BASE_URL = 'https://api.example.com';
    process.env.FRONTEND_URL = 'https://app.example.com';
  });

  it('appends a footer containing an Unsubscribe link to the original body', () => {
    const { buildMarketingFooterAndUnsubscribeUrl } = freshService();
    const original = '<p>Promo body</p>';
    const { htmlWithFooter } = buildMarketingFooterAndUnsubscribeUrl(original, {
      memberId: 'mem-1', tenantId: 'ten-1', tenantName: 'Acme', postalLine: '1 A St, Town, TS 00000'
    });

    expect(htmlWithFooter.startsWith(original)).toBe(true);          // original preserved
    expect(htmlWithFooter).toMatch(/Unsubscribe from marketing emails/i);
    expect(htmlWithFooter).toContain('/unsubscribe?token=');         // member-facing link
    expect(htmlWithFooter).toContain('Acme');                        // tenant name
    expect(htmlWithFooter).toContain('1 A St, Town, TS 00000');      // CAN-SPAM postal line
  });

  it('emits a one-click List-Unsubscribe URL pointing at the public API', () => {
    const { buildMarketingFooterAndUnsubscribeUrl } = freshService();
    const { listUnsubscribeUrl } = buildMarketingFooterAndUnsubscribeUrl('<p>x</p>', {
      memberId: 'mem-1', tenantId: 'ten-1', tenantName: 'Acme'
    });
    expect(listUnsubscribeUrl).toMatch(/^https:\/\/api\.example\.com\/api\/public\/marketing-unsubscribe\?token=/);
  });

  it('round-trips a verifiable unsubscribe token bound to the member/tenant', () => {
    const { buildMarketingFooterAndUnsubscribeUrl } = freshService();
    const { listUnsubscribeUrl } = buildMarketingFooterAndUnsubscribeUrl('<p>x</p>', {
      memberId: 'mem-42', tenantId: 'ten-7', tenantName: 'Acme'
    });
    const token = decodeURIComponent(listUnsubscribeUrl.split('token=')[1]);
    const { verifyMarketingUnsubscribeToken } = require('../marketingUnsubscribeToken.service');
    const payload = verifyMarketingUnsubscribeToken(token);
    expect(payload).toEqual({ memberId: 'mem-42', tenantId: 'ten-7' });
  });

  it('without JWT_SECRET: still renders a footer but no signed List-Unsubscribe URL', () => {
    delete process.env.JWT_SECRET;
    const { buildMarketingFooterAndUnsubscribeUrl } = freshService();
    const { htmlWithFooter, listUnsubscribeUrl } = buildMarketingFooterAndUnsubscribeUrl('<p>x</p>', {
      memberId: 'mem-1', tenantId: 'ten-1', tenantName: 'Acme'
    });
    expect(htmlWithFooter).toMatch(/Unsubscribe from marketing emails/i);
    expect(listUnsubscribeUrl).toBeNull();
  });
});

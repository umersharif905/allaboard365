const {
  verifyWebhookSignature,
  shouldForwardIssue,
  buildAutomationContext,
} = require('../../sentryCursorAutomationService');

describe('sentryCursorAutomationService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.SENTRY_CURSOR_AUTOMATION_ENABLED = 'true';
    process.env.SENTRY_CURSOR_ENVIRONMENTS = 'production';
    process.env.SENTRY_CURSOR_MIN_EVENTS = '1';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('verifies a valid Sentry webhook signature', () => {
    const secret = 'test-secret';
    const rawBody = Buffer.from(JSON.stringify({ action: 'created' }), 'utf8');
    const signature = require('crypto').createHmac('sha256', secret).update(rawBody).digest('hex');

    expect(verifyWebhookSignature(rawBody, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(rawBody, 'bad-signature', secret)).toBe(false);
  });

  it('forwards production issue.created events when enabled', () => {
    const decision = shouldForwardIssue({
      action: 'created',
      resource: 'issue',
      issue: { count: 3, environment: 'production', title: 'TypeError' },
      event: null,
    });

    expect(decision.forward).toBe(true);
  });

  it('skips non-production environments', () => {
    const decision = shouldForwardIssue({
      action: 'created',
      resource: 'issue',
      issue: { count: 3, environment: 'development', title: 'TypeError' },
      event: null,
    });

    expect(decision.forward).toBe(false);
    expect(decision.reason).toContain('environment');
  });

  it('builds a rich automation context with issue metadata', () => {
    const context = buildAutomationContext({
      action: 'created',
      resource: 'issue',
      issue: {
        shortId: 'OPENENROLL-123',
        title: 'Cannot read properties of undefined',
        culprit: 'billingNightlyOrchestrator.service.js',
        level: 'error',
        count: 12,
        permalink: 'https://sentry.io/issues/123/',
      },
      event: null,
    });

    expect(context).toContain('OPENENROLL-123');
    expect(context).toContain('billingNightlyOrchestrator.service.js');
    expect(context).toContain('https://sentry.io/issues/123/');
  });
});

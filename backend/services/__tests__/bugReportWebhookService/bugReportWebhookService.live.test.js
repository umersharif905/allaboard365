/**
 * LIVE TEST: Calls the real bug-report webhook. Not run by default `npm test`.
 * Run with: npm run test:live
 * Requires .env to have BUG_REPORT_WEBHOOK_URL and BUG_REPORT_WEBHOOK_BEARER_TOKEN set.
 * Optional: set RUN_LIVE_TESTS=1 to enforce intent (test will skip otherwise if you add a guard).
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { publishBugReport } = require('../../bugReportWebhookService');

describe('bugReportWebhookService (live)', () => {
  it('createRealBugReport', async () => {
    const result = await publishBugReport({
      context: 'live test from allaboard365 backend',
      payload: { source: 'jest-live', timestamp: new Date().toISOString() }
    });

    expect(result).toBeDefined();
  });
});

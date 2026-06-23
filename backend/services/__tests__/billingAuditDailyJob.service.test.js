'use strict';

const {
  SCHEDULED_AUDITS,
  scheduledAuditsForTenant
} = require('../billingAuditDailyJob.service');

describe('billingAuditDailyJob scheduledAuditsForTenant', () => {
  test('includes missing_recurring for standard tenants', () => {
    const audits = scheduledAuditsForTenant({ IsExternal: false });
    expect(audits).toEqual(SCHEDULED_AUDITS);
    expect(audits).toContain('missing_recurring');
  });

  test('omits missing_recurring when IsExternal', () => {
    const audits = scheduledAuditsForTenant({ IsExternal: true });
    expect(audits).not.toContain('missing_recurring');
    expect(audits.length).toBe(SCHEDULED_AUDITS.length - 1);
  });
});

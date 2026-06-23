'use strict';

const {
  isTenantEmailSendReady,
  resolveFromEmailForTenant,
  platformDefaultFromEmail,
} = require('../tenantEmailFrom');

describe('tenantEmailFrom', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, DEFAULT_FROM_EMAIL: 'noreply@allaboard365.com' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses platform default when email not configured', () => {
    expect(resolveFromEmailForTenant(null)).toBe('noreply@allaboard365.com');
    expect(resolveFromEmailForTenant({ dkimEnabled: false })).toBe('noreply@allaboard365.com');
    expect(
      resolveFromEmailForTenant({
        dkimEnabled: true,
        customFromAddress: 'noreply@tenant.com',
        verificationStatus: 'pending',
      })
    ).toBe('noreply@allaboard365.com');
  });

  it('uses custom from when DKIM verified', () => {
    const email = {
      dkimEnabled: true,
      customFromAddress: 'noreply@sharewellpartners.com',
      verificationStatus: 'verified',
    };
    expect(isTenantEmailSendReady(email)).toBe(true);
    expect(resolveFromEmailForTenant(email)).toBe('noreply@sharewellpartners.com');
  });

  it('platformDefaultFromEmail reads env', () => {
    expect(platformDefaultFromEmail()).toBe('noreply@allaboard365.com');
  });
});

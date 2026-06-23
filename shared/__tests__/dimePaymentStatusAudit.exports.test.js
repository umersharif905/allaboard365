'use strict';

/**
 * Regression: DimePaymentStatusAuditTimer destructures these from the shared
 * module. listTenantIdsForDimeAudit was missing for weeks — the timer fired on
 * schedule but threw "listTenantIdsForDimeAudit is not a function" on every
 * run, so Pending payments never reconciled with DIME.
 */

describe('dimePaymentStatusAudit exports', () => {
  const mod = require('../dimePaymentStatusAudit');

  it('exports every function the DimePaymentStatusAuditTimer imports', () => {
    expect(typeof mod.runAudit).toBe('function');
    expect(typeof mod.listTenantIdsForDimeAudit).toBe('function');
  });

  it('timer module loads without throwing', () => {
    expect(() => require('../../DimePaymentStatusAuditTimer/index.js')).not.toThrow();
  });
});

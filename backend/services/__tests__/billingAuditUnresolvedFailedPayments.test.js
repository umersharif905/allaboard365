'use strict';

const {
  UNRESOLVED_FAILED_PAYMENTS_EXTRA_WHERE,
  UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE,
} = require('../billingAuditUnresolvedFailedPayments');

describe('billingAuditUnresolvedFailedPayments', () => {
  it('excludes failed payments when linked invoice is fulfilled by other successful payments', () => {
    expect(UNRESOLVED_FAILED_PAYMENTS_EXTRA_WHERE).toMatch(/FROM oe\.Invoices inv/);
    expect(UNRESOLVED_FAILED_PAYMENTS_EXTRA_WHERE).toMatch(/pOk\.InvoiceId = inv\.InvoiceId/);
    expect(UNRESOLVED_FAILED_PAYMENTS_EXTRA_WHERE).toMatch(/>= inv\.TotalAmount - 0\.005/);
  });

  it('still excludes later household/group successful payments', () => {
    expect(UNRESOLVED_FAILED_PAYMENTS_EXTRA_WHERE).toMatch(/pLater\.PaymentDate > p\.PaymentDate/);
  });

  it('full where includes failed status and retry guard', () => {
    expect(UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE).toMatch(/p\.Status = N'Failed'/);
    expect(UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE).toMatch(/p\.RetryDate IS NULL OR p\.RetryDate > GETUTCDATE\(\)/);
  });
});

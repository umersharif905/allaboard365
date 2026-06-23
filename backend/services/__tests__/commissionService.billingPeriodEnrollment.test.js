const CommissionService = require('../commissionService.advances');

describe('CommissionService.billingPeriodEnrollmentStatusSql', () => {
  it('allows Inactive enrollments that still cover the billed period', () => {
    const clause = CommissionService.billingPeriodEnrollmentStatusSql('e');
    expect(clause).toContain("e.Status NOT IN ('Pending', 'Cancelled', 'Denied')");
    expect(clause).not.toContain('Inactive');
  });
});

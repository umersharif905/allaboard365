const { resolveEmployeeDocAutoFill } = require('../proposalGenerator.service');

describe('resolveEmployeeDocAutoFill', () => {
  const ctxBase = {
    tierPricing: { EE: 100, ES: 200, EC: 250, EF: 400 },
    groupContributions: {
      tierContributions: {
        EE: { amount: 50, type: 'dollar' },
        ES: { amount: 25, type: 'percentage' }, // 25% of ES=$200 = $50
        // EC omitted -> $0
        EF: { amount: 0, type: 'dollar' },
      }
    }
  };

  it('GroupContributionEE: dollar type returns raw amount', () => {
    expect(resolveEmployeeDocAutoFill('GroupContributionEE', ctxBase)).toBe(50);
  });
  it('GroupContributionES: percentage type returns price * percent/100', () => {
    expect(resolveEmployeeDocAutoFill('GroupContributionES', ctxBase)).toBe(50);
  });
  it('GroupContributionEC: missing tier returns $0', () => {
    expect(resolveEmployeeDocAutoFill('GroupContributionEC', ctxBase)).toBe(0);
  });
  it('GroupContributionEF: explicit $0 returns 0', () => {
    expect(resolveEmployeeDocAutoFill('GroupContributionEF', ctxBase)).toBe(0);
  });
  it('EmployeeCostEE: price minus contribution', () => {
    expect(resolveEmployeeDocAutoFill('EmployeeCostEE', ctxBase)).toBe(50);
  });
  it('EmployeeCostES: handles percent contribution', () => {
    expect(resolveEmployeeDocAutoFill('EmployeeCostES', ctxBase)).toBe(150);
  });
  it('EmployeeCostEC: no contribution -> full price', () => {
    expect(resolveEmployeeDocAutoFill('EmployeeCostEC', ctxBase)).toBe(250);
  });
  it('EmployeeCostEF: never negative', () => {
    const ctx = { ...ctxBase, groupContributions: { tierContributions: { EF: { amount: 9999, type: 'dollar' } } } };
    expect(resolveEmployeeDocAutoFill('EmployeeCostEF', ctx)).toBe(0);
  });
  it('null groupContributions -> contribution 0, cost = price', () => {
    const ctx = { ...ctxBase, groupContributions: null };
    expect(resolveEmployeeDocAutoFill('GroupContributionEE', ctx)).toBe(0);
    expect(resolveEmployeeDocAutoFill('EmployeeCostEE', ctx)).toBe(100);
  });
  it('returns undefined for non-employee-scoped types (pass-through)', () => {
    expect(resolveEmployeeDocAutoFill('AgentName', ctxBase)).toBeUndefined();
  });
});

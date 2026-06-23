'use strict';

const {
  invoiceDueDateBeforeTenantLocalTodayPredicate,
  invoiceDueDateOnOrAfterTenantLocalTodayPredicate,
  invoicePastDueOpenBalancePredicate
} = require('../invoiceTenantCalendarSql');

describe('invoiceTenantCalendarSql overdue sync predicates', () => {
  it('past-due predicate compares DueDate to tenant-local today', () => {
    const sql = invoiceDueDateBeforeTenantLocalTodayPredicate('inv', 't');
    expect(sql).toContain('inv.DueDate');
    expect(sql).toContain('t.TimeZone');
    expect(sql).toMatch(/<\s*CAST/);
  });

  it('not-yet-due predicate is the complement of past-due', () => {
    const sql = invoiceDueDateOnOrAfterTenantLocalTodayPredicate('inv', 't');
    expect(sql).toContain('inv.DueDate');
    expect(sql).toMatch(/>=\s*CAST/);
  });

  it('past-due open balance includes Unpaid, Partial, and Overdue', () => {
    const sql = invoicePastDueOpenBalancePredicate('i', 't');
    expect(sql).toContain("N'Unpaid'");
    expect(sql).toContain("N'Partial'");
    expect(sql).toContain("N'Overdue'");
    expect(sql).toContain('i.BalanceDue > 0.005');
  });
});

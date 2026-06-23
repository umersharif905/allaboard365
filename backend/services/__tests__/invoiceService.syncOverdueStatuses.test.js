'use strict';

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: require('mssql'),
  rawSql: {}
}));

const { syncInvoiceOverdueStatuses } = require('../invoiceService');

describe('syncInvoiceOverdueStatuses', () => {
  it('marks past-due Unpaid/Partial as Overdue for all invoice types and resets premature Overdue', async () => {
    const queries = [];
    const pool = {
      request() {
        return {
          query: jest.fn(async (sql) => {
            queries.push(String(sql));
            return { rowsAffected: queries.length === 1 ? [12] : [3] };
          })
        };
      }
    };

    const stats = await syncInvoiceOverdueStatuses(pool);

    expect(stats).toEqual({ markedOverdue: 12, resetPrematureOverdue: 3 });
    expect(queries).toHaveLength(2);

    const markSql = queries[0];
    expect(markSql).toContain("SET Status = N'Overdue'");
    expect(markSql).toContain("inv.Status IN (N'Unpaid', N'Partial')");
    expect(markSql).toContain('inv.BalanceDue > 0.005');
    expect(markSql).not.toContain("InvoiceType = N'Individual'");

    const resetSql = queries[1];
    expect(resetSql).toContain("WHERE inv.Status = N'Overdue'");
    expect(resetSql).toContain("THEN N'Partial'");
    expect(resetSql).toContain("ELSE N'Unpaid'");
  });
});

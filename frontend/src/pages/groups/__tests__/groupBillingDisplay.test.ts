import { describe, expect, it } from 'vitest';
import { getInvoiceTableDisplay } from '../groupBillingDisplay';

const invoiceId = 'INV-001';

describe('getInvoiceTableDisplay', () => {
  it('shows Pending when invoice is Paid but a Pending payment exists (Leslie Brothers shape)', () => {
    const disp = getInvoiceTableDisplay(
      { InvoiceId: invoiceId, Status: 'Paid', DueDate: '2026-06-01' },
      [
        { InvoiceId: invoiceId, Status: 'Failed' },
        { InvoiceId: invoiceId, Status: 'Pending' },
      ]
    );
    expect(disp.label).toBe('Pending');
    expect(disp.paymentInFlight).toBe(true);
  });

  it('shows Paid when invoice is Paid and no in-flight payments', () => {
    const disp = getInvoiceTableDisplay(
      { InvoiceId: invoiceId, Status: 'Paid' },
      [{ InvoiceId: invoiceId, Status: 'Completed' }]
    );
    expect(disp.label).toBe('Paid');
    expect(disp.paymentInFlight).toBe(false);
  });

  it('shows Overdue when unpaid and no pending charge', () => {
    const disp = getInvoiceTableDisplay(
      { InvoiceId: invoiceId, Status: 'Overdue', DueDate: '2020-01-01' },
      [{ InvoiceId: invoiceId, Status: 'Failed' }]
    );
    expect(disp.label).toBe('Overdue');
    expect(disp.paymentInFlight).toBe(false);
  });

  it('keeps Failed history visible in payments list while badge shows Pending', () => {
    const payments = [
      { InvoiceId: invoiceId, Status: 'Failed' },
      { InvoiceId: invoiceId, Status: 'Pending' },
    ];
    expect(payments.filter((p) => p.InvoiceId === invoiceId)).toHaveLength(2);
    expect(getInvoiceTableDisplay({ InvoiceId: invoiceId, Status: 'Unpaid' }, payments).label).toBe(
      'Pending'
    );
  });
});

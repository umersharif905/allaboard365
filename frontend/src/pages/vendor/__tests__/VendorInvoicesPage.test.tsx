import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import VendorInvoicesPage from '../VendorInvoicesPage';

vi.mock('../../../services/vendor/vendorInvoices.service', () => ({
  fetchVendorInvoicePreview: vi.fn().mockResolvedValue({
    periodStart: '2026-05-01',
    periodEnd: '2026-06-01',
    tenants: [
      {
        tenantId: 't1',
        tenantName: 'Align Health',
        isExternal: true,
        expectedAmount: 100,
        lineCount: 2,
      },
    ],
    summary: { tenantCount: 1, lineCount: 2, grandTotal: 100 },
    warnings: [],
  }),
  downloadVendorInvoicesZip: vi.fn(),
}));

describe('VendorInvoicesPage', () => {
  it('renders invoices heading and month selector', () => {
    render(<VendorInvoicesPage />);
    expect(screen.getByRole('heading', { name: /Invoices/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('loads preview and shows tenant row', async () => {
    render(<VendorInvoicesPage />);
    fireEvent.click(screen.getByRole('button', { name: /Load preview/i }));
    expect(await screen.findByText('Align Health')).toBeInTheDocument();
    expect(screen.getAllByText(/\$100\.00/).length).toBeGreaterThan(0);
  });
});

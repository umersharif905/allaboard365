import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OutstandingInvoicePayPromptModal from '../OutstandingInvoicePayPromptModal';

const invoice = {
  invoiceId: 'inv-123',
  invoiceNumber: 'INV-2026-06',
  billingPeriodStart: '2026-06-01',
  billingPeriodEnd: '2026-06-30',
  balanceDue: 125.5,
  status: 'Overdue',
};

describe('OutstandingInvoicePayPromptModal', () => {
  it('39. shows invoice details when open', () => {
    render(
      <OutstandingInvoicePayPromptModal
        open
        invoice={invoice}
        onClose={vi.fn()}
        onPayNow={vi.fn()}
      />
    );
    expect(screen.getByText(/Pay outstanding invoice now/i)).toBeInTheDocument();
    expect(screen.getByText('INV-2026-06')).toBeInTheDocument();
    expect(screen.getByText('$125.50')).toBeInTheDocument();
  });

  it('40. Pay now calls onPayNow with invoice id', async () => {
    const onPayNow = vi.fn().mockResolvedValue({ success: true, data: { amount: 125.5 } });
    const onSuccess = vi.fn();
    render(
      <OutstandingInvoicePayPromptModal
        open
        invoice={invoice}
        onClose={vi.fn()}
        onPayNow={onPayNow}
        onSuccess={onSuccess}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Pay now/i }));
    await waitFor(() => {
      expect(onPayNow).toHaveBeenCalledWith('inv-123');
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it('41. Not now dismisses without charge', () => {
    const onClose = vi.fn();
    const onPayNow = vi.fn();
    render(
      <OutstandingInvoicePayPromptModal
        open
        invoice={invoice}
        onClose={onClose}
        onPayNow={onPayNow}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Not now/i }));
    expect(onClose).toHaveBeenCalled();
    expect(onPayNow).not.toHaveBeenCalled();
  });
});

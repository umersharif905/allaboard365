import type React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { test, expect, vi, beforeEach } from 'vitest';
import TpaForwardPreviewModal from '../TpaForwardPreviewModal';
import { caseForwardingService } from '../../../../services/caseForwarding.service';

vi.mock('../../../../services/caseForwarding.service', () => ({
  caseForwardingService: {
    getPreview: vi.fn(),
    send: vi.fn(),
  },
}));

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

beforeEach(() => {
  (caseForwardingService.getPreview as any).mockResolvedValue({
    success: true,
    data: {
      target: { targetId: 't1', label: 'ARM' },
      recipients: ['a@arm.com', 'b@arm.com'],
      subject: 'Reimbursement request — CASE-1',
      body: 'Body text',
      documents: [{ DocumentId: 'd1', DocumentName: 'Bill', FileName: 'bill.pdf' }],
      priorSends: [{ RecipientAddress: 'a@arm.com', Subject: 'x', SentDate: '2026-05-01T00:00:00Z', Status: 'Sent' }],
    },
  });
  (caseForwardingService.send as any).mockResolvedValue({ success: true, data: { messageId: 'm', recipients: ['a@arm.com'] } });
});

test('shows recipients, prior-send warning, and sends selected', async () => {
  wrap(<TpaForwardPreviewModal caseId="c1" isOpen onClose={() => {}} />);
  await waitFor(() => screen.getByText(/Reimbursement request/));
  expect(screen.getByText(/Already sent/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  await waitFor(() => expect(caseForwardingService.send).toHaveBeenCalled());
  const arg = (caseForwardingService.send as any).mock.calls[0][1];
  expect(arg.to).toContain('a@arm.com');
});

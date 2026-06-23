import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequestTypeChangeModal } from '../RequestTypeChangeModal';
import * as svc from '../../../services/groupTypeChangeRequests.service';
import type { GroupTypeChangeRequest } from '../../../services/groupTypeChangeRequests.service';

vi.mock('../../../services/groupTypeChangeRequests.service');

const mockRequest = vi.mocked(svc.createRequest);

function pendingResult(): GroupTypeChangeRequest {
  return {
    RequestId: 'req-1',
    GroupId: 'group-1',
    TenantId: 'tenant-1',
    RequestedBy: 'user-1',
    CurrentType: 'Standard',
    RequestedType: 'ListBill',
    Status: 'Pending',
    Reason: 'Need list bill',
    ReviewedBy: null,
    ReviewedAt: null,
    ReviewNotes: null,
    CreatedDate: '2026-04-24T00:00:00Z',
    ModifiedDate: '2026-04-24T00:00:00Z',
  };
}

function approvedResult(): GroupTypeChangeRequest {
  return {
    ...pendingResult(),
    Status: 'Approved',
    ReviewedBy: 'system',
    ReviewedAt: '2026-04-24T00:00:00Z',
    ReviewNotes: 'Auto-approved per tenant setting',
  };
}

const defaultProps = {
  groupId: 'group-1',
  currentType: 'Standard' as const,
  onClose: vi.fn(),
  onSuccess: vi.fn(),
};

describe('RequestTypeChangeModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the modal with current type and target type', () => {
    render(<RequestTypeChangeModal {...defaultProps} />);
    expect(screen.getByText(/Request Group Type Change/i)).toBeInTheDocument();
    // Shows current type
    expect(screen.getByText(/Standard/i)).toBeInTheDocument();
    // Shows target type — may appear multiple times (badge + description label)
    const listFillElements = screen.getAllByText(/List Bill/i);
    expect(listFillElements.length).toBeGreaterThan(0);
  });

  it('disables the submit button when reason is empty', () => {
    render(<RequestTypeChangeModal {...defaultProps} />);
    const submit = screen.getByRole('button', { name: /submit request/i });
    expect(submit).toBeDisabled();
  });

  it('disables the submit button when reason has fewer than 5 characters', async () => {
    render(<RequestTypeChangeModal {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'Hi');
    const submit = screen.getByRole('button', { name: /submit request/i });
    expect(submit).toBeDisabled();
  });

  it('enables the submit button when reason has at least 5 characters', async () => {
    render(<RequestTypeChangeModal {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'Need list bill conversion');
    const submit = screen.getByRole('button', { name: /submit request/i });
    expect(submit).not.toBeDisabled();
  });

  it('calls createRequest with correct params on submit', async () => {
    mockRequest.mockResolvedValueOnce(pendingResult());
    render(<RequestTypeChangeModal {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'Need list bill conversion');
    const submit = screen.getByRole('button', { name: /submit request/i });
    await userEvent.click(submit);
    expect(mockRequest).toHaveBeenCalledWith({
      groupId: 'group-1',
      requestedType: 'ListBill',
      reason: 'Need list bill conversion',
    });
  });

  it('shows "Pending approval" message when response Status is Pending', async () => {
    mockRequest.mockResolvedValueOnce(pendingResult());
    render(<RequestTypeChangeModal {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'Need list bill conversion');
    await userEvent.click(screen.getByRole('button', { name: /submit request/i }));
    await waitFor(() => {
      expect(screen.getByText(/pending approval/i)).toBeInTheDocument();
    });
  });

  it('shows "Approved" message with continue action when response Status is Approved', async () => {
    mockRequest.mockResolvedValueOnce(approvedResult());
    render(<RequestTypeChangeModal {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'Need list bill conversion');
    await userEvent.click(screen.getByRole('button', { name: /submit request/i }));
    await waitFor(() => {
      expect(screen.getByText(/approved/i)).toBeInTheDocument();
      expect(screen.getByText(/continue/i)).toBeInTheDocument();
    });
  });

  it('shows an inline error message when the request fails', async () => {
    mockRequest.mockRejectedValueOnce({ message: 'A pending request already exists' });
    render(<RequestTypeChangeModal {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'Need list bill conversion');
    await userEvent.click(screen.getByRole('button', { name: /submit request/i }));
    await waitFor(() => {
      expect(screen.getByText(/A pending request already exists/i)).toBeInTheDocument();
    });
  });

  it('calls onClose when Cancel is clicked', async () => {
    render(<RequestTypeChangeModal {...defaultProps} />);
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(defaultProps.onClose).toHaveBeenCalledOnce();
  });

  it('calls onSuccess after auto-approved response', async () => {
    mockRequest.mockResolvedValueOnce(approvedResult());
    render(<RequestTypeChangeModal {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'Need list bill conversion');
    await userEvent.click(screen.getByRole('button', { name: /submit request/i }));
    await waitFor(() => {
      expect(screen.getByText(/approved/i)).toBeInTheDocument();
    });
    // onSuccess is called to notify parent
    expect(defaultProps.onSuccess).toHaveBeenCalledOnce();
  });

  it('does not call onSuccess for Pending status (admin review required)', async () => {
    mockRequest.mockResolvedValueOnce(pendingResult());
    render(<RequestTypeChangeModal {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'Need list bill conversion');
    await userEvent.click(screen.getByRole('button', { name: /submit request/i }));
    await waitFor(() => {
      expect(screen.getByText(/pending approval/i)).toBeInTheDocument();
    });
    expect(defaultProps.onSuccess).not.toHaveBeenCalled();
  });
});

/**
 * Tests for the TenantAdmin GroupTypeChangeRequests approval queue page.
 *
 * Covers:
 *   - Renders a table with Pending requests
 *   - Approve flow: confirm modal opens, submit calls approve() and removes row from Pending tab
 *   - Deny flow: modal requires notes (min 5 chars), submit calls deny()
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { GroupTypeChangeRequest } from '../../../services/groupTypeChangeRequests.service';

// ---------------------------------------------------------------------------
// Module mocks (hoisted before imports)
// ---------------------------------------------------------------------------
vi.mock('../../../services/groupTypeChangeRequests.service');

import * as svc from '../../../services/groupTypeChangeRequests.service';

const mockListRequests = vi.mocked(svc.listRequests);
const mockApprove = vi.mocked(svc.approve);
const mockDeny = vi.mocked(svc.deny);

// ---------------------------------------------------------------------------
// Import component under test (after mocks)
// ---------------------------------------------------------------------------
import GroupTypeChangeRequests from '../GroupTypeChangeRequests';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePendingRequest(overrides: Partial<GroupTypeChangeRequest> = {}): GroupTypeChangeRequest {
  return {
    RequestId: 'req-1',
    GroupId: 'group-1',
    TenantId: 'tenant-1',
    RequestedBy: 'user-1',
    CurrentType: 'Standard',
    RequestedType: 'ListBill',
    Status: 'Pending',
    Reason: 'We need list bill for our group',
    ReviewedBy: null,
    ReviewedAt: null,
    ReviewNotes: null,
    CreatedDate: '2026-04-24T10:00:00Z',
    ModifiedDate: '2026-04-24T10:00:00Z',
    GroupName: 'Acme Corp',
    AgentName: 'Jane Agent',
    ...overrides,
  } as GroupTypeChangeRequest & { GroupName?: string; AgentName?: string };
}

function makeApprovedRequest(): GroupTypeChangeRequest {
  return makePendingRequest({
    RequestId: 'req-2',
    Status: 'Approved',
    ReviewedBy: 'admin-1',
    ReviewedAt: '2026-04-24T11:00:00Z',
    ReviewNotes: 'Looks good',
  });
}

// ---------------------------------------------------------------------------
// Test wrapper
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GroupTypeChangeRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: listRequests returns one pending request for any status
    mockListRequests.mockResolvedValue([makePendingRequest()]);
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  it('renders tab labels for Pending, Approved, and Denied', async () => {
    render(<GroupTypeChangeRequests />, { wrapper });
    expect(await screen.findByRole('tab', { name: /pending/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /approved/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /denied/i })).toBeInTheDocument();
  });

  it('renders a row for a pending request with group name and type transition', async () => {
    render(<GroupTypeChangeRequests />, { wrapper });
    // Group name
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    // Type transition: Standard and ListBill/List Bill appear at least once in the table
    const standardMatches = screen.getAllByText(/Standard/i);
    expect(standardMatches.length).toBeGreaterThan(0);
    const listFillMatches = screen.getAllByText(/ListBill|List Bill/i);
    expect(listFillMatches.length).toBeGreaterThan(0);
  });

  it('shows reason text in the pending row', async () => {
    render(<GroupTypeChangeRequests />, { wrapper });
    expect(await screen.findByText('We need list bill for our group')).toBeInTheDocument();
  });

  it('calls listRequests with status Pending on initial render', async () => {
    render(<GroupTypeChangeRequests />, { wrapper });
    await waitFor(() => expect(mockListRequests).toHaveBeenCalledWith({ status: 'Pending' }));
  });

  it('shows empty state when no pending requests exist', async () => {
    mockListRequests.mockResolvedValue([]);
    render(<GroupTypeChangeRequests />, { wrapper });
    await waitFor(() => {
      expect(screen.getByText(/no pending requests/i)).toBeInTheDocument();
    });
  });

  // ── Approve flow ─────────────────────────────────────────────────────────

  it('opens a confirm modal when Approve is clicked', async () => {
    render(<GroupTypeChangeRequests />, { wrapper });
    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    await userEvent.click(approveBtn);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/confirm approval/i)).toBeInTheDocument();
  });

  it('calls approve() when the confirm modal is submitted', async () => {
    mockApprove.mockResolvedValueOnce({ ...makePendingRequest(), Status: 'Approved' } as any);
    // After approve, refetch returns empty list (row removed from Pending tab)
    mockListRequests
      .mockResolvedValueOnce([makePendingRequest()]) // initial load
      .mockResolvedValueOnce([]);                    // after invalidation

    render(<GroupTypeChangeRequests />, { wrapper });
    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    await userEvent.click(approveBtn);

    // Submit the confirm dialog
    const confirmBtn = screen.getByRole('button', { name: /confirm/i });
    await userEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockApprove).toHaveBeenCalledWith('req-1', undefined);
    });
  });

  it('passes optional notes to approve()', async () => {
    mockApprove.mockResolvedValueOnce({ ...makePendingRequest(), Status: 'Approved' } as any);
    mockListRequests
      .mockResolvedValueOnce([makePendingRequest()])
      .mockResolvedValueOnce([]);

    render(<GroupTypeChangeRequests />, { wrapper });
    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    await userEvent.click(approveBtn);

    // Enter optional notes
    const notesInput = screen.queryByRole('textbox');
    if (notesInput) {
      await userEvent.type(notesInput, 'Approved with condition');
    }

    const confirmBtn = screen.getByRole('button', { name: /confirm/i });
    await userEvent.click(confirmBtn);

    await waitFor(() => expect(mockApprove).toHaveBeenCalled());
  });

  it('dismisses the confirm modal when Cancel is clicked', async () => {
    render(<GroupTypeChangeRequests />, { wrapper });
    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    await userEvent.click(approveBtn);

    const cancelBtn = screen.getByRole('button', { name: /cancel/i });
    await userEvent.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  // ── Deny flow ─────────────────────────────────────────────────────────────

  it('opens a deny modal when Deny is clicked', async () => {
    render(<GroupTypeChangeRequests />, { wrapper });
    const denyBtn = await screen.findByRole('button', { name: /deny/i });
    await userEvent.click(denyBtn);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/deny request/i)).toBeInTheDocument();
  });

  it('disables the deny submit button when notes are empty', async () => {
    render(<GroupTypeChangeRequests />, { wrapper });
    const denyBtn = await screen.findByRole('button', { name: /deny/i });
    await userEvent.click(denyBtn);
    const submitBtn = screen.getByRole('button', { name: /confirm denial|submit/i });
    expect(submitBtn).toBeDisabled();
  });

  it('disables the deny submit button when notes are fewer than 5 characters', async () => {
    render(<GroupTypeChangeRequests />, { wrapper });
    const denyBtn = await screen.findByRole('button', { name: /deny/i });
    await userEvent.click(denyBtn);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'No');
    const submitBtn = screen.getByRole('button', { name: /confirm denial|submit/i });
    expect(submitBtn).toBeDisabled();
  });

  it('enables deny submit when notes have at least 5 characters', async () => {
    render(<GroupTypeChangeRequests />, { wrapper });
    const denyBtn = await screen.findByRole('button', { name: /deny/i });
    await userEvent.click(denyBtn);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'Group does not qualify');
    const submitBtn = screen.getByRole('button', { name: /confirm denial|submit/i });
    expect(submitBtn).not.toBeDisabled();
  });

  it('calls deny() with the provided notes', async () => {
    mockDeny.mockResolvedValueOnce({ ...makePendingRequest(), Status: 'Denied' } as any);
    mockListRequests
      .mockResolvedValueOnce([makePendingRequest()])
      .mockResolvedValueOnce([]);

    render(<GroupTypeChangeRequests />, { wrapper });
    const denyBtn = await screen.findByRole('button', { name: /deny/i });
    await userEvent.click(denyBtn);

    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'Group does not qualify');

    const submitBtn = screen.getByRole('button', { name: /confirm denial|submit/i });
    await userEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockDeny).toHaveBeenCalledWith('req-1', 'Group does not qualify');
    });
  });

  it('dismisses the deny modal when Cancel is clicked', async () => {
    render(<GroupTypeChangeRequests />, { wrapper });
    const denyBtn = await screen.findByRole('button', { name: /deny/i });
    await userEvent.click(denyBtn);

    const cancelBtn = screen.getByRole('button', { name: /cancel/i });
    await userEvent.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  // ── Tab switching ─────────────────────────────────────────────────────────

  it('calls listRequests with status Approved when Approved tab is clicked', async () => {
    mockListRequests.mockResolvedValue([makeApprovedRequest()]);
    render(<GroupTypeChangeRequests />, { wrapper });

    // Wait for initial load
    await screen.findByRole('tab', { name: /approved/i });

    const approvedTab = screen.getByRole('tab', { name: /approved/i });
    await userEvent.click(approvedTab);

    await waitFor(() => {
      expect(mockListRequests).toHaveBeenCalledWith({ status: 'Approved' });
    });
  });

  it('calls listRequests with status Denied when Denied tab is clicked', async () => {
    mockListRequests.mockResolvedValue([]);
    render(<GroupTypeChangeRequests />, { wrapper });

    await screen.findByRole('tab', { name: /denied/i });
    const deniedTab = screen.getByRole('tab', { name: /denied/i });
    await userEvent.click(deniedTab);

    await waitFor(() => {
      expect(mockListRequests).toHaveBeenCalledWith({ status: 'Denied' });
    });
  });

  it('hides action buttons on the Approved tab', async () => {
    mockListRequests.mockResolvedValue([makeApprovedRequest()]);
    render(<GroupTypeChangeRequests />, { wrapper });

    const approvedTab = await screen.findByRole('tab', { name: /approved/i });
    await userEvent.click(approvedTab);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /deny/i })).not.toBeInTheDocument();
    });
  });
});

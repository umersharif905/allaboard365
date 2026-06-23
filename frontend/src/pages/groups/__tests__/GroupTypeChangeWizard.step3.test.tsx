/**
 * GroupTypeChangeWizard — Step 3 (Confirm) tests
 *
 * Covers:
 *   - Step 3 renders confirmation screen with correct counts
 *   - "Apply conversion" button is disabled until "I understand" is checked
 *   - Clicking "Apply conversion" calls apply() with correct payload
 *   - On success, advances to Step 4
 *   - On failure, shows inline error message (no step change)
 *   - Back button returns to Step 2
 *
 * Run: npx vitest run src/pages/groups/__tests__/GroupTypeChangeWizard.step3.test.tsx
 */

import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../../services/groupTypeChangeWizard.service');
vi.mock('../../../services/enrollment-link-templates.service');

import * as svc from '../../../services/groupTypeChangeWizard.service';
import { EnrollmentLinkTemplatesService } from '../../../services/enrollment-link-templates.service';
import type { TypeChangePreview, ApplyResult } from '../../../services/groupTypeChangeWizard.service';

const mockGetPreview = vi.mocked(svc.getPreview);
const mockApply = vi.mocked(svc.apply);
const mockGetAvailableProducts = vi.mocked(svc.getAvailableProducts);
const mockGetTemplates = vi.mocked(EnrollmentLinkTemplatesService.getTemplates);

// ---------------------------------------------------------------------------
// Import component
// ---------------------------------------------------------------------------
import GroupTypeChangeWizard from '../GroupTypeChangeWizard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptyPreview(): TypeChangePreview {
  return { targetType: 'ListBill', members: [], membersWithoutEnrollments: [] };
}

function makeProductsResponse() {
  return {
    group: { GroupId: 'group-123', Name: 'Test Group', TenantId: 'tenant-1', Status: 'Active' },
    groupProducts: [],
    availableProducts: [
      {
        ProductId: 'p1',
        Name: 'Individual Plan A',
        ProductType: 'Medical',
        Description: '',
        BasePrice: 10,
        ProductOwner: 'Acme Vendor',
        AllowedStates: [],
        MinAge: 18,
        MaxAge: 65,
        SalesType: 'Individual',
        IsActive: true
      }
    ]
  };
}

function makeApplyResult(overrides: Partial<ApplyResult> = {}): ApplyResult {
  return {
    productsHidden: 1,
    productsAdded: 1,
    preservedEnrollmentsRepointed: 0,
    enrollmentsTerminationScheduled: 0,
    householdIdsCleared: 2,
    enrollmentsCancelled: 3,
    groupType: 'ListBill',
    ...overrides
  };
}

function renderWizard(groupId = 'group-123') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });

  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/groups/${groupId}/type-change/wizard`]}>
        <Routes>
          <Route
            path="/groups/:identifier/type-change/wizard"
            element={<GroupTypeChangeWizard />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Navigate from Step 1 → Step 2 → select product → Step 3 */
async function advanceToStep3() {
  mockGetPreview.mockResolvedValue(makeEmptyPreview());
  mockGetAvailableProducts.mockResolvedValue(makeProductsResponse() as any);
  // Step 4 template fetch — return empty list so Step 4 renders without blocking
  mockGetTemplates.mockResolvedValue({
    success: true,
    data: { data: [], total: 0, page: 1, limit: 50 }
  } as any);

  renderWizard();

  // Step 1 → 2
  await waitFor(() => {
    expect(screen.queryByText(/loading enrollment preview/i)).not.toBeInTheDocument();
  });
  await userEvent.click(screen.getByRole('button', { name: /next/i }));

  // Step 2: wait for products to load, select one, click Next
  await waitFor(() => {
    expect(screen.getByTestId('product-checkbox-p1')).toBeInTheDocument();
  });
  await userEvent.click(screen.getByTestId('product-checkbox-p1'));
  await userEvent.click(screen.getByTestId('step2-next'));

  // Should now be on Step 3
  await waitFor(() => {
    expect(screen.getByText(/confirm conversion/i)).toBeInTheDocument();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GroupTypeChangeWizard — Step 3 (Confirm)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the confirmation screen with counts', async () => {
    mockApply.mockResolvedValue(makeApplyResult());

    await advanceToStep3();

    // Products being added count (1 selected in step 2)
    await waitFor(() => {
      expect(screen.getByText(/confirm conversion/i)).toBeInTheDocument();
      expect(screen.getByText(/products being added to the group/i)).toBeInTheDocument();
    });
  });

  it('shows household clear count from reEnrollMemberIds (0 in this flow)', async () => {
    mockApply.mockResolvedValue(makeApplyResult());

    await advanceToStep3();

    await waitFor(() => {
      const countEl = screen.getByTestId('confirm-household-count');
      // No reEnroll members in the empty preview
      expect(countEl).toHaveTextContent('0');
    });
  });

  it('disables "Apply conversion" until "I understand" is checked', async () => {
    mockApply.mockResolvedValue(makeApplyResult());

    await advanceToStep3();

    const applyBtn = screen.getByTestId('step3-apply');
    expect(applyBtn).toBeDisabled();

    const checkbox = screen.getByTestId('confirm-understood');
    await userEvent.click(checkbox);

    expect(applyBtn).not.toBeDisabled();
  });

  it('calls apply() with correct groupId and payload when confirmed', async () => {
    mockApply.mockResolvedValue(makeApplyResult());

    await advanceToStep3();

    const checkbox = screen.getByTestId('confirm-understood');
    await userEvent.click(checkbox);

    await userEvent.click(screen.getByTestId('step3-apply'));

    await waitFor(() => {
      expect(mockApply).toHaveBeenCalledWith('group-123', {
        productIds: ['p1'],
        memberIdsToReEnroll: [],
        preserveMappings: [],
        memberIdsToLetFinish: []
      });
    });
  });

  it('advances to Step 4 (Links) on successful apply', async () => {
    mockApply.mockResolvedValue(makeApplyResult());

    await advanceToStep3();

    const checkbox = screen.getByTestId('confirm-understood');
    await userEvent.click(checkbox);

    await userEvent.click(screen.getByTestId('step3-apply'));

    await waitFor(() => {
      // Step 4 shows the resend links heading
      expect(screen.getByText(/send enrollment links/i)).toBeInTheDocument();
      // Step 3 Confirm screen no longer visible
      expect(screen.queryByText(/confirm conversion/i)).not.toBeInTheDocument();
    });
  });

  it('shows inline error and does not advance when apply() throws', async () => {
    mockApply.mockRejectedValue(new Error('Apply failed — transaction rolled back.'));

    await advanceToStep3();

    const checkbox = screen.getByTestId('confirm-understood');
    await userEvent.click(checkbox);

    await userEvent.click(screen.getByTestId('step3-apply'));

    await waitFor(() => {
      expect(screen.getByTestId('step3-error')).toHaveTextContent(/apply failed/i);
      // Still on Step 3
      expect(screen.getByText(/confirm conversion/i)).toBeInTheDocument();
    });
  });

  it('returns to Step 2 when Back is clicked', async () => {
    await advanceToStep3();

    // There are two "back"-ish buttons: the header arrow and the step Back button.
    // The step Back button is inside the step content area and has visible text "Back".
    const allBackBtns = screen.getAllByRole('button', { name: /back/i });
    // The last one is the in-step Back button (header arrow has aria-label "Go back")
    const stepBackBtn = allBackBtns.find(btn => btn.textContent?.trim().includes('Back'));
    expect(stepBackBtn).toBeDefined();
    await userEvent.click(stepBackBtn!);

    await waitFor(() => {
      expect(screen.getByText(/select individual products/i)).toBeInTheDocument();
    });
  });
});

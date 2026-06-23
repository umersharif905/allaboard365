/**
 * GroupTypeChangeWizard — Step 1 (Review) tests
 *
 * Covers:
 *   - Progress bar renders 5 step labels
 *   - Two collapsible sections render (Re-enroll / Let finish) — preserve
 *     bucket was dropped, every member is now one of these two actions
 *   - Member names appear in the correct section
 *   - Each member row shows a one-line summary, not nested per-enrollment chips
 *   - Let-finish section shows the end-of-month deadline callout
 *   - Loading state renders
 *   - Error state renders when service rejects
 *   - Empty state renders when no members are returned
 *   - "Next" button advances to Step 2
 *
 * Run: npx vitest run src/pages/groups/__tests__/GroupTypeChangeWizard.step1.test.tsx
 */

import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Mock the service before any component imports
// ---------------------------------------------------------------------------
vi.mock('../../../services/groupTypeChangeWizard.service');
vi.mock('../../../services/group-products.service');

import * as svc from '../../../services/groupTypeChangeWizard.service';
import type { TypeChangePreview, PreviewMember } from '../../../services/groupTypeChangeWizard.service';
import { GroupProductsService } from '../../../services/group-products.service';

const mockGetPreview = vi.mocked(svc.getPreview);
const mockGetGroupProducts = vi.mocked(GroupProductsService.getGroupProducts);

// ---------------------------------------------------------------------------
// Import component under test
// ---------------------------------------------------------------------------
import GroupTypeChangeWizard from '../GroupTypeChangeWizard';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeReEnrollMember(overrides: Partial<PreviewMember> = {}): PreviewMember {
  return {
    memberId: 'member-reenroll-1',
    displayName: 'Bob ReEnroll',
    action: 'reEnroll',
    enrollments: [
      {
        enrollmentId: 'enroll-2',
        productId: 'product-2',
        productName: 'Group Dental Plan',
        vendorId: 'vendor-2',
        productType: 'Dental',
        effectiveDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
        status: 'Pending',
        matchingIndividualProduct: null,
        action: 'reEnroll'
      }
    ],
    ...overrides
  };
}

function makeLetFinishMember(overrides: Partial<PreviewMember> = {}): PreviewMember {
  return {
    memberId: 'member-letfinish-1',
    displayName: 'Carol LetFinish',
    action: 'letFinishThenCancel',
    enrollments: [
      {
        enrollmentId: 'enroll-3',
        productId: 'product-3',
        productName: 'Group Vision Plan',
        vendorId: 'vendor-3',
        productType: 'Vision',
        effectiveDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        status: 'Active',
        matchingIndividualProduct: null,
        action: 'letFinishThenCancel'
      }
    ],
    ...overrides
  };
}

function makePreview(members: PreviewMember[]): TypeChangePreview {
  return { targetType: 'ListBill', members, membersWithoutEnrollments: [] };
}

// ---------------------------------------------------------------------------
// Test wrapper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GroupTypeChangeWizard — Step 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Progress bar ─────────────────────────────────────────────────────────

  it('renders all 5 step labels in the progress bar', async () => {
    mockGetPreview.mockResolvedValue(makePreview([]));
    renderWizard();

    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Products')).toBeInTheDocument();
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.getByText('Links')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  // ── Loading state ────────────────────────────────────────────────────────

  it('shows a loading message while the preview is loading', () => {
    // Never resolves — stays in loading state
    mockGetPreview.mockReturnValue(new Promise(() => {}));
    renderWizard();

    expect(screen.getByText(/loading enrollment preview/i)).toBeInTheDocument();
  });

  // ── Error state ──────────────────────────────────────────────────────────

  it('shows an error message when the service rejects', async () => {
    mockGetPreview.mockRejectedValue(new Error('No approved type change request for this group.'));
    renderWizard();

    await waitFor(() => {
      expect(screen.getByText(/no approved type change request/i)).toBeInTheDocument();
    });
  });

  // ── Empty state ──────────────────────────────────────────────────────────

  it('shows empty state when no members are returned', async () => {
    mockGetPreview.mockResolvedValue(makePreview([]));
    renderWizard();

    await waitFor(() => {
      expect(
        screen.getByText(/no members have active or upcoming enrollments/i)
      ).toBeInTheDocument();
    });
  });

  // ── Two sections render ──────────────────────────────────────────────────
  //
  // Preserve was retired. Step 1 now bucket members into reEnroll OR
  // letFinishThenCancel only; the green "section-preserve" group is gone.

  it('renders both action sections when both action types are present', async () => {
    mockGetPreview.mockResolvedValue(
      makePreview([makeReEnrollMember(), makeLetFinishMember()])
    );
    renderWizard();

    await waitFor(() => {
      expect(screen.getByTestId('section-reEnroll')).toBeInTheDocument();
      expect(screen.getByTestId('section-letFinishThenCancel')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('section-preserve')).not.toBeInTheDocument();
  });

  // ── Member names appear in correct sections ───────────────────────────────

  it('shows member names in the Re-enroll section', async () => {
    mockGetPreview.mockResolvedValue(makePreview([makeReEnrollMember()]));
    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('Bob ReEnroll')).toBeInTheDocument();
    });
  });

  it('shows member names in the Let finish, then cancel section', async () => {
    mockGetPreview.mockResolvedValue(makePreview([makeLetFinishMember()]));
    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('Carol LetFinish')).toBeInTheDocument();
    });
  });

  it('shows both member names when both action types are present', async () => {
    mockGetPreview.mockResolvedValue(
      makePreview([makeReEnrollMember(), makeLetFinishMember()])
    );
    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('Bob ReEnroll')).toBeInTheDocument();
      expect(screen.getByText('Carol LetFinish')).toBeInTheDocument();
    });
  });

  // ── Section counts ───────────────────────────────────────────────────────

  it('shows correct member count per section', async () => {
    mockGetPreview.mockResolvedValue(
      makePreview([
        makeReEnrollMember(),
        makeReEnrollMember({ memberId: 'reenroll-2', displayName: 'Dave ReEnroll' }),
        makeLetFinishMember()
      ])
    );
    renderWizard();

    await waitFor(() => {
      // ReEnroll section shows "2 members"
      const reEnrollSection = screen.getByTestId('section-reEnroll');
      expect(reEnrollSection).toHaveTextContent('2 members');

      // LetFinish section shows "1 member"
      const letFinishSection = screen.getByTestId('section-letFinishThenCancel');
      expect(letFinishSection).toHaveTextContent('1 member');
    });
  });

  // ── Member row format: name + one-line summary, no per-enrollment chips ──

  it('renders one row per member with an enrollment-count summary, not nested per-enrollment chips', async () => {
    mockGetPreview.mockResolvedValue(
      makePreview([
        makeReEnrollMember({
          memberId: 'm-multi',
          displayName: 'Multi Enrollment',
          enrollments: [
            {
              enrollmentId: 'e1',
              productId: 'p1',
              productName: 'Plan One',
              vendorId: 'v1',
              productType: 'Medical',
              effectiveDate: new Date(Date.now() + 30 * 86400000).toISOString(),
              status: 'Pending',
              matchingIndividualProduct: null,
              action: 'reEnroll'
            },
            {
              enrollmentId: 'e2',
              productId: 'p2',
              productName: 'Plan Two',
              vendorId: 'v1',
              productType: 'Dental',
              effectiveDate: new Date(Date.now() + 30 * 86400000).toISOString(),
              status: 'Pending',
              matchingIndividualProduct: null,
              action: 'reEnroll'
            }
          ]
        })
      ])
    );
    renderWizard();

    await waitFor(() => {
      expect(screen.getByText('Multi Enrollment')).toBeInTheDocument();
    });

    // Summary text: "2 enrollments — re-enroll required"
    expect(screen.getByText(/2 enrollments — re-enroll required/i)).toBeInTheDocument();
    // Per-enrollment product names should NOT be rendered
    expect(screen.queryByText('Plan One')).not.toBeInTheDocument();
    expect(screen.queryByText('Plan Two')).not.toBeInTheDocument();
  });

  // ── Let-finish deadline callout ──────────────────────────────────────────

  it('shows the end-of-month deadline callout in the let-finish section when it has members', async () => {
    mockGetPreview.mockResolvedValue(makePreview([makeLetFinishMember()]));
    renderWizard();

    await waitFor(() => {
      expect(screen.getByTestId('letfinish-deadline-callout')).toBeInTheDocument();
    });
    expect(screen.getByTestId('letfinish-deadline-callout')).toHaveTextContent(/re-enrolled in the new products before/i);
  });

  // ── Next button advances to Step 2 ──────────────────────────────────────

  it('advances to step 2 (Products) when Next is clicked', async () => {
    mockGetPreview.mockResolvedValue(makePreview([]));
    // Step 2 now renders the real product picker — provide an empty response
    mockGetGroupProducts.mockResolvedValue({
      success: true,
      data: {
        group: { GroupId: 'group-123', Name: 'Test Group', TenantId: 'tenant-1', Status: 'Active' },
        groupProducts: [],
        availableProducts: []
      }
    } as any);

    renderWizard();

    // Wait for loading to finish
    await waitFor(() => {
      expect(screen.queryByText(/loading enrollment preview/i)).not.toBeInTheDocument();
    });

    const nextBtn = screen.getByRole('button', { name: /next/i });
    await userEvent.click(nextBtn);

    // Step 2 real picker heading
    await waitFor(() => {
      expect(screen.getByText(/select individual products/i)).toBeInTheDocument();
    });
  });

  // ── getPreview called with correct groupId ────────────────────────────────

  it('calls getPreview with the groupId from the URL', async () => {
    mockGetPreview.mockResolvedValue(makePreview([]));
    renderWizard('my-test-group');

    await waitFor(() => {
      expect(mockGetPreview).toHaveBeenCalledWith('my-test-group');
    });
  });
});

/**
 * GroupTypeChangeWizard — Step 2 (Products) tests
 *
 * Covers:
 *   - Step 2 renders after clicking Next on Step 1
 *   - Loading state shown while products load
 *   - Products are rendered grouped by vendor (ProductOwner)
 *   - Only Individual/Both SalesType products are shown
 *   - Checkboxes are pre-selected for products already on the group
 *     with SalesType=Individual/Both
 *   - Products with SalesType=Group are excluded
 *   - Selecting/deselecting a checkbox updates selection
 *   - Clicking Next without selection shows inline error
 *   - Clicking Next with ≥1 selection advances to Step 3
 *
 * Run: npx vitest run src/pages/groups/__tests__/GroupTypeChangeWizard.step2.test.tsx
 */

import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Mock the wizard service. Step 2 uses the wizard-specific
// `getAvailableProducts` endpoint (not the legacy `GroupProductsService`).
// ---------------------------------------------------------------------------
vi.mock('../../../services/groupTypeChangeWizard.service');

import * as svc from '../../../services/groupTypeChangeWizard.service';
import type { TypeChangePreview } from '../../../services/groupTypeChangeWizard.service';

const mockGetPreview = vi.mocked(svc.getPreview);
const mockGetAvailableProducts = vi.mocked(svc.getAvailableProducts);

// ---------------------------------------------------------------------------
// Import component under test
// ---------------------------------------------------------------------------
import GroupTypeChangeWizard from '../GroupTypeChangeWizard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptyPreview(targetType: 'ListBill' | 'Standard' = 'ListBill'): TypeChangePreview {
  return { targetType, members: [], membersWithoutEnrollments: [] };
}

// getAvailableProducts already unwraps the API envelope, returning the bare
// data shape. The mock returns the same shape directly.
function makeAvailableProductsResponse(overrides: {
  groupProducts?: any[];
  availableProducts?: any[];
} = {}) {
  return {
    group: { GroupId: 'group-123', Name: 'Test Group', TenantId: 'tenant-1', Status: 'Active' },
    groupProducts: overrides.groupProducts ?? [],
    availableProducts: overrides.availableProducts ?? []
  };
}

function makeProduct(overrides: {
  ProductId?: string;
  Name?: string;
  SalesType?: string;
  ProductOwner?: string;
  ProductType?: string;
} = {}) {
  return {
    ProductId: 'product-1',
    Name: 'Individual Medical Plan',
    ProductType: 'Medical',
    Description: '',
    BasePrice: 10,
    ProductOwner: 'Acme Vendor',
    AllowedStates: [],
    MinAge: 18,
    MaxAge: 65,
    SalesType: 'Individual',
    IsActive: true,
    ...overrides
  };
}

function makeGroupProduct(productId: string, salesType = 'Individual') {
  return {
    GroupProductId: `gp-${productId}`,
    GroupId: 'group-123',
    ProductId: productId,
    IsAssigned: true,
    IsActive: true,
    CustomSettings: null,
    CreatedDate: new Date().toISOString(),
    Name: `Product ${productId}`,
    ProductType: 'Medical',
    ProductStatus: 'Active',
    MinAge: 18,
    MaxAge: 65,
    SalesType: salesType,
    AllowedStates: [],
    BasePrice: 10,
    ProductOwner: 'Acme Vendor'
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

// Helper: advance from Step 1 to Step 2
async function advanceToStep2() {
  mockGetPreview.mockResolvedValue(makeEmptyPreview());

  renderWizard();

  await waitFor(() => {
    expect(screen.queryByText(/loading enrollment preview/i)).not.toBeInTheDocument();
  });

  const nextBtn = screen.getByRole('button', { name: /next/i });
  await userEvent.click(nextBtn);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GroupTypeChangeWizard — Step 2 (Products)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the step 2 heading after advancing from step 1', async () => {
    mockGetAvailableProducts.mockResolvedValue(makeAvailableProductsResponse());

    await advanceToStep2();

    await waitFor(() => {
      expect(screen.getByText(/select individual products/i)).toBeInTheDocument();
    });
  });

  it('shows loading state while products are loading', async () => {
    // Never resolves
    mockGetAvailableProducts.mockReturnValue(new Promise(() => {}));

    await advanceToStep2();

    await waitFor(() => {
      expect(screen.getByText(/loading products/i)).toBeInTheDocument();
    });
  });

  it('renders empty state when no eligible products are available', async () => {
    // Only a Group-type product — should be filtered out
    mockGetAvailableProducts.mockResolvedValue(
      makeAvailableProductsResponse({
        availableProducts: [makeProduct({ SalesType: 'Group' })]
      })
    );

    await advanceToStep2();

    await waitFor(() => {
      expect(screen.getByText(/no individual-type products are available/i)).toBeInTheDocument();
    });
  });

  it('renders Individual and Both products but not Group-only products', async () => {
    mockGetAvailableProducts.mockResolvedValue(
      makeAvailableProductsResponse({
        availableProducts: [
          makeProduct({ ProductId: 'p-individual', Name: 'Ind Medical', SalesType: 'Individual' }),
          makeProduct({ ProductId: 'p-both', Name: 'Both Dental', SalesType: 'Both' }),
          makeProduct({ ProductId: 'p-group', Name: 'Group Vision', SalesType: 'Group' })
        ]
      })
    );

    await advanceToStep2();

    await waitFor(() => {
      expect(screen.getByText('Ind Medical')).toBeInTheDocument();
      expect(screen.getByText('Both Dental')).toBeInTheDocument();
      expect(screen.queryByText('Group Vision')).not.toBeInTheDocument();
    });
  });

  it('renders all eligible products in a flat list (no vendor grouping)', async () => {
    mockGetAvailableProducts.mockResolvedValue(
      makeAvailableProductsResponse({
        availableProducts: [
          makeProduct({ ProductId: 'p1', Name: 'Plan A', ProductOwner: 'Vendor Alpha', SalesType: 'Individual' }),
          makeProduct({ ProductId: 'p2', Name: 'Plan B', ProductOwner: 'Vendor Beta', SalesType: 'Individual' }),
          makeProduct({ ProductId: 'p3', Name: 'Plan C', ProductOwner: 'Vendor Alpha', SalesType: 'Both' })
        ]
      })
    );

    await advanceToStep2();

    // Wizard renders products as a single flat list with no vendor headers.
    await waitFor(() => {
      expect(screen.getByText('Plan A')).toBeInTheDocument();
      expect(screen.getByText('Plan B')).toBeInTheDocument();
      expect(screen.getByText('Plan C')).toBeInTheDocument();
    });
    expect(screen.queryByText('Vendor Alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('Vendor Beta')).not.toBeInTheDocument();
  });

  it('pre-selects products already on the group with SalesType=Individual or Both', async () => {
    mockGetAvailableProducts.mockResolvedValue(
      makeAvailableProductsResponse({
        groupProducts: [
          makeGroupProduct('p-existing-ind', 'Individual'),
          makeGroupProduct('p-existing-both', 'Both'),
          makeGroupProduct('p-existing-group', 'Group') // should NOT be pre-selected
        ],
        availableProducts: [
          makeProduct({ ProductId: 'p-existing-ind', Name: 'Pre-selected Ind', SalesType: 'Individual' }),
          makeProduct({ ProductId: 'p-existing-both', Name: 'Pre-selected Both', SalesType: 'Both' }),
          makeProduct({ ProductId: 'p-new', Name: 'New Ind Plan', SalesType: 'Individual' })
        ]
      })
    );

    await advanceToStep2();

    await waitFor(() => {
      const checkbox1 = screen.getByTestId('product-checkbox-p-existing-ind') as HTMLInputElement;
      const checkbox2 = screen.getByTestId('product-checkbox-p-existing-both') as HTMLInputElement;
      const checkbox3 = screen.getByTestId('product-checkbox-p-new') as HTMLInputElement;

      expect(checkbox1.checked).toBe(true);
      expect(checkbox2.checked).toBe(true);
      expect(checkbox3.checked).toBe(false);
    });
  });

  it('toggles a checkbox when clicked', async () => {
    mockGetAvailableProducts.mockResolvedValue(
      makeAvailableProductsResponse({
        availableProducts: [
          makeProduct({ ProductId: 'p1', Name: 'Toggle Me', SalesType: 'Individual' })
        ]
      })
    );

    await advanceToStep2();

    await waitFor(() => {
      expect(screen.getByTestId('product-checkbox-p1')).toBeInTheDocument();
    });

    const checkbox = screen.getByTestId('product-checkbox-p1') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    await userEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    await userEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it('shows inline error when clicking Next with no products selected', async () => {
    mockGetAvailableProducts.mockResolvedValue(
      makeAvailableProductsResponse({
        availableProducts: [
          makeProduct({ ProductId: 'p1', Name: 'Unselected Plan', SalesType: 'Individual' })
        ]
      })
    );

    await advanceToStep2();

    await waitFor(() => {
      expect(screen.getByTestId('step2-next')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('step2-next'));

    await waitFor(() => {
      expect(screen.getByTestId('step2-error')).toHaveTextContent(/select at least one/i);
    });
  });

  it('advances to Step 3 when a product is selected and Next is clicked', async () => {
    mockGetAvailableProducts.mockResolvedValue(
      makeAvailableProductsResponse({
        availableProducts: [
          makeProduct({ ProductId: 'p1', Name: 'My Product', SalesType: 'Individual' })
        ]
      })
    );

    await advanceToStep2();

    await waitFor(() => {
      expect(screen.getByTestId('product-checkbox-p1')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('product-checkbox-p1'));
    await userEvent.click(screen.getByTestId('step2-next'));

    await waitFor(() => {
      expect(screen.getByText(/confirm conversion/i)).toBeInTheDocument();
    });
  });

  // ---------- reverse direction: ListBill → Standard ----------
  describe('reverse direction (targetType=Standard)', () => {
    async function advanceToStep2Standard() {
      mockGetPreview.mockResolvedValue(makeEmptyPreview('Standard'));
      renderWizard();
      await waitFor(() => {
        expect(screen.queryByText(/loading enrollment preview/i)).not.toBeInTheDocument();
      });
      await userEvent.click(screen.getByRole('button', { name: /next/i }));
    }

    it('updates the heading to "Select group products" when target is Standard', async () => {
      mockGetAvailableProducts.mockResolvedValue(makeAvailableProductsResponse());

      await advanceToStep2Standard();

      await waitFor(() => {
        expect(screen.getByText(/select group products/i)).toBeInTheDocument();
      });
    });

    it('renders Group and Both products, hides Individual products', async () => {
      mockGetAvailableProducts.mockResolvedValue(
        makeAvailableProductsResponse({
          availableProducts: [
            makeProduct({ ProductId: 'p-group', Name: 'Group Medical', SalesType: 'Group' }),
            makeProduct({ ProductId: 'p-both', Name: 'Both Dental', SalesType: 'Both' }),
            makeProduct({ ProductId: 'p-ind', Name: 'Ind Vision', SalesType: 'Individual' })
          ]
        })
      );

      await advanceToStep2Standard();

      await waitFor(() => {
        expect(screen.getByText('Group Medical')).toBeInTheDocument();
        expect(screen.getByText('Both Dental')).toBeInTheDocument();
        expect(screen.queryByText('Ind Vision')).not.toBeInTheDocument();
      });
    });

    it('pre-selects existing Group / Both products on the group, not Individual', async () => {
      mockGetAvailableProducts.mockResolvedValue(
        makeAvailableProductsResponse({
          availableProducts: [
            makeProduct({ ProductId: 'p-group', Name: 'Group Medical', SalesType: 'Group' }),
            makeProduct({ ProductId: 'p-both', Name: 'Both Dental', SalesType: 'Both' }),
            makeProduct({ ProductId: 'p-ind', Name: 'Ind Vision', SalesType: 'Individual' })
          ],
          groupProducts: [
            makeGroupProduct('p-group', 'Group'),
            makeGroupProduct('p-both', 'Both'),
            makeGroupProduct('p-ind', 'Individual')
          ]
        })
      );

      await advanceToStep2Standard();

      await waitFor(() => {
        expect(screen.getByTestId('product-checkbox-p-group')).toBeChecked();
        expect(screen.getByTestId('product-checkbox-p-both')).toBeChecked();
        // The Individual one isn't even rendered (filtered out), so the
        // checkbox shouldn't be present at all on the Standard direction.
        expect(screen.queryByTestId('product-checkbox-p-ind')).not.toBeInTheDocument();
      });
    });

    it('empty-state copy reads "group" not "individual" when target is Standard', async () => {
      mockGetAvailableProducts.mockResolvedValue(
        makeAvailableProductsResponse({
          availableProducts: [
            // Only Individual — no Group / Both, so empty state for Standard direction
            makeProduct({ SalesType: 'Individual' })
          ]
        })
      );

      await advanceToStep2Standard();

      await waitFor(() => {
        expect(screen.getByText(/no group-type products are available/i)).toBeInTheDocument();
      });
    });
  });
});

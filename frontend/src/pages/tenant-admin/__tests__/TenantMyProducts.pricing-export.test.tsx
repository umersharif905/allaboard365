/**
 * @vitest-environment jsdom
 *
 * Tests for the Export Pricing button in TenantMyProducts → ProductDetailsModal (Pricing tab).
 *
 * Covers:
 *   - Export Pricing button renders when pricingTiers.length > 0
 *   - Button is absent when there are no pricing tiers
 *   - Button shows "Exporting…" while the service call is in-flight
 *   - Inline error message appears when the export fails
 *   - downloadPricingExport is called with the correct productId and productName
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted before imports)
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { tenantId: 'tenant-1' } }),
}));

vi.mock('../../../components/forms/AddProductWizard', () => ({ default: () => null }));
vi.mock('../../../components/ai/AIProductCreator', () => ({ default: () => null }));
vi.mock('../../../components/products/ProductAPIConfigModal', () => ({ default: () => null }));

const getMock = vi.fn();
vi.mock('../../../services/api.service', () => ({
  apiService: { get: (...a: unknown[]) => getMock(...a) },
}));

const downloadPricingExportMock = vi.fn();
vi.mock('../../../services/tenant-admin/pricing-export.service', () => ({
  downloadPricingExport: (...a: unknown[]) => downloadPricingExportMock(...a),
}));

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------
import TenantMyProducts from '../TenantMyProducts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRODUCT_LIST = [
  {
    ProductId: 'prod-1',
    Name: 'Health Plus',
    Description: 'A health plan',
    ProductType: 'Health',
    Status: 'Active',
    IsBundle: false,
    SubscriptionCount: 10,
    CreatedDate: '2025-01-01T00:00:00Z',
    ModifiedDate: '2025-01-01T00:00:00Z',
  },
];

const PRODUCT_DETAIL_WITH_TIERS = {
  ProductId: 'prod-1',
  Name: 'Health Plus',
  ProductType: 'Health',
  Status: 'Active',
  IsBundle: false,
  pricingTiers: [
    { id: 't1', minAge: 18, maxAge: 29, tierType: 'Single', tobaccoStatus: 'Non-Tobacco', msrpRate: 150 },
    { id: 't2', minAge: 30, maxAge: 39, tierType: 'Single', tobaccoStatus: 'Non-Tobacco', msrpRate: 200 },
  ],
};

const PRODUCT_DETAIL_NO_TIERS = {
  ProductId: 'prod-1',
  Name: 'Health Plus',
  ProductType: 'Health',
  Status: 'Active',
  IsBundle: false,
  pricingTiers: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

async function openProductDetailsModal(detailResponse: object) {
  getMock
    .mockResolvedValueOnce({ success: true, data: PRODUCT_LIST })   // products list
    .mockResolvedValueOnce({ success: true, data: detailResponse }); // product detail

  render(<TenantMyProducts />, { wrapper });

  // Wait for product list to load, then click "View details"
  const viewBtn = await screen.findByTitle('View details');
  await userEvent.click(viewBtn);
}

async function switchToPricingTab() {
  // The pricing tab label includes the tier count like "Pricing (2)"
  const pricingTab = await screen.findByRole('button', { name: /pricing/i });
  await userEvent.click(pricingTab);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TenantMyProducts — Export Pricing button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    downloadPricingExportMock.mockResolvedValue(undefined);
  });

  it('renders Export Pricing button when pricingTiers.length > 0', async () => {
    await openProductDetailsModal(PRODUCT_DETAIL_WITH_TIERS);
    await switchToPricingTab();

    expect(await screen.findByRole('button', { name: /export pricing/i })).toBeInTheDocument();
  });

  it('does not render Export Pricing button when pricingTiers is empty', async () => {
    await openProductDetailsModal(PRODUCT_DETAIL_NO_TIERS);
    await switchToPricingTab();

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /export pricing/i })).not.toBeInTheDocument();
    });
  });

  it('calls downloadPricingExport with the correct productId and productName', async () => {
    await openProductDetailsModal(PRODUCT_DETAIL_WITH_TIERS);
    await switchToPricingTab();

    const exportBtn = await screen.findByRole('button', { name: /export pricing/i });
    await userEvent.click(exportBtn);

    await waitFor(() => {
      expect(downloadPricingExportMock).toHaveBeenCalledWith('prod-1', 'Health Plus');
    });
  });

  it('shows "Exporting…" label while the export is in-flight', async () => {
    // Never resolves during the assertion window
    downloadPricingExportMock.mockReturnValue(new Promise(() => {}));

    await openProductDetailsModal(PRODUCT_DETAIL_WITH_TIERS);
    await switchToPricingTab();

    const exportBtn = await screen.findByRole('button', { name: /export pricing/i });
    await userEvent.click(exportBtn);

    expect(await screen.findByRole('button', { name: /exporting/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /exporting/i })).toBeDisabled();
  });

  it('shows an inline error message when the export fails', async () => {
    downloadPricingExportMock.mockRejectedValueOnce(new Error('Server error'));

    await openProductDetailsModal(PRODUCT_DETAIL_WITH_TIERS);
    await switchToPricingTab();

    const exportBtn = await screen.findByRole('button', { name: /export pricing/i });
    await userEvent.click(exportBtn);

    expect(await screen.findByText('Server error')).toBeInTheDocument();
  });

  it('restores the button label after a failed export', async () => {
    downloadPricingExportMock.mockRejectedValueOnce(new Error('Oops'));

    await openProductDetailsModal(PRODUCT_DETAIL_WITH_TIERS);
    await switchToPricingTab();

    const exportBtn = await screen.findByRole('button', { name: /export pricing/i });
    await userEvent.click(exportBtn);

    // Button should return to its default label once the rejection is handled
    expect(await screen.findByRole('button', { name: /export pricing/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export pricing/i })).not.toBeDisabled();
  });
});

/**
 * Tests for the MinimumEmployeesPerGroup field in the Vendors admin page.
 *
 * Add-vendor tests: render <Vendors mode="list" />, open the Add Vendor dialog,
 * navigate to the Eligibility tab (tab 5), interact with the field.
 *
 * Edit-vendor tests: render <Vendors mode="detail" routeVendorId="vendor-1" />,
 * which auto-loads the vendor and displays the form inline without a dialog.
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports so vitest can hoist them.
// We declare spy functions at module scope so they survive hoisting.
// ---------------------------------------------------------------------------

const axiosMockGet = vi.fn();
const axiosMockPut = vi.fn();
const axiosMockPost = vi.fn();

vi.mock('axios', () => {
  // NOTE: axiosMockGet/Put/Post are declared above in module scope,
  // so they are accessible at hoisting time (vitest evaluates the factory lazily).
  const instance = {
    get: (...a: any[]) => axiosMockGet(...a),
    put: (...a: any[]) => axiosMockPut(...a),
    post: (...a: any[]) => axiosMockPost(...a),
    defaults: { baseURL: 'http://localhost:3001' },
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return { default: { create: () => instance } };
});

vi.mock('../../../config/api', () => ({
  API_CONFIG: { BASE_URL: 'http://localhost:3001' },
}));

vi.mock('../../../services/api.service', () => ({
  apiService: {
    get: vi.fn().mockResolvedValue({ success: true, data: [] }),
    post: vi.fn().mockResolvedValue({ success: true, data: {} }),
    downloadFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../components/admin/AdminVendorUserManagementPanel', () => ({
  default: () => <div data-testid="stub-vendor-users" />,
}));
vi.mock('../../../components/forms/AddProductWizard', () => ({
  default: () => <div data-testid="stub-add-products" />,
}));
vi.mock('../../../components/groups/NewGroupFormGenerateModal', () => ({
  default: () => <div data-testid="stub-ng-modal" />,
}));
vi.mock('../../../components/layout/SharedHeader', () => ({
  default: () => <header data-testid="stub-header" />,
}));
vi.mock('../../../components/pdf-signer/PDFSignerEditor', () => ({
  default: () => <div data-testid="stub-pdf-signer" />,
}));
vi.mock('../../../components/common/SearchableDropdown', () => ({
  default: ({ onChange }: any) => (
    <input
      data-testid="stub-searchable-dropdown"
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

// ---------------------------------------------------------------------------
// Import component under test (after mocks)
// ---------------------------------------------------------------------------
import Vendors from '../Vendors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Vendor list response for mode="list" */
const vendorListResponse = {
  data: {
    success: true,
    data: [
      {
        Id: 'vendor-1',
        VendorName: 'Tall Tree Health',
        Email: 'info@talltree.com',
        Phone: '5551234567',
        City: 'Austin',
        State: 'TX',
        MinimumEmployeesPerGroup: 5,
      },
    ],
  },
};

/** Vendor detail for mode="detail" */
const vendorDetailResponse = {
  data: {
    success: true,
    data: {
      Id: 'vendor-1',
      VendorName: 'Tall Tree Health',
      Email: 'info@talltree.com',
      Phone: '5551234567',
      City: 'Austin',
      State: 'TX',
      EligibilityFutureEffectiveDays: 7,
      EligibilityPrimaryExportGrain: 'PerProduct',
      EligibilityDateFormat: 'ARM',
      EligibilityIncludeVendorIds: [],
      MinimumEmployeesPerGroup: 5,
      ExportMethod: '',
      ExportGroupIds: [],
    },
  },
};

/** Default catch-all mock: handles list, detail, and all sub-resources. */
function setupDefaultMocks() {
  axiosMockGet.mockImplementation((url: string) => {
    if (/\/api\/vendors\/vendor-1$/.test(url)) return Promise.resolve(vendorDetailResponse);
    if (/\/api\/vendors(\?.*)?$/.test(url)) return Promise.resolve(vendorListResponse);
    return Promise.resolve({ data: { success: true, data: [] } });
  });
  axiosMockPut.mockResolvedValue({ data: { success: true, data: { Id: 'vendor-1' } } });
  axiosMockPost.mockResolvedValue({ data: { success: true, data: { Id: 'new-vendor', id: 'new-vendor' } } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Vendors — MinimumEmployeesPerGroup field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Add-vendor flow ──────────────────────────────────────────────────────

  it('renders the Minimum employees per group field on the Eligibility tab (add-vendor dialog)', async () => {
    render(
      <MemoryRouter>
        <Vendors mode="list" />
      </MemoryRouter>
    );

    await waitFor(() => expect(axiosMockGet).toHaveBeenCalled());

    // Open Add Vendor dialog
    const addBtn = await screen.findByRole('button', { name: /add vendor/i });
    await act(async () => { fireEvent.click(addBtn); });

    // Navigate to Eligibility tab
    const eligibilityTab = await screen.findByRole('tab', { name: /eligibility/i });
    await act(async () => { fireEvent.click(eligibilityTab); });

    const input = await screen.findByLabelText(/minimum employees per group/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'number');
    // New vendor: field is blank → null value
    expect(input).toHaveValue(null);
  });

  it('includes minimumEmployeesPerGroup in the POST body when creating a new vendor', async () => {
    render(
      <MemoryRouter>
        <Vendors mode="list" />
      </MemoryRouter>
    );

    await waitFor(() => expect(axiosMockGet).toHaveBeenCalled());

    const addBtn = await screen.findByRole('button', { name: /add vendor/i });
    await act(async () => { fireEvent.click(addBtn); });

    // Fill required Vendor Name on the dashboard tab (tab 0)
    const vendorNameInput = await screen.findByLabelText(/vendor name/i);
    await act(async () => {
      fireEvent.change(vendorNameInput, { target: { value: 'New Test Vendor' } });
    });

    // Navigate to Eligibility tab and set the minimum
    const eligibilityTab = await screen.findByRole('tab', { name: /eligibility/i });
    await act(async () => { fireEvent.click(eligibilityTab); });

    const minInput = await screen.findByLabelText(/minimum employees per group/i);
    await act(async () => {
      fireEvent.change(minInput, { target: { value: '10' } });
    });
    expect(minInput).toHaveValue(10);

    // Navigate back to Dashboard tab (tab 0 allows create)
    const dashboardTab = await screen.findByRole('tab', { name: /dashboard/i });
    await act(async () => { fireEvent.click(dashboardTab); });

    const saveBtn = await screen.findByRole('button', { name: /create vendor/i });
    await act(async () => { fireEvent.click(saveBtn); });

    await waitFor(() => expect(axiosMockPost).toHaveBeenCalled());
    const postPayload = axiosMockPost.mock.calls[0][1];
    expect(postPayload).toMatchObject({ minimumEmployeesPerGroup: 10 });
  });

  // ── Edit-vendor flow (mode="detail") ─────────────────────────────────────
  // In detail mode the dialog renders with disablePortal + hideBackdrop inside
  // the component tree, which may result in the wrapper having aria-hidden="true"
  // in jsdom. We use { hidden: true } to reach into those nodes.

  it('displays the existing MinimumEmployeesPerGroup value (5) when editing a vendor', async () => {
    render(
      <MemoryRouter>
        <Vendors mode="detail" routeVendorId="vendor-1" />
      </MemoryRouter>
    );

    // Wait for the detail to load and form to appear
    await waitFor(() =>
      expect(axiosMockGet).toHaveBeenCalledWith(expect.stringContaining('/api/vendors/vendor-1'))
    );

    // Navigate to Eligibility tab (may be aria-hidden in detail mode)
    const eligibilityTab = await screen.findByRole('tab', { name: /eligibility/i, hidden: true });
    await act(async () => { fireEvent.click(eligibilityTab); });

    const input = await screen.findByLabelText(/minimum employees per group/i);
    expect(input).toHaveValue(5);
  });

  it('includes minimumEmployeesPerGroup: 3 in the PUT body after updating the value', async () => {
    render(
      <MemoryRouter>
        <Vendors mode="detail" routeVendorId="vendor-1" />
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(axiosMockGet).toHaveBeenCalledWith(expect.stringContaining('/api/vendors/vendor-1'))
    );

    const eligibilityTab = await screen.findByRole('tab', { name: /eligibility/i, hidden: true });
    await act(async () => { fireEvent.click(eligibilityTab); });

    // MUI TextField associates label via aria-labelledby; use hidden:true since the
    // dialog wrapper may have aria-hidden in jsdom's detail mode.
    const input = await screen.findByLabelText(/minimum employees per group/i);
    await act(async () => {
      fireEvent.change(input, { target: { value: '3' } });
    });
    expect(input).toHaveValue(3);

    const saveBtn = await screen.findByRole('button', { name: /save changes/i, hidden: true });
    await act(async () => { fireEvent.click(saveBtn); });

    await waitFor(() => expect(axiosMockPut).toHaveBeenCalled());
    const putPayload = axiosMockPut.mock.calls[0][1];
    expect(putPayload).toMatchObject({ minimumEmployeesPerGroup: 3 });
  }, 15000);

  it('sends minimumEmployeesPerGroup: null when the field is cleared', async () => {
    render(
      <MemoryRouter>
        <Vendors mode="detail" routeVendorId="vendor-1" />
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(axiosMockGet).toHaveBeenCalledWith(expect.stringContaining('/api/vendors/vendor-1'))
    );

    const eligibilityTab = await screen.findByRole('tab', { name: /eligibility/i, hidden: true });
    await act(async () => { fireEvent.click(eligibilityTab); });

    const input = await screen.findByLabelText(/minimum employees per group/i);
    await act(async () => {
      fireEvent.change(input, { target: { value: '' } });
    });

    const saveBtn = await screen.findByRole('button', { name: /save changes/i, hidden: true });
    await act(async () => { fireEvent.click(saveBtn); });

    await waitFor(() => expect(axiosMockPut).toHaveBeenCalled());
    const putPayload = axiosMockPut.mock.calls[0][1];
    expect(putPayload).toMatchObject({ minimumEmployeesPerGroup: null });
  }, 15000);
});

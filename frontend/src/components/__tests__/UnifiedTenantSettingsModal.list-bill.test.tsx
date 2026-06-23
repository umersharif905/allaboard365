/**
 * Tests for Task 3.6: auto-approve toggle + below-minimum alert recipients
 * in UnifiedTenantSettingsModal.
 *
 * Strategy: render the modal with a fabricated tenant, navigate to the
 * "Enrollment" tab, and assert that:
 *  1. The auto-approve checkbox reflects advancedSettings.enrollment.autoApproveGroupTypeChanges
 *  2. Toggling the checkbox updates local state (visible via re-render)
 *  3. The recipients textarea round-trips the array stored in
 *     advancedSettings.enrollment.belowMinimumAlertRecipients
 *  4. Saving calls PUT /api/tenants/:id (via TenantAdminService.updateTenantSettings)
 *     with the updated enrollment block serialised in AdvancedSettings JSON.
 *
 * All external services are mocked so the tests are fast and hermetic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import UnifiedTenantSettingsModal from '../UnifiedTenantSettingsModal';

// ─── Mock heavy service dependencies ────────────────────────────────────────

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { currentRole: 'TenantAdmin', roles: ['TenantAdmin'], userId: 'u1', email: 't@t.com' }
  })
}));

vi.mock('../../services/api.service', () => ({
  apiService: {
    get: vi.fn().mockResolvedValue({ success: true, data: {} }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../../services/email-settings.service', () => ({
  EmailSettingsService: { getDnsRecords: vi.fn().mockResolvedValue({ success: true, data: [] }) }
}));

vi.mock('../../services/product-overrides.service', () => ({
  ProductOverridesService: {
    getOverrideACHAccounts: vi.fn().mockResolvedValue({ success: true, data: [] })
  }
}));

vi.mock('../../services/tenant-payout-ach.service', () => ({
  TenantPayoutACHService: {
    getTenantPayoutACHAccounts: vi.fn().mockResolvedValue({ success: true, data: [] })
  }
}));

vi.mock('../../services/tenant-admin/agent-onboarding.service', () => ({
  AgentOnboardingService: {
    getAgreementDocuments: vi.fn().mockResolvedValue({ success: true, data: [] })
  }
}));

vi.mock('../../services/tenant-admin/tenant-admin.service', () => ({
  TenantAdminService: {
    updateTenantSettings: vi.fn().mockResolvedValue({ success: true, data: {} }),
    getTenantInfo: vi.fn().mockResolvedValue({ success: true, data: {} })
  }
}));

vi.mock('../../services/TenantService', () => ({
  default: {
    updateTenant: vi.fn().mockResolvedValue({ success: true, data: {} }),
    getTenantById: vi.fn().mockResolvedValue({ success: true, data: {} })
  }
}));

// Stub sub-components that have their own network calls or complex rendering
vi.mock('../EmailSettingsSection', () => ({
  default: () => <div data-testid="email-settings-stub" />
}));

vi.mock('../UrlPathManager', () => ({
  default: () => <div data-testid="url-path-manager-stub" />
}));

vi.mock('../common/SearchableDropdown', () => ({
  default: () => <div data-testid="searchable-dropdown-stub" />
}));

import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
const mockUpdateTenantSettings = TenantAdminService.updateTenantSettings as ReturnType<typeof vi.fn>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildTenant(enrollmentOverrides: Record<string, unknown> = {}) {
  const enrollment = {
    autoApproveGroupTypeChanges: false,
    belowMinimumAlertRecipients: [] as string[],
    ...enrollmentOverrides
  };
  const advancedSettings = JSON.stringify({ enrollment });
  return {
    TenantId: 'tenant-001',
    Name: 'Test Tenant',
    LogoUrl: '',
    PrimaryColorHex: '#1f8dbf',
    SecondaryColorHex: '#125e82',
    CustomDomain: '',
    DefaultUrlPath: '',
    MemberIDPrefix: 'TST',
    IndividualMemberIDPrefix: null,
    AdvancedSettings: advancedSettings,
    SystemFees: null as any,
    PaymentProcessorSettings: null as any,
    MinimumSetupFee: null
  };
}

function renderModal(tenant = buildTenant()) {
  const onClose = vi.fn();
  const onSave = vi.fn();
  render(
    <UnifiedTenantSettingsModal
      tenant={tenant}
      onClose={onClose}
      onSave={onSave}
    />
  );
  return { onClose, onSave };
}

async function navigateToEnrollmentTab() {
  const enrollmentTabBtn = await screen.findByRole('button', { name: /enrollment/i });
  await act(async () => { fireEvent.click(enrollmentTabBtn); });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('UnifiedTenantSettingsModal — Enrollment tab (Task 3.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateTenantSettings.mockResolvedValue({ success: true, data: {} });
  });

  // ── 1. Auto-approve checkbox reflects stored value (false) ─────────────────

  it('renders auto-approve checkbox unchecked when stored value is false', async () => {
    renderModal(buildTenant({ autoApproveGroupTypeChanges: false }));
    await navigateToEnrollmentTab();

    const checkbox = screen.getByRole('checkbox', { name: /auto-approve group type changes/i });
    expect(checkbox).not.toBeChecked();
  });

  // ── 2. Auto-approve checkbox reflects stored value (true) ──────────────────

  it('renders auto-approve checkbox checked when stored value is true', async () => {
    renderModal(buildTenant({ autoApproveGroupTypeChanges: true }));
    await navigateToEnrollmentTab();

    const checkbox = screen.getByRole('checkbox', { name: /auto-approve group type changes/i });
    expect(checkbox).toBeChecked();
  });

  // ── 3. Toggling the checkbox updates local state ───────────────────────────

  it('toggles the auto-approve checkbox and reflects the new state', async () => {
    renderModal(buildTenant({ autoApproveGroupTypeChanges: false }));
    await navigateToEnrollmentTab();

    const checkbox = screen.getByRole('checkbox', { name: /auto-approve group type changes/i });
    expect(checkbox).not.toBeChecked();

    await act(async () => { fireEvent.click(checkbox); });
    expect(checkbox).toBeChecked();

    await act(async () => { fireEvent.click(checkbox); });
    expect(checkbox).not.toBeChecked();
  });

  // ── 4. Recipients textarea shows stored emails (one per line) ──────────────

  it('renders existing recipients one per line in the textarea', async () => {
    renderModal(buildTenant({
      belowMinimumAlertRecipients: ['ops@example.com', 'admin@example.com']
    }));
    await navigateToEnrollmentTab();

    const textarea = screen.getByRole('textbox', { name: /notification email addresses/i });
    expect(textarea).toHaveValue('ops@example.com\nadmin@example.com');
  });

  // ── 5. Editing the textarea round-trips the array ─────────────────────────

  it('updates the recipients when the textarea content changes', async () => {
    renderModal(buildTenant({ belowMinimumAlertRecipients: [] }));
    await navigateToEnrollmentTab();

    const textarea = screen.getByRole('textbox', { name: /notification email addresses/i });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'a@b.com\nc@d.com' } });
    });
    expect(textarea).toHaveValue('a@b.com\nc@d.com');
  });

  // ── 6. Save persists enrollment settings via updateTenantSettings ──────────

  it('persists autoApproveGroupTypeChanges=true via updateTenantSettings on Save', async () => {
    renderModal(buildTenant({ autoApproveGroupTypeChanges: false }));
    await navigateToEnrollmentTab();

    // Toggle checkbox to true
    const checkbox = screen.getByRole('checkbox', { name: /auto-approve group type changes/i });
    await act(async () => { fireEvent.click(checkbox); });

    // Click Save button in the modal footer
    const saveBtn = screen.getByRole('button', { name: /^save changes$/i });
    await act(async () => { fireEvent.click(saveBtn); });

    await waitFor(() => {
      expect(mockUpdateTenantSettings).toHaveBeenCalled();
    });

    const call = mockUpdateTenantSettings.mock.calls[0][0];
    const parsed = JSON.parse(call.AdvancedSettings);
    expect(parsed.enrollment.autoApproveGroupTypeChanges).toBe(true);
  });

  // ── 7. Save persists recipients array via updateTenantSettings ─────────────

  it('persists belowMinimumAlertRecipients via updateTenantSettings on Save', async () => {
    renderModal(buildTenant({ belowMinimumAlertRecipients: [] }));
    await navigateToEnrollmentTab();

    const textarea = screen.getByRole('textbox', { name: /notification email addresses/i });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'ops@acme.com\nit@acme.com' } });
    });

    const saveBtn = screen.getByRole('button', { name: /^save changes$/i });
    await act(async () => { fireEvent.click(saveBtn); });

    await waitFor(() => {
      expect(mockUpdateTenantSettings).toHaveBeenCalled();
    });

    const call = mockUpdateTenantSettings.mock.calls[0][0];
    const parsed = JSON.parse(call.AdvancedSettings);
    expect(parsed.enrollment.belowMinimumAlertRecipients).toEqual(['ops@acme.com', 'it@acme.com']);
  });

  // ── 8. Empty textarea produces empty array in payload ─────────────────────

  it('produces an empty recipients array when the textarea is blank', async () => {
    renderModal(buildTenant({ belowMinimumAlertRecipients: ['old@example.com'] }));
    await navigateToEnrollmentTab();

    const textarea = screen.getByRole('textbox', { name: /notification email addresses/i });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '' } });
    });

    const saveBtn = screen.getByRole('button', { name: /^save changes$/i });
    await act(async () => { fireEvent.click(saveBtn); });

    await waitFor(() => {
      expect(mockUpdateTenantSettings).toHaveBeenCalled();
    });

    const call = mockUpdateTenantSettings.mock.calls[0][0];
    const parsed = JSON.parse(call.AdvancedSettings);
    expect(parsed.enrollment.belowMinimumAlertRecipients).toEqual([]);
  });
});

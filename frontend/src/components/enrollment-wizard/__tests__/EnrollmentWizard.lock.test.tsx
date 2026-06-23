/**
 * Task 3.7 — EnrollmentWizard T-5 lock screen
 *
 * Tests that the enrollment wizard surfaces the GROUP_BELOW_MINIMUM_LOCKED
 * soft-block returned by GET /api/enrollment-links/:linkToken/enrollment-data.
 *
 * Strategy:
 *  - Mount the real EnrollmentWizard with all network-bound services mocked.
 *  - Drive getEnrollmentData to return { success: false, code: 'GROUP_BELOW_MINIMUM_LOCKED' }
 *    and assert the locked-state screen is rendered (no Next/wizard UI).
 *  - Drive getEnrollmentData to return a normal success payload and assert
 *    the wizard renders normally (welcome screen shown, no locked message).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EnrollmentWizard from '../EnrollmentWizard';

// ─── Mock services ────────────────────────────────────────────────────────────

vi.mock('../../../services/enrollment.service', () => ({
  EnrollmentService: {
    getEnrollmentStatus: vi.fn(),
    getEnrollmentData: vi.fn(),
    getTenantRedirect: vi.fn(),
    getProductAcknowledgements: vi.fn(),
    getEnrollmentLink: vi.fn()
  }
}));

vi.mock('../../../services/enrollment-link.service', () => ({
  EnrollmentLinkService: {
    getContributionPreview: vi.fn().mockResolvedValue({ success: true, data: {} }),
    getEnrollmentLink: vi.fn().mockResolvedValue({ success: true, data: {} })
  }
}));

vi.mock('../../../services/api.service', () => ({
  apiService: {
    get: vi.fn().mockResolvedValue({ success: true, data: {} }),
    post: vi.fn().mockResolvedValue({ success: true, data: {} }),
    put: vi.fn().mockResolvedValue({ success: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ success: true, data: {} })
  }
}));

// ─── Mock hooks that make network calls ──────────────────────────────────────

vi.mock('../../../hooks/useEffectiveDates', () => ({
  useEffectiveDates: () => ({
    data: null,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn()
  })
}));

vi.mock('../../../hooks/useEnrollmentLinkPricing', () => ({
  useEnrollmentLinkPricing: () => ({
    data: null,
    isLoading: false,
    isError: false,
    isFetching: false,
    error: null,
    refetch: vi.fn()
  }),
  useEnrollmentLinkTotals: () => ({
    data: null,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn()
  })
}));

// ─── Stub heavy sub-components ────────────────────────────────────────────────

vi.mock('../AskAgentQuestionModal', () => ({ default: () => null }));
vi.mock('../ContributionBreakdown', () => ({ default: () => null }));
vi.mock('../DeclineCoverageModal', () => ({ default: () => null }));
vi.mock('../../email-verification/EmailVerificationPanel', () => ({ default: () => null }));
vi.mock('../EnrollmentQualificationCheck', () => ({ default: () => null }));
vi.mock('../ProductSelectionModal', () => ({ default: () => null }));
vi.mock('../SignaturePad', () => ({ default: () => null }));
vi.mock('../steps/MarketingProductSelectionStep', () => ({ default: () => null }));
vi.mock('../steps/ProductQuestionnaireStep', () => ({
  default: () => null,
  validateQuestionnaire: vi.fn().mockReturnValue(true),
  hasTriggeredConditionalAcknowledgement: vi.fn().mockReturnValue(false)
}));
vi.mock('../../shared/ProductInfoModal', () => ({ default: () => null }));
vi.mock('../components/UsPhoneSlotsInput', () => ({ UsPhoneSlotsInput: () => null }));
vi.mock('../../payment/DetectedCardBrandLine', () => ({ DetectedCardBrandLine: () => null }));
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { EnrollmentService } from '../../../services/enrollment.service';

const mockEnrollmentService = EnrollmentService as unknown as {
  getEnrollmentStatus: ReturnType<typeof vi.fn>;
  getEnrollmentData: ReturnType<typeof vi.fn>;
  getTenantRedirect: ReturnType<typeof vi.fn>;
  getProductAcknowledgements: ReturnType<typeof vi.fn>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A minimal "enrollment is not started" status payload */
const notStartedStatus = {
  success: true,
  data: {
    isCompleted: false,
    passwordSetupCompleted: false,
    isDeclined: false,
    coverageDeclined: false,
    memberId: null,
    memberName: '',
    memberEmail: ''
  }
};

/** A minimal valid enrollment-data payload (welcome screen appears) */
const validEnrollmentData = {
  success: true,
  data: {
    status: 'valid',
    enrollmentLink: {
      linkId: 'link-1',
      groupId: 'grp-1',
      linkToken: 'tok_test',
      linkType: 'Member',
      description: 'Test Link',
      expiresAt: '2099-01-01T00:00:00.000Z',
      usageCount: 0,
      maxUsage: 100,
      templateName: 'Standard',
      templateType: 'Group'
    },
    primaryMember: null,
    productSections: [],
    dependents: [],
    group: { groupId: 'grp-1', groupName: 'Test Group', groupLogoUrl: null },
    tenant: {
      tenantId: 'ten-1',
      tenantName: 'Test Tenant',
      tenantLogoUrl: null,
      chargeFirstPaymentWithRecurring: false
    },
    requiresSSN: false,
    paymentSettings: { paymentMethods: ['ACH'] }
  }
};

/** The T-5 locked soft-block response */
const lockedResponse = {
  success: false,
  code: 'GROUP_BELOW_MINIMUM_LOCKED',
  message: 'Enrollment for this group is temporarily paused. Please contact your agent.',
  data: { minimum: 5, currentCount: 3 }
};

function renderWizard(token = 'tok_test') {
  return render(
    <MemoryRouter initialEntries={[`/enroll/${token}`]}>
      <EnrollmentWizard linkToken={token} />
    </MemoryRouter>
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EnrollmentWizard — T-5 GROUP_BELOW_MINIMUM_LOCKED screen (Task 3.7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnrollmentService.getTenantRedirect.mockResolvedValue({
      success: true,
      data: { tenantName: 'Test', redirectUrl: '/login', redirectType: 'default' }
    });
    mockEnrollmentService.getProductAcknowledgements.mockResolvedValue({
      success: true,
      data: { productAcknowledgements: [] }
    });
  });

  // ── 1. Locked response renders the paused screen ──────────────────────────

  it('renders the "Enrollment temporarily paused" screen when the group is locked', async () => {
    mockEnrollmentService.getEnrollmentStatus.mockResolvedValue(notStartedStatus);
    mockEnrollmentService.getEnrollmentData.mockResolvedValue(lockedResponse);

    renderWizard();

    await waitFor(() => {
      expect(screen.getByText(/enrollment temporarily paused/i)).toBeInTheDocument();
    });

    expect(
      screen.getByText(/minimum required enrollees/i)
    ).toBeInTheDocument();
  });

  // ── 2. Locked screen has no Next button ───────────────────────────────────

  it('does not render a Next button on the locked screen', async () => {
    mockEnrollmentService.getEnrollmentStatus.mockResolvedValue(notStartedStatus);
    mockEnrollmentService.getEnrollmentData.mockResolvedValue(lockedResponse);

    renderWizard();

    await waitFor(() => {
      expect(screen.getByText(/enrollment temporarily paused/i)).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
  });

  // ── 3. Successful response does NOT show the locked screen ────────────────

  it('does not render the locked screen when enrollment data loads successfully', async () => {
    mockEnrollmentService.getEnrollmentStatus.mockResolvedValue(notStartedStatus);
    mockEnrollmentService.getEnrollmentData.mockResolvedValue(validEnrollmentData);

    renderWizard();

    // Wait for loading to finish
    await waitFor(() => {
      expect(screen.queryByText(/loading enrollment information/i)).not.toBeInTheDocument();
    });

    expect(screen.queryByText(/enrollment temporarily paused/i)).not.toBeInTheDocument();
  });

  // ── 4. Locked screen shows the agent-contact copy ─────────────────────────

  it('shows the agent-contact instruction text on the locked screen', async () => {
    mockEnrollmentService.getEnrollmentStatus.mockResolvedValue(notStartedStatus);
    mockEnrollmentService.getEnrollmentData.mockResolvedValue(lockedResponse);

    renderWizard();

    await waitFor(() => {
      expect(screen.getByText(/please contact your agent/i)).toBeInTheDocument();
    });
  });
});

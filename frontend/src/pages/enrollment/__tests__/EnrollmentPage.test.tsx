import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import EnrollmentPage from '../EnrollmentPage';

// Mock the entire EnrollmentService so we can drive the EnrollmentPage
// through each of its 5 link-status branches:
//   loading → invalid → expired → inactive → used → valid (wizard mounts)
vi.mock('../../../services/enrollment.service', () => ({
  EnrollmentService: {
    getEnrollmentLink: vi.fn(),
    getEnrollmentStatus: vi.fn(),
    getTenantRedirect: vi.fn()
  }
}));

// Stub the 11k-line EnrollmentWizard so this suite stays hermetic and fast.
vi.mock('../../../components/enrollment-wizard/EnrollmentWizard', () => ({
  default: ({ linkToken }: { linkToken: string }) => (
    <div data-testid="wizard-stub">WIZARD: {linkToken}</div>
  )
}));

import { EnrollmentService } from '../../../services/enrollment.service';
const mocked = EnrollmentService as unknown as {
  getEnrollmentLink: ReturnType<typeof vi.fn>;
  getEnrollmentStatus: ReturnType<typeof vi.fn>;
  getTenantRedirect: ReturnType<typeof vi.fn>;
};

function renderAt(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/enroll/${token}`]}>
      <Routes>
        <Route path="/enroll/:linkToken" element={<EnrollmentPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getTenantRedirect.mockResolvedValue({
    success: true,
    data: { tenantName: 'Test', redirectUrl: '/login', redirectType: 'default' }
  });
  mocked.getEnrollmentStatus.mockResolvedValue({
    success: true,
    data: { isCompleted: false, passwordSetupCompleted: false, memberName: '', memberEmail: '' }
  });
});

describe('EnrollmentPage — link status branches', () => {
  it('shows a loading spinner while the link request is in flight', () => {
    mocked.getEnrollmentLink.mockImplementation(() => new Promise(() => {}));
    renderAt('enroll_loading');
    expect(screen.getByText(/loading enrollment link/i)).toBeInTheDocument();
  });

  it('renders the "Invalid Enrollment Link" page when backend returns success:false', async () => {
    mocked.getEnrollmentLink.mockResolvedValue({
      success: false,
      message: 'Enrollment link not found'
    });

    renderAt('enroll_bad');

    await waitFor(() => {
      expect(screen.getByText(/invalid enrollment link/i)).toBeInTheDocument();
    });
  });

  it('renders the "Enrollment Link Expired" page when ExpiresAt is in the past', async () => {
    mocked.getEnrollmentLink.mockResolvedValue({
      success: true,
      data: {
        LinkId: 'l1',
        LinkToken: 'enroll_expired',
        LinkUrl: '/x',
        IsActive: true,
        UsageCount: 0,
        ExpiresAt: '2020-01-01T00:00:00.000Z',
        CreatedDate: '2019-01-01T00:00:00.000Z'
      }
    });

    renderAt('enroll_expired');

    await waitFor(() => {
      expect(screen.getByText(/enrollment link expired/i)).toBeInTheDocument();
    });
  });

  it('renders the "Enrollment Link Inactive" page when IsActive is false', async () => {
    mocked.getEnrollmentLink.mockResolvedValue({
      success: true,
      data: {
        LinkId: 'l2',
        LinkToken: 'enroll_inactive',
        LinkUrl: '/x',
        IsActive: false,
        UsageCount: 0,
        CreatedDate: '2026-01-01T00:00:00.000Z'
      }
    });

    renderAt('enroll_inactive');

    await waitFor(() => {
      expect(screen.getByText(/enrollment link inactive/i)).toBeInTheDocument();
    });
  });

  it('routes usage-capped + completed to the "used" handler (Enrollment Complete)', async () => {
    mocked.getEnrollmentLink.mockResolvedValue({
      success: true,
      data: {
        LinkId: 'l3',
        LinkToken: 'enroll_used',
        LinkUrl: '/x',
        IsActive: true,
        UsageCount: 5,
        MaxUsage: 5,
        CreatedDate: '2026-01-01T00:00:00.000Z'
      }
    });
    mocked.getEnrollmentStatus.mockResolvedValue({
      success: true,
      data: {
        isCompleted: true,
        passwordSetupCompleted: true,
        memberName: 'Alice',
        memberEmail: 'a@b.com'
      }
    });

    renderAt('enroll_used');

    await waitFor(() => {
      expect(screen.getByText(/enrollment complete/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/alice/i)).toBeInTheDocument();
  });

  it('routes usage-capped + NOT completed to the wizard (re-enrollment allowed)', async () => {
    mocked.getEnrollmentLink.mockResolvedValue({
      success: true,
      data: {
        LinkId: 'l4',
        LinkToken: 'enroll_capped_noop',
        LinkUrl: '/x',
        IsActive: true,
        UsageCount: 5,
        MaxUsage: 5,
        CreatedDate: '2026-01-01T00:00:00.000Z'
      }
    });
    // getEnrollmentStatus → not completed; EnrollmentPage falls back to 'valid'
    mocked.getEnrollmentStatus.mockResolvedValue({
      success: true,
      data: {
        isCompleted: false,
        passwordSetupCompleted: false,
        memberName: '',
        memberEmail: ''
      }
    });

    renderAt('enroll_capped_noop');

    await waitFor(() => {
      expect(screen.getByTestId('wizard-stub')).toBeInTheDocument();
    });
    expect(screen.getByText(/WIZARD: enroll_capped_noop/)).toBeInTheDocument();
  });

  it('renders the wizard for a valid, active, non-capped link', async () => {
    mocked.getEnrollmentLink.mockResolvedValue({
      success: true,
      data: {
        LinkId: 'l5',
        LinkToken: 'enroll_ok',
        LinkUrl: '/x',
        IsActive: true,
        UsageCount: 0,
        CreatedDate: '2026-01-01T00:00:00.000Z'
      }
    });

    renderAt('enroll_ok');

    await waitFor(() => {
      expect(screen.getByTestId('wizard-stub')).toBeInTheDocument();
    });
  });
});

describe('EnrollmentPage — used-link handler sub-branches', () => {
  beforeEach(() => {
    mocked.getEnrollmentLink.mockResolvedValue({
      success: true,
      data: {
        LinkId: 'u1',
        LinkToken: 'enroll_used2',
        LinkUrl: '/x',
        IsActive: true,
        UsageCount: 5,
        MaxUsage: 5,
        CreatedDate: '2026-01-01T00:00:00.000Z'
      }
    });
  });

  it('shows "Complete Your Account Setup" when password is pending', async () => {
    mocked.getEnrollmentStatus.mockResolvedValue({
      success: true,
      data: {
        isCompleted: true,
        passwordSetupCompleted: false,
        memberName: 'Pending User',
        memberEmail: 'pending@test.com'
      }
    });

    renderAt('enroll_used2');

    await waitFor(() => {
      expect(screen.getByText(/complete your account setup/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /set up password/i })).toBeInTheDocument();
  });

  it('shows "Enrollment Complete" + "Go to Login" button when password is set', async () => {
    mocked.getEnrollmentStatus.mockResolvedValue({
      success: true,
      data: {
        isCompleted: true,
        passwordSetupCompleted: true,
        memberName: 'Done User',
        memberEmail: 'done@test.com'
      }
    });

    renderAt('enroll_used2');

    await waitFor(() => {
      expect(screen.getByText(/enrollment complete/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /go to login/i })).toBeInTheDocument();
  });
});

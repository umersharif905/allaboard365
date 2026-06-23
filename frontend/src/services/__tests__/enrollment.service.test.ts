import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnrollmentService } from '../enrollment.service';

// Mock the underlying apiService so each EnrollmentService method can be
// driven without real HTTP. This pins the service surface that the wizard
// + EnrollmentPage rely on.
vi.mock('../api.service', () => ({
  apiService: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn()
  }
}));

import { apiService } from '../api.service';

const mocked = apiService as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EnrollmentService — URL shapes', () => {
  it('getEnrollmentLink hits /api/enrollment-links/:linkToken', async () => {
    mocked.get.mockResolvedValue({ success: true, data: { LinkId: 'x' } });
    const res = await EnrollmentService.getEnrollmentLink('tok_1');
    expect(mocked.get).toHaveBeenCalledWith('/api/enrollment-links/tok_1');
    expect(res.success).toBe(true);
  });

  it('getEnrollmentData appends /enrollment-data', async () => {
    mocked.get.mockResolvedValue({ success: true, data: {} });
    await EnrollmentService.getEnrollmentData('tok_2');
    expect(mocked.get).toHaveBeenCalledWith('/api/enrollment-links/tok_2/enrollment-data');
  });

  it('getEnrollmentStatus appends /enrollment-status', async () => {
    mocked.get.mockResolvedValue({ success: true, data: { isCompleted: false } });
    await EnrollmentService.getEnrollmentStatus('tok_3');
    expect(mocked.get).toHaveBeenCalledWith('/api/enrollment-links/tok_3/enrollment-status');
  });

  it('getTenantRedirect appends /tenant-redirect', async () => {
    mocked.get.mockResolvedValue({ success: true, data: { tenantName: 't' } });
    await EnrollmentService.getTenantRedirect('tok_4');
    expect(mocked.get).toHaveBeenCalledWith('/api/enrollment-links/tok_4/tenant-redirect');
  });

  it('getEffectiveDates appends /effective-dates', async () => {
    mocked.get.mockResolvedValue({ success: true, data: [] });
    await EnrollmentService.getEffectiveDates('tok_5');
    expect(mocked.get).toHaveBeenCalledWith('/api/enrollment-links/tok_5/effective-dates');
  });

  it('getProductAcknowledgements encodes selectedProducts as a comma-joined query param', async () => {
    mocked.get.mockResolvedValue({ success: true, data: [] });
    await EnrollmentService.getProductAcknowledgements('tok_6', ['p1', 'p2', 'p3']);
    expect(mocked.get).toHaveBeenCalledWith(
      '/api/enrollment-links/tok_6/product-acknowledgements?selectedProducts=p1%2Cp2%2Cp3'
    );
  });
});

describe('EnrollmentService.completeEnrollment', () => {
  it('POSTs to /complete-enrollment and returns the response', async () => {
    mocked.post.mockResolvedValue({
      success: true,
      data: { memberId: 'm1', enrollmentStatus: 'Active' }
    });

    const enrollmentData = {
      memberId: 'm1',
      memberInfo: {},
      memberTier: 'EE',
      selectedProducts: ['p1'],
      selectedConfigs: { p1: 'config_6000' },
      frontendPricing: [],
      householdMembers: [],
      effectiveDate: '2026-05-01',
      acknowledgements: [],
      digitalSignature: 'signed',
      ipAddress: '127.0.0.1',
      userAgent: 'test'
    } as any;

    const res = await EnrollmentService.completeEnrollment('tok_7', enrollmentData);

    expect(mocked.post).toHaveBeenCalledWith(
      '/api/enrollment-links/tok_7/complete-enrollment',
      enrollmentData
    );
    expect(res.success).toBe(true);
  });

  it('rethrows network errors so callers can surface them', async () => {
    mocked.post.mockRejectedValue(new Error('network down'));
    await expect(
      EnrollmentService.completeEnrollment('tok_8', {} as any)
    ).rejects.toThrow('network down');
  });
});

describe('EnrollmentService — error propagation', () => {
  it('surfaces { success: false, message } from getEnrollmentLink unchanged', async () => {
    mocked.get.mockResolvedValue({ success: false, message: 'Enrollment link not found' });
    const res = await EnrollmentService.getEnrollmentLink('tok_bad');
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/not found/i);
  });

  it('surfaces { success: false, error: { code } } from completeEnrollment unchanged', async () => {
    mocked.post.mockResolvedValue({
      success: false,
      error: { code: 'PAYMENT_ERROR', message: 'Card declined' }
    });
    const res = await EnrollmentService.completeEnrollment('tok_decline', {} as any);
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('PAYMENT_ERROR');
  });
});

describe('EnrollmentService — acknowledgements + password setup', () => {
  it('submitAcknowledgements POSTs to /submit-acknowledgements', async () => {
    mocked.post.mockResolvedValue({ success: true });
    await EnrollmentService.submitAcknowledgements('tok_9', {
      acknowledgements: [],
      digitalSignature: 's',
      ipAddress: 'x',
      userAgent: 'y'
    });
    expect(mocked.post).toHaveBeenCalledWith(
      '/api/enrollment-links/tok_9/submit-acknowledgements',
      expect.objectContaining({ digitalSignature: 's' })
    );
  });

  it('setupPassword POSTs to /setup-password with email + password + memberId', async () => {
    mocked.post.mockResolvedValue({ success: true });
    await EnrollmentService.setupPassword('tok_10', {
      email: 'a@b.com',
      password: 'p@ss',
      memberId: 'm1'
    });
    expect(mocked.post).toHaveBeenCalledWith(
      '/api/enrollment-links/tok_10/setup-password',
      expect.objectContaining({ email: 'a@b.com', memberId: 'm1' })
    );
  });

  it('declineCoverage POSTs to /decline-coverage with audit fields', async () => {
    mocked.post.mockResolvedValue({ success: true });
    await EnrollmentService.declineCoverage('tok_11', {
      ipAddress: '127.0.0.1',
      userAgent: 'test'
    });
    expect(mocked.post).toHaveBeenCalledWith(
      '/api/enrollment-links/tok_11/decline-coverage',
      expect.objectContaining({ ipAddress: '127.0.0.1' })
    );
  });
});

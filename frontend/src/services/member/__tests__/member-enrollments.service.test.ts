import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemberEnrollmentService, mapEnrollmentProductDocuments } from '../member-enrollments.service';

vi.mock('../../api.service', () => ({
  apiService: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
  },
}));

import { apiService } from '../../api.service';

const mockApiService = vi.mocked(apiService);

describe('MemberEnrollmentService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getMyEnrollments', () => {
    it('should fetch enrollments successfully', async () => {
      const mockEnrollments = [
        {
          enrollmentId: 'enrollment-123',
          memberId: 'member-123',
          productId: 'product-123',
          status: 'Active',
          effectiveDate: '2024-01-01',
          premiumAmount: 150.00,
          paymentFrequency: 'Monthly',
          product: {
            productId: 'product-123',
            name: 'Premium Health Plan',
            description: 'A comprehensive health plan',
            productType: 'Healthcare'
          },
          memberName: 'John Doe'
        }
      ];

      mockApiService.get.mockResolvedValue({
        success: true,
        data: mockEnrollments
      });

      const result = await MemberEnrollmentService.getMyEnrollments();

      expect(mockApiService.get).toHaveBeenCalledWith('/api/me/member/enrollments');
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockEnrollments);
    });

    it('should handle API errors gracefully', async () => {
      const error = new Error('Network error');
      mockApiService.get.mockRejectedValue(error);

      const result = await MemberEnrollmentService.getMyEnrollments();

      expect(result.success).toBe(false);
      expect(result.data).toEqual([]);
      expect(result.message).toBe('Network error');
      expect(result.error?.message).toBe('Network error');
      expect(result.error?.code).toBe('FETCH_ENROLLMENTS_ERROR');
    });
  });

  describe('getAvailableProducts', () => {
    it('should fetch available products successfully', async () => {
      const mockProducts = [
        {
          productId: 'product-456',
          name: 'Dental Plan',
          description: 'Dental coverage',
          productType: 'Dental',
          basePrice: 25.00,
          canEnroll: true
        }
      ];

      mockApiService.get.mockResolvedValue({
        success: true,
        data: mockProducts
      });

      const result = await MemberEnrollmentService.getAvailableProducts();

      expect(mockApiService.get).toHaveBeenCalledWith('/api/me/member/products');
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockProducts);
    });

    it('should handle API errors gracefully', async () => {
      const error = new Error('Failed to fetch products');
      mockApiService.get.mockRejectedValue(error);

      const result = await MemberEnrollmentService.getAvailableProducts();

      expect(result.success).toBe(false);
      expect(result.data).toEqual([]);
      expect(result.message).toBe('Failed to fetch products');
      expect(result.error?.code).toBe('FETCH_PRODUCTS_ERROR');
    });
  });

  describe('getProductDetail', () => {
    it('should fetch product details successfully', async () => {
      const mockProductDetail = {
        productId: 'product-123',
        name: 'Premium Health Plan',
        description: 'A comprehensive health plan',
        productType: 'Healthcare',
        pricing: [
          {
            name: 'Employee Only',
            rate: 150.00,
            minAge: 18,
            maxAge: 99
          }
        ]
      };

      mockApiService.get.mockResolvedValue({
        success: true,
        data: mockProductDetail
      });

      const result = await MemberEnrollmentService.getProductDetail('product-123');

      expect(mockApiService.get).toHaveBeenCalledWith('/api/me/member/products/product-123');
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockProductDetail);
    });

    it('should handle API errors gracefully', async () => {
      const error = new Error('Product not found');
      mockApiService.get.mockRejectedValue(error);

      const result = await MemberEnrollmentService.getProductDetail('nonexistent-product');

      expect(result.success).toBe(false);
      expect(result.data).toEqual({});
      expect(result.message).toBe('Product not found');
      expect(result.error?.code).toBe('FETCH_PRODUCT_DETAIL_ERROR');
    });
  });

  describe('submitEnrollmentRequest', () => {
    it('should submit enrollment request successfully', async () => {
      const enrollmentRequest = {
        productId: 'product-123',
        effectiveDate: '2024-02-01',
        paymentFrequency: 'Monthly',
        enrollmentDetails: 'Test enrollment'
      };

      const mockResponse = {
        success: true,
        data: {
          enrollmentId: 'enrollment-123',
          status: 'Pending'
        }
      };

      mockApiService.post.mockResolvedValue(mockResponse);

      const result = await MemberEnrollmentService.submitEnrollmentRequest(enrollmentRequest);

      expect(mockApiService.post).toHaveBeenCalledWith('/api/me/member/enrollments', enrollmentRequest);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
    });

    it('should handle API errors gracefully', async () => {
      const enrollmentRequest = {
        productId: 'product-123',
        effectiveDate: '2024-02-01'
      };

      const error = new Error('Enrollment failed');
      mockApiService.post.mockRejectedValue(error);

      const result = await MemberEnrollmentService.submitEnrollmentRequest(enrollmentRequest);

      expect(result.success).toBe(false);
      expect(result.data).toBeNull();
      expect(result.message).toBe('Enrollment failed');
      expect(result.error?.code).toBe('SUBMIT_ENROLLMENT_ERROR');
    });
  });

  describe('cancelEnrollmentRequest', () => {
    it('should cancel enrollment request successfully', async () => {
      const mockResponse = {
        success: true,
        data: null,
        message: 'Enrollment request cancelled successfully'
      };

      mockApiService.put.mockResolvedValue(mockResponse);

      const result = await MemberEnrollmentService.cancelEnrollmentRequest('enrollment-123');

      expect(mockApiService.put).toHaveBeenCalledWith('/api/me/member/enrollments/enrollment-123/cancel', {});
      expect(result.success).toBe(true);
      expect(result.data).toBeNull();
    });

    it('should handle API errors gracefully', async () => {
      const error = new Error('Cancellation failed');
      mockApiService.put.mockRejectedValue(error);

      const result = await MemberEnrollmentService.cancelEnrollmentRequest('enrollment-123');

      expect(result.success).toBe(false);
      expect(result.data).toBeNull();
      expect(result.message).toBe('Cancellation failed');
      expect(result.error?.code).toBe('CANCEL_ENROLLMENT_ERROR');
    });
  });

  describe('submitPlanChangesRequest', () => {
    it('should submit plan changes request successfully', async () => {
      const planChangesRequest = {
        enrollmentId: 'enrollment-123',
        configFieldChanges: { deductible: 'High' },
        addProducts: ['product-456'],
        removeProducts: [],
        effectiveDate: '2024-02-01'
      };

      const mockResponse = {
        success: true,
        data: {
          changeRequestId: 'change-123',
          status: 'Pending'
        }
      };

      mockApiService.post.mockResolvedValue(mockResponse);

      const result = await MemberEnrollmentService.submitPlanChangesRequest(planChangesRequest);

      expect(mockApiService.post).toHaveBeenCalledWith('/api/me/member/plan-changes', planChangesRequest);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
    });

    it('should handle API errors gracefully', async () => {
      const planChangesRequest = {
        enrollmentId: 'enrollment-123',
        configFieldChanges: { deductible: 'High' }
      };

      const error = new Error('Plan changes failed');
      mockApiService.post.mockRejectedValue(error);

      const result = await MemberEnrollmentService.submitPlanChangesRequest(planChangesRequest);

      expect(result.success).toBe(false);
      expect(result.data).toBeNull();
      expect(result.message).toBe('Plan changes failed');
      expect(result.error?.code).toBe('SUBMIT_PLAN_CHANGES_ERROR');
    });
  });

  describe('getPlanChangeRequests', () => {
    it('should fetch plan change requests successfully', async () => {
      const mockChangeRequests = [
        {
          changeRequestId: 'change-123',
          enrollmentId: 'enrollment-123',
          status: 'Pending',
          configFieldChanges: { deductible: 'High' },
          addProducts: ['product-456'],
          removeProducts: []
        }
      ];

      mockApiService.get.mockResolvedValue({
        success: true,
        data: mockChangeRequests
      });

      const result = await MemberEnrollmentService.getPlanChangeRequests();

      expect(mockApiService.get).toHaveBeenCalledWith('/api/me/member/plan-changes');
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockChangeRequests);
    });

    it('should handle API errors gracefully', async () => {
      const error = new Error('Failed to fetch plan changes');
      mockApiService.get.mockRejectedValue(error);

      const result = await MemberEnrollmentService.getPlanChangeRequests();

      expect(result.success).toBe(false);
      expect(result.data).toEqual([]);
      expect(result.message).toBe('Failed to fetch plan changes');
      expect(result.error?.code).toBe('FETCH_PLAN_CHANGES_ERROR');
    });
  });

  describe('cancelPlanChangeRequest', () => {
    it('should cancel plan change request successfully', async () => {
      const mockResponse = {
        success: true,
        data: null,
        message: 'Plan change request cancelled successfully'
      };

      mockApiService.put.mockResolvedValue(mockResponse);

      const result = await MemberEnrollmentService.cancelPlanChangeRequest('change-123');

      expect(mockApiService.put).toHaveBeenCalledWith('/api/me/member/plan-changes/change-123/cancel', {});
      expect(result.success).toBe(true);
      expect(result.data).toBeNull();
    });

    it('should handle API errors gracefully', async () => {
      const error = new Error('Cancellation failed');
      mockApiService.put.mockRejectedValue(error);

      const result = await MemberEnrollmentService.cancelPlanChangeRequest('change-123');

      expect(result.success).toBe(false);
      expect(result.data).toBeNull();
      expect(result.message).toBe('Cancellation failed');
      expect(result.error?.code).toBe('CANCEL_PLAN_CHANGES_ERROR');
    });
  });

  describe('calculatePricingImpact', () => {
    it('should calculate pricing impact successfully', async () => {
      const pricingRequest = {
        enrollmentId: 'enrollment-123',
        configFieldChanges: { deductible: 'High' },
        addProducts: ['product-456'],
        removeProducts: []
      };

      const mockPricingImpact = {
        currentPremium: 150.00,
        newPremium: 175.00,
        difference: 25.00,
        breakdown: {
          configChanges: 10.00,
          addedProducts: 15.00,
          removedProducts: 0
        },
        hasChanges: true
      };

      mockApiService.post.mockResolvedValue({
        success: true,
        data: mockPricingImpact
      });

      const result = await MemberEnrollmentService.calculatePricingImpact(pricingRequest);

      expect(mockApiService.post).toHaveBeenCalledWith('/api/me/member/plan-changes/pricing-impact', pricingRequest);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockPricingImpact);
    });

    it('should handle API errors gracefully', async () => {
      const pricingRequest = {
        enrollmentId: 'enrollment-123',
        configFieldChanges: { deductible: 'High' }
      };

      const error = new Error('Pricing calculation failed');
      mockApiService.post.mockRejectedValue(error);

      const result = await MemberEnrollmentService.calculatePricingImpact(pricingRequest);

      expect(result.success).toBe(false);
      expect(result.data).toBeNull();
      expect(result.message).toBe('Pricing calculation failed');
      expect(result.error?.code).toBe('CALCULATE_PRICING_IMPACT_ERROR');
    });
  });
});

describe('mapEnrollmentProductDocuments', () => {
  it('maps PascalCase admin enrollment document rows', () => {
    expect(
      mapEnrollmentProductDocuments([
        { ProductDocumentId: 'doc-1', DocumentUrl: 'https://example.com/a.pdf', DisplayName: 'Summary', SortOrder: 1 },
      ])
    ).toEqual([
      { productDocumentId: 'doc-1', documentUrl: 'https://example.com/a.pdf', displayName: 'Summary', sortOrder: 1 },
    ]);
  });

  it('returns empty array for missing or invalid docs', () => {
    expect(mapEnrollmentProductDocuments(undefined)).toEqual([]);
    expect(mapEnrollmentProductDocuments([])).toEqual([]);
    expect(mapEnrollmentProductDocuments([{ DocumentUrl: '   ' }])).toEqual([]);
  });
});


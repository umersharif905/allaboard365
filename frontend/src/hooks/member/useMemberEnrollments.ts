import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EnrollmentRequest, GroupedEnrollment, MemberEnrollmentService } from '../../services/member/member-enrollments.service';

// Query Keys
export const memberEnrollmentKeys = {
  all: ['member-enrollments'] as const,
  enrollments: () => [...memberEnrollmentKeys.all, 'enrollments'] as const,
  products: () => [...memberEnrollmentKeys.all, 'products'] as const,
  productDetail: (id: string) => [...memberEnrollmentKeys.all, 'product', id] as const,
};

/**
 * Hook to get member's current enrollments
 */
export const useMemberEnrollments = () => {
  console.log('🚀 useMemberEnrollments hook called');
  return useQuery({
    queryKey: [...memberEnrollmentKeys.enrollments(), 'v2'], // Add version to bust cache
    queryFn: async () => {
      console.log('🔍 Making API call to getMyEnrollments');
      const response = await MemberEnrollmentService.getMyEnrollments();
      console.log('🔍 useMemberEnrollments - Service response:', response);
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch enrollments');
      }
      console.log('🔍 useMemberEnrollments - Returning data:', response.data);
      return response.data;
    },
    staleTime: 0, // Disable caching temporarily
    gcTime: 0, // Disable caching temporarily
  });
};

/**
 * Hook to get member's enrollments grouped by bundle
 * @param filterStatus - Filter by status: 'active', 'pending', or 'terminated'. If undefined, returns active enrollments only.
 */
export const useGroupedMemberEnrollments = (filterStatus?: 'active' | 'pending' | 'terminated') => {
  console.log('🚀 useGroupedMemberEnrollments hook called', { filterStatus });
  return useQuery({
    queryKey: [...memberEnrollmentKeys.enrollments(), 'grouped', 'v2', filterStatus], // Include filterStatus in cache key
    queryFn: async (): Promise<GroupedEnrollment[]> => {
      console.log('🔍 Making API call to getMyEnrollments for grouping', { filterStatus });
      const response = await MemberEnrollmentService.getMyEnrollments(filterStatus);
      console.log('🔍 useGroupedMemberEnrollments - Service response:', response);
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch enrollments');
      }
      
      // Group the enrollments by bundle
      const groupedEnrollments = MemberEnrollmentService.groupEnrollmentsByBundle(response.data);
      console.log('🔍 useGroupedMemberEnrollments - Grouped enrollments:', groupedEnrollments);
      return groupedEnrollments;
    },
    staleTime: 0, // Disable caching temporarily
    gcTime: 0, // Disable caching temporarily
  });
};

/**
 * Hook to get products available to member
 */
export const useAvailableProducts = () => {
  console.log('🚀 useAvailableProducts hook called');
  return useQuery({
    queryKey: [...memberEnrollmentKeys.products(), 'v2'], // Add version to bust cache
    queryFn: async () => {
      console.log('🔍 Making API call to getAvailableProducts');
      const response = await MemberEnrollmentService.getAvailableProducts();
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch available products');
      }
      return response.data;
    },
    staleTime: 0, // Disable caching temporarily
    gcTime: 0, // Disable caching temporarily
  });
};

/**
 * Hook to get detailed product information
 */
export const useProductDetail = (productId: string) => {
  return useQuery({
    queryKey: memberEnrollmentKeys.productDetail(productId),
    queryFn: async () => {
      const response = await MemberEnrollmentService.getProductDetail(productId);
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch product details');
      }
      return response.data;
    },
    enabled: !!productId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};

/**
 * Hook to submit enrollment request
 */
export const useSubmitEnrollment = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: EnrollmentRequest) => {
      const response = await MemberEnrollmentService.submitEnrollmentRequest(request);
      if (!response.success) {
        throw new Error(response.message || 'Failed to submit enrollment request');
      }
      return response.data;
    },
    onSuccess: () => {
      // Invalidate and refetch enrollments and products
      queryClient.invalidateQueries({ queryKey: memberEnrollmentKeys.enrollments() });
      queryClient.invalidateQueries({ queryKey: memberEnrollmentKeys.products() });
    },
  });
};

/**
 * Hook to cancel enrollment request
 */
export const useCancelEnrollment = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (enrollmentId: string) => {
      const response = await MemberEnrollmentService.cancelEnrollmentRequest(enrollmentId);
      if (!response.success) {
        throw new Error(response.message || 'Failed to cancel enrollment request');
      }
      return response.data;
    },
    onSuccess: () => {
      // Invalidate and refetch enrollments and products
      queryClient.invalidateQueries({ queryKey: memberEnrollmentKeys.enrollments() });
      queryClient.invalidateQueries({ queryKey: memberEnrollmentKeys.products() });
    },
  });
};

/**
 * Combined hook for member enrollment management
 */
export const useMemberEnrollmentManager = () => {
  console.log('🚀 useMemberEnrollmentManager hook called');
  const enrollments = useMemberEnrollments();
  const availableProducts = useAvailableProducts();
  const submitEnrollment = useSubmitEnrollment();
  const cancelEnrollment = useCancelEnrollment();

  return {
    // Data
    enrollments: enrollments.data || [],
    availableProducts: availableProducts.data || [],
    
    // Loading states
    isLoadingEnrollments: enrollments.isLoading,
    isLoadingProducts: availableProducts.isLoading,
    isSubmitting: submitEnrollment.isPending,
    isCancelling: cancelEnrollment.isPending,
    
    // Error states
    enrollmentsError: enrollments.error,
    productsError: availableProducts.error,
    submitError: submitEnrollment.error,
    cancelError: cancelEnrollment.error,
    
    // Actions
    submitEnrollmentRequest: submitEnrollment.mutate,
    cancelEnrollmentRequest: cancelEnrollment.mutate,
    
    // Refetch functions
    refetchEnrollments: enrollments.refetch,
    refetchProducts: availableProducts.refetch,
    
    // Combined loading state
    isLoading: enrollments.isLoading || availableProducts.isLoading,
    
    // Combined error state
    hasError: enrollments.isError || availableProducts.isError,
    
    // Success states
    submitSuccess: submitEnrollment.isSuccess,
    cancelSuccess: cancelEnrollment.isSuccess,
  };
};

export default useMemberEnrollmentManager;
/**
 * UNIFIED MEMBER PRODUCT MANAGEMENT SERVICE
 * 
 * Role-aware service for managing member products and enrollments
 * Routes to appropriate endpoint based on:
 * - Member managing their own data: /api/me/member/...
 * - Admin/Agent managing member data: /api/members/{memberId}/...
 */

import { apiService } from './api.service';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

export class MemberProductManagementService {
  /**
   * Get available products for a member
   * - If memberId provided: Use admin endpoint (admin managing member)
   * - If no memberId: Use member endpoint (member managing themselves)
   */
  static async getAvailableProducts(memberId?: string): Promise<ApiResponse<any[]>> {
    try {
      const endpoint = memberId 
        ? `/api/members/${memberId}/products`
        : '/api/me/member/products';

      console.log(`🔍 MemberProductManagementService.getAvailableProducts: Using endpoint ${endpoint}`);

      const response = await apiService.get<ApiResponse<any[]>>(endpoint);
      return response;

    } catch (error) {
      console.error('❌ Error fetching available products:', error);
      throw error;
    }
  }

  /**
   * Get enrollments for a member
   * - If memberId provided: Use admin endpoint (admin managing member)
   *   - For admin endpoints, fetch both Active and Pending enrollments to include future effective dates
   * - If no memberId: Use member endpoint (member managing themselves)
   */
  static async getMemberEnrollments(memberId?: string): Promise<ApiResponse<any[]>> {
    try {
      if (memberId) {
        // For admin managing member: fetch both Active and Pending enrollments
        // This ensures we get future effective enrollments that need to be cancellable
        console.log(`🔍 MemberProductManagementService.getMemberEnrollments: Fetching enrollments for member ${memberId}`);
        
        const [activeResponse, pendingResponse] = await Promise.all([
          apiService.get<ApiResponse<any[]>>(`/api/enrollments?memberId=${memberId}&status=Active`),
          apiService.get<ApiResponse<any[]>>(`/api/enrollments?memberId=${memberId}&status=Pending`)
        ]);
        
        const activeEnrollments = activeResponse.success ? (activeResponse.data || []) : [];
        const pendingEnrollments = pendingResponse.success ? (pendingResponse.data || []) : [];
        
        // Combine and deduplicate by EnrollmentId
        const allEnrollments = [...activeEnrollments, ...pendingEnrollments];
        const uniqueEnrollments = allEnrollments.filter((enrollment, index, self) => 
          index === self.findIndex(e => (e.EnrollmentId || e.enrollmentId) === (enrollment.EnrollmentId || enrollment.enrollmentId))
        );
        
        console.log(`🔍 MemberProductManagementService.getMemberEnrollments: Found ${activeEnrollments.length} Active, ${pendingEnrollments.length} Pending, ${uniqueEnrollments.length} total unique enrollments`);
        
        return {
          success: true,
          data: uniqueEnrollments
        };
      } else {
        // Member managing themselves: use member endpoint
        const endpoint = '/api/me/member/enrollments';
        console.log(`🔍 MemberProductManagementService.getMemberEnrollments: Using endpoint ${endpoint}`);
        const response = await apiService.get<ApiResponse<any[]>>(endpoint);
        return response;
      }

    } catch (error) {
      console.error('❌ Error fetching member enrollments:', error);
      throw error;
    }
  }

  /**
   * Get member profile
   * - If memberId provided: Use admin endpoint (admin managing member)
   * - If no memberId: Use member endpoint (member managing themselves)
   */
  static async getMemberProfile(memberId?: string): Promise<ApiResponse<any>> {
    try {
      const endpoint = memberId 
        ? `/api/members/${memberId}/profile`
        : '/api/me/member/profile';

      console.log(`🔍 MemberProductManagementService.getMemberProfile: Using endpoint ${endpoint}`);

      const response = await apiService.get<ApiResponse<any>>(endpoint);
      return response;

    } catch (error) {
      console.error('❌ Error fetching member profile:', error);
      throw error;
    }
  }

  /**
   * Get household data for a member
   * - If memberId provided: Use existing /api/members/{memberId}/with-household
   * - If no memberId: Use /api/me/member/household
   */
  static async getMemberHousehold(memberId?: string): Promise<ApiResponse<any>> {
    try {
      const endpoint = memberId 
        ? `/api/members/${memberId}/with-household`
        : '/api/me/member/household';

      console.log(`🔍 MemberProductManagementService.getMemberHousehold: Using endpoint ${endpoint}`);

      const response = await apiService.get<ApiResponse<any>>(endpoint);
      return response;

    } catch (error) {
      console.error('❌ Error fetching member household:', error);
      throw error;
    }
  }
}


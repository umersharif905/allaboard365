import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';

// Types for member-specific data
export interface Agent {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  agentCode?: string | null;
}

export interface MemberProfile {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  zip?: string; // Alias for zipCode for backward compatibility
  gender?: string; // Gender field
  memberStatus?: string;
  dateOfBirth?: Date;
  tobaccoUse?: string;
  tier?: string;
  relationshipType?: string;
  isPrimaryMember?: boolean;
  isSpouseDelegate?: boolean;
  actorRelationshipType?: string;
  jobPosition?: string; // Job position (e.g., 'employee', 'executive')
  age?: number;
  enrollmentDate?: Date;
  groupId?: string;
  tenantId?: string;
  /** Raw DB household member ID (integrations). */
  householdMemberId?: string | null;
  tenantMemberIDPrefix?: string | null;
  tenantIndividualMemberIDPrefix?: string | null;
  groupName?: string;
  agent?: Agent;
  billType?: 'LB' | 'SB'; // List Billing or Single Billing
  allowPlanModifications?: boolean; // Whether group allows members to modify their own plans
  nextBillingDate?: string;
  /** Nine digits only when on file (from API); never ciphertext */
  ssn?: string | null;
  /** Last 4 digits only (from API); same source as admin Member.SSNLast4 */
  ssnLast4?: string | null;
  paymentMethod?: string;
  paymentMethodDetails?: {
    method: string;
    cardType?: string;
    last4Digits?: string;
    expirationDate?: string;
    bankName?: string;
    accountType?: string;
    routingNumber?: string;
    accountNumber?: string;
    accountName?: string;
  };
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: {
    message: string;
    code: string;
  };
}

// Member profile service
export const MemberProfileService = {
  // Get member profile
  async getProfile(): Promise<ApiResponse<MemberProfile>> {
    try {
      console.log('Fetching member profile from API...');
      const response = await apiService.get<ApiResponse<MemberProfile>>('/api/me/member/profile');
      console.log('Profile response:', response);
      return response;
    } catch (error) {
      console.error('Failed to fetch member profile:', error);
      
      // Check for specific error types and provide better error messages
      let errorMessage = 'Unknown error occurred';
      let errorCode = 'UNKNOWN_ERROR';
      
      if (error && typeof error === 'object' && 'message' in error) {
        errorMessage = String(error.message);
        
        if (errorMessage.includes('404')) {
          errorMessage = 'Profile endpoint not found. The backend may not be configured correctly.';
          errorCode = 'ENDPOINT_NOT_FOUND';
        } else if (errorMessage.includes('401')) {
          errorMessage = 'Authentication required. Please log in again.';
          errorCode = 'AUTH_ERROR';
        } else if (errorMessage.includes('500')) {
          errorMessage = 'Server error. Please try again later.';
          errorCode = 'SERVER_ERROR';
        } else if (errorMessage.includes('Network Error')) {
          errorMessage = 'Network error. Please check your connection.';
          errorCode = 'NETWORK_ERROR';
        }
      }
      
      return {
        success: false,
        message: errorMessage,
        error: {
          message: errorMessage,
          code: errorCode
        }
      };
    }
  },
  
  // Update member profile
  async updateProfile(profileData: Partial<MemberProfile>): Promise<ApiResponse<MemberProfile>> {
    try {
      console.log('Updating member profile with data:', profileData);
      const response = await apiService.put<ApiResponse<MemberProfile>>('/api/me/member/profile', profileData);
      console.log('Update response:', response);
      return response;
    } catch (error) {
      console.error('Failed to update member profile:', error);
      
      // Check for specific error types and provide better error messages
      let errorMessage = 'Unknown error occurred';
      let errorCode = 'UNKNOWN_ERROR';
      
      if (error && typeof error === 'object' && 'message' in error) {
        errorMessage = String(error.message);
        
        if (errorMessage.includes('404')) {
          errorMessage = 'Profile update endpoint not found.';
          errorCode = 'ENDPOINT_NOT_FOUND';
        } else if (errorMessage.includes('401')) {
          errorMessage = 'Authentication required. Please log in again.';
          errorCode = 'AUTH_ERROR';
        } else if (errorMessage.includes('500')) {
          errorMessage = 'Server error. Please try again later.';
          errorCode = 'SERVER_ERROR';
        } else if (errorMessage.includes('Network Error')) {
          errorMessage = 'Network error. Please check your connection.';
          errorCode = 'NETWORK_ERROR';
        }
      }
      
      return {
        success: false,
        message: errorMessage,
        error: {
          message: errorMessage,
          code: errorCode
        }
      };
    }
  }
};

export const useMemberProfile = () => {
  const { user, isLoading: isAuthLoading } = useAuth();
  const queryClient = useQueryClient();
  
  const {
    data,
    isLoading,
    isError,
    error,
    refetch
  } = useQuery({
    queryKey: ['memberProfile'],
    queryFn: async () => {
      const response = await MemberProfileService.getProfile();
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch member profile');
      }
      return response.data;
    },
    enabled: !isAuthLoading && !!user && user.currentRole === 'Member',
    retry: 1, // Only retry once to avoid flooding logs with errors
    retryDelay: 1000 // Wait 1 second between retries
  });
  
  const updateProfile = useMutation({
    mutationFn: async (profileData: Partial<MemberProfile>) => {
      const response = await MemberProfileService.updateProfile(profileData);
      if (!response.success) {
        throw new Error(response.message || 'Failed to update member profile');
      }
      return response.data;
    },
    onSuccess: (updatedProfile) => {
      // Update the cache with the new profile data
      queryClient.setQueryData(['memberProfile'], updatedProfile);
    }
  });
  
  return {
    profile: data,
    isLoading,
    isError,
    error,
    refetch,
    updateProfile: updateProfile.mutate,
    isUpdating: updateProfile.isPending,
    updateError: updateProfile.error
  };
};

export default useMemberProfile; 
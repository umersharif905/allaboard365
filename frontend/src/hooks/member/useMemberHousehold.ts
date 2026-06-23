import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiService } from '../../services/api.service';

// Types
export interface HouseholdMember {
  MemberId: string;
  UserId: string;
  GroupId?: string | null;
  RelationshipType: 'P' | 'S' | 'C';
  RelationshipDescription: string;
  MemberSequence: number;
  HouseholdMemberID?: string;
  TenantMemberIDPrefix?: string | null;
  TenantIndividualMemberIDPrefix?: string | null;
  Status: string;
  DateOfBirth?: string;
  Gender?: string;
  Address?: string;
  City?: string;
  State?: string;
  Zip?: string;
  TerminationDate?: string;
  FirstName: string;
  LastName: string;
  Email: string;
  PhoneNumber?: string;
  UserStatus?: string;
  UserTerminationDate?: string;
  IsCurrentUser: boolean;
  IsExpired: boolean;
  IsPendingTermination: boolean;
  EffectiveTerminationDate?: string;
  /** Nine digits when on file (from API) */
  ssn?: string | null;
  ssnLast4?: string | null;
}

export interface HouseholdData {
  householdMembers: HouseholdMember[];
  currentMemberRelationship: 'P' | 'S' | 'C';
  canManageHousehold: boolean;
}

export interface AddDependentData {
  firstName: string;
  lastName: string;
  /** Required for spouse; omitted for child (server generates placeholder) */
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: string;
  relationshipType: 'S' | 'C';
  /** Optional; nine digits, stored encrypted */
  ssn?: string;
}

export interface UpdateDependentData {
  firstName: string;
  lastName: string;
  /** Spouse only; omit or empty to leave unchanged (e.g. placeholder noemail.com). Not used for children. */
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: string;
  /** Nine digits when setting/updating; omit or empty to leave unchanged on update */
  ssn?: string;
}

// API Service functions
const HouseholdService = {
  async getHousehold(memberId?: string, includeInactive?: boolean): Promise<{ success: boolean; data: HouseholdData; message?: string }> {
    try {
      // If memberId is provided, use the admin endpoint for that specific member
      // Otherwise, use the current user's endpoint
      let endpoint = memberId 
        ? `/api/members/${memberId}/household`
        : '/api/me/member/household';
      if (!memberId && includeInactive) {
        endpoint += '?includeInactive=true';
      }
      
      return await apiService.get<{ success: boolean; data: HouseholdData }>(endpoint);
    } catch (error) {
      console.error('Failed to fetch household:', error);
      throw error;
    }
  },

  async addDependent(dependentData: AddDependentData): Promise<{ success: boolean; data: HouseholdMember; message?: string }> {
    try {
      return await apiService.post<{ success: boolean; data: HouseholdMember }>('/api/me/member/household/members', dependentData);
    } catch (error) {
      console.error('Failed to add dependent:', error);
      throw error;
    }
  },

  async updateDependent(memberId: string, dependentData: UpdateDependentData): Promise<{ success: boolean; data: HouseholdMember; message?: string }> {
    try {
      return await apiService.put<{ success: boolean; data: HouseholdMember }>(`/api/me/member/household/members/${memberId}`, dependentData);
    } catch (error) {
      console.error('Failed to update dependent:', error);
      throw error;
    }
  },

  async removeDependent(memberId: string): Promise<{ success: boolean; message?: string }> {
    try {
      console.log('🗑️ HouseholdService.removeDependent called for member:', memberId);
      const result = await apiService.delete<{ success: boolean; message?: string }>(`/api/me/member/household/members/${memberId}`);
      console.log('✅ HouseholdService.removeDependent response:', result);
      return result;
    } catch (error) {
      console.error('❌ Failed to remove dependent:', error);
      throw error;
    }
  }
};

// Main hook for household data
export const useMemberHousehold = (memberId?: string, enabled: boolean = true, includeInactive?: boolean) => {
  const query = useQuery({
    queryKey: ['memberHousehold', memberId, enabled, includeInactive], // Include includeInactive so refetch gets inactive when toggled
    queryFn: async () => {
      // Safety check: if disabled or memberId provided, skip execution
      if (!enabled || memberId) {
        console.log('⏭️ useMemberHousehold queryFn skipped - enabled:', enabled, 'memberId:', memberId);
        return null;
      }
      
      console.log('🔄 useMemberHousehold queryFn called - fetching household data for current user');
      
      const response = await HouseholdService.getHousehold(memberId, includeInactive);
      if (!response.success || !response.data) {
        // If member record not found, return empty household instead of throwing
        if (response.message?.includes('Member profile not found') || response.message?.includes('Member not found')) {
          console.warn('⚠️ Member record not found - returning empty household data');
          return {
            householdMembers: [],
            currentMemberRelationship: 'P' as const,
            canManageHousehold: false
          };
        }
        throw new Error(response.message || 'Failed to fetch household data');
      }
      console.log('✅ useMemberHousehold queryFn completed - household data:', response.data);
      return response.data;
    },
    enabled: enabled && !memberId, // Only fetch when enabled AND NOT managing for another member (no memberId provided)
    retry: false, // Don't retry on 404 errors
    retryDelay: 1000,
  });

  // Log when query is enabled/disabled
  console.log('🔍 useMemberHousehold hook state:', { 
    enabled: enabled && !memberId, 
    memberId, 
    enabledParam: enabled,
    queryEnabled: query.isEnabled,
    queryStatus: query.status 
  });

  return {
    ...query,
    refetch: query.refetch
  };
};

// Mutation hooks for household management
export const useMemberHouseholdMutations = () => {
  const queryClient = useQueryClient();

  const addDependent = useMutation({
    mutationFn: (dependentData: AddDependentData) => HouseholdService.addDependent(dependentData),
    onSuccess: () => {
      // Invalidate and refetch household data
      queryClient.invalidateQueries({ queryKey: ['memberHousehold'] });
    },
    onError: (error) => {
      console.error('Error adding dependent:', error);
    }
  });

  const updateDependent = useMutation({
    mutationFn: ({ memberId, dependentData }: { memberId: string; dependentData: UpdateDependentData }) => 
      HouseholdService.updateDependent(memberId, dependentData),
    onSuccess: () => {
      // Invalidate and refetch household data
      queryClient.invalidateQueries({ queryKey: ['memberHousehold'] });
    },
    onError: (error) => {
      console.error('Error updating dependent:', error);
    }
  });

  const removeDependent = useMutation({
    mutationFn: (memberId: string) => HouseholdService.removeDependent(memberId),
    onSuccess: (data, memberId) => {
      console.log('🔄 Removing dependent mutation succeeded, invalidating cache for member:', memberId);
      // Invalidate and refetch household data
      queryClient.invalidateQueries({ queryKey: ['memberHousehold'] });
      console.log('✅ Cache invalidated for memberHousehold');
    },
    onError: (error) => {
      console.error('❌ Error removing dependent:', error);
    }
  });

  return {
    addDependent,
    updateDependent,
    removeDependent
  };
};
import { useQuery } from '@tanstack/react-query';
import { GroupsService, type ContributionRule } from '../services/groups.service';

/**
 * Hook to fetch group contribution rules
 * Uses GroupsService which follows backend-system.md patterns (apiService)
 * 
 * @param groupId - The ID of the group
 * @returns Query result with contribution rules data
 */
const fetchGroupContributionRules = async (groupId: string): Promise<ContributionRule[]> => {
  console.log(`🔍 fetchGroupContributionRules called with groupId: ${groupId}`);
  
  try {
    const response = await GroupsService.getGroupContributions(groupId);
    
    if (!response.success) {
      console.error(`❌ API returned success: false for group ${groupId}:`, response.message);
      throw new Error(response.message || 'Failed to fetch contribution rules');
    }

    // Filter out any invalid rules and inactive rules
    const validRules = (response.data || []).filter((rule: ContributionRule) => 
      rule && 
      rule.contributionId && 
      rule.name && 
      rule.contributionType &&
      rule.status !== 'Inactive' && // Don't show deleted/inactive rules
      ['flat_rate', 'percentage', 'tier_based', 'role_based', 'tenure_based', 'age_based', 'division_based', 'override', 'minimum_threshold'].includes(rule.contributionType)
    );

    console.log(`✅ Fetched ${validRules.length} contribution rules for group ${groupId}`);
    return validRules;
    
  } catch (error) {
    console.error(`❌ Error in fetchGroupContributionRules for group ${groupId}:`, error);
    throw error;
  }
};

export const useGroupContributionRules = (groupId: string) => {
  console.log('🔍 useGroupContributionRules - groupId:', groupId);
  console.log('🔍 useGroupContributionRules - enabled:', !!groupId);
  
  return useQuery({
    queryKey: ['groupContributionRules', groupId],
    queryFn: () => {
      console.log('🔍 useGroupContributionRules - queryFn called for groupId:', groupId);
      return fetchGroupContributionRules(groupId);
    },
    enabled: !!groupId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 2,
  });
};

// Re-export ContributionRule type from GroupsService
export type { ContributionRule };

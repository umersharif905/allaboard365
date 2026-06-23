import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import type { ApiResponse } from '../../types/index';
import {
  AgentLicenseValidationData,
  AgentProfileValidationData,
  AgentValidationCheck,
  buildAgentValidationSummary,
  buildEnrollmentLinkCreationSummary
} from '../../utils/agent-validation';

interface UseAgentProfileCompletionRequirementOptions {
  enabled?: boolean;
  /** full: all profile fields + at least one active license; enrollment-links: W-9 + banking only */
  requirementScope?: 'full' | 'enrollment-links';
}

export const useAgentProfileCompletionRequirement = (
  { enabled = true, requirementScope = 'full' }: UseAgentProfileCompletionRequirementOptions = {}
) => {
  const { user } = useAuth();
  const isAgent = user?.currentRole === 'Agent';
  const shouldCheck = enabled && isAgent;

  const [isProfileComplete, setIsProfileComplete] = useState(true);
  const [nextMissing, setNextMissing] = useState<AgentValidationCheck | null>(null);
  const [isLoading, setIsLoading] = useState(shouldCheck);

  const revalidate = useCallback(async () => {
    if (!shouldCheck) {
      setIsProfileComplete(true);
      setNextMissing(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const profileResponse = await apiService.get<ApiResponse<AgentProfileValidationData>>('/api/me/agent/profile');

      if (!profileResponse.success || !profileResponse.data) {
        setIsProfileComplete(true);
        setNextMissing(null);
        return;
      }

      if (requirementScope === 'enrollment-links') {
        const summary = buildEnrollmentLinkCreationSummary(profileResponse.data);
        setIsProfileComplete(summary.missing.length === 0);
        setNextMissing(summary.missing[0] ?? null);
        return;
      }

      const licensesResponse = await apiService.get<ApiResponse<AgentLicenseValidationData[]>>('/api/me/agent/licenses');
      const licenses = licensesResponse.success && Array.isArray(licensesResponse.data)
        ? licensesResponse.data
        : [];
      const summary = buildAgentValidationSummary(profileResponse.data, licenses);

      setIsProfileComplete(summary.missing.length === 0);
      setNextMissing(summary.missing[0] ?? null);
    } catch {
      setIsProfileComplete(true);
      setNextMissing(null);
    } finally {
      setIsLoading(false);
    }
  }, [shouldCheck, requirementScope]);

  useEffect(() => {
    void revalidate();
  }, [revalidate]);

  useEffect(() => {
    if (!shouldCheck) {
      return;
    }

    const handleValidationRevalidate = () => {
      void revalidate();
    };

    window.addEventListener('agent-validation-revalidate', handleValidationRevalidate);
    return () => {
      window.removeEventListener('agent-validation-revalidate', handleValidationRevalidate);
    };
  }, [revalidate, shouldCheck]);

  return {
    isProfileComplete,
    nextMissing,
    isLoading,
    revalidate,
  };
};

export default useAgentProfileCompletionRequirement;

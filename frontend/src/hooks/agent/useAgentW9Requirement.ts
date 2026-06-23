import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import type { ApiResponse } from '../../types/index';

interface AgentW9ProfileResponse {
  W9Stored?: boolean;
}

interface UseAgentW9RequirementOptions {
  enabled?: boolean;
}

export const useAgentW9Requirement = ({ enabled = true }: UseAgentW9RequirementOptions = {}) => {
  const { user } = useAuth();
  const isAgent = user?.currentRole === 'Agent';
  const shouldCheck = enabled && isAgent;

  const [hasW9, setHasW9] = useState(true);
  const [isLoading, setIsLoading] = useState(shouldCheck);

  const revalidate = useCallback(async () => {
    if (!shouldCheck) {
      setHasW9(true);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const response = await apiService.get<ApiResponse<AgentW9ProfileResponse>>('/api/me/agent/profile');
      if (response.success && response.data) {
        setHasW9(Boolean(response.data.W9Stored));
      } else {
        setHasW9(false);
      }
    } catch {
      setHasW9(false);
    } finally {
      setIsLoading(false);
    }
  }, [shouldCheck]);

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
    hasW9,
    isLoading,
    revalidate,
  };
};

export default useAgentW9Requirement;

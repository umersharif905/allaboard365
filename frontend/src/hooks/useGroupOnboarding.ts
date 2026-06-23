import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CompleteOnboardingRequest, GroupOnboardingService, SetupPasswordRequest } from '../services/group-onboarding.service';

export const useGroupOnboardingData = (linkToken: string) => {
  return useQuery({
    queryKey: ['groupOnboarding', linkToken],
    queryFn: () => GroupOnboardingService.getOnboardingData(linkToken),
    enabled: !!linkToken,
    retry: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

export const useCompleteOnboarding = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ linkToken, data }: { linkToken: string; data: CompleteOnboardingRequest }) =>
      GroupOnboardingService.completeOnboarding(linkToken, data),
    onSuccess: (data, variables) => {
      // Invalidate the onboarding data query to refresh it
      queryClient.invalidateQueries({ queryKey: ['groupOnboarding', variables.linkToken] });
    },
  });
};

export const useSetupPassword = () => {
  return useMutation({
    mutationFn: ({ linkToken, data }: { linkToken: string; data: SetupPasswordRequest }) =>
      GroupOnboardingService.setupPassword(linkToken, data),
  });
};

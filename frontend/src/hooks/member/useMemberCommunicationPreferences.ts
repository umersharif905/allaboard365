import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiService } from '../../services/api.service';

export interface MemberCommunicationPrefs {
  emailMarketingEnabled: boolean;
  smsMarketingEnabled: boolean;
  smsConsentGranted: boolean;
}

interface PrefsResponse {
  success: boolean;
  data?: MemberCommunicationPrefs;
  message?: string;
}

export function useMemberCommunicationPreferences() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['member', 'communication-preferences'],
    queryFn: async () => {
      const res = await apiService.get<PrefsResponse>('/api/me/member/communication-preferences');
      if (!res.success || !res.data) {
        throw new Error(res.message || 'Failed to load communication preferences');
      }
      return res.data;
    }
  });

  const mutation = useMutation({
    mutationFn: async (body: {
      emailMarketingEnabled?: boolean;
      smsMarketingEnabled?: boolean;
    }) => {
      const res = await apiService.put<PrefsResponse>('/api/me/member/communication-preferences', body);
      if (!res.success || !res.data) {
        throw new Error(res.message || 'Failed to save preferences');
      }
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member', 'communication-preferences'] });
    }
  });

  return {
    ...query,
    savePreferences: mutation.mutateAsync,
    isSaving: mutation.isPending,
    saveError: mutation.error
  };
}

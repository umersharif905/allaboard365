import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiService } from '../../services/api.service';

export interface AgentNotificationPrefs {
  enrollmentNotificationsEnabled: boolean;
  paymentAlertsEnabled: boolean;
  marketingEnabled: boolean;
}

interface PrefsResponse {
  success: boolean;
  data?: AgentNotificationPrefs;
  message?: string;
}

export function useAgentNotificationPreferences() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['agent', 'notification-preferences'],
    queryFn: async () => {
      const res = await apiService.get<PrefsResponse>('/api/me/agent/notification-preferences');
      if (!res.success || !res.data) {
        throw new Error(res.message || 'Failed to load notification preferences');
      }
      return res.data;
    }
  });

  const mutation = useMutation({
    mutationFn: async (body: Partial<AgentNotificationPrefs>) => {
      const res = await apiService.put<PrefsResponse>('/api/me/agent/notification-preferences', body);
      if (!res.success || !res.data) {
        throw new Error(res.message || 'Failed to save notification preferences');
      }
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent', 'notification-preferences'] });
    }
  });

  return {
    ...query,
    savePreferences: mutation.mutateAsync,
    isSaving: mutation.isPending,
    saveError: mutation.error
  };
}

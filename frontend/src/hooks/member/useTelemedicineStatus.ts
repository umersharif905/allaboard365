import { useQuery } from '@tanstack/react-query';
import { TelemedicineService, TelemedicineStatusData } from '../../services/member/telemedicine.service';

const telemedicineKeys = {
  all: ['member', 'telemedicine'] as const,
  status: () => [...telemedicineKeys.all, 'status'] as const
};

export const useTelemedicineStatus = () => {
  return useQuery({
    queryKey: telemedicineKeys.status(),
    queryFn: async (): Promise<TelemedicineStatusData | null> => {
      const response = await TelemedicineService.getStatus();
      if (!response.success) {
        throw new Error(response.message || 'Failed to load telemedicine status');
      }
      return response.data ?? null;
    },
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000
  });
};

export default useTelemedicineStatus;

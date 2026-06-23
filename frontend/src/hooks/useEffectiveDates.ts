// frontend/src/hooks/useEffectiveDates.ts
import { useQuery } from '@tanstack/react-query';
import { EffectiveDatesResponse, EffectiveDatesService } from '../services/effective-dates.service';

export const useEffectiveDates = (memberId: string | undefined, selectedProducts: string[] = []) => {
  return useQuery({
    queryKey: ['effective-dates', memberId, selectedProducts],
    queryFn: async () => {
      // For Agent-Static links, memberId will be undefined - backend will handle this
      const response = await EffectiveDatesService.getEffectiveDates(memberId || '', selectedProducts);
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch effective dates');
      }
      
      return response.data as EffectiveDatesResponse;
    },
    // Enable the query even without memberId (for Agent-Static links)
    // The backend will default to individual enrollment logic
    enabled: true,
    staleTime: 2 * 60 * 1000, // 2 minutes (shorter since it depends on product selection)
    gcTime: 5 * 60 * 1000, // 5 minutes
  });
};

export default useEffectiveDates;

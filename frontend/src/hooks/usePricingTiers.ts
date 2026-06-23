import { useQuery } from '@tanstack/react-query';

interface PricingTier {
  id: string;
  tierType: string;
  label?: string;
  ageBands: any[];
}

const fetchPricingTiers = async (): Promise<PricingTier[]> => {
  return [];
};

export const usePricingTiers = () => {
  return useQuery({
    queryKey: ['pricingTiers'],
    queryFn: fetchPricingTiers,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

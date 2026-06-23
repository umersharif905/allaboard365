import { useQuery } from '@tanstack/react-query';

interface PlanDetails {
  id: string;
  name: string;
  data: any;
}

const fetchPlanDetails = async (): Promise<PlanDetails[]> => {
  return [];
};

export const usePlanDetails = () => {
  return useQuery({
    queryKey: ['planDetails'],
    queryFn: fetchPlanDetails,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

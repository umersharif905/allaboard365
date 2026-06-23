import { useQuery } from '@tanstack/react-query';

interface EffectiveDateLogic {
  id: string;
  name: string;
  description?: string;
}

const fetchEffectiveDateLogics = async (): Promise<EffectiveDateLogic[]> => {
  return [
    { id: '1', name: 'Immediate', description: 'Effective immediately' },
    { id: '2', name: 'First of Month', description: 'Effective first of next month' },
    { id: '3', name: 'First of Quarter', description: 'Effective first of next quarter' },
  ];
};

export const useEffectiveDateLogics = () => {
  return useQuery({
    queryKey: ['effectiveDateLogics'],
    queryFn: fetchEffectiveDateLogics,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

import { useQuery } from '@tanstack/react-query';

interface TerminationLogic {
  id: string;
  name: string;
  description?: string;
}

const fetchTerminationLogics = async (): Promise<TerminationLogic[]> => {
  return [
    { id: '1', name: 'End of Month', description: 'Terminate at end of month' },
    { id: '2', name: 'End of Quarter', description: 'Terminate at end of quarter' },
    { id: '3', name: 'End of Year', description: 'Terminate at end of year' },
  ];
};

export const useTerminationLogics = () => {
  return useQuery({
    queryKey: ['terminationLogics'],
    queryFn: fetchTerminationLogics,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

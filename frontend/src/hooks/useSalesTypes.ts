import { useQuery } from '@tanstack/react-query';

interface SalesType {
  id: string;
  name: string;
  description?: string;
}

const fetchSalesTypes = async (): Promise<SalesType[]> => {
  return [
    { id: '1', name: 'Direct', description: 'Direct sales' },
    { id: '2', name: 'Agent', description: 'Agent sales' },
    { id: '3', name: 'Broker', description: 'Broker sales' },
  ];
};

export const useSalesTypes = () => {
  return useQuery({
    queryKey: ['salesTypes'],
    queryFn: fetchSalesTypes,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

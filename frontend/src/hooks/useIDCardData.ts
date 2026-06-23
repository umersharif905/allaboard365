import { useQuery } from '@tanstack/react-query';

interface IDCardData {
  id: string;
  name: string;
  data: any;
}

const fetchIDCardData = async (): Promise<IDCardData[]> => {
  return [];
};

export const useIDCardData = () => {
  return useQuery({
    queryKey: ['idCardData'],
    queryFn: fetchIDCardData,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

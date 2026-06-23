import { useQuery } from '@tanstack/react-query';

interface RequiredASA {
  id: string;
  documentId: string;
  documentName: string;
  documentUrl: string;
}

const fetchRequiredASA = async (): Promise<RequiredASA[]> => {
  return [];
};

export const useRequiredASA = () => {
  return useQuery({
    queryKey: ['requiredASA'],
    queryFn: fetchRequiredASA,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

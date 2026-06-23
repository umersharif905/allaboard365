import { useQuery } from '@tanstack/react-query';

interface ProductOwner {
  id: string;
  name: string;
  email?: string;
}

const fetchProductOwners = async (): Promise<ProductOwner[]> => {
  return [
    { id: '1', name: 'John Smith', email: 'john@example.com' },
    { id: '2', name: 'Jane Doe', email: 'jane@example.com' },
  ];
};

export const useProductOwners = () => {
  return useQuery({
    queryKey: ['productOwners'],
    queryFn: fetchProductOwners,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

import { useQuery } from '@tanstack/react-query';

interface ProductType {
  id: string;
  name: string;
  description?: string;
}

const fetchProductTypes = async (): Promise<ProductType[]> => {
  // Mock data for now - replace with actual API call
  return [
    { id: '1', name: 'Health', description: 'Health insurance products' },
    { id: '2', name: 'Dental', description: 'Dental insurance products' },
    { id: '3', name: 'Vision', description: 'Vision insurance products' },
    { id: '4', name: 'Life', description: 'Life insurance products' },
    { id: '5', name: 'Disability', description: 'Disability insurance products' },
    { id: '6', name: 'Bundle', description: 'Product bundles' },
  ];
};

export const useProductTypes = () => {
  return useQuery({
    queryKey: ['productTypes'],
    queryFn: fetchProductTypes,
    staleTime: 10 * 60 * 1000, // 10 minutes
    retry: 2,
  });
};

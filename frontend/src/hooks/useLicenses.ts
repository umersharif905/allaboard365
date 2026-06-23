import { useQuery } from '@tanstack/react-query';

interface License {
  id: string;
  name: string;
  description?: string;
}

const fetchLicenses = async (): Promise<License[]> => {
  return [
    { id: '1', name: 'Life Insurance License', description: 'Required for life insurance products' },
    { id: '2', name: 'Health Insurance License', description: 'Required for health insurance products' },
    { id: '3', name: 'Property & Casualty License', description: 'Required for P&C products' },
  ];
};

export const useLicenses = () => {
  return useQuery({
    queryKey: ['licenses'],
    queryFn: fetchLicenses,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

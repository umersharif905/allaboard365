import { useQuery } from '@tanstack/react-query';

interface ConfigurationField {
  id: string;
  fieldName: string;
  fieldOptions: string[];
}

const fetchConfigurationFields = async (): Promise<ConfigurationField[]> => {
  return [
    { id: '1', fieldName: 'Coverage Level', fieldOptions: ['Basic', 'Standard', 'Premium'] },
    { id: '2', fieldName: 'Deductible', fieldOptions: ['$500', '$1000', '$2500', '$5000'] },
  ];
};

export const useConfigurationFields = () => {
  return useQuery({
    queryKey: ['configurationFields'],
    queryFn: fetchConfigurationFields,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

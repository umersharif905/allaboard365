import { useQuery } from '@tanstack/react-query';

interface State {
  id: string;
  name: string;
  code: string;
}

const fetchStates = async (): Promise<State[]> => {
  // Mock data for now - replace with actual API call
  return [
    { id: '1', name: 'Alabama', code: 'AL' },
    { id: '2', name: 'Alaska', code: 'AK' },
    { id: '3', name: 'Arizona', code: 'AZ' },
    { id: '4', name: 'Arkansas', code: 'AR' },
    { id: '5', name: 'California', code: 'CA' },
    { id: '6', name: 'Colorado', code: 'CO' },
    { id: '7', name: 'Connecticut', code: 'CT' },
    { id: '8', name: 'Delaware', code: 'DE' },
    { id: '9', name: 'Florida', code: 'FL' },
    { id: '10', name: 'Georgia', code: 'GA' },
    // Add more states as needed
  ];
};

export const useStates = () => {
  return useQuery({
    queryKey: ['states'],
    queryFn: fetchStates,
    staleTime: 10 * 60 * 1000, // 10 minutes
    retry: 2,
  });
};

import { useQuery } from '@tanstack/react-query';

interface AcknowledgementQuestion {
  id: string;
  question: string;
  fieldType: string;
  required: boolean;
  options?: string[];
}

const fetchAcknowledgementQuestions = async (): Promise<AcknowledgementQuestion[]> => {
  return [
    { id: '1', question: 'Do you understand the coverage terms?', fieldType: 'checkbox', required: true },
    { id: '2', question: 'Have you read the policy documents?', fieldType: 'checkbox', required: true },
  ];
};

export const useAcknowledgementQuestions = () => {
  return useQuery({
    queryKey: ['acknowledgementQuestions'],
    queryFn: fetchAcknowledgementQuestions,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

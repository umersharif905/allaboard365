import { useQuery } from '@tanstack/react-query';

interface AIChunk {
  id: string;
  chunk_text: string;
  created_at?: string;
}

const fetchAIChunks = async (): Promise<AIChunk[]> => {
  return [];
};

export const useAIChunks = () => {
  return useQuery({
    queryKey: ['aiChunks'],
    queryFn: fetchAIChunks,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

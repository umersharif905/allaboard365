import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  aiTenantKnowledgeService,
  type TenantKnowledgeFilters,
} from '../services/aiTenantKnowledge.service';
import { updateProductChunk, deleteProductChunk } from '../services/productChunks.service';

export const useTenantKnowledgeChunks = (filters: TenantKnowledgeFilters) =>
  useQuery({
    queryKey: ['tenantKnowledgeChunks', filters],
    queryFn: () => aiTenantKnowledgeService.listChunks(filters),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });

export const useTenantKnowledgeStats = () =>
  useQuery({
    queryKey: ['tenantKnowledgeStats'],
    queryFn: () => aiTenantKnowledgeService.getStats(),
    staleTime: 60_000,
  });

export const useTenantKnowledgeProducts = () =>
  useQuery({
    queryKey: ['tenantKnowledgeProducts'],
    queryFn: () => aiTenantKnowledgeService.listProducts(),
    staleTime: 60_000,
  });

const invalidateAll = (queryClient: ReturnType<typeof useQueryClient>) => {
  queryClient.invalidateQueries({ queryKey: ['tenantKnowledgeChunks'] });
  queryClient.invalidateQueries({ queryKey: ['tenantKnowledgeStats'] });
  queryClient.invalidateQueries({ queryKey: ['tenantKnowledgeProducts'] });
};

export const useUpdateTenantChunk = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, chunkId, payload }: {
      productId: string;
      chunkId: string;
      payload: { chunkText?: string; question?: string; title?: string };
    }) => updateProductChunk(productId, chunkId, payload),
    onSuccess: () => invalidateAll(queryClient),
  });
};

export const useDeleteTenantChunk = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, chunkId }: { productId: string; chunkId: string }) =>
      deleteProductChunk(productId, chunkId),
    onSuccess: () => invalidateAll(queryClient),
  });
};

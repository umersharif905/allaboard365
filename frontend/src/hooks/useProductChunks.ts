import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchProductChunks,
  createProductChunk,
  updateProductChunk,
  deleteProductChunk,
  regenerateAllProductChunks,
} from '../services/productChunks.service';
import type { AIChunk, ChunkType } from '../types/aiChunks';

const key = (productId: string) => ['productChunks', productId];

export function useProductChunks(productId: string | undefined) {
  return useQuery<AIChunk[]>({
    queryKey: key(productId || ''),
    queryFn: () => fetchProductChunks(productId as string),
    enabled: !!productId,
  });
}

export function useCreateChunk(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { chunkType: ChunkType; chunkText: string; question?: string; title?: string }) =>
      createProductChunk(productId, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(productId) }),
  });
}

export function useUpdateChunk(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      chunkId,
      ...payload
    }: { chunkId: string; chunkText?: string; question?: string; title?: string }) =>
      updateProductChunk(productId, chunkId, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(productId) }),
  });
}

export function useDeleteChunk(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chunkId: string) => deleteProductChunk(productId, chunkId),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(productId) }),
  });
}

export function useRegenerateAll(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => regenerateAllProductChunks(productId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key(productId) });
      qc.invalidateQueries({ queryKey: ['productDocuments', productId] });
    },
  });
}

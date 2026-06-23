import apiClient from './apiClient';
import type { AIChunk, ChunkType } from '../types/aiChunks';

export async function fetchProductChunks(productId: string): Promise<AIChunk[]> {
  const res = await apiClient.post('/api/ai/chunks', {
    systemAreas: ['Product'],
    userRole: 'TenantAdmin',
    productId,
  });
  return ((res.data as { chunks?: AIChunk[] })?.chunks ?? []) as AIChunk[];
}

export async function createProductChunk(
  productId: string,
  payload: { chunkType: ChunkType; chunkText: string; question?: string; title?: string }
): Promise<AIChunk> {
  const res = await apiClient.post(`/api/products/${productId}/chunks`, payload);
  return (res.data as { chunk: AIChunk }).chunk;
}

export async function updateProductChunk(
  productId: string,
  chunkId: string,
  payload: { chunkText?: string; question?: string; title?: string }
): Promise<AIChunk> {
  const res = await apiClient.put(`/api/products/${productId}/chunks/${chunkId}`, payload);
  return (res.data as { chunk: AIChunk }).chunk;
}

export async function deleteProductChunk(productId: string, chunkId: string): Promise<void> {
  await apiClient.delete(`/api/products/${productId}/chunks/${chunkId}`);
}

export async function regenerateDocumentChunks(productId: string, documentId: string): Promise<void> {
  try {
    await apiClient.post(`/api/products/${productId}/documents/${documentId}/regenerate-chunks`);
  } catch (err: unknown) {
    const message =
      err && typeof err === 'object' && 'message' in err && typeof (err as { message: string }).message === 'string'
        ? (err as { message: string }).message
        : 'Failed to regenerate document chunks.';
    throw new Error(message);
  }
}

export async function regenerateAllProductChunks(productId: string): Promise<void> {
  await apiClient.post(`/api/products/${productId}/chunks/regenerate-all`);
}

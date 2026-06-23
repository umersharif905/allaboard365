import apiClient from './apiClient';

export type ChunkType = 'prose' | 'faq';
export type ChunkSource = 'ai' | 'manual';
export type SortBy = 'avgRating' | 'ratingCount' | 'modifiedDate' | 'productName';
export type SortDir = 'asc' | 'desc';

export interface TenantKnowledgeChunk {
  AIChunkId: string;
  ProductId: string | null;
  ProductName: string | null;
  ProductIsBundle: boolean;
  ChunkType: ChunkType;
  Source: ChunkSource;
  Question: string | null;
  Title: string | null;
  ChunkText: string;
  SourceDocumentId: string | null;
  CreatedDate: string;
  ModifiedDate: string | null;
  AvgRating: number | null;
  RatingCount: number;
}

export interface TenantKnowledgeFilters {
  search?: string;
  productId?: string | null;
  chunkType?: ChunkType | null;
  source?: ChunkSource | null;
  minRating?: number | null;
  hasRating?: boolean;
  sortBy?: SortBy;
  sortDir?: SortDir;
  page?: number;
  pageSize?: number;
}

export interface TenantKnowledgeListResponse {
  success: boolean;
  chunks: TenantKnowledgeChunk[];
  page: number;
  pageSize: number;
  totalCount: number;
}

export interface TenantKnowledgeStats {
  totalChunks: number;
  byType: { prose: number; faq: number };
  bySource: { ai: number; manual: number };
  productsWithChunks: number;
  ratedChunks: number;
  overallAvgRating: number | null;
}

export interface TenantKnowledgeProduct {
  productId: string;
  name: string;
  isBundle: boolean;
  chunkCount: number;
  avgRating: number | null;
}

const cleanParams = (filters: TenantKnowledgeFilters): Record<string, string> => {
  const params: Record<string, string> = {};
  if (filters.search?.trim())  params.search = filters.search.trim();
  if (filters.productId)       params.productId = filters.productId;
  if (filters.chunkType)       params.chunkType = filters.chunkType;
  if (filters.source)          params.source = filters.source;
  if (filters.minRating != null) params.minRating = String(filters.minRating);
  if (filters.hasRating)       params.hasRating = 'true';
  if (filters.sortBy)          params.sortBy = filters.sortBy;
  if (filters.sortDir)         params.sortDir = filters.sortDir;
  if (filters.page)            params.page = String(filters.page);
  if (filters.pageSize)        params.pageSize = String(filters.pageSize);
  return params;
};

export const aiTenantKnowledgeService = {
  async listChunks(filters: TenantKnowledgeFilters): Promise<TenantKnowledgeListResponse> {
    const { data } = await apiClient.get('/api/ai/tenant-knowledge/chunks', { params: cleanParams(filters) });
    return data as TenantKnowledgeListResponse;
  },
  async getStats(): Promise<{ success: boolean; stats: TenantKnowledgeStats }> {
    const { data } = await apiClient.get('/api/ai/tenant-knowledge/stats');
    return data as { success: boolean; stats: TenantKnowledgeStats };
  },
  async listProducts(): Promise<{ success: boolean; products: TenantKnowledgeProduct[] }> {
    const { data } = await apiClient.get('/api/ai/tenant-knowledge/products');
    return data as { success: boolean; products: TenantKnowledgeProduct[] };
  },
};

export type ChunkType = 'prose' | 'faq';
export type ChunkSource = 'ai' | 'manual';
export type ExtractionStatus = 'queued' | 'running' | 'completed' | 'failed' | null;

export interface AIChunk {
  AIChunkId: string;
  ProductId: string | null;
  TenantId?: string;
  SystemArea: string;
  ChunkType: ChunkType;
  Source: ChunkSource;
  SourceDocumentId: string | null;
  Question: string | null;
  Title: string | null;
  ChunkText: string;
  CreatedDate?: string;
}

export interface ProductDocumentWithExtraction {
  ProductDocumentId: string;
  DocumentUrl: string;
  DisplayName: string;
  SortOrder: number;
  ExtractionStatus: ExtractionStatus;
  ExtractionStartedAt: string | null;
  ExtractionCompletedAt: string | null;
  ExtractionError: string | null;
  ExtractionChunkCount: number | null;
}

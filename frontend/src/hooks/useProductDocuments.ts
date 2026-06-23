import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '../services/apiClient';
import { regenerateDocumentChunks } from '../services/productChunks.service';
import type { ExtractionStatus, ProductDocumentWithExtraction } from '../types/aiChunks';

const key = (productId: string) => ['productDocuments', productId];

/** API returns camelCase on product.productDocuments; normalize for Step 9 UI. */
export function normalizeProductDocument(
  doc: Record<string, unknown>
): ProductDocumentWithExtraction {
  return {
    ProductDocumentId: String(doc.ProductDocumentId ?? doc.productDocumentId ?? ''),
    DocumentUrl: String(doc.DocumentUrl ?? doc.documentUrl ?? ''),
    DisplayName: String(doc.DisplayName ?? doc.displayName ?? 'Document'),
    SortOrder: Number(doc.SortOrder ?? doc.sortOrder ?? 0),
    ExtractionStatus: (doc.ExtractionStatus ?? doc.extractionStatus ?? null) as ExtractionStatus,
    ExtractionStartedAt: (doc.ExtractionStartedAt ?? doc.extractionStartedAt ?? null) as string | null,
    ExtractionCompletedAt: (doc.ExtractionCompletedAt ??
      doc.extractionCompletedAt ??
      null) as string | null,
    ExtractionError: (doc.ExtractionError ?? doc.extractionError ?? null) as string | null,
    ExtractionChunkCount: (doc.ExtractionChunkCount ?? doc.extractionChunkCount ?? null) as number | null,
  };
}

async function fetchProductDocuments(productId: string): Promise<ProductDocumentWithExtraction[]> {
  const res = await apiClient.get(`/api/products/${productId}`);
  const body = res.data as {
    product?: { productDocuments?: unknown[]; documents?: unknown[] };
    documents?: unknown[];
  };
  const raw =
    body?.product?.productDocuments ?? body?.product?.documents ?? body?.documents ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((d) => normalizeProductDocument(d as Record<string, unknown>));
}

const hasInFlight = (docs?: ProductDocumentWithExtraction[]) =>
  !!docs?.some((d) => d.ExtractionStatus === 'queued' || d.ExtractionStatus === 'running');

export function useProductDocuments(productId: string | undefined) {
  return useQuery<ProductDocumentWithExtraction[]>({
    queryKey: key(productId || ''),
    queryFn: () => fetchProductDocuments(productId as string),
    enabled: !!productId,
    refetchInterval: (q) => (hasInFlight(q.state.data) ? 3000 : false),
    refetchIntervalInBackground: false,
  });
}

export function useRegenerateDocument(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => {
      if (!documentId) {
        return Promise.reject(new Error('Document ID is missing — re-save the product or re-upload the document.'));
      }
      return regenerateDocumentChunks(productId, documentId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key(productId) });
      qc.invalidateQueries({ queryKey: ['productChunks', productId] });
    },
  });
}

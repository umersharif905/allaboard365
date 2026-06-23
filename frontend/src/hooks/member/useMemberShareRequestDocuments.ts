import { useQuery } from '@tanstack/react-query';
import { apiService } from '../../services/api.service';

/**
 * A member-visible document attached to a sharing request, returned by
 * GET /api/me/member/sharing-requests/:id/documents. AuthenticatedUrl is the
 * signed download URL; BlobUrl is the fallback for non-blob storage.
 */
export interface MemberShareRequestDocument {
  DocumentId: string;
  DocumentName?: string | null;
  DocumentType?: string | null;
  FileName?: string | null;
  BillId?: string | null;
  BillNumber?: string | null;
  CreatedDate?: string | null;
  AuthenticatedUrl?: string | null;
  BlobUrl?: string | null;
}

async function fetchDocuments(shareRequestId: string): Promise<MemberShareRequestDocument[]> {
  const res = await apiService.get<{
    success: boolean;
    data?: MemberShareRequestDocument[];
    message?: string;
  }>(`/api/me/member/sharing-requests/${shareRequestId}/documents`);
  if (!res.success) {
    throw new Error(res.message || 'Failed to load documents');
  }
  return res.data ?? [];
}

/**
 * Lazy hook — only fires when `enabled` is true (e.g. when the card is
 * expanded), so we don't fetch documents for every collapsed request.
 */
export function useMemberShareRequestDocuments(shareRequestId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['member', 'sharing-requests', shareRequestId, 'documents'] as const,
    queryFn: () => fetchDocuments(shareRequestId),
    enabled: enabled && !!shareRequestId,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000
  });
}

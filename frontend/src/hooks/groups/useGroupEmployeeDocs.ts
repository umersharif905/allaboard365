import { useQuery } from '@tanstack/react-query';
import { apiService } from '../../services/api.service';

export interface ApplicableEmployeeDoc {
  proposalDocumentId: string;
  name: string;
  productId: string;
  productName: string;
}

export function useGroupEmployeeDocs(groupId: string | null) {
  return useQuery<ApplicableEmployeeDoc[], Error>({
    queryKey: ['groupEmployeeDocs', groupId],
    queryFn: async () => {
      const res = await apiService.get<{ success: boolean; data?: ApplicableEmployeeDoc[]; message?: string }>(
        `/api/groups/${groupId}/employee-docs`
      );
      if (!res.success) throw new Error(res.message || 'Failed to load employee docs');
      return res.data ?? [];
    },
    enabled: !!groupId,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
  });
}

export function getEmployeeDocDownloadUrl(groupId: string, proposalDocumentId: string): string {
  return `/api/groups/${groupId}/employee-docs/${proposalDocumentId}/download`;
}

/**
 * Fetches the employee-facing PDF through the authenticated apiService (so JWT +
 * tenant headers travel with the request), then opens the resulting blob in a
 * new tab. Using window.open(url) directly doesn't work because the new tab
 * wouldn't carry the Authorization header and because the download route isn't
 * same-origin with the Vite dev server.
 */
export async function downloadEmployeeDocToNewTab(
  groupId: string,
  proposalDocumentId: string
): Promise<void> {
  const blob = await apiService.get<Blob>(
    getEmployeeDocDownloadUrl(groupId, proposalDocumentId),
    { responseType: 'blob' }
  );
  const pdfBlob = blob instanceof Blob ? blob : new Blob([blob as ArrayBuffer], { type: 'application/pdf' });
  const url = window.URL.createObjectURL(pdfBlob);
  window.open(url, '_blank', 'noopener');
  // Revoke after a minute so Chrome has time to render the PDF.
  setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
}

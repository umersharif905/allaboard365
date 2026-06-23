import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { DocumentService } from '../services/document.service';
import { DocumentMetadata } from '../services/groups.service';

/**
 * Hook for fetching documents for a specific group
 * @param groupId The ID of the group to fetch documents for
 */
export const useGroupDocuments = (groupId: string) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  
  return useQuery({
    queryKey: ['groupDocuments', groupId],
    queryFn: () => DocumentService.getGroupDocuments(groupId),
    enabled: !isAuthLoading && !!user && !!groupId,
    select: (response) => {
      if (response.success) {
        return response.data;
      }
      throw new Error(response.message || 'Failed to fetch group documents');
    }
  });
};

/**
 * Hook for uploading documents
 */
export const useUploadDocuments = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ 
      groupId, 
      files, 
      documentType, 
      description 
    }: { 
      groupId: string, 
      files: File[], 
      documentType: string, 
      description: string 
    }) => 
      DocumentService.uploadDocuments(groupId, files, documentType, description),
    onSuccess: (data, variables) => {
      if (data.success) {
        // Invalidate the documents query to trigger a refetch
        queryClient.invalidateQueries({ queryKey: ['groupDocuments', variables.groupId] });
      }
    }
  });
};

/**
 * Hook for saving document metadata
 */
export const useSaveDocumentMetadata = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ 
      groupId, 
      metadata 
    }: { 
      groupId: string, 
      metadata: DocumentMetadata 
    }) => 
      DocumentService.saveDocumentMetadata(groupId, metadata),
    onSuccess: (data, variables) => {
      if (data.success) {
        // Invalidate the documents query to trigger a refetch
        queryClient.invalidateQueries({ queryKey: ['groupDocuments', variables.groupId] });
      }
    }
  });
};

/**
 * Hook for downloading a document
 */
export const useDownloadDocument = () => {
  return useMutation({
    mutationFn: ({ 
      groupId, 
      documentId 
    }: { 
      groupId: string, 
      documentId: string 
    }) => 
      DocumentService.downloadDocument(groupId, documentId)
  });
};

/**
 * Hook for deleting a document
 */
export const useDeleteDocument = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ 
      groupId, 
      documentId 
    }: { 
      groupId: string, 
      documentId: string 
    }) => 
      DocumentService.deleteDocument(groupId, documentId),
    onSuccess: (data, variables) => {
      if (data.success) {
        // Invalidate the documents query to trigger a refetch
        queryClient.invalidateQueries({ queryKey: ['groupDocuments', variables.groupId] });
      }
    }
  });
}; 
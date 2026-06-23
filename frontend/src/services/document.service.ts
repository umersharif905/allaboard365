import type { ApiResponse } from '../types/api.types';
import { apiService } from './api.service';
import { Document, DocumentMetadata, DocumentUploadResponse } from './groups.service';

export class DocumentService {
  /**
   * Fetches documents for a specific group.
   * @param groupId The ID of the group.
   */
  static async getGroupDocuments(groupId: string): Promise<ApiResponse<Document[]>> {
    try {
      return await apiService.get<ApiResponse<Document[]>>(`/api/groups/${groupId}/documents`);
    } catch (error) {
      console.error(`Error fetching documents for group ${groupId}:`, error);
      return { success: false, data: [], message: `Failed to fetch documents for group ${groupId}` };
    }
  }

  /**
   * Uploads documents for a group.
   * @param groupId The ID of the group.
   * @param files The files to upload.
   * @param documentType The type of document.
   * @param description The document description.
   */
  static async uploadDocuments(
    groupId: string, 
    files: File[], 
    documentType: string, 
    description: string
  ): Promise<ApiResponse<DocumentUploadResponse>> {
    try {
      const formData = new FormData();
      
      files.forEach((file) => {
        formData.append('files', file);
      });
      formData.append('uploadType', 'documents');
      formData.append('entityId', groupId);
      formData.append('fileType', documentType);
      formData.append('description', description);
      formData.append('category', 'group-documents');

      // Use apiService for FormData uploads (handles base URL, auth, and FormData properly)
      return await apiService.post<ApiResponse<DocumentUploadResponse>>('/api/uploads', formData);
    } catch (error) {
      console.error(`Error uploading documents for group ${groupId}:`, error);
      return { 
        success: false, 
        data: { success: false } as DocumentUploadResponse, 
        message: error instanceof Error ? error.message : `Failed to upload documents for group ${groupId}`
      };
    }
  }

  /**
   * Saves document metadata for a group.
   * @param groupId The ID of the group.
   * @param metadata The document metadata.
   */
  static async saveDocumentMetadata(
    groupId: string, 
    metadata: DocumentMetadata
  ): Promise<ApiResponse<Document>> {
    try {
      return await apiService.post<ApiResponse<Document>>(`/api/groups/${groupId}/documents`, metadata);
    } catch (error) {
      console.error(`Error saving document metadata for group ${groupId}:`, error);
      return { 
        success: false, 
        data: {} as Document, 
        message: `Failed to save document metadata for group ${groupId}` 
      };
    }
  }

  /**
   * Downloads or views a document.
   * @param groupId The ID of the group.
   * @param documentId The ID of the document.
   */
  static async downloadDocument(groupId: string, documentId: string): Promise<ApiResponse<{ downloadUrl: string; fileName: string; mimeType: string }>> {
    try {
      return await apiService.get<ApiResponse<{ downloadUrl: string; fileName: string; mimeType: string }>>(`/api/groups/${groupId}/documents/${documentId}/download`);
    } catch (error) {
      console.error(`Error downloading document ${documentId}:`, error);
      return { 
        success: false, 
        data: { downloadUrl: '', fileName: '', mimeType: '' }, 
        message: `Failed to download document ${documentId}` 
      };
    }
  }

  /**
   * Deletes a document.
   * @param groupId The ID of the group.
   * @param documentId The ID of the document.
   */
  static async deleteDocument(groupId: string, documentId: string): Promise<ApiResponse<void>> {
    try {
      return await apiService.delete<ApiResponse<void>>(`/api/groups/${groupId}/documents/${documentId}`);
    } catch (error) {
      console.error(`Error deleting document ${documentId}:`, error);
      return { success: false, data: undefined, message: `Failed to delete document ${documentId}` };
    }
  }
}

export default DocumentService; 
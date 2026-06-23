import { apiService } from '../api.service';

export interface AgentAgreementDocument {
  FileId: string;
  FileName: string;
  StoredFileName: string;
  FilePath: string;
  FileSize: number;
  MimeType: string;
  Description: string;
  CreatedDate: string;
  ModifiedDate?: string;
}

export interface UploadResponse {
  success: boolean;
  message: string;
  data?: {
    fileId: string;
    fileName: string;
    fileUrl: string;
    fileSize: number;
    mimeType: string;
  };
}

export class AgentOnboardingService {
  /**
   * Get all agent agreement documents for the current tenant
   */
  static async getDocuments(): Promise<{ success: boolean; data?: AgentAgreementDocument[]; message?: string }> {
    try {
      const response = await apiService.get('/api/me/tenant-admin/agent-onboarding/documents');
      return response as { success: boolean; data?: AgentAgreementDocument[]; message?: string };
    } catch (error) {
      console.error('Error fetching agent agreement documents:', error);
      return {
        success: false,
        message: 'Failed to fetch agent agreement documents'
      };
    }
  }

  /**
   * Upload a new agent agreement document
   */
  static async uploadDocument(file: File): Promise<UploadResponse> {
    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await apiService.post('/api/me/tenant-admin/agent-onboarding/documents', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });

      return response as UploadResponse;
    } catch (error) {
      console.error('Error uploading agent agreement document:', error);
      return {
        success: false,
        message: 'Failed to upload agent agreement document'
      };
    }
  }

  /**
   * Delete an agent agreement document
   */
  static async deleteDocument(fileId: string): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await apiService.delete(`/api/me/tenant-admin/agent-onboarding/documents/${fileId}`);
      return response as { success: boolean; message?: string };
    } catch (error) {
      console.error('Error deleting agent agreement document:', error);
      return {
        success: false,
        message: 'Failed to delete agent agreement document'
      };
    }
  }

  /**
   * Download an agent agreement document
   */
  static async downloadDocument(filePath: string, fileName: string): Promise<void> {
    try {
      // Create a temporary link to download the file
      const link = document.createElement('a');
      link.href = filePath;
      link.download = fileName;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Error downloading agent agreement document:', error);
      throw new Error('Failed to download document');
    }
  }
}

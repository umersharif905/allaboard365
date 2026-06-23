import { MAX_DOCUMENT_UPLOAD_BYTES, MAX_DOCUMENT_UPLOAD_MB } from '../constants/uploads';
import { ApiResponse } from '../types/index';
import { apiService } from './api.service';

export interface UploadedDocument {
  fileId: string;
  fileName: string;
  storedFileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
  containerName: string;
}

export interface DocumentUploadResponse {
  success: boolean;
  message: string;
  data: UploadedDocument[];
}

class DocumentUploadService {
  private static extractErrorMessage(error: any): string {
    if (typeof error === 'string' && error.trim()) {
      return error;
    }
    if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
      return error.message;
    }
    if (typeof error?.message === 'string' && error.message.trim()) {
      return error.message;
    }
    if (typeof error?.response?.data?.message === 'string' && error.response.data.message.trim()) {
      return error.response.data.message;
    }
    if (typeof error?.response?.data?.error === 'string' && error.response.data.error.trim()) {
      return error.response.data.error;
    }
    if (typeof error?.error?.message === 'string' && error.error.message.trim()) {
      return error.error.message;
    }
    if (typeof error?.details === 'string' && error.details.trim()) {
      return error.details;
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}' && serialized !== 'null') {
        return serialized;
      }
    } catch (serializationError) {
      // no-op: fall through to default message
    }
    return 'Upload request failed';
  }

  /**
   * Upload documents to Azure Blob Storage
   * Only allows: PDF, DOC, DOCX, JPEG, JPG, PNG files
   */
  /** When sessionToken is provided, uses token-protected public endpoint (agent onboarding). Otherwise uses authenticated /api/uploads. */
  static async uploadDocuments(files: File[], uploadType: string = 'agents', entityId?: string, sessionToken?: string): Promise<DocumentUploadResponse> {
    // Allowed file types for agent onboarding
    const ALLOWED_FILE_TYPES = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/jpg',
      'image/png'
    ];
    const MAX_FILE_SIZE = MAX_DOCUMENT_UPLOAD_BYTES;

    // Validate files before upload
    if (!files || files.length === 0) {
      const error = new Error('No files provided for upload');
      console.error('❌ DocumentUploadService.uploadDocuments - Validation failed:', error.message);
      throw error;
    }

    // Validate file types and sizes
    const invalidFileErrors: string[] = [];
    files.forEach(file => {
      if (!ALLOWED_FILE_TYPES.includes(file.type)) {
        invalidFileErrors.push(`${file.name} (type: ${file.type || 'unknown'})`);
      } else if (file.size > MAX_FILE_SIZE) {
        invalidFileErrors.push(`${file.name} (size: ${(file.size / 1024 / 1024).toFixed(2)}MB, max: ${MAX_DOCUMENT_UPLOAD_MB}MB)`);
      }
    });

    if (invalidFileErrors.length > 0) {
      const error = new Error(
        `Invalid files detected. Allowed types: PDF, JPEG, JPG, PNG (max ${MAX_DOCUMENT_UPLOAD_MB}MB each). Invalid files: ${invalidFileErrors.join(', ')}`
      );
      console.error('❌ DocumentUploadService.uploadDocuments - File validation failed:', {
        invalidFiles: invalidFileErrors,
        allowedTypes: ALLOWED_FILE_TYPES
      });
      throw error;
    }

    // Validate file objects are valid File instances
    const invalidFileObjects = files.filter(f => !(f instanceof File) || f.size === 0);
    if (invalidFileObjects.length > 0) {
      const error = new Error(`Invalid file objects detected: ${invalidFileObjects.map(f => f instanceof File ? f.name : 'unknown').join(', ')}`);
      console.error('❌ DocumentUploadService.uploadDocuments - Invalid file objects:', {
        invalidFiles: invalidFileObjects.map(f => ({ 
          name: f instanceof File ? f.name : 'unknown', 
          size: f instanceof File ? f.size : 0, 
          type: typeof f 
        }))
      });
      throw error;
    }

    // Log upload details for debugging
    const uploadDetails = {
      fileCount: files.length,
      files: files.map(f => ({
        name: f.name,
        size: f.size,
        type: f.type,
        lastModified: f.lastModified,
        // Check if file object is valid
        isValid: f instanceof File && f.size > 0
      })),
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      uploadType,
      entityId,
      timestamp: new Date().toISOString()
    };

    console.log('📤 DocumentUploadService.uploadDocuments - Starting upload:', uploadDetails);

    try {
      const formData = new FormData();
      
      // Add files to FormData
      files.forEach((file, index) => {
        console.log(`📎 Adding file ${index + 1}/${files.length} to FormData:`, {
          name: file.name,
          size: file.size,
          type: file.type
        });
        formData.append('files', file);
      });
      
      // Add metadata
      formData.append('uploadType', uploadType);
      if (entityId) {
        formData.append('entityId', entityId);
      }
      formData.append('description', 'Agent onboarding documents');
      formData.append('category', 'professional');
      const endpoint = sessionToken ? '/api/public/onboarding-upload' : '/api/uploads';
      if (sessionToken) {
        formData.append('sessionToken', sessionToken);
      }

      console.log('🌐 DocumentUploadService.uploadDocuments - Making API request:', {
        endpoint,
        uploadType,
        entityId,
        fileCount: files.length,
        formDataKeys: Array.from(formData.keys())
      });

      const startTime = performance.now();
      
      const response = await apiService.post<DocumentUploadResponse>(endpoint, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      const duration = performance.now() - startTime;
      
      console.log('✅ DocumentUploadService.uploadDocuments - Upload successful:', {
        success: response.success,
        message: response.message,
        uploadedCount: response.data?.length || 0,
        duration: `${duration.toFixed(2)}ms`,
        uploadDetails
      });

      return response;
    } catch (error: any) {
      // Enhanced error logging for production debugging
      const errorDetails = {
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        stack: error instanceof Error ? error.stack : undefined,
        uploadDetails,
        networkError: error?.code === 'ERR_NETWORK' || error?.message?.includes('Network Error'),
        axiosError: error?.isAxiosError,
        responseStatus: error?.response?.status,
        responseData: error?.response?.data,
        requestUrl: error?.config?.url,
        requestMethod: error?.config?.method
      };

      console.error('❌ DocumentUploadService.uploadDocuments - Upload failed:', errorDetails);

      // Track error for production debugging
      if (typeof window !== 'undefined' && (window as any).errorTracker) {
        try {
          (window as any).errorTracker.trackApiError({
            endpoint: '/api/uploads',
            method: 'POST',
            requestUrl: '/api/uploads',
            status: error?.response?.status,
            error: error instanceof Error ? error : new Error(String(error)),
            errorType: 'NETWORK_ERROR',
            additionalContext: errorDetails
          });
        } catch (trackingError) {
          console.warn('⚠️ Failed to track error:', trackingError);
        }
      }

      // Re-throw with more context
      const extractedMessage = DocumentUploadService.extractErrorMessage(error);
      const enhancedError = new Error(
        `Document upload failed: ${extractedMessage}`
      );
      (enhancedError as any).originalError = error;
      (enhancedError as any).uploadDetails = uploadDetails;
      throw enhancedError;
    }
  }

  /**
   * Get authenticated URL for a document
   */
  static async getAuthenticatedUrl(containerName: string, blobName: string): Promise<string> {
    const response = await apiService.get(`/api/uploads/sas/${containerName}/${blobName}`) as ApiResponse<{url: string}>;
    if (!response.data) {
      throw new Error('Failed to get authenticated URL: no data in response');
    }
    return response.data.url;
  }
}

export default DocumentUploadService;

import { apiService } from './api.service';

// Global cache for SAS URLs to avoid duplicate requests
const sasUrlCache = new Map<string, { url: string; expiresAt: number }>();

export interface SASUrlResponse {
  success: boolean;
  data?: {
    url: string;
    containerName: string;
    blobName: string;
    expiresInMinutes: number;
    permissions: string;
  };
  message?: string;
  error?: {
    message: string;
    code: string;
  };
}

export class BlobService {
  /**
   * Generate a SAS URL for accessing a blob with authentication
   * @param containerName - The container name
   * @param blobName - The blob name
   * @param permissions - Permissions (default: 'r' for read)
   * @param expiresInMinutes - Expiration time in minutes (default: 60)
   * @returns Promise with SAS URL response
   */
  static async generateSASUrl(
    containerName: string,
    blobName: string,
    permissions: string = 'r',
    expiresInMinutes: number = 60
  ): Promise<SASUrlResponse> {
    try {
      const response = await apiService.get<SASUrlResponse>(
        `/api/uploads/sas/${containerName}/${blobName}?permissions=${permissions}&expiresInMinutes=${expiresInMinutes}`
      );
      return response;
    } catch (error) {
      console.error('Error generating SAS URL:', error);
      return {
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to generate SAS URL',
          code: 'SAS_GENERATION_ERROR'
        }
      };
    }
  }

  /**
   * Extract container name and blob name from a blob URL
   * @param blobUrl - The full blob URL
   * @returns Object with containerName and blobName, or null if parsing fails
   */
  static parseBlobUrl(blobUrl: string): { containerName: string; blobName: string } | null {
    try {
      // Handle URLs like: https://oestorage.blob.core.windows.net/container/blobname
      const url = new URL(blobUrl);
      const pathParts = url.pathname.split('/').filter(part => part.length > 0);
      
      if (pathParts.length >= 2) {
        return {
          containerName: pathParts[0],
          blobName: pathParts.slice(1).join('/') // Handle nested paths
        };
      }
      
      return null;
    } catch (error) {
      console.error('Error parsing blob URL:', error);
      return null;
    }
  }

  /**
   * Get an authenticated URL for a blob
   * @param blobUrl - The original blob URL
   * @param permissions - Permissions (default: 'r' for read)
   * @param expiresInMinutes - Expiration time in minutes (default: 60)
   * @returns Promise with authenticated URL or original URL if parsing fails
   */
  static async getAuthenticatedUrl(
    blobUrl: string,
    permissions: string = 'r',
    expiresInMinutes: number = 60
  ): Promise<string> {
    const parsed = this.parseBlobUrl(blobUrl);
    
    if (!parsed) {
      console.warn('Could not parse blob URL, returning original:', blobUrl);
      return blobUrl;
    }

    // Create cache key
    const cacheKey = `${parsed.containerName}/${parsed.blobName}:${permissions}`;
    const now = Date.now();
    const expiresAt = now + (expiresInMinutes * 60 * 1000);

    // Check cache first
    const cached = sasUrlCache.get(cacheKey);
    if (cached && cached.expiresAt > now + (5 * 60 * 1000)) { // 5 minute buffer
      return cached.url;
    }

    const sasResponse = await this.generateSASUrl(
      parsed.containerName,
      parsed.blobName,
      permissions,
      expiresInMinutes
    );

    if (sasResponse.success && sasResponse.data?.url) {
      // Cache the result
      sasUrlCache.set(cacheKey, {
        url: sasResponse.data.url,
        expiresAt: now + (expiresInMinutes * 60 * 1000)
      });
      return sasResponse.data.url;
    }

    console.warn('Failed to generate SAS URL, returning original:', blobUrl);
    return blobUrl;
  }

  /**
   * Check if a URL is a blob storage URL
   * @param url - The URL to check
   * @returns True if it's a blob storage URL
   */
  static isBlobUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.includes('blob.core.windows.net') || 
             urlObj.hostname.includes('storage.allaboard365.com');
    } catch {
      return false;
    }
  }

  /**
   * Clear expired entries from the SAS URL cache
   */
  static clearExpiredCache(): void {
    const now = Date.now();
    for (const [key, value] of sasUrlCache.entries()) {
      if (value.expiresAt <= now) {
        sasUrlCache.delete(key);
      }
    }
  }

  /**
   * Clear all entries from the SAS URL cache
   */
  static clearCache(): void {
    sasUrlCache.clear();
  }
}

export default BlobService;

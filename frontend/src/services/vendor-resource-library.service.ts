import { ApiResponse } from '../types/api.types';
import { apiService } from './api.service';
import type { MarketingFolderTree, MarketingResourceItem } from './marketing-resources.service';
import { MarketingResourcesService } from './marketing-resources.service';

const BASE = '/api/me/vendor/resource-library';

export interface VendorLibraryPayload {
  folders: MarketingFolderTree[];
}

export interface VendorOrganizationCatalog {
  organizationName: string;
  folders: MarketingFolderTree[];
}

export interface VendorCopyTenant {
  tenantId: string;
  name: string;
}

export class VendorResourceLibraryService {
  static async getTree(): Promise<MarketingFolderTree[]> {
    const res = await apiService.get<ApiResponse<VendorLibraryPayload>>(`${BASE}/folders`);
    if (!res.success) throw new Error(res.message || 'Failed to load library');
    return res.data?.folders || [];
  }

  static async createFolder(payload: { name: string; description?: string }): Promise<unknown> {
    const res = await apiService.post<ApiResponse<unknown>>(`${BASE}/folders`, payload);
    if (!res.success) throw new Error(res.message || 'Create failed');
    return res.data;
  }

  static async updateFolder(folderId: string, payload: { name?: string; description?: string | null }): Promise<unknown> {
    const res = await apiService.patch<ApiResponse<unknown>>(`${BASE}/folders/${folderId}`, payload);
    if (!res.success) throw new Error(res.message || 'Update failed');
    return res.data;
  }

  static async deleteFolder(folderId: string): Promise<void> {
    const res = await apiService.delete<ApiResponse<unknown>>(`${BASE}/folders/${folderId}`);
    if (!res.success) throw new Error(res.message || 'Delete failed');
  }

  static async reorderFolders(orderedFolderIds: string[]): Promise<unknown> {
    const res = await apiService.patch<ApiResponse<unknown>>(`${BASE}/folders/reorder`, { orderedFolderIds });
    if (!res.success) throw new Error(res.message || 'Reorder failed');
    return res.data;
  }

  static async createResource(payload: {
    folderId: string;
    title: string;
    description?: string;
    resourceType: 'file' | 'link';
    externalUrl?: string;
    fileId?: string;
    fileName?: string;
    storedFileName?: string;
    fileUrl?: string;
    mimeType?: string;
    fileSize?: number;
  }): Promise<{ resourceId: string }> {
    const res = await apiService.post<ApiResponse<{ resourceId: string }>>(`${BASE}/resources`, payload);
    if (!res.success || !res.data) throw new Error(res.message || 'Create failed');
    return res.data;
  }

  static async updateResource(resourceId: string, payload: {
    title?: string;
    description?: string | null;
    folderId?: string;
  }): Promise<unknown> {
    const res = await apiService.patch<ApiResponse<unknown>>(`${BASE}/resources/${resourceId}`, payload);
    if (!res.success) throw new Error(res.message || 'Update failed');
    return res.data;
  }

  static async deleteResource(resourceId: string): Promise<void> {
    const res = await apiService.delete<ApiResponse<unknown>>(`${BASE}/resources/${resourceId}`);
    if (!res.success) throw new Error(res.message || 'Delete failed');
  }

  static async reorderResources(folderId: string, orderedResourceIds: string[]): Promise<{
    folderId: string;
    resources: MarketingResourceItem[];
  }> {
    const res = await apiService.patch<ApiResponse<{ folderId: string; resources: MarketingResourceItem[] }>>(
      `${BASE}/resources/reorder`,
      { folderId, orderedResourceIds }
    );
    if (!res.success || !res.data) throw new Error(res.message || 'Reorder failed');
    return res.data;
  }

  static async listTenants(): Promise<VendorCopyTenant[]> {
    const res = await apiService.get<ApiResponse<{ tenants: VendorCopyTenant[] }>>(`${BASE}/tenants`);
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load tenants');
    return res.data.tenants;
  }

  static async getOrganizationCatalog(sourceTenantId?: string): Promise<VendorOrganizationCatalog> {
    const url = sourceTenantId
      ? `${BASE}/organization-catalog?tenantId=${encodeURIComponent(sourceTenantId)}`
      : `${BASE}/organization-catalog`;
    const res = await apiService.get<ApiResponse<VendorOrganizationCatalog>>(url);
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load catalog');
    return res.data;
  }

  static async copyFoldersFromOrganization(folderIds: string[], sourceTenantId?: string): Promise<VendorLibraryPayload> {
    const res = await apiService.post<ApiResponse<VendorLibraryPayload>>(
      `${BASE}/copy-from-organization`,
      { folderIds, sourceTenantId }
    );
    if (!res.success || !res.data) throw new Error(res.message || 'Copy failed');
    return res.data;
  }

  /** Reuse the shared file upload helper; entityId is the vendorId so file uploads are tracked per vendor. */
  static uploadFile(file: File, vendorId: string) {
    return MarketingResourcesService.uploadMarketingFile(file, vendorId);
  }
}

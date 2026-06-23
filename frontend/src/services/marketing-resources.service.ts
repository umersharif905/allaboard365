import { ApiResponse } from '../types/api.types';
import { apiService } from './api.service';

export interface MarketingResourceItem {
  resourceId: string;
  folderId: string;
  title: string;
  description?: string | null;
  resourceType: 'file' | 'link';
  sortOrder: number;
  createdDate?: string;
  externalUrl?: string;
  fileUrl?: string | null;
  fileId?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

export interface MarketingFolderTree {
  folderId: string;
  name: string;
  description?: string | null;
  sortOrder: number;
  /** Tenant admin only: when true, folder is omitted for agents in their resource library. */
  hideFromAgents?: boolean;
  createdDate?: string;
  resources: MarketingResourceItem[];
}

export interface MarketingFolderMeta {
  folderId: string;
  name: string;
  description?: string | null;
  sortOrder: number;
  isActive?: boolean;
  hideFromAgents?: boolean;
  createdDate?: string;
  modifiedDate?: string;
}

function tenantAdminBase(): string {
  return '/api/me/tenant-admin';
}

export type AgencyApiMode = 'agent' | 'tenantAdmin';

function agencyResourceBase(agencyId: string, mode: AgencyApiMode = 'agent'): string {
  return mode === 'tenantAdmin'
    ? `/api/me/tenant-admin/agencies/${agencyId}`
    : `/api/me/agent/agencies/${agencyId}`;
}

export interface AgentResourceLibraryPayload {
  folders: MarketingFolderTree[];
  libraryMode: 'organization' | 'agency';
  organizationName: string;
  agencyId: string | null;
  useCustomResourceLibrary: boolean;
  isAgencyAdmin: boolean;
}

/** Tenant admin (or sysadmin via tenant switch) reading a managed agency's library. */
export interface TenantAdminAgencyLibraryPayload {
  folders: MarketingFolderTree[];
  agencyId: string;
  useCustomResourceLibrary: boolean;
}

export class MarketingResourcesService {
  /** Tenant admin: folders only. Agent: full payload including libraryMode / organizationName. */
  static async getLibraryTree(currentRole: string): Promise<MarketingFolderTree[]> {
    const data = await this.getResourceLibraryPayload(currentRole);
    return data.folders;
  }

  static async getResourceLibraryPayload(currentRole: string): Promise<AgentResourceLibraryPayload | { folders: MarketingFolderTree[] }> {
    if (currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') {
      const res = await apiService.get<ApiResponse<{ folders: MarketingFolderTree[] }>>(
        `${tenantAdminBase()}/marketing-resources`
      );
      if (!res.success) {
        throw new Error(res.message || 'Failed to load marketing library');
      }
      return { folders: res.data?.folders || [] };
    }
    const res = await apiService.get<
      ApiResponse<{
        folders: MarketingFolderTree[];
        libraryMode: 'organization' | 'agency';
        organizationName: string;
        agencyId: string | null;
        useCustomResourceLibrary: boolean;
        isAgencyAdmin: boolean;
      }>
    >('/api/me/agent/marketing-resources');
    if (!res.success || !res.data) {
      throw new Error(res.message || 'Failed to load marketing library');
    }
    return res.data;
  }

  /**
   * Tenant admin (or SysAdmin via tenant switch) reading a managed agency's library
   * with admin-only metadata (hideFromAgents, useCustomResourceLibrary toggle state).
   */
  static async getTenantAdminAgencyLibrary(agencyId: string): Promise<TenantAdminAgencyLibraryPayload> {
    const res = await apiService.get<ApiResponse<TenantAdminAgencyLibraryPayload>>(
      `${agencyResourceBase(agencyId, 'tenantAdmin')}/marketing-resources`
    );
    if (!res.success || !res.data) {
      throw new Error(res.message || 'Failed to load agency library');
    }
    return res.data;
  }

  static async patchAgencyLibrarySettings(
    agencyId: string,
    useCustomResourceLibrary: boolean,
    mode: AgencyApiMode = 'agent'
  ): Promise<void> {
    const res = await apiService.patch<ApiResponse<{ useCustomResourceLibrary: boolean }>>(
      `${agencyResourceBase(agencyId, mode)}/library-settings`,
      { useCustomResourceLibrary }
    );
    if (!res.success) {
      throw new Error(res.message || 'Failed to update library settings');
    }
  }

  static async getOrganizationCatalog(
    agencyId: string,
    mode: AgencyApiMode = 'agent'
  ): Promise<{ organizationName: string; folders: MarketingFolderTree[] }> {
    const res = await apiService.get<
      ApiResponse<{ organizationName: string; folders: MarketingFolderTree[] }>
    >(`${agencyResourceBase(agencyId, mode)}/marketing-resources/organization-catalog`);
    if (!res.success || !res.data) {
      throw new Error(res.message || 'Failed to load organization catalog');
    }
    return res.data;
  }

  static async copyOrganizationFoldersToAgency(
    agencyId: string,
    folderIds: string[],
    mode: AgencyApiMode = 'agent'
  ): Promise<MarketingFolderTree[]> {
    const res = await apiService.post<ApiResponse<{ folders: MarketingFolderTree[] }>>(
      `${agencyResourceBase(agencyId, mode)}/marketing-resources/copy-from-organization`,
      { folderIds }
    );
    if (!res.success || !res.data?.folders) {
      throw new Error(res.message || 'Copy failed');
    }
    return res.data.folders;
  }

  static async createAgencyFolder(
    agencyId: string,
    body: { name: string; description?: string; hideFromAgents?: boolean },
    mode: AgencyApiMode = 'agent'
  ): Promise<MarketingFolderMeta> {
    const res = await apiService.post<ApiResponse<MarketingFolderMeta>>(
      `${agencyResourceBase(agencyId, mode)}/marketing-folders`,
      body
    );
    if (!res.success || !res.data) {
      throw new Error(res.message || 'Failed to create folder');
    }
    return normalizeFolderMeta(res.data);
  }

  static async updateAgencyFolder(
    agencyId: string,
    folderId: string,
    body: { name?: string; description?: string | null; hideFromAgents?: boolean },
    mode: AgencyApiMode = 'agent'
  ): Promise<MarketingFolderMeta> {
    const res = await apiService.patch<ApiResponse<MarketingFolderMeta>>(
      `${agencyResourceBase(agencyId, mode)}/marketing-folders/${folderId}`,
      body
    );
    if (!res.success || !res.data) {
      throw new Error(res.message || 'Failed to update folder');
    }
    return normalizeFolderMeta(res.data);
  }

  static async deleteAgencyFolder(
    agencyId: string,
    folderId: string,
    mode: AgencyApiMode = 'agent'
  ): Promise<void> {
    const res = await apiService.delete<ApiResponse<unknown>>(
      `${agencyResourceBase(agencyId, mode)}/marketing-folders/${folderId}`
    );
    if (!res.success) {
      throw new Error(res.message || 'Failed to delete folder');
    }
  }

  static async reorderAgencyFolders(
    agencyId: string,
    orderedFolderIds: string[],
    mode: AgencyApiMode = 'agent'
  ): Promise<MarketingFolderMeta[]> {
    const res = await apiService.patch<ApiResponse<MarketingFolderMeta[]>>(
      `${agencyResourceBase(agencyId, mode)}/marketing-folders/reorder`,
      { orderedFolderIds }
    );
    if (!res.success) {
      throw new Error(res.message || 'Failed to reorder folders');
    }
    return (res.data || []).map(normalizeFolderMeta);
  }

  static async createAgencyResource(
    agencyId: string,
    body: Record<string, unknown>,
    mode: AgencyApiMode = 'agent'
  ): Promise<string> {
    const res = await apiService.post<ApiResponse<{ resourceId: string }>>(
      `${agencyResourceBase(agencyId, mode)}/marketing-resources`,
      body
    );
    if (!res.success || !res.data?.resourceId) {
      throw new Error(res.message || 'Failed to create resource');
    }
    return res.data.resourceId;
  }

  static async updateAgencyResource(
    agencyId: string,
    resourceId: string,
    body: { title?: string; description?: string | null; folderId?: string },
    mode: AgencyApiMode = 'agent'
  ): Promise<void> {
    const res = await apiService.patch<ApiResponse<unknown>>(
      `${agencyResourceBase(agencyId, mode)}/marketing-resources/${resourceId}`,
      body
    );
    if (!res.success) {
      throw new Error(res.message || 'Failed to update resource');
    }
  }

  static async deleteAgencyResource(
    agencyId: string,
    resourceId: string,
    mode: AgencyApiMode = 'agent'
  ): Promise<void> {
    const res = await apiService.delete<ApiResponse<unknown>>(
      `${agencyResourceBase(agencyId, mode)}/marketing-resources/${resourceId}`
    );
    if (!res.success) {
      throw new Error(res.message || 'Failed to delete resource');
    }
  }

  static async reorderAgencyResources(
    agencyId: string,
    folderId: string,
    orderedResourceIds: string[],
    mode: AgencyApiMode = 'agent'
  ): Promise<void> {
    const res = await apiService.patch<ApiResponse<unknown>>(
      `${agencyResourceBase(agencyId, mode)}/marketing-resources/reorder`,
      { folderId, orderedResourceIds }
    );
    if (!res.success) {
      throw new Error(res.message || 'Failed to reorder resources');
    }
  }

  static async listFolders(): Promise<MarketingFolderMeta[]> {
    const res = await apiService.get<ApiResponse<MarketingFolderMeta[]>>(`${tenantAdminBase()}/marketing-folders`);
    if (!res.success) {
      throw new Error(res.message || 'Failed to list folders');
    }
    return res.data || [];
  }

  static async createFolder(body: {
    name: string;
    description?: string;
    hideFromAgents?: boolean;
  }): Promise<MarketingFolderMeta> {
    const res = await apiService.post<ApiResponse<MarketingFolderMeta>>(`${tenantAdminBase()}/marketing-folders`, body);
    if (!res.success || !res.data) {
      throw new Error(res.message || 'Failed to create folder');
    }
    return res.data;
  }

  static async updateFolder(
    folderId: string,
    body: { name?: string; description?: string | null; hideFromAgents?: boolean }
  ): Promise<MarketingFolderMeta> {
    const res = await apiService.patch<ApiResponse<MarketingFolderMeta>>(
      `${tenantAdminBase()}/marketing-folders/${folderId}`,
      body
    );
    if (!res.success || !res.data) {
      throw new Error(res.message || 'Failed to update folder');
    }
    return res.data;
  }

  static async deleteFolder(folderId: string): Promise<void> {
    const res = await apiService.delete<ApiResponse<unknown>>(`${tenantAdminBase()}/marketing-folders/${folderId}`);
    if (!res.success) {
      throw new Error(res.message || 'Failed to delete folder');
    }
  }

  static async reorderFolders(orderedFolderIds: string[]): Promise<MarketingFolderMeta[]> {
    const res = await apiService.patch<ApiResponse<MarketingFolderMeta[]>>(
      `${tenantAdminBase()}/marketing-folders/reorder`,
      { orderedFolderIds }
    );
    if (!res.success) {
      throw new Error(res.message || 'Failed to reorder folders');
    }
    return res.data || [];
  }

  static async createResource(body: Record<string, unknown>): Promise<string> {
    const res = await apiService.post<ApiResponse<{ resourceId: string }>>(
      `${tenantAdminBase()}/marketing-resources`,
      body
    );
    if (!res.success || !res.data?.resourceId) {
      throw new Error(res.message || 'Failed to create resource');
    }
    return res.data.resourceId;
  }

  static async updateResource(
    resourceId: string,
    body: { title?: string; description?: string | null; folderId?: string }
  ): Promise<void> {
    const res = await apiService.patch<ApiResponse<unknown>>(
      `${tenantAdminBase()}/marketing-resources/${resourceId}`,
      body
    );
    if (!res.success) {
      throw new Error(res.message || 'Failed to update resource');
    }
  }

  static async deleteResource(resourceId: string): Promise<void> {
    const res = await apiService.delete<ApiResponse<unknown>>(`${tenantAdminBase()}/marketing-resources/${resourceId}`);
    if (!res.success) {
      throw new Error(res.message || 'Failed to delete resource');
    }
  }

  static async reorderResources(folderId: string, orderedResourceIds: string[]): Promise<void> {
    const res = await apiService.patch<ApiResponse<unknown>>(`${tenantAdminBase()}/marketing-resources/reorder`, {
      folderId,
      orderedResourceIds
    });
    if (!res.success) {
      throw new Error(res.message || 'Failed to reorder resources');
    }
  }

  static async uploadMarketingFile(file: File, entityId?: string): Promise<{
    url: string;
    filename: string;
    fileId: string;
    mimeType?: string;
    fileSize?: number;
    fileName?: string;
  }> {
    const formData = new FormData();
    formData.append('files', file);
    formData.append('uploadType', 'marketing-resources');
    if (entityId) {
      formData.append('entityId', entityId);
    }
    const res = await apiService.post<
      ApiResponse<
        Array<{
          url: string;
          filename: string;
          fileId: string;
          mimeType?: string;
          fileSize?: number;
          fileName?: string;
        }>
      >
    >('/api/uploads/marketing-resources', formData, { timeout: 120000 });
    if (!res.success || !res.data?.[0]?.fileId) {
      throw new Error(res.message || 'Upload failed');
    }
    const row = res.data[0];
    return {
      url: row.url,
      filename: row.filename,
      fileId: row.fileId,
      mimeType: row.mimeType,
      fileSize: row.fileSize,
      fileName: row.fileName
    };
  }

  /** Sysadmin: read any tenant's library (admin view) for the cross-tenant copy UI. */
  static async getTenantLibraryAsSysadmin(tenantId: string): Promise<MarketingFolderTree[]> {
    const res = await apiService.get<ApiResponse<{ folders: MarketingFolderTree[] }>>(
      `/api/me/sysadmin/marketing-resources/tenants/${tenantId}/library`
    );
    if (!res.success) {
      throw new Error(res.message || 'Failed to load tenant library');
    }
    return res.data?.folders || [];
  }

  /** Sysadmin: copy folders (and their resources) from one tenant to another. */
  static async copyFoldersBetweenTenants(params: {
    sourceTenantId: string;
    targetTenantId: string;
    folderIds: string[];
  }): Promise<{ copiedFolderCount: number; targetLibrary: { folders: MarketingFolderTree[] } }> {
    const res = await apiService.post<
      ApiResponse<{
        sourceTenantId: string;
        targetTenantId: string;
        copiedFolderCount: number;
        targetLibrary: { folders: MarketingFolderTree[] };
      }>
    >('/api/me/sysadmin/marketing-resources/copy-between-tenants', params);
    if (!res.success || !res.data) {
      throw new Error(res.message || 'Copy failed');
    }
    return {
      copiedFolderCount: res.data.copiedFolderCount,
      targetLibrary: res.data.targetLibrary
    };
  }
}

function normalizeFolderMeta(raw: MarketingFolderMeta | Record<string, unknown>): MarketingFolderMeta {
  const r = raw as Record<string, unknown>;
  return {
    folderId: String(r.folderId ?? r.FolderId ?? ''),
    name: String(r.name ?? r.Name ?? ''),
    description: (r.description ?? r.Description ?? null) as string | null,
    sortOrder: Number(r.sortOrder ?? r.SortOrder ?? 0),
    isActive: r.isActive as boolean | undefined,
    hideFromAgents: Boolean(r.hideFromAgents ?? r.HideFromAgents),
    createdDate: r.createdDate as string | undefined,
    modifiedDate: r.modifiedDate as string | undefined
  };
}

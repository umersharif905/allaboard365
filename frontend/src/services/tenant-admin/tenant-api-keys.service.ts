// File: frontend/src/services/tenant-admin/tenant-api-keys.service.ts
// TenantAdmin self-service for the tenant-level website integration API key.
// Mints/lists/revokes a single key per tenant website (AgentId = NULL,
// Scope = 'website-integration'). Backed by /api/tenant-api-keys.

import { apiService } from '../api.service';
import type {
  CreatedTenantApiKey,
  TenantApiKey,
} from '../../types/tenant-admin/tenant-api-keys.types';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
}

const BASE = '/api/tenant-api-keys';

export const TenantApiKeysService = {
  /** List the tenant's website integration keys (active + revoked). */
  async list(): Promise<TenantApiKey[]> {
    const res = await apiService.get<ApiResponse<TenantApiKey[]>>(BASE);
    return res.data ?? [];
  },

  /** Mint a new website integration key. The raw `key` is returned only once. */
  async create(keyName: string): Promise<CreatedTenantApiKey> {
    const res = await apiService.post<ApiResponse<CreatedTenantApiKey>>(BASE, { keyName });
    if (!res.data) {
      throw new Error(res.message || 'Failed to create website key');
    }
    return res.data;
  },

  /** Revoke a key (sets Status = 'revoked'). */
  async revoke(apiKeyId: string): Promise<void> {
    await apiService.delete<ApiResponse<never>>(`${BASE}/${apiKeyId}`);
  },
};

export default TenantApiKeysService;

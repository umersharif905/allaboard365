// services/vendorRequestTypes.service.ts
// Thin wrapper over /api/me/vendor/request-types for the vendor portal.

import { apiService } from './api.service';
import type { VendorRequestType } from '../types/shareRequest.types';

const BASE = '/api/me/vendor/request-types';

interface ListResponse { success: boolean; data: VendorRequestType[] }
interface ItemResponse { success: boolean; data: VendorRequestType }
interface DeleteResponse { success: boolean; data: { typeId: string; dependentCount: number } }
interface DependentsBlockedResponse {
  success: false;
  code: 'DEPENDENTS_EXIST';
  message: string;
  dependentCount: number;
}

export const vendorRequestTypesService = {
  async list(): Promise<VendorRequestType[]> {
    const res = await apiService.get<ListResponse>(BASE);
    return res.success ? res.data : [];
  },

  async create(name: string): Promise<VendorRequestType> {
    const res = await apiService.post<ItemResponse>(BASE, { name });
    return res.data;
  },

  async update(typeId: string, body: { name?: string; sortOrder?: number }): Promise<VendorRequestType> {
    const res = await apiService.put<ItemResponse>(`${BASE}/${typeId}`, body);
    return res.data;
  },

  /**
   * Delete a type. If dependent share requests exist and `force` is false,
   * the backend returns 409 with code DEPENDENTS_EXIST and a dependentCount;
   * we surface that as a structured result so the caller can show a
   * confirmation modal before re-calling with force=true.
   */
  async remove(
    typeId: string,
    force: boolean
  ): Promise<{ status: 'deleted'; dependentCount: number } | { status: 'has-dependents'; dependentCount: number }> {
    const url = force ? `${BASE}/${typeId}?force=true` : `${BASE}/${typeId}`;
    try {
      const res = await apiService.delete<DeleteResponse>(url);
      return { status: 'deleted', dependentCount: res.data.dependentCount };
    } catch (err: any) {
      // apiService normalizes errors to { code, message, responseData, status }.
      // The 409 dependents-exist body comes back on err.responseData.
      const body = (err?.responseData ?? {}) as Partial<DependentsBlockedResponse>;
      if (err?.code === 'DEPENDENTS_EXIST' || body.code === 'DEPENDENTS_EXIST') {
        return {
          status: 'has-dependents',
          dependentCount: Number(body.dependentCount ?? 0),
        };
      }
      throw err;
    }
  },
};

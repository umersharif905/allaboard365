// frontend/src/services/share-request-claim.service.ts
// Thin wrappers for the vendor share request claim endpoints.

import { apiService } from './api.service';
import { ClaimerOption, ClaimResponse } from '../types/shareRequest.types';

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  message?: string;
}

const BASE = '/api/me/vendor/share-requests';

export const shareRequestClaimService = {
  /** Self-claim. Throws on 409/404; caller surfaces a toast. */
  async claim(shareRequestId: string): Promise<ClaimResponse> {
    const res = await apiService.post<ApiEnvelope<ClaimResponse>>(
      `${BASE}/${shareRequestId}/claim`
    );
    return res.data;
  },

  /** Release a claim. Claimer can release own; admin can release anyone's. */
  async unclaim(shareRequestId: string): Promise<void> {
    await apiService.delete<ApiEnvelope<undefined>>(
      `${BASE}/${shareRequestId}/claim`
    );
  },

  /** Admin reassign to a specific vendor user. */
  async reassign(shareRequestId: string, userId: string): Promise<ClaimResponse> {
    const res = await apiService.put<ApiEnvelope<ClaimResponse>>(
      `${BASE}/${shareRequestId}/claim`,
      { userId }
    );
    return res.data;
  },

  /** Full vendor roster with claimed-SR counts (auth user first). */
  async getClaimers(): Promise<ClaimerOption[]> {
    const res = await apiService.get<ApiEnvelope<ClaimerOption[]>>(
      `${BASE}/claimers`
    );
    return res.data;
  }
};

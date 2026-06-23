// frontend/src/services/share-request-status.service.ts
// Thin wrapper for the vendor share request status/determination endpoint.

import { apiService } from './api.service';
import type {
  ShareRequestStatus,
  ShareRequestDetermination,
} from '../types/shareRequest.types';

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  message?: string;
}

interface UpdateStatusPayload {
  status?: ShareRequestStatus;
  determination?: ShareRequestDetermination;
  reason?: string;
  /** Member-facing closing note shown on the member dashboard at terminal status. */
  memberOutcomeNote?: string;
}

const BASE = '/api/me/vendor/share-requests';

export const shareRequestStatusService = {
  async update(shareRequestId: string, payload: UpdateStatusPayload): Promise<void> {
    const res = await apiService.put<ApiEnvelope<unknown>>(
      `${BASE}/${shareRequestId}/status`,
      payload
    );
    if (!res.success) {
      throw new Error(res.message || 'Failed to update status');
    }
  },
};

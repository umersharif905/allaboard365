// frontend/src/services/sr-diagnoses.service.ts
// Client for the per-share-request diagnosis (ICD-10) CRUD endpoints.
import { apiService } from './api.service';
import type { ShareRequestDiagnosis } from '../types/shareRequest.types';

interface ApiEnvelope<T> { success: boolean; data?: T; message?: string }
const SR_BASE = '/api/me/vendor/share-requests';

function unwrap<T>(res: ApiEnvelope<T>, what: string): T {
  if (!res.success || res.data === undefined) throw new Error(res.message || `Failed to ${what}`);
  return res.data;
}

export interface DiagnosisInput {
  icd10Code: string;
  description?: string;
  isPrimary?: boolean;
  sortOrder?: number;
}

export const srDiagnosesService = {
  async list(shareRequestId: string): Promise<ShareRequestDiagnosis[]> {
    const res = await apiService.get<ApiEnvelope<ShareRequestDiagnosis[]>>(`${SR_BASE}/${shareRequestId}/diagnoses`);
    return unwrap(res, 'load diagnoses');
  },
  async add(shareRequestId: string, input: DiagnosisInput): Promise<{ diagnosisId: string; icd10Code: string }> {
    const res = await apiService.post<ApiEnvelope<{ diagnosisId: string; icd10Code: string }>>(`${SR_BASE}/${shareRequestId}/diagnoses`, input);
    return unwrap(res, 'add diagnosis');
  },
  async update(shareRequestId: string, diagnosisId: string, input: Partial<DiagnosisInput>): Promise<void> {
    const res = await apiService.put<ApiEnvelope<unknown>>(`${SR_BASE}/${shareRequestId}/diagnoses/${diagnosisId}`, input);
    if (!res.success) throw new Error(res.message || 'Failed to update diagnosis');
  },
  async remove(shareRequestId: string, diagnosisId: string): Promise<void> {
    const res = await apiService.delete<ApiEnvelope<unknown>>(`${SR_BASE}/${shareRequestId}/diagnoses/${diagnosisId}`);
    if (!res.success) throw new Error(res.message || 'Failed to delete diagnosis');
  },
};

/**
 * Case Study Service
 * Vendor-portal case studies (Patient/Client Success Stories) created from completed
 * share requests. Pulls an auto-populated draft, then persists create/update.
 */
import { apiService } from './api.service';
import type {
  CaseStudyDraft,
  CaseStudyDraftResponse,
  CaseStudyResponse,
  CaseStudyListResponse,
} from '../types/caseStudy.types';

const BASE = '/api/me/vendor/case-studies';

export const CaseStudyService = {
  /** Auto-populated draft from a completed share request (not yet persisted). */
  async getPrefill(shareRequestId: string): Promise<CaseStudyDraftResponse> {
    return apiService.get<CaseStudyDraftResponse>(`${BASE}/prefill/${shareRequestId}`);
  },

  async getById(caseStudyId: string): Promise<CaseStudyResponse> {
    return apiService.get<CaseStudyResponse>(`${BASE}/${caseStudyId}`);
  },

  async list(params?: { status?: string; brand?: string }): Promise<CaseStudyListResponse> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.brand) qs.set('brand', params.brand);
    const suffix = qs.toString() ? `?${qs}` : '';
    return apiService.get<CaseStudyListResponse>(`${BASE}${suffix}`);
  },

  async create(data: CaseStudyDraft & { isPublished?: boolean }): Promise<CaseStudyResponse> {
    return apiService.post<CaseStudyResponse>(BASE, data);
  },

  async update(
    caseStudyId: string,
    data: Partial<CaseStudyDraft> & { isPublished?: boolean }
  ): Promise<CaseStudyResponse> {
    return apiService.put<CaseStudyResponse>(`${BASE}/${caseStudyId}`, data);
  },

  async remove(caseStudyId: string): Promise<{ success: boolean; message?: string }> {
    return apiService.delete<{ success: boolean; message?: string }>(`${BASE}/${caseStudyId}`);
  },
};

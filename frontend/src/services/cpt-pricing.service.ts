// frontend/src/services/cpt-pricing.service.ts
// Client for the backend pricing proxy (/api/me/vendor/pricing/*) and the
// per-share-request pricing snapshot refresh.

import { apiService } from './api.service';
import type {
  CptPriceResult,
  HospitalPricesResult,
  PricingSearchResult,
  ShareRequestProcedure,
} from '../types/cptPricing.types';

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  message?: string;
}

const PRICING_BASE = '/api/me/vendor/pricing';
const SR_BASE = '/api/me/vendor/share-requests';

function unwrap<T>(res: ApiEnvelope<T>, what: string): T {
  if (!res.success || res.data === undefined) {
    throw new Error(res.message || `Failed to load ${what}`);
  }
  return res.data;
}

export const cptPricingService = {
  async search(q: string, zip?: string): Promise<PricingSearchResult> {
    const params = new URLSearchParams({ q });
    if (zip) params.set('zip', zip);
    const res = await apiService.get<ApiEnvelope<PricingSearchResult>>(
      `${PRICING_BASE}/search?${params.toString()}`
    );
    return unwrap(res, 'pricing search');
  },

  async getCptPrice(code: string, opts?: { zip?: string; site?: string }): Promise<CptPriceResult> {
    const params = new URLSearchParams();
    if (opts?.zip) params.set('zip', opts.zip);
    if (opts?.site) params.set('site', opts.site);
    const qs = params.toString();
    const res = await apiService.get<ApiEnvelope<CptPriceResult>>(
      `${PRICING_BASE}/cpt/${encodeURIComponent(code)}${qs ? `?${qs}` : ''}`
    );
    return unwrap(res, `pricing for ${code}`);
  },

  async getHospitalPrices(
    code: string,
    opts?: { zip?: string; radius?: number; limit?: number; state?: string }
  ): Promise<HospitalPricesResult> {
    const params = new URLSearchParams();
    if (opts?.zip) params.set('zip', opts.zip);
    if (opts?.radius) params.set('radius', String(opts.radius));
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.state) params.set('state', opts.state);
    const qs = params.toString();
    const res = await apiService.get<ApiEnvelope<HospitalPricesResult>>(
      `${PRICING_BASE}/hospital-prices/${encodeURIComponent(code)}${qs ? `?${qs}` : ''}`
    );
    return unwrap(res, `hospital prices for ${code}`);
  },

  // --- per-share-request procedures (existing CRUD + snapshot refresh) ---

  async getProcedures(shareRequestId: string): Promise<ShareRequestProcedure[]> {
    const res = await apiService.get<ApiEnvelope<ShareRequestProcedure[]>>(
      `${SR_BASE}/${shareRequestId}/procedures`
    );
    return unwrap(res, 'procedures');
  },

  async addProcedure(
    shareRequestId: string,
    payload: { cptCode: string; description?: string }
  ): Promise<{ procedureId: string; cptCode: string }> {
    const res = await apiService.post<ApiEnvelope<{ procedureId: string; cptCode: string }>>(
      `${SR_BASE}/${shareRequestId}/procedures`,
      payload
    );
    return unwrap(res, 'add procedure');
  },

  async updateProcedure(
    shareRequestId: string,
    procedureId: string,
    payload: { cptCode?: string; description?: string; sortOrder?: number }
  ): Promise<void> {
    const res = await apiService.put<ApiEnvelope<unknown>>(
      `${SR_BASE}/${shareRequestId}/procedures/${procedureId}`,
      payload
    );
    if (!res.success) throw new Error(res.message || 'Failed to update procedure');
  },

  async deleteProcedure(shareRequestId: string, procedureId: string): Promise<void> {
    const res = await apiService.delete<ApiEnvelope<unknown>>(
      `${SR_BASE}/${shareRequestId}/procedures/${procedureId}`
    );
    if (!res.success) throw new Error(res.message || 'Failed to delete procedure');
  },

  /** Fetch live Medicare pricing and persist the snapshot. zip omitted → member ZIP (server default). */
  async refreshPricing(
    shareRequestId: string,
    procedureId: string,
    zip?: string
  ): Promise<ShareRequestProcedure> {
    const res = await apiService.post<ApiEnvelope<ShareRequestProcedure>>(
      `${SR_BASE}/${shareRequestId}/procedures/${procedureId}/pricing-refresh`,
      zip ? { zip } : {}
    );
    return unwrap(res, 'pricing refresh');
  },
};

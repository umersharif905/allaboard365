// frontend/src/services/npiPublicSearch.service.ts
// Calls the public (anonymous) NPI provider search endpoint.

import { apiService } from './api.service';
import type { CoLocatedResponse, NpiSearchResponse, ProviderSearchMode } from '../types/providerSearch';

export type ProviderSearchParams = {
  formId: string;
  mode: ProviderSearchMode;
  lastName?: string;
  organizationName?: string;
  zip: string;
};

export async function searchPublicProviders(
  params: ProviderSearchParams
): Promise<NpiSearchResponse> {
  const qs = new URLSearchParams();
  qs.set('form', params.formId);
  qs.set('mode', params.mode);
  if (params.lastName) qs.set('lastName', params.lastName);
  if (params.organizationName) qs.set('organizationName', params.organizationName);
  qs.set('zip', params.zip);
  return apiService.get<NpiSearchResponse>(`/api/public/npi/search?${qs.toString()}`);
}

export type CoLocatedParams = {
  formId: string;
  address1: string;
  zip: string;
};

/** Look up organizations registered at a doctor's practice street address. */
export async function findCoLocatedProviders(
  params: CoLocatedParams
): Promise<CoLocatedResponse> {
  const qs = new URLSearchParams();
  qs.set('form', params.formId);
  qs.set('address1', params.address1);
  qs.set('zip', params.zip);
  return apiService.get<CoLocatedResponse>(`/api/public/npi/co-located?${qs.toString()}`);
}

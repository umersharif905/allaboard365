// frontend/src/types/providerSearch.ts
// Types for the provider_search form field and the public NPI search endpoint.

export type ProviderSearchMode = 'individual' | 'organization' | 'both';

/** A provider result from the public NPI search endpoint. */
export type NpiProvider = {
  source: 'registry';
  npi: string;
  name: string;
  providerType?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  fax?: string | null;
  taxId?: string | null;
  specialty?: string | null;
  /**
   * When a single facility registers many NPIs at the same address under the
   * same organization name (e.g. each billing department of a hospital), the
   * siblings are attached here so the UI can offer them as a sub-selection.
   * Present only on the umbrella row when there are 2+ same-name entries.
   */
  departments?: Array<{
    npi: string;
    specialty?: string | null;
    providerType?: string | null;
  }>;
};

/**
 * A provider entered by hand when not found in the registry. Carries the same
 * detail a registry pick would (NPI, type, phone, fax, second address line) so
 * a manual provider is not a thinner record than a registry-sourced one.
 */
export type ManualProvider = {
  source: 'manual';
  name: string;
  providerType?: string;
  npi?: string;
  phone?: string;
  fax?: string;
  taxId?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
};

/** The value stored in the form submission for a provider_search field. */
export type ProviderFieldValue = NpiProvider | ManualProvider;

/**
 * A provider the signed-in member's household has used before (from
 * GET /api/me/member/forms/prior-providers). Surfaced as a "Your providers"
 * suggestion; converted to a ProviderFieldValue on selection.
 */
export type PriorProvider = {
  npi?: string | null;
  name: string;
  providerType?: string | null;
  taxId?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  fax?: string | null;
  role?: string | null;
  lastUsedDate?: string | null;
};

/** Convert a prior provider into the value the provider_search field stores. */
export function priorToProviderValue(p: PriorProvider): ProviderFieldValue {
  if (p.npi) {
    return {
      source: 'registry',
      npi: p.npi,
      name: p.name,
      providerType: p.providerType ?? null,
      taxId: p.taxId ?? null,
      address1: p.address1 ?? null,
      address2: p.address2 ?? null,
      city: p.city ?? null,
      state: p.state ?? null,
      zip: p.zip ?? null,
      phone: p.phone ?? null,
      fax: p.fax ?? null
    };
  }
  return {
    source: 'manual',
    name: p.name,
    providerType: p.providerType ?? undefined,
    taxId: p.taxId ?? undefined,
    phone: p.phone ?? undefined,
    fax: p.fax ?? undefined,
    address1: p.address1 ?? undefined,
    address2: p.address2 ?? undefined,
    city: p.city ?? undefined,
    state: p.state ?? undefined,
    zip: p.zip ?? undefined
  };
}

/** Response shape of GET /api/public/npi/search. */
export type NpiSearchResponse = {
  success: boolean;
  count: number;
  widened: boolean;
  data: NpiProvider[];
  message?: string;
};

/** Response shape of GET /api/public/npi/co-located. */
export type CoLocatedResponse = {
  success: boolean;
  count: number;
  data: NpiProvider[];
  message?: string;
};

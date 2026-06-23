// Types for the CPT / hospital pricing proxy (backend /api/me/vendor/pricing/*
// + the pricing snapshot persisted on oe.ShareRequestProcedures).

export interface PriceFormulaStep {
  expr: string;
  value: number;
}

export interface PriceTerm {
  name: string;
  display: string;
  note?: string | null;
  source?: string | null;
  release?: string | null;
  table?: string | null;
  value: number | string;
}

/** One component of the Medicare computation (professional, facility_asc, facility_hopd, anesthesia, inpatient DRG). */
export interface PriceSection {
  kind: string;
  title: string;
  result: number | null;
  result_label?: string | null;
  payable: boolean;
  status?: string | null;
  formula?: string | null;
  legend?: string | null;
  setting_note?: string | null;
  steps?: PriceFormulaStep[];
  terms?: PriceTerm[];
}

/** Per-site all-in Medicare total with the computed 150-200% negotiation range. */
export interface SiteTotal {
  site: string;
  professional: number | null;
  facility: number | null;
  anesthesia: number | null;
  total: number;
  targetMin: number;
  targetMax: number;
}

/** /pricing/cpt/:code response — Medicare breakdown + computed targets. */
export interface CptPriceResult {
  code: string;
  description?: string | null;
  found: boolean;
  zip?: string | null;
  locality?: string | null;
  site?: string | null;
  anes_minutes_used?: number | null;
  sections: PriceSection[];
  totals: SiteTotal[];
  medicareTotal: number | null;
  headlineSite: string | null;
  targetMin: number | null;
  targetMax: number | null;
  targetMinPct: number;
  targetMaxPct: number;
}

/** JSON persisted in oe.ShareRequestProcedures.PricingSnapshot. */
export interface PricingSnapshot {
  code: string;
  description?: string | null;
  zip?: string | null;
  locality?: string | null;
  site?: string | null;
  anesMinutesUsed?: number | null;
  headlineSite: string | null;
  medicareTotal: number | null;
  targetMin: number | null;
  targetMax: number | null;
  targetMinPct: number;
  targetMaxPct: number;
  totals: SiteTotal[];
  sections: PriceSection[];
}

/** Row from GET /share-requests/:id/procedures (pricing columns included). */
export interface ShareRequestProcedure {
  ProcedureId: string;
  ShareRequestId: string;
  CPTCode: string;
  Description: string | null;
  SortOrder: number;
  CreatedDate: string;
  PricingSnapshot: PricingSnapshot | null;
  MedicareTotal: number | null;
  TargetMin: number | null;
  TargetMax: number | null;
  SnapshotZip: string | null;
  SnapshotDate: string | null;
}

export interface HospitalPayerRate {
  payer: string;
  plan: string;
  amount: number;
}

/** One hospital's MRF price line for a code (/pricing/hospital-prices/:code). */
export interface HospitalPrice {
  price_id: number;
  hospital_ccn: string;
  hospital_name: string;
  hospital_city: string;
  hospital_state: string;
  hospital_zip: string;
  billing_code: string;
  code_type: string;
  setting?: string | null;
  billing_class?: string | null;
  cash_price: number | null;
  gross_charge: number | null;
  min_negotiated: number | null;
  max_negotiated: number | null;
  distance_mi?: number | null;
  top_payers: HospitalPayerRate[];
  raw_description?: string | null;
}

export interface HospitalPricesResult {
  code: string;
  count: number;
  procedure?: {
    code_type?: string;
    raw_description?: string;
    layman_description?: string;
    procedure_category?: string;
  } | null;
  results: HospitalPrice[];
}

export interface ProcedureCatalogEntry {
  name: string;
  short_name: string;
  category?: string | null;
  default_setting?: string | null;
  price_mode?: string | null;
}

/** /pricing/search response: bundle catalog + raw hospital price matches. */
export interface PricingSearchResult {
  procedures: ProcedureCatalogEntry[];
  hospitalMatches: Array<HospitalPrice & { layman_description?: string | null }>;
}

export interface UaRelabelRule {
  from: string;
  to: string;
}

/** How rows are grouped for enrollment (one row per primary vs per product line). */
export type RowGrain = 'perPrimary' | 'perProduct' | 'perMember';

/** When a configured product applies to a CSV row. */
export type ProductMatchMode = 'always' | 'fieldEquals' | 'fieldTruthy' | 'fieldNonBlank';

export interface ProductMatch {
  mode: ProductMatchMode;
  /** CSV column name (for fieldEquals / fieldTruthy / fieldNonBlank). */
  field?: string;
  /** Allowed values when mode is fieldEquals. */
  values?: string[];
}

export type KeyStrategyType = 'planCode' | 'composite' | 'codedMap' | 'householdTier';

export interface KeyStrategy {
  type: KeyStrategyType;
  strategies?: string[];
  compositeFields?: string[];
  compositeSeparator?: string;
  tierFields?: string;
  tierPattern?: string;
  uaFields?: string;
  planCodeFields?: string;
  tierUaSuffixRegex?: string;
  uaRelabel?: UaRelabelRule[];
  /** codedMap: file value -> catalog tier (e.g. F -> EF). */
  valueMap?: Record<string, string>;
}

export interface ImportProduct {
  id: string;
  label: string;
  /** AllAboard ProductId this product config maps to. */
  targetProductId: string | null;
  match: ProductMatch;
  keyStrategy: KeyStrategy;
}

/** How a CSV row identifies which AllAboard product (optional — tier key still drives the map). */
export type ProductSourceMode = 'none' | 'fields';

/** How a CSV row resolves the catalog map key (pricing tier within a product). */
export type TierSourceMode = 'tierUa' | 'composite' | 'planCode' | 'composite_then_tier';

export interface PlanKeyProductSource {
  /** none = single assumed product (see productMapping); fields = read vendor product id column(s). */
  mode: ProductSourceMode;
  /** Comma-separated export column fallbacks (e.g. Product_ID). */
  fields: string;
}

export interface PlanKeyTierSource {
  mode: TierSourceMode;
  strategies: string[];
  compositeFields: string[];
  compositeSeparator: string;
  tierFields: string;
  tierPattern: string;
  uaFields: string;
  planCodeFields: string;
  tierUaSuffixRegex: string;
  uaRelabel: UaRelabelRule[];
}

export interface VendorImportRules {
  rowGrain?: RowGrain;
  /** Multi-product config; when empty, legacy planKey path is used. */
  products?: ImportProduct[];
  tobacco: {
    columns: string[];
    yesValues: string[];
    yesWhenNumericGreaterThan: number;
    yesTextPatterns: string[];
  };
  planKey: {
    productSource: PlanKeyProductSource;
    tierSource: PlanKeyTierSource;
    /** @deprecated use tierSource.strategies — kept in sync on save */
    strategies: string[];
    compositeFields: string[];
    compositeSeparator: string;
    tierFields: string;
    tierPattern: string;
    uaFields: string;
    planCodeFields: string;
    tierUaSuffixRegex: string;
    uaRelabel: UaRelabelRule[];
    sourceKeyIncludeRegex: string | null;
  };
  productMapping: {
    /** When productSource.mode is none, optional fixed product for auto-map (AllAboard ProductId). */
    assumedProductId: string | null;
    defaultProductNameContains: string | null;
    planCodePrefixes: string[];
  };
  /** How dependent member ids collapse to primary household key for grouping. */
  householdMemberId?: {
    /** Regex list; first capture group is the base household member id when matched. */
    suffixStripPatterns: string[];
  };
}

export const DEFAULT_VENDOR_IMPORT_RULES: VendorImportRules = {
  rowGrain: 'perPrimary',
  products: [],
  tobacco: {
    columns: ['Tobacco Surcharge', 'Tobacco_Surcharge', 'TobaccoSurcharge'],
    yesValues: [],
    yesWhenNumericGreaterThan: 0,
    yesTextPatterns: ['yes', 'y', 'true', '1'],
  },
  planKey: {
    productSource: { mode: 'none', fields: 'Product_ID' },
    tierSource: {
      mode: 'tierUa',
      strategies: ['planCode', 'tierUa'],
      compositeFields: [],
      compositeSeparator: '_',
      tierFields: 'PlanTier,Family Size Tier,Plan Tier,Coverage Tier',
      tierPattern: '^(EE|ES|EC|EF)$',
      uaFields: 'UA,Deductible IUA,Plan Base',
      planCodeFields: 'Plan Name,Product Name',
      tierUaSuffixRegex: '(\\d{3,6})(EE|ES|EC|EF)$',
      uaRelabel: [],
    },
    strategies: ['planCode', 'tierUa'],
    compositeFields: [],
    compositeSeparator: '_',
    tierFields: 'PlanTier,Family Size Tier,Plan Tier,Coverage Tier',
    tierPattern: '^(EE|ES|EC|EF)$',
    uaFields: 'UA,Deductible IUA,Plan Base',
    planCodeFields: 'Plan Name,Product Name',
    tierUaSuffixRegex: '(\\d{3,6})(EE|ES|EC|EF)$',
    uaRelabel: [],
    sourceKeyIncludeRegex: null,
  },
  productMapping: {
    assumedProductId: null,
    defaultProductNameContains: null,
    planCodePrefixes: [],
  },
  householdMemberId: {
    suffixStripPatterns: [],
  },
};

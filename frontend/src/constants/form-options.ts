// Centralized form dropdown options for the application
// Location: frontend/src/constants/form-options.ts

// Type definitions for dropdown options
export interface DropdownOption {
  value: string;
  label: string;
}

export interface StateOption {
  code: string;
  name: string;
}

export interface StateOptionFormatted {
  value: string;
  label: string;
}

// US States - Multiple formats for backward compatibility
export const US_STATES_FORMATTED: DropdownOption[] = [
  { value: 'AL', label: 'Alabama' },
  { value: 'AK', label: 'Alaska' },
  { value: 'AZ', label: 'Arizona' },
  { value: 'AR', label: 'Arkansas' },
  { value: 'CA', label: 'California' },
  { value: 'CO', label: 'Colorado' },
  { value: 'CT', label: 'Connecticut' },
  { value: 'DE', label: 'Delaware' },
  { value: 'FL', label: 'Florida' },
  { value: 'GA', label: 'Georgia' },
  { value: 'HI', label: 'Hawaii' },
  { value: 'ID', label: 'Idaho' },
  { value: 'IL', label: 'Illinois' },
  { value: 'IN', label: 'Indiana' },
  { value: 'IA', label: 'Iowa' },
  { value: 'KS', label: 'Kansas' },
  { value: 'KY', label: 'Kentucky' },
  { value: 'LA', label: 'Louisiana' },
  { value: 'ME', label: 'Maine' },
  { value: 'MD', label: 'Maryland' },
  { value: 'MA', label: 'Massachusetts' },
  { value: 'MI', label: 'Michigan' },
  { value: 'MN', label: 'Minnesota' },
  { value: 'MS', label: 'Mississippi' },
  { value: 'MO', label: 'Missouri' },
  { value: 'MT', label: 'Montana' },
  { value: 'NE', label: 'Nebraska' },
  { value: 'NV', label: 'Nevada' },
  { value: 'NH', label: 'New Hampshire' },
  { value: 'NJ', label: 'New Jersey' },
  { value: 'NM', label: 'New Mexico' },
  { value: 'NY', label: 'New York' },
  { value: 'NC', label: 'North Carolina' },
  { value: 'ND', label: 'North Dakota' },
  { value: 'OH', label: 'Ohio' },
  { value: 'OK', label: 'Oklahoma' },
  { value: 'OR', label: 'Oregon' },
  { value: 'PA', label: 'Pennsylvania' },
  { value: 'RI', label: 'Rhode Island' },
  { value: 'SC', label: 'South Carolina' },
  { value: 'SD', label: 'South Dakota' },
  { value: 'TN', label: 'Tennessee' },
  { value: 'TX', label: 'Texas' },
  { value: 'UT', label: 'Utah' },
  { value: 'VT', label: 'Vermont' },
  { value: 'VA', label: 'Virginia' },
  { value: 'WA', label: 'Washington' },
  { value: 'WV', label: 'West Virginia' },
  { value: 'WI', label: 'Wisconsin' },
  { value: 'WY', label: 'Wyoming' }
];

export const US_STATES_CODE_NAME: StateOption[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' }
];

// Business Types - Comprehensive list
export const BUSINESS_TYPES: string[] = [
  'Corporation',
  'LLC',
  'Partnership',
  'Sole Proprietorship',
  'Non-Profit',
  'Government',
  'Other'
];

// Credit Card Types
export const CREDIT_CARD_TYPES: string[] = [
  'Visa',
  'MasterCard',
  'American Express',
  'Discover'
];

// Account Types
export const ACCOUNT_TYPES: string[] = [
  'Checking',
  'Savings'
];

// Payment Methods
export const PAYMENT_METHODS: string[] = [
  'Credit Card',
  'ACH',
  'Check',
  'Money Order'
];

// Industries
export const INDUSTRIES: string[] = [
  'Healthcare',
  'Technology',
  'Manufacturing',
  'Retail',
  'Education',
  'Financial Services',
  'Construction',
  'Hospitality',
  'Transportation',
  'Other'
];

// Time Zones
export const TIME_ZONES: DropdownOption[] = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time (HST)' }
];

// Product Types
export const PRODUCT_TYPES: string[] = [
  'Healthcare',
  'Dental',
  'Vision',
  'Life Insurance',
  'Disability',
  'Accident',
  'Critical Illness',
  'Hospital Indemnity',
  'Other'
];

// License Types - Based on checked licenses from product wizard
export const LICENSE_TYPES: DropdownOption[] = [
  { value: 'Life Insurance', label: 'Life Insurance' },
  { value: 'Health', label: 'Health' },
  { value: 'Casualty', label: 'Casualty' },
  { value: 'Medicare Advantage', label: 'Medicare Advantage' },
  { value: 'Accident', label: 'Accident' },
  { value: 'Property', label: 'Property' },
  { value: 'Medicare Supplement', label: 'Medicare Supplement' }
  // Commented out to match product wizard selections:
  // { value: 'Personal Lines', label: 'Personal Lines' },
  // { value: 'Variable Contracts', label: 'Variable Contracts' },
  // { value: 'Limited Lines', label: 'Limited Lines' },
  // { value: 'Surplus Lines', label: 'Surplus Lines' },
  // { value: 'Navigator / Exchange License', label: 'Navigator / Exchange License' }
];

// License Status Options
export const LICENSE_STATUS_OPTIONS: DropdownOption[] = [
  { value: 'Active', label: 'Active' },
  { value: 'Inactive', label: 'Inactive' },
  { value: 'Suspended', label: 'Suspended' },
  { value: 'Cancelled', label: 'Cancelled' }
];

// Residency Type Options
export const RESIDENCY_TYPE_OPTIONS: DropdownOption[] = [
  { value: 'Resident', label: 'Resident' },
  { value: 'Non-Resident', label: 'Non-Resident' }
];

// Required Licenses (legacy - keeping for backward compatibility)
export const REQUIRED_LICENSES: string[] = [
  'Life',
  'Health',
  'Accident',
  'PropertyCasualty'
];

// Tobacco Options
export const TOBACCO_OPTIONS: DropdownOption[] = [
  { value: 'Yes', label: 'Yes' },
  { value: 'No', label: 'No' }
];

// Gender Options
export const GENDER_OPTIONS: DropdownOption[] = [
  { value: 'Male', label: 'Male' },
  { value: 'Female', label: 'Female' },
  { value: 'Other', label: 'Other' },
  { value: 'Prefer not to say', label: 'Prefer not to say' }
];

// Marital Status Options
export const MARITAL_STATUS_OPTIONS: DropdownOption[] = [
  { value: 'Single', label: 'Single' },
  { value: 'Married', label: 'Married' },
  { value: 'Divorced', label: 'Divorced' },
  { value: 'Widowed', label: 'Widowed' },
  { value: 'Separated', label: 'Separated' }
];

// Relationship Types
export const RELATIONSHIP_TYPES: DropdownOption[] = [
  { value: 'Spouse', label: 'Spouse' },
  { value: 'Child', label: 'Child' },
  { value: 'Dependent', label: 'Dependent' },
  { value: 'Other', label: 'Other' }
];

// Commission Tier Levels - Standard hierarchy structure
export interface TierLevel {
  level: number;
  name: string;
  description: string;
}

export const COMMISSION_TIER_LEVELS: TierLevel[] = [
  { level: -1, name: 'Associate', description: 'Referral Partner — entry-level referral commission' },
  { level: 0, name: 'Agent', description: 'Writing Agent — primary producer earning base commission' },
  { level: 1, name: 'Agency', description: 'Override for managing agent downline' },
  { level: 2, name: 'GA', description: 'General Agency — regional override layer' },
  { level: 3, name: 'MGA', description: 'Master General Agency — senior regional override tier' },
  { level: 4, name: 'IMO', description: 'Independent Marketing Org — national distribution tier' },
  { level: 5, name: 'FMO', description: 'Field Marketing Org — top distribution tier' },
  { level: 6, name: 'Enterprise/Carrier', description: 'Platform fees or carrier rev share' },
];

/** Normalize snapshot tier from API/DB (handles decimals like -1.0000001 → -1). */
export const coerceCommissionTierLevelSnapshot = (raw: unknown): number | null => {
  if (raw === undefined || raw === null || raw === '') return null;
  const x = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(x)) return null;
  const rounded = Math.round(x);
  if (Math.abs(x - rounded) < 1e-6) return rounded;
  return x;
};

// Helper function to get tier level by level number
export const getTierLevelByLevel = (level: number): TierLevel | undefined => {
  const coerced = coerceCommissionTierLevelSnapshot(level);
  if (coerced === null) return undefined;
  return COMMISSION_TIER_LEVELS.find(tier => tier.level === coerced);
};

/** Returns tier levels that are strictly below the viewer's level (for dropdown when assigning a downline). Higher levels first. */
export const getTierLevelsBelowViewer = (viewerLevel: number): TierLevel[] => {
  return COMMISSION_TIER_LEVELS.filter((t) => t.level < viewerLevel).sort((a, b) => b.level - a.level);
};

// Helper function to get tier level by name
export const getTierLevelByName = (name: string): TierLevel | undefined => {
  return COMMISSION_TIER_LEVELS.find(tier => tier.name.toLowerCase() === name.toLowerCase());
};

// Helper function to get formatted tier level label (e.g., "Level 0: Agent")
export const getTierLevelLabel = (tierLevel?: number | null): string => {
  if (tierLevel === undefined || tierLevel === null) return '';
  const tier = getTierLevelByLevel(tierLevel);
  if (!tier) {
    const n = Number(tierLevel);
    if (!Number.isFinite(n)) return '';
    const text = Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(4)));
    return `Level ${text}`;
  }

  // Format: "Level {level}: {name}"
  return `Level ${tier.level}: ${tier.name}`;
};

function isNumericTierLabelString(s: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(s.trim());
}

/**
 * Payout row display: prefer tenant commission level name from DB; avoid showing "-1.0000".
 * When label is missing or numeric-only, use canonical tier name from COMMISSION_TIER_LEVELS.
 */
export const formatPayoutCommissionTierDisplay = (
  tierLevelSnapshot: number | null | undefined,
  snapshotLabel: string | null | undefined
): string => {
  const trimmed = snapshotLabel != null ? String(snapshotLabel).trim() : '';
  const level = coerceCommissionTierLevelSnapshot(tierLevelSnapshot);

  if (trimmed && !isNumericTierLabelString(trimmed)) {
    if (level != null) {
      const tier = getTierLevelByLevel(level);
      const shortName = tier?.name;
      if (shortName && !trimmed.toLowerCase().includes(shortName.toLowerCase())) {
        return `${trimmed} (${shortName})`;
      }
    }
    return trimmed;
  }

  if (level != null) {
    return getTierLevelLabel(level);
  }

  if (trimmed && isNumericTierLabelString(trimmed)) {
    const coerced = coerceCommissionTierLevelSnapshot(Number(trimmed));
    if (coerced != null) {
      return getTierLevelLabel(coerced);
    }
  }

  return trimmed || '';
};

// Helper function to get tier name options for dropdowns
export const TIER_NAME_OPTIONS: DropdownOption[] = COMMISSION_TIER_LEVELS.map(tier => ({
  value: tier.name,
  label: `${tier.name} (Level ${tier.level})`
}));

/** Short tier name for a single level (e.g. "Agent", "GA"). */
export const getTierName = (level: number): string => {
  const tier = getTierLevelByLevel(level);
  return tier ? tier.name : `Level ${level}`;
};

/**
 * Tier display for a commission rule when listing rules.
 * - Tiered structure (CommissionType=Tiered): all tiers from CommissionJson, e.g. "Associate, Agent, Agency, GA, MGA, IMO, FMO".
 * - Single-tier (EntityType=Tier with TierLevel): "Agent", "GA", etc.
 * - Otherwise: empty string.
 */
export const getTierDisplayForRule = (rule: {
  EntityType?: string;
  TierLevel?: number | null;
  CommissionType?: string;
  CommissionJson?: string | object | null;
}): string => {
  // Tiered rules: use CommissionJson first (covers full multi-tier structure)
  if (rule.CommissionType === 'Tiered' && rule.CommissionJson) {
    try {
      const json = typeof rule.CommissionJson === 'string'
        ? JSON.parse(rule.CommissionJson)
        : rule.CommissionJson;
      if (json?.tiers && Array.isArray(json.tiers) && json.tiers.length > 0) {
        const names = json.tiers
          .map((t: { level?: number; tierLevel?: number; name?: string }) => {
            const lvl = t.level ?? t.tierLevel ?? 0;
            return t.name || getTierName(lvl);
          })
          .filter(Boolean);
        return [...new Set(names)].join(', ');
      }
    } catch {
      // ignore parse errors
    }
  }
  // Single-tier rules
  if (rule.EntityType === 'Tier' && rule.TierLevel != null) {
    return getTierName(rule.TierLevel);
  }
  return '';
};

/**
 * Split commission display for a rule (who it's split with and percentages).
 * Returns e.g. "Jane Smith (60%), John Doe (40%)" or empty string if not a split rule.
 */
export const getSplitDisplayForRule = (rule: {
  CommissionType?: string;
  CommissionJson?: string | object | null;
}): string => {
  if (rule.CommissionType !== 'Split' || !rule.CommissionJson) return '';
  try {
    const json = typeof rule.CommissionJson === 'string'
      ? JSON.parse(rule.CommissionJson)
      : rule.CommissionJson;
    const sc = json?.splitCommission;
    if (!sc) return '';
    const parts: string[] = [];
    const primaryName = sc.primaryAgentName?.trim();
    const primaryPct = sc.primaryAgentPercentage;
    if (primaryName && primaryPct != null) {
      parts.push(`${primaryName} (${(primaryPct * 100).toFixed(0)}%)`);
    }
    if (sc.agents && Array.isArray(sc.agents)) {
      for (const a of sc.agents) {
        if (a.agentId === sc.primaryAgentId) continue;
        const name = (a.agentName || '').trim() || `Agent`;
        const pct = a.percentage;
        if (pct != null && pct > 0) {
          parts.push(`${name} (${(pct * 100).toFixed(0)}%)`);
        }
      }
    }
    return parts.join(', ');
  } catch {
    return '';
  }
};

/** Tier levels we expect a commission group to cover (Agent through FMO). */
const COMMISSION_GROUP_TIERS = [0, 1, 2, 3, 4, 5] as const;

/** Returns tier levels covered by a single rule (for group coverage analysis). */
export const getTiersCoveredByRule = (rule: {
  EntityType?: string;
  TierLevel?: number | null;
  CommissionType?: string;
  CommissionJson?: string | object | null;
}): number[] => {
  const covered: number[] = [];
  if (rule.EntityType === 'Tier' && rule.TierLevel != null) {
    covered.push(rule.TierLevel);
  }
  if (rule.CommissionType === 'Tiered' && rule.CommissionJson) {
    try {
      const json = typeof rule.CommissionJson === 'string'
        ? JSON.parse(rule.CommissionJson)
        : rule.CommissionJson;
      if (json?.tiers && Array.isArray(json.tiers)) {
        for (const t of json.tiers) {
          const lvl = t.level ?? t.tierLevel;
          if (typeof lvl === 'number') covered.push(lvl);
        }
      }
    } catch {
      // ignore
    }
  }
  return [...new Set(covered)];
};

/**
 * Returns tier levels (0–5) that have no rule coverage in the group.
 * Used to warn when agents at certain levels won't receive commission.
 */
export const getMissingTiersForGroup = (rules: Array<{
  EntityType?: string;
  TierLevel?: number | null;
  CommissionType?: string;
  CommissionJson?: string | object | null;
}>): number[] => {
  const covered = new Set<number>();
  for (const r of rules) {
    for (const lvl of getTiersCoveredByRule(r)) {
      if (COMMISSION_GROUP_TIERS.includes(lvl as 0 | 1 | 2 | 3 | 4 | 5)) covered.add(lvl);
    }
  }
  return COMMISSION_GROUP_TIERS.filter((l) => !covered.has(l));
};

const ALL_PRODUCTS_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Returns tenant products (excluding bundles) that have no rule in the group.
 * If any rule has ProductId = All Products, returns [] (all products are covered).
 */
export const getMissingProductsForGroup = (
  products: Array<{ ProductId: string; Name: string }>,
  rules: Array<{ ProductId?: string }>
): Array<{ ProductId: string; Name: string }> => {
  const hasAllProducts = rules.some((r) => r.ProductId === ALL_PRODUCTS_ID);
  if (hasAllProducts) return [];
  const coveredIds = new Set(rules.map((r) => r.ProductId).filter(Boolean));
  return products.filter((p) => !coveredIds.has(p.ProductId));
};

// Helper functions
export const getStateByCode = (code: string): StateOption | undefined => {
  return US_STATES_CODE_NAME.find(state => state.code === code);
};

export const getStateByValue = (value: string): DropdownOption | undefined => {
  return US_STATES_FORMATTED.find(state => state.value === value);
};

export const getBusinessTypeLabel = (type: string): string => {
  return BUSINESS_TYPES.includes(type) ? type : 'Other';
};

export const getCreditCardTypeLabel = (type: string): string => {
  return CREDIT_CARD_TYPES.includes(type) ? type : 'Unknown';
};

export const getAccountTypeLabel = (type: string): string => {
  return ACCOUNT_TYPES.includes(type) ? type : 'Unknown';
};

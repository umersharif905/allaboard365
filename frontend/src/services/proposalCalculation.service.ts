/**
 * PROPOSAL CALCULATION SERVICE
 * 
 * Type definitions for business proposal tier pricing.
 * All business proposal calculations are now computed server-side
 * by the backend proposalCalculation.service.js.
 */

// ============================================================================
// TYPES
// ============================================================================

export type TierCounts = { EE: number; ES: number; EC: number; EF: number };
export type TierPrices = { EE: number; ES: number; EC: number; EF: number };

export interface AgeBand {
  label: string;
  minAge: number;
  maxAge: number;
}

export interface AgeBandTierCounts {
  label: string;
  minAge: number;
  maxAge: number;
  counts: TierCounts;
}

export interface AgeBandTierPrices {
  label: string;
  minAge: number;
  maxAge: number;
  prices: TierPrices;
}

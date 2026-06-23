/** Shared with accounting commission breakdown API and payment detail UIs. */

export interface PaymentBreakdownProduct {
  productId: string;
  productName: string;
  commissionAmount: number;
  /** Per-product tier distribution: "EE: 2, ES: 0, EC: 1, EF: 2" for groups, "EE" for individuals */
  tierDisplay?: string | null;
  breakdown: Array<{
    recipientName: string;
    amount: number;
    ruleName: string | null;
    tierLevel: number | null;
    recipientAgentId?: string | null;
    recipientAgencyId?: string | null;
  }>;
}

export interface PaymentBreakdownAgentOverride {
  overrideId: string;
  overrideType: 'Fixed' | 'Percentage';
  sourceAgentId: string;
  sourceAgentName: string;
  recipientAgentId: string;
  recipientAgentName: string | null;
  amount: number;
  sourceTotalBefore?: number;
  skipped?: boolean;
  skipReason?: string;
  viewerRole?: 'source' | 'recipient' | 'downline';
}

export interface PaymentBreakdownData {
  paymentId: string;
  paymentDate: string;
  amount: number;
  commission: number;
  commissionBeforeOverrides?: number;
  commissionAfterOverrides?: number;
  agentName: string;
  agentCommissionTierLevel?: number | null;
  /** Tenant-defined commission level name at calculation/snapshot time when API provides it. */
  agentCommissionTierLevelSnapshotLabel?: string | null;
  /** Selling agent IDs surfaced from getPaymentBreakdownPreview — let UIs
   *  fetch agency / commission-group context without re-deriving. */
  sellingAgentId?: string | null;
  sellingAgentAgencyId?: string | null;
  clientTierDisplay?: string | null;
  products: PaymentBreakdownProduct[];
  agentOverrides?: PaymentBreakdownAgentOverride[];
}

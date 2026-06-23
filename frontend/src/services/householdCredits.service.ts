import { apiService } from './api.service';

export interface CreditEntry {
  EntryId: string;
  EntryType:
    | 'OverpaymentRecognized'
    | 'AppliedToInvoice'
    | 'ReversedApplication'
    | 'ManualGoodwill'
    | 'Voided';
  Amount: number;
  SourcePaymentId?: string | null;
  SourceInvoiceId?: string | null;
  TargetInvoiceId?: string | null;
  RelatedEntryId?: string | null;
  Notes?: string | null;
  CreatedBy?: string | null;
  CreatedDate: string;
}

export interface CreditBalance {
  availableCredit: number;
  entryCount: number;
  byEntry: CreditEntry[];
}

export interface CreditBalanceListRow {
  /**
   * Null for group-scoped credits (credits attached directly to a Group; the
   * group has no household). Populated for individual / household-scoped
   * credits.
   */
  HouseholdId: string | null;
  TenantId: string;
  Balance: number;
  EntryCount: number;
  LastActivity: string;
  PrimaryMemberId?: string | null;
  GroupId?: string | null;
  PrimaryName?: string | null;
  GroupName?: string | null;
  HouseholdType: 'Individual' | 'Group';
  /** Sum of all positive entries ever issued to this account. */
  TotalIssued?: number;
  /** Sum of |negative entries| — credit consumed via apply or void. */
  TotalApplied?: number;
}

export const householdCreditsService = {
  async getMemberSelf(): Promise<CreditBalance> {
    const res = await apiService.get<{ success: boolean; data: CreditBalance }>(
      '/api/me/member/household-credits'
    );
    return res.data;
  },

  async getForHousehold(householdId: string): Promise<CreditBalance> {
    const res = await apiService.get<{ success: boolean; data: CreditBalance }>(
      `/api/admin/household-credits?householdId=${encodeURIComponent(householdId)}`
    );
    return res.data;
  },

  async listBalances(params: { search?: string; householdType?: 'Individual' | 'Group' | ''; groupId?: string; includeApplied?: boolean } = {}): Promise<CreditBalanceListRow[]> {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.householdType) qs.set('householdType', params.householdType);
    if (params.groupId) qs.set('groupId', params.groupId);
    if (params.includeApplied) qs.set('includeApplied', 'true');
    const url = `/api/admin/household-credits/balances${qs.toString() ? `?${qs.toString()}` : ''}`;
    const res = await apiService.get<{ success: boolean; data: CreditBalanceListRow[] }>(url);
    return res.data;
  },

  async createGoodwill(payload: {
    tenantId: string;
    householdId: string;
    amount: number;
    notes?: string;
    /**
     * When true (default), the credit is created AND immediately applied
     * across the household's unpaid invoices oldest-first in a single
     * transaction. When false, the credit sits on the account and auto-applies
     * on the next nightly run.
     */
    applyNow?: boolean;
  }) {
    return apiService.post<{
      success: boolean;
      data: {
        entryId: string;
        applications: Array<{
          invoiceId: string;
          appliedAmount: number;
          newStatus: string;
        }>;
      };
    }>(
      '/api/admin/household-credits',
      payload
    );
  },

  async voidEntry(entryId: string, reason?: string) {
    return apiService.patch<{ success: boolean; data: { entryId: string; voidedAmount: number } }>(
      `/api/admin/household-credits/${encodeURIComponent(entryId)}/void`,
      { reason }
    );
  },

  async runDetectionNow() {
    return apiService.post<{ success: boolean; data: { recognized: number; householdsTouched: number; applicationsCount: number } }>(
      '/api/admin/household-credits/run-detection',
      {}
    );
  }
};

/**
 * Group-scoped credit ledger client. Mirrors the household service shape.
 */
export const groupCreditsService = {
  async getForGroup(groupId: string): Promise<CreditBalance> {
    const res = await apiService.get<{ success: boolean; data: CreditBalance }>(
      `/api/admin/group-credits?groupId=${encodeURIComponent(groupId)}`
    );
    return res.data;
  },

  async createGoodwill(payload: {
    tenantId: string;
    groupId: string;
    amount: number;
    notes?: string;
    applyNow?: boolean;
  }) {
    return apiService.post<{
      success: boolean;
      data: {
        entryId: string;
        applications: Array<{
          invoiceId: string;
          appliedAmount: number;
          newStatus: string;
        }>;
      };
    }>('/api/admin/group-credits', payload);
  },

  voidEntry(entryId: string, reason?: string) {
    return householdCreditsService.voidEntry(entryId, reason);
  }
};

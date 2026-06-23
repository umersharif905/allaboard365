import { apiService } from '../api.service';

export interface ProductOverrideRow {
  overrideACHId: string | null;
  tenantId: string;
  tenantName: string;
  accountName: string;
  accountHolderName: string | null;
  bankName: string | null;
  accountNumberLast4: string | null;
  expectedAmount: number;
  paidAmount: number;
  unpaidAmount: number;
  /** Tenant-level pending payout clawbacks (oe.PayoutClawbacks). Same value appears on every ACH row for a tenant since clawback is recipient-level. */
  pendingClawbackAmount?: number;
  pendingClawbackCount?: number;
  netNextPayoutAmount?: number;
  hasActiveAch: boolean;
  /** True when expected amount is from ProductPricing.OverrideRate with no oe.ProductOverrides row (pricing-only). */
  uncategorizedPricingGap?: boolean;
}

export interface ProductOverridesReconciliation {
  /** advancedSettings.payouts.overrideBasis */
  payoutBasis: string;
  /** Payments included in this report after payout-window + funding gate */
  fundedPaymentsInWindow: number;
  /** Sum of expectedAmount in the table (matches footer Total if you sum Total column). */
  reportExpectedTotal: number;
  /** SUM(Invoices.OverrideRate) for Paid invoices whose billing period overlaps the selected dates. */
  invoicePaidOverrideBillingPeriodOverlap: number;
  /** SUM(Invoices.OverrideRate) for Paid invoices whose fulfillment anchor falls in the selected dates. */
  invoicePaidOverrideFulfillmentInWindow: number;
  /** Portion of the billing-overlap sum on Paid invoices that have no oe.Payments row (credit-funded). */
  creditFundedPaidInvoiceOverrideBillingOverlap: number;
}

export async function getProductOverrides(params: { startDate: string; endDate: string }): Promise<{
  success: boolean;
  data: ProductOverrideRow[];
  reconciliation?: ProductOverridesReconciliation | null;
}> {
  const query = new URLSearchParams();
  query.append('startDate', params.startDate);
  query.append('endDate', params.endDate);

  return apiService.get<{ success: boolean; data: ProductOverrideRow[] }>(
    `/api/accounting/product-overrides?${query.toString()}`
  );
}

export async function getTenantOverrideAchDetails(tenantId: string): Promise<{ success: boolean; data: any }> {
  const payoutType = encodeURIComponent('Product Override Distributions');
  return apiService.get<{ success: boolean; data: any }>(
    `/api/accounting/nacha/ach-details/Tenant/${tenantId}?payoutType=${payoutType}`
  );
}

export interface OverrideBreakdownItem {
  productId: string;
  productName: string;
  tiers: {
    productPricingId: string;
    pricingTier: string;
    enrollmentCount: number;
    overrideAmount: number;
    totalOverride: number;
  }[];
  totalOverride: number;
}

export interface FilterOption {
  id: string;
  label: string;
  type: 'all' | 'group' | 'member';
  value: string;
}

export async function getOverrideBreakdownFilterOptions(params: {
  overrideACHId: string | null;
  tenantId: string;
  startDate: string;
  endDate: string;
}): Promise<{ success: boolean; data: FilterOption[] }> {
  const query = new URLSearchParams();
  query.append('overrideACHId', params.overrideACHId || '');
  query.append('tenantId', params.tenantId);
  query.append('startDate', params.startDate);
  query.append('endDate', params.endDate);

  return apiService.get<{ success: boolean; data: FilterOption[] }>(
    `/api/accounting/product-overrides/filter-options?${query.toString()}`
  );
}

export async function getOverrideBreakdown(params: {
  overrideACHId: string | null;
  tenantId: string;
  startDate: string;
  endDate: string;
  groupId?: string;
  householdId?: string;
}): Promise<{ success: boolean; data: OverrideBreakdownItem[] }> {
  const query = new URLSearchParams();
  query.append('overrideACHId', params.overrideACHId || '');
  query.append('tenantId', params.tenantId);
  query.append('startDate', params.startDate);
  query.append('endDate', params.endDate);
  if (params.groupId) query.append('groupId', params.groupId);
  if (params.householdId) query.append('householdId', params.householdId);

  return apiService.get<{ success: boolean; data: OverrideBreakdownItem[] }>(
    `/api/accounting/product-overrides/breakdown?${query.toString()}`
  );
}



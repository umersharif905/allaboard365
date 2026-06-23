// Types for the Cases feature (back-office vendor portal).
// Renamed from case.types.ts on 2026-05-19.
// Mirrors the shape of the Case row returned by the backend.

import type { FinanceSummary, PaymentType, TransactionStatus } from './shareRequest.types';

export type CaseStatus =
  | 'Open'
  | 'In Progress'
  | 'Pending'
  | 'Closed';

export const CASE_STATUSES: CaseStatus[] = [
  'Open',
  'In Progress',
  'Pending',
  'Closed',
];

export const STATUS_COLORS: Record<CaseStatus, { bg: string; text: string }> = {
  'Open':        { bg: 'bg-blue-100',   text: 'text-blue-800' },
  'In Progress': { bg: 'bg-sky-100',    text: 'text-sky-800' },
  'Pending':     { bg: 'bg-yellow-100', text: 'text-yellow-800' },
  'Closed':      { bg: 'bg-gray-100',   text: 'text-gray-800' },
};

// Codes are vendor-defined now (white-label). Stored as plain strings; the
// vendor's active codes are exposed by useCaseTaxonomy().
export type CaseType = string;
export type CaseSubcategory = string;

export interface CaseRow {
  CaseId: string;
  VendorId: string;
  CaseNumber: string;
  MemberId: string;
  HouseholdId?: string | null;
  Status: CaseStatus;
  CaseType: CaseType;
  CaseSubcategory?: CaseSubcategory | null;
  SubcategoryDetail?: string | null;
  Title?: string | null;
  Description?: string | null;
  SubmittedDate: string;
  CompletedDate?: string | null;
  ClaimedByUserId?: string | null;
  ClaimedAt?: string | null;
  CreatedDate: string;
  ModifiedDate?: string | null;
  MemberFirstName?: string | null;
  MemberLastName?: string | null;
  MemberEmail?: string | null;
  MemberPhone?: string | null;
  MemberDOB?: string | null;
  MemberNumber?: string | null;
  ClaimedByFirstName?: string | null;
  ClaimedByLastName?: string | null;
  /** Claimer's PreferredColor (#rrggbb) for the colored pill. Null when unclaimed. */
  ClaimedByColor?: string | null;
  CreatedByFirstName?: string | null;
  CreatedByLastName?: string | null;
  /** True for an unmatched "shell" case awaiting a member match (back-office triage). */
  NeedsMemberMatch?: boolean;
  ForwardingTarget?: { targetId: string; label: string; planVendorId: string } | null;
}

export interface CaseDashboardStats {
  Total: number;
  Unclaimed: number;
  Claimed: number;
  OpenCount: number;
  InProgress: number;
  Pending: number;
  Closed: number;
}

export interface CaseNote {
  NoteId: string;
  NoteType: string;
  Note: string;
  IsInternal: boolean;
  PreviousValue?: string | null;
  NewValue?: string | null;
  CreatedDate: string;
  CreatedByName?: string | null;
}

export interface CaseProviderRow {
  CaseProviderId: string;
  CaseId: string;
  ProviderId: string;
  ProviderRole?: string | null;
  Notes?: string | null;
  CreatedDate: string;
  ProviderName?: string | null;
  NPI?: string | null;
  Phone?: string | null;
  Address1?: string | null;
  City?: string | null;
  State?: string | null;
}

export interface CaseDocumentRow {
  DocumentId: string;
  CaseId: string;
  DocumentName: string;
  DocumentType?: string | null;
  FileName: string;
  FileSize?: number | null;
  MimeType?: string | null;
  BlobUrl?: string | null;
  BlobPath?: string | null;
  Description?: string | null;
  IsActive: boolean;
  CreatedDate: string;
  AuthenticatedUrl?: string | null;
}

export interface MemberSearchResult {
  MemberId: string;
  FirstName: string;
  LastName: string;
  Email?: string | null;
  Phone?: string | null;
  HouseholdId?: string | null;
  HouseholdMemberID?: string | null;
}

// ============================================================================
// FINANCES — Case Bills + Ledger (mirrors the Share Request finance model, but
// without the UA / share / CPT machinery; see docs/billing-rework).
// ============================================================================

export type CaseBillType = 'Bill' | 'Estimate';

export const CASE_BILL_TYPES: CaseBillType[] = ['Bill', 'Estimate'];

// Reduced transaction-type set: the SR set minus the UA-specific types.
export type CaseTransactionType =
  | 'Payment to Provider'
  | 'Member Payment'
  | 'Reimbursement'
  | 'Discount'
  | 'Financial Aid';

export const CASE_TRANSACTION_TYPES: CaseTransactionType[] = [
  'Payment to Provider',
  'Member Payment',
  'Reimbursement',
  'Discount',
  'Financial Aid',
];

// Display labels for the Case ledger (kept distinct from SR so "member payment"
// reads clearly without the UA framing).
export const CASE_TRANSACTION_TYPE_LABELS: Record<string, string> = {
  'Payment to Provider': 'Payment to provider',
  'Member Payment': 'Member payment',
  'Reimbursement': 'Reimbursement (to member)',
  'Discount': 'Discount',
  'Financial Aid': 'Financial aid',
};

export const caseTransactionTypeLabel = (t: string): string =>
  CASE_TRANSACTION_TYPE_LABELS[t] ?? t;

export interface CaseBill {
  BillId: string;
  CaseId: string;
  VendorId: string;
  ProviderId?: string | null;
  BillNumber?: string | null;
  BillType: CaseBillType;
  BillDate?: string | null;
  DateOfService?: string | null;
  Description?: string | null;
  BilledAmount: number;
  AllowedAmount?: number | null;
  PaidAmount: number;
  Balance: number;
  Notes?: string | null;
  IsActive: boolean;
  CreatedDate: string;
  CreatedBy?: string | null;
  ModifiedDate?: string | null;
  ModifiedBy?: string | null;
  // Joined
  ProviderName?: string | null;
  NPI?: string | null;
}

export interface CaseTransaction {
  TransactionId: string;
  CaseId: string;
  VendorId: string;
  BillId?: string | null;
  ProviderId?: string | null;
  TransactionType: CaseTransactionType;
  PaymentType?: PaymentType | null;
  TransactionStatus: TransactionStatus;
  Amount: number;
  TransactionDate: string;
  ReferenceNumber?: string | null;
  Description?: string | null;
  Notes?: string | null;
  CreatedDate: string;
  CreatedBy?: string | null;
  ModifiedDate?: string | null;
  ModifiedBy?: string | null;
  // Joined
  BillNumber?: string | null;
  ProviderName?: string | null;
}

// The Case finance-summary endpoint reuses the same computed contract as the
// Share Request one (the UA buckets simply come back as zero).
export interface CaseFinanceSummaryResponse {
  success: boolean;
  data: FinanceSummary & { caseId: string };
}

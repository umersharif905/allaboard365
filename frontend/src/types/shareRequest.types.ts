// types/shareRequest.types.ts
// Type definitions for Share Request Management

import type { UserColorHex } from './userColor';

/**
 * Per-vendor share request type, managed by VendorAdmin via
 * /api/me/vendor/request-types. Replaces the old hardcoded RequestType +
 * lookup-table Category/SubCategory model.
 */
export interface VendorRequestType {
  TypeId: string;
  VendorId: string;
  Name: string;
  SortOrder: number;
  CreatedDate?: string;
  ModifiedDate?: string | null;
}

export type ShareRequestStatus =
  | 'New'
  | 'Acknowledged'
  | 'In Review'
  | 'Awaiting Member Info'
  | 'Awaiting Authorization'
  | 'Processing'
  | 'Completed'
  | 'Denied'
  | 'Withdrawn';

// ============================================================================
// MEMBER-FACING PROGRESS BAR (4-step stepper)
// ============================================================================

export type ShareRequestTerminalVariant = 'success' | 'denied' | 'withdrawn';

export interface ShareRequestStepInfo {
  stepIndex: 0 | 1 | 2 | 3;
  terminalVariant: ShareRequestTerminalVariant | null;
  actionNeeded: boolean;
}

export const SHARE_REQUEST_STEPS = ['Submitted', 'Acknowledged', 'Processing', 'Processed'] as const;

/**
 * Single source of truth for mapping a backend ShareRequest Status onto one of
 * the 4 member-facing steps. Unknown/unexpected statuses default to step 2
 * (Processing) so the member always sees a sensible "in progress" state.
 */
export function mapShareRequestStatusToStep(status: string): ShareRequestStepInfo {
  switch (status) {
    case 'New':
      return { stepIndex: 0, terminalVariant: null, actionNeeded: false };
    case 'Acknowledged':
      return { stepIndex: 1, terminalVariant: null, actionNeeded: false };
    case 'In Review':
    case 'Awaiting Authorization':
    case 'Processing':
      return { stepIndex: 2, terminalVariant: null, actionNeeded: false };
    case 'Awaiting Member Info':
      return { stepIndex: 2, terminalVariant: null, actionNeeded: true };
    case 'Completed':
      return { stepIndex: 3, terminalVariant: 'success', actionNeeded: false };
    case 'Denied':
      return { stepIndex: 3, terminalVariant: 'denied', actionNeeded: false };
    case 'Withdrawn':
      return { stepIndex: 3, terminalVariant: 'withdrawn', actionNeeded: false };
    default:
      return { stepIndex: 2, terminalVariant: null, actionNeeded: false };
  }
}

/**
 * Member-facing hover copy for each step circle/label, plus the variant-specific
 * copy for the terminal "Processed" step and the amber action-needed banner.
 */
export const SHARE_REQUEST_STEP_TOOLTIPS = {
  Submitted:
    'Your request has been submitted. A care team member will be reviewing it shortly.',
  Acknowledged:
    'The care team has received your sharing request and is determining the next steps.',
  Processing:
    'Your request is being actively worked — the team is reviewing bills, coordinating with providers, and determining what can be shared. This step can take some time.',
  ActionNeeded:
    "Action needed — please check your email for a request for more information. If you don't see anything, reach out to the care team directly.",
  ProcessedSuccess: 'Your share request is complete. Open the details for more.',
  ProcessedDenied: 'Your share request was denied. Open the details for more.',
  ProcessedWithdrawn: 'Your share request was withdrawn. Open the details for more.',
} as const;

export type ShareRequestDetermination =
  | 'Pending'
  | 'Not Eligible'
  | 'Eligible'
  | 'Undetermined';

export type BillType = 'Bill' | 'Estimate';

export type TransactionType =
  | 'Payment to Provider'
  | 'Member Payment'
  | 'UA Payment'
  | 'UA Reduction'
  | 'Reimbursement'
  | 'Discount'
  | 'Financial Aid'
  // Legacy values — retained so historical transactions still render; these are
  // no longer offered in the Add Transaction dropdown (collapsed into 'Discount'
  // / 'Financial Aid'). See docs/billing-rework/BLOCKERS.md #4.
  | 'Discount from Provider'
  | 'Discount from Emry FA'
  | 'Discount from Emry RBP'
  | 'Negotiation';

export type PaymentType = 'ACH' | 'Credit Card' | 'Benji Card' | 'Check' | 'Debit' | 'Discount';

export type TransactionStatus = 'Pending' | 'Cleared' | 'Cancelled';

export type MemberPaymentMethod = 'Check' | 'ACH' | 'Digital Debit Card';

export interface ShareRequestDiagnosis {
  DiagnosisId: string;
  ShareRequestId: string;
  ICD10Code: string;
  Description?: string;
  IsPrimary: boolean;
  SortOrder: number;
  CreatedDate: string;
}

// The detail embed returns the full pricing-enriched procedure row. Re-use the
// canonical pricing type so RequestDetails and the pricing component agree.
export type { ShareRequestProcedure } from './cptPricing.types';

export interface ShareRequest {
  ShareRequestId: string;
  VendorId: string;
  RequestNumber: string;
  MemberId: string;
  HouseholdId?: string;
  
  // Classification
  RequestTypeId?: string | null;
  RequestTypeName?: string | null;
  SubType?: string | null;

  // Status
  Status: ShareRequestStatus;
  Determination: ShareRequestDetermination;
  
  // Service Details
  DateOfService?: string;
  ServiceDate?: string; // Alias for DateOfService
  DateOfServiceEnd?: string;
  
  // Notes
  NextSteps?: string;
  GeneralNotes?: string;
  EligibilityNotes?: string;
  /** Member-facing closing explanation shown on the member dashboard at terminal status. */
  MemberOutcomeNote?: string | null;

  // Financial Summary
  TotalBilledAmount: number;
  TotalBilled?: number; // Alias for TotalBilledAmount
  TotalDiscounts: number;
  /** @deprecated Legacy computed-total column (never wired up; 0 on all rows).
   *  Retained for old data only — not displayed/edited. Use IncidentUAAmount. */
  TotalUAAmount: number;
  /** @deprecated Raw UA tier the member typed on the public form (e.g. "1500").
   *  Obsolete now that members are in the DB — not displayed. Use IncidentUAAmount. */
  MemberStatedUA?: string | null;
  /** The unshared amount for THIS incident, snapshotted at SR creation from the
   *  member's enrollment so a later plan change can't alter it. Back-office
   *  editable. The single source of truth for UA. (2026-05-30 migration.) */
  IncidentUAAmount?: number | null;
  // ---- Editable form-derived fields (2026-05-28 migration). Auto-populated
  // at SR auto-create from the public form payload; editable by the back
  // office after the fact. The original form submission stays intact as
  // the source of truth for what the member actually wrote.
  ProcedureName?: string | null;
  EventNarrative?: string | null;
  SymptomsBeganDate?: string | null;
  IsNewCondition?: string | null;
  OtherInsurance?: string | null;
  WouldSwitchDoctor?: boolean | null;
  ErCharityCareApplied?: string | null;
  MaternityDeliveryStatus?: string | null;
  SurgeonInNetwork?: boolean | null;
  PatientRelationToPrimary?: string | null;
  /** Patient name captured on the request ("First Last"); returned by sr.* in the detail query. */
  RequestName?: string | null;
  /** Authoritative patient name from the linked form submission's payload (clean
   *  first+last), when the request originated from a form. Null for manual requests. */
  PatientName?: string | null;
  TotalShareAmount: number;
  TotalShared?: number; // Alias for TotalShareAmount
  TotalPaidAmount: number;
  TotalPaid?: number; // Alias for TotalPaidAmount
  TotalMemberPayments: number;
  Balance: number;
  
  // Member Payment
  MemberPaymentMethod?: MemberPaymentMethod;
  MemberPaymentStatus?: string;
  MemberPaymentDate?: string;
  MemberPaymentReference?: string;
  
  // Dates
  SubmittedDate: string;
  IntakeDate?: string;
  ReviewStartDate?: string;
  DeterminationDate?: string;
  CompletedDate?: string;
  
  // Notes
  InternalNotes?: string;
  
  // Member Info (joined)
  MemberFirstName?: string;
  MemberLastName?: string;
  MemberEmail?: string;
  MemberPhone?: string;
  MemberAddress1?: string;
  MemberAddress2?: string;
  MemberCity?: string;
  MemberState?: string;
  MemberZipCode?: string;
  MemberNumber?: string;
  
  // Audit
  CreatedDate: string;
  CreatedBy?: string;
  CreatedByFirstName?: string;
  CreatedByLastName?: string;
  ModifiedDate?: string;
  ModifiedBy?: string;
  ModifiedByFirstName?: string;
  ModifiedByLastName?: string;

  // Claim (soft ownership)
  ClaimedByUserId?: string | null;
  ClaimedAt?: string | null;
  ClaimedByFirstName?: string | null;
  ClaimedByLastName?: string | null;
  ClaimedByColor?: UserColorHex;

  // Counts (for list view)
  BillCount?: number;
  ProviderCount?: number;
}

export type ClaimTab = 'unclaimed' | 'claimed' | 'all';

export interface ClaimerOption {
  userId: string;
  firstName: string;
  lastName: string;
  role: 'VendorAdmin' | 'VendorAgent';
  claimedCount: number;
  preferredColor?: UserColorHex;
}

export interface ClaimResponse {
  shareRequestId: string;
  claimedByUserId: string;
  claimedAt: string;
  claimedByName: string | null;
}

export interface ShareRequestListItem extends ShareRequest {
  BillCount: number;
  ProviderCount: number;
  /** True for an unmatched "shell" SR awaiting a member match (back-office triage). */
  NeedsMemberMatch?: boolean;
  /** Typed submitter name, shown when there's no matched member. */
  RequestName?: string;
}

export interface Provider {
  ProviderId: string;
  VendorId: string;
  ProviderName: string;
  ProviderType?: string;
  NPI?: string;
  TaxId?: string;
  Phone?: string;
  Fax?: string;
  Email?: string;
  Website?: string;
  Address1?: string;
  Address2?: string;
  City?: string;
  State?: string;
  ZipCode?: string;
  Country?: string;
  Notes?: string;
  IsActive: boolean;
  CreatedDate: string;
  CreatedBy?: string;
  ModifiedDate?: string;
  ModifiedBy?: string;
  RequestCount?: number;
}

export interface ShareRequestProvider {
  ShareRequestProviderId: string;
  ShareRequestId: string;
  ProviderId: string;
  ProviderRole?: string;
  Notes?: string;
  CreatedDate: string;
  ProviderName: string;
  ProviderType?: string;
  NPI?: string;
  Phone?: string;
  Email?: string;
  City?: string;
  State?: string;
}

export interface ShareRequestBill {
  BillId: string;
  ShareRequestId: string;
  ProviderId?: string;
  BillNumber?: string;
  BillType: BillType;
  BillDate?: string;
  DateOfService?: string;
  Description?: string;
  
  // Amounts
  BilledAmount: number;
  AllowedAmount?: number;
  DiscountAmount: number;
  UAAmount: number;
  ShareAmount: number;
  PaidAmount: number;
  Balance: number;
  
  // Codes
  CPTCodes?: string[];
  DiagnosisCodes?: string[];
  
  Notes?: string;
  IsActive: boolean;
  CreatedDate: string;
  CreatedBy?: string;
  ModifiedDate?: string;
  ModifiedBy?: string;
  
  // Joined
  ProviderName?: string;
  NPI?: string;
}

export interface ShareRequestTransaction {
  TransactionId: string;
  ShareRequestId: string;
  BillId?: string;
  ProviderId?: string;
  
  TransactionType: TransactionType;
  PaymentType?: PaymentType;
  TransactionStatus: TransactionStatus;
  
  Amount: number;
  TransactionDate: string;
  ReferenceNumber?: string;
  Description?: string;
  Notes?: string;
  
  CreatedDate: string;
  CreatedBy?: string;
  ModifiedDate?: string;
  ModifiedBy?: string;
  
  // Joined
  BillNumber?: string;
  ProviderName?: string;
}

export interface ShareRequestDocument {
  DocumentId: string;
  ShareRequestId: string;
  BillId?: string;
  DocumentName: string;
  DocumentType?: string;
  FileName: string;
  FileSize?: number;
  MimeType?: string;
  BlobUrl?: string;
  BlobPath?: string;
  AuthenticatedUrl?: string;
  Description?: string;
  UploadedBy?: string;
  IsActive: boolean;
  CreatedDate: string;
  CreatedBy?: string;
  CreatedByFirstName?: string;
  CreatedByLastName?: string;
  BillNumber?: string;
}

export interface ShareRequestNote {
  NoteId: string;
  ShareRequestId: string;
  NoteType: 'Note' | 'StatusChange' | 'Communication' | 'SystemActivity';
  Note: string;
  IsInternal: boolean;
  PreviousValue?: string;
  NewValue?: string;
  CreatedDate: string;
  CreatedBy?: string;
  CreatedByName?: string;
  UserFirstName?: string;
  UserLastName?: string;
}

export interface ShareRequestStatusHistory {
  StatusHistoryId: string;
  ShareRequestId: string;
  PreviousStatus?: string;
  NewStatus: string;
  PreviousDetermination?: string;
  NewDetermination?: string;
  Reason?: string;
  CreatedDate: string;
  CreatedBy?: string;
  CreatedByName?: string;
}

export interface ShareRequestDashboardStats {
  statusCounts: Record<ShareRequestStatus, number>;
  totalBills: number;        // Bills only (excludes Estimates)
  totalEstimates: number;    // Estimates only
  totalPayments: number;     // Payments to providers + Reimbursements
  totalUAPayments: number;   // UA Payments + UA Reductions
  totalDiscounts: number;    // All discounts
  totalMemberPayments: number; // Member payments
  totalBalance: number;      // Bills - Discounts - UA - Payments - Member Payments
}

/**
 * Computed finance summary returned by
 * GET /api/me/vendor/share-requests/:id/finance-summary and (as `totals`) by
 * GET /api/me/vendor/members/:id/finance-summary. Computed from source tables
 * and normalized via the backend financeCategory map.
 */
export interface FinanceSummary {
  billed: number;
  estimates: number;
  billPaid: number;
  billBalance: number;
  // Cards
  saved: number;        // discounts + financial aid
  memberPaid: number;   // member out-of-pocket (UA + member payments, cleared)
  reimbursed: number;   // reimbursements paid to member (cleared)
  balance: number;      // outstanding
  // Detail
  discount: number;
  financialAid: number;
  paidToProvider: number;
  uaPaid: number;
  memberPayment: number;
  byCategory: Record<string, { cleared: number; pending: number; total: number; count: number }>;
  transactionCount: number;
  billCount: number;
}

export interface MemberFinanceShareRequest extends FinanceSummary {
  shareRequestId: string;
  requestNumber: string;
  status: ShareRequestStatus;
  determination?: ShareRequestDetermination;
  serviceDate: string | null;
  submittedDate: string | null;
  incidentUA: number;
  uaPaidInFull: boolean;
}

export interface MemberFinanceUAEvent {
  shareRequestId: string;
  requestNumber: string;
  eventDate: string | null;
  inWindow: boolean;
  incidentUA: number;
  uaPaid: number;
  qualifies: boolean;
}

export interface UaAnalysis {
  windowMonths: number;
  windowStart?: string;
  uaPaidInFullCount: number;
  fullyCovered: boolean;
  events: MemberFinanceUAEvent[];
}

export interface MemberFinanceSummary {
  memberId: string;
  shareRequestCount: number;
  totals: FinanceSummary;
  shareRequests: MemberFinanceShareRequest[];
  uaAnalysis: UaAnalysis;
}

export interface FinanceSummaryResponse {
  success: boolean;
  // The per-SR payload also carries the owning member's trailing-window
  // UA-coverage analysis (best-effort; null if it couldn't be computed) so the
  // SR Finances tab can render the same coverage banner the member tab shows.
  data: FinanceSummary & { shareRequestId: string; uaAnalysis?: UaAnalysis | null };
}

export interface MemberFinanceSummaryResponse {
  success: boolean;
  data: MemberFinanceSummary;
}

// API Response types
export interface ShareRequestListResponse {
  success: boolean;
  data: ShareRequestListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ShareRequestDetailResponse {
  success: boolean;
  data: ShareRequest;
}


export interface ProviderListResponse {
  success: boolean;
  data: Provider[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Filter options
export interface ShareRequestFilters {
  page?: number;
  limit?: number;
  status?: ShareRequestStatus;
  determination?: ShareRequestDetermination;
  requestTypeId?: string;
  memberId?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
  dateFrom?: string;
  dateTo?: string;
}

export interface ProviderFilters {
  page?: number;
  limit?: number;
  search?: string;
  providerType?: string;
  isActive?: boolean;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

// Status constants for UI
export const SHARE_REQUEST_STATUSES: ShareRequestStatus[] = [
  'New',
  'Acknowledged',
  'In Review',
  'Awaiting Member Info',
  'Awaiting Authorization',
  'Processing',
  'Completed',
  'Denied',
  'Withdrawn'
];

export const SHARE_REQUEST_DETERMINATIONS: ShareRequestDetermination[] = [
  'Pending',
  'Not Eligible',
  'Eligible',
  'Undetermined'
];

export const BILL_TYPES: BillType[] = ['Bill', 'Estimate'];

export const TRANSACTION_TYPES: TransactionType[] = [
  'Payment to Provider',
  'Member Payment',
  'UA Payment',
  'UA Reduction',
  'Reimbursement',
  'Discount',
  'Financial Aid'
];

/**
 * Human-friendly labels for transaction types. The canonical values above are
 * what's stored (and what financeCategory.js keys off) — these only change the
 * display text so the care team can tell the two member-payment types apart and
 * sees that a reimbursement goes back to the member. Falls back to the raw value
 * for anything not listed (incl. legacy types).
 */
export const TRANSACTION_TYPE_LABELS: Record<string, string> = {
  'UA Payment': 'Member payment — toward UA',
  'Member Payment': 'Member payment — other',
  'Payment to Provider': 'Payment to provider',
  'Reimbursement': 'Reimbursement (to member)',
  'UA Reduction': 'UA reduction',
  'Discount': 'Discount',
  'Financial Aid': 'Financial aid',
};

export const transactionTypeLabel = (t: string): string =>
  TRANSACTION_TYPE_LABELS[t] ?? t;

export const PAYMENT_TYPES: PaymentType[] = [
  'ACH',
  'Credit Card',
  'Benji Card',
  'Check',
  'Debit',
  'Discount'
];

export const TRANSACTION_STATUSES: TransactionStatus[] = [
  'Pending',
  'Cleared',
  'Cancelled'
];

export const MEMBER_PAYMENT_METHODS: MemberPaymentMethod[] = [
  'Check',
  'ACH',
  'Digital Debit Card'
];

// Status color mapping for UI. Ordered roughly by progression: blue tones for
// pre-work, warm tones when blocked on an external party, purple while we're
// actively processing, then green/red/gray for the three terminal outcomes.
export const STATUS_COLORS: Record<ShareRequestStatus, { bg: string; text: string }> = {
  'New':                     { bg: 'bg-blue-100',   text: 'text-blue-800' },
  'Acknowledged':            { bg: 'bg-sky-100',    text: 'text-sky-800' },
  'In Review':               { bg: 'bg-indigo-100', text: 'text-indigo-800' },
  'Awaiting Member Info':    { bg: 'bg-yellow-100', text: 'text-yellow-800' },
  'Awaiting Authorization':  { bg: 'bg-amber-100',  text: 'text-amber-800' },
  'Processing':              { bg: 'bg-purple-100', text: 'text-purple-800' },
  'Completed':               { bg: 'bg-green-100',  text: 'text-green-800' },
  'Denied':                  { bg: 'bg-red-100',    text: 'text-red-800' },
  'Withdrawn':               { bg: 'bg-gray-100',   text: 'text-gray-800' }
};

export const DETERMINATION_COLORS: Record<ShareRequestDetermination, { bg: string; text: string }> = {
  'Pending': { bg: 'bg-gray-100', text: 'text-gray-800' },
  'Not Eligible': { bg: 'bg-red-100', text: 'text-red-800' },
  'Eligible': { bg: 'bg-green-100', text: 'text-green-800' },
  'Undetermined': { bg: 'bg-yellow-100', text: 'text-yellow-800' }
};

// Member Plan (Enrollment) interface
export interface MemberPlan {
  EnrollmentId: string;
  MemberId: string;
  ProductId: string;
  ProductBundleID?: string; // If set, this enrollment is part of a bundle
  EnrollmentStatus: string;
  EffectiveDate: string;
  TerminationDate?: string;
  PremiumAmount?: number;
  PaymentFrequency?: string;
  EnrollmentDetails?: string;
  EnrollmentDate: string;
  HouseholdId: string;
  ProductPricingId?: string;
  
  // Product details
  ProductName: string;
  ProductDescription?: string;
  ProductType?: string;
  ProductImageUrl?: string;
  ProductLogoUrl?: string;
  CoverageDetails?: string;
  Features?: string;
  RequiredDataFields?: string;
  
  // Bundle product details (if this enrollment is part of a bundle)
  BundleProductName?: string;
  BundleProductDescription?: string;
  BundleProductType?: string;
  BundleProductImageUrl?: string;
  BundleProductLogoUrl?: string;
  
  // Vendor details
  VendorId: string;
  VendorName: string;
  
  // Member info
  RelationshipType: string;
  HouseholdMemberID?: string;
  FirstName?: string;
  LastName?: string;
  Email?: string;
  
  // Configuration values from ProductPricing
  ConfigValue1?: string;
  ConfigValue2?: string;
  ConfigValue3?: string;
  ConfigValue4?: string;
  ConfigValue5?: string;
  PricingLabel?: string;
  
  // Processed configuration fields (field name + selected value)
  ConfigurationFields?: {
    fieldName: string;
    fieldOptions: string[];
    selectedValue: string;
  }[];

  // Product documents (PDFs uploaded with the product)
  productDocuments?: {
    productDocumentId?: string;
    documentUrl: string;
    displayName?: string;
    sortOrder?: number;
  }[];
  ProductDocumentUrl?: string | null;
}

// Header plan summary — single resolved plan for ShareRequestHeaderCard
export interface ShareRequestHeaderPlan {
  PlanLabel: string;
  TierType: string | null;
  UAValue: string | null;
  UALabel: string | null;
  EffectiveDate: string | null;
  ProductPricingId: string | null;
}

export interface ShareRequestHeaderPlanResponse {
  success: boolean;
  data: ShareRequestHeaderPlan | null;
}

// ============================================================================
// FINANCIAL APPLICATIONS (FAP)
// ============================================================================

export interface ShareRequestFAP {
  FAPId: string;
  ShareRequestId: string;
  BillId?: string;
  MemberId: string;
  ApplicationType: 'Internal' | 'External';
  ApplicationSource?: string;
  ApplicationNumber?: string;
  Status: 'Draft' | 'Submitted' | 'Pending' | 'Approved' | 'Denied' | 'Applied';
  SubmissionDate?: string;
  DecisionDate?: string;
  AppliedDate?: string;
  AwardAmount?: number;
  AppliedAmount: number;
  RemainingAmount?: number;
  Decision?: 'Approved' | 'Denied' | 'Partial';
  DecisionReason?: string;
  DecisionNotes?: string;
  ApplicationData?: {
    income?: number;
    householdSize?: number;
    [key: string]: any;
  };
  SupportingDocuments?: string[]; // Document IDs
  Notes?: string;
  InternalNotes?: string;
  CreatedDate: string;
  CreatedBy?: string;
  ModifiedDate?: string;
  ModifiedBy?: string;
  // Joined
  BillNumber?: string;
  BillBilledAmount?: number;
  MemberNumber?: string;
  MemberFirstName?: string;
  MemberLastName?: string;
  CreatedByFirstName?: string;
  CreatedByLastName?: string;
}

// ============================================================================
// QUEUES
// ============================================================================

export type QueueType = 
  | 'Pending Review'
  | 'Awaiting Member'
  | 'Awaiting Records'
  | 'UA Pending'
  | 'FAP Submitted' // deprecated 2026-05-30 (SR FAP removed); kept so legacy queue rows still render
  | 'Ready to Pay'
  | 'In Collections'
  | 'Needs Member Reachout';

export interface ShareRequestQueue {
  ShareRequestId: string;
  RequestNumber: string;
  Status: ShareRequestStatus;
  Determination: ShareRequestDetermination;
  SubmittedDate: string;
  TotalBilledAmount: number;
  Balance: number;
  MissingDocuments: boolean;
  MemberFirstName?: string;
  MemberLastName?: string;
  MemberNumber?: string;
  QueueType: QueueType;
  Priority: number;
  AssignedTo?: string;
  AssignedDate?: string;
  QueueCreatedDate: string;
  AssignedToFirstName?: string;
  AssignedToLastName?: string;
  CollectionsCount: number;
  DaysInQueue: number;
}

export interface QueueStats {
  QueueType: QueueType;
  Count: number;
  OldestItemDate: string;
  MaxAgingDays: number;
  AvgAgingDays: number;
}

// ============================================================================
// PAYABLES
// ============================================================================

export type PayableStatus = 'Pending' | 'Approved' | 'Sent' | 'Cleared' | 'Failed';
export type ExportStatus = 'Pending' | 'Exported' | 'Posted' | 'Failed';
export type ExportSystem = 'QBO' | 'BenjiCard' | 'Manual';

export interface ShareRequestPayable {
  PayableId: string;
  ShareRequestId: string;
  BillId?: string;
  TransactionId?: string;
  PayeeType: 'Provider' | 'Member';
  PayeeId: string;
  PayeeName: string;
  PayeeAddress?: any;
  PaymentAmount: number;
  PaymentMethod: 'Check' | 'ACH' | 'Credit Card' | 'Digital Debit Card';
  PaymentReference?: string;
  PaymentDate?: string;
  PostingDate?: string;
  ExportStatus: ExportStatus;
  ExportSystem?: ExportSystem;
  ExportReference?: string;
  ExportDate?: string;
  ExportError?: string;
  Status: PayableStatus;
  ApprovedDate?: string;
  ApprovedBy?: string;
  SentDate?: string;
  ClearedDate?: string;
  Notes?: string;
  InternalNotes?: string;
  CreatedDate: string;
  CreatedBy?: string;
  ModifiedDate?: string;
  ModifiedBy?: string;
}

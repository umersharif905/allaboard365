// frontend/src/types/member.types.ts
/**
 * Comprehensive Member interface matching the oe.Members database table
 * This is the single source of truth for all member data
 */

export interface Member {
  // Core identification fields
  MemberId: string;
  UserId: string;
  GroupId?: string;
  
  // Personal information
  FirstName: string;
  LastName: string;
  Email: string;
  PhoneNumber?: string;
  DateOfBirth?: string;
  Gender?: string;
  SSN?: string;
  /** Last 4 digits only (from API); full SSN is never sent. */
  SSNLast4?: string | null;
  
  // Address information
  Address?: string;
  City?: string;
  State?: string;
  Zip?: string;
  
  // Status and enrollment
  Status: 'Active' | 'Inactive' | 'Terminated' | 'Pending' | 'Suspended' | 'Pending Payment' | 'Declined';
  EnrollmentType?: string;
  
  // Medical and employment
  MedicalInfo?: string;
  HireDate?: string;
  TerminationDate?: string;
  Department?: string;
  JobTitle?: string;
  JobPosition?: string; // Job position ID (e.g., 'c_level', 'president', 'manager', etc.)
  EmployeeId?: string;
  WorkLocation?: string;
  
  // Household and relationships
  HouseholdId?: string;
  HouseholdMemberID?: string;
  SubscriberId?: string;
  MemberSequence?: number;
  PrimaryMemberId?: string;
  RelationshipType?: 'P' | 'S' | 'C'; // Primary, Spouse, Child
  RelationshipDescription?: string;
  
  /** From tenant row; used only for display masking of HouseholdMemberID for individuals. */
  TenantMemberIDPrefix?: string | null;
  /** From tenant row; when set and distinct from TenantMemberIDPrefix, individual (no GroupId) IDs show with this prefix in UI only. */
  TenantIndividualMemberIDPrefix?: string | null;

  // Business context
  TenantId?: string;
  AgentId?: string;
  AgentName?: string; // Computed: Agent's full name
  AgentEmail?: string; // Computed: Agent's email
  AgencyId?: string; // Agency ID
  AgencyName?: string; // Agency name
  GroupAgentId?: string; // Group's assigned agent
  GroupAgentName?: string; // Group agent's full name
  GroupAgentEmail?: string; // Group agent's email
  CreatedBy?: string;
  ModifiedBy?: string;
  
  // Member tier and preferences
  Tier?: string; // EE, ES, EC, EF
  TobaccoUse?: string; // Y, N, U
  SmsConsent?: boolean | number | null;
  
  // Timestamps
  CreatedDate: string;
  ModifiedDate?: string;
  
  // Computed/derived fields (from joins)
  TenantName?: string;
  GroupName?: string;
  /** Group logo URL (when member is in a group). */
  GroupLogoUrl?: string | null;
  PrimaryMemberName?: string;
  TotalEnrollments?: number;
  ActiveEnrollments?: number;
  /** Count of enrollments in PaymentHold (initial payment not completed / orphan hold). Distinct from member-level Pending Payment. */
  PaymentHoldEnrollmentCount?: number;
  MonthlyPremium?: number;
  /** Household employer share (same window as roster premiums; from Contribution rows or product/fee fallback). */
  EmployerContribution?: number;
  /** Household employee share (premium subtotal − EmployerContribution on roster). */
  EmployeeContribution?: number;
  /** Earliest future effective date (enrollments not yet in effect). For "plan goes into effect in X days" indicator. */
  EarliestFutureEffectiveDate?: string | null;
  /** Earliest active effective date (enrollments already in effect). */
  EarliestActiveEffectiveDate?: string | null;
  /** Count of enrollments with future effective date. For "new plans go into effect in X days". */
  FutureEffectiveDateCount?: number;
  /** Login account status (oe.Users.Status). When not 'Active', member cannot log in. */
  UserStatus?: string;
  // Enhanced enrollment status (computed by backend)
  EnrollmentStatus?: 'Enrolled' | 'Pending Login' | 'Pending Approval' | 'Declined Coverage' | 'Terminated' | 'Enrollment Link Sent' | 'Enrollment Link Used' | 'Not Enrolled' | 'Pending Migration';
  EnrollmentStatusColor?: 'success' | 'warning' | 'info' | 'secondary' | 'error' | 'default';
  /** CreatedDate of the active unused enrollment link (when link was generated/sent). */
  EnrollmentLinkSentAt?: string | null;
  
  /** E123 / data migration staging — not yet live billing. */
  IsPendingMigration?: boolean | number;
  DependentCount?: number;

  /** Enrolled plan display names (bundle name for bundles, product name otherwise). For Plans column. */
  EnrolledPlanNames?: string[];
  
  // Billing type (computed by backend: 'LB' for group billing, 'SB' for single billing)
  BillType?: 'LB' | 'SB';
}

// Utility types for different views
export type MemberSummary = Pick<Member, 'MemberId' | 'FirstName' | 'LastName' | 'Email' | 'Status' | 'RelationshipType'>;

export type MemberEnrollment = Pick<Member, 'MemberId' | 'FirstName' | 'LastName' | 'Email' | 'Status'> & {
  // Enrollment-specific fields
};

export type MemberHousehold = Pick<Member, 'MemberId' | 'FirstName' | 'LastName' | 'RelationshipType' | 'HouseholdId'>;

export type MemberBasic = Pick<Member, 'MemberId' | 'FirstName' | 'LastName' | 'Email' | 'PhoneNumber' | 'Status'>;

// Create member data (for forms)
export interface CreateMemberData {
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber?: string;
  dateOfBirth?: string;
  gender?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  relationshipType: 'P' | 'S' | 'C';
  householdId?: string;
  primaryMemberId?: string; // Added for dependent members
  // New fields
  hireDate?: string;
  department?: string;
  jobPosition?: string; // Job position ID
  workLocation?: string;
  tier?: string; // EE, ES, EC, EF
  tobaccoUse?: string; // Y, N, U
  metadata?: Record<string, any>; // Keep for backward compatibility
}

// Update member data (for forms)
export interface UpdateMemberData extends Partial<CreateMemberData> {
  memberId: string;
}

/** API rows may use PascalCase, camelCase, or lowercase for this field. */
export function resolveHouseholdMemberId(m: Record<string, unknown> | Partial<Member>): string | undefined {
  const candidates = [
    (m as Member).HouseholdMemberID,
    (m as Record<string, unknown>).householdMemberId,
    (m as Record<string, unknown>).householdmemberid,
    (m as Record<string, unknown>).HouseholdMemberId,
  ];
  for (const v of candidates) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

/**
 * Per-product ID card / eligibility: when set, if stored household ID starts with tenant
 * MemberIDPrefix or (when distinct) IndividualMemberIDPrefix, replace that prefix with the mask.
 */
export function applyProductMemberIdPrefixMask(
  storedId: string | undefined,
  tenantMemberIdPrefix: string | null | undefined,
  productMaskPrefix: string | null | undefined,
  tenantIndividualMemberIdPrefix?: string | null | undefined
): string | undefined {
  if (storedId == null || String(storedId).trim() === '') return storedId;
  const s = String(storedId).trim();
  const mask = productMaskPrefix != null ? String(productMaskPrefix).trim() : '';
  if (!mask) return s;

  const replaceIfPrefix = (rawPrefix: string | null | undefined): string | null => {
    const p = rawPrefix != null ? String(rawPrefix).trim() : '';
    if (!p) return null;
    if (s.length >= p.length && s.slice(0, p.length).toUpperCase() === p.toUpperCase()) {
      return mask + s.slice(p.length);
    }
    return null;
  };

  const main = replaceIfPrefix(tenantMemberIdPrefix);
  if (main != null) return main;

  const ind =
    tenantIndividualMemberIdPrefix != null ? String(tenantIndividualMemberIdPrefix).trim() : '';
  const mainP = tenantMemberIdPrefix != null ? String(tenantMemberIdPrefix).trim() : '';
  if (ind && ind.toUpperCase() !== mainP.toUpperCase()) {
    const second = replaceIfPrefix(ind);
    if (second != null) return second;
  }

  return s;
}

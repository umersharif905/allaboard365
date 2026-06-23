import type { ApiResponse } from '../types/api.types';
import type { Member } from '../types/member.types';
import { apiService } from './api.service';

// Define ContributionRule type
export interface ContributionRule {
  contributionId: string;
  groupId: string;
  /** Single product (legacy); when productIds has one element it is mirrored here */
  productId?: string;
  /** Multiple products this rule applies to; takes precedence over productId when present */
  productIds?: string[];
  productName?: string;
  name: string;
  description?: string;
  contributionType: 'flat_rate' | 'percentage' | 'tier_based' | 'age_based' | 'tenure_based' | 'override' | 'minimum_threshold';
  contributionDirection?: 'Employer' | 'MaxEmployee'; // NEW: Direction of contribution
  
  // Basic amounts
  flatRateAmount?: number;
  percentageAmount?: number;
  
  /** When contributionType is percentage: null = % of actual premium; EE/ES/EC/EF = % of that tier's equivalent premium for everyone */
  equivalentTier?: 'EE' | 'ES' | 'EC' | 'EF' | null;
  
  // Tier-based contributions
  tierContributions?: {
    employee_only?: number;
    employee_spouse?: number;
    employee_children?: number;
    family?: number;
  };
  
  // Age-based contributions
  ageRules?: Array<{
    minAge: number;
    maxAge?: number;
    contributionAmount: number;
    contributionType: 'flat' | 'percentage';
  }>;
  
  // Tenure-based contributions
  tenureRules?: Array<{
    minYears: number;
    contributionAmount: number;
  }>;
  
  // Minimum threshold
  minimumAmount?: number;
  
  // Job position filter (optional - applies to all if empty/null)
  jobPositions?: string[] | null;
  
  // Rule settings
  priority: number;
  stacking: boolean;
  appliesTo?: {
    employmentClass?: string[];
    coverageTier?: string[];
    planType?: string[];
  };
  
  effectiveDate: string;
  endDate?: string;
  status: 'Active' | 'Inactive' | 'Pending';
  createdDate: string;
}

export interface ApplyToExistingPreviewMember {
  memberId: string;
  memberName: string;
  /** Tobacco status: Yes, No, or Unknown (affects EE equivalent and employer contribution). */
  tobaccoUse?: string;
  totalPremium: number;
  /** Product premium + system fee + processing fee (base used for contribution rules) */
  totalPremiumIncludingFees?: number;
  currentEmployerContribution: number;
  currentEmployeeContribution: number;
  newEmployerContribution: number;
  newEmployeeContribution: number;
  isUpdate: boolean;
  /** True when member has no contribution enrollments but the rule does not apply (e.g. job position, age filter). */
  ruleDoesNotApply?: boolean;
  corrections?: Array<{
    contributionId: string;
    ruleName: string;
    currentAmount: number;
    newAmount: number;
  }>;
}

export interface Product {
  ProductId: string;
  Name: string;
  ProductType: string;
}

// Using the same GroupDetails interface from the component for consistency
export interface Group {
    GroupId: string;
    Name: string;
    TaxIdNumber?: string;
    Status: 'Active' | 'Inactive' | 'Pending' | 'Archived';
    AdminName?: string;
    AdminEmail?: string;
    AdminPhone?: string;
    BillingType?: 'Monthly' | 'Quarterly' | 'Annual';
    TotalMembers: number;
    ActiveEnrollments: number;
    MonthlyPremium: number;
    CreatedDate: string;
    ModifiedDate?: string;
    TenantId: string;
    Address?: string;
    City?: string;
    State?: string;
    Zip?: string;
    ContactTitle?: string;
    PrimaryContact: string;
    ContactEmail?: string;
    ContactPhone?: string;
    TenantName?: string;
    Address2?: string;
    ContactPhone2?: string;
    FaxNumber?: string;
    Website?: string;
    BusinessType?: string;
    CreditCardNumber?: string;
    CreditCardType?: string;
    CreditCardExpiry?: string;
    CreditCardName?: string;

    ACHBankName?: string;
    ACHAccountType?: string;
    ACHRoutingNumber?: string;
    ACHAccountNumber?: string;
    ACHAccountName?: string;
    LogoUrl?: string;
    DocumentsFolder?: string;
    AgentName?: string;
    AgentCode?: string | null;
    AgentId?: string;
    AgentUserId?: string;
    MinimumHirePeriod?: number;
    AllowPlanModifications?: boolean;
    AllowMidMonthEffective?: boolean;
    ShowEmployeePricingOnTiles?: boolean;
    ShowContributionStrategy?: boolean;
    PayrollPeriod?: 'Monthly' | 'Bi-Monthly' | 'Bi-Weekly' | 'Weekly';
    // Onboarding status fields
    OnboardingStatus?: 'Pending Onboarding' | 'Onboarding Complete' | 'Onboarding Expired' | 'No Onboarding Link';
    // Enrollment effective date fields
    EarliestFutureEffectiveDate?: string | null;
    EarliestActiveEffectiveDate?: string | null;
    FutureEffectiveDateCount?: number;
    OnboardingLinkCreated?: string;
    OnboardingLinkExpires?: string;
    OnboardingCompleted?: string;
    GroupType?: 'Standard' | 'ListBill';
    AllAboardMasterGroupId?: string | null;
    IsE123Migrated?: boolean;
    IsPendingMigration?: boolean;
    PendingMigrationMemberCount?: number;
}

/** Response payload from GET /api/groups/:id/termination-preview */
export interface GroupTerminationPreviewData {
    canTerminate: boolean;
    enrollmentsMissingTerminationDate: number;
    householdsWithFutureTermination: Array<{
        householdId: string;
        primaryMemberName: string;
        latestTerminationDate: string | null;
    }>;
    recurringPayments: Array<{
        scheduleId: string;
        locationName: string;
        monthlyAmount: number;
        nextBillingDate: string | null;
        processor: string;
    }>;
}

/** A single member entry returned by /api/groups/:id/release-unenrolled-preview */
export interface GroupReleaseMember {
    memberId: string;
    userId: string | null;
    firstName: string;
    lastName: string;
    email: string;
    /** 'P' = primary, 'S' = spouse, 'C' = child, etc. */
    relationshipType: string | null;
    memberStatus: string | null;
    householdId: string | null;
    /** Count of enrollments currently in their active window (Status='Active' AND today within Effective..Termination). */
    activeEnrollmentCount: number;
    /** Count of all Status='Active' enrollments regardless of window. */
    totalActiveStatusEnrollments: number;
    /** Count of active-status enrollments that have NO TerminationDate set. */
    enrollmentsMissingTerminationDate: number;
    /** ISO of the latest TerminationDate across active-status enrollments, or null. */
    latestTerminationDate: string | null;
}

/** A household entry — a primary member plus their dependents — that is the unit of release. */
export interface GroupReleaseHousehold {
    /** Stable key for React/UI. Equals HouseholdId, or `member:<memberId>` for solo members with NULL HouseholdId. */
    householdKey: string;
    /** Real HouseholdId, or null for solo members. */
    householdId: string | null;
    primary: GroupReleaseMember | null;
    dependents: GroupReleaseMember[];
    /** All member ids in this household (primary + dependents). */
    memberIds: string[];
    memberCount: number;
    /** Latest active-status TerminationDate across all members in the household, or null. */
    latestTerminationDate: string | null;
    /** Present only on notReleasableHouseholds: human-readable reason the household is still enrolled. */
    reason?: string;
}

/** Response payload from GET /api/groups/:id/release-unenrolled-preview */
export interface GroupReleaseUnenrolledPreviewData {
    groupId: string;
    groupName: string;
    releasableHouseholds: GroupReleaseHousehold[];
    notReleasableHouseholds: GroupReleaseHousehold[];
    summary: {
        totalMembers: number;
        totalHouseholds: number;
        releasableHouseholdCount: number;
        notReleasableHouseholdCount: number;
        releasableMemberCount: number;
        notReleasableMemberCount: number;
    };
}

// Billing-related interfaces
export interface Invoice {
  InvoiceId: string;
  GroupId: string;
  InvoiceNumber: string;
  InvoiceDate: string;
  DueDate: string;
  BillingPeriodStart: string;
  BillingPeriodEnd: string;
  TotalAmount: number;
  PaidAmount: number;
  Status: 'Paid' | 'Unpaid' | 'Overdue' | 'Partial';
  PaymentDate?: string;
  PaymentMethod?: string;
  PdfUrl?: string;
  LineItems?: InvoiceLineItem[];
}

export interface InvoiceLineItem {
  Description: string;
  Quantity: number;
  UnitPrice: number;
  Amount: number;
}

export interface Payment {
  PaymentId: string;
  GroupId: string;
  InvoiceId?: string;
  PaymentDate: string;
  Amount: number;
  PaymentMethod: string;
  TransactionId: string;
  Status: 'Completed' | 'Pending' | 'Failed';
  ProcessorResponse?: string;
}

export interface PaymentMethod {
  PaymentMethodId: string;
  GroupId: string;
  Type: 'ACH' | 'CreditCard';
  Last4: string;
  BankName?: string;
  CardBrand?: string;
  ExpiryMonth?: number;
  ExpiryYear?: number;
  IsDefault: boolean;
  CreatedDate: string;
  Status: 'Active' | 'Inactive';
}

export interface BillingDetails {
  BillingType: 'SingleBill' | 'ListBill';
  BillingFrequency: 'Monthly' | 'Quarterly' | 'Annual';
  NextBillingDate: string;
  CurrentBalance: number;
  TotalPaidYTD: number;
  AutoPay: boolean;
  PaymentTerms: number; // Days
}

export interface ScheduledPayment {
  scheduleId: string;
  locationId?: string;
  locationName: string;
  nextBillingDate: string;
  monthlyAmount: number;
  isActive?: boolean;
  cancelledDate?: string | null;
  processor?: string;
}

export interface BillingData {
  billingDetails: BillingDetails;
  invoices: Invoice[];
  payments: Payment[];
  paymentMethod: PaymentMethod | null;
  scheduledPayments?: ScheduledPayment[];
}

export interface MonthlyBillSummary {
  lastMonthBill: {
    amount: number;
    paymentDate: string;
    billingPeriodStart: string;
    billingPeriodEnd: string;
  } | null;
  nextMonthBill: {
    scheduledAmount: number;
    billingDate: string;
    lastUpdated: string;
  } | null;
}

export interface EstimatedInvoiceLocation {
  locationId: string;
  locationName: string;
  isPrimary: boolean;
  basePremium: number;
  basePremiumNonProfit?: number;
  basePremiumForProfit?: number;
  systemFees: number;
  paymentProcessingFee: number; // Payment processing fee (separate from system fees)
  processingFees: number; // Total of systemFees + paymentProcessingFee (for backward compatibility)
  setupFees: number;
  totalAmount: number;
  householdCount: number;
  memberCount: number;
}

export interface ProcessingFeeByProductLine {
  productId: string | null;
  productName: string;
  amount: number;
}

export interface EstimatedInvoiceData {
  estimatedMonth: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  totalAmount: number;
  premiumNonProfitTotal?: number;
  premiumForProfitTotal?: number;
  totalFees?: number;
  processingFeeByProduct?: ProcessingFeeByProductLine[];
  systemFeesTotal?: number;
  setupFeesTotal?: number;
  locations: EstimatedInvoiceLocation[];
  /** True when this group has zero non-terminated members (e.g. duplicate shell group). */
  noActiveMembers?: boolean;
}

export interface PaymentMethodFormData {
  type: 'ACH' | 'CreditCard';
  billingAddress: string;
  billingCity: string;
  billingState: string;
  billingZip: string;
  bankName?: string;
  accountType?: string;
  accountHolderName?: string;
  routingNumber?: string;
  accountNumber?: string;
  cardNumber?: string;
  expiryMonth?: number;
  expiryYear?: number;
  cvv?: string;
  cardholderName?: string;
}

// Document-related interfaces
export interface Document {
  DocumentId: string;
  GroupId: string;
  FileName: string;
  FileType: string;
  FileSize: number;
  DocumentType: 'W-9' | 'ParticipationAgreement' | 'PayrollFile' | 'OnboardingDocs' | 'Other';
  Description?: string;
  UploadedDate: string;
  UploadedBy: string;
  UploadedByName: string;
  Url: string;
  Status: 'Active' | 'Archived';
  StoredFileName?: string;
  ContainerName?: string;
}

export interface DocumentUploadResponse {
  success: boolean;
  data?: {
    url: string;
    storedFileName: string;
    containerName: string;
  }[];
  message?: string;
  url?: string;
  filename?: string;
}

export interface DocumentMetadata {
  fileName: string;
  fileType: string;
  fileSize: number;
  documentType: string;
  description: string;
  url: string;
  storedFileName: string;
  containerName: string;
}

export interface GroupMembersQueryParams {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  locationFilter?: string;
  showTerminated?: boolean;
  /** When false/omitted, API excludes oe.Members.Status = Inactive (soft-removed roster rows). */
  showInactive?: boolean;
  search?: string;
  enrollmentStatusFilter?: string;
}

export interface EnrollmentSummary {
  totalPremium: number;
  enrolledHouseholdsCount: number;
  futureEffectiveHouseholdsCount: number;
  totalHouseholdsCount: number;
}

export interface GroupMembersResponse {
  members: Member[];
  statusCounts: Record<string, number>;
  enrollmentSummary?: EnrollmentSummary;
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
}

export interface MembersReportDefaultPeriod {
  reportYear: number;
  reportMonth: number;
  source: 'current' | 'future';
}

export class GroupsService {
    /**
     * Fetches a group by its ID. Used by SysAdmin and TenantAdmin.
     * @param groupId The ID of the group to fetch.
     */
    static async getGroupById(groupId: string): Promise<ApiResponse<Group>> {
        console.log(`[GroupsService] Calling getGroupById for group: ${groupId}`);
        const response = await apiService.get<ApiResponse<Group>>(`/api/groups/${groupId}`);
        console.log(`[GroupsService] getGroupById response:`, response);
        return response;
    }

    /**
     * Fetches the assigned group for the currently logged-in GroupAdmin.
     */
    static async getMyGroupAdminGroup(): Promise<ApiResponse<Group>> {
        console.log('[GroupsService] Getting current group admin group. Auth token:', 
            localStorage.getItem('accessToken') ? 'Present' : 'Missing',
            'Roles:', localStorage.getItem('roles'),
            'UserId:', localStorage.getItem('userId'));
        return apiService.get('/api/me/group-admin/group');
    }

    /**
     * Fetches group details for the currently logged-in Agent.
     * @param groupId The ID of the group to fetch.
     */
    static async getAgentGroup(groupId: string): Promise<ApiResponse<Group>> {
        return apiService.get(`/api/me/agent/groups/${groupId}`);
    }

    /**
     * Updates a group's details.
     * @param groupId The ID of the group to update.
     * @param groupData The data to update.
     */
    static async updateGroup(groupId: string, groupData: Partial<Group>): Promise<ApiResponse<Group>> {
        // Map PascalCase fields to lowercase for backend compatibility
        const mappedData: any = {};
        
        Object.keys(groupData).forEach(key => {
            if (key === 'MinimumHirePeriod') {
                mappedData.minimumHirePeriod = (groupData as any)[key];
            } else if (key === 'AllowPlanModifications') {
                mappedData.allowPlanModifications = (groupData as any)[key];
            } else if (key === 'AllowMidMonthEffective') {
                mappedData.allowMidMonthEffective = (groupData as any)[key];
            } else if (key === 'ShowEmployeePricingOnTiles') {
                mappedData.showEmployeePricingOnTiles = (groupData as any)[key];
            } else if (key === 'ShowContributionStrategy') {
                mappedData.showContributionStrategy = (groupData as any)[key];
            } else if (key === 'PayrollPeriod') {
                mappedData.payrollPeriod = (groupData as any)[key];
            } else {
                mappedData[key] = (groupData as any)[key];
            }
        });
        
        return apiService.put(`/api/groups/${groupId}`, mappedData);
    }

    /**
     * Soft-delete (archive) a group. Only allowed when the group has no active enrollments.
     * Used by Agent, TenantAdmin, SysAdmin.
     * @param groupId The ID of the group to delete.
     */
    static async deleteGroup(groupId: string): Promise<ApiResponse<{ message: string }>> {
        return apiService.delete<ApiResponse<{ message: string }>>(`/api/groups/${groupId}`);
    }

    /** Set group Status from Archived back to Active (unterminate / restore) */
    static async restoreGroup(groupId: string): Promise<ApiResponse<{ message: string }>> {
        return apiService.post<ApiResponse<{ message: string }>>(`/api/groups/${groupId}/restore`, {});
    }

    /** Pre-terminate checklist: enrollments, future household term dates, active DIME recurring schedules */
    static async getGroupTerminationPreview(
        groupId: string
    ): Promise<ApiResponse<GroupTerminationPreviewData>> {
        return apiService.get<ApiResponse<GroupTerminationPreviewData>>(
            `/api/groups/${groupId}/termination-preview`
        );
    }

    /** Preview which members in a group can be released (have no currently active enrollments). */
    static async getReleaseUnenrolledPreview(
        groupId: string
    ): Promise<ApiResponse<GroupReleaseUnenrolledPreviewData>> {
        return apiService.get<ApiResponse<GroupReleaseUnenrolledPreviewData>>(
            `/api/groups/${groupId}/release-unenrolled-preview`
        );
    }

    /**
     * Release the selected members from a group (set Members.GroupId = NULL).
     * Server re-validates that each selected member has no currently active enrollment.
     */
    static async releaseUnenrolledMembers(
        groupId: string,
        memberIds: string[]
    ): Promise<ApiResponse<{ releasedCount: number; skippedCount: number; releasedMemberIds: string[] }>> {
        return apiService.post<ApiResponse<{ releasedCount: number; skippedCount: number; releasedMemberIds: string[] }>>(
            `/api/groups/${groupId}/release-unenrolled`,
            { memberIds }
        );
    }

    /**
     * Uploads a logo for a group.
     * @param groupId The ID of the group.
     * @param logoFile The logo file to upload.
     */
    static async uploadGroupLogo(groupId: string, logoFile: File): Promise<ApiResponse<{ url: string }>> {
        const formData = new FormData();
        formData.append('files', logoFile);
        formData.append('uploadType', 'logos');
        formData.append('entityId', groupId);
        return apiService.post('/api/uploads', formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
        });
    }

    /**
     * Fetches the assigned agent for a specific group.
     * @param groupId The ID of the group.
     */
    static async getGroupAgent(groupId: string): Promise<ApiResponse<any>> {
        try {
            return await apiService.get<ApiResponse<any>>(`/api/groups/${groupId}/agent`);
        } catch (error) {
            console.error(`Error fetching agent for group ${groupId}:`, error);
            return { success: false, data: null, message: `Failed to fetch agent for group ${groupId}` };
        }
    }

    /**
     * Fetches all members for a specific group with server-side pagination and sorting.
     * @param groupId The ID of the group.
     * @param params Pagination and sorting parameters
     */
    static async getGroupMembers(
        groupId: string, 
        params?: GroupMembersQueryParams
    ): Promise<ApiResponse<GroupMembersResponse>> {
        try {
            const queryParams = new URLSearchParams();
            if (params?.page) queryParams.append('page', params.page.toString());
            if (params?.pageSize) queryParams.append('pageSize', params.pageSize.toString());
            if (params?.sortBy) queryParams.append('sortBy', params.sortBy);
            if (params?.sortOrder) queryParams.append('sortOrder', params.sortOrder);
            if (params?.locationFilter) queryParams.append('locationFilter', params.locationFilter);
            if (params?.showTerminated !== undefined) queryParams.append('showTerminated', params.showTerminated.toString());
            if (params?.showInactive !== undefined) queryParams.append('showInactive', params.showInactive.toString());
            if (params?.search && params.search.trim()) queryParams.append('search', params.search.trim());
            if (params?.enrollmentStatusFilter && params.enrollmentStatusFilter !== 'all') queryParams.append('enrollmentStatusFilter', params.enrollmentStatusFilter);
            
            const queryString = queryParams.toString();
            const url = `/api/groups/${groupId}/members${queryString ? `?${queryString}` : ''}`;
            
            return await apiService.get<ApiResponse<GroupMembersResponse>>(url);
        } catch (error) {
            console.error(`Error fetching members for group ${groupId}:`, error);
            return { 
                success: false, 
                data: { members: [], statusCounts: {}, enrollmentSummary: { totalPremium: 0, enrolledHouseholdsCount: 0, futureEffectiveHouseholdsCount: 0, totalHouseholdsCount: 0 }, pagination: { page: 1, pageSize: 10, totalCount: 0, totalPages: 0 } }, 
                message: `Failed to fetch members for group ${groupId}` 
            };
        }
    }

    /**
     * Creates a new member in a specific group.
     * @param groupId The ID of the group.
     * @param memberData The member data to create.
     */
    static async createGroupMember(groupId: string, memberData: any): Promise<ApiResponse<any>> {
        try {
            // Add groupId to the member data
            const requestData = {
                ...memberData,
                groupId
            };
            return await apiService.post<ApiResponse<any>>('/api/members', requestData);
        } catch (error) {
            console.error(`Error creating member for group ${groupId}:`, error);
            return { success: false, data: null, message: `Failed to create member for group ${groupId}` };
        }
    }

    /**
     * Updates an existing member.
     * @param memberId The ID of the member to update.
     * @param memberData The member data to update.
     */
    static async updateGroupMember(memberId: string, memberData: any): Promise<ApiResponse<any>> {
        try {
            return await apiService.put<ApiResponse<any>>(`/api/members/${memberId}`, memberData);
        } catch (error) {
            console.error(`Error updating member ${memberId}:`, error);
            return { success: false, data: null, message: `Failed to update member ${memberId}` };
        }
    }

    /**
     * Terminates a member by setting their status to 'Terminated'.
     * @param memberId The ID of the member to terminate.
     */
    static async terminateGroupMember(memberId: string): Promise<ApiResponse<any>> {
        try {
            return await apiService.put<ApiResponse<any>>(`/api/members/${memberId}`, { status: 'Terminated' });
        } catch (error) {
            console.error(`Error terminating member ${memberId}:`, error);
            return { success: false, data: null, message: `Failed to terminate member ${memberId}` };
        }
    }

    /**
     * Fetches all contribution rules for a specific group.
     * @param groupId The ID of the group.
     */
    static async getGroupContributions(groupId: string): Promise<ApiResponse<ContributionRule[]>> {
        try {
            const response = await apiService.get<ApiResponse<any>>(`/api/groups/${groupId}/contributions`);
            
            if (response.success) {
                // Handle different possible response structures
                let rulesData: any[] = [];
                if (Array.isArray(response.data)) {
                    rulesData = response.data;
                } else if (response.data && Array.isArray(response.data.contributions)) {
                    rulesData = response.data.contributions;
                } else if (response.data && Array.isArray(response.data.rules)) {
                    rulesData = response.data.rules;
                } else if (response.data && Array.isArray(response.data.contributionRules)) {
                    rulesData = response.data.contributionRules;
                }
                
                // Map backend PascalCase to frontend camelCase
                const mappedRules = rulesData.map((rule: any) => ({
                    contributionId: rule.ContributionId,
                    groupId: rule.GroupId,
                    productId: rule.productId ?? rule.ProductId,
                    productIds: rule.productIds ?? (rule.ProductIds ? (typeof rule.ProductIds === 'string' ? JSON.parse(rule.ProductIds) : rule.ProductIds) : undefined),
                    productName: rule.ProductName,
                    name: rule.Name,
                    description: rule.Description,
                    contributionType: rule.ContributionType,
                    flatRateAmount: rule.FlatRateAmount,
                    percentageAmount: rule.PercentageAmount,
                    equivalentTier: rule.equivalentTier ?? rule.EquivalentTier ?? null,
                    tierContributions: rule.tierContributions,
                    roleContributions: rule.roleContributions,
                    tenureRules: rule.tenureRules,
                    ageRules: rule.ageRules,
                    jobPositions: rule.jobPositions,
                    divisionRules: rule.divisionRules,
                    overrideType: rule.OverrideType,
                    overrideAmount: rule.OverrideAmount,
                    minimumAmount: rule.MinimumAmount,
                    priority: rule.Priority,
                    stacking: rule.Stacking,
                    appliesTo: rule.appliesTo,
                    // Parse calendar dates correctly to avoid timezone conversion issues
                    // Server returns UTC dates like "2025-11-05T00:00:00Z" - parse date parts separately
                    effectiveDate: rule.EffectiveDate ? (() => {
                        const dateStr = rule.EffectiveDate;
                        if (dateStr.includes('T')) {
                            const [datePart] = dateStr.split('T');
                            return datePart; // Return YYYY-MM-DD format
                        }
                        return dateStr; // Already in YYYY-MM-DD format
                    })() : '',
                    endDate: rule.EndDate ? (() => {
                        const dateStr = rule.EndDate;
                        if (dateStr.includes('T')) {
                            const [datePart] = dateStr.split('T');
                            return datePart; // Return YYYY-MM-DD format
                        }
                        return dateStr; // Already in YYYY-MM-DD format
                    })() : undefined,
                    status: rule.Status,
                    createdDate: rule.CreatedDate
                }));

                return { success: true, data: mappedRules };
            }
            
            return response;
        } catch (error) {
            console.error(`Error fetching contributions for group ${groupId}:`, error);
            return { success: false, data: [], message: `Failed to fetch contributions for group ${groupId}` };
        }
    }

    /**
     * Fetches all products for a specific group.
     * @param groupId The ID of the group.
     */
    static async getGroupProducts(groupId: string): Promise<ApiResponse<Product[]>> {
        try {
            const response = await apiService.get<ApiResponse<any>>(`/api/groups/${groupId}/products`);
            
            if (response.success) {
                // Handle different possible response structures
                let productsData: any[] = [];
                if (Array.isArray(response.data)) {
                    productsData = response.data;
                } else if (response.data && Array.isArray(response.data.groupProducts)) {
                    // Use groupProducts - these are products assigned to this specific group
                    productsData = response.data.groupProducts;
                } else if (response.data && Array.isArray(response.data.products)) {
                    productsData = response.data.products;
                } else if (response.data && Array.isArray(response.data.assignedProducts)) {
                    productsData = response.data.assignedProducts;
                } else if (response.data && Array.isArray(response.data.availableProducts)) {
                    // Fallback to availableProducts if groupProducts not found
                    productsData = response.data.availableProducts;
                }
                
                return { success: true, data: productsData };
            }
            
            return response;
        } catch (error) {
            console.error(`Error fetching products for group ${groupId}:`, error);
            return { success: false, data: [], message: `Failed to fetch products for group ${groupId}` };
        }
    }

    /**
     * Creates a new contribution rule for a specific group.
     * @param groupId The ID of the group.
     * @param contributionData The contribution data to create.
     */
    static async createGroupContribution(groupId: string, contributionData: Partial<ContributionRule>): Promise<ApiResponse<ContributionRule>> {
        try {
            const response = await apiService.post<ApiResponse<ContributionRule>>(`/api/groups/${groupId}/contributions`, contributionData);
            return response;
        } catch (error) {
            console.error(`Error creating contribution for group ${groupId}:`, error);
            return { success: false, data: {} as ContributionRule, message: `Failed to create contribution for group ${groupId}` };
        }
    }

    /**
     * Updates an existing contribution rule.
     * @param groupId The ID of the group.
     * @param contributionId The ID of the contribution to update.
     * @param contributionData The contribution data to update.
     */
    static async updateGroupContribution(groupId: string, contributionId: string, contributionData: Partial<ContributionRule>): Promise<ApiResponse<ContributionRule>> {
        try {
            const response = await apiService.put<ApiResponse<ContributionRule>>(`/api/groups/${groupId}/contributions/${contributionId}`, contributionData);
            return response;
        } catch (error) {
            console.error(`Error updating contribution ${contributionId}:`, error);
            return { success: false, data: {} as ContributionRule, message: `Failed to update contribution ${contributionId}` };
        }
    }

    /**
     * Deletes a contribution rule.
     * @param groupId The ID of the group.
     * @param contributionId The ID of the contribution to delete.
     */
    static async deleteGroupContribution(groupId: string, contributionId: string): Promise<ApiResponse<any>> {
        try {
            return await apiService.delete<ApiResponse<any>>(`/api/groups/${groupId}/contributions/${contributionId}`);
        } catch (error) {
            console.error(`Error deleting contribution ${contributionId}:`, error);
            return { success: false, data: null, message: `Failed to delete contribution ${contributionId}` };
        }
    }

    /**
     * Preview which members would get contribution rules applied (enrolled but missing or incorrect contribution enrollments).
     */
    static async getApplyContributionsToExistingPreview(groupId: string): Promise<ApiResponse<{ members: ApplyToExistingPreviewMember[]; ruleContributionIds: string[] }>> {
        try {
            const response = await apiService.get<ApiResponse<{ members: ApplyToExistingPreviewMember[]; ruleContributionIds: string[] }>>(
                `/api/groups/${groupId}/contributions/apply-to-existing/preview`
            );
            return response;
        } catch (error) {
            console.error(`Error previewing apply contributions to existing for group ${groupId}:`, error);
            return { success: false, data: { members: [], ruleContributionIds: [] }, message: (error as Error)?.message };
        }
    }

    /**
     * Apply contribution enrollments to existing members (create or update oe.Enrollments).
     * @param memberIds Optional; if omitted, applies to all members that need it.
     */
    static async applyContributionsToExisting(groupId: string, memberIds?: string[]): Promise<ApiResponse<{ created: number; updated: number; errors?: Array<{ memberId: string; memberName: string; message: string }> }>> {
        try {
            const response = await apiService.post<ApiResponse<{ created: number; updated: number; errors?: Array<{ memberId: string; memberName: string; message: string }> }>>(
                `/api/groups/${groupId}/contributions/apply-to-existing`,
                { memberIds }
            );
            return response;
        } catch (error) {
            console.error(`Error applying contributions to existing for group ${groupId}:`, error);
            return { success: false, data: { created: 0, updated: 0 }, message: (error as Error)?.message };
        }
    }

    /**
     * Fetches billing data for a specific group.
     * @param groupId The ID of the group.
     * @param options Optional query parameters for filtering and pagination
     */
    static async getGroupBillingData(
        groupId: string, 
        options?: {
            invoiceLocationId?: string;
            paymentLocationId?: string;
            paymentStatus?: string;
            invoicePage?: number;
            invoiceLimit?: number;
            paymentPage?: number;
            paymentLimit?: number;
        }
    ): Promise<ApiResponse<BillingData>> {
        try {
            const queryParams = new URLSearchParams();
            if (options?.invoiceLocationId) queryParams.append('invoiceLocationId', options.invoiceLocationId);
            if (options?.paymentLocationId) queryParams.append('paymentLocationId', options.paymentLocationId);
            if (options?.paymentStatus) queryParams.append('paymentStatus', options.paymentStatus);
            if (options?.invoicePage) queryParams.append('invoicePage', options.invoicePage.toString());
            if (options?.invoiceLimit) queryParams.append('invoiceLimit', options.invoiceLimit.toString());
            if (options?.paymentPage) queryParams.append('paymentPage', options.paymentPage.toString());
            if (options?.paymentLimit) queryParams.append('paymentLimit', options.paymentLimit.toString());
            
            const queryString = queryParams.toString();
            const url = `/api/groups/${groupId}/billing${queryString ? `?${queryString}` : ''}`;
            const response = await apiService.get<ApiResponse<BillingData>>(url);
            
            if (response.success) {
                return response;
            }
            
            // If the endpoint is not implemented yet (404), return mock data
            const errorResponse = response as any;
            if (errorResponse.status === 404) {
                const mockData: BillingData = {
                    billingDetails: {
                        BillingType: 'SingleBill',
                        BillingFrequency: 'Monthly',
                        NextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                        CurrentBalance: 0,
                        TotalPaidYTD: 0,
                        AutoPay: false,
                        PaymentTerms: 30,
                    },
                    invoices: [],
                    payments: [],
                    paymentMethod: null
                };
                
                return { success: true, data: mockData };
            }
            
            return response;
        } catch (error) {
            console.error(`Error fetching billing data for group ${groupId}:`, error);
            return { success: false, data: {} as BillingData, message: `Failed to fetch billing data for group ${groupId}` };
        }
    }

    /**
     * Fetches monthly billing summary (last and next month's bills) for a specific group.
     * @param groupId The ID of the group.
     */
    static async getGroupMonthlySummary(groupId: string): Promise<ApiResponse<MonthlyBillSummary>> {
        try {
            const response = await apiService.get<ApiResponse<MonthlyBillSummary>>(`/api/groups/${groupId}/billing/monthly-summary`);
            return response;
        } catch (error) {
            console.error(`Error fetching monthly billing summary for group ${groupId}:`, error);
            return { 
                success: false, 
                data: { lastMonthBill: null, nextMonthBill: null }, 
                message: `Failed to fetch monthly billing summary for group ${groupId}` 
            };
        }
    }

    /**
     * Fetches estimated invoice amount for the following month.
     * @param groupId The ID of the group.
     */
    static async getEstimatedInvoiceAmount(groupId: string): Promise<ApiResponse<EstimatedInvoiceData>> {
        try {
            const response = await apiService.get<ApiResponse<EstimatedInvoiceData>>(`/api/groups/${groupId}/billing/estimated`);
            return response;
        } catch (error) {
            console.error(`Error fetching estimated invoice amount for group ${groupId}:`, error);
            return { 
                success: false, 
                data: {
                    estimatedMonth: '',
                    billingPeriodStart: '',
                    billingPeriodEnd: '',
                    totalAmount: 0,
                    premiumNonProfitTotal: 0,
                    premiumForProfitTotal: 0,
                    totalFees: 0,
                    locations: []
                }, 
                message: `Failed to fetch estimated invoice amount for group ${groupId}` 
            };
        }
    }

    /**
     * Premium breakdown (non-profit vs for-profit base premium + fees) for a calendar month.
     */
    static async getPremiumBreakdown(
        groupId: string,
        year: number,
        month: number
    ): Promise<ApiResponse<EstimatedInvoiceData>> {
        try {
            const response = await apiService.get<ApiResponse<EstimatedInvoiceData>>(
                `/api/groups/${groupId}/billing/premium-breakdown?year=${year}&month=${month}`
            );
            return response;
        } catch (error) {
            console.error(`Error fetching premium breakdown for group ${groupId}:`, error);
            return {
                success: false,
                data: {
                    estimatedMonth: '',
                    billingPeriodStart: '',
                    billingPeriodEnd: '',
                    totalAmount: 0,
                    premiumNonProfitTotal: 0,
                    premiumForProfitTotal: 0,
                    totalFees: 0,
                    locations: []
                },
                message: `Failed to fetch premium breakdown for group ${groupId}`
            };
        }
    }

    /**
     * Cancels a DIME scheduled/recurring payment for the group (TenantAdmin, SysAdmin only).
     * @param groupId The group ID.
     * @param scheduleId The DIME recurring payment schedule ID.
     */
    static async cancelScheduledPayment(groupId: string, scheduleId: string): Promise<ApiResponse<{ message: string }>> {
        try {
            const response = await apiService.post<ApiResponse<{ message: string }>>(
                `/api/groups/${groupId}/billing/cancel-scheduled-payment`,
                { scheduleId }
            );
            return response;
        } catch (error) {
            console.error(`Error canceling scheduled payment for group ${groupId}:`, error);
            return {
                success: false,
                data: { message: '' },
                message: (error as any)?.response?.data?.message || 'Failed to cancel scheduled payment'
            };
        }
    }

    /**
     * Manually set scheduled payment status in our DB only (no DIME). For syncing records.
     */
    static async updateScheduledPaymentStatus(groupId: string, scheduleId: string, isActive: boolean): Promise<ApiResponse<{ isActive: boolean }>> {
        try {
            const response = await apiService.put<ApiResponse<{ isActive: boolean }>>(
                `/api/groups/${groupId}/billing/scheduled-payment/${encodeURIComponent(scheduleId)}/status`,
                { isActive }
            );
            return response;
        } catch (error) {
            console.error(`Error updating scheduled payment status for group ${groupId}:`, error);
            return {
                success: false,
                data: { isActive },
                message: (error as any)?.response?.data?.message || 'Failed to update status'
            };
        }
    }

    /**
     * Manually set scheduled payment amount in our DB only (DIME syncs on 1st of month). SysAdmin only.
     */
    static async updateScheduledPaymentAmount(groupId: string, scheduleId: string, monthlyAmount: number): Promise<ApiResponse<{ monthlyAmount: number }>> {
        try {
            const response = await apiService.put<ApiResponse<{ monthlyAmount: number }>>(
                `/api/groups/${groupId}/billing/scheduled-payment/${encodeURIComponent(scheduleId)}/amount`,
                { monthlyAmount }
            );
            return response;
        } catch (error) {
            console.error(`Error updating scheduled payment amount for group ${groupId}:`, error);
            return {
                success: false,
                data: { monthlyAmount },
                message: (error as any)?.response?.data?.message || 'Failed to update amount'
            };
        }
    }

    /**
     * Downloads an invoice PDF.
     * @param groupId The ID of the group.
     * @param invoiceId The ID of the invoice.
     */
    static async downloadInvoice(groupId: string, invoiceId: string): Promise<Blob> {
        try {
            const response = await apiService.get(`/api/groups/${groupId}/invoices/${invoiceId}/download`, {
                responseType: 'blob',
            });
            
            return response as unknown as Blob;
        } catch (error) {
            console.error(`Error downloading invoice ${invoiceId}:`, error);
            throw error;
        }
    }

    /**
     * Get regenerate preview for an Unpaid invoice (TenantAdmin, SysAdmin only).
     * Returns recalculated amounts for the modal.
     */
    static async getRegenerateInvoicePreview(groupId: string, invoiceId: string): Promise<ApiResponse<{
        invoiceNumber: string;
        locationName: string;
        billingDate: string;
        billingDateStr: string;
        currentAmount: number;
        currentSubTotal: number;
        newAmount: number;
        newSubTotal: number;
        breakdown: { basePremium: number; systemFees: number; paymentProcessingFee: number; setupFees: number };
    }>> {
        const response = await apiService.get<ApiResponse<{
            invoiceNumber: string;
            locationName: string;
            billingDate: string;
            billingDateStr: string;
            currentAmount: number;
            currentSubTotal: number;
            newAmount: number;
            newSubTotal: number;
            breakdown: { basePremium: number; systemFees: number; paymentProcessingFee: number; setupFees: number };
        }>>(`/api/groups/${groupId}/invoices/${invoiceId}/regenerate-preview`);
        return response;
    }

    /**
     * Regenerate an Unpaid invoice: deletes existing invoice and triggers oe_payment_manager manual-run
     * for the group. Creates new invoice(s) and DIME recurring payment(s), canceling existing schedules.
     * (TenantAdmin, SysAdmin only)
     */
    static async regenerateInvoice(groupId: string, invoiceId: string): Promise<ApiResponse<{
        message: string;
        invoiceNumber: string;
        manualRunResult?: unknown;
    }>> {
        const response = await apiService.post<ApiResponse<{
            message: string;
            invoiceNumber: string;
            manualRunResult?: unknown;
        }>>(`/api/groups/${groupId}/invoices/${invoiceId}/regenerate`);
        return response;
    }

    /**
     * Deletes an invoice for a group (TenantAdmin, SysAdmin only).
     * @param groupId The ID of the group.
     * @param invoiceId The ID of the invoice to delete.
     */
    static async deleteInvoice(groupId: string, invoiceId: string): Promise<ApiResponse<{ message: string }>> {
        try {
            const response = await apiService.delete<ApiResponse<{ message: string }>>(
                `/api/groups/${groupId}/invoices/${invoiceId}`
            );
            return response;
        } catch (error) {
            console.error(`Error deleting invoice ${invoiceId}:`, error);
            return {
                success: false,
                data: { message: '' },
                message: (error as any)?.response?.data?.message || 'Failed to delete invoice'
            };
        }
    }

    /**
     * Preview change effective date for group (TenantAdmin, SysAdmin only).
     * Returns enrollments, schedules, and invoices that would be changed.
     */
    static async changeEffectiveDatePreview(groupId: string, newEffectiveDate: string): Promise<ApiResponse<{
        groupId: string;
        groupName: string;
        newEffectiveDate: string;
        enrollmentsToUpdate: Array<{ enrollmentId: string; memberId: string; productId: string; productName: string; currentEffectiveDate: string; newEffectiveDate: string; householdId?: string; primaryMemberName?: string }>;
        householdsAffected: Array<{ householdId: string; primaryMemberName: string; enrollmentCount: number; dependentsImpacted: number; products: string[] }>;
        schedulesToCancel: Array<{ planId: string; scheduleId: string; monthlyAmount: number; nextBillingDate: string | null }>;
        invoicesToDelete: Array<{ invoiceId: string; invoiceNumber: string; invoiceDate: string | null; totalAmount: number }>;
        summary: { enrollmentCount: number; householdCount: number; totalHouseholdsInGroup?: number; scheduleCount: number; invoiceCount: number };
        whatWillHappen: { enrollments: string; households: string; schedules: string; invoices: string };
    }>> {
        const response = await apiService.post<ApiResponse<unknown>>(
            `/api/groups/${groupId}/advanced/change-effective-date/preview`,
            { newEffectiveDate }
        );
        return response as ApiResponse<{
            groupId: string;
            groupName: string;
            newEffectiveDate: string;
            enrollmentsToUpdate: Array<{ enrollmentId: string; memberId: string; productId: string; productName: string; currentEffectiveDate: string; newEffectiveDate: string; householdId?: string; primaryMemberName?: string }>;
            householdsAffected: Array<{ householdId: string; primaryMemberName: string; enrollmentCount: number; dependentsImpacted: number; products: string[] }>;
            schedulesToCancel: Array<{ planId: string; scheduleId: string; monthlyAmount: number; nextBillingDate: string | null }>;
            invoicesToDelete: Array<{ invoiceId: string; invoiceNumber: string; invoiceDate: string | null; totalAmount: number }>;
            summary: { enrollmentCount: number; householdCount: number; totalHouseholdsInGroup?: number; scheduleCount: number; invoiceCount: number };
            whatWillHappen: { enrollments: string; households: string; schedules: string; invoices: string };
        }>;
    }

    /**
     * Apply change effective date for group (TenantAdmin, SysAdmin only).
     * Updates enrollments, cancels recurring, deletes Unpaid invoices. ACID transaction.
     */
    static async changeEffectiveDateApply(groupId: string, newEffectiveDate: string): Promise<ApiResponse<{
        message: string;
        newEffectiveDate: string;
        enrollmentsUpdated: boolean;
        recurringCancelled: number;
        invoicesDeleted: boolean;
    }>> {
        const response = await apiService.post<ApiResponse<unknown>>(
            `/api/groups/${groupId}/advanced/change-effective-date`,
            { newEffectiveDate }
        );
        return response as ApiResponse<{
            message: string;
            newEffectiveDate: string;
            enrollmentsUpdated: boolean;
            recurringCancelled: number;
            invoicesDeleted: boolean;
        }>;
    }

    /**
     * Downloads a pending invoice PDF for the next payment date
     * @param groupId The ID of the group.
     */
    static async downloadSampleInvoice(groupId: string): Promise<Blob> {
        try {
            const response = await apiService.get(`/api/groups/${groupId}/billing/sample-invoice`, {
                responseType: 'blob',
            });
            
            return response as unknown as Blob;
        } catch (error: any) {
            console.error(`Error downloading pending invoice:`, error);
            // When responseType is 'blob', axios returns the error response as a Blob
            // We need to convert it to text and parse as JSON to get the error message
            if (error?.response?.data instanceof Blob) {
                try {
                    const text = await error.response.data.text();
                    const errorData = JSON.parse(text);
                    const errorMessage = errorData.message || 'Failed to download pending invoice';
                    throw new Error(errorMessage);
                } catch (parseError) {
                    // If parsing fails, use the original error
                    throw new Error('Failed to download pending invoice. Please ensure the group has active enrollments.');
                }
            }
            // If it's already a parsed error object
            if (error?.response?.data && typeof error.response.data === 'object' && !(error.response.data instanceof Blob)) {
                const errorData = error.response.data;
                const errorMessage = errorData.message || 'Failed to download pending invoice';
                throw new Error(errorMessage);
            }
            // If error has a message property
            if (error?.message) {
                throw new Error(error.message);
            }
            throw new Error('Failed to download pending invoice. Please try again.');
        }
    }

    static async sendSampleInvoiceEmail(groupId: string, recipientEmail?: string): Promise<ApiResponse<{
      emailsSent: number;
      emailsFailed: number;
      results: Array<{
        locationId: string;
        locationName: string;
        email?: string;
        messageId?: string;
        success: boolean;
        message?: string;
      }>;
    }>> {
      const response = await apiService.post<ApiResponse<{
        emailsSent: number;
        emailsFailed: number;
        results: Array<{
          locationId: string;
          locationName: string;
          email?: string;
          messageId?: string;
          success: boolean;
          message?: string;
        }>;
      }>>(`/api/groups/${groupId}/billing/send-sample-invoice-email`, {
        recipientEmail
      });
      return response;
    }

    /**
     * Downloads a CSV report of group members with optional filters.
     * @param groupId The ID of the group.
     * @param options Report options (scope, dependents, dateOfBirth, hireDate, contributions, planDetails, fees).
     */
    static async downloadMembersReport(
        groupId: string,
        options: {
            scope: 'active' | 'all';
            includeDependents: boolean;
            includeDateOfBirth: boolean;
            includeHireDate: boolean;
            includeContributions: boolean;
            includePlanDetails?: boolean;
            includeFees?: boolean;
            includeLocation?: boolean;
            includeTotalPremium?: boolean;
            includeCompanyRole?: boolean;
            includeTobacco?: boolean;
            includeGender?: boolean;
            /** Calendar year (UTC). Defaults to current UTC year. */
            reportYear?: number;
            /** Month 1–12 (UTC). Defaults to current UTC month. Enrollments evaluated as of end of this month. */
            reportMonth?: number;
        }
    ): Promise<Blob> {
        const params = new URLSearchParams();
        const now = new Date();
        const reportYear = options.reportYear ?? now.getUTCFullYear();
        const reportMonth = options.reportMonth ?? now.getUTCMonth() + 1;
        params.set('scope', options.scope);
        params.set('includeDependents', String(options.includeDependents));
        params.set('includeDateOfBirth', String(options.includeDateOfBirth));
        params.set('includeHireDate', String(options.includeHireDate));
        params.set('includeContributions', String(options.includeContributions ?? false));
        params.set('includePlanDetails', String(options.includePlanDetails ?? false));
        params.set('includeFees', String(options.includeFees ?? false));
        params.set('includeLocation', String(options.includeLocation ?? false));
        params.set('includeTotalPremium', String(options.includeTotalPremium ?? true));
        params.set('includeCompanyRole', String(options.includeCompanyRole ?? false));
        params.set('includeTobacco', String(options.includeTobacco ?? false));
        params.set('includeGender', String(options.includeGender ?? false));
        params.set('reportYear', String(reportYear));
        params.set('reportMonth', String(reportMonth));

        try {
            const response = await apiService.get(
                `/api/groups/${groupId}/members/report?${params.toString()}`,
                {
                    responseType: 'blob',
                }
            );

            return response as unknown as Blob;
        } catch (error: unknown) {
            // When responseType is 'blob', error responses have Blob body - parse for user-friendly message
            const err = error as { response?: { status?: number; data?: Blob }; message?: string };
            if (err?.response?.data instanceof Blob) {
                try {
                    const text = await (err.response.data as Blob).text();
                    const parsed = JSON.parse(text);
                    const msg = parsed?.message || parsed?.error?.message;
                    if (typeof msg === 'string' && msg.trim()) {
                        throw new Error(msg);
                    }
                } catch (parseErr) {
                    // Rethrow only when we successfully extracted a message (parseErr is our new Error)
                    if (parseErr instanceof Error && parseErr !== error && parseErr.name === 'Error') {
                        throw parseErr;
                    }
                }
            }
            console.error(`Error downloading members report for group ${groupId}:`, error);
            throw error;
        }
    }

    /**
     * Returns default report period:
     * - current UTC month when there are active enrollments this month
     * - otherwise earliest future effective month/year
     */
    static async getMembersReportDefaultPeriod(groupId: string): Promise<ApiResponse<MembersReportDefaultPeriod>> {
        try {
            return await apiService.get<ApiResponse<MembersReportDefaultPeriod>>(
                `/api/groups/${groupId}/members/report-default-period`
            );
        } catch (error) {
            console.error(`Error getting default report period for group ${groupId}:`, error);
            const now = new Date();
            return {
                success: false,
                data: {
                    reportYear: now.getUTCFullYear(),
                    reportMonth: now.getUTCMonth() + 1,
                    source: 'current'
                },
                message: `Failed to get default report period for group ${groupId}`
            };
        }
    }

    /**
     * Creates or updates a payment method for a group.
     * @param groupId The ID of the group.
     * @param paymentMethodData The payment method data.
     * @param isUpdate Whether this is an update to an existing payment method.
     */
    static async savePaymentMethod(
        groupId: string, 
        paymentMethodData: PaymentMethodFormData, 
        isUpdate: boolean = false
    ): Promise<ApiResponse<PaymentMethod>> {
        try {
            if (isUpdate) {
                return await apiService.put<ApiResponse<PaymentMethod>>(
                    `/api/groups/${groupId}/payment-method`, 
                    paymentMethodData
                );
            } else {
                return await apiService.post<ApiResponse<PaymentMethod>>(
                    `/api/groups/${groupId}/payment-method`, 
                    paymentMethodData
                );
            }
        } catch (error) {
            console.error(`Error saving payment method for group ${groupId}:`, error);
            return { 
                success: false, 
                data: {} as PaymentMethod, 
                message: `Failed to save payment method for group ${groupId}` 
            };
        }
    }

    /**
     * Makes a payment for an invoice.
     * @param groupId The ID of the group.
     * @param invoiceId The ID of the invoice.
     * @param amount The payment amount.
     */
    static async makePayment(groupId: string, invoiceId: string, amount: number): Promise<ApiResponse<Payment>> {
        try {
            return await apiService.post<ApiResponse<Payment>>(`/api/groups/${groupId}/invoices/${invoiceId}/pay`, { amount });
        } catch (error) {
            console.error(`Error making payment for invoice ${invoiceId}:`, error);
            return { 
                success: false, 
                data: {} as Payment, 
                message: `Failed to make payment for invoice ${invoiceId}` 
            };
        }
    }

    /**
     * Manual charge for an Unpaid invoice. Same options as individual setup recurring:
     * - Payment method selector
     * - Cancel existing DIME schedules before charging (avoids double charge)
     * - Returns success + optional warning (e.g. cancel failures)
     */
    static async chargeInvoice(
        groupId: string,
        invoiceId: string,
        options: { amount: number; groupPaymentMethodId?: string; cancelExisting?: boolean }
    ): Promise<ApiResponse<Payment>> {
        try {
            return await apiService.post<ApiResponse<Payment>>(
                `/api/groups/${groupId}/invoices/${invoiceId}/charge`,
                options
            );
        } catch (error) {
            console.error(`Error charging invoice ${invoiceId}:`, error);
            const msg = (error as any)?.response?.data?.message || (error as Error)?.message;
            return {
                success: false,
                data: {} as Payment,
                message: msg || `Failed to charge invoice ${invoiceId}`,
            };
        }
    }

    /**
     * Manual invoice status (mark paid, unpaid, or set partial paid amount). TenantAdmin / SysAdmin.
     */
    static async updateInvoiceManualStatus(
        groupId: string,
        invoiceId: string,
        body: { mode: 'paid_full' | 'unpaid' | 'partial'; paidAmount?: number }
    ): Promise<ApiResponse<{ mode: string; paidAmount?: number }>> {
        try {
            return await apiService.patch<ApiResponse<{ mode: string; paidAmount?: number }>>(
                `/api/groups/${groupId}/invoices/${invoiceId}/status`,
                body
            );
        } catch (error) {
            console.error(`Error updating invoice ${invoiceId} status:`, error);
            const msg = (error as any)?.response?.data?.message || (error as Error)?.message;
            return {
                success: false,
                data: { mode: '' },
                message: msg || `Failed to update invoice ${invoiceId}`,
            };
        }
    }

    /**
     * Fetches documents for a specific group.
     * @param groupId The ID of the group.
     */
    static async getGroupDocuments(groupId: string): Promise<ApiResponse<Document[]>> {
        try {
            return await apiService.get<ApiResponse<Document[]>>(`/api/groups/${groupId}/documents`);
        } catch (error) {
            console.error(`Error fetching documents for group ${groupId}:`, error);
            return { success: false, data: [], message: `Failed to fetch documents for group ${groupId}` };
        }
    }

    /**
     * Uploads documents for a group.
     * @param groupId The ID of the group.
     * @param files The files to upload.
     * @param documentType The type of document.
     * @param description The document description.
     */
    static async uploadDocuments(
        groupId: string, 
        files: File[], 
        documentType: string, 
        description: string
    ): Promise<ApiResponse<DocumentUploadResponse>> {
        try {
            const formData = new FormData();
            
            files.forEach((file) => {
                formData.append('files', file);
            });
            formData.append('uploadType', 'documents');
            formData.append('entityId', groupId);
            formData.append('fileType', documentType);
            formData.append('description', description);
            formData.append('category', 'group-documents');

            // Use apiService for FormData uploads
            return await apiService.post<ApiResponse<DocumentUploadResponse>>('/api/uploads', formData);
        } catch (error) {
            console.error(`Error uploading documents for group ${groupId}:`, error);
            return { 
                success: false, 
                data: { success: false } as DocumentUploadResponse, 
                message: `Failed to upload documents for group ${groupId}` 
            };
        }
    }

    /**
     * Saves document metadata for a group.
     * @param groupId The ID of the group.
     * @param metadata The document metadata.
     */
    static async saveDocumentMetadata(
        groupId: string, 
        metadata: DocumentMetadata
    ): Promise<ApiResponse<Document>> {
        try {
            return await apiService.post<ApiResponse<Document>>(`/api/groups/${groupId}/documents`, metadata);
        } catch (error) {
            console.error(`Error saving document metadata for group ${groupId}:`, error);
            return { 
                success: false, 
                data: {} as Document, 
                message: `Failed to save document metadata for group ${groupId}` 
            };
        }
    }

    /**
     * Downloads a document.
     * @param groupId The ID of the group.
     * @param documentId The ID of the document.
     */
    static async downloadDocument(groupId: string, documentId: string): Promise<ApiResponse<{ downloadUrl: string; fileName: string; mimeType: string }>> {
        try {
            return await apiService.get<ApiResponse<{ downloadUrl: string; fileName: string; mimeType: string }>>(`/api/groups/${groupId}/documents/${documentId}/download`);
        } catch (error) {
            console.error(`Error downloading document ${documentId}:`, error);
            return { 
                success: false, 
                data: { downloadUrl: '', fileName: '', mimeType: '' }, 
                message: `Failed to download document ${documentId}` 
            };
        }
    }

    /**
     * Deletes a document.
     * @param groupId The ID of the group.
     * @param documentId The ID of the document.
     */
    static async deleteDocument(groupId: string, documentId: string): Promise<ApiResponse<void>> {
        try {
            return await apiService.delete<ApiResponse<void>>(`/api/groups/${groupId}/documents/${documentId}`);
        } catch (error) {
            console.error(`Error deleting document ${documentId}:`, error);
            return { success: false, data: undefined, message: `Failed to delete document ${documentId}` };
        }
    }

    /**
     * Fetches all contribution rules for a specific group (alias for getGroupContributions).
     * @param groupId The ID of the group.
     */
    static async getGroupContributionRules(groupId: string): Promise<ApiResponse<ContributionRule[]>> {
        return this.getGroupContributions(groupId);
    }

    /**
     * Fetches all eligibility rules for a specific group.
     * @param groupId The ID of the group.
     */
    static async getGroupEligibilityRules(groupId: string): Promise<ApiResponse<any[]>> {
        try {
            const response = await apiService.get<ApiResponse<any[]>>(`/api/groups/${groupId}/eligibility-rules`);
            return response;
        } catch (error) {
            console.error(`Error fetching eligibility rules for group ${groupId}:`, error);
            return { success: false, data: [], message: `Failed to fetch eligibility rules for group ${groupId}` };
        }
    }

    static async getGroupEnrollmentLinks(groupId: string): Promise<ApiResponse<any[]>> {
        try {
            const response = await apiService.get<ApiResponse<any[]>>(`/api/groups/${groupId}/enrollment-links`);
            return response;
        } catch (error) {
            console.error(`Error fetching enrollment links for group ${groupId}:`, error);
            return { success: false, data: [], message: `Failed to fetch enrollment links for group ${groupId}` };
        }
    }

    /**
     * Fast verification of setup step status (single backend query).
     * Returns hasPaymentMethod, hasMembers, hasEnrollmentLinks, hasBusinessInfo,
     * contributionRulesCount, agentHasSignature, groupAdminHasSignature, signaturesRequired.
     */
    static async getSetupSteps(groupId: string): Promise<ApiResponse<{
        hasPaymentMethod: boolean;
        hasMembers: boolean;
        hasEnrollmentLinks: boolean;
        hasBusinessInfo: boolean;
        contributionRulesCount: number;
        agentHasSignature: boolean;
        groupAdminHasSignature: boolean;
        signaturesRequired: boolean;
    }>> {
        try {
            const response = await apiService.get<ApiResponse<any>>(`/api/groups/${groupId}/setup-steps`);
            return response;
        } catch (error: unknown) {
            console.error(`Error fetching setup steps for group ${groupId}:`, error);
            const ax = error as { response?: { data?: { message?: string } }; message?: string };
            const message =
                ax?.response?.data?.message ||
                ax?.message ||
                `Failed to fetch setup steps for group ${groupId}`;
            return {
                success: false,
                data: {
                    hasPaymentMethod: false,
                    hasMembers: false,
                    hasEnrollmentLinks: false,
                    hasBusinessInfo: false,
                    contributionRulesCount: 0,
                    agentHasSignature: false,
                    groupAdminHasSignature: false,
                    signaturesRequired: false
                },
                message
            };
        }
    }

    /**
     * Send enrollment links to group members
     */
    static async sendEnrollmentLinks(
        groupId: string, 
        memberIds: string[], 
        templateId: string,
        deliveryPreferences?: { sendEmail: boolean; sendSMS: boolean },
        phoneNumbers?: Record<string, string>,
        linkBaseUrl?: string
    ): Promise<ApiResponse<any>> {
        const body: Record<string, unknown> = {
            memberIds,
            templateId,
            deliveryPreferences: deliveryPreferences || { sendEmail: true, sendSMS: false },
            phoneNumbers: phoneNumbers || {}
        };
        if (linkBaseUrl && linkBaseUrl.trim()) {
            body.linkBaseUrl = linkBaseUrl.trim();
        }
        return apiService.post(`/api/groups/${groupId}/send-enrollment-links`, body);
    }

    /**
     * Get eligible members for enrollment links (not enrolled, no active links)
     */
    static async getEligibleMembers(groupId: string): Promise<ApiResponse<{ count: number; members: Array<{ MemberId: string; FirstName: string; LastName: string; Email: string; PhoneNumber?: string }> }>> {
        return apiService.get(`/api/groups/${groupId}/eligible-members`);
    }

    /**
     * Get enrollment period status for a group
     */
  static async getEnrollmentPeriodStatus(groupId: string): Promise<ApiResponse<any>> {
    return apiService.get(`/api/groups/${groupId}/enrollment-period/status`);
  }

  /**
   * Send password reset or setup email to an enrolled member
   * @param groupId - Group ID
   * @param memberId - Member ID
   * @returns Promise with API response
   */
  static async sendPasswordEmail(groupId: string, memberId: string): Promise<ApiResponse<{ emailType: 'setup' | 'reset'; messageId: string }>> {
    return apiService.post(`/api/groups/${groupId}/members/${memberId}/send-password-email`);
  }

    /**
     * Create enrollment period for a group
     */
    static async createEnrollmentPeriod(groupId: string, periodData: any): Promise<ApiResponse<any>> {
        return apiService.post(`/api/groups/${groupId}/enrollment-period`, periodData);
    }

    /**
     * After group create: optional mid-month cohort flag, then initial enrollment period.
     */
    static async applyInitialEnrollmentPeriodAfterGroupCreate(
        groupId: string,
        period: {
            startDate: string;
            endDate: string;
            earliestEffectiveDate: string;
            allowMidMonthEffective?: boolean;
        }
    ): Promise<ApiResponse<any>> {
        if (period.allowMidMonthEffective) {
            const settingsResult = await GroupsService.updateGroup(groupId, {
                AllowMidMonthEffective: true
            });
            if (!settingsResult.success) {
                return settingsResult;
            }
        }
        return GroupsService.createEnrollmentPeriod(groupId, {
            startDate: period.startDate,
            endDate: period.endDate,
            earliestEffectiveDate: period.earliestEffectiveDate
        });
    }

    /**
     * Update enrollment period for a group
     */
    static async updateEnrollmentPeriod(groupId: string, periodData: any): Promise<ApiResponse<any>> {
        return apiService.put(`/api/groups/${groupId}/enrollment-period`, periodData);
    }

    /**
     * Get enrollment tokens for a group
     */
    static async getEnrollmentTokens(groupId: string): Promise<ApiResponse<any>> {
        return apiService.get(`/api/groups/${groupId}/enrollment-tokens`);
    }

    /**
     * Get onboarding tokens for a group
     */
    static async getOnboardingTokens(groupId: string): Promise<ApiResponse<any>> {
        return apiService.get(`/api/groups/${groupId}/onboarding-tokens`);
    }

    /**
     * Get onboarding data for a group
     */
    static async getOnboardingData(groupId: string): Promise<ApiResponse<any>> {
        return apiService.get(`/api/groups/${groupId}/onboarding-data`);
    }

    /**
     * Send onboarding link to group members
     */
    static async sendOnboardingLink(groupId: string, data: any): Promise<ApiResponse<any>> {
        return apiService.post(`/api/groups/${groupId}/send-onboarding-link`, data);
    }

    /**
     * Reveal decrypted routing and account numbers for ACH (edit mode)
     */
    static async revealPaymentMethod(groupId: string, paymentMethodId: string): Promise<ApiResponse<{ routingNumber: string | null; accountNumber: string | null }>> {
        try {
            return await apiService.get<ApiResponse<{ routingNumber: string | null; accountNumber: string | null }>>(
                `/api/groups/${groupId}/payment-method/${paymentMethodId}/reveal`
            );
        } catch (error) {
            console.error(`Error revealing payment method:`, error);
            return { success: false, data: { routingNumber: null, accountNumber: null }, message: 'Failed to reveal' };
        }
    }

    /**
     * Delete group payment method
     */
    static async deletePaymentMethod(groupId: string, methodId: string): Promise<ApiResponse<any>> {
        return apiService.delete(`/api/groups/${groupId}/payment-method/${methodId}`);
    }

    /**
     * Set default payment method
     */
    static async setDefaultPaymentMethod(groupId: string, methodId: string): Promise<ApiResponse<any>> {
        return apiService.put(`/api/groups/${groupId}/payment-method/${methodId}/set-default`);
    }

    /**
     * Re-tokenize an existing group payment method at the payment processor (DIME)
     * using the encrypted card / bank details on file. Mirrors the member-side
     * MemberPaymentMethodsService.addToPaymentProcessorForMember flow — used to
     * recover from a stale vault token (DIME error 23) without asking the group
     * to re-enter their details.
     *
     * Optional `cvv` is forwarded straight to DIME for the in-flight retry only;
     * it is never persisted (PCI DSS 3.2.2).
     */
    static async addPaymentMethodToProcessor(
        groupId: string,
        paymentMethodId: string,
        options?: { cvv?: string; forceReplaceProcessorPaymentMethod?: boolean }
    ): Promise<{ success: boolean; message?: string; code?: string }> {
        const body: Record<string, unknown> = {};
        if (options?.cvv) body.cvv = options.cvv;
        if (options?.forceReplaceProcessorPaymentMethod === true) {
            body.forceReplaceProcessorPaymentMethod = true;
        }
        return await apiService.post(
            `/api/groups/${groupId}/payment-method/${paymentMethodId}/add-to-processor`,
            body
        );
    }

    /**
     * Update an existing payment method (billing, location, and optionally replace account/card details).
     */
    static async updatePaymentMethod(
        groupId: string,
        paymentMethodId: string,
        data: {
            billingAddress: string;
            billingCity: string;
            billingState: string;
            billingZip: string;
            locationId?: string | null;
            type?: 'ACH' | 'CreditCard';
            bankName?: string;
            accountType?: string;
            accountHolderName?: string;
            routingNumber?: string;
            accountNumber?: string;
            cardNumber?: string;
            expiryMonth?: number;
            expiryYear?: number;
            cvv?: string;
            cardholderName?: string;
        }
    ): Promise<ApiResponse<any>> {
        try {
            const payload: Record<string, unknown> = {
                billingAddress: data.billingAddress,
                billingCity: data.billingCity,
                billingState: data.billingState,
                billingZip: data.billingZip
            };
            if (data.locationId !== undefined) payload.locationId = data.locationId;
            if (data.type) payload.type = data.type;
            if (data.bankName !== undefined) payload.bankName = data.bankName;
            if (data.accountType !== undefined) payload.accountType = data.accountType;
            if (data.accountHolderName !== undefined) payload.accountHolderName = data.accountHolderName;
            if (data.routingNumber !== undefined) payload.routingNumber = data.routingNumber;
            if (data.accountNumber !== undefined) payload.accountNumber = data.accountNumber;
            if (data.cardNumber !== undefined) payload.cardNumber = data.cardNumber;
            if (data.expiryMonth !== undefined) payload.expiryMonth = data.expiryMonth;
            if (data.expiryYear !== undefined) payload.expiryYear = data.expiryYear;
            if (data.cvv !== undefined) payload.cvv = data.cvv;
            if (data.cardholderName !== undefined) payload.cardholderName = data.cardholderName;
            return await apiService.put<ApiResponse<any>>(
                `/api/groups/${groupId}/payment-method/${paymentMethodId}`,
                payload
            );
        } catch (error) {
            console.error(`Error updating payment method for group ${groupId}:`, error);
            return {
                success: false,
                data: null,
                message: `Failed to update payment method`
            };
        }
    }

    /**
     * Send group message to members
     */
static async sendGroupMessage(
        groupId: string,
        data: {
            memberIds?: string[]; // Optional: specific member IDs (for backward compatibility)
            filters?: { // Optional: filter object (sends to all matching members server-side)
                enrollmentStatus?: string;
                locationId?: string;
                showTerminated?: boolean;
                search?: string;
            };
            templateId?: string;
            subject?: string;
            body?: string;
            deliveryPreferences: { sendEmail: boolean; sendSMS: boolean };
            phoneNumbers?: Record<string, string>;
            replyToEmail: string;
            fromEmail: string;
            fromName: string;
        }
    ): Promise<ApiResponse<{ messagesQueued: number; emailsQueued: number; smsQueued: number; totalMembers: number }>> {
return apiService.post(`/api/groups/${groupId}/send-message`, data);
    }

    /**
     * Get filtered message recipients for a group
     */
    static async getGroupMessageRecipients(
        groupId: string,
        filters?: {
            enrollmentStatus?: string;
            locationId?: string;
            showTerminated?: boolean;
            search?: string;
        }
    ): Promise<ApiResponse<{ members: Member[]; totalCount: number }>> {
        const queryParams = new URLSearchParams();
        if (filters?.enrollmentStatus && filters.enrollmentStatus !== 'all') {
            queryParams.append('enrollmentStatus', filters.enrollmentStatus);
        }
        if (filters?.locationId && filters.locationId !== 'all') {
            queryParams.append('locationId', filters.locationId);
        }
        if (filters?.showTerminated !== undefined) {
            queryParams.append('showTerminated', filters.showTerminated.toString());
        }
        if (filters?.search) {
            queryParams.append('search', filters.search);
        }
        
        const queryString = queryParams.toString();
        const url = `/api/groups/${groupId}/message-recipients${queryString ? `?${queryString}` : ''}`;
        return apiService.get(url);
    }

    /**
     * Get sender options (reply-to and from name options) for a group
     */
    static async getGroupMessageSenderOptions(
        groupId: string
    ): Promise<ApiResponse<{ options: Array<{ type: string; email: string; name: string }> }>> {
        return apiService.get(`/api/groups/${groupId}/message-sender-options`);
    }

    /**
     * Preview a message template with group context
     */
    static async previewGroupMessageTemplate(
        groupId: string,
        templateId: string
    ): Promise<ApiResponse<{ subject: string; body: string }>> {
        return apiService.post(`/api/message-center/templates/${templateId}/preview-group`, { groupId });
    }

    /**
     * Resolve a group identifier (UUID or slug) to a canonical groupId.
     * UUIDs are passed through by the backend unchanged.
     */
    static async resolveGroupIdentifier(identifier: string): Promise<ApiResponse<{ groupId: string; groupName?: string }>> {
        try {
            return await apiService.get<ApiResponse<{ groupId: string; groupName?: string }>>(
                `/api/groups/resolve/${encodeURIComponent(identifier)}`
            );
        } catch (error) {
            console.error(`[GroupsService] resolveGroupIdentifier failed for "${identifier}":`, error);
            return { success: false, data: { groupId: '' }, message: 'Failed to resolve group identifier' };
        }
    }

    /**
     * Update a group's AllAboard Master Group ID. SysAdmin / TenantAdmin only.
     */
    static async updateMasterGroupId(
        groupId: string,
        value: string | null
    ): Promise<ApiResponse<{ allAboardMasterGroupId: string | null }>> {
        try {
            return await apiService.patch<ApiResponse<{ allAboardMasterGroupId: string | null }>>(
                `/api/groups/${groupId}/master-group-id`,
                { value }
            );
        } catch (error) {
            console.error(`[GroupsService] updateMasterGroupId failed for group ${groupId}:`, error);
            const msg = (error as any)?.response?.data?.message || (error as Error)?.message;
            return { success: false, data: { allAboardMasterGroupId: null }, message: msg || 'Failed to update master group ID' };
        }
    }

    /**
     * Check whether a master group ID value is already taken.
     * Returns { available: boolean; conflictingGroupId?: string; conflictingGroupName?: string }
     */
    static async validateMasterGroupId(
        value: string,
        excludeGroupId?: string
    ): Promise<ApiResponse<{ available: boolean; conflictingGroupId?: string; conflictingGroupName?: string }>> {
        try {
            const params = new URLSearchParams({ value });
            if (excludeGroupId) params.set('groupId', excludeGroupId);
            const res = await apiService.get<ApiResponse<{ available?: boolean; valid?: boolean; errors?: string[] }>>(
                `/api/groups/validate-master-group-id?${params.toString()}`
            );
            if (res.success && res.data) {
                const available = res.data.available ?? res.data.valid ?? false;
                return { ...res, data: { available } };
            }
            return res as ApiResponse<{ available: boolean }>;
        } catch (error) {
            console.error(`[GroupsService] validateMasterGroupId failed:`, error);
            return { success: false, data: { available: false }, message: 'Validation failed' };
        }
    }

    /**
     * Check whether a location-level AllAboard Group ID value is already taken.
     */
    static async validateLocationGroupId(
        value: string,
        groupId: string,
        excludeLocationId?: string
    ): Promise<ApiResponse<{ available: boolean; conflictingLocationId?: string; conflictingLocationName?: string }>> {
        try {
            const params = new URLSearchParams({ value, groupId });
            if (excludeLocationId) params.set('locationId', excludeLocationId);
            const res = await apiService.get<ApiResponse<{ available?: boolean; valid?: boolean; errors?: string[] }>>(
                `/api/groups/validate-location-group-id?${params.toString()}`
            );
            if (res.success && res.data) {
                const available = res.data.available ?? res.data.valid ?? false;
                return { ...res, data: { available } };
            }
            return res as ApiResponse<{ available: boolean }>;
        } catch (error) {
            console.error(`[GroupsService] validateLocationGroupId failed:`, error);
            return { success: false, data: { available: false }, message: 'Validation failed' };
        }
    }

    /**
     * Update a location's AllAboard Group ID override. SysAdmin / TenantAdmin only.
     */
    static async updateLocationGroupId(
        groupId: string,
        locationId: string,
        value: string | null
    ): Promise<ApiResponse<{ allAboardGroupId: string | null }>> {
        try {
            return await apiService.patch<ApiResponse<{ allAboardGroupId: string | null }>>(
                `/api/groups/${groupId}/locations/${locationId}/group-id`,
                { value }
            );
        } catch (error) {
            console.error(`[GroupsService] updateLocationGroupId failed for location ${locationId}:`, error);
            const msg = (error as any)?.response?.data?.message || (error as Error)?.message;
            return { success: false, data: { allAboardGroupId: null }, message: msg || 'Failed to update location group ID' };
        }
    }

}

export default GroupsService; 
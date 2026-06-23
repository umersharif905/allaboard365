import { apiService } from '../api.service';

// Types
export interface MemberEnrollment {
  enrollmentId: string;
  memberId: string;
  productId: string; // '00000000-0000-0000-0000-000000000000' for all-products contribution enrollments
  status: 'Active' | 'Pending' | 'PaymentHold' | 'Denied' | 'Cancelled' | 'Inactive' | 'Terminated';
  effectiveDate: string;
  terminationDate?: string;
  premiumAmount: number;
  includedPaymentProcessingFeeAmount?: number;
  includedSystemFeeAmount?: number;
  paymentFrequency: string;
  enrollmentDetails?: string;
  configValues?: Record<string, any>;
  externalAPISyncedAt?: string | null;
  externalAPIDeactivatedAt?: string | null;
  hasProductAPIConfig?: boolean;
  createdDate: string;
  modifiedDate: string;
  productBundleID?: string;
  groupID?: string;
  employerContributionAmount?: number; // Locked-in employer contribution at enrollment time
  contributionId?: string; // References oe.GroupContributions.ContributionId
  enrollmentType?: 'Product' | 'Contribution' | 'PaymentProcessingFee' | 'ProcessingFee' | 'SystemFee'; // Type of enrollment
  bundleProductId?: string;
  /** Tenant oe.Tenants.MemberIDPrefix for this member — used with product idCardMemberIdPrefixMask on ID cards */
  memberTenantMemberIdPrefix?: string;
  product: {
    productId: string;
    name: string;
    description: string;
    productType: string;
    vendorId?: string;
    vendorName?: string;
    productImageUrl?: string;
    productLogoUrl?: string;
    productDocumentUrl?: string;
    productDocuments?: { productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }[];
    coverageDetails?: string;
    features: any[];
    requiredDataFields?: any;
    isSSNRequired?: boolean;
    productOwnerName?: string;
    productOwnerEmail?: string;
    idCardData?: any;
    /** When set, replace tenant group prefix on this product's ID card / eligibility */
    idCardMemberIdPrefixMask?: string | null;
    planDetailsData?: any;
  }; // For all-products contributions, this is the "All Products" product
  bundleProduct?: {
    productId: string;
    name: string;
    description: string;
    productType: string;
    vendorId?: string;
    vendorName?: string;
    productImageUrl?: string;
    productLogoUrl?: string;
    productDocumentUrl?: string;
    productDocuments?: { productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }[];
    coverageDetails?: string;
    features: any[];
    idCardData?: any;
    idCardMemberIdPrefixMask?: string | null;
    planDetailsData?: any;
  };
  memberName: string;
  /** Tier the enrollment was priced with (EE, ES, EC, EF) from ProductPricing - for tier mismatch warning */
  pricingTier?: string | null;
  /**
   * Live config values from the enrollment's linked ProductPricing row (oe.ProductPricing.ConfigValue1-5).
   * Preferred over enrollmentDetails.configuration for display: a product-level relabel on ProductPricing
   * automatically flows to every enrollment pointing at that row, while the enrollmentDetails snapshot is
   * frozen at sign-up time. Falls back to the snapshot when null (products without RequiredDataFields).
   */
  configValue1?: string | null;
  configValue2?: string | null;
  configValue3?: string | null;
  configValue4?: string | null;
  configValue5?: string | null;
  /**
   * True when plan configuration is shown on the ID card ({{ConfigValue1}} replaced in JSON, or
   * idCardConfigurationDisplay is returned for the Member Details block). Plans page skips duplicating the cyan line.
   */
  configurationShownInIdCardData?: boolean;
  /** Label + value for a plan configuration row under Member Details on the card (when not using inline tokens). */
  idCardConfigurationDisplay?: { label: string; value: string } | null;
  /** When present on API payloads (PascalCase), used for next billing display on member payments */
  NextBillingDate?: string;
  /** E123 migration staging — not live until payment / go-live */
  isPendingMigration?: boolean;
}

// Grouped enrollment for bundles
export interface GroupedEnrollment {
  type: 'bundle' | 'individual';
  bundleId?: string; // ProductBundleID for bundles, undefined for individual products
  bundleName?: string; // Name of the bundle product (for bundles)
  bundleProduct?: { // Actual bundle product information
    productId: string;
    name: string;
    description: string;
    productType: string;
    vendorId?: string;
    vendorName?: string;
    productImageUrl?: string;
    productLogoUrl?: string;
    productDocumentUrl?: string;
    productDocuments?: { productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }[];
    coverageDetails?: string;
    features: any[];
    idCardData?: any;
    planDetailsData?: any;
  };
  totalPremium: number;
  status: 'Active' | 'Pending' | 'PaymentHold' | 'Denied' | 'Cancelled' | 'Inactive' | 'Terminated';
  effectiveDate: string;
  terminationDate?: string;
  enrollments: MemberEnrollment[]; // All enrollments in this group
  primaryEnrollment?: MemberEnrollment; // The main enrollment for bundles (the one with the premium)
  componentEnrollments?: MemberEnrollment[]; // Component enrollments for bundles
}

export interface AvailableProduct {
  productId: string;
  name: string;
  description: string;
  productType: string;
  vendorId?: string;
  vendorName?: string;
  productImageUrl?: string;
  productLogoUrl?: string;
  productDocumentUrl?: string;
  productDocuments?: { productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }[];
  coverageDetails?: string;
  features: any[];
  allowedStates: string[];
  minAge: number;
  maxAge: number;
  salesType: string;
  requiresTobaccoInfo: boolean;
  effectiveDateLogic?: string;
  maxEffectiveDateDays: number;
  requiredLicenses: string[];
  requiredDataFields: any[];
  acknowledgementQuestions: any[];
  productOwnerName?: string;
  productOwnerEmail?: string;
  basePrice: number;
  isEnrolled: boolean;
  enrollmentStatus?: string;
  existingEnrollmentId?: string;
  canEnroll: boolean;
}

export interface ProductDetail extends AvailableProduct {
  terminationLogic?: string;
  contactDetails: any;
  enrollment?: {
    status: string;
    enrollmentId: string;
    effectiveDate: string;
    premium: number;
  };
  pricing: {
    name: string;
    rate: number;
    minAge?: number;
    maxAge?: number;
    allowedStates: string[];
    configuration: {
      field1?: string;
      field2?: string;
      field3?: string;
      value1?: string;
      value2?: string;
      value3?: string;
    };
    effectiveDate: string;
    terminationDate?: string;
  }[];
}

export interface EnrollmentRequest {
  productId: string;
  effectiveDate: string;
  paymentFrequency?: string;
  enrollmentDetails?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  error?: {
    message: string;
    code: string;
  };
}

/** Calendar cohort from oe.Enrollments.TerminationDate — keeps separate terminated bundle episodes apart in the UI */
function enrollmentTerminationCohortKey(enrollment: MemberEnrollment): string {
  if (!enrollment.terminationDate) return 'none';
  const s = String(enrollment.terminationDate).trim();
  const ymd = s.length >= 10 ? s.slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : 'none';
}

/** Earliest coverage start among bundle components (matches that terminated stint, not highest-premium row). */
function earliestEffectiveDateAmong(enrollments: MemberEnrollment[]): string {
  let best = '';
  let bestTs = Infinity;
  for (const e of enrollments) {
    if (!e.effectiveDate) continue;
    const t = new Date(e.effectiveDate).getTime();
    if (!Number.isNaN(t) && t < bestTs) {
      bestTs = t;
      best = e.effectiveDate;
    }
  }
  return best || enrollments[0]?.effectiveDate || '';
}

function latestTerminationAmong(enrollments: MemberEnrollment[]): string | undefined {
  let best: string | undefined;
  let bestTs = -Infinity;
  for (const e of enrollments) {
    if (!e.terminationDate) continue;
    const t = new Date(e.terminationDate).getTime();
    if (!Number.isNaN(t) && t > bestTs) {
      bestTs = t;
      best = e.terminationDate;
    }
  }
  return best ?? enrollments[0]?.terminationDate;
}

export class MemberEnrollmentService {
  /**
   * Group enrollments by bundle ID to display bundles as single items.
   * Groups by (bundleId, status, termination cohort) so Active vs ended enrollments split,
   * and multiple terminated episodes for the same bundle product do not merge into one card.
   */
  static groupEnrollmentsByBundle(enrollments: MemberEnrollment[]): GroupedEnrollment[] {
    const getDisplayPremium = (enrollment: MemberEnrollment) => {
      return (enrollment.premiumAmount || 0) +
        (enrollment.includedPaymentProcessingFeeAmount || 0) +
        (enrollment.includedSystemFeeAmount || 0);
    };

    const groupedMap = new Map<string, MemberEnrollment[]>();
    
    // Group by ProductBundleID, status, and termination date cohort so distinct terminated periods stay separate.
    // All-products contributions (productId = '00000000-0000-0000-0000-000000000000') are treated as individual
    enrollments.forEach(enrollment => {
      const bundleKey = enrollment.productBundleID || 'individual';
      const status = normalizeEnrollmentStatus(enrollment.status);
      const termCohort = enrollmentTerminationCohortKey(enrollment);
      const groupKey = `${bundleKey}|${status}|${termCohort}`;
      if (!groupedMap.has(groupKey)) {
        groupedMap.set(groupKey, []);
      }
      groupedMap.get(groupKey)!.push(enrollment);
    });
    
    // Convert groups to GroupedEnrollment objects
    const groupedEnrollments: GroupedEnrollment[] = [];
    
    groupedMap.forEach((enrollmentList, groupKey) => {
      const parts = groupKey.split('|');
      const bundleKey = parts[0];
      const statusFromKey = parts[1] ?? enrollmentList[0]?.status ?? 'Active';
      if (bundleKey === 'individual') {
        // Handle individual products (no bundle)
        enrollmentList.forEach(enrollment => {
          groupedEnrollments.push({
            type: 'individual',
            bundleId: undefined,
            bundleName: undefined,
            totalPremium: getDisplayPremium(enrollment),
            status: enrollment.status,
            effectiveDate: enrollment.effectiveDate,
            terminationDate: enrollment.terminationDate,
            enrollments: [enrollment],
            primaryEnrollment: enrollment,
            componentEnrollments: []
          });
        });
      } else {
        // Handle bundle products (group already filtered by status—only same-status components)
        // Sort enrollments by premium amount (highest first) for consistent ordering
        const sortedEnrollments = enrollmentList.sort((a, b) => getDisplayPremium(b) - getDisplayPremium(a));
        const primaryEnrollment = sortedEnrollments[0]; // Keep for reference but all will be shown as components
        const componentEnrollments = sortedEnrollments; // All enrollments in this group share the same status
        
        // Calculate total premium (sum of all component premiums)
        const totalPremium = enrollmentList.reduce((sum, enrollment) => sum + getDisplayPremium(enrollment), 0);
        
        // Get bundle name from the bundleProduct (actual bundle product) or fallback to primary enrollment
        const bundleName = primaryEnrollment?.bundleProduct?.name || enrollmentList[0]?.bundleProduct?.name || primaryEnrollment?.product?.name || enrollmentList[0]?.product?.name;
        
        groupedEnrollments.push({
          type: 'bundle',
          bundleId: bundleKey,
          bundleName: bundleName,
          bundleProduct: primaryEnrollment?.bundleProduct || enrollmentList[0]?.bundleProduct,
          totalPremium: totalPremium,
          status: (statusFromKey as GroupedEnrollment['status']) || primaryEnrollment?.status || enrollmentList[0]?.status,
          effectiveDate: earliestEffectiveDateAmong(enrollmentList),
          terminationDate: latestTerminationAmong(enrollmentList),
          enrollments: enrollmentList,
          primaryEnrollment: primaryEnrollment,
          componentEnrollments: componentEnrollments
        });
      }
    });
    
    // Sort by creation date (newest first)
    return groupedEnrollments.sort((a, b) => 
      new Date(b.primaryEnrollment?.createdDate || b.enrollments[0]?.createdDate).getTime() - 
      new Date(a.primaryEnrollment?.createdDate || a.enrollments[0]?.createdDate).getTime()
    );
  }

  /**
   * Get current member's enrollments
   * @param filterStatus - Filter by status: 'active', 'pending', or 'terminated'. If undefined, returns active enrollments only.
   */
  static async getMyEnrollments(filterStatus?: 'active' | 'pending' | 'terminated'): Promise<ApiResponse<MemberEnrollment[]>> {
    try {
      console.log('🔍 MemberEnrollmentService.getMyEnrollments - Making API call', { filterStatus });
      let url = '/api/me/member/enrollments';
      if (filterStatus === 'terminated') {
        url += '?filterStatus=terminated';
      } else if (filterStatus === 'pending') {
        url += '?filterStatus=pending';
      } else if (filterStatus === 'active') {
        url += '?filterStatus=active';
      }
      // If filterStatus is undefined, use default behavior (active only)
      const response = await apiService.get<ApiResponse<MemberEnrollment[]>>(url);
      console.log('🔍 MemberEnrollmentService.getMyEnrollments - Response:', response);
      console.log('🔍 MemberEnrollmentService.getMyEnrollments - Response.data:', response.data);
      console.log('🔍 MemberEnrollmentService.getMyEnrollments - Response.data length:', response.data?.length);
      return response;
    } catch (error) {
      return {
        success: false,
        data: [],
        message: error instanceof Error ? error.message : 'Failed to fetch enrollments',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'FETCH_ENROLLMENTS_ERROR'
        }
      };
    }
  }

  /**
   * Get products available to member
   */
  static async getAvailableProducts(): Promise<ApiResponse<AvailableProduct[]>> {
    try {
      return await apiService.get<ApiResponse<AvailableProduct[]>>('/api/me/member/products');
    } catch (error) {
      return {
        success: false,
        data: [],
        message: error instanceof Error ? error.message : 'Failed to fetch available products',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'FETCH_PRODUCTS_ERROR'
        }
      };
    }
  }

  /**
   * Get detailed product information
   */
  static async getProductDetail(productId: string): Promise<ApiResponse<ProductDetail>> {
    try {
      return await apiService.get<ApiResponse<ProductDetail>>(`/api/me/member/products/${productId}`);
    } catch (error) {
      return {
        success: false,
        data: {} as ProductDetail,
        message: error instanceof Error ? error.message : 'Failed to fetch product details',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'FETCH_PRODUCT_DETAIL_ERROR'
        }
      };
    }
  }

  /**
   * Submit enrollment request
   */
  static async submitEnrollmentRequest(request: EnrollmentRequest): Promise<ApiResponse<any>> {
    try {
      return await apiService.post<ApiResponse<any>>('/api/me/member/enrollments', request);
    } catch (error) {
      return {
        success: false,
        data: null,
        message: error instanceof Error ? error.message : 'Failed to submit enrollment request',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'SUBMIT_ENROLLMENT_ERROR'
        }
      };
    }
  }

  /**
   * Cancel pending enrollment request
   */
  static async cancelEnrollmentRequest(enrollmentId: string): Promise<ApiResponse<any>> {
    try {
      return await apiService.put<ApiResponse<any>>(`/api/me/member/enrollments/${enrollmentId}/cancel`, {});
    } catch (error) {
      return {
        success: false,
        data: null,
        message: error instanceof Error ? error.message : 'Failed to cancel enrollment request',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'CANCEL_ENROLLMENT_ERROR'
        }
      };
    }
  }

  /**
   * Submit plan changes request
   */
  static async submitPlanChangesRequest(request: {
    enrollmentId: string;
    configFieldChanges?: Record<string, string>;
    addProducts?: string[];
    removeProducts?: string[];
    effectiveDate?: string;
  }): Promise<ApiResponse<any>> {
    try {
      return await apiService.post<ApiResponse<any>>('/api/me/member/plan-changes', request);
    } catch (error) {
      return {
        success: false,
        data: null,
        message: error instanceof Error ? error.message : 'Failed to submit plan changes request',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'SUBMIT_PLAN_CHANGES_ERROR'
        }
      };
    }
  }

  /**
   * Get plan change requests
   */
  static async getPlanChangeRequests(): Promise<ApiResponse<any[]>> {
    try {
      return await apiService.get<ApiResponse<any[]>>('/api/me/member/plan-changes');
    } catch (error) {
      return {
        success: false,
        data: [],
        message: error instanceof Error ? error.message : 'Failed to fetch plan change requests',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'FETCH_PLAN_CHANGES_ERROR'
        }
      };
    }
  }

  /**
   * Cancel plan change request
   */
  static async cancelPlanChangeRequest(changeRequestId: string): Promise<ApiResponse<any>> {
    try {
      return await apiService.put<ApiResponse<any>>(`/api/me/member/plan-changes/${changeRequestId}/cancel`, {});
    } catch (error) {
      return {
        success: false,
        data: null,
        message: error instanceof Error ? error.message : 'Failed to cancel plan change request',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'CANCEL_PLAN_CHANGES_ERROR'
        }
      };
    }
  }

  /**
   * Calculate pricing impact for plan changes
   */
  static async calculatePricingImpact(request: {
    enrollmentId: string;
    configFieldChanges?: Record<string, string>;
    addProducts?: string[];
    removeProducts?: string[];
  }): Promise<ApiResponse<any>> {
    try {
      return await apiService.post<ApiResponse<any>>('/api/me/member/plan-changes/pricing-impact', request);
    } catch (error) {
      return {
        success: false,
        data: null,
        message: error instanceof Error ? error.message : 'Failed to calculate pricing impact',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'CALCULATE_PRICING_IMPACT_ERROR'
        }
      };
    }
  }

  /**
   * Get member data by ID
   */
  static async getMember(memberId?: string): Promise<ApiResponse<any>> {
    try {
      const url = memberId ? `/api/me/member/profile/${memberId}` : '/api/me/member/profile';
      return await apiService.get<ApiResponse<any>>(url);
    } catch (error) {
      return {
        success: false,
        data: null,
        message: error instanceof Error ? error.message : 'Failed to get member data',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'GET_MEMBER_ERROR'
        }
      };
    }
  }

  /**
   * Get member's enrollment link token
   */
  static async getMemberEnrollmentLinkToken(memberId?: string): Promise<string | null> {
    try {
      const memberResponse = await this.getMember(memberId);
      if (memberResponse.success && memberResponse.data) {
        return memberResponse.data.enrollmentLinkToken || null;
      }
      return null;
    } catch (error) {
      console.error('Error getting enrollment link token:', error);
      return null;
    }
  }
}

export default MemberEnrollmentService;

const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';

/** Normalize ProductDocuments from admin /api/enrollments (PascalCase or camelCase). */
export function mapEnrollmentProductDocuments(
  docs: unknown
): { productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }[] {
  if (!Array.isArray(docs) || docs.length === 0) return [];
  return docs
    .map((d: any) => ({
      productDocumentId: d.productDocumentId ?? d.ProductDocumentId,
      documentUrl: String(d.documentUrl ?? d.DocumentUrl ?? '').trim(),
      displayName: d.displayName ?? d.DisplayName,
      sortOrder: d.sortOrder ?? d.SortOrder ?? 0,
    }))
    .filter((d) => d.documentUrl !== '');
}

export function normalizeEnrollmentStatus(raw: string | null | undefined): MemberEnrollment['status'] {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  if (s === 'active') return 'Active';
  if (s === 'pending' || s === 'pendingpayment') return 'Pending';
  if (s === 'paymenthold') return 'PaymentHold';
  if (s === 'denied') return 'Denied';
  if (s === 'cancelled' || s === 'canceled') return 'Cancelled';
  if (s === 'inactive') return 'Inactive';
  if (s === 'terminated') return 'Terminated';
  const t = String(raw ?? '').trim();
  if (!t) return 'Inactive';
  return t as MemberEnrollment['status'];
}

/** Plans shown in vendor portal + member plans (active, pending migration, payment hold). */
export function isVendorVisiblePlanEnrollment(enrollment: Pick<MemberEnrollment, 'status' | 'isPendingMigration'>): boolean {
  const normalized = normalizeEnrollmentStatus(enrollment.status);
  if (normalized === 'Active' || normalized === 'Pending' || normalized === 'PaymentHold') return true;
  return enrollment.isPendingMigration === true;
}

export function formatPlanStatusLabel(
  status: string,
  isPendingMigration?: boolean
): string {
  if (isPendingMigration) return 'Pending migration';
  const normalized = normalizeEnrollmentStatus(status);
  if (normalized === 'PaymentHold') return 'Payment pending';
  if (normalized === 'Pending') return 'Pending';
  return normalized;
}

/**
 * Same enrollment payload as the Members → Plans tab (member enrollments API, all statuses).
 * Used by plan wizards and kept in sync with MemberPlansTab.
 */
export async function fetchMemberEnrollmentsAllStatuses(memberId: string): Promise<MemberEnrollment[]> {
  const response = await apiService.get<{ success: boolean; data: any[]; message?: string }>(
    `/api/enrollments?memberId=${encodeURIComponent(memberId)}&status=all`
  );
  if (!response.success) {
    throw new Error(response.message || 'Failed to fetch enrollments');
  }
  const transformed = response.data
    .filter((enrollment: any) => {
      const enrollmentType = enrollment.EnrollmentType;
      return (
        !enrollmentType ||
        enrollmentType === 'Product' ||
        enrollmentType === 'Contribution' ||
        enrollmentType === 'PaymentProcessingFee' ||
        enrollmentType === 'ProcessingFee' ||
        enrollmentType === 'SystemFee'
      );
    })
    .map((enrollment: any) => ({
      enrollmentId: enrollment.EnrollmentId,
      memberId: enrollment.MemberId,
      productId: enrollment.ProductId,
      status: normalizeEnrollmentStatus(enrollment.Status),
      effectiveDate: enrollment.EffectiveDate,
      terminationDate: enrollment.TerminationDate,
      premiumAmount: enrollment.PremiumAmount || enrollment.Premium || 0,
      includedPaymentProcessingFeeAmount:
        enrollment.IncludedPaymentProcessingFeeAmount != null ? Number(enrollment.IncludedPaymentProcessingFeeAmount) : 0,
      includedSystemFeeAmount: enrollment.IncludedSystemFeeAmount != null ? Number(enrollment.IncludedSystemFeeAmount) : 0,
      paymentFrequency: enrollment.PaymentFrequency || 'Monthly',
      createdDate: enrollment.CreatedDate,
      modifiedDate: enrollment.ModifiedDate || enrollment.CreatedDate,
      memberName: enrollment.MemberName,
      productBundleID: enrollment.ProductBundleID,
      enrollmentDetails: enrollment.EnrollmentDetails,
      enrollmentType: enrollment.EnrollmentType,
      externalAPISyncedAt: enrollment.ExternalAPISyncedAt,
      externalAPIDeactivatedAt: enrollment.ExternalAPIDeactivatedAt,
      hasProductAPIConfig: enrollment.HasProductAPIConfig === 1 || enrollment.HasProductAPIConfig === true,
      groupID: enrollment.GroupID,
      employerContributionAmount: enrollment.EmployerContributionAmount,
      contributionId: enrollment.ContributionId,
      memberTenantMemberIdPrefix: enrollment.MemberTenantMemberIdPrefix ?? '',
      product: enrollment.ProductId
        ? {
            productId: enrollment.ProductId,
            name: enrollment.ProductName || 'Unknown Product',
            description: enrollment.ProductDescription || '',
            productType: enrollment.ProductType || '',
            vendorId: enrollment.ProductVendorId ?? enrollment.VendorId ?? undefined,
            vendorName: enrollment.ProductVendorName ?? enrollment.VendorName ?? undefined,
            productImageUrl: enrollment.ProductImageUrl,
            productLogoUrl: enrollment.ProductLogoUrl,
            productDocumentUrl: enrollment.ProductDocumentUrl,
            productDocuments: mapEnrollmentProductDocuments(enrollment.ProductDocuments),
            idCardData: enrollment.IDCardData
              ? typeof enrollment.IDCardData === 'string'
                ? JSON.parse(enrollment.IDCardData)
                : enrollment.IDCardData
              : null,
            idCardMemberIdPrefixMask: enrollment.IDCardMemberIdPrefixMask ?? null,
            requiredDataFields: enrollment.RequiredDataFields
              ? typeof enrollment.RequiredDataFields === 'string'
                ? JSON.parse(enrollment.RequiredDataFields)
                : enrollment.RequiredDataFields
              : [],
            features: [],
            productOwnerName: enrollment.ProductOwnerName,
            hidePricing: enrollment.HidePricing || false,
            linkedToProductId: enrollment.LinkedToProductId || null,
            staticGroupId: enrollment.StaticGroupId || null,
            showGroupIdOnIDCard: enrollment.ShowGroupIdOnIDCard === true || enrollment.ShowGroupIdOnIDCard === 1,
            groupId: enrollment.GroupVendorGroupId || enrollment.StaticGroupId || null
          }
        : null,
      bundleProduct: enrollment.ProductBundleID
        ? {
            productId: enrollment.ProductBundleID,
            name: enrollment.BundleProductName,
            description: enrollment.BundleProductDescription,
            productType: enrollment.BundleProductType,
            vendorId: enrollment.BundleVendorId ?? undefined,
            vendorName: enrollment.BundleVendorName ?? undefined,
            productImageUrl: enrollment.BundleProductImageUrl,
            productLogoUrl: enrollment.BundleProductLogoUrl,
            productDocumentUrl: enrollment.BundleProductDocumentUrl,
            productDocuments: mapEnrollmentProductDocuments(enrollment.BundleProductDocuments),
            features: [],
            idCardData: enrollment.BundleIDCardData
              ? typeof enrollment.BundleIDCardData === 'string'
                ? JSON.parse(enrollment.BundleIDCardData)
                : enrollment.BundleIDCardData
              : null,
            idCardMemberIdPrefixMask: enrollment.BundleIDCardMemberIdPrefixMask ?? null
          }
        : null,
      configValue1: enrollment.ConfigValue1,
      configValue2: enrollment.ConfigValue2,
      configValue3: enrollment.ConfigValue3,
      configValue4: enrollment.ConfigValue4,
      configValue5: enrollment.ConfigValue5,
      pricingTier: enrollment.PricingTier || enrollment.pricingTier || null,
      isPendingMigration: enrollment.IsPendingMigration === 1 || enrollment.IsPendingMigration === true,
      configurationShownInIdCardData:
        enrollment.configurationShownInIdCardData === true ||
        enrollment.ConfigurationShownInIdCardData === true,
      idCardConfigurationDisplay:
        enrollment.idCardConfigurationDisplay ?? enrollment.IdCardConfigurationDisplay ?? null
    }));
  return transformed as MemberEnrollment[];
}

/** Group product rows for TenantAdmin plan / dependent wizards (excludes Contribution & fee rows, excludes all-products contribution row). */
export function groupEnrollmentsForPlanWizard(enrollments: MemberEnrollment[]): GroupedEnrollment[] {
  const productEnrollments = enrollments.filter((e: any) => {
    const enrollmentType = e.enrollmentType || e.EnrollmentType;
    if (enrollmentType === 'Contribution') return false;
    if (
      enrollmentType === 'PaymentProcessingFee' ||
      enrollmentType === 'ProcessingFee' ||
      enrollmentType === 'SystemFee'
    ) {
      return false;
    }
    return true;
  });
  const grouped = MemberEnrollmentService.groupEnrollmentsByBundle(productEnrollments);
  return grouped.filter((e: GroupedEnrollment) => e.primaryEnrollment?.productId !== ALL_PRODUCTS_GUID);
}
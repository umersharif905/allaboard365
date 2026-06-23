import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Eye, EyeOff, FileText, Info, Loader2, Package, Undo2, Users, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ContributionBreakdown from '../../components/enrollment-wizard/ContributionBreakdown';
import SignaturePad from '../../components/enrollment-wizard/SignaturePad';
import ProductInfoModal from '../../components/shared/ProductInfoModal';
import { OPEN_ENROLL_BRANDING } from '../../constants/branding';
import { isProductEnrollment } from '../../constants/enrollments';
import { useAuth } from '../../contexts/AuthContext';
import { useMemberHousehold } from '../../hooks/member/useMemberHousehold';
import { useMemberProfile } from '../../hooks/member/useMemberProfile';
import { useEffectiveDates } from '../../hooks/useEffectiveDates';
import { apiService } from '../../services/api.service';
import { ContributionCalculator } from '../../services/ContributionCalculator';
import { MemberProductManagementService } from '../../services/member-product-management.service';
import { MemberEnrollmentService } from '../../services/member/member-enrollments.service';
import { PricingService } from '../../services/pricing.service';
import { ProductChangesCompleteService, type ProductAcknowledgement } from '../../services/product-changes-complete.service';
import { calculateBundleDisplayPrices, isProductPriceHidden } from '../../utils/bundlePricingDisplay';
import { formatDate, validateSSN } from '../../utils/helpers';

/**
 * Product Change Wizard
 * 
 * Allows members to modify their current enrollment selections.
 * 
 * IMPORTANT: See docs/billing/plan-changes-logic.md for complete documentation on:
 * - How future enrollments are handled
 * - Payment calculation logic (incremental vs full charge)
 * - Bundle component conflict resolution
 * - Payment verification requirements
 * 
 * Backend: backend/routes/me/member/product-changes-complete.js
 */

// Feature flag to disable the wizard temporarily
const IS_WIZARD_ENABLED = false;

interface Product {
  productId: string;
  name: string;
  description: string;
  productType: string;
  productImageUrl: string;
  productLogoUrl: string;
  productDocumentUrl: string;
  basePrice: number;
  effectiveDateLogic: string;
  isEnrolled: boolean;
  canEnroll: boolean;
  isGroupAuthorized: boolean;
  requiredDataFields: Array<{
    id: string;
    fieldName: string;
    fieldOptions: string[];
  }>;
  acknowledgementQuestions: any[];
  existingEnrollmentId?: string;
  currentConfiguration?: string;
  currentPrice?: number;
  isBundle?: boolean;
  monthlyPremium?: number;
  employerContribution?: number;
  employeeContribution?: number;
  contributionRules?: Array<{
    type: string;
    amount: number;
    description: string;
    appliesTo: string;
  }>;
  includedProducts?: Array<{
    productId: string;
    productName: string;
    description: string;
    productType: string;
    productDocumentUrl?: string;
    monthlyPremium: number;
    requiredDataFields?: Array<{
      id: string;
      fieldName: string;
      fieldOptions: string[];
    }>;
  }>;
}

interface MemberEnrollment {
  enrollmentId: string;
  memberId: string;
  productId: string;
  status: string;
  effectiveDate: string;
  terminationDate?: string;
  premiumAmount: number;
  paymentFrequency: string;
  enrollmentDetails: string;
  createdDate: string;
  modifiedDate: string;
  memberName: string;
  product: {
    productId: string;
    name: string;
    description: string;
    productType: string;
    productImageUrl: string;
    productLogoUrl: string;
    productDocumentUrl: string;
    coverageDetails: string;
    features: any[];
    productOwnerName: string;
    productOwnerEmail: string;
    idCardData: any;
  };
}

interface ProductChangeWizardProps {
  onClose?: () => void;
  memberId?: string; // Optional member ID for admin/agent use
  memberName?: string; // Member name for display when managing on behalf
  memberEmail?: string; // Member email for display when managing on behalf
}

type ChangeAction = 'dependents' | 'plans';
type RelationshipType = 'S' | 'C';

interface DependentForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  gender: string;
  relationshipType: RelationshipType;
  /** Nine digits only when set */
  ssn?: string;
}

interface HouseholdMember {
  memberId: string;
  firstName: string;
  lastName: string;
  relationshipType: string;
  dateOfBirth?: string;
  isCurrentUser?: boolean;
}

const ProductChangeWizard: React.FC<ProductChangeWizardProps> = ({ onClose, memberId: propMemberId, memberName: propMemberName, memberEmail: propMemberEmail }) => {
  const navigate = useNavigate();
  
  // Feature flag check - disable wizard and show "Coming Soon" message
  if (!IS_WIZARD_ENABLED) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-12 text-center">
            <div className="mb-6">
              <Package className="h-16 w-16 mx-auto text-oe-primary mb-4" />
              <h1 className="text-3xl font-semibold text-gray-900 mb-2">Plan Management Wizard</h1>
              <p className="text-xl text-gray-600 mb-4">Coming Soon</p>
              <p className="text-lg text-oe-primary font-medium">New and Improved Plan Management Wizard</p>
            </div>
            <p className="text-gray-600 mb-8 max-w-2xl mx-auto">
              We're working on an improved plan management experience. This feature will be available soon with enhanced functionality and better performance.
            </p>
            <button
              onClick={() => navigate('/member/plans')}
              className="inline-flex items-center px-6 py-3 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Plans
            </button>
          </div>
        </div>
      </div>
    );
  }
  
  const params = useParams<{ memberId?: string }>();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  
  // Get memberId from either props or route params
  const memberId = propMemberId || params.memberId;
  
  // Fetch member data if managing via route (not passed as props)
  const { data: routeMemberData } = useQuery({
    queryKey: ['routeMemberData', memberId],
    queryFn: async () => {
      if (!memberId || propMemberName) return null; // Skip if member info already provided via props
      const response = await apiService.get<{ success: boolean; data: any }>(`/api/members/${memberId}`);
      return response.success ? response.data : null;
    },
    enabled: !!memberId && !propMemberName,
    staleTime: Infinity  // Never refetch
  });
  
  // Use either prop data or fetched route data
  const memberName = propMemberName || (routeMemberData ? `${routeMemberData.FirstName} ${routeMemberData.LastName}` : undefined);

  // NOTE: memberId parameter allows admin/agent to modify plans on behalf of another member
  // Currently uses current user's profile hooks - future enhancement: pass memberId to hooks
  console.log('ProductChangeWizard: Managing products for member:', memberId || 'current user');
  
  // Check if managing on behalf of another member (admin/agent mode)
  // Use memberId only (not memberName) to avoid race conditions where memberName might not be loaded yet
  const isManagingForMember = !!memberId;
  
  console.log('🔍 ProductChangeWizard: isManagingForMember:', isManagingForMember, { memberId, memberName });
  
  // Use current user hooks (will be overridden if managing another member)
  // IMPORTANT: Only call these hooks when NOT managing another member
  const { profile: currentUserProfile } = useMemberProfile();
  const { data: currentUserHouseholdData } = useMemberHousehold(undefined, !isManagingForMember); // Disabled when managing for another member
  
  // Only fetch current user's pricing when NOT managing for another member
  // This prevents 404 errors when managing another member's plan
  const { data: currentUserPricingData, isLoading: currentUserPricingLoading } = useQuery({
    queryKey: ['memberPricing', 'currentUser', memberId], // Include memberId in key to prevent cross-contamination
    queryFn: async () => {
      // Double-check we're not managing for another member (safety check)
      // This prevents the query from running even if enabled flag is somehow bypassed
      if (isManagingForMember || memberId) {
        console.log('⏭️ Skipping pricing fetch - managing for another member', { isManagingForMember, memberId });
        return null;
      }
      
      // Get member's current enrollments to determine products
      const enrollmentsResponse = await MemberEnrollmentService.getMyEnrollments();
      if (!enrollmentsResponse.success) {
        // If member record not found, return a simple structure instead of throwing
        if (enrollmentsResponse.message?.includes('Member record not found')) {
          console.warn('⚠️ Member record not found - returning empty pricing data');
          return {
            memberAge: 35,
            tier: 'EE',
            tobaccoUse: 'No',
            householdSize: 1
          };
        }
        throw new Error(enrollmentsResponse.message || 'Failed to get member enrollments');
      }
      const enrollments = enrollmentsResponse.data || [];
      
      // Get member data for criteria
      const memberData = await MemberEnrollmentService.getMember();
      if (!memberData.success) {
        // If member record not found, return a simple structure instead of throwing
        if (memberData.message?.includes('Member record not found')) {
          console.warn('⚠️ Member record not found - returning empty pricing data');
          return {
            memberAge: 35,
            tier: 'EE',
            tobaccoUse: 'No',
            householdSize: 1
          };
        }
        throw new Error(memberData.message || 'Failed to get member data');
      }
      const member = memberData.data;
      
      // Build member criteria
      const memberCriteria = {
        age: member.age || 35,
        tobaccoUse: member.tobaccoUse || 'No',
        tier: member.tier || 'EE',
        householdSize: member.householdSize || 1
      };
      
      // Build selected products and configurations from current enrollments
      const selectedProducts = enrollments.map(enrollment => enrollment.productId);
      const selectedConfigs = enrollments.reduce((configs, enrollment) => {
        if (enrollment.configValues && Object.keys(enrollment.configValues).length > 0) {
          configs[enrollment.productId] = enrollment.configValues;
        }
        return configs;
      }, {} as Record<string, Record<string, any>>);
      
      // Use the unified pricing service
      return await PricingService.calculatePricing({
        memberId: member.id,
        calculationType: 'current',
        memberCriteria,
        productSelections: selectedProducts.map(productId => ({ 
          productId,
          configValues: selectedConfigs[productId] || {}
        }))
      });
    },
    enabled: !isManagingForMember && !memberId, // Only fetch when NOT managing for another member AND no memberId prop
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    retry: false, // Don't retry on 404 errors
  });
  
  // Only fetch current user's enrollments when NOT managing for another member
  // This prevents 404 errors when managing another member's plan
  const { data: currentUserGroupedEnrollments } = useQuery({
    queryKey: ['groupedMemberEnrollments', 'currentUser', memberId], // Include memberId in key to prevent cross-contamination
    queryFn: async () => {
      // Double-check we're not managing for another member (safety check)
      // This prevents the query from running even if enabled flag is somehow bypassed
      if (isManagingForMember || memberId) {
        console.log('⏭️ Skipping enrollments fetch - managing for another member', { isManagingForMember, memberId });
        return null;
      }
      
      const response = await MemberEnrollmentService.getMyEnrollments();
      if (!response.success) {
        // If member record not found, return empty array instead of throwing
        if (response.message?.includes('Member record not found')) {
          console.warn('⚠️ Member record not found - returning empty enrollments');
          return [];
        }
        throw new Error(response.message || 'Failed to fetch enrollments');
      }
      return MemberEnrollmentService.groupEnrollmentsByBundle(response.data);
    },
    enabled: !isManagingForMember && !memberId, // Only fetch when NOT managing for another member AND no memberId prop
    staleTime: 0,
    gcTime: 0,
    retry: false, // Don't retry on 404 errors
  });
  
  // Fetch member-specific data when managing on behalf (admin/agent mode)
  const { data: memberSpecificProfile } = useQuery({
    queryKey: ['memberSpecificProfile', memberId],
    queryFn: async () => {
      if (!memberId) return null;
      const response = await apiService.get<{ success: boolean; data: any }>(`/api/members/${memberId}/profile`);
      return response.success ? response.data : null;
    },
    enabled: !!memberId && isManagingForMember,
    staleTime: Infinity  // Never refetch
  });

  const { data: memberSpecificPricing, isLoading: memberSpecificPricingLoading } = useQuery({
    queryKey: ['memberSpecificPricing', memberId],
    queryFn: async () => {
      if (!memberId) return null;
      // Return a simple pricing structure since the endpoint doesn't return full pricing data
      // The actual pricing calculation happens in calculateTotalCost
      return {
        memberAge: memberSpecificProfile?.Age || 0,
        tier: memberSpecificProfile?.Tier || 'EE',
        tobaccoUse: memberSpecificProfile?.TobaccoUse || 'N',
        householdSize: memberSpecificHousehold?.length || 1
      };
    },
    enabled: !!memberId && isManagingForMember && !!memberSpecificProfile,
    staleTime: Infinity // Don't refetch pricing data
  });

  const { data: memberSpecificHousehold } = useQuery({
    queryKey: ['memberSpecificHousehold', memberId],
    queryFn: async () => {
      if (!memberId) return null;
      const response = await apiService.get<{ success: boolean; data: any }>(`/api/members/${memberId}/household`);
      return response.success ? response.data : null;
    },
    enabled: !!memberId && isManagingForMember,
    staleTime: Infinity  // Never refetch
  });

  const { data: memberSpecificEnrollmentsRaw } = useQuery({
    queryKey: ['memberSpecificEnrollments', memberId],
    queryFn: async () => {
      if (!memberId) return null;
      console.log('🔍 Fetching member-specific enrollments for memberId:', memberId);
      const response = await MemberProductManagementService.getMemberEnrollments(memberId);
      console.log('🔍 Member-specific enrollments response:', {
        success: response.success,
        dataLength: response.data?.length || 0,
        data: response.data
      });
      return response.success ? response.data : null;
    },
    enabled: !!memberId && isManagingForMember,
    staleTime: Infinity  // Never refetch
  });

  // Group member-specific enrollments when managing for another member
  const memberSpecificEnrollmentsGrouped = React.useMemo(() => {
    if (!isManagingForMember || !memberSpecificEnrollmentsRaw) {
      console.log('🔍 memberSpecificEnrollmentsGrouped: Not managing for member or no raw data', {
        isManagingForMember,
        hasRawData: !!memberSpecificEnrollmentsRaw,
        rawDataLength: memberSpecificEnrollmentsRaw?.length
      });
      return null;
    }
    
    console.log('🔍 Grouping member-specific enrollments:', {
      rawDataLength: memberSpecificEnrollmentsRaw.length,
      rawData: memberSpecificEnrollmentsRaw
    });
    
    // Transform raw enrollment data to MemberEnrollment format
    // Handle both PascalCase (from /api/enrollments) and camelCase (from /api/members/:id/enrollments) formats
    const enrollments = memberSpecificEnrollmentsRaw.map((e: any) => {
      // Helper to get value from either PascalCase or camelCase
      const getValue = (pascalKey: string, camelKey: string, defaultValue: any = null) => {
        return e[pascalKey] ?? e[camelKey] ?? defaultValue;
      };
      
      // Parse JSON fields safely
      const parseJson = (value: any) => {
        if (!value) return null;
        if (typeof value === 'string') {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        }
        return value;
      };
      
      return {
        enrollmentId: getValue('EnrollmentId', 'enrollmentId'),
        memberId: getValue('MemberId', 'memberId'),
        productId: getValue('ProductId', 'productId'),
        status: getValue('Status', 'status'),
        effectiveDate: getValue('EffectiveDate', 'effectiveDate'),
        terminationDate: getValue('TerminationDate', 'terminationDate'),
        premiumAmount: getValue('PremiumAmount', 'premiumAmount', 0),
        paymentFrequency: getValue('PaymentFrequency', 'paymentFrequency', 'Monthly'),
        enrollmentDetails: getValue('EnrollmentDetails', 'enrollmentDetails'),
        createdDate: getValue('CreatedDate', 'createdDate'),
        modifiedDate: getValue('ModifiedDate', 'modifiedDate'),
        productBundleID: getValue('ProductBundleID', 'productBundleID'),
        groupID: getValue('GroupID', 'groupID'),
        employerContributionAmount: getValue('EmployerContributionAmount', 'employerContributionAmount'),
        contributionId: getValue('ContributionId', 'contributionId'),
        enrollmentType: getValue('EnrollmentType', 'enrollmentType'),
        product: e.product || (getValue('ProductId', 'productId') ? {
          productId: getValue('ProductId', 'productId'),
          name: getValue('ProductName', 'productName', 'Unknown Product'),
          description: getValue('ProductDescription', 'productDescription', ''),
          productType: getValue('ProductType', 'productType', ''),
          productImageUrl: getValue('ProductImageUrl', 'productImageUrl'),
          productLogoUrl: getValue('ProductLogoUrl', 'productLogoUrl'),
          productDocumentUrl: getValue('ProductDocumentUrl', 'productDocumentUrl'),
          idCardData: parseJson(getValue('IDCardData', 'idCardData')),
          requiredDataFields: parseJson(getValue('RequiredDataFields', 'requiredDataFields')) || [],
          productOwnerName: getValue('ProductOwnerName', 'productOwnerName'),
          productOwnerEmail: getValue('ProductOwnerEmail', 'productOwnerEmail')
        } : null),
        bundleProduct: e.bundleProduct || (getValue('ProductBundleID', 'productBundleID') ? {
          productId: getValue('ProductBundleID', 'productBundleID'),
          name: getValue('BundleProductName', 'bundleProductName'),
          description: getValue('BundleProductDescription', 'bundleProductDescription'),
          productType: getValue('BundleProductType', 'bundleProductType'),
          productImageUrl: getValue('BundleProductImageUrl', 'bundleProductImageUrl'),
          productLogoUrl: getValue('BundleProductLogoUrl', 'bundleProductLogoUrl'),
          productDocumentUrl: getValue('BundleProductDocumentUrl', 'bundleProductDocumentUrl'),
          idCardData: parseJson(getValue('BundleIDCardData', 'bundleIDCardData'))
        } : null),
        memberName: getValue('MemberName', 'memberName', '')
      };
    });
    
    console.log('🔍 Transformed enrollments before grouping:', {
      count: enrollments.length,
      enrollments: enrollments.map(e => ({
        productId: e.productId,
        status: e.status,
        effectiveDate: e.effectiveDate,
        productName: e.product?.name
      }))
    });
    
    // Group the enrollments
    const grouped = MemberEnrollmentService.groupEnrollmentsByBundle(enrollments);
    console.log('🔍 Grouped enrollments result:', {
      count: grouped.length,
      grouped: grouped.map(ge => ({
        type: ge.type,
        bundleId: ge.bundleId,
        status: ge.status,
        effectiveDate: ge.effectiveDate,
        productId: ge.type === 'bundle' ? ge.bundleId : ge.primaryEnrollment?.productId
      }))
    });
    
    return grouped;
  }, [isManagingForMember, memberSpecificEnrollmentsRaw]);

  // Use member-specific data if managing, otherwise use current user data
  const memberProfile = isManagingForMember ? memberSpecificProfile : currentUserProfile;
  const householdData = isManagingForMember ? memberSpecificHousehold : currentUserHouseholdData;
  const pricingData = isManagingForMember ? memberSpecificPricing : currentUserPricingData;
  const groupedEnrollments = isManagingForMember ? memberSpecificEnrollmentsGrouped : currentUserGroupedEnrollments;
  const isPricingDataLoading = isManagingForMember ? memberSpecificPricingLoading : currentUserPricingLoading;
  
  // Check if enrollment is for a future effective date (cannot be modified)
  const isFutureEnrollment = (productId: string): boolean => {
    const enrollment = groupedEnrollments?.find(ge => 
      (ge.type === 'bundle' && ge.bundleId === productId) ||
      (ge.type === 'individual' && ge.primaryEnrollment?.productId === productId)
    );
    
    if (!enrollment) return false;
    
    const effectiveDate = enrollment.type === 'bundle' 
      ? enrollment.enrollments?.[0]?.effectiveDate
      : enrollment.primaryEnrollment?.effectiveDate;
    
    if (!effectiveDate) return false;
    
    const effective = new Date(effectiveDate);
    const today = new Date();
    effective.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    
    return effective > today;
  };

  // Check if user has GroupAdmin or higher role (can cancel future enrollments)
  const canCancelFutureEnrollments = (): boolean => {
    const userRole = user?.currentRole;
    const allowedRoles = ['GroupAdmin', 'Agent', 'TenantAdmin', 'SysAdmin'];
    return allowedRoles.includes(userRole || '');
  };

  // Check if modifying future enrollment is restricted (group member, same month)
  // NEW: GroupAdmin+ roles can always modify (they have authority to override restrictions)
  const isFutureEnrollmentModificationRestricted = (productId: string): { restricted: boolean; reason?: string } => {
    if (!isFutureEnrollment(productId)) {
      return { restricted: false };
    }

    // GroupAdmin+ roles can always modify future enrollments (they have authority)
    if (canCancelFutureEnrollments()) {
      return { restricted: false };
    }

    // Check if member is in a group
    if (!isGroupMember) {
      return { restricted: false }; // Individual members can modify (with credit handling)
    }

    // Regular group members: Check if within same month as effective date
    const enrollment = groupedEnrollments?.find(ge => 
      (ge.type === 'bundle' && ge.bundleId === productId) ||
      (ge.type === 'individual' && ge.primaryEnrollment?.productId === productId)
    );
    
    if (!enrollment) {
      return { restricted: false };
    }

    const effectiveDate = enrollment.type === 'bundle' 
      ? enrollment.enrollments?.[0]?.effectiveDate
      : enrollment.primaryEnrollment?.effectiveDate;
    
    if (!effectiveDate) {
      return { restricted: false };
    }

    const effective = new Date(effectiveDate);
    const today = new Date();
    
    // Check if effective date is in the same month as today
    const sameMonth = effective.getFullYear() === today.getFullYear() && 
                      effective.getMonth() === today.getMonth();
    
    if (sameMonth) {
      return { 
        restricted: true, 
        reason: 'Cannot modify future effective plans within the same month as the effective date. The group has already been invoiced for this month.'
      };
    }

    return { restricted: false };
  };

  // Check if a product is already included in an enrolled bundle
  const isProductInEnrolledBundle = (productId: string): { isIncluded: boolean; bundleName?: string } => {
    // Get all enrolled bundles
    const enrolledBundles = groupedEnrollments?.filter(ge => 
      ge.type === 'bundle' && ge.status === 'Active'
    ) || [];
    
    // Check each bundle's component products
    for (const bundle of enrolledBundles) {
      const bundleProduct = products.find(p => p.productId === bundle.bundleId);
      if (bundleProduct?.includedProducts) {
        const isIncluded = bundleProduct.includedProducts.some((ip: any) => ip.productId === productId);
        if (isIncluded) {
          return {
            isIncluded: true,
            bundleName: bundleProduct.name
          };
        }
      }
    }
    
    return { isIncluded: false };
  };

  // Check if a bundle contains products that are already enrolled (individually or in another bundle)
  const bundleHasEnrolledProducts = (bundleProduct: Product): { hasConflict: boolean; conflictingProducts?: string[] } => {
    if (!bundleProduct.isBundle || !bundleProduct.includedProducts) {
      return { hasConflict: false };
    }
    
    const conflictingProducts: string[] = [];
    
    // Check each included product in the bundle
    for (const includedProduct of bundleProduct.includedProducts) {
      // Check if this product is enrolled individually (not as part of this bundle)
      const isEnrolledIndividually = groupedEnrollments?.some(ge => 
        ge.status === 'Active' &&
        ge.type === 'individual' &&
        ge.primaryEnrollment?.productId === includedProduct.productId
      );
      
      if (isEnrolledIndividually) {
        conflictingProducts.push(includedProduct.productName || 'Unknown Product');
      }
    }
    
    return {
      hasConflict: conflictingProducts.length > 0,
      conflictingProducts
    };
  };

  // Calculate the correct new monthly total for display
  // This accounts for: current total + new products - removed products
  // PLUS tier/tobacco repricing of existing products
  const calculateCorrectMonthlyTotal = (): number => {
    // PREFER backend calculation (single source of truth)
    if (calculatedCharges) {
      console.log('✅ Using backend monthly total:', calculatedCharges.newMonthlyTotal);
      return calculatedCharges.newMonthlyTotal;
    }
    
    // Fallback for loading state - show current total from enrollments
    console.log('⏳ Waiting for backend calculation, showing current enrollment total...');
    const currentTotal = groupedEnrollments
      ?.filter(ge => ge.status === 'Active')
      .reduce((sum, ge) => sum + (ge.totalPremium || ge.primaryEnrollment?.premiumAmount || 0), 0) || 0;
    
    return currentTotal;
  };

  // Calculate immediate charge amount (for confirmation page)
  const calculateImmediateCharge = (): { dueToday: number; isIncremental: boolean; reason: string } => {
    console.log('🔍 calculateImmediateCharge called:', {
      hasCalculatedCharges: !!calculatedCharges,
      calculatedCharges,
      currentStep
    });
    
    // ALWAYS use backend calculation (single source of truth)
    if (calculatedCharges) {
      const result = {
        dueToday: calculatedCharges.dueToday,
        isIncremental: calculatedCharges.breakdown?.tierTobaccoAdjustment > 0 || 
                       calculatedCharges.breakdown?.newProducts > 0,
        reason: calculatedCharges.explanation
      };
      console.log('✅ Using backend calculation result:', result);
      return result;
    }
    
    // Loading state - show $0 until backend responds
    console.log('⏳ Waiting for backend calculation...');
    return {
      dueToday: 0,
      isIncremental: false,
      reason: 'Calculating...'
    };
  };
  
  // Get group contribution rules if member is part of a group
  const { data: groupContributionRules, isLoading: isLoadingContributionRules } = useQuery({
    queryKey: ['groupContributionRules', memberProfile?.groupId, memberId],
    queryFn: async () => {
      const groupId = memberProfile?.groupId || memberProfile?.GroupId; // Handle both camelCase and PascalCase
      if (!groupId) {
        console.log('🔍 DEBUG: No groupId found in memberProfile, skipping contribution rules fetch', {
          memberProfile: memberProfile ? { hasGroupId: !!memberProfile.groupId, hasGroupIdPascal: !!memberProfile.GroupId, keys: Object.keys(memberProfile) } : null,
          memberId
        });
        return [];
      }
      console.log('🔍 DEBUG: Fetching group contribution rules', {
        groupId,
        memberId,
        memberProfileKeys: memberProfile ? Object.keys(memberProfile) : null
      });
      const response = await apiService.get<{ success: boolean; data: any[] }>(`/api/groups/${groupId}/contributions`);
      const rules = response.success ? (Array.isArray(response.data) ? response.data : []) : [];
      console.log('✅ DEBUG: Group contribution rules fetched', {
        groupId,
        rulesCount: rules.length,
        rules: rules.map((r: any) => ({ Name: r.Name, ProductId: r.ProductId, Status: r.Status, FlatRateAmount: r.FlatRateAmount }))
      });
      return rules;
    },
    enabled: !!(memberProfile?.groupId || memberProfile?.GroupId),
    staleTime: 5 * 60 * 1000,
  });

  // Get tenant payment processor settings and system fees (matching EnrollmentWizard pattern)
  const { data: tenantPaymentSettings } = useQuery({
    queryKey: ['tenantPaymentSettings', memberProfile?.tenantId],
    queryFn: async () => {
      if (!memberProfile?.tenantId) return null;
      const response = await apiService.get<{ success: boolean; data: { paymentProcessorSettings: any | null; systemFeesSettings: any | null } }>(
        `/api/tenants/${memberProfile.tenantId}/payment-settings`
      );
      return response.success ? response.data : null;
    },
    enabled: !!memberProfile?.tenantId,
    staleTime: 10 * 60 * 1000, // 10 minutes
  });

  // Update payment settings when tenant settings are loaded
  useEffect(() => {
    if (tenantPaymentSettings) {
      setPaymentProcessorSettings(tenantPaymentSettings.paymentProcessorSettings);
      setSystemFeesSettings(tenantPaymentSettings.systemFeesSettings);
      if (tenantPaymentSettings.systemFeesSettings) {
        console.log('💰 DEBUG: System fees breakdown:', {
          platformFee: tenantPaymentSettings.systemFeesSettings.platformFee,
          mobileAppFee: tenantPaymentSettings.systemFeesSettings.mobileAppFee,
          aiAssistantFee: tenantPaymentSettings.systemFeesSettings.aiAssistantFee
        });
      }
    }
  }, [tenantPaymentSettings]);

  // Get group payment method for group members (to calculate fees)
  const { data: groupPaymentMethod } = useQuery({
    queryKey: ['groupPaymentMethod', memberProfile?.groupId],
    queryFn: async () => {
      if (!memberProfile?.groupId) return null;
      const response = await apiService.get<{ success: boolean; data: { paymentMethods: any[] } }>(
        `/api/groups/${memberProfile.groupId}/billing`
      );
      if (response.success && response.data.paymentMethods && response.data.paymentMethods.length > 0) {
        // Get the default payment method or first active one
        const defaultPaymentMethod = response.data.paymentMethods.find((pm: any) => pm.IsDefault) 
          || response.data.paymentMethods[0];
        return defaultPaymentMethod?.Type === 'ACH' ? 'ACH' : 'Card';
      }
      return 'ACH'; // Default to ACH for group members (most common)
    },
    enabled: !!memberProfile?.groupId, // Enable for all group members (needed for fee calculation)
    staleTime: 10 * 60 * 1000, // 10 minutes
  });

  // Update group payment method type when loaded
  useEffect(() => {
    if (groupPaymentMethod) {
      setGroupPaymentMethodType(groupPaymentMethod);
    }
  }, [groupPaymentMethod]);

  // Get member payment methods for individual members (to calculate fees)
  const { data: paymentMethods = [] } = useQuery({
    queryKey: ['memberPaymentMethods', memberProfile?.id],
    queryFn: async () => {
      if (!memberProfile?.id) return [];
      const response = await apiService.get<{ success: boolean; data: any[] }>(
        `/api/members/${memberProfile.id}/payment-methods`
      );
      return response.success ? (Array.isArray(response.data) ? response.data : []) : [];
    },
    enabled: !!memberProfile?.id && memberProfile?.billType === 'SB', // Only for individual billing
    staleTime: 5 * 60 * 1000,
  });
  const defaultPaymentMethod = paymentMethods.find((pm: any) => pm.isDefault || pm.IsDefault);

  // Wizard state
  const [currentStep, setCurrentStep] = useState(0);
  const [selectedActions, setSelectedActions] = useState<ChangeAction[]>([]);
  
  // Dependent management state
  const [dependentsToAdd, setDependentsToAdd] = useState<DependentForm[]>([]);
  const [dependentsToRemove, setDependentsToRemove] = useState<string[]>([]);
  const [showAddDependentForm, setShowAddDependentForm] = useState(false);
  const [currentDependentForm, setCurrentDependentForm] = useState<DependentForm>({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    dateOfBirth: '',
    gender: '',
    relationshipType: 'S',
    ssn: ''
  });
  const [showAddDependentSsn, setShowAddDependentSsn] = useState(false);
  
  // Tier and tobacco state
  const [tobaccoUse, setTobaccoUse] = useState<'Yes' | 'No'>('No');
  const [calculatedTier, setCalculatedTier] = useState<string>('EE');
  const [showTierChange, setShowTierChange] = useState(false);
  
  // Product management state (from ProductChangePage)
  const [products, setProducts] = useState<Product[]>([]);
  const [enrollments, setEnrollments] = useState<MemberEnrollment[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [removedProducts, setRemovedProducts] = useState<string[]>([]);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [productPrices, setProductPrices] = useState<Record<string, number>>({});
  const [includedProductPrices, setIncludedProductPrices] = useState<Record<string, number>>({});
  const [currentTotal, setCurrentTotal] = useState(0);
  const [currentMonthlyPremium, setCurrentMonthlyPremium] = useState(0);
  const [newTotal, setNewTotal] = useState(0);
  const [isPricingLoading, setIsPricingLoading] = useState(true);
  const [paymentProcessorSettings, setPaymentProcessorSettings] = useState<any>(null);
  const [systemFeesSettings, setSystemFeesSettings] = useState<any>(null);
  const [processingFee, setProcessingFee] = useState<number>(0);
  const [systemFeesAmount, setSystemFeesAmount] = useState<number>(0);
  const [groupPaymentMethodType, setGroupPaymentMethodType] = useState<'ACH' | 'Card' | null>(null);
  // NEW: Contribution totals state (matching EnrollmentWizard pattern)
  const [totalCosts, setTotalCosts] = useState<{
    employerContribution: number;
    employeeContribution: number;
    totalCost: number;
  }>({ employerContribution: 0, employeeContribution: 0, totalCost: 0 });
  const [hasMaxEmployeeRuleApplied, setHasMaxEmployeeRuleApplied] = useState<boolean>(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState<string | null>(null);
  const [futureEnrollmentsAlreadyPaid, setFutureEnrollmentsAlreadyPaid] = useState<boolean | null>(null);
  const [calculationAttempted, setCalculationAttempted] = useState(false);
  const [calculationFailed, setCalculationFailed] = useState(false);
  const [calculatedCharges, setCalculatedCharges] = useState<{
    dueToday: number;
    processingFee?: number;
    totalDueToday?: number;
    newMonthlyTotal: number;
    breakdown: any;
    explanation: string;
    contributions?: {
      totalEmployerContribution: number;
      totalEmployeeContribution: number;
      hasContributions: boolean;
      contributionDetails?: any;
    };
    // Phase 5.8: backend pricing authority block — source of truth for fee values.
    authority?: {
      products: any;
      totals: {
        monthlyContribution: number;
        includedFeeTotal: number;
        nonIncludedFeeTotal: number;
        systemFees: number;
      };
      display: any;
      pricingFingerprint: string;
    } | null;
  } | null>(null);
  const calculationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [recalculateTrigger, setRecalculateTrigger] = useState(0); // Manual trigger for recalculation
  const [initialSelectedProducts, setInitialSelectedProducts] = useState<string[]>([]);
  const [initialConfigValues, setInitialConfigValues] = useState<Record<string, string>>({});
  const [initialTobaccoUse, setInitialTobaccoUse] = useState<'Yes' | 'No'>('No');
  const [showProductInfoModal, setShowProductInfoModal] = useState(false);
  const [selectedProductForInfo, setSelectedProductForInfo] = useState<Product | null>(null);
  const [selectedConfigs, setSelectedConfigs] = useState<Record<string, string>>({});
  const [productAcknowledgements, setProductAcknowledgements] = useState<ProductAcknowledgement[]>([]);
  const [acknowledgementResponses, setAcknowledgementResponses] = useState<Record<string, boolean>>({});
  const [digitalSignature, setDigitalSignature] = useState<string>('');
  const [isSignatureValid, setIsSignatureValid] = useState(false);
  const [signatureAgreement, setSignatureAgreement] = useState(false);
  
  // Error and loading state
  const [error, setError] = useState<string | null>(null);
  const [productsLoading, setProductsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pricingErrors, setPricingErrors] = useState<Set<string>>(new Set());
  
  // Group member state
  const [isGroupMember, setIsGroupMember] = useState(false);
  
  // Check if new products are being added (not just removed or reconfigured)
  const hasNewProducts = () => {
    const currentSelected = selectedProducts.filter(id => !removedProducts.includes(id));
    const initialSelected = initialSelectedProducts;
    const hasNew = currentSelected.some(productId => !initialSelected.includes(productId));
    
    console.log('🔍 DEBUG: hasNewProducts check:', {
      currentSelected,
      initialSelected,
      hasNew,
      selectedProducts,
      removedProducts
    });
    
    return hasNew;
  };

  // Check if there are any actual changes made
  const hasAnyChanges = (): boolean => {
    // Check for product additions/removals
    const currentSelected = selectedProducts.filter(id => !removedProducts.includes(id));
    const hasProductChanges = 
      removedProducts.length > 0 || // Products removed
      currentSelected.some(productId => !initialSelectedProducts.includes(productId)) || // Products added
      initialSelectedProducts.some(productId => !currentSelected.includes(productId)); // Products removed (via filtering)
    
    // Check for config value changes
    const hasConfigChanges = Object.keys(configValues).some(key => {
      return configValues[key] !== initialConfigValues[key];
    }) || Object.keys(initialConfigValues).some(key => {
      return configValues[key] !== initialConfigValues[key];
    });
    
    // Check for dependent changes
    const hasDependentChanges = dependentsToAdd.length > 0 || dependentsToRemove.length > 0;
    
    // Check for tobacco use changes
    const normalizedCurrentTobacco = tobaccoUse || 'No';
    const normalizedInitialTobacco = initialTobaccoUse || 'No';
    const hasTobaccoChanges = normalizedCurrentTobacco !== normalizedInitialTobacco;
    
    const hasChanges = hasProductChanges || hasConfigChanges || hasDependentChanges || hasTobaccoChanges;
    
    console.log('🔍 DEBUG: hasAnyChanges check:', {
      hasProductChanges,
      hasConfigChanges,
      hasDependentChanges,
      hasTobaccoChanges,
      hasChanges,
      currentSelected,
      initialSelectedProducts,
      removedProducts,
      dependentsToAdd: dependentsToAdd.length,
      dependentsToRemove: dependentsToRemove.length,
      tobaccoUse: normalizedCurrentTobacco,
      initialTobaccoUse: normalizedInitialTobacco
    });
    
    return hasChanges;
  };
  
  // Use the unified effective dates hook - only fetch when new products are being added
  const { 
    data: effectiveDatesData
  } = useEffectiveDates(memberProfile?.id, hasNewProducts() ? selectedProducts : []);
  
  console.log('🔍 DEBUG: Effective dates data:', {
    effectiveDatesData,
    hasNewProducts: hasNewProducts(),
    selectedProducts: hasNewProducts() ? selectedProducts : []
  });

  // Calculate effective date with priority:
  // Priority 1: Existing plan's effective date (if modifying existing enrollments)
  // Priority 2: Earliest effective date from API (enrollment period or first of next month)
  const calculateEffectiveDate = (): string | null => {
    // Check if we're modifying existing enrollments (not just adding new ones)
    const hasExistingEnrollments = groupedEnrollments && groupedEnrollments.length > 0 && 
      groupedEnrollments.some(ge => {
        const productId = ge.type === 'bundle' ? ge.bundleId : ge.primaryEnrollment?.productId;
        return productId && !removedProducts.includes(productId) && 
               (selectedProducts.includes(productId) || initialSelectedProducts.includes(productId));
      });
    
    if (hasExistingEnrollments) {
      // Priority 1: Use existing enrollment's effective date
      const existingEnrollment = groupedEnrollments?.find(ge => {
        const productId = ge.type === 'bundle' ? ge.bundleId : ge.primaryEnrollment?.productId;
        return productId && !removedProducts.includes(productId);
      });
      
      if (existingEnrollment) {
        const existingEffectiveDate = existingEnrollment.type === 'bundle' 
          ? existingEnrollment.enrollments?.[0]?.effectiveDate
          : existingEnrollment.primaryEnrollment?.effectiveDate;
        
        if (existingEffectiveDate) {
          console.log('🔍 Using existing enrollment effective date (Priority 1):', existingEffectiveDate);
          return existingEffectiveDate;
        }
      }
    }
    
    // Priority 2: Fall back to API effective date options (enrollment period logic)
    const apiEffectiveDate = effectiveDatesData?.effectiveDateOptions?.fixedDate || 
      (effectiveDatesData?.effectiveDateOptions?.availableDates?.[0] || null);
    
    if (apiEffectiveDate) {
      console.log('🔍 Using API effective date options (Priority 2):', apiEffectiveDate);
      return apiEffectiveDate;
    }
    
    return null;
  };
  
  // Calculate effective date once and reuse
  const calculatedEffectiveDate = calculateEffectiveDate();

  // Calculate current household composition - ONLY show dependents, not primary member
  const getCurrentHouseholdMembers = (): HouseholdMember[] => {
    if (!householdData?.householdMembers) return [];
    
    return householdData.householdMembers
      .filter((m: any) => !m.IsCurrentUser) // Exclude primary member
      .filter((m: any) => !dependentsToRemove.includes(m.MemberId))
      .map((m: any) => ({
        memberId: m.MemberId,
        firstName: m.FirstName,
        lastName: m.LastName,
        relationshipType: m.RelationshipType,
        dateOfBirth: m.DateOfBirth,
        isCurrentUser: m.IsCurrentUser
      }));
  };

  // Calculate new tier based on household changes
  // CRITICAL: Always calculate tier from actual household composition, never trust DB tier
  useEffect(() => {
    if (!householdData) return;
    
    const currentMembers = getCurrentHouseholdMembers();
    const newDependents = dependentsToAdd;
    
    // Combine current members with new dependents to get projected household
    const projectedHousehold = [
      ...currentMembers,
      ...newDependents.map(d => ({
        memberId: 'new',
        firstName: d.firstName,
        lastName: d.lastName,
        relationshipType: d.relationshipType,
        dateOfBirth: d.dateOfBirth,
        isCurrentUser: false
      }))
    ];
    
    // Always calculate tier from actual household composition (not DB tier)
    const hasSpouse = projectedHousehold.some(m => m.relationshipType === 'S');
    const childrenCount = projectedHousehold.filter(m => m.relationshipType === 'C').length;
    const calculatedTierFromHousehold = PricingService.calculateMemberTier(hasSpouse, childrenCount);
    
    // Calculate current tier from current household (before any changes)
    const currentHasSpouse = currentMembers.some(m => m.relationshipType === 'S');
    const currentChildrenCount = currentMembers.filter(m => m.relationshipType === 'C').length;
    const currentTierFromHousehold = PricingService.calculateMemberTier(currentHasSpouse, currentChildrenCount);
    
    // Always use calculated tier (never trust DB tier)
    setCalculatedTier(calculatedTierFromHousehold);
    
    // Only show tier change if user actually added/removed dependents (not just because DB tier was wrong)
    const hasActualChanges = dependentsToAdd.length > 0 || dependentsToRemove.length > 0;
    setShowTierChange(hasActualChanges && calculatedTierFromHousehold !== currentTierFromHousehold);
    
    console.log('🔍 Tier calculation:', {
      currentHousehold: { hasSpouse: currentHasSpouse, childrenCount: currentChildrenCount, tier: currentTierFromHousehold },
      projectedHousehold: { hasSpouse, childrenCount, tier: calculatedTierFromHousehold },
      dbTier: memberProfile?.tier,
      hasActualChanges,
      showTierChange: hasActualChanges && calculatedTierFromHousehold !== currentTierFromHousehold
    });
  }, [dependentsToAdd, dependentsToRemove, householdData, memberProfile]);

  // NOTE: Tier initialization is handled by the tier calculation useEffect above
  // This ensures tier is always calculated from actual household composition, not DB tier

  // Initialize tobacco use from member profile
  useEffect(() => {
    if (memberProfile?.tobaccoUse) {
      // Normalize tobacco use to Yes/No
      const normalizedTobacco = (memberProfile.tobaccoUse === 'Yes' || memberProfile.tobaccoUse === 'Y') ? 'Yes' : 'No';
      setTobaccoUse(normalizedTobacco);
      setInitialTobaccoUse(normalizedTobacco);
    }
  }, [memberProfile]);
  
  // Set isGroupMember based on memberProfile
  useEffect(() => {
    setIsGroupMember(!!memberProfile?.groupId);
  }, [memberProfile?.groupId]);
  
  // Load product data when reaching the manage plans step OR when reviewing with tier/tobacco changes
  useEffect(() => {
    const currentStepData = getWizardSteps()[currentStep];
    if (currentStepData?.id === 'manage-plans' && products.length === 0) {
      loadProductData();
    }
    // Also load products when reviewing dependent-only changes (to show updated pricing)
    if (currentStepData?.id === 'review' && !selectedActions.includes('plans') && products.length === 0) {
      // Normalize tobacco values for comparison
      const originalTobacco = (memberProfile?.tobaccoUse === 'Yes' || memberProfile?.tobaccoUse === 'Y') ? 'Yes' : 'No';
      const hasTobaccoChange = tobaccoUse !== originalTobacco;
      const hasHouseholdImpact = showTierChange || hasTobaccoChange;
      
      if (hasHouseholdImpact) {
        loadProductData();
      }
    }
  }, [currentStep, showTierChange, tobaccoUse, memberProfile?.tobaccoUse, selectedActions, products.length]);
  
  // Calculate included product pricing when data changes
  useEffect(() => {
    if (memberProfile && householdData && products.length > 0) {
      calculateIncludedProductPricing();
    }
  }, [memberProfile, householdData, products, configValues, calculatedTier, tobaccoUse]);

  // Calculate prices when products/config change
  useEffect(() => {
    const calculatePrices = async () => {
      if (products.length > 0 && memberProfile && householdData) {
        setIsPricingLoading(true);
        const prices: Record<string, number> = {};
        
        for (const product of products) {
          const selectedConfigValue = configValues[product.productId] || 
            (product.requiredDataFields && product.requiredDataFields.length > 0 ? 
              product.requiredDataFields[0].fieldOptions[0] : 'Default');
          
          // Check if this product is enrolled and config hasn't changed
          // Always calculate fresh pricing based on current wizard state
          // This ensures users see what they'll actually pay after changes are applied
          const price = await getProductPricing(product, selectedConfigValue);
          prices[product.productId] = price ?? 0;
        }
        setProductPrices(prices);
        setIsPricingLoading(false);
      }
    };
    calculatePrices();
  }, [products, pricingData, householdData, memberProfile, configValues, calculatedTier, tobaccoUse, initialSelectedProducts, initialConfigValues, groupedEnrollments]);
  
  // Calculate totals when selections change
  useEffect(() => {
    const calculateTotals = async () => {
      const current = await getCurrentEnrollmentsTotalCost();
      const currentPremium = await getCurrentMonthlyPremium();
      const newTotalCalc = await getSelectedProductsTotalCost();
      
      console.log('🔍 DEBUG: Total calculation results:', {
        currentTotal: current,
        currentMonthlyPremium: currentPremium,
        newTotal: newTotalCalc,
        isGroupMember,
        hasGroupContributionRules: (Array.isArray(groupContributionRules) ? groupContributionRules.length : 0)
      });
      
      setCurrentTotal(current);
      setCurrentMonthlyPremium(currentPremium);
      setNewTotal(newTotalCalc);
    };
    calculateTotals();
  }, [enrollments, selectedProducts, productPrices, groupedEnrollments, groupContributionRules, initialConfigValues, configValues, isGroupMember]);

  // Update totalCosts when contributions are calculated (matching EnrollmentWizard pattern)
  useEffect(() => {
    // If we have backend contributions, use them immediately (don't wait for frontend rules)
    if (calculatedCharges?.contributions?.hasContributions) {
      console.log('✅ Backend contributions available, using them directly');
      // Backend contributions are already being used in the calculation below
      // Continue to execute the effect to update totalCosts
    } else if (isGroupMember && isLoadingContributionRules) {
      // Only wait for frontend rules if we don't have backend contributions yet
      console.log('⏳ Waiting for groupContributionRules to load before calculating totals...');
      return;
    }
    
    const updateTotalCosts = async () => {
      // Check if there are household changes (tier/tobacco changes) that affect existing products
      const originalTobacco = (memberProfile?.tobaccoUse === 'Yes' || memberProfile?.tobaccoUse === 'Y') ? 'Yes' : 'No';
      const hasTobaccoChange = tobaccoUse !== originalTobacco;
      const hasHouseholdImpact = showTierChange || hasTobaccoChange;
      
      // If no products selected AND no household changes, set totals to 0
      if (!selectedProducts.length && !hasHouseholdImpact) {
        setTotalCosts({ employerContribution: 0, employeeContribution: 0, totalCost: 0 });
        return;
      }

      const selectedProductsData = [];
      const selectedConfigsForCalc: Record<string, string> = {};
      
      // If household changes exist but no products explicitly selected, use existing products
      const productsToCalculate = selectedProducts.length > 0 
        ? selectedProducts 
        : (groupedEnrollments?.filter(ge => {
            if (ge.status !== 'Active') return false;
            const enrollmentType = ge.primaryEnrollment?.enrollmentType || ge.enrollments?.[0]?.enrollmentType;
            return isProductEnrollment(enrollmentType);
          }).map(ge => ge.type === 'bundle' ? ge.bundleId : ge.primaryEnrollment?.productId).filter(Boolean) as string[] || []);
      
      for (const productId of productsToCalculate) {
        if (removedProducts.includes(productId)) {
          continue;
        }
        
        const product = products.find(p => p.productId === productId);
        if (product) {
          const selectedConfig = configValues[productId] || (product.isBundle ? '1500' : 'Default');
          selectedConfigsForCalc[productId] = selectedConfig;
          
          const transformedProduct = await transformProductForContributionCalculator(product, selectedConfig);
          selectedProductsData.push(transformedProduct);
        }
      }

      // Filter all-products rules by status and member criteria (job position)
      const memberCriteria = {
        age: memberProfile?.age || 35,
        jobPosition: memberProfile?.jobPosition
      };
      
      const allProductsRules = (Array.isArray(groupContributionRules) ? groupContributionRules : [])
        .filter((rule: any) => !rule.ProductId && rule.Status === 'Active');
      
      // Don't pre-filter - let ContributionCalculator handle filtering by memberCriteria
      const transformedAllProductsRules = transformContributionRules(allProductsRules);

      // If no products selected (all cancelled), set totals to 0
      if (selectedProductsData.length === 0) {
        console.log('🔍 DEBUG: No products selected - setting totals to 0');
        setTotalCosts({
          employerContribution: 0,
          employeeContribution: 0,
          totalCost: 0
        });
        return;
      }

      // Always calculate tier from household composition (never use DB tier)
      const tierForContributions = getTierForPricing();
      
      const contributionResult = ContributionCalculator.calculateTotalContributions(
        selectedProductsData,
        selectedConfigsForCalc,
        transformedAllProductsRules,
        tierForContributions, // ALWAYS use calculated tier from household composition
        memberCriteria // Pass memberCriteria for additional filtering in ContributionCalculator
      );

      // PREFER backend-calculated contributions if available (from calculate-plan-change-cost endpoint)
      // This ensures consistency and avoids race conditions with loading contribution rules
      let finalEmployerContribution = contributionResult.totals.totalEmployerContribution;
      let finalEmployeeContribution = contributionResult.totals.totalEmployeeContribution;
      
      // PREFER backend-calculated total premium (newMonthlyTotal) when available
      // This is critical for removed products - backend correctly subtracts removed products' premiums
      // Frontend calculation doesn't account for removed products in totalPremium
      let finalTotalCost = contributionResult.totals.totalPremium;
      if (calculatedCharges?.newMonthlyTotal !== undefined && calculatedCharges.newMonthlyTotal !== null) {
        console.log('✅ Using backend-calculated newMonthlyTotal for totalCost:', {
          backendTotal: calculatedCharges.newMonthlyTotal,
          frontendTotal: contributionResult.totals.totalPremium,
          hasRemovedProducts: removedProducts.length > 0
        });
        finalTotalCost = calculatedCharges.newMonthlyTotal;
      }
      
      if (calculatedCharges?.contributions?.hasContributions) {
        console.log('✅ Using backend-calculated contributions:', calculatedCharges.contributions);
        finalEmployerContribution = calculatedCharges.contributions.totalEmployerContribution;
        finalEmployeeContribution = calculatedCharges.contributions.totalEmployeeContribution;
      }
      
      // Update totalCosts with contribution results (matching EnrollmentWizard pattern)
      setTotalCosts({
        employerContribution: finalEmployerContribution,
        employeeContribution: finalEmployeeContribution,
        totalCost: finalTotalCost // Use backend newMonthlyTotal when available (correctly handles removed products)
      });

      // Check for MaxEmployee rule
      const hasMaxEmployeeRule = (Array.isArray(groupContributionRules) ? groupContributionRules : []).some(
        (rule: any) => 
          rule.Status === 'Active' && 
          rule.ContributionDirection === 'MaxEmployee'
      );
      setHasMaxEmployeeRuleApplied(hasMaxEmployeeRule);
    };

    updateTotalCosts();
  }, [selectedProducts, removedProducts, products, configValues, groupContributionRules, isLoadingContributionRules, memberProfile, calculatedTier, showTierChange, tobaccoUse, groupedEnrollments, isGroupMember, calculatedCharges?.contributions]);

  // Phase 5.8: render processing + system fees from backend pricing authority.
  // Previously computed client-side via calculateCombinedFees(); now reads
  // response.data.authority.totals from /calculate-plan-change-cost. When the
  // authority block is absent (pre-API, or edge cases where the backend
  // couldn't compute it — e.g. non-group members, chargeFeeToMember disabled,
  // or no selected products), we fall back to $0 rather than silently
  // recomputing on the client. This matches the fail-loudly pattern adopted
  // in EnrollmentWizard (commit 37977d19).
  useEffect(() => {
    const authority = calculatedCharges?.authority;

    if (!authority) {
      // Authority not yet available (pre-API or edge case). Show $0 fees
      // until the backend responds — do NOT recompute client-side.
      if (calculatedCharges && !calculatedCharges.authority) {
        console.warn(
          '⚠️ /calculate-plan-change-cost response is missing the authority block; ' +
          'rendering $0 fees. Expected when chargeFeeToMember is disabled or no ' +
          'selected products, but otherwise indicates a backend regression.'
        );
      }
      setSystemFeesAmount(0);
      setProcessingFee(0);
      return;
    }

    const totals = authority.totals || ({} as any);
    const processingFeePortion =
      Number(totals.includedFeeTotal || 0) + Number(totals.nonIncludedFeeTotal || 0);
    const systemFees = Number(totals.systemFees || 0);
    const combinedFees = Math.round((processingFeePortion + systemFees) * 100) / 100;

    console.log('✅ DEBUG: Fees rendered from authority:', {
      includedFeeTotal: Number(totals.includedFeeTotal || 0),
      nonIncludedFeeTotal: Number(totals.nonIncludedFeeTotal || 0),
      processingFeePortion,
      systemFees,
      combinedFees,
      pricingFingerprint: authority.pricingFingerprint
    });

    setSystemFeesAmount(systemFees);
    setProcessingFee(combinedFees);
  }, [calculatedCharges]);
  
  // Calculate plan change costs when reaching confirmation page
  // Uses unified backend calculation to ensure frontend matches backend exactly
  // Debounced to avoid excessive API calls during rapid changes
  useEffect(() => {
    const currentStepData = steps[currentStep];
    const isReviewStep = currentStepData?.id === 'review';
    
    console.log('🔍 useEffect for backend calculation triggered:', { 
      currentStep,
      currentStepId: currentStepData?.id,
      isReviewStep,
      shouldCalculate: isReviewStep,
      selectedProductsCount: selectedProducts.length,
      configValuesCount: Object.keys(configValues).length
    });
    
    // Clear previous timer
    if (calculationTimerRef.current) {
      console.log('⏹️ Clearing previous calculation timer');
      clearTimeout(calculationTimerRef.current);
      calculationTimerRef.current = null;
    }
    
    // Only calculate on review/confirmation page (dynamically determined)
    if (!isReviewStep) {
      console.log('⏭️ Skipping backend calculation - not on review page (step:', currentStep, ', id:', currentStepData?.id, ')');
      // Reset calculation states when not on review step
      setCalculationAttempted(false);
      setCalculationFailed(false);
      return;
    }
    
    // Note: Endpoint now supports admin users managing on behalf of another member via memberId parameter
    
    // Check for household changes (tier/tobacco changes or dependents being added)
    const originalTobacco = (memberProfile?.tobaccoUse === 'Yes' || memberProfile?.tobaccoUse === 'Y') ? 'Yes' : 'No';
    const hasTobaccoChange = tobaccoUse !== originalTobacco;
    const dependentsToAddLength = dependentsToAdd.length;
    const hasHouseholdChanges = showTierChange || hasTobaccoChange || dependentsToAddLength > 0;
    
    console.log('🔍 Checking if API call should be made:', {
      selectedProductsCount: selectedProducts.length,
      removedProductsCount: removedProducts.length,
      showTierChange,
      hasTobaccoChange,
      dependentsToAddLength,
      hasHouseholdChanges,
      shouldSkip: selectedProducts.length === 0 && removedProducts.length === 0 && !hasHouseholdChanges
    });
    
    // Check if tier needs recalculation (DB tier might be wrong)
    const tierNeedsRecalculation = calculatedTier && memberProfile?.tier && calculatedTier !== memberProfile.tier;
    
    // Skip calculation if there are no changes at all (no products, no household changes, and tier is correct)
    // Note: We still calculate if there are removed products (cancellations) to show refunds
    // CRITICAL: Always calculate if tier needs recalculation (DB tier might be wrong)
    if (selectedProducts.length === 0 && removedProducts.length === 0 && !hasHouseholdChanges && !tierNeedsRecalculation) {
      console.log('⏭️ Skipping backend calculation - no products selected or removed, no household changes, and tier is correct');
      setCalculatedCharges(null);
      return;
    }
    
    if (tierNeedsRecalculation) {
      console.log(`🔄 Tier needs recalculation: DB tier (${memberProfile.tier}) differs from calculated tier (${calculatedTier}) - will recalculate pricing and contributions`);
    }
    
    // Debounce: wait 300ms after last change before calling API
    console.log('⏱️ Starting 300ms debounce timer for calculate-plan-change-cost API call...');
    calculationTimerRef.current = setTimeout(async () => {
      try {
        setCalculationAttempted(true);
        setCalculationFailed(false);
        console.log('🔍 Calculating plan change costs from backend...');
        
        // Prepare frontend pricing for validation
        // For household changes OR tier recalculation, include existing products if no products are explicitly selected
        let productsToPrice = selectedProducts.filter(pid => !removedProducts.includes(pid));
        const needsExistingProducts = (hasHouseholdChanges || tierNeedsRecalculation) && productsToPrice.length === 0;
        if (needsExistingProducts && groupedEnrollments) {
          // Get existing active product IDs for household changes or tier recalculation
          const existingProductIds = groupedEnrollments
            .filter(ge => {
              if (ge.status !== 'Active') return false;
              const enrollmentType = ge.primaryEnrollment?.enrollmentType || ge.enrollments?.[0]?.enrollmentType;
              return isProductEnrollment(enrollmentType);
            })
            .map(ge => ge.type === 'bundle' ? ge.bundleId : ge.primaryEnrollment?.productId)
            .filter(Boolean) as string[];
          
          productsToPrice = existingProductIds;
          if (tierNeedsRecalculation) {
            console.log(`🔄 Tier recalculation detected - including existing products for repricing with correct tier (${calculatedTier}):`, existingProductIds.map(id => id.substring(0, 8)));
          } else {
            console.log('🔍 Household changes detected - including existing products for pricing:', existingProductIds.map(id => id.substring(0, 8)));
          }
        }
        
        // For tier recalculation, don't send frontend pricing - let backend calculate with correct tier
        // Otherwise, use frontend pricing for validation
        const pricingForValidation = tierNeedsRecalculation ? [] : productsToPrice.map(productId => {
          const product = products.find(p => p.productId === productId);
          const monthlyPremium = product?.isBundle 
            ? getBundleTotalPrice(product)
            : (productPrices[productId] || (groupedEnrollments?.find(ge => 
              (ge.type === 'bundle' && ge.bundleId === productId) ||
              (ge.type === 'individual' && ge.primaryEnrollment?.productId === productId)
            )?.totalPremium || 0));
          
          console.log('📊 DEBUG: Building pricingForValidation entry:', {
            productId: productId.substring(0, 8),
            productName: product?.name,
            isBundle: product?.isBundle,
            monthlyPremium,
            monthlyPremiumType: typeof monthlyPremium,
            productPricesValue: productPrices[productId],
            selectedConfig: configValues[productId] || null
          });
          
          return {
            productId,
            productName: product?.name || '',
            monthlyPremium,
            selectedConfig: configValues[productId] || null
          };
        });
        
        if (tierNeedsRecalculation) {
          console.log('🔄 Tier recalculation: Sending empty frontendPricing to force backend recalculation with correct tier');
        }
        
        console.log('📤 Sending to backend:', {
          selectedProducts: selectedProducts.map(id => id.substring(0, 8)),
          removedProducts: removedProducts.map(id => id.substring(0, 8)),
          configValues,
          initialConfigValues,
          pricingForValidation: pricingForValidation.map(p => ({
            productId: p.productId.substring(0, 8),
            productName: p.productName,
            monthlyPremium: p.monthlyPremium,
            selectedConfig: p.selectedConfig
          })),
          memberId: memberId || 'none (self)',
          isManagingForMember,
          propMemberId,
          paramsMemberId: params.memberId
        });
        
        const response = await apiService.post<{
          success: boolean;
          data: {
            dueToday: number;
            newMonthlyTotal: number;
            breakdown: any;
            explanation: string;
            paymentStatus: {
              hasFutureEnrollments: boolean;
              futureEnrollmentsAlreadyPaid: boolean;
              isGroupMember: boolean;
            };
            contributions?: {
              totalEmployerContribution: number;
              totalEmployeeContribution: number;
              hasContributions: boolean;
              contributionDetails?: any;
            };
            authority?: {
              products: any;
              totals: {
                monthlyContribution: number;
                includedFeeTotal: number;
                nonIncludedFeeTotal: number;
                systemFees: number;
              };
              display: any;
              pricingFingerprint: string;
            } | null;
          }
        }>('/api/me/member/calculate-plan-change-cost', {
          selectedProducts,
          removedProducts,
          frontendPricing: pricingForValidation,
          configValues,
          initialConfigValues,
          dependentsToAdd: dependentsToAdd,
          newTobaccoUse: tobaccoUse !== memberProfile?.tobaccoUse ? tobaccoUse : null,
          calculatedTier: calculatedTier || null,
          memberId: memberId || undefined, // Include memberId for admin users (from props or URL params)
          effectiveDate: calculatedEffectiveDate || null // Pass effective date to select correct pricing tiers (prioritizes existing plan, falls back to API options)
        });
        
        console.log('📥 Backend response:', response);
        
        if (response.success && response.data) {
          console.log('✅ Backend calculation result:', response.data);
          console.log('📊 Backend contributions:', response.data.contributions);
          setCalculatedCharges(response.data);
          setFutureEnrollmentsAlreadyPaid(response.data.paymentStatus.futureEnrollmentsAlreadyPaid);
          setCalculationFailed(false);
          
          // Immediately update totalCosts if contributions are available
          const contributions = response.data.contributions;
          if (contributions && contributions.hasContributions) {
            console.log('🔄 Immediately updating totalCosts with backend contributions:', {
              employer: contributions.totalEmployerContribution,
              employee: contributions.totalEmployeeContribution
            });
            setTotalCosts(prev => ({
              ...prev,
              employerContribution: contributions.totalEmployerContribution,
              employeeContribution: contributions.totalEmployeeContribution
            }));
          }
        } else {
          console.warn('⚠️ Backend returned success=false or no data:', response);
          setCalculatedCharges(null);
          setCalculationFailed(true);
        }
      } catch (error: any) {
        console.error('❌ Failed to calculate charges:', error);
        setCalculationFailed(true);
        // If it's a 404, the endpoint might not be available or route might be wrong
        // Allow proceeding anyway - we'll calculate on the backend during actual submission
        if (error?.response?.status === 404) {
          console.warn('⚠️ Calculation endpoint returned 404 - proceeding without calculation. Backend will calculate during submission.');
        }
        // Set calculatedCharges to null but don't block the user from proceeding
        setCalculatedCharges(null);
      }
    }, 300);
    
    // Cleanup timer on unmount or when dependencies change
    return () => {
      if (calculationTimerRef.current) {
        console.log('🧹 Cleanup: clearing calculation timer');
        clearTimeout(calculationTimerRef.current);
        calculationTimerRef.current = null;
      }
    };
    // NOTE: configValues and initialConfigValues are NOT in dependencies
    // They're captured in the setTimeout closure, and adding them would cause
    // the useEffect to re-trigger on every config change, clearing the timer
    // Instead, we use recalculateTrigger which is manually incremented when needed
  }, [currentStep, selectedProducts, removedProducts, dependentsToAdd, tobaccoUse, calculatedTier, recalculateTrigger]);
  
  // ============================================================================
  // PRODUCT PRICING FUNCTIONS (Cloned from ProductChangePage with tier/tobacco overrides)
  // ============================================================================
  
  // Calculate projected household size for pricing
  const getProjectedHouseholdSize = () => {
    const currentDependents = getCurrentHouseholdMembers().length;
    const newDependentsCount = dependentsToAdd.length;
    return 1 + currentDependents + newDependentsCount; // 1 = primary member
  };

  // Always calculate tier from household composition (never use DB tier)
  // This ensures pricing and contributions use the correct tier based on actual household
  const getTierForPricing = (): string => {
    // If calculatedTier is already set (from useEffect), use it
    if (calculatedTier && calculatedTier !== 'EE') {
      return calculatedTier;
    }
    
    // Otherwise, calculate from current household composition
    if (householdData) {
      const currentMembers = getCurrentHouseholdMembers();
      const hasSpouse = currentMembers.some(m => m.relationshipType === 'S');
      const childrenCount = currentMembers.filter(m => m.relationshipType === 'C').length;
      const tierFromHousehold = PricingService.calculateMemberTier(hasSpouse, childrenCount);
      return tierFromHousehold;
    }
    
    // Last resort: use calculatedTier state (shouldn't reach here, but safe fallback)
    return calculatedTier || 'EE';
  };
  
  // Get product pricing with tier/tobacco overrides
  const getProductPricing = async (product: Product, overrideConfigValue?: string): Promise<number | null> => {
    if (!pricingData || !memberProfile || !householdData) {
      console.log('⚠️ Missing pricing data:', { pricingData: !!pricingData, memberProfile: !!memberProfile, householdData: !!householdData, isPricingDataLoading });
      return null;
    }

    try {
      // Use WIZARD OVERRIDES for tier and tobacco
      // Always calculate tier from household composition (never use DB tier)
      const tierForPricing = getTierForPricing();
      
      const memberCriteria = {
        age: memberProfile.age || 35,
        tobaccoUse: tobaccoUse || memberProfile.tobaccoUse || 'No', // WIZARD OVERRIDE
        tier: tierForPricing, // ALWAYS use calculated tier from household composition
        householdSize: getProjectedHouseholdSize() // USE PROJECTED HOUSEHOLD SIZE
      };

      const configValue = overrideConfigValue || configValues[product.productId] || 
        (product.requiredDataFields && product.requiredDataFields.length > 0 ? 
          product.requiredDataFields[0].fieldOptions[0] : 'Default');

      console.log('🔍 DEBUG: Wizard pricing criteria:', {
        memberId: memberProfile.id,
        groupId: memberProfile.groupId,
        memberCriteria,
        productId: product.productId,
        configValue,
        tierForPricing,
        dbTier: memberProfile.tier,
        calculatedTierState: calculatedTier,
        tobaccoOverride: tobaccoUse
      });

      const productConfigValues = { configValue1: configValue };

      // Use calculated effective date (prioritizes existing plan, falls back to API options)
      const effectiveDateForPricing = calculatedEffectiveDate;

      const pricing = await PricingService.calculatePricing({
        memberId: memberProfile.id || '',
        calculationType: 'enrollment',
        memberCriteria,
        groupId: memberProfile.groupId,
        productSelections: [{ 
          productId: product.productId,
          configValues: productConfigValues
        }],
        effectiveDate: effectiveDateForPricing || undefined // Pass effective date to select correct pricing tiers
      });

      // Check if backend reported pricing errors for this product
      if (pricing.pricingErrors && pricing.pricingErrors.length > 0) {
        const productError = pricing.pricingErrors.find(e => e.productId === product.productId);
        if (productError) {
          console.error(`⚠️ Backend reported pricing error for ${product.name}:`, productError);
          // Add to pricing errors set
          setPricingErrors(prev => new Set(prev).add(product.productId));
          return null;
        }
      }

      const productPricing = pricing.products?.find(p => p.productId === product.productId);
      // CRITICAL: Convert to Number to prevent string concatenation in bundle calculations
      const monthlyPremium = Number(productPricing?.monthlyPremium || product.basePrice || 0);
      
      console.log(`🔍 DEBUG: Wizard pricing result for ${product.name}:`, {
        productId: product.productId,
        configValue,
        monthlyPremium,
        monthlyPremiumType: typeof monthlyPremium,
        tierUsed: memberCriteria.tier,
        tobaccoUsed: memberCriteria.tobaccoUse
      });
      
      // Remove from pricing errors if pricing succeeded
      setPricingErrors(prev => {
        const newErrors = new Set(prev);
        newErrors.delete(product.productId);
        return newErrors;
      });
      
      return monthlyPremium;
    } catch (error) {
      console.error('Pricing calculation failed:', error);
      
      // Check if error is due to missing pricing configuration
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('No pricing found') || errorMessage.includes('pricing calculation failed')) {
        // Add product to pricing errors
        setPricingErrors(prev => new Set(prev).add(product.productId));
      }
      
      return null;
    }
  };

  // Calculate pricing for included products within bundles
  const getIncludedProductPricing = async (includedProduct: any, bundleProductId: string, overrideConfigValue?: string): Promise<number | null> => {
    if (!memberProfile || !householdData) return null;

    try {
      // Use WIZARD OVERRIDES for tier and tobacco
      const memberCriteria = {
        age: memberProfile.age || 35,
        tobaccoUse: tobaccoUse || memberProfile.tobaccoUse || 'No', // WIZARD OVERRIDE
        tier: calculatedTier || memberProfile.tier || 'EE', // WIZARD OVERRIDE
        householdSize: getProjectedHouseholdSize()
      };

      const bundleConfigKey = `${bundleProductId}-${includedProduct.productId}`;
      const configValue = overrideConfigValue || configValues[bundleConfigKey] || 
        (includedProduct.requiredDataFields && includedProduct.requiredDataFields.length > 0 ? 
          includedProduct.requiredDataFields[0].fieldOptions[0] : 'Default');

      const productConfigValues = { configValue1: configValue };

      console.log('🔍 DEBUG: getIncludedProductPricing criteria:', {
        productName: includedProduct.productName,
        productId: includedProduct.productId,
        bundleConfigKey,
        configValue,
        memberCriteria,
        groupId: memberProfile.groupId,
        isEssentialSharewell: includedProduct.productName === 'Essential (ShareWELL)',
        configValues: configValues,
        overrideConfigValue
      });

      // Use calculated effective date (prioritizes existing plan, falls back to API options)
      const effectiveDateForPricing = calculatedEffectiveDate;

      const pricing = await PricingService.calculatePricing({
        memberId: memberProfile.id || '',
        calculationType: 'enrollment',
        memberCriteria,
        groupId: memberProfile.groupId,
        productSelections: [{ 
          productId: includedProduct.productId,
          configValues: productConfigValues
        }],
        effectiveDate: effectiveDateForPricing || undefined // Pass effective date to select correct pricing tiers
      });

      // Check if backend reported pricing errors for this included product
      if (pricing.pricingErrors && pricing.pricingErrors.length > 0) {
        const productError = pricing.pricingErrors.find(e => e.productId === includedProduct.productId);
        if (productError) {
          console.error(`⚠️ Backend reported pricing error for bundle component ${includedProduct.productName}:`, productError);
          // Add bundle to pricing errors (not the individual included product)
          setPricingErrors(prev => new Set(prev).add(bundleProductId));
          return null;
        }
      }

      const productPricing = pricing.products?.find(p => p.productId === includedProduct.productId);
      // Ensure monthlyPremium is a NUMBER, not a string
      const monthlyPremium = Number(productPricing?.monthlyPremium || 0);
      
      console.log('🔍 DEBUG: getIncludedProductPricing result:', {
        productName: includedProduct.productName,
        monthlyPremium,
        monthlyPremiumType: typeof monthlyPremium,
        pricingResult: productPricing,
        isEssentialSharewell: includedProduct.productName === 'Essential (ShareWELL)',
        configValueUsed: configValue
      });
      
      // Special logging for Essential (ShareWELL) to track the $45 difference
      if (includedProduct.productName === 'Essential (ShareWELL)') {
        console.log('🔍 ESSENTIAL SHAREWELL DEBUG:', {
          productId: includedProduct.productId,
          bundleConfigKey,
          configValue,
          monthlyPremium,
          expectedBackendPrice: 155, // From backend logs
          difference: monthlyPremium - 155,
          memberCriteria,
          productConfigValues,
          isStandaloneProduct: selectedProducts.includes(includedProduct.productId),
          standaloneConfigValue: configValues[includedProduct.productId]
        });
      }
      
      // Remove bundle from pricing errors if pricing succeeded
      setPricingErrors(prev => {
        const newErrors = new Set(prev);
        newErrors.delete(bundleProductId);
        return newErrors;
      });
      
      return monthlyPremium;
    } catch (error) {
      console.error('Included product pricing calculation failed:', error);
      
      // Check if error is due to missing pricing configuration
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('No pricing found') || errorMessage.includes('pricing calculation failed')) {
        // Add bundle to pricing errors (not the individual included product)
        setPricingErrors(prev => new Set(prev).add(bundleProductId));
      }
      
      return null;
    }
  };

  // Calculate pricing for all included products in bundles
  const calculateIncludedProductPricing = async () => {
    if (!memberProfile || !householdData || !products.length) return;

    console.log('🔍 DEBUG: calculateIncludedProductPricing called', {
      productsCount: products.length,
      memberProfile: !!memberProfile,
      householdData: !!householdData
    });

    const newIncludedProductPrices: Record<string, number> = {};
    const newBundlePrices: Record<string, number> = {};

    for (const product of products) {
      if (product.isBundle && product.includedProducts) {
        console.log('🔍 DEBUG: Processing bundle', product.name, {
          includedProductsCount: product.includedProducts.length
        });
        
        let bundleTotal = 0;
        for (const includedProduct of product.includedProducts) {
          const bundleConfigKey = `${product.productId}-${includedProduct.productId}`;
          // USE THE ACTUAL SELECTED CONFIG VALUE, not the default!
          const selectedConfigValue = configValues[bundleConfigKey] || 
            (includedProduct.requiredDataFields && includedProduct.requiredDataFields.length > 0 ? 
              includedProduct.requiredDataFields[0].fieldOptions[0] : 'Default');
          
          console.log('🔍 DEBUG: Calculating pricing for included product', {
            productName: includedProduct.productName,
            bundleConfigKey,
            selectedConfigValue,
            configValues: configValues[bundleConfigKey],
            isEssentialSharewell: includedProduct.productName === 'Essential (ShareWELL)',
            allConfigValues: Object.keys(configValues).filter(key => key.includes(includedProduct.productId))
          });
          
          const pricing = await getIncludedProductPricing(includedProduct, product.productId, selectedConfigValue);
          // Ensure pricing is a NUMBER before adding to total
          const pricingAsNumber = Number(pricing ?? 0);
          newIncludedProductPrices[bundleConfigKey] = pricingAsNumber;
          bundleTotal += pricingAsNumber;
          
          console.log('🔍 DEBUG: Included product pricing result', {
            productName: includedProduct.productName,
            pricing,
            pricingType: typeof pricing,
            pricingAsNumber,
            bundleTotal,
            bundleTotalType: typeof bundleTotal
          });
        }
        newBundlePrices[product.productId] = bundleTotal;
        
        console.log('🔍 DEBUG: Bundle total calculated', {
          bundleName: product.name,
          bundleTotal,
          includedProductPrices: Object.keys(newIncludedProductPrices).length
        });
      }
    }

    console.log('🔍 DEBUG: Setting included product prices', newIncludedProductPrices);
    console.log('🔍 DEBUG: Setting bundle prices', newBundlePrices);

    setIncludedProductPrices(newIncludedProductPrices);
    setProductPrices(prev => ({
      ...prev,
      ...newBundlePrices
    }));
  };

  // Calculate total bundle price from included products
  const getBundleTotalPrice = (bundleProduct: Product) => {
    if (!bundleProduct.isBundle || !bundleProduct.includedProducts) {
      return bundleProduct.basePrice;
    }

    // Use the bundle price from productPrices if available (set by calculateIncludedProductPricing)
    const bundlePrice = Number(productPrices[bundleProduct.productId] || 0);
    
    console.log('🔍 DEBUG: getBundleTotalPrice called:', {
      bundleName: bundleProduct.name,
      bundleId: bundleProduct.productId.substring(0, 8),
      bundlePrice,
      hasBundlePrice: bundlePrice > 0,
      productPricesKeys: Object.keys(productPrices).map(k => k.substring(0, 8)),
      allProductPrices: Object.entries(productPrices).reduce((acc, [k, v]) => {
        acc[k.substring(0, 8)] = v;
        return acc;
      }, {} as Record<string, any>)
    });
    
    if (bundlePrice > 0) {
      console.log('✅ DEBUG: Using pre-calculated bundle price for', bundleProduct.name, ':', bundlePrice);
      return bundlePrice;
    }

    // Fallback: calculate from included products (for cases where calculateIncludedProductPricing hasn't run yet)
    let total = 0;
    let hasLoadingPrices = false;
    
    console.log('🔍 DEBUG: getBundleTotalPrice fallback for', bundleProduct.name, {
      includedProducts: bundleProduct.includedProducts.length,
      includedProductPrices: Object.keys(includedProductPrices).length,
      productPricesValue: productPrices[bundleProduct.productId]
    });
    
    for (const includedProduct of bundleProduct.includedProducts) {
      const bundleConfigKey = `${bundleProduct.productId}-${includedProduct.productId}`;
      // CRITICAL: Ensure price is a number to prevent string concatenation
      const price = Number(includedProductPrices[bundleConfigKey] || 0);
      total += price;
      
      console.log('🔍 DEBUG: Included product pricing:', {
        productName: includedProduct.productName,
        bundleConfigKey,
        price,
        configValue: configValues[bundleConfigKey]
      });
      
      if (price === 0) {
        hasLoadingPrices = true;
      }
    }

    console.log('🔍 DEBUG: Bundle total calculated (fallback):', {
      bundleName: bundleProduct.name,
      total,
      hasLoadingPrices
    });

    return hasLoadingPrices ? 0 : total;
  };
  
  // Filter contribution rules by member criteria (job position, age, etc.) - matching EnrollmentWizard pattern
  const filterRulesByMemberCriteria = (rules: any[], memberCriteria?: { age?: number; jobPosition?: string }) => {
    if (!memberCriteria) return rules;
    
    return rules.filter((rule: any) => {
      // Filter by job position (if rule has JobPositions filter)
      if (rule.JobPositions) {
        try {
          const jobPositions = typeof rule.JobPositions === 'string' 
            ? JSON.parse(rule.JobPositions) 
            : rule.JobPositions;
          
          // If job positions array exists and has items, member must match
          if (Array.isArray(jobPositions) && jobPositions.length > 0) {
            const memberJobPosition = memberCriteria.jobPosition;
            
            if (!memberJobPosition || !jobPositions.includes(memberJobPosition)) {
              console.log(`❌ Rule "${rule.Name}" filtered out - job position mismatch:`, {
                memberJobPosition,
                ruleJobPositions: jobPositions
              });
              return false; // Member's job position doesn't match filter
            }
            
            console.log(`✅ Rule "${rule.Name}" passed job position filter:`, memberJobPosition);
          }
          // If empty array or null, applies to all job positions (fall through)
        } catch (error) {
          console.warn(`Error parsing rule JobPositions: ${error instanceof Error ? error.message : String(error)}`);
          // Continue to other checks if parsing fails
        }
      }
      
      // TODO: Add age filtering if needed (for age_based rules)
      // The ContributionCalculator will handle age-based filtering internally
      
      return true;
    });
  };

  // Transform group contribution rules to ContributionCalculator format
  const transformContributionRules = (rules: any[]) => {
    return rules.map((rule: any) => {
      const contributionType = rule.ContributionType || rule.contributionType || 'flat_rate';
      
      // Parse ageRules for age_based contributions
      let ageRules = undefined;
      if (contributionType === 'age_based' && (rule.AgeRules || rule.ageRules)) {
        try {
          const ageRulesData = typeof (rule.AgeRules || rule.ageRules) === 'string' 
            ? JSON.parse(rule.AgeRules || rule.ageRules) 
            : (rule.AgeRules || rule.ageRules);
          
          // Transform to ContributionCalculator format (ensure maxAge can be null)
          ageRules = Array.isArray(ageRulesData) ? ageRulesData.map((ageRule: any) => ({
            minAge: ageRule.minAge ?? ageRule.min_age ?? 0,
            maxAge: ageRule.maxAge !== undefined ? ageRule.maxAge : (ageRule.max_age !== undefined ? ageRule.max_age : null),
            contributionAmount: ageRule.contributionAmount ?? ageRule.contribution_amount ?? 0,
            contributionType: ageRule.contributionType ?? ageRule.contribution_type ?? 'flat'
          })) : undefined;
        } catch (e) {
          console.error('Error parsing ageRules:', e);
          ageRules = undefined;
        }
      }
      
      return {
        type: contributionType === 'flat_rate' ? 'flat_rate' : 
              contributionType === 'percentage' ? 'percentage' :
              contributionType === 'tier_based' ? 'tier_based' :
              contributionType === 'age_based' ? 'age_based' : 'flat_rate',
        amount: contributionType === 'flat_rate' ? (rule.FlatRateAmount || rule.flatRateAmount || 0) : 
                contributionType === 'percentage' ? (rule.PercentageAmount || rule.percentageAmount || 0) : 0,
        description: rule.Name || rule.name || '',
        appliesTo: (rule.ProductId || rule.productId) ? 'product' : 'all_products',
        contributionDirection: rule.ContributionDirection || rule.contributionDirection || 'Employer',
        tierContributions: contributionType === 'tier_based' && (rule.TierContributions || rule.tierContributions) ? 
          (typeof (rule.TierContributions || rule.tierContributions) === 'string' 
            ? JSON.parse(rule.TierContributions || rule.tierContributions) 
            : (rule.TierContributions || rule.tierContributions)) : 
          undefined,
        ageRules: ageRules,
        jobPositions: (rule.JobPositions || rule.jobPositions) ? 
          (typeof (rule.JobPositions || rule.jobPositions) === 'string' 
            ? JSON.parse(rule.JobPositions || rule.jobPositions) 
            : (rule.JobPositions || rule.jobPositions)) : 
          undefined
      };
    });
  };

  // Transform product data to ContributionCalculator format
  const transformProductForContributionCalculator = async (product: Product, selectedConfig: string) => {
    let monthlyPremium = 0;
    
    if (product.isBundle) {
      monthlyPremium = getBundleTotalPrice(product);
    } else {
      const price = await getProductPricing(product);
      monthlyPremium = price ?? 0;
    }

    // Get product-specific rules (don't pre-filter - let ContributionCalculator handle filtering)
    const productRules = (Array.isArray(groupContributionRules) ? groupContributionRules : [])
      .filter(rule => rule.ProductId === product.productId && rule.Status === 'Active');
    
    // Transform rules but don't filter - ContributionCalculator will filter by memberCriteria
    const transformedRules = transformContributionRules(productRules);

    console.log('🔍 DEBUG: transformProductForContributionCalculator:', {
      productId: product.productId,
      productName: product.name,
      monthlyPremium,
      productSpecificRulesCount: productRules.length,
      productSpecificRules: productRules.map(r => ({ Name: r.Name, ProductId: r.ProductId, FlatRateAmount: r.FlatRateAmount }))
    });

    return {
      productId: product.productId,
      productName: product.name,
      description: product.description,
      productType: product.productType,
      isBundle: product.isBundle || false,
      contributionRules: transformedRules,
      pricingVariations: [{
        configValue: selectedConfig,
        monthlyPremium: monthlyPremium,
        employerContribution: 0,
        employeeContribution: monthlyPremium
      }]
    };
  };

  // Calculate total cost for selected products
  const getSelectedProductsTotalCost = async () => {
    if (!selectedProducts.length) {
      return 0;
    }

    const selectedProductsData = [];
    const selectedConfigsForCalc: Record<string, string> = {};
    
    for (const productId of selectedProducts) {
      if (removedProducts.includes(productId)) {
        continue;
      }
      
      const product = products.find(p => p.productId === productId);
      if (product) {
        const selectedConfig = configValues[productId] || (product.isBundle ? '1500' : 'Default');
        selectedConfigsForCalc[productId] = selectedConfig;
        
        const transformedProduct = await transformProductForContributionCalculator(product, selectedConfig);
        selectedProductsData.push(transformedProduct);
      }
    }
    
    // If all products were removed, return 0
    if (selectedProductsData.length === 0) {
      console.log('🔍 DEBUG: All products removed - returning 0');
      return 0;
    }

    // Filter all-products rules by status and member criteria (job position)
    const memberCriteria = {
      age: memberProfile?.age || 35,
      jobPosition: memberProfile?.jobPosition
    };
    
    const allProductsRules = (Array.isArray(groupContributionRules) ? groupContributionRules : [])
      .filter((rule: any) => !rule.ProductId && rule.Status === 'Active');
    
    // Don't pre-filter - let ContributionCalculator handle filtering by memberCriteria
    const transformedAllProductsRules = transformContributionRules(allProductsRules);

    console.log('🔍 DEBUG: Before ContributionCalculator.calculateTotalContributions:', {
      selectedProductsDataCount: selectedProductsData.length,
      selectedProductsData: selectedProductsData.map(p => ({ 
        productName: p.productName, 
        monthlyPremium: p.pricingVariations[0].monthlyPremium,
        contributionRulesCount: p.contributionRules.length
      })),
      allProductsRulesCount: transformedAllProductsRules.length,
      allProductsRules: transformedAllProductsRules.map(r => ({ type: r.type, amount: r.amount, description: r.description })),
      memberCriteria,
      groupContributionRulesRaw: (Array.isArray(groupContributionRules) ? groupContributionRules : []).map(r => ({ 
        Name: r.Name, 
        ProductId: r.ProductId, 
        FlatRateAmount: r.FlatRateAmount,
        JobPositions: r.JobPositions
      }))
    });

    const contributionResult = ContributionCalculator.calculateTotalContributions(
      selectedProductsData,
      selectedConfigsForCalc,
      transformedAllProductsRules,
      calculatedTier || memberProfile?.tier || 'EE',
      memberCriteria // Pass memberCriteria for additional filtering in ContributionCalculator
    );

    console.log('🔍 DEBUG: getSelectedProductsTotalCost ContributionCalculator result:', {
      selectedProductsData: selectedProductsData.map(p => p.productName),
      contributionResult,
      totalEmployeeContribution: contributionResult.totals.totalEmployeeContribution,
      totalEmployerContribution: contributionResult.totals.totalEmployerContribution,
      totalPremium: contributionResult.totals.totalPremium
    });

    return contributionResult.totals.totalEmployeeContribution;
  };

  // Calculate current enrollments total cost
  // Matches MemberPlansTab logic: includes ALL Active enrollments (including future effective)
  // Get raw enrollments for current user (needed to access Contribution enrollments)
  // When managing for another member, we already have memberSpecificEnrollmentsRaw
  // When managing for self, we need to fetch raw enrollments separately
  const { data: currentUserRawEnrollments } = useQuery({
    queryKey: ['currentUserRawEnrollments', 'forContributions'],
    queryFn: async () => {
      if (isManagingForMember) {
        // When managing for another member, return empty - we'll use memberSpecificEnrollmentsRaw
        return [];
      }
      // When managing for self, fetch raw enrollments
      const response = await MemberEnrollmentService.getMyEnrollments();
      if (!response.success) {
        if (response.message?.includes('Member record not found')) {
          return [];
        }
        throw new Error(response.message || 'Failed to fetch enrollments');
      }
      return response.data || [];
    },
    enabled: !isManagingForMember && !!groupedEnrollments, // Only fetch when managing for self and we have grouped enrollments
    staleTime: 5 * 60 * 1000,
  });

  // Get Contribution enrollments (matching MemberPlansTab logic)
  const allContributionEnrollments = React.useMemo(() => {
    const rawEnrollments = isManagingForMember ? (memberSpecificEnrollmentsRaw || []) : (currentUserRawEnrollments || []);
    if (!rawEnrollments || rawEnrollments.length === 0) return [];
    
    return rawEnrollments.filter((e: any) => {
      const isActive = e.status === 'Active' || e.Status === 'Active';
      const isContribution = e.enrollmentType === 'Contribution' || e.EnrollmentType === 'Contribution';
      return isActive && isContribution;
    });
  }, [isManagingForMember, memberSpecificEnrollmentsRaw, currentUserRawEnrollments]);

  // Calculate current monthly premium (sum of Product enrollments only, excluding fees)
  const getCurrentMonthlyPremium = async () => {
    if (!groupedEnrollments) return 0;
    
    // Filter to only active product enrollments (exclude fees and contributions)
    const activeProductEnrollments = groupedEnrollments.filter(ge => {
      if (ge.status !== 'Active') return false;
      const enrollmentType = ge.primaryEnrollment?.enrollmentType || ge.enrollments?.[0]?.enrollmentType;
      return isProductEnrollment(enrollmentType);
    });
    
    // Calculate total product premium from Product enrollments only (no fees)
    const totalProductPremium = activeProductEnrollments.reduce((sum: number, ge: any) => 
      sum + (ge.totalPremium || 0), 0
    );
    
    console.log('🔍 DEBUG: getCurrentMonthlyPremium:', {
      totalGroupedEnrollments: groupedEnrollments.length,
      activeProductEnrollmentsCount: activeProductEnrollments.length,
      totalProductPremium,
      activeProductEnrollments: activeProductEnrollments.map(ge => ({
        type: ge.type,
        productId: ge.type === 'bundle' ? ge.bundleId : ge.primaryEnrollment?.productId,
        totalPremium: ge.totalPremium
      }))
    });
    
    return totalProductPremium;
  };

  const getCurrentEnrollmentsTotalCost = async () => {
    if (!groupedEnrollments) return 0;
    
    // Calculate contributions from enrollments directly (no dynamic rule application)
    // This matches the logic in MemberPlansTab - see docs/contributions/contribution-calculation.md
    const activeGroupedEnrollments = groupedEnrollments.filter(ge => ge.status === 'Active');
    
    // Calculate total product premium from Product enrollments only
    // Sum all active grouped enrollments (which are already filtered to Product enrollments)
    const totalProductPremium = activeGroupedEnrollments.reduce((sum: number, ge: any) => 
      sum + (ge.totalPremium || 0), 0
    );
    
    // Calculate employer contribution from Contribution enrollments only
    // Never recalculate from rules - use the hard-saved values in the database
    const totalEmployerContribution = allContributionEnrollments.reduce((sum: number, e: any) => {
      const employerContrib = e.employerContributionAmount || e.EmployerContributionAmount || 0;
      return sum + employerContrib;
    }, 0);
    
    // Calculate employee contribution: totalPremium - employerContribution
    // This is ALWAYS calculated as premium - employer, never from contribution rules
    const totalMonthlyContribution = Math.max(0, totalProductPremium - totalEmployerContribution);
    
    console.log('🔍 DEBUG: getCurrentEnrollmentsTotalCost (from enrollments):', {
      totalProductPremium,
      totalEmployerContribution,
      totalMonthlyContribution,
      calculation: `${totalProductPremium} - ${totalEmployerContribution} = ${totalMonthlyContribution}`,
      contributionEnrollmentCount: allContributionEnrollments.length,
      activeGroupedEnrollmentsCount: activeGroupedEnrollments.length
    });
    
    return totalMonthlyContribution;
  };
  
  // Calculate contributions for products using the contribution system
  const calculateProductContributions = async (productsData: Product[], configs: Record<string, string>) => {
    if (!memberProfile || !householdData) return;

    try {
      // For each product, calculate contributions
      const updatedProducts = await Promise.all(productsData.map(async (product) => {
        const configValue = configs[product.productId] || product.requiredDataFields[0]?.fieldOptions[0] || 'Default';
        
        const contributionResult = ContributionCalculator.calculateProductContributions(
          {
            productId: product.productId,
            productName: product.name,
            isBundle: product.isBundle || false,
            pricingVariations: [{
              configValue,
              monthlyPremium: product.basePrice
            }],
            contributionRules: []
          },
          configValue
        );

        return {
          ...product,
          monthlyPremium: contributionResult.employer + contributionResult.employee,
          employerContribution: contributionResult.employer,
          employeeContribution: contributionResult.employee,
          contributionRules: []
        };
      }));

      setProducts(updatedProducts);
    } catch (error) {
      console.warn('Failed to calculate product contributions:', error);
    }
  };
  
  // Load products and enrollments data
  const loadProductData = async () => {
    try {
      setProductsLoading(true);
      setError(null);

      // Use unified service that routes to correct endpoint based on memberId
      // - If memberId provided: Admin managing member (uses /api/members/{memberId}/...)
      // - If no memberId: Member managing themselves (uses /api/me/member/...)
      console.log('🔍 ProductChangeWizard: Loading product data for member:', memberId || 'current user');
      console.log('🔍 DEBUG: groupedEnrollments state:', {
        isManagingForMember,
        hasGroupedEnrollments: !!groupedEnrollments,
        groupedEnrollmentsLength: groupedEnrollments?.length || 0,
        groupedEnrollments: groupedEnrollments?.map(ge => ({
          type: ge.type,
          bundleId: ge.bundleId,
          status: ge.status,
          effectiveDate: ge.effectiveDate,
          productId: ge.type === 'bundle' ? ge.bundleId : ge.primaryEnrollment?.productId,
          productName: ge.type === 'bundle' ? ge.bundleName : ge.primaryEnrollment?.product?.name
        }))
      });
      
      const [productsResponse, enrollmentsResponse] = await Promise.all([
        MemberProductManagementService.getAvailableProducts(memberId),
        MemberProductManagementService.getMemberEnrollments(memberId)
      ]);

      console.log('🔍 DEBUG: API responses:', {
        productsSuccess: productsResponse.success,
        productsCount: productsResponse.data?.length || 0,
        enrollmentsSuccess: enrollmentsResponse.success,
        enrollmentsCount: enrollmentsResponse.data?.length || 0,
        enrollmentsData: enrollmentsResponse.data?.map((e: any) => ({
          enrollmentId: e.enrollmentId || e.EnrollmentId,
          productId: e.productId || e.ProductId,
          status: e.status || e.Status,
          effectiveDate: e.effectiveDate || e.EffectiveDate,
          productName: e.product?.name || e.ProductName
        }))
      });

      if (productsResponse.success && enrollmentsResponse.success) {
        const productsData = productsResponse.data;
        const enrollmentsData = enrollmentsResponse.data;

        const currentEnrollments = enrollmentsData.filter(e => e.status === 'Active');
        const enrolledProductIds: string[] = [];
        
        // Helper function to check if enrollment is future (effective date > today)
        const isFutureEffectiveDate = (effectiveDate: string | undefined): boolean => {
          if (!effectiveDate) return false;
          const effective = new Date(effectiveDate);
          const today = new Date();
          effective.setHours(0, 0, 0, 0);
          today.setHours(0, 0, 0, 0);
          return effective > today;
        };
        
        // Use grouped enrollments to determine enrolled products
        // Include both Active enrollments AND future effective enrollments (so they can be cancelled)
        // NOTE: Future enrollments can have status 'Active' OR 'Pending' - we check by effective date
        console.log('🔍 DEBUG: Determining enrolled products:', {
          hasGroupedEnrollments: !!groupedEnrollments,
          groupedEnrollmentsLength: groupedEnrollments?.length || 0,
          enrollmentsDataLength: enrollmentsData?.length || 0
        });
        
        if (groupedEnrollments && groupedEnrollments.length > 0) {
          console.log('🔍 DEBUG: Using groupedEnrollments to determine enrolled products');
          groupedEnrollments.forEach(groupedEnrollment => {
            // Get effective date for this enrollment
            const effectiveDate = groupedEnrollment.type === 'bundle' 
              ? groupedEnrollment.enrollments?.[0]?.effectiveDate
              : groupedEnrollment.primaryEnrollment?.effectiveDate;
            
            const isFuture = isFutureEffectiveDate(effectiveDate);
            const isActive = groupedEnrollment.status === 'Active';
            const isPending = groupedEnrollment.status === 'Pending';
            
            console.log('🔍 DEBUG: Processing grouped enrollment:', {
              type: groupedEnrollment.type,
              bundleId: groupedEnrollment.bundleId,
              productId: groupedEnrollment.type === 'bundle' ? groupedEnrollment.bundleId : groupedEnrollment.primaryEnrollment?.productId,
              status: groupedEnrollment.status,
              effectiveDate,
              isFuture,
              isActive,
              isPending,
              willInclude: isActive || (isPending && isFuture)
            });
            
            // Include ALL enrollments that are:
            // 1. Active (regardless of effective date) - covers both current and future Active enrollments
            // 2. Pending with future effective date - so they can be cancelled
            // EXCLUDE non-product enrollments (Contribution, PaymentProcessingFee, SystemFee, etc.)
            if (isActive || (isPending && isFuture)) {
              // Check if this is a product enrollment (not a fee or contribution)
              const enrollmentType = groupedEnrollment.primaryEnrollment?.enrollmentType || 
                                    groupedEnrollment.enrollments?.[0]?.enrollmentType;
              
              if (!isProductEnrollment(enrollmentType)) {
                console.log('⏭️ Skipping non-product enrollment:', {
                  type: groupedEnrollment.type,
                  enrollmentType,
                  productId: groupedEnrollment.type === 'bundle' ? groupedEnrollment.bundleId : groupedEnrollment.primaryEnrollment?.productId
                });
                return; // Skip non-product enrollments
              }
              
              if (groupedEnrollment.type === 'bundle' && groupedEnrollment.bundleId) {
                if (!enrolledProductIds.includes(groupedEnrollment.bundleId)) {
                  enrolledProductIds.push(groupedEnrollment.bundleId);
                  console.log('✅ Added bundle product to enrolled list:', groupedEnrollment.bundleId);
                }
              } else if (groupedEnrollment.type === 'individual' && groupedEnrollment.primaryEnrollment) {
                const productId = groupedEnrollment.primaryEnrollment.productId;
                if (!enrolledProductIds.includes(productId)) {
                  enrolledProductIds.push(productId);
                  console.log('✅ Added individual product to enrolled list:', productId);
                }
              }
            }
          });
        } else {
          console.log('🔍 DEBUG: Falling back to enrollmentsData (groupedEnrollments not available)');
          // Fallback: include both active and future enrollments from raw enrollmentsData
          // EXCLUDE non-product enrollments (use EnrollmentType to filter)
          
          // First, include all Active product enrollments
          enrollmentsData.forEach(enrollment => {
            if (enrollment.status === 'Active' && isProductEnrollment(enrollment.enrollmentType)) {
              if (!enrolledProductIds.includes(enrollment.productId)) {
                enrolledProductIds.push(enrollment.productId);
                console.log('✅ Added Active product enrollment to enrolled list:', enrollment.productId);
              }
            }
          });
          
          // Also check for future enrollments in enrollmentsData (Active or Pending status)
          enrollmentsData.forEach(enrollment => {
            const isFuture = isFutureEffectiveDate(enrollment.effectiveDate);
            if (isProductEnrollment(enrollment.enrollmentType) && isFuture && (enrollment.status === 'Active' || enrollment.status === 'Pending')) {
              if (!enrolledProductIds.includes(enrollment.productId)) {
                enrolledProductIds.push(enrollment.productId);
                console.log('✅ Added future product enrollment to enrolled list:', enrollment.productId, 'status:', enrollment.status);
              }
            }
          });
        }
        
        // No need to filter - we already filtered by EnrollmentType above
        console.log('🔍 DEBUG: Final enrolledProductIds (filtered by EnrollmentType):', enrolledProductIds);
        
        // Set up configuration values
        const initialConfigs: Record<string, string> = {};
        
        // Set configs from enrollment details OR infer from grouped enrollments
        // Include both Active and future effective enrollments for config loading
        if (groupedEnrollments) {
          groupedEnrollments.forEach(ge => {
            // Get effective date to check if it's future
            const effectiveDate = ge.type === 'bundle' 
              ? ge.enrollments?.[0]?.effectiveDate
              : ge.primaryEnrollment?.effectiveDate;
            const isFuture = isFutureEffectiveDate(effectiveDate);
            
            // Process Active enrollments OR future effective enrollments (Active or Pending)
            if ((ge.status as string) === 'Active' || (isFuture && ((ge.status as string) === 'Active' || (ge.status as string) === 'Pending'))) {
              // Try to get config from enrollment details first
              let configFound = false;
              
              if (ge.primaryEnrollment?.enrollmentDetails) {
                try {
                  const details = JSON.parse(ge.primaryEnrollment.enrollmentDetails);
                  if (details.configuration) {
                    const productId = ge.type === 'bundle' ? ge.bundleId : ge.primaryEnrollment?.productId;
                    if (productId) {
                      initialConfigs[productId] = details.configuration;
                      configFound = true;
                    }
                  }
                  if (details.bundleConfigurations) {
                    console.log('🔍 DEBUG: Loading bundle configurations:', details.bundleConfigurations);
                    Object.keys(details.bundleConfigurations).forEach(bundleConfigKey => {
                      initialConfigs[bundleConfigKey] = details.bundleConfigurations[bundleConfigKey];
                      console.log('🔍 DEBUG: Set bundle config:', bundleConfigKey, '=', details.bundleConfigurations[bundleConfigKey]);
                    });
                    configFound = true;
                  }
                } catch (e) {
                  console.warn('Failed to parse enrollment details:', e);
                }
              }
              
              // If config not found in details, try to infer from premium amount
              if (!configFound && ge.type === 'individual' && ge.primaryEnrollment) {
                const productId = ge.primaryEnrollment.productId;
                const enrolledPremium = ge.primaryEnrollment.premiumAmount;
                const product = productsData.find(p => p.productId === productId);
                
                if (product?.requiredDataFields && product.requiredDataFields.length > 0) {
                  console.log(`🔍 Attempting to infer config for ${product.name} from enrolled premium: $${enrolledPremium}`);
                  
                  let matchedConfig: string | null = null;
                  
                  // Smart inference for Essential ShareWELL based on pricing table
                  if (product.name === 'Essential (ShareWELL)') {
                    const currentTier = memberProfile?.tier || 'EE';
                    const currentTobacco = memberProfile?.tobaccoUse || 'No';
                    
                    // Match premium to known configurations
                    if (currentTier === 'EE' && currentTobacco === 'No') {
                      if (enrolledPremium === 200) matchedConfig = '1500';
                      else if (enrolledPremium === 155) matchedConfig = '3000';
                      else if (enrolledPremium === 125) matchedConfig = '6000';
                    } else if (currentTier === 'ES' && currentTobacco === 'No') {
                      if (enrolledPremium === 375) matchedConfig = '1500';
                      else if (enrolledPremium === 285) matchedConfig = '3000';
                      else if (enrolledPremium === 225) matchedConfig = '6000';
                    }
                    // Add more tier/tobacco combinations as needed
                  }
                  
                  if (matchedConfig) {
                    initialConfigs[productId] = matchedConfig;
                    console.log(`✅ Inferred config for ${product.name}: ${matchedConfig} (from premium $${enrolledPremium})`);
                  } else {
                    // Fallback: use first option, but log a warning
                    const field = product.requiredDataFields[0];
                    initialConfigs[productId] = field.fieldOptions[0];
                    console.warn(`⚠️ Could not infer config for ${product.name}, defaulting to ${field.fieldOptions[0]}`);
                  }
                }
              }
            }
          });
        } else {
          // Fallback: use old enrollment details parsing
          currentEnrollments.forEach(enrollment => {
            if (enrollment.enrollmentDetails) {
              try {
                const details = JSON.parse(enrollment.enrollmentDetails);
                if (details.configuration) {
                  initialConfigs[enrollment.productId] = details.configuration;
                }
                if (details.bundleConfigurations) {
                  Object.keys(details.bundleConfigurations).forEach(bundleConfigKey => {
                    initialConfigs[bundleConfigKey] = details.bundleConfigurations[bundleConfigKey];
                  });
                }
              } catch (e) {
                console.warn('Failed to parse enrollment details:', e);
              }
            }
          });
        }
        
        // Set default configs for all products
        productsData.forEach(product => {
          if (product.requiredDataFields && product.requiredDataFields.length > 0) {
            if (!initialConfigs[product.productId]) {
              const firstField = product.requiredDataFields[0];
              if (firstField.fieldOptions && firstField.fieldOptions.length > 0) {
                initialConfigs[product.productId] = firstField.fieldOptions[0];
              }
            }
          }
          
          // Set up configs for included products within bundles
          if (product.isBundle && product.includedProducts) {
            product.includedProducts.forEach((includedProduct: any) => {
              if (includedProduct.requiredDataFields && includedProduct.requiredDataFields.length > 0) {
                const bundleConfigKey = `${product.productId}-${includedProduct.productId}`;
                if (!initialConfigs[bundleConfigKey]) {
                  const firstField = includedProduct.requiredDataFields[0];
                  if (firstField.fieldOptions && firstField.fieldOptions.length > 0) {
                    initialConfigs[bundleConfigKey] = firstField.fieldOptions[0];
                    console.log('🔍 DEBUG: Set default bundle config for', includedProduct.productName, ':', bundleConfigKey, '=', firstField.fieldOptions[0]);
                    
                    // ALSO set bundle-level config to match (for pricing consistency)
                    if (!initialConfigs[product.productId]) {
                      initialConfigs[product.productId] = firstField.fieldOptions[0];
                      console.log('🔍 DEBUG: Set bundle-level config to match sub-product:', product.productId, '=', firstField.fieldOptions[0]);
                    }
                  }
                } else {
                  console.log('🔍 DEBUG: Using existing bundle config for', includedProduct.productName, ':', bundleConfigKey, '=', initialConfigs[bundleConfigKey]);
                  
                  // Ensure bundle-level config matches sub-product config
                  if (!initialConfigs[product.productId]) {
                    initialConfigs[product.productId] = initialConfigs[bundleConfigKey];
                    console.log('🔍 DEBUG: Set bundle-level config to match existing sub-product:', product.productId, '=', initialConfigs[bundleConfigKey]);
                  }
                }
              }
            });
          }
        });
        
        console.log('🔍 DEBUG: Final initialConfigs loaded:', initialConfigs);
        setConfigValues(initialConfigs);
        setInitialConfigValues({ ...initialConfigs });
        setSelectedConfigs(initialConfigs);

        setProducts(productsData);
        setEnrollments(enrollmentsData);
        // No need to filter - we already filtered by EnrollmentType when collecting enrollments
        setSelectedProducts(enrolledProductIds);
        setInitialSelectedProducts([...enrolledProductIds]);

        await calculateProductContributions(productsData, initialConfigs);
      } else {
        setError('Failed to load product data');
      }
    } catch (err) {
      console.error('Error loading data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setProductsLoading(false);
    }
  };
  
  // Handle configuration changes for products
  const handleConfigChange = async (productId: string, configValue: string) => {
    // ✅ ALLOW config changes on future enrollments
    // Backend will calculate proper "Due Today" amount for paid future enrollments
    
    console.log('🔍 handleConfigChange called:', {
      productId: productId.substring(0, 8),
      configValue,
      isFutureEnrollment: isFutureEnrollment(productId)
    });
    
    const newConfigValues = {
      ...configValues,
      [productId]: configValue
    };
    setConfigValues(newConfigValues);
    
    const newSelectedConfigs = {
      ...selectedConfigs,
      [productId]: configValue
    };
    setSelectedConfigs(newSelectedConfigs);
    
    console.log('✅ Config values updated:', {
      productId: productId.substring(0, 8),
      newValue: configValue,
      allConfigValues: Object.keys(newConfigValues)
    });
    
    // Immediately recalculate pricing with tier/tobacco overrides
    const product = products.find(p => p.productId === productId);
    
    console.log('🔍 DEBUG: handleConfigChange - found product:', {
      productId: productId.substring(0, 8),
      productFound: !!product,
      productName: product?.name,
      hasMemberProfile: !!memberProfile,
      hasHouseholdData: !!householdData,
      currentPriceInState: productPrices[productId]
    });
    
    if (product && memberProfile && householdData) {
      try {
        console.log('🔍 DEBUG: Calling getProductPricing with config:', configValue);
        const newPrice = await getProductPricing(product, configValue);
        
        console.log('🔍 DEBUG: getProductPricing returned:', {
          newPrice,
          newPriceType: typeof newPrice,
          isNull: newPrice === null,
          isZero: newPrice === 0
        });
        
        if (newPrice !== null) {
          console.log('✅ DEBUG: Updating productPrices state:', {
            productId: productId.substring(0, 8),
            oldPrice: productPrices[productId],
            newPrice,
            difference: newPrice - (productPrices[productId] || 0)
          });
          
          setProductPrices(prev => {
            const updated = {
              ...prev,
              [productId]: newPrice
            };
            
            console.log('💰 DEBUG: setProductPrices callback executed:', {
              productId: productId.substring(0, 8),
              prevPrice: prev[productId],
              newPrice,
              allPricesAfterUpdate: Object.entries(updated).reduce((acc, [k, v]) => {
                acc[k.substring(0, 8)] = v;
                return acc;
              }, {} as Record<string, any>)
            });
            
            return updated;
          });
        } else {
          console.warn('⚠️ DEBUG: getProductPricing returned null, not updating price');
        }
      } catch (error) {
        console.error('❌ DEBUG: Pricing calculation failed:', error);
      }
    } else {
      console.warn('⚠️ DEBUG: Skipping pricing recalculation - missing required data:', {
        hasProduct: !!product,
        hasMemberProfile: !!memberProfile,
        hasHouseholdData: !!householdData
      });
    }
    
    // Trigger backend recalculation on review page
    const currentStepData = steps[currentStep];
    if (currentStepData?.id === 'review') {
      console.log('🔄 DEBUG: Triggering backend recalculation (on review step)');
      setRecalculateTrigger(prev => prev + 1);
    }
  };

  // Handle configuration changes for included products within bundles
  const handleBundleConfigChange = async (bundleProductId: string, includedProductId: string, configValue: string) => {
    const bundleConfigKey = `${bundleProductId}-${includedProductId}`;
    
    console.log('🔍 handleBundleConfigChange called:', {
      bundleProductId: bundleProductId.substring(0, 8),
      includedProductId: includedProductId.substring(0, 8),
      configValue,
      bundleConfigKey: bundleConfigKey.substring(0, 50)
    });
    
    const newConfigValues = {
      ...configValues,
      [bundleConfigKey]: configValue
    };
    setConfigValues(newConfigValues);
    
    const newSelectedConfigs = {
      ...selectedConfigs,
      [bundleConfigKey]: configValue
    };
    setSelectedConfigs(newSelectedConfigs);
    
    console.log('✅ Bundle config values updated:', {
      bundleConfigKey: bundleConfigKey.substring(0, 50),
      newValue: configValue,
      totalConfigKeys: Object.keys(newConfigValues).length
    });
    
    // Immediately recalculate pricing with tier/tobacco overrides
    const bundleProduct = products.find(p => p.productId === bundleProductId);
    const includedProduct = bundleProduct?.includedProducts?.find(p => p.productId === includedProductId);
    
    if (includedProduct && memberProfile && householdData) {
      try {
        const newPrice = await getIncludedProductPricing(includedProduct, bundleProductId, configValue);
        
        if (newPrice !== null) {
          setIncludedProductPrices(prev => ({
            ...prev,
            [bundleConfigKey]: newPrice
          }));
        }

        // Update bundle total price
        let updatedBundleTotal = 0;
        if (bundleProduct && bundleProduct.includedProducts) {
          for (const includedProduct of bundleProduct.includedProducts) {
            const includedBundleConfigKey = `${bundleProductId}-${includedProduct.productId}`;
            const includedPrice = includedBundleConfigKey === bundleConfigKey 
              ? (newPrice ?? 0)
              : (includedProductPrices[includedBundleConfigKey] || 0);
            
            console.log('🔍 DEBUG: Bundle component price:', {
              productName: includedProduct.productName,
              bundleConfigKey: includedBundleConfigKey.substring(0, 50),
              isChangedProduct: includedBundleConfigKey === bundleConfigKey,
              price: includedPrice,
              newPrice,
              oldPrice: includedProductPrices[includedBundleConfigKey]
            });
            
            updatedBundleTotal += Number(includedPrice);
          }
          
          console.log('💰 DEBUG: Updated bundle total:', {
            bundleName: bundleProduct.name,
            oldBundlePrice: productPrices[bundleProductId],
            newBundleTotal: updatedBundleTotal,
            difference: updatedBundleTotal - (productPrices[bundleProductId] || 0)
          });
        }
        
        setProductPrices(prev => {
          const updated = {
            ...prev,
            [bundleProductId]: updatedBundleTotal
          };
          
          console.log('✅ DEBUG: setProductPrices called with bundle price:', {
            bundleId: bundleProductId.substring(0, 8),
            oldPrice: prev[bundleProductId],
            newPrice: updatedBundleTotal
          });
          
          return updated;
        });
      } catch (error) {
        console.warn('Bundle pricing calculation failed:', error);
      }
    }
    
    // Trigger backend recalculation on review page
    const currentStepData = steps[currentStep];
    if (currentStepData?.id === 'review') {
      console.log('🔄 DEBUG: Triggering backend recalculation after bundle config change (on review step)');
      setRecalculateTrigger(prev => prev + 1);
    }
  };
  
  // Handle product toggle (add/remove)
  const handleProductToggle = (productId: string) => {
    const isCurrentlyEnrolled = groupedEnrollments?.some(ge => 
      ge.status === 'Active' && (
        (ge.type === 'bundle' && ge.bundleId === productId) ||
        (ge.type === 'individual' && ge.primaryEnrollment?.productId === productId)
      )
    ) || false;
    
    if (isCurrentlyEnrolled) {
      // Check if this is a future enrollment
      if (isFutureEnrollment(productId)) {
        // Check if modification is restricted (group member, same month)
        const restriction = isFutureEnrollmentModificationRestricted(productId);
        
        if (restriction.restricted) {
          alert(restriction.reason || 'Cannot modify this future enrollment.');
          return;
        }
        
        // For future enrollments, check if user can cancel (GroupAdmin+)
        if (!canCancelFutureEnrollments()) {
          // Regular members cannot cancel future enrollments themselves
          alert('Future enrollments can only be cancelled by a Group Administrator or higher. Please contact your administrator if you need to make changes.');
          return;
        }
        
        // GroupAdmin+ can cancel future enrollments - show confirmation
        const enrollment = groupedEnrollments?.find(ge => 
          (ge.type === 'bundle' && ge.bundleId === productId) ||
          (ge.type === 'individual' && ge.primaryEnrollment?.productId === productId)
        );
        
        const effectiveDate = enrollment?.type === 'bundle' 
          ? enrollment.enrollments?.[0]?.effectiveDate
          : enrollment?.primaryEnrollment?.effectiveDate;
        
        // Format effective date properly (avoid timezone conversion issues)
        let formattedDate = 'the future date';
        if (effectiveDate) {
          try {
            // Parse date parts separately to avoid timezone conversion (per backend-system.md)
            const [datePart] = effectiveDate.split('T');
            const [year, month, day] = datePart.split('-');
            const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
            formattedDate = date.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric'
            });
          } catch (error) {
            console.error('Error formatting effective date:', error);
            formattedDate = effectiveDate;
          }
        }
        
        const confirmMessage = `This will cancel your future enrollment effective ${formattedDate}. ` +
          (isGroupMember 
            ? 'Group billing adjustments may be required.' 
            : 'A refund may be processed if the enrollment was already paid for.');
        
        if (window.confirm(confirmMessage)) {
          setSelectedProducts(prev => prev.filter(id => id !== productId));
          setRemovedProducts(prev => [...prev, productId]);
        }
        return;
      }
      
      // Existing enrollment (not future) - show normal remove confirmation
      setShowRemoveConfirm(productId);
    } else {
      setSelectedProducts(prev => {
        if (prev.includes(productId)) {
          return prev.filter(id => id !== productId);
        } else {
          return [...prev, productId];
        }
      });
    }
  };

  const handleConfirmRemove = (productId: string) => {
    setSelectedProducts(prev => prev.filter(id => id !== productId));
    setRemovedProducts(prev => [...prev, productId]);
    setShowRemoveConfirm(null);
  };

  const handleUndoRemove = (productId: string) => {
    setSelectedProducts(prev => [...prev, productId]);
    setRemovedProducts(prev => prev.filter(id => id !== productId));
  };

  const handleProductInfoClick = (product: Product) => {
    setSelectedProductForInfo(product);
    setShowProductInfoModal(true);
  };

  // Generate wizard steps based on selected actions
  // Get configuration display text for a product
  const getConfigDisplayText = (productId: string) => {
    const product = products.find(p => p.productId === productId);
    if (!product) return '';
    
    const config = configValues[productId];
    if (!config || config === 'Default') return '';
    
    // Find the field name for this config
    const field = product.requiredDataFields?.[0];
    if (field && field.fieldName) {
      return ` (${field.fieldName}: ${config})`;
    }
    
    return '';
  };

  const getWizardSteps = () => {
    const steps = [
      { id: 'action-selection', title: 'Select Changes', description: 'What would you like to modify?' }
    ];
    
    if (selectedActions.includes('dependents')) {
      steps.push(
        { id: 'manage-dependents', title: 'Manage Dependents', description: 'Add or remove household members' },
        { id: 'tobacco-question', title: 'Tobacco Use', description: 'Update household tobacco status' }
      );
    }
    
    if (selectedActions.includes('plans')) {
      steps.push(
        { id: 'manage-plans', title: 'Manage Plans', description: 'Select and configure benefits' }
      );
    }
    
    // Add acknowledgements step (includes signature) if products require them
    if (productAcknowledgements && productAcknowledgements.length > 0) {
      steps.push(
        { id: 'acknowledgements', title: 'Acknowledgements & Signature', description: 'Review and sign' }
      );
    }
    
    // Always end with review/confirmation
    steps.push(
      { id: 'review', title: 'Review Changes', description: 'Review all changes before submitting' }
    );
    
    return steps;
  };

  const steps = getWizardSteps();

  const handleActionToggle = (action: ChangeAction) => {
    setSelectedActions(prev => {
      if (prev.includes(action)) {
        return prev.filter(a => a !== action);
      } else {
        return [...prev, action];
      }
    });
  };

  const handleAddDependent = () => {
    // Validate form - first, last name required, email required for spouse
    if (!currentDependentForm.firstName || !currentDependentForm.lastName) {
      setError('First name and last name are required');
      return;
    }
    
    // Validate required fields: gender and date of birth
    if (!currentDependentForm.gender) {
      setError('Gender is required');
      return;
    }
    
    if (!currentDependentForm.dateOfBirth) {
      setError('Date of birth is required');
      return;
    }
    
    // Check if trying to add spouse when one already exists
    if (currentDependentForm.relationshipType === 'S') {
      const hasExistingSpouse = getCurrentHouseholdMembers().some(m => m.relationshipType === 'S') ||
                                dependentsToAdd.some(d => d.relationshipType === 'S');
      if (hasExistingSpouse) {
        setError('A spouse already exists in your household. Please remove the existing spouse before adding a new one.');
        return;
      }
      
      // Email required for spouse
      if (!currentDependentForm.email) {
        setError('Email is required for spouse');
        return;
      }
    }
    
    // Validate email format if provided
    if (currentDependentForm.email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(currentDependentForm.email)) {
        setError('Please enter a valid email address');
        return;
      }
    }

    const ssnDigits = (currentDependentForm.ssn || '').replace(/\D/g, '');
    if (ssnDigits.length > 0 && ssnDigits.length !== 9) {
      setError('Social Security Number must be exactly 9 digits or left blank.');
      return;
    }
    if (ssnDigits.length === 9) {
      const ssnChk = validateSSN(ssnDigits);
      if (!ssnChk.isValid) {
        setError(ssnChk.error || 'Invalid SSN');
        return;
      }
    }

    // For children, send empty strings for email & phone (backend will generate unique email)
    // For spouse, use their email (required) and phone (optional)
    const emailToUse = currentDependentForm.relationshipType === 'C' ? '' : currentDependentForm.email;
    const phoneToUse = currentDependentForm.relationshipType === 'C' ? '' : currentDependentForm.phone;

    // Add to list
    setDependentsToAdd(prev => [...prev, {
      ...currentDependentForm,
      email: emailToUse,
      phone: phoneToUse,
      ssn: ssnDigits.length === 9 ? ssnDigits : undefined
    }]);
    
    // Reset form - check if spouse exists and set default accordingly
    const hasExistingSpouse = getCurrentHouseholdMembers().some(m => m.relationshipType === 'S') ||
                             dependentsToAdd.some(d => d.relationshipType === 'S');
    setCurrentDependentForm({
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      dateOfBirth: '',
      gender: '',
      relationshipType: hasExistingSpouse ? 'C' : 'S', // Default to Child if spouse exists, otherwise Spouse
      ssn: ''
    });

    setShowAddDependentSsn(false);
    
    setShowAddDependentForm(false);
    setError(null);
  };

  const handleRemoveDependent = (memberId: string, memberName: string) => {
    // If already marked for removal, undo it
    if (dependentsToRemove.includes(memberId)) {
      setDependentsToRemove(prev => prev.filter(id => id !== memberId));
      return;
    }
    
    // Show confirmation before marking for removal
    if (confirm(`Are you sure you want to remove ${memberName} from your household? This will affect your coverage tier and may impact your pricing.`)) {
      setDependentsToRemove(prev => [...prev, memberId]);
    }
  };

  // Check if selected products require acknowledgements
  // ONLY checks newly added products (not existing ones that user already signed for)
  const checkForAcknowledgements = async (shouldNavigate: boolean = true) => {
    try {
      // Get products to check (ONLY new products being added, not existing ones)
      const productsToCheck = selectedProducts.filter(pid => !initialSelectedProducts.includes(pid));

      console.log('🔍 Checking acknowledgements for NEW products only:', {
        productsToCheck,
        selectedProducts,
        initialSelectedProducts,
        newProductsCount: productsToCheck.length
      });

      if (productsToCheck.length > 0) {
        const acknowledgementsResponse = await ProductChangesCompleteService.getProductAcknowledgements(productsToCheck);
        
        if (acknowledgementsResponse.success && acknowledgementsResponse.data.productAcknowledgements.length > 0) {
          console.log('🔍 Products require acknowledgements:', acknowledgementsResponse.data.productAcknowledgements);
          setProductAcknowledgements(acknowledgementsResponse.data.productAcknowledgements);
          
          if (shouldNavigate) {
            setSubmitting(false);
            // Move to next step (acknowledgements will be added to steps)
            if (currentStep < steps.length - 1) {
              setCurrentStep(prev => prev + 1);
            }
          }
          return;
        } else {
          // No acknowledgements needed for new products
          console.log('🔍 No acknowledgements required for new products');
          setProductAcknowledgements([]);
        }
      } else {
        // No new products, clear acknowledgements
        console.log('🔍 No new products to check for acknowledgements');
        setProductAcknowledgements([]);
      }

      // No acknowledgements needed, move to review step if navigating
      if (shouldNavigate) {
        setSubmitting(false);
        if (currentStep < steps.length - 1) {
          setCurrentStep(prev => prev + 1);
        }
      }
    } catch (err) {
      console.error('Error checking acknowledgements:', err);
      setError(err instanceof Error ? err.message : 'Failed to check product requirements');
      if (shouldNavigate) {
        setSubmitting(false);
      }
    }
  };

  // Proactively check for acknowledgements when new products are selected
  useEffect(() => {
    // Only check if we're past the action selection step and products are loaded
    if (products.length > 0 && initialSelectedProducts.length > 0) {
      // Check for new products
      const newProducts = selectedProducts.filter(pid => !initialSelectedProducts.includes(pid));
      
      if (newProducts.length > 0) {
        console.log('🔍 Proactively checking acknowledgements for newly selected products:', newProducts);
        // Check acknowledgements without navigating (just update state)
        checkForAcknowledgements(false).catch(err => {
          console.error('Error in proactive acknowledgement check:', err);
        });
      } else {
        // No new products, clear acknowledgements
        setProductAcknowledgements([]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProducts, products.length, initialSelectedProducts.length]);

  const handleNext = async () => {
    const currentStepData = steps[currentStep];
    
    // Validate action selection
    if (currentStepData?.id === 'action-selection' && selectedActions.length === 0) {
      setError('Please select at least one action to proceed');
      return;
    }
    
    // Validate dependent management step - check for unsaved dependent form
    if (currentStepData?.id === 'manage-dependents' && showAddDependentForm) {
      alert('Please save or cancel the dependent form before continuing.');
      return;
    }
    
    // If on manage-plans step, check for acknowledgements
    if (currentStepData?.id === 'manage-plans') {
      await checkForAcknowledgements();
      return;
    }
    
    // If on tobacco-question and no manage-plans step, check acknowledgements
    if (currentStepData?.id === 'tobacco-question' && !selectedActions.includes('plans')) {
      await checkForAcknowledgements();
      return;
    }
    
    // If on review step (final step), submit
    if (currentStepData?.id === 'review') {
      await handleSubmitChanges();
      return;
    }
    
    setError(null);
    
    if (currentStep < steps.length - 1) {
      setCurrentStep(prev => prev + 1);
    }
  };
  
  // Submit all wizard changes
  const handleSubmitChanges = async () => {
    try {
      setSubmitting(true);
      setError(null);

      // When only changing dependents (not managing plans), we need to include existing enrollments
      // as "selectedProducts" so they get re-enrolled with the new tier/tobacco pricing
      let productsToSubmit = selectedProducts;
      
      if (!selectedActions.includes('plans') && (showTierChange || tobaccoUse !== memberProfile?.tobaccoUse)) {
        // Include all currently enrolled products (filter by EnrollmentType, not GUID)
        const enrolledProductIds: string[] = [];
        groupedEnrollments?.forEach(ge => {
          if (ge.status === 'Active') {
            // Check if this is a product enrollment (not a fee or contribution)
            const enrollmentType = ge.primaryEnrollment?.enrollmentType || ge.enrollments?.[0]?.enrollmentType;
            
            if (!isProductEnrollment(enrollmentType)) {
              return; // Skip non-product enrollments
            }
            
            if (ge.type === 'bundle' && ge.bundleId) {
              enrolledProductIds.push(ge.bundleId);
            } else if (ge.type === 'individual' && ge.primaryEnrollment?.productId) {
              enrolledProductIds.push(ge.primaryEnrollment.productId);
            }
          }
        });
        productsToSubmit = enrolledProductIds;
        console.log('🔍 DEBUG: Including existing enrollments for tier/tobacco update:', enrolledProductIds);
      }
      
      // IMPORTANT: Deduplicate products to prevent double enrollments
      productsToSubmit = [...new Set(productsToSubmit)];
      
      // Note: No need to filter by GUID - we already filter by EnrollmentType when collecting enrollments
      
      console.log('🔍 DEBUG: Products after deduplication and filtering:', productsToSubmit);

      // Prepare completion data with wizard-specific fields
      const completionData = {
        selectedProducts: productsToSubmit,
        removedProducts,
        configValues,
        initialConfigValues, // Send original config values so backend can detect changes
        effectiveDate: calculatedEffectiveDate ? calculatedEffectiveDate.split('T')[0] : new Date().toISOString().split('T')[0], // Use same effective date that was used for pricing calculations
        memberId: isManagingForMember ? memberId : null, // Send memberId if managing another member
        frontendPricing: productsToSubmit
          .filter(productId => !removedProducts.includes(productId))
          .map(productId => {
            const product = products.find(p => p.productId === productId);
            
            // Get config value (for bundles, try bundle-level first, then infer from sub-products)
            let selectedConfig = configValues[productId];
            if (!selectedConfig && product?.isBundle && product.includedProducts) {
              // Try to infer from sub-product configs
              for (const ip of product.includedProducts) {
                const bundleConfigKey = `${productId}-${ip.productId}`;
                if (configValues[bundleConfigKey]) {
                  selectedConfig = configValues[bundleConfigKey];
                  break;
                }
              }
            }
            
            // Always use calculated pricing (not enrolled amounts) to match backend
            return {
              productId,
              productName: product?.name ?? 'Unknown Product',
              monthlyPremium: product?.isBundle 
                ? getBundleTotalPrice(product)
                : (productPrices[productId] || product?.basePrice || 0),
              selectedConfig: selectedConfig || null
            };
          }),
        // Only include acknowledgements if there actually are any to sign
        acknowledgements: digitalSignature ? productAcknowledgements.flatMap(pa => 
          (pa.acknowledgements || []).map((ack: any) => ({
            productId: pa.productId,
            questionId: ack.id,
            question: ack.question || ack.text || '',
            response: acknowledgementResponses[`${pa.productId}-${ack.id || ack.question}`] ? 'Yes' : 'No'
          }))
        ) : [],
        digitalSignature: digitalSignature || '',
        memberInfo: {
          firstName: memberProfile?.firstName || '',
          lastName: memberProfile?.lastName || '',
          email: memberProfile?.email || '',
          phone: memberProfile?.phone || '',
          dateOfBirth: memberProfile?.dateOfBirth || '',
          gender: memberProfile?.gender || '',
          tobaccoUse: tobaccoUse,
          address: memberProfile?.address || '',
          city: memberProfile?.city || '',
          state: memberProfile?.state || '',
          zip: memberProfile?.zip || memberProfile?.zipCode || '',
          hasSpouse: getCurrentHouseholdMembers().some(m => m.relationshipType === 'S') || 
                     dependentsToAdd.some(d => d.relationshipType === 'S'),
          childrenCount: getCurrentHouseholdMembers().filter(m => m.relationshipType === 'C').length + 
                        dependentsToAdd.filter(d => d.relationshipType === 'C').length
        },
        // Wizard-specific fields
        dependentsToAdd: dependentsToAdd,
        dependentsToRemove: dependentsToRemove,
        newTobaccoUse: tobaccoUse !== memberProfile?.tobaccoUse ? tobaccoUse : null,
        calculatedTier: calculatedTier !== memberProfile?.tier ? calculatedTier : null,
        // Group member flag to skip DIME payment processing
        isGroupMember: isGroupMember,
        // Payment verification - send what user was shown on confirmation page
        ...(() => {
          const chargeInfo = calculateImmediateCharge();
          const correctMonthlyTotal = calculateCorrectMonthlyTotal();
          
          return {
            expectedChargeAmount: chargeInfo.dueToday,
            expectedIsIncremental: chargeInfo.isIncremental,
            expectedMonthlyTotal: correctMonthlyTotal
          };
        })()
      };

      console.log('🔍 DEBUG: Wizard submitting changes:', {
        ...completionData,
        isGroupMember,
        groupId: memberProfile?.groupId,
        configValuesKeys: Object.keys(completionData.configValues),
        initialConfigValuesKeys: Object.keys(completionData.initialConfigValues),
        configValuesSample: completionData.configValues,
        initialConfigValuesSample: completionData.initialConfigValues
      });

      const response = await ProductChangesCompleteService.completeProductChanges(completionData);

      if (response.success) {
        console.log('✅ Product changes completed successfully:', response.data);
        
        // Update group member status from response
        if (response.data?.paymentInfo) {
          setIsGroupMember(response.data.paymentInfo.isGroupMember || false);
        }
        
        // Invalidate relevant queries to ensure fresh data is fetched
        if (memberId) {
          // Invalidate enrollments queries for this member
          queryClient.invalidateQueries({ queryKey: ['memberEnrollments', memberId] });
          queryClient.invalidateQueries({ queryKey: ['enrollments'] });
          queryClient.invalidateQueries({ queryKey: ['groupedMemberEnrollments'] });
          queryClient.invalidateQueries({ queryKey: ['memberSpecificEnrollments', memberId] });
          console.log('🔄 Invalidated enrollment queries for member:', memberId);
        } else {
          // Invalidate current user's enrollment queries
          queryClient.invalidateQueries({ queryKey: ['memberEnrollments'] });
          queryClient.invalidateQueries({ queryKey: ['enrollments'] });
          queryClient.invalidateQueries({ queryKey: ['groupedMemberEnrollments'] });
          console.log('🔄 Invalidated enrollment queries for current user');
        }
        
        alert('Your changes have been saved successfully!');
        if (onClose) {
          onClose();
        } else if (memberId) {
          // Navigate back to members page if managing on behalf
          const roleBase = user?.currentRole === 'SysAdmin' ? 'admin' 
                          : user?.currentRole === 'TenantAdmin' ? 'tenant-admin'
                          : user?.currentRole === 'Agent' ? 'agent'
                          : user?.currentRole === 'GroupAdmin' ? 'group-admin'
                          : 'member';
          navigate(`/${roleBase}/members`, {
            state: { reopenMemberId: memberId }
          });
        } else {
          // Navigate to member's own plans page
          navigate('/member/plans');
        }
      } else {
        throw new Error(response.message || 'Failed to submit changes');
      }
    } catch (err) {
      console.error('❌ Error submitting changes:', err);
      
      // Handle different types of errors with user-friendly messages
      let errorMessage = 'Failed to submit changes';
      
      if (err instanceof Error) {
        const errorMsg = err.message.toLowerCase();
        
        // DIME payment errors
        if (errorMsg.includes('no active payment method') || errorMsg.includes('payment method')) {
          errorMessage = 'Payment setup required: Please add a payment method in your account settings before making plan changes.';
        } else if (errorMsg.includes('dime') || errorMsg.includes('payment processing')) {
          errorMessage = 'Payment processing error: Please check your payment method and try again.';
        } else if (errorMsg.includes('pricing validation failed')) {
          errorMessage = 'Pricing calculation error: Please refresh the page and try again.';
        } else if (errorMsg.includes('network') || errorMsg.includes('fetch')) {
          errorMessage = 'Network error: Please check your connection and try again.';
        } else {
          errorMessage = err.message;
        }
      }
      
      setError(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(prev => prev - 1);
    }
  };

  const isNextDisabled = () => {
    const currentStepData = steps[currentStep];
    
    if (currentStepData?.id === 'action-selection') {
      return selectedActions.length === 0;
    }
    
    // Block progression on manage-plans step if there are pricing errors
    if (currentStepData?.id === 'manage-plans') {
      return pricingErrors.size > 0;
    }
    
    // Validate acknowledgements step - all acknowledgements checked, signature valid, and agreement checked
    // Only required for NEW products (not existing ones that user already signed for)
    if (currentStepData?.id === 'acknowledgements') {
      // Only validate if there are acknowledgements (which means there are new products)
      if (productAcknowledgements.length === 0) {
        return false; // No acknowledgements needed, allow proceeding
      }
      
      const allChecked = productAcknowledgements.every(pa => 
        (pa.acknowledgements || []).every((ack: any) => 
          acknowledgementResponses[`${pa.productId}-${ack.id || ack.question}`]
        )
      );
      // Signature only required if there are new products (acknowledgements exist)
      const hasValidSignature = productAcknowledgements.length > 0 ? (isSignatureValid && signatureAgreement) : true;
      
      console.log('🔍 DEBUG: Acknowledgements validation:', {
        allChecked,
        isSignatureValid,
        signatureAgreement,
        hasValidSignature,
        isDisabled: !allChecked || !hasValidSignature,
        acknowledgementResponses,
        digitalSignature: digitalSignature.substring(0, 50),
        productAcknowledgementsCount: productAcknowledgements.length
      });
      
      return !allChecked || !hasValidSignature;
    }
    
    // 🔒 CRITICAL: Block submission on review step until backend calculation completes
    // This prevents premium mismatch errors caused by submitting before new prices are calculated
    // However, if calculation failed (e.g., 404), allow proceeding - backend will calculate during submission
    // Also allow proceeding when managing for another member - backend will calculate during submission
    if (currentStepData?.id === 'review') {
      // First check if there are any actual changes - if not, disable the button
      if (!hasAnyChanges()) {
        console.log('🔍 DEBUG: Review step button disabled - no changes detected');
        return true; // Disable button
      }
      
      // If managing for another member, always allow proceeding (backend calculates during submission)
      if (isManagingForMember) {
        console.log('🔍 DEBUG: Review step button state (managing for member):', {
          isManagingForMember: true,
          allowingProceed: true,
          reason: 'Backend will calculate during submission'
        });
        return false; // Allow proceeding
      }
      
      const isCalculating = !calculatedCharges && !calculationFailed && calculationAttempted;
      
      console.log('🔍 DEBUG: Review step button state:', {
        isCalculating,
        hasCalculatedCharges: !!calculatedCharges,
        calculationAttempted,
        calculationFailed,
        calculatedCharges: calculatedCharges ? {
          dueToday: calculatedCharges.dueToday,
          newMonthlyTotal: calculatedCharges.newMonthlyTotal
        } : null
      });
      
      return isCalculating;
    }
    
    return false;
  };

  // Render action selection step
  const renderActionSelection = () => (
    <div className="space-y-6 pb-32">
      <div className="mb-8">
        <h2 className="text-2xl font-semibold text-gray-900">What would you like to change?</h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Add/Remove Dependents Option */}
        <div
          onClick={() => handleActionToggle('dependents')}
          className={`relative p-8 border-2 rounded-lg cursor-pointer transition-all hover-lift shadow-sm ${
            selectedActions.includes('dependents')
              ? 'border-[#1f8dbf] bg-[#d6eef8] shadow-md'
              : 'border-gray-300 hover:border-[#1f8dbf] hover:bg-gray-50 hover:shadow-md'
          }`}
        >
          <div className="flex items-start">
            {/* Checkbox */}
            <div className="flex-shrink-0 mr-4">
              <div className={`w-6 h-6 rounded border-2 flex items-center justify-center transition-all ${
                selectedActions.includes('dependents')
                  ? 'bg-[#1f8dbf] border-[#1f8dbf]'
                  : 'bg-white border-gray-300'
              }`}>
                {selectedActions.includes('dependents') && (
                  <Check className="h-4 w-4 text-white" />
                )}
              </div>
            </div>
            
            <div className={`flex-shrink-0 ${selectedActions.includes('dependents') ? 'text-[#1f8dbf]' : 'text-gray-400'}`}>
              <Users className="h-8 w-8" />
            </div>
            <div className="ml-4 flex-1">
              <h3 className="text-lg font-medium text-gray-900">Add/Remove Dependents</h3>
              <p className="mt-2 text-sm text-gray-600">
                Add or remove family members from your household
              </p>
            </div>
          </div>
        </div>

        {/* Manage Plans Option */}
        <div
          onClick={() => handleActionToggle('plans')}
          className={`relative p-8 border-2 rounded-lg cursor-pointer transition-all hover-lift shadow-sm ${
            selectedActions.includes('plans')
              ? 'border-[#1f8dbf] bg-[#d6eef8] shadow-md'
              : 'border-gray-300 hover:border-[#1f8dbf] hover:bg-gray-50 hover:shadow-md'
          }`}
        >
          <div className="flex items-start">
            {/* Checkbox */}
            <div className="flex-shrink-0 mr-4">
              <div className={`w-6 h-6 rounded border-2 flex items-center justify-center transition-all ${
                selectedActions.includes('plans')
                  ? 'bg-[#1f8dbf] border-[#1f8dbf]'
                  : 'bg-white border-gray-300'
              }`}>
                {selectedActions.includes('plans') && (
                  <Check className="h-4 w-4 text-white" />
                )}
              </div>
            </div>
            
            <div className={`flex-shrink-0 ${selectedActions.includes('plans') ? 'text-[#1f8dbf]' : 'text-gray-400'}`}>
              <Package className="h-8 w-8" />
            </div>
            <div className="ml-4 flex-1">
              <h3 className="text-lg font-medium text-gray-900">Manage Plans</h3>
              <p className="mt-2 text-sm text-gray-600">
                Add, remove, or modify your benefit plans
              </p>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}
    </div>
  );

  // Render dependent management step
  const renderManageDependents = () => (
    <div className="space-y-6 pb-32">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-gray-900 mb-2">Manage Dependents</h2>
        <p className="text-gray-600">Add or remove family members from your household</p>
      </div>

      {/* Current Dependents */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="p-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Current Household Members</h3>
        </div>
        <div className="p-4">
          {getCurrentHouseholdMembers().length === 0 ? (
            <p className="text-gray-500 text-sm">No dependents in household</p>
          ) : (
            <div className="space-y-2">
              {getCurrentHouseholdMembers().map((member) => (
                <div key={member.memberId} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <p className="font-medium text-gray-900">
                      {member.firstName} {member.lastName}
                      {member.isCurrentUser && (
                        <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">Primary</span>
                      )}
                    </p>
                    <p className="text-sm text-gray-600">
                      {member.relationshipType === 'S' ? 'Spouse' : member.relationshipType === 'C' ? 'Child' : 'Dependent'}
                      {member.dateOfBirth && (
                        <span className="ml-2">• Born {formatDate(member.dateOfBirth, false)}</span>
                      )}
                    </p>
                  </div>
                  {!member.isCurrentUser && (
                    <button
                      onClick={() => handleRemoveDependent(member.memberId, `${member.firstName} ${member.lastName}`)}
                      className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                        dependentsToRemove.includes(member.memberId)
                          ? 'bg-red-100 text-red-800 hover:bg-red-200'
                          : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                      }`}
                    >
                      {dependentsToRemove.includes(member.memberId) ? 'Undo Remove' : 'Remove'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* New Dependents to Add */}
      {dependentsToAdd.length > 0 && (
        <div className="bg-green-50 rounded-lg border border-green-200 p-4">
          <h3 className="text-sm font-medium text-green-900 mb-3">New Dependents to Add</h3>
          <div className="space-y-2">
            {dependentsToAdd.map((dependent, index) => (
              <div key={index} className="flex items-center justify-between p-3 bg-white rounded-lg">
                <div>
                  <p className="font-medium text-gray-900">
                    {dependent.firstName} {dependent.lastName}
                  </p>
                  <p className="text-sm text-gray-600">
                    {dependent.relationshipType === 'S' ? 'Spouse' : 'Child'}
                    {dependent.dateOfBirth && (
                      <span className="ml-2">• Born {formatDate(dependent.dateOfBirth, false)}</span>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => setDependentsToAdd(prev => prev.filter((_, i) => i !== index))}
                  className="px-3 py-1 bg-red-100 text-red-800 rounded text-sm font-medium hover:bg-red-200 transition-colors"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Dependent Button/Form */}
      {!showAddDependentForm ? (
        <button
          onClick={() => {
            // Check if spouse exists and set default relationship type accordingly
            const hasExistingSpouse = getCurrentHouseholdMembers().some(m => m.relationshipType === 'S') ||
                                     dependentsToAdd.some(d => d.relationshipType === 'S');
            setCurrentDependentForm({
              firstName: '',
              lastName: '',
              email: '',
              phone: '',
              dateOfBirth: '',
              gender: '',
              relationshipType: hasExistingSpouse ? 'C' : 'S', // Default to Child if spouse exists, otherwise Spouse
              ssn: ''
            });
            setShowAddDependentSsn(false);
            setShowAddDependentForm(true);
          }}
          className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-oe-primary hover:text-oe-primary transition-colors"
        >
          + Add Dependent
        </button>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Add New Dependent</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Relationship dropdown - FIRST */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Relationship to Primary Member <span className="text-red-500">*</span>
              </label>
              {(() => {
                const hasExistingSpouse = getCurrentHouseholdMembers().some(m => m.relationshipType === 'S') ||
                                         dependentsToAdd.some(d => d.relationshipType === 'S');
                return (
                  <select
                    value={currentDependentForm.relationshipType}
                    onChange={(e) => {
                      const newType = e.target.value as RelationshipType;
                      // Clear email and phone when switching to Child (children don't need them)
                      setCurrentDependentForm({
                        ...currentDependentForm, 
                        relationshipType: newType,
                        email: newType === 'C' ? '' : currentDependentForm.email,
                        phone: newType === 'C' ? '' : currentDependentForm.phone
                      });
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary transition-all duration-200"
                    required
                  >
                    <option value="">Select Relationship</option>
                    <option value="S" disabled={hasExistingSpouse}>
                      Spouse
                    </option>
                    <option value="C">Child</option>
                  </select>
                );
              })()}
              {getCurrentHouseholdMembers().some(m => m.relationshipType === 'S') || dependentsToAdd.some(d => d.relationshipType === 'S') ? (
                <p className="mt-1 text-xs text-gray-500">A spouse already exists in your household</p>
              ) : null}
            </div>
            
            {/* First Name */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                First Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={currentDependentForm.firstName}
                onChange={(e) => setCurrentDependentForm({...currentDependentForm, firstName: e.target.value})}
                className="form-input"
                required
              />
            </div>
            
            {/* Last Name */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Last Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={currentDependentForm.lastName}
                onChange={(e) => setCurrentDependentForm({...currentDependentForm, lastName: e.target.value})}
                className="form-input"
                required
              />
            </div>
            
            {/* Date of Birth */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Date of Birth <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={currentDependentForm.dateOfBirth}
                onChange={(e) => setCurrentDependentForm({...currentDependentForm, dateOfBirth: e.target.value})}
                className="form-input"
                required
              />
            </div>
            
            {/* Gender */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Gender <span className="text-red-500">*</span>
              </label>
              <select
                value={currentDependentForm.gender}
                onChange={(e) => setCurrentDependentForm({...currentDependentForm, gender: e.target.value})}
                className="form-input"
                required
              >
                <option value="">Select Gender</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
              </select>
            </div>

            {/* SSN — optional; persisted on complete (same encryption as admin plan mod) */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Social Security Number <span className="text-gray-400 text-xs font-normal">(Optional)</span>
              </label>
              <div className="relative max-w-xl">
                <input
                  type={showAddDependentSsn ? 'text' : 'password'}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={11}
                  value={(() => {
                    const d = (currentDependentForm.ssn || '').replace(/\D/g, '').slice(0, 9);
                    if (showAddDependentSsn) return currentDependentForm.ssn || '';
                    if (!d) return '';
                    return `${d.slice(0, 3)}${d.length > 3 ? '-' : ''}${d.slice(3, 5)}${d.length > 5 ? '-' : ''}${d.slice(5, 9)}`;
                  })()}
                  onChange={(e) => {
                    const dOnly = e.target.value.replace(/\D/g, '').slice(0, 9);
                    setCurrentDependentForm({ ...currentDependentForm, ssn: dOnly });
                  }}
                  className="form-input pr-11 font-mono text-base"
                  placeholder="XXX-XX-XXXX"
                />
                <button
                  type="button"
                  aria-label={showAddDependentSsn ? 'Hide SSN' : 'Show SSN'}
                  onClick={() => setShowAddDependentSsn((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                >
                  {showAddDependentSsn ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </div>
            
            {/* Email & Phone - ONLY show for Spouse */}
            {currentDependentForm.relationshipType === 'S' && (
              <>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="email"
                    value={currentDependentForm.email}
                    onChange={(e) => setCurrentDependentForm({...currentDependentForm, email: e.target.value})}
                    className="form-input"
                    placeholder="spouse@example.com"
                    required
                  />
                </div>
                
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Phone Number <span className="text-gray-400 text-xs">(Optional)</span>
                  </label>
                  <input
                    type="tel"
                    value={currentDependentForm.phone}
                    onChange={(e) => setCurrentDependentForm({...currentDependentForm, phone: e.target.value})}
                    className="form-input"
                    placeholder="(555) 123-4567"
                  />
                </div>
              </>
            )}
          </div>

          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          <div className="mt-4 flex justify-end space-x-3">
            <button
              onClick={() => {
                setShowAddDependentForm(false);
                setShowAddDependentSsn(false);
                setError(null);
              }}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              onClick={handleAddDependent}
              className="btn-primary"
            >
              Add Dependent
            </button>
          </div>
        </div>
      )}

      {/* Tier Change Notification */}
      {showTierChange && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start">
            <Check className="h-5 w-5 text-oe-primary mt-0.5 mr-3" />
            <div>
              <p className="text-sm font-medium text-blue-900">
                Your coverage tier will change from {memberProfile?.tier || 'EE'} to {calculatedTier}
              </p>
              <p className="text-xs text-oe-primary-dark mt-1">
                This may affect your product pricing in the next step
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // Render tobacco question step
  const renderTobaccoQuestion = () => (
    <div className="space-y-6 pb-32">
      <div className="mb-8">
        <h2 className="text-2xl font-semibold text-gray-900">Tobacco Use</h2>
      </div>

      <div className="max-w-2xl mx-auto">
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <label className="block text-lg font-medium text-gray-900 mb-4">
            Does anyone in your household use tobacco or nicotine products?
          </label>
          
          <div className="space-y-3">
            <label className={`flex items-center p-4 border-2 rounded-lg cursor-pointer transition-all ${
              tobaccoUse === 'No' ? 'border-oe-primary bg-blue-50' : 'border-gray-200 hover:border-gray-300'
            }`}>
              <input
                type="radio"
                name="tobaccoUse"
                value="No"
                checked={tobaccoUse === 'No'}
                onChange={(e) => setTobaccoUse(e.target.value as 'Yes' | 'No')}
                className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
              />
              <span className="ml-3 text-gray-900 font-medium">No</span>
            </label>
            
            <label className={`flex items-center p-4 border-2 rounded-lg cursor-pointer transition-all ${
              tobaccoUse === 'Yes' ? 'border-oe-primary bg-blue-50' : 'border-gray-200 hover:border-gray-300'
            }`}>
              <input
                type="radio"
                name="tobaccoUse"
                value="Yes"
                checked={tobaccoUse === 'Yes'}
                onChange={(e) => setTobaccoUse(e.target.value as 'Yes' | 'No')}
                className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
              />
              <span className="ml-3 text-gray-900 font-medium">Yes</span>
            </label>
          </div>

        </div>
      </div>
    </div>
  );

  // Render manage plans step
  const renderManagePlans = () => {
    if (productsLoading) {
      return (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-oe-primary mr-3" />
          <p className="text-gray-600">Loading products...</p>
        </div>
      );
    }
    
    // If there are pricing errors, show only the error screen
    if (pricingErrors.size > 0) {
      // Generate pre-filled support email
      const generateSupportEmailLink = () => {
        const subject = 'Pricing Configuration Required - Product Change Wizard';
        
        // Get affected products
        const affectedProducts = Array.from(pricingErrors)
          .map(productId => {
            const product = products.find(p => p.productId === productId);
            return product ? `- ${product.name} (ID: ${productId})` : `- Unknown Product (ID: ${productId})`;
          })
          .join('\n');
        
        // Get household members info
        const householdMembers = getCurrentHouseholdMembers();
        const householdInfo = householdMembers.length > 0
          ? householdMembers.map(m => `- ${m.firstName} ${m.lastName} (${m.relationshipType === 'S' ? 'Spouse' : 'Child'})`).join('\n')
          : 'No dependents';
        
        // Build email body
        const body = `Hello Support Team,

I'm experiencing a pricing configuration error while trying to modify my plan. The system is unable to calculate pricing for some products based on my household configuration.

MEMBER INFORMATION:
- Name: ${memberProfile?.firstName || ''} ${memberProfile?.lastName || ''}
- Email: ${memberProfile?.email || ''}
- Member ID: ${memberProfile?.id || memberId || 'N/A'}
${memberProfile?.groupId ? `- Group ID: ${memberProfile.groupId}` : '- Individual Member (No Group)'}

CURRENT CONFIGURATION:
- Coverage Tier: ${calculatedTier || memberProfile?.tier || 'EE'}
- Tobacco Use: ${tobaccoUse}
- Age: ${memberProfile?.age || 'N/A'}
- Household Size: ${getProjectedHouseholdSize()} person(s)

HOUSEHOLD MEMBERS:
${householdInfo}

PRODUCTS AFFECTED (Missing Pricing):
${affectedProducts}

REQUESTED CHANGES:
${dependentsToAdd.length > 0 ? `- Adding ${dependentsToAdd.length} dependent(s)` : ''}
${dependentsToRemove.length > 0 ? `- Removing ${dependentsToRemove.length} dependent(s)` : ''}
${selectedActions.includes('plans') ? '- Modifying plan selections' : ''}

Please help configure pricing for these products so I can complete my enrollment.

Thank you,
${memberProfile?.firstName || ''} ${memberProfile?.lastName || ''}`;

        return `mailto:${OPEN_ENROLL_BRANDING.supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      };
      
      return (
        <div className="space-y-6 pb-32">
          <div className="max-w-2xl mx-auto">
            {/* Error Icon and Title */}
            <div className="text-center mb-8">
              <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-red-100 mb-4">
                <X className="h-10 w-10 text-red-600" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                Pricing Configuration Required
              </h2>
              <p className="text-gray-600">
                We're unable to proceed with plan changes at this time
              </p>
            </div>

            {/* Main Error Card */}
            <div className="bg-white rounded-lg border-2 border-red-300 shadow-lg overflow-hidden">
              {/* Error Header */}
              <div className="bg-red-50 px-6 py-4 border-b border-red-200">
                <p className="text-base font-semibold text-red-900">
                  Missing Pricing Configuration
                </p>
              </div>

              {/* Error Body */}
              <div className="px-6 py-6 space-y-4">
                <p className="text-sm text-gray-700">
                  We're unable to calculate pricing for some products based on your current household configuration. 
                  This typically occurs when pricing hasn't been set up for your specific coverage tier or tobacco status.
                </p>

                {/* Current Configuration */}
                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                  <p className="text-sm font-medium text-gray-900 mb-2">Your Configuration:</p>
                  <div className="space-y-1 text-sm text-gray-700">
                    <div className="flex justify-between">
                      <span>Coverage Tier:</span>
                      <span className="font-medium">{calculatedTier || memberProfile?.tier || 'EE'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Tobacco Use:</span>
                      <span className="font-medium">{tobaccoUse}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Age:</span>
                      <span className="font-medium">{memberProfile?.age || 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Household Size:</span>
                      <span className="font-medium">{getProjectedHouseholdSize()} person(s)</span>
                    </div>
                  </div>
                </div>

                {/* Affected Products */}
                <div className="bg-red-50 rounded-lg p-4 border border-red-200">
                  <p className="text-sm font-medium text-red-900 mb-2">
                    Products Affected:
                  </p>
                  <ul className="space-y-1">
                    {Array.from(pricingErrors).map(productId => {
                      const product = products.find(p => p.productId === productId);
                      return product ? (
                        <li key={productId} className="text-sm text-red-800 flex items-center">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-600 mr-2"></span>
                          {product.name}
                        </li>
                      ) : null;
                    })}
                  </ul>
                </div>

                {/* Action Required */}
                <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                  <div className="flex items-start">
                    <Info className="h-5 w-5 text-oe-primary mr-2 mt-0.5 flex-shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-blue-900 mb-2">
                        How to Resolve This:
                      </p>
                      <p className="text-sm text-blue-800 mb-3">
                        Please contact our support team. They can configure pricing for your specific situation and help you complete your enrollment.
                      </p>
                      <a 
                        href={generateSupportEmailLink()}
                        className="inline-flex items-center gap-2 bg-oe-primary hover:bg-oe-primary-dark text-white px-4 py-2.5 rounded-lg font-medium text-sm transition-colors"
                      >
                        <span>Email Support (Pre-filled)</span>
                        <span className="text-blue-200">→</span>
                      </a>
                      <p className="text-xs text-oe-primary-dark mt-2">
                        Your configuration details will be automatically included in the email
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Additional Help Text */}
            <div className="mt-6 text-center">
              <p className="text-sm text-gray-600">
                You can go back to modify your household information, or contact support for assistance.
              </p>
            </div>
          </div>
        </div>
      );
    }
    
    return (
      <div className="space-y-6 pb-32">
        <div className="mb-6">
          <h2 className="text-2xl font-semibold text-gray-900">Manage Plans</h2>
        </div>
        
        {(() => {
          // Normalize tobacco values for comparison
          const originalTobacco = (memberProfile?.tobaccoUse === 'Yes' || memberProfile?.tobaccoUse === 'Y') ? 'Yes' : 'No';
          const hasTobaccoChange = tobaccoUse !== originalTobacco;
          
          return (showTierChange || hasTobaccoChange) && (
            <div className="bg-[#d6eef8] border border-[#1f8dbf] rounded-lg p-4 mb-4">
              <div className="flex items-start">
                <Info className="h-5 w-5 text-[#1f8dbf] mr-2 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-gray-900">Pricing reflects your updated information</p>
                  <ul className="mt-2 text-xs text-gray-700 space-y-1">
                    {showTierChange && (
                      <li>• Coverage Tier: {memberProfile?.tier || 'EE'} → {calculatedTier}</li>
                    )}
                    {hasTobaccoChange && (
                      <li>• Tobacco Status: {originalTobacco} → {tobaccoUse}</li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          );
        })()}
        
        {/* Product Grid */}
        <div className="space-y-4">
          {products
            // Filter out individual products that are part of enrolled bundles
            .filter((product) => {
              // Don't filter out bundles themselves
              if (product.isBundle) return true;
              
              // Check if this product appears as a component in any bundle enrollment (Active or Pending)
              // Look for enrollments where this productId has a ProductBundleID (meaning it's enrolled as part of a bundle)
              const isComponentOfEnrolledBundle = groupedEnrollments?.some(ge => {
                // Check both Active and Pending bundle enrollments
                if (ge.type !== 'bundle' || (ge.status !== 'Active' && ge.status !== 'Pending')) return false;
                
                // Check if this productId appears in the bundle's component enrollments
                // Component enrollments will have productBundleID set (not null)
                return ge.enrollments?.some((enrollment: any) => 
                  enrollment.productId === product.productId && 
                  enrollment.productBundleID && 
                  enrollment.productBundleID !== enrollment.productId // Make sure it's actually a component, not the bundle itself
                );
              });
              
              // Hide if it's a component of an enrolled bundle (Active or Pending)
              if (isComponentOfEnrolledBundle) return false;
              
              // Also check using the isProductInEnrolledBundle helper for additional coverage
              const bundleInfo = isProductInEnrolledBundle(product.productId);
              if (bundleInfo.isIncluded) {
                // Hide if it's enrolled as part of a bundle
                return false;
              }
              
              return true;
            })
            .sort((a, b) => {
              const aEnrolled = groupedEnrollments?.some(ge => 
                ge.status === 'Active' && (
                  (ge.type === 'bundle' && ge.bundleId === a.productId) ||
                  (ge.type === 'individual' && ge.primaryEnrollment?.productId === a.productId)
                )
              ) || false;
              const bEnrolled = groupedEnrollments?.some(ge => 
                ge.status === 'Active' && (
                  (ge.type === 'bundle' && ge.bundleId === b.productId) ||
                  (ge.type === 'individual' && ge.primaryEnrollment?.productId === b.productId)
                )
              ) || false;
              
              if (aEnrolled && !bEnrolled) return -1;
              if (!aEnrolled && bEnrolled) return 1;
              return a.name.localeCompare(b.name);
            })
            .map((product) => {
            const isSelected = selectedProducts.includes(product.productId);
            
            // Check if product is enrolled and get effective date
            const enrollmentInfo = groupedEnrollments?.find(ge => 
              ge.status === 'Active' && (
                (ge.type === 'bundle' && ge.bundleId === product.productId) ||
                (ge.type === 'individual' && ge.primaryEnrollment?.productId === product.productId)
              )
            );
            
            const isCurrentlyEnrolled = !!enrollmentInfo;
            
            // Check if enrollment is future (not yet effective) using the helper function
            const isFutureEnrollmentFlag = isFutureEnrollment(product.productId);
            
            // Check if this individual product is already part of an enrolled bundle
            const bundleInfo = isProductInEnrolledBundle(product.productId);
            
            // Check if this bundle contains products that are already enrolled
            const bundleConflict = bundleHasEnrolledProducts(product);
            
            const isBeingRemoved = removedProducts.includes(product.productId);
            const currentConfig = configValues[product.productId] || (product.requiredDataFields[0]?.fieldOptions[0] || '');
            const productPrice = product.isBundle 
              ? getBundleTotalPrice(product)
              : (productPrices[product.productId] !== undefined ? productPrices[product.productId] : 0);

            return (
              <div
                key={product.productId}
                className={`bg-white rounded-lg border-2 transition-all ${
                  isBeingRemoved
                    ? 'border-red-300 bg-red-50'
                    : isSelected 
                      ? 'border-oe-primary shadow-md' 
                      : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="p-6">
                  <div className="flex items-start space-x-4">
                    {/* Product Image */}
                    <div className="flex-shrink-0">
                      <img
                        src={product.productLogoUrl}
                        alt={product.name}
                        className="w-16 h-16 object-contain rounded-lg"
                      />
                    </div>

                    {/* Product Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <h3 className="text-lg font-semibold text-gray-900 mb-1">
                            {product.name}
                          </h3>
                          <p className="text-sm text-gray-600 mb-2">
                            {product.description}
                          </p>
                          <div className="flex items-center space-x-4">
                            <span className="text-sm font-medium text-gray-900">
                              {productPrice > 0 ? (
                                <>
                                  ${productPrice.toFixed(2)}/month
                                  {product.isBundle && memberProfile?.groupId && (
                                    <span className="ml-2 text-xs text-gray-500">
                                      (before employer contributions)
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span className="flex items-center text-gray-500">
                                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                  Calculating...
                                </span>
                              )}
                            </span>
                            {product.productDocumentUrl && (
                              <button
                                onClick={() => handleProductInfoClick(product)}
                                className="inline-flex items-center px-2 py-1 rounded text-xs font-medium text-oe-primary hover:text-blue-800 hover:bg-blue-50"
                              >
                                <FileText className="h-3 w-3 mr-1" />
                                Product Info
                              </button>
                            )}
                            {isCurrentlyEnrolled && (
                              <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                                isFutureEnrollmentFlag 
                                  ? 'bg-blue-100 text-blue-800' 
                                  : 'bg-green-100 text-green-800'
                              }`}>
                                {isFutureEnrollmentFlag ? 'Not Yet Effective' : 'Currently Enrolled'}
                              </span>
                            )}
                            {!isCurrentlyEnrolled && bundleInfo.isIncluded && (
                              <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
                                <Info className="h-3 w-3 mr-1" />
                                Included in {bundleInfo.bundleName}
                              </span>
                            )}
                            {bundleConflict.hasConflict && (
                              <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
                                <X className="h-3 w-3 mr-1" />
                                Already enrolled in {bundleConflict.conflictingProducts?.join(', ')}
                              </span>
                            )}
                            {!product.isGroupAuthorized && (
                              <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                                Not Available for Your Group
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Action Button */}
                        <div className="flex-shrink-0 ml-4">
                          {isCurrentlyEnrolled ? (
                            <div className="flex flex-col items-end space-y-2">
                              {isFutureEnrollmentFlag ? (() => {
                                const restriction = isFutureEnrollmentModificationRestricted(product.productId);
                                const canCancel = canCancelFutureEnrollments();
                                
                                if (restriction.restricted) {
                                  return (
                                    <button
                                      onClick={() => alert(restriction.reason || 'Cannot modify this future enrollment.')}
                                      disabled
                                      className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-200 text-gray-500 cursor-not-allowed opacity-60"
                                      title={restriction.reason}
                                    >
                                      <X className="h-3 w-3 mr-1" />
                                      Cannot Modify
                                    </button>
                                  );
                                }
                                
                                if (!canCancel) {
                                  return (
                                    <button
                                      onClick={() => alert('Future enrollments can only be cancelled by a Group Administrator or higher. Please contact your administrator if you need to make changes.')}
                                      disabled
                                      className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-200 text-gray-500 cursor-not-allowed opacity-60"
                                    >
                                      <X className="h-3 w-3 mr-1" />
                                      Contact Admin
                                    </button>
                                  );
                                }
                                
                                // GroupAdmin+ can cancel future enrollments
                                // Check if this future enrollment is already being removed
                                const isFutureBeingRemoved = isBeingRemoved && isFutureEnrollment(product.productId);
                                
                                if (isFutureBeingRemoved) {
                                  // Show "Undo cancel" for future enrollments that were cancelled
                                  return (
                                    <button
                                      onClick={() => handleUndoRemove(product.productId)}
                                      className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 hover:bg-green-200"
                                      title="Undo cancellation of future enrollment"
                                    >
                                      <Undo2 className="h-3 w-3 mr-1" />
                                      Undo Cancel
                                    </button>
                                  );
                                }
                                
                                // Show "Cancel" button for future enrollments that can be cancelled
                                return (
                                  <button
                                    onClick={() => handleProductToggle(product.productId)}
                                    className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 hover:bg-yellow-200"
                                    title="Cancel future enrollment (may require refund)"
                                  >
                                    <X className="h-3 w-3 mr-1" />
                                    Cancel
                                  </button>
                                );
                              })() : isBeingRemoved ? (
                                <button
                                  onClick={() => handleUndoRemove(product.productId)}
                                  className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800 hover:bg-red-200"
                                >
                                  <Undo2 className="h-3 w-3 mr-1" />
                                  Undo Remove
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleProductToggle(product.productId)}
                                  className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800 hover:bg-red-200"
                                >
                                  <X className="h-3 w-3 mr-1" />
                                  Remove
                                </button>
                              )}
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                if (bundleInfo.isIncluded) {
                                  alert(`This product is already included in your ${bundleInfo.bundleName} plan. You cannot add it separately.`);
                                  return;
                                }
                                if (bundleConflict.hasConflict) {
                                  alert(`This bundle cannot be added because you are already enrolled in: ${bundleConflict.conflictingProducts?.join(', ')}. Please remove those products first.`);
                                  return;
                                }
                                handleProductToggle(product.productId);
                              }}
                              disabled={!product.isGroupAuthorized || bundleInfo.isIncluded || bundleConflict.hasConflict}
                              className={`w-6 h-6 rounded border-2 flex items-center justify-center transition-colors ${
                                isSelected && !isBeingRemoved
                                  ? 'bg-oe-primary border-oe-primary text-white'
                                  : 'border-gray-300 hover:border-gray-400'
                              } ${(!product.isGroupAuthorized || bundleInfo.isIncluded || bundleConflict.hasConflict) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                            >
                              {isSelected && !isBeingRemoved && <Check className="h-4 w-4" />}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Bundle Products Display */}
                      {product.isBundle && product.includedProducts && product.includedProducts.length > 0 && (() => {
                        // Get bundle's selected configuration
                        const bundleSelectedConfig = configValues[product.productId];
                        
                        // Calculate display prices for this bundle
                        const bundleProducts = product.includedProducts.map((ip: any) => ({
                          productId: ip.productId,
                          productName: ip.productName,
                          monthlyPremium: includedProductPrices[`${product.productId}-${ip.productId}`] || 0,
                          hidePricing: ip.hidePricing || false,
                          linkedToProductId: ip.linkedToProductId || null,
                          pricingVariations: []
                        }));
                        
                        // Map bundle's config to all its included products for price calculation
                        const includedProductConfigs: Record<string, string> = {};
                        if (bundleSelectedConfig) {
                          bundleProducts.forEach((bp: any) => {
                            includedProductConfigs[bp.productId] = bundleSelectedConfig;
                          });
                        }
                        
                        const displayPrices = calculateBundleDisplayPrices(bundleProducts, includedProductConfigs);
                        
                        return (
                          <div className="mt-4 pt-4 border-t border-gray-200">
                            <div className="space-y-3">
                              {product.includedProducts.map((includedProduct, index) => {
                                const isPriceHidden = isProductPriceHidden(includedProduct.productId, displayPrices.hiddenProductIds);
                                const displayPriceResult = displayPrices.displayPrices.get(includedProduct.productId);
                                const displayPrice = displayPriceResult?.displayPrice;
                                const actualPrice = includedProductPrices[`${product.productId}-${includedProduct.productId}`] || 0;
                                
                                return (
                                  <div key={includedProduct.productId || index} className="bg-gray-50 rounded-lg p-3">
                                    <div className="flex justify-between items-start">
                                      <div className="flex-1">
                                        <h4 className="text-sm font-medium text-gray-900">
                                          {includedProduct.productName}
                                        </h4>
                                        <p className="text-xs text-gray-600 mt-1">
                                          {includedProduct.description}
                                        </p>
                                        <div className="mt-2">
                                          <span className="text-sm font-medium text-gray-900">
                                            {isPriceHidden ? (
                                              <span className="text-gray-500 text-xs">Included</span>
                                            ) : displayPrice !== null && displayPrice !== undefined && displayPrice !== actualPrice ? (
                                              `$${displayPrice.toFixed(2)}/month`
                                            ) : actualPrice > 0 ? (
                                              `$${actualPrice.toFixed(2)}/month`
                                            ) : (
                                              <span className="flex items-center text-gray-500">
                                                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                                Calculating...
                                              </span>
                                            )}
                                          </span>
                                        </div>
                                    
                                    {/* Configuration for included products */}
                                    {includedProduct.requiredDataFields && includedProduct.requiredDataFields.length > 0 && (
                                      <div className="mt-3">
                                        {includedProduct.requiredDataFields.map((field) => {
                                          const bundleConfigKey = `${product.productId}-${includedProduct.productId}`;
                                          return (
                                            <div key={field.id}>
                                              <label className="block text-xs font-medium text-gray-700 mb-1">
                                                {field.fieldName}
                                              </label>
                                              <select
                                                value={configValues[bundleConfigKey] || field.fieldOptions[0] || ''}
                                                onChange={(e) => handleBundleConfigChange(product.productId, includedProduct.productId, e.target.value)}
                                                className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-oe-primary"
                                              >
                                                {field.fieldOptions.map((option) => (
                                                  <option key={option} value={option}>
                                                    {option}
                                                  </option>
                                                ))}
                                              </select>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                  
                                  {/* Product Info button */}
                                  {includedProduct.productDocumentUrl && (
                                    <button
                                      onClick={() => handleProductInfoClick({
                                        ...includedProduct,
                                        productId: includedProduct.productId,
                                        name: includedProduct.productName,
                                        productDocumentUrl: includedProduct.productDocumentUrl || '',
                                        productImageUrl: '',
                                        productLogoUrl: '',
                                        basePrice: 0,
                                        effectiveDateLogic: '',
                                        isEnrolled: false,
                                        canEnroll: true,
                                        isGroupAuthorized: true,
                                        requiredDataFields: [],
                                        acknowledgementQuestions: []
                                      })}
                                      className="ml-2 inline-flex items-center px-2 py-1 rounded text-xs font-medium text-oe-primary hover:text-blue-800 hover:bg-blue-50"
                                    >
                                      <FileText className="h-3 w-3 mr-1" />
                                      Product Info
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Configuration for individual products */}
                      {!product.isBundle && product.requiredDataFields.length > 0 && (
                        <div className="mt-4 pt-4 border-t border-gray-200">
                          <div className="space-y-3">
                            {product.requiredDataFields.map((field) => (
                              <div key={field.id}>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                  {field.fieldName}
                                </label>
                                            <select
                                              value={currentConfig}
                                              onChange={(e) => handleConfigChange(product.productId, e.target.value)}
                                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                            >
                                              {field.fieldOptions.map((option) => (
                                                <option key={option} value={option}>
                                                  {option}
                                                </option>
                                              ))}
                                            </select>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        
        {/* Remove Confirmation Dialog */}
        {showRemoveConfirm && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-lg max-w-md w-full p-6">
              <div className="flex items-center mb-4">
                <div className="flex-shrink-0">
                  <X className="h-6 w-6 text-red-600" />
                </div>
                <div className="ml-3">
                  <h3 className="text-lg font-medium text-gray-900">Remove Product</h3>
                </div>
              </div>
              <div className="mb-6">
                <p className="text-sm text-gray-600">
                  Are you sure you want to remove this product from your plan? This action can be undone.
                </p>
              </div>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setShowRemoveConfirm(null)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleConfirmRemove(showRemoveConfirm)}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700"
                >
                  Remove Product
                </button>
              </div>
            </div>
          </div>
        )}
        
        {/* Product Info Modal */}
        <ProductInfoModal
          isOpen={showProductInfoModal}
          onClose={() => setShowProductInfoModal(false)}
          product={selectedProductForInfo}
          isBundle={selectedProductForInfo?.isBundle || false}
          includedProducts={selectedProductForInfo?.includedProducts || []}
        />
      </div>
    );
  };

  // Format date for display
  const formatEffectiveDate = (dateString: string | undefined) => {
    if (!dateString) return 'To be determined';
    
    try {
      // For calendar dates (billing, effective dates), parse date parts separately to avoid timezone issues
      // Server returns UTC dates like "2025-11-05T00:00:00Z"
      const [datePart] = dateString.split('T');
      const [year, month, day] = datePart.split('-');
      const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch (error) {
      console.error('Error formatting date:', error);
      return dateString;
    }
  };

  // Render review step
  const renderReview = () => (
    <div className="space-y-6 pb-32">
      <div className="mb-8">
        <h2 className="text-2xl font-semibold text-gray-900">Confirm Changes</h2>
      </div>


      {/* Dependent Changes Summary */}
      {selectedActions.includes('dependents') && (dependentsToAdd.length > 0 || dependentsToRemove.length > 0) && (
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Household Changes</h3>
          
          {dependentsToAdd.length > 0 && (
            <div className="mb-4">
              <p className="text-sm font-medium text-green-700 mb-2">Adding:</p>
              <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
                {dependentsToAdd.map((dep, idx) => (
                  <li key={idx}>{dep.firstName} {dep.lastName} ({dep.relationshipType === 'S' ? 'Spouse' : 'Child'})</li>
                ))}
              </ul>
            </div>
          )}
          
          {dependentsToRemove.length > 0 && (
            <div>
              <p className="text-sm font-medium text-red-700 mb-2">Removing:</p>
              <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
                {dependentsToRemove.map((memberId) => {
                  const member = householdData?.householdMembers?.find((m: any) => m.MemberId === memberId);
                  return member ? (
                    <li key={memberId}>{member.FirstName} {member.LastName}</li>
                  ) : null;
                })}
              </ul>
            </div>
          )}

          {(() => {
            const oldTobacco = (memberProfile?.tobaccoUse === 'Y' || memberProfile?.tobaccoUse === 'Yes') ? 'Yes' : 'No';
            const newTobacco = tobaccoUse;
            return oldTobacco !== newTobacco && (
              <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                <p className="text-sm text-yellow-800">
                  <strong>Tobacco Status Change:</strong> {oldTobacco} → {newTobacco}
                </p>
              </div>
            );
          })()}
        </div>
      )}

      {/* Plan Changes Summary - Show when managing plans OR when tier/tobacco changed (affects existing products) */}
      {(() => {
        // Normalize tobacco values for comparison
        const originalTobacco = (memberProfile?.tobaccoUse === 'Yes' || memberProfile?.tobaccoUse === 'Y') ? 'Yes' : 'No';
        const hasTobaccoChange = tobaccoUse !== originalTobacco;
        const hasHouseholdImpact = showTierChange || hasTobaccoChange;
        
        
        return (selectedActions.includes('plans') || hasHouseholdImpact) && (
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
              {selectedActions.includes('plans') ? 'Plan Changes' : 'Premium Changes Due to Household Updates'}
            </h3>
          
          <div className="space-y-4">
            {/* Current Plan */}
            <div className="py-2 border-b border-gray-200 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-gray-900">Current Total Premium</span>
                <span className="text-sm font-medium text-gray-900">
                  {isPricingLoading ? (
                    <span className="flex items-center text-gray-500">
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      Calculating...
                    </span>
                  ) : (
                    `$${currentMonthlyPremium.toFixed(2)}/mo`
                  )}
                </span>
              </div>
              {(() => {
                // Calculate current employer contribution from Contribution enrollments
                const currentEmployerContribution = allContributionEnrollments.reduce((sum: number, e: any) => {
                  const employerContrib = e.employerContributionAmount || e.EmployerContributionAmount || 0;
                  return sum + employerContrib;
                }, 0);
                const hasCurrentEmployerContributions = currentEmployerContribution > 0;
                
                // Calculate current processing fees from fee enrollments
                const currentProcessingFeeEnrollments = (isManagingForMember ? (memberSpecificEnrollmentsRaw || []) : (currentUserRawEnrollments || [])).filter((e: any) => {
                  const enrollmentType = e.enrollmentType || e.EnrollmentType;
                  return (enrollmentType === 'PaymentProcessingFee' || enrollmentType === 'ProcessingFee' || enrollmentType === 'SystemFee') && e.status === 'Active';
                });
                const currentProcessingFees = currentProcessingFeeEnrollments.reduce((sum: number, e: any) => {
                  const feeAmount = e.premiumAmount || e.PremiumAmount || 0;
                  return sum + feeAmount;
                }, 0);
                
                return (
                  <>
                    {/* Current Fees - Show if > 0 */}
                    {currentProcessingFees > 0 && (
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-600">Current Fees</span>
                        <span className="text-sm text-gray-600">${currentProcessingFees.toFixed(2)}/mo</span>
                      </div>
                    )}
                    
                    {/* Current Employer Contributions - Show if > 0 */}
                    {hasCurrentEmployerContributions && (
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-600">Current Employer Contribution</span>
                        <span className="text-sm font-medium text-green-600">-${currentEmployerContribution.toFixed(2)}/mo</span>
                      </div>
                    )}
                    
                    {/* Current Monthly Contribution (always show) */}
                    <div className="flex justify-between items-center pt-1 border-t border-gray-100">
                      <span className="text-sm font-medium text-gray-900">Current Monthly Contribution</span>
                      <span className="text-sm font-medium text-gray-900">
                        {isPricingLoading ? (
                          <span className="flex items-center text-gray-500">
                            <Loader2 className="h-3 w-3 animate-spin mr-1" />
                            Calculating...
                          </span>
                        ) : (
                          `$${currentTotal.toFixed(2)}/mo`
                        )}
                      </span>
                    </div>
                  </>
                );
              })()}
            </div>
            
            {/* Show existing products with updated pricing when tier/tobacco changes */}
            {!selectedActions.includes('plans') && hasHouseholdImpact && groupedEnrollments && (
              <div className="py-2 border-b border-gray-200">
                <div className="text-sm font-medium text-gray-900 mb-3">Your Existing Products</div>
                <div className="space-y-3">
                  {groupedEnrollments
                    .filter(ge => {
                      // Only show active product enrollments (exclude fees and contributions)
                      if (ge.status !== 'Active') return false;
                      const enrollmentType = ge.primaryEnrollment?.enrollmentType || ge.enrollments?.[0]?.enrollmentType;
                      return isProductEnrollment(enrollmentType);
                    })
                    .map(ge => {
                      const productId = ge.type === 'bundle' ? ge.bundleId : ge.primaryEnrollment?.productId;
                      if (!productId) return null;
                      
                      const productName = ge.type === 'bundle' 
                        ? ge.bundleName 
                        : ge.primaryEnrollment?.product?.name || 'Unknown Product';
                      
                      const oldPremium = ge.totalPremium || 0;
                      
                      // Calculate new premium with updated tier/tobacco
                      const product = products.find(p => p.productId === productId);
                      let newPremium = product?.isBundle 
                        ? getBundleTotalPrice(product)
                        : (productPrices[productId] || oldPremium);
                      
                      // For household changes, if productPrices isn't populated, use backend calculation or totalCosts
                      if ((!productPrices[productId] || productPrices[productId] === 0) && hasHouseholdImpact) {
                        // Use backend calculation if available, otherwise use totalCosts
                        // For single product, the total equals the product premium
                        if (calculatedCharges?.newMonthlyTotal && calculatedCharges.newMonthlyTotal > 0) {
                          newPremium = calculatedCharges.newMonthlyTotal;
                        } else if (totalCosts.totalCost > 0) {
                          newPremium = totalCosts.totalCost;
                        }
                      }
                      
                      const priceDiff = newPremium - oldPremium;
                      
                      return (
                        <div key={productId} className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                          <div className="flex justify-between items-start mb-2">
                            <span className="font-medium text-gray-900">{productName}</span>
                          </div>
                          {getConfigDisplayText(productId) && (
                            <div className="text-xs text-gray-600 mb-2">
                              {getConfigDisplayText(productId).replace(/[()]/g, '')}
                            </div>
                          )}
                          {(effectiveDatesData?.effectiveDateOptions?.fixedDate || effectiveDatesData?.effectiveDateOptions?.availableDates?.[0]) && (
                            <div className="text-xs text-oe-primary mb-2">
                              Price Change Effective: {formatEffectiveDate(effectiveDatesData?.effectiveDateOptions?.fixedDate || effectiveDatesData?.effectiveDateOptions?.availableDates?.[0])}
                            </div>
                          )}
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-gray-600">Current Premium:</span>
                            <span className="text-sm font-medium text-gray-900">${oldPremium.toFixed(2)}/mo</span>
                          </div>
                          <div className="flex justify-between items-center mt-1">
                            <span className="text-sm text-gray-600">New Premium:</span>
                            <span className={`text-sm font-medium ${priceDiff > 0 ? 'text-orange-600' : priceDiff < 0 ? 'text-green-600' : 'text-gray-900'}`}>
                              ${newPremium.toFixed(2)}/mo
                              {priceDiff !== 0 && (
                                <span className="ml-2 text-xs">
                                  ({priceDiff > 0 ? '+' : ''}{priceDiff.toFixed(2)})
                                </span>
                              )}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                </div>
                
                {/* NEW MONTHLY PREMIUM TOTAL - After repricing */}
                <div className="mt-4 pt-4 border-t border-gray-300">
                  <div className="flex justify-between items-center">
                    <span className="text-base font-semibold text-gray-900">New Monthly Premium</span>
                    <span className="text-base font-semibold text-gray-900">
                      {(() => {
                        // Calculate new premium from products shown above (sum of new premiums)
                        const newPremiumTotal = groupedEnrollments
                          ?.filter(ge => {
                            if (ge.status !== 'Active') return false;
                            const enrollmentType = ge.primaryEnrollment?.enrollmentType || ge.enrollments?.[0]?.enrollmentType;
                            return isProductEnrollment(enrollmentType);
                          })
                          .reduce((sum: number, ge: any) => {
                            const productId = ge.type === 'bundle' ? ge.bundleId : ge.primaryEnrollment?.productId;
                            if (!productId) return sum;
                            const product = products.find(p => p.productId === productId);
                            const newPremium = product?.isBundle 
                              ? getBundleTotalPrice(product)
                              : (productPrices[productId] || ge.totalPremium || 0);
                            return sum + newPremium;
                          }, 0) || 0;
                        
                        // Fallback to totalCosts.totalCost if available, then backend calculation
                        const backendTotal = calculatedCharges?.newMonthlyTotal || 0;
                        const newPremium = newPremiumTotal > 0 
                          ? newPremiumTotal
                          : (totalCosts.totalCost > 0 
                            ? totalCosts.totalCost 
                            : backendTotal);
                        
                        // Compare premium to premium (not total to total which includes fees/contributions)
                        const totalChange = newPremium - currentMonthlyPremium;
                        
                        return (
                          <div className="text-right">
                            <div>${newPremium.toFixed(2)}/mo</div>
                            {totalChange !== 0 && (
                              <div className={`text-xs font-normal mt-1 ${totalChange > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                                ({totalChange > 0 ? '+' : ''}{totalChange.toFixed(2)}/mo)
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </span>
                  </div>
                </div>
              </div>
            )}
            
            {/* Plan Changes Details */}
            {(() => {
              // Check if there are any changes: removed products, added products, config changes, OR tier/tobacco changes
              const hasRemovedProducts = removedProducts.length > 0;
              const hasAddedProducts = selectedProducts.some(id => !initialSelectedProducts.includes(id));
              const hasConfigChanges = selectedProducts.some(productId => {
                const product = products.find(p => p.productId === productId);
                if (product?.isBundle && product.includedProducts) {
                  // Check bundle sub-product configs
                  return product.includedProducts.some(ip => {
                    const key = `${productId}-${ip.productId}`;
                    return configValues[key] !== initialConfigValues[key];
                  });
                }
                // Check individual product config
                return configValues[productId] !== initialConfigValues[productId];
              });
              
              const hasTierChange = showTierChange;
              const hasTobaccoChange = tobaccoUse !== memberProfile?.tobaccoUse;
              
              console.log('🔍 Plan Changes section conditional:', {
                hasRemovedProducts,
                hasAddedProducts,
                hasConfigChanges,
                hasTierChange,
                hasTobaccoChange,
                willRenderSection: hasRemovedProducts || hasAddedProducts || hasConfigChanges || hasTierChange || hasTobaccoChange
              });
              
              return (hasRemovedProducts || hasAddedProducts || hasConfigChanges || hasTierChange || hasTobaccoChange) && (
                <div className="py-2 border-b border-gray-200">
                  <div className="text-sm font-medium text-gray-900 mb-2">Plan Changes</div>
                <div className="space-y-1 text-sm">
                  {/* Show removed products */}
                  {removedProducts.map(productId => {
                    const product = products.find(p => p.productId === productId);
                    const productName = product?.name || 'Unknown Product';
                    
                    // Get premium from grouped enrollment
                    const groupedEnrollment = groupedEnrollments?.find(ge => {
                      if (ge.type === 'bundle' && ge.bundleId === productId) {
                        return true;
                      } else if (ge.type === 'individual' && ge.primaryEnrollment?.productId === productId) {
                        return true;
                      }
                      return false;
                    });
                    
                    let premium = 0;
                    let terminationDate: string | undefined;
                    if (groupedEnrollment) {
                      if (groupedEnrollment.type === 'bundle') {
                        premium = groupedEnrollment.totalPremium || 0;
                        terminationDate = groupedEnrollment.enrollments?.[0]?.effectiveDate;
                      } else if (groupedEnrollment.primaryEnrollment) {
                        premium = groupedEnrollment.primaryEnrollment.premiumAmount || 0;
                        terminationDate = groupedEnrollment.primaryEnrollment.effectiveDate;
                      }
                    }
                    
                    return (
                      <div key={productId} className="py-2 border-b border-gray-200 last:border-b-0">
                        <div className="flex justify-between items-start">
                          <div className="flex-1">
                            <div className="flex justify-between">
                              <span className="text-gray-900 font-medium">Remove {productName}{getConfigDisplayText(productId)}</span>
                              <span className="text-red-600 font-medium">-${premium.toFixed(2)}</span>
                            </div>
                            {terminationDate && (
                              <div className="text-xs text-gray-600 mt-1">
                                Termination Date: {formatEffectiveDate(terminationDate)}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  
                  {/* Show products being added */}
                  {selectedProducts
                    .filter(productId => !initialSelectedProducts.includes(productId))
                    .map(productId => {
                      const product = products.find(p => p.productId === productId);
                      const productName = product?.name || 'Unknown Product';
                      const premium = product?.isBundle 
                        ? getBundleTotalPrice(product)
                        : (productPrices[productId] || product?.basePrice || 0);
                      
                      return (
                        <div key={productId} className="py-2 border-b border-gray-200 last:border-b-0">
                          <div className="flex justify-between items-start">
                            <div className="flex-1">
                              <div className="flex justify-between">
                                <span className="text-gray-900 font-medium">{productName}{getConfigDisplayText(productId)}</span>
                                <span className="text-gray-900 font-medium">
                                  {premium > 0 ? (
                                    `+$${premium.toFixed(2)}`
                                  ) : (
                                    <span className="flex items-center text-gray-500">
                                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                      Calculating...
                                    </span>
                                  )}
                                </span>
                              </div>
                              {(effectiveDatesData?.effectiveDateOptions?.fixedDate || effectiveDatesData?.effectiveDateOptions?.availableDates?.[0]) && (
                                <div className="text-xs text-gray-600 mt-1">
                                  Effective Date: {formatEffectiveDate(effectiveDatesData?.effectiveDateOptions?.fixedDate || effectiveDatesData?.effectiveDateOptions?.availableDates?.[0])}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  
                  {/* Show existing products with configuration changes */}
                  {selectedProducts
                    .filter(productId => initialSelectedProducts.includes(productId))
                    .filter(productId => {
                      const product = products.find(p => p.productId === productId);
                      if (product?.isBundle && product.includedProducts) {
                        return product.includedProducts.some(ip => {
                          const key = `${productId}-${ip.productId}`;
                          const hasInitialValue = initialConfigValues[key] !== undefined;
                          return hasInitialValue && configValues[key] !== initialConfigValues[key];
                        });
                      }
                      // Only show config change if we have a valid initial value
                      const hasInitialValue = initialConfigValues[productId] !== undefined;
                      return hasInitialValue && configValues[productId] !== initialConfigValues[productId];
                    })
                    .map(productId => {
                      const product = products.find(p => p.productId === productId);
                      const productName = product?.name || 'Unknown Product';
                      const oldPremium = (() => {
                        const ge = groupedEnrollments?.find(e => 
                          (e.type === 'bundle' && e.bundleId === productId) ||
                          (e.type === 'individual' && e.primaryEnrollment?.productId === productId)
                        );
                        return ge?.totalPremium || 0;
                      })();
                      const newPremium = product?.isBundle 
                        ? getBundleTotalPrice(product)
                        : (productPrices[productId] || 0);
                      const priceDiff = newPremium - oldPremium;
                      
                      // For bundles, find the configurable component to get its config values
                      let oldConfig = 'Unknown';
                      let newConfig = 'Unknown';
                      
                      if (product?.isBundle && product.includedProducts) {
                        // Find the first included product with configuration fields
                        const configurableComponent = product.includedProducts.find(ip => 
                          ip.requiredDataFields && ip.requiredDataFields.length > 0
                        );
                        
                        if (configurableComponent) {
                          const bundleComponentKey = `${productId}-${configurableComponent.productId}`;
                          oldConfig = initialConfigValues[bundleComponentKey] || 'Default';
                          newConfig = configValues[bundleComponentKey] || 'Default';
                        }
                      } else {
                        oldConfig = initialConfigValues[productId] || 'Default';
                        newConfig = configValues[productId] || 'Default';
                      }
                      
                      console.log('🔍 DEBUG: Config change pricing', {
                        productId,
                        productName,
                        oldConfig,
                        newConfig,
                        oldPremium,
                        newPremium,
                        priceDiff,
                        productPricesValue: productPrices[productId],
                        isBundle: product?.isBundle
                      });
                      
                      return (
                        <div key={productId} className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                          <div className="flex justify-between items-start mb-2">
                            <span className="font-medium text-gray-900">{productName}</span>
                          </div>
                          <div className="text-xs text-gray-600 mb-2">
                            Configuration: {oldConfig} → {newConfig}
                          </div>
                          {(effectiveDatesData?.effectiveDateOptions?.fixedDate || effectiveDatesData?.effectiveDateOptions?.availableDates?.[0]) && (
                            <div className="text-xs text-oe-primary mb-2">
                              Change Effective: {formatEffectiveDate(effectiveDatesData?.effectiveDateOptions?.fixedDate || effectiveDatesData?.effectiveDateOptions?.availableDates?.[0])}
                            </div>
                          )}
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-gray-600">Current Premium:</span>
                            <span className="text-sm font-medium text-gray-900">${oldPremium.toFixed(2)}/mo</span>
                          </div>
                          <div className="flex justify-between items-center mt-1">
                            <span className="text-sm text-gray-600">New Premium:</span>
                            <span className={`text-sm font-medium ${newPremium > oldPremium ? 'text-red-600' : newPremium < oldPremium ? 'text-green-600' : 'text-gray-900'}`}>
                              {newPremium > 0 ? (
                                <>
                                  ${newPremium.toFixed(2)}/mo
                                  {newPremium !== oldPremium && (
                                    <span className="ml-2 text-xs">
                                      ({newPremium > oldPremium ? '+' : ''}{(newPremium - oldPremium).toFixed(2)})
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span className="flex items-center text-gray-500">
                                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                  Calculating...
                                </span>
                              )}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  
                  {/* Show subtotal and employer contributions breakdown for group members */}
                  {isGroupMember ? (() => {
                    // Check if there are household changes (tier/tobacco changes) that affect existing products
                    const originalTobacco = (memberProfile?.tobaccoUse === 'Yes' || memberProfile?.tobaccoUse === 'Y') ? 'Yes' : 'No';
                    const hasTobaccoChange = tobaccoUse !== originalTobacco;
                    const hasHouseholdImpact = showTierChange || hasTobaccoChange;
                    
                    // Get products to calculate: either explicitly selected OR existing products (if household changes)
                    const productsToCalculate = selectedProducts.length > 0 
                      ? selectedProducts 
                      : (groupedEnrollments?.filter(ge => {
                          if (ge.status !== 'Active') return false;
                          const enrollmentType = ge.primaryEnrollment?.enrollmentType || ge.enrollments?.[0]?.enrollmentType;
                          return isProductEnrollment(enrollmentType);
                        }).map(ge => ge.type === 'bundle' ? ge.bundleId : ge.primaryEnrollment?.productId).filter(Boolean) as string[] || []);
                    
                    // Calculate total premium before employer contributions
                    const totalPremiumBeforeContributions = productsToCalculate
                      .filter(productId => !removedProducts.includes(productId))
                      .reduce((sum, productId) => {
                        const product = products.find(p => p.productId === productId);
                        const premium = product?.isBundle 
                          ? getBundleTotalPrice(product)
                          : (productPrices[productId] || 0);
                        return sum + premium;
                      }, 0);
                    
                    // Get all active product IDs (not removed)
                    const activeSelectedProductIds = productsToCalculate.filter(productId => !removedProducts.includes(productId));
                    
                    // Filter to show rules that apply to:
                    // 1. All products (ProductId === null) - these apply to ALL selected products
                    // 2. Specific products that are currently selected
                    // 3. Member's job position (if rule has JobPositions filter)
                    const memberCriteria = {
                      age: memberProfile?.age || 35,
                      jobPosition: memberProfile?.jobPosition
                    };
                    
                    const allRelevantRules = (Array.isArray(groupContributionRules) ? groupContributionRules : []).filter((rule: any) => 
                      rule.Status === 'Active' && 
                      (rule.ProductId === null || activeSelectedProductIds.includes(rule.ProductId)) &&
                      (rule.FlatRateAmount || 0) > 0
                    );
                    
                    // Filter by member criteria (job position)
                    const relevantRules = filterRulesByMemberCriteria(allRelevantRules, memberCriteria);
                    
                    console.log('🔍 DEBUG: Group contribution rules in review:', {
                      isGroupMember,
                      memberProfileGroupId: memberProfile?.groupId,
                      groupContributionRules: (Array.isArray(groupContributionRules) ? groupContributionRules : []).map(r => ({
                        Name: r.Name,
                        ProductId: r.ProductId,
                        Status: r.Status,
                        FlatRateAmount: r.FlatRateAmount
                      })),
                      activeSelectedProductIds,
                      relevantRules: relevantRules?.map(r => ({
                        Name: r.Name,
                        ProductId: r.ProductId,
                        FlatRateAmount: r.FlatRateAmount
                      }))
                    });
                    
                    // Use totalCosts.employerContribution directly - it's already calculated correctly by ContributionCalculator
                    // This handles age-based, tier-based, and flat-rate contributions correctly
                    const totalEmployerContribution = totalCosts.employerContribution || 0;
                    const hasEmployerContributions = totalEmployerContribution > 0;
                    
                    // Calculate final contribution: employee contribution + processing fees (unless MaxEmployee rule applies)
                    // Check if MaxEmployee rule is applied
                    const hasMaxEmployeeRule = (Array.isArray(groupContributionRules) ? groupContributionRules : []).some(
                      (rule: any) => 
                        rule.Status === 'Active' && 
                        rule.ContributionDirection === 'MaxEmployee'
                    );
                    
                    // Use totalCosts if available (from ContributionCalculator), otherwise use calculatedPremium or backend calculation
                    // For household changes, totalCosts should have the correct value from updateTotalCosts
                    // Fallback to backend calculation if available (for household changes, this matches the "New Monthly Premium" above)
                    const backendTotal = calculatedCharges?.newMonthlyTotal || 0;
                    const displayTotalPremium = totalCosts.totalCost > 0 
                      ? totalCosts.totalCost 
                      : (backendTotal > 0 ? backendTotal : totalPremiumBeforeContributions);
                    
                    let finalContribution = 0;
                    if (!isPricingLoading && displayTotalPremium > 0) {
                      if (hasMaxEmployeeRule && processingFee > 0) {
                        // MaxEmployee rule: employer covers processing fees
                        const adjustedContributions = ContributionCalculator.adjustContributionsForProcessingFees(
                          totalCosts.employerContribution,
                          totalCosts.employeeContribution,
                          processingFee,
                          true // hasMaxEmployeeRule
                        );
                        finalContribution = adjustedContributions.adjustedEmployeeContribution;
                      } else {
                        // Regular rules: employee pays contribution + processing fees
                        // Use employeeContribution from totalCosts if available (already calculated by ContributionCalculator)
                        // If employeeContribution is 0 but employerContribution > 0, calculate it: premium - employer
                        let employeeAmount = totalCosts.employeeContribution;
                        if (employeeAmount <= 0 && totalCosts.employerContribution > 0) {
                          employeeAmount = displayTotalPremium - totalCosts.employerContribution;
                        } else if (employeeAmount <= 0) {
                          employeeAmount = displayTotalPremium;
                        }
                        finalContribution = employeeAmount + processingFee;
                      }
                    }
                    
                    console.log('🔍 DEBUG: Plan Changes section display values:', {
                      totalCosts_totalCost: totalCosts.totalCost,
                      totalPremiumBeforeContributions,
                      displayTotalPremium,
                      totalCosts_employeeContribution: totalCosts.employeeContribution,
                      totalCosts_employerContribution: totalCosts.employerContribution,
                      processingFee,
                      finalContribution,
                      hasHouseholdImpact,
                      activeSelectedProductIds_length: activeSelectedProductIds.length
                    });
                    
                    // Check if we should show loading state - hide all numbers until calculation is ready
                    const currentStepDataForGroup = steps[currentStep];
                    const isReviewStepForGroup = currentStepDataForGroup?.id === 'review';
                    const isCalculatingForGroup = isReviewStepForGroup && (isPricingLoading || (calculationAttempted && !calculatedCharges && !calculationFailed));
                    
                    return (
                      <>
                        {/* Total Premium (before contributions) */}
                        <div className="flex justify-between pt-2 border-t border-gray-100">
                          <span className="text-sm text-gray-700">Total Premium</span>
                          <span className="text-sm text-gray-900">
                            {isCalculatingForGroup ? (
                              <span className="flex items-center text-gray-500">
                                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                Calculating...
                              </span>
                            ) : (
                              `$${displayTotalPremium.toFixed(2)}/mo`
                            )}
                          </span>
                        </div>
                        
                        {/* Fees - Always show if > 0 (calculated from totalPremium) */}
                        {!isCalculatingForGroup && processingFee > 0 && (
                          <div className="flex justify-between pt-2 border-t border-gray-100">
                            <span className="text-sm text-gray-700">Fees</span>
                            <span className="text-sm text-gray-900">${processingFee.toFixed(2)}/mo</span>
                          </div>
                        )}
                        
                        {/* Subtotal - Show if processing fees exist AND there are employer contributions to deduct */}
                        {!isCalculatingForGroup && hasEmployerContributions && processingFee > 0 && (
                          <div className="flex justify-between pt-2 border-t border-gray-100">
                            <span className="text-sm font-medium text-gray-700">Subtotal</span>
                            <span className="text-sm font-medium text-gray-900">
                              ${(displayTotalPremium + processingFee).toFixed(2)}/mo
                            </span>
                          </div>
                        )}
                        
                        {/* Employer Contributions - Always show if > 0 (matches EnrollmentWizard pattern) */}
                        {!isCalculatingForGroup && totalEmployerContribution > 0 && (
                          <div className="pt-2 border-t border-gray-100">
                            <div className="text-xs font-medium text-gray-700 mb-1">
                              Employer Contributions:
                            </div>
                            <div className="flex justify-between ml-2">
                              <span className="text-green-700 text-xs">Employer Contribution</span>
                              <span className="text-green-600 text-xs">-${totalEmployerContribution.toFixed(2)}</span>
                            </div>
                          </div>
                        )}
                        
                        {/* Final Contribution (includes processing fees) */}
                        <div className="flex justify-between font-medium pt-2 border-t border-gray-200">
                          <span className="text-gray-900">New Monthly Contribution</span>
                          <span className="text-gray-900">
                            {isCalculatingForGroup ? (
                              <span className="flex items-center text-gray-500">
                                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                Calculating...
                              </span>
                            ) : (
                              `$${finalContribution.toFixed(2)}/mo`
                            )}
                          </span>
                        </div>
                      </>
                    );
                  })() : (
                    /* Non-group members: show monthly premium + due today */
                    <>
                      {(() => {
                        const currentStepData = steps[currentStep];
                        const isReviewStep = currentStepData?.id === 'review';
                        return !calculatedCharges && isReviewStep && (
                          <div className="flex items-center gap-2 text-gray-600 py-3 border-t border-gray-200">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            <span>Calculating pricing from backend...</span>
                          </div>
                        );
                      })()}
                      {(() => {
                        const chargeInfo = calculateImmediateCharge();
                        const correctMonthlyTotal = calculateCorrectMonthlyTotal();
                        const currentStepData = steps[currentStep];
                        const isReviewStep = currentStepData?.id === 'review';
                        
                        // Calculate contributions for display (matching EnrollmentWizard pattern)
                        const displayEmployerContribution = totalCosts.employerContribution;
                        let adjustedEmployeeContribution = totalCosts.employeeContribution;
                        
                        // Adjust for MaxEmployee rule (employer covers processing fees)
                        if (hasMaxEmployeeRuleApplied && processingFee > 0) {
                          const adjustedContributions = ContributionCalculator.adjustContributionsForProcessingFees(
                            totalCosts.employerContribution,
                            totalCosts.employeeContribution,
                            processingFee,
                            true // hasMaxEmployeeRule
                          );
                          adjustedEmployeeContribution = adjustedContributions.adjustedEmployeeContribution;
                        } else {
                          // For regular rules, processing fees are paid by employee
                          adjustedEmployeeContribution = totalCosts.employeeContribution + processingFee;
                        }

                        // Check if we should show loading state - hide all numbers until calculation is ready
                        const isCalculating = isReviewStep && (isPricingLoading || (calculationAttempted && !calculatedCharges && !calculationFailed));
                        
                        return (
                          <>
                            {/* Monthly Contribution Summary - Matching EnrollmentWizard pattern */}
                            <div className="space-y-3 pt-2 border-t border-gray-200">
                              <div className="flex justify-between">
                                <span className="text-gray-700">Monthly Premium</span>
                                <span className="font-medium">
                                  {isCalculating ? (
                                    <span className="flex items-center text-gray-500">
                                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                      Calculating...
                                    </span>
                                  ) : (
                                    `$${totalCosts.totalCost.toFixed(2)}`
                                  )}
                                </span>
                              </div>
                              
                              {/* Fees - Show BEFORE employer contribution (includes both system fees and payment processing fees) */}
                              {processingFee > 0 && !isCalculating && (
                                <div className="flex justify-between">
                                  <span className="text-gray-700">Fees</span>
                                  <span className="font-medium">${processingFee.toFixed(2)}</span>
                                </div>
                              )}
                              
                              {/* Show subtotal if processing fees exist */}
                              {processingFee > 0 && !isCalculating && (
                                <div className="flex justify-between border-t border-gray-200 pt-2">
                                  <span className="text-gray-700 font-medium">Subtotal</span>
                                  <span className="font-medium">${(totalCosts.totalCost + processingFee).toFixed(2)}</span>
                                </div>
                              )}
                              
                              {/* Employer Contribution - Only show for group members */}
                              {isGroupMember && displayEmployerContribution !== 0 && !isCalculating && (
                                <>
                                  <div className="flex justify-between text-green-600">
                                    <span>Employer Contribution</span>
                                    <span>
                                      {displayEmployerContribution < 0 ? '' : '-'}${Math.abs(displayEmployerContribution).toFixed(2)}
                                    </span>
                                  </div>
                                  {displayEmployerContribution !== 0 && (
                                    <div className="border-t border-gray-200 pt-2"></div>
                                  )}
                                </>
                              )}
                              
                              {/* Final Employee Contribution */}
                              <div className="flex justify-between text-lg font-semibold border-t border-gray-200 pt-2">
                                <span>{isGroupMember ? 'New Monthly Contribution:' : 'Total Monthly Contribution'}</span>
                                <span className="text-oe-primary text-xl">
                                  {isCalculating ? (
                                    <span className="flex items-center text-gray-500">
                                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                      Calculating...
                                    </span>
                                  ) : (
                                    `$${adjustedEmployeeContribution.toFixed(2)}`
                                  )}
                                </span>
                              </div>
                            </div>
                            
                            {/* Due Today - Highlighted */}
                            {!isGroupMember && (
                              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mt-3">
                                <div className="space-y-2">
                                  {/* Base charge */}
                                  <div className="flex justify-between items-center">
                                    <span className="text-sm text-gray-700">Base Charge:</span>
                                    <span className="text-sm font-medium text-gray-900">
                                      {isCalculating ? (
                                        <span className="flex items-center text-gray-500">
                                          <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                          Calculating...
                                        </span>
                                      ) : (
                                        `$${chargeInfo.dueToday.toFixed(2)}`
                                      )}
                                    </span>
                                  </div>
                                  
                                  {/* Fees */}
                                  {!isCalculating && calculatedCharges?.processingFee && calculatedCharges.processingFee > 0 && (
                                    <div className="flex justify-between items-center">
                                  <span className="text-sm text-gray-700">Fees:</span>
                                      <span className="text-sm font-medium text-gray-900">
                                        ${calculatedCharges.processingFee.toFixed(2)}
                                      </span>
                                    </div>
                                  )}
                                  
                                  {/* Total Due Today */}
                                  <div className="flex justify-between items-center pt-2 border-t border-yellow-300">
                                    <div>
                                      <span className="text-base font-semibold text-gray-900">Total Due Today</span>
                                      {!isCalculating && chargeInfo.isIncremental && (
                                        <p className="text-xs text-gray-600 mt-1">{chargeInfo.reason}</p>
                                      )}
                                      {!chargeInfo.isIncremental && chargeInfo.dueToday > 0 && (
                                        <p className="text-xs text-gray-600 mt-1">First month payment {calculatedCharges?.processingFee && calculatedCharges.processingFee > 0 ? '+ processing fee' : ''}</p>
                                      )}
                                    </div>
                                    <span className="text-2xl font-bold text-gray-900">
                                      {isCalculating ? (
                                        <span className="flex items-center text-gray-500">
                                          <Loader2 className="h-5 w-5 animate-spin mr-1" />
                                          Calculating...
                                        </span>
                                      ) : (
                                        `$${((calculatedCharges?.totalDueToday !== undefined ? calculatedCharges.totalDueToday : chargeInfo.dueToday) || 0).toFixed(2)}`
                                      )}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            )}
                            
                            {/* Contribution Breakdown - Debug mode only (matching EnrollmentWizard) */}
                            {pricingData && selectedProducts.length > 0 && (
                              <ContributionBreakdown
                                products={(pricingData as any)?.products || []}
                                selectedConfigs={configValues}
                                allProductsRules={(pricingData as any)?.allProductsRules || []}
                                totals={{
                                  totalPremium: totalCosts.totalCost,
                                  totalEmployerContribution: totalCosts.employerContribution,
                                  totalEmployeeContribution: totalCosts.employeeContribution
                                }}
                                memberTier={calculatedTier || memberProfile?.tier}
                                memberAge={memberProfile?.age}
                                memberJobPosition={memberProfile?.jobPosition}
                              />
                            )}
                          </>
                        );
                      })()}
                    </>
                  )}
                </div>
              </div>
              );
            })()}
          </div>
        </div>
      );
    })()}

      {/* Group Member Payment Notice */}
      {isGroupMember && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start">
            <Info className="h-5 w-5 text-oe-primary mr-3 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-blue-900">Group Member Payment</p>
              <p className="text-xs text-oe-primary-dark mt-1">
                Your employer handles payment processing for your benefits. Your contribution will be deducted from your paycheck.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Effective Date Message */}
      {(() => {
        // Check if all plans are being cancelled (all initial plans removed, no new plans added)
        const currentSelected = selectedProducts.filter(id => !removedProducts.includes(id));
        const hasNewProductsToAdd = currentSelected.some(productId => !initialSelectedProducts.includes(productId));
        const allPlansCancelled = removedProducts.length > 0 && 
          removedProducts.length === initialSelectedProducts.length && 
          !hasNewProductsToAdd;
        
        if (allPlansCancelled) {
          // Find the earliest effective date from removed products to determine termination message
          let earliestEffectiveDate: string | null = null;
          let hasFutureEffective = false;
          
          removedProducts.forEach(productId => {
            const enrollment = groupedEnrollments?.find(ge => 
              (ge.type === 'bundle' && ge.bundleId === productId) ||
              (ge.type === 'individual' && ge.primaryEnrollment?.productId === productId)
            );
            
            if (enrollment) {
              const effectiveDate = enrollment.type === 'bundle' 
                ? enrollment.enrollments?.[0]?.effectiveDate
                : enrollment.primaryEnrollment?.effectiveDate;
              
              if (effectiveDate) {
                if (!earliestEffectiveDate || new Date(effectiveDate) < new Date(earliestEffectiveDate)) {
                  earliestEffectiveDate = effectiveDate;
                }
                
                // Check if this is a future effective enrollment
                const effective = new Date(effectiveDate);
                const today = new Date();
                effective.setHours(0, 0, 0, 0);
                today.setHours(0, 0, 0, 0);
                if (effective > today) {
                  hasFutureEffective = true;
                }
              }
            }
          });
          
          // Determine termination message
          let terminationMessage = '';
          if (hasFutureEffective && earliestEffectiveDate) {
            // Future effective plan - will never go into effect, terminate immediately
            terminationMessage = 'Plan will terminate effective immediately';
          } else if (earliestEffectiveDate) {
            // Existing plan - terminate 1 month after effective date
            try {
              // Parse date parts separately to avoid timezone issues (UTC-safe)
              const [datePart] = String(earliestEffectiveDate).split('T');
              const [year, month, day] = datePart.split('-').map(Number);
              
              // Calculate 1 month after effective date (UTC-safe)
              const terminationYear = month === 12 ? year + 1 : year;
              const terminationMonth = month === 12 ? 1 : month + 1;
              const terminationDay = day; // Keep same day of month
              
              // Format as YYYY-MM-DD string for formatEffectiveDate
              const terminationDateStr = `${terminationYear}-${String(terminationMonth).padStart(2, '0')}-${String(terminationDay).padStart(2, '0')}`;
              terminationMessage = `Plan will terminate effective ${formatEffectiveDate(terminationDateStr)}`;
            } catch (error) {
              console.error('Error calculating termination date:', error);
              terminationMessage = 'Plan will terminate effective 1 month after current effective date';
            }
          } else {
            terminationMessage = 'Plan will terminate effective 1 month after current effective date';
          }
          
          return (
            <div className="text-center py-4">
              <div className="inline-block bg-blue-50 border border-blue-200 rounded-lg px-4 py-2">
                <span className="text-sm font-bold text-blue-800">
                  {terminationMessage}
                </span>
              </div>
            </div>
          );
        }
        
        // Show effective date for new products OR when tier/tobacco changes affect existing products
        const hasNewProductsToShow = hasNewProducts();
        const hasTierTobaccoChanges = showTierChange || tobaccoUse !== memberProfile?.tobaccoUse;
        const shouldShowEffectiveDate = hasNewProductsToShow || hasTierTobaccoChanges;
        
        // Use calculated effective date (prioritizes existing plan, falls back to API options)
        const effectiveDate = calculatedEffectiveDate;
        
        return shouldShowEffectiveDate && effectiveDate && (
          <div className="text-center py-4">
            <div className="inline-block bg-blue-50 border border-blue-200 rounded-lg px-4 py-2">
              <span className="text-sm font-bold text-blue-800">
                Plan changes will go into effect {formatEffectiveDate(effectiveDate)}
              </span>
            </div>
          </div>
        );
      })()}

      {/* Error Display */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <div className="flex items-start">
            <div className="flex-shrink-0">
              <X className="h-6 w-6 text-red-400" />
            </div>
            <div className="ml-3 flex-1">
              <h3 className="text-lg font-medium text-red-800">Unable to Complete Changes</h3>
              <div className="mt-2 text-sm text-red-700">
                <p>{error}</p>
              </div>
              {error.includes('Payment setup required') && (
                <div className="mt-3 p-3 bg-red-100 rounded-md">
                  <p className="text-sm text-red-600">
                    <strong>Next steps:</strong> Go to your account settings to add a payment method, then return to complete your plan changes.
                  </p>
                </div>
              )}
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="px-3 py-2 bg-red-100 text-red-800 text-sm font-medium rounded-lg hover:bg-red-200"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // Render acknowledgements and signature step (combined)
  // Only shown for NEW products (existing products already have acknowledgements on file)
  const renderAcknowledgements = () => (
    <div className="space-y-6 pb-32">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-gray-900">Product Acknowledgements & Signature</h2>
        <p className="text-gray-600">
          Please review and acknowledge the following statements for the new products you are adding, then sign below.
          {productAcknowledgements.length === 0 && (
            <span className="text-gray-500 italic"> (No acknowledgements required for existing products)</span>
          )}
        </p>
      </div>

      {/* Acknowledgements Section */}
      <div className="space-y-4">
        {productAcknowledgements.map((productAck) => (
          <div key={productAck.productId} className="bg-white rounded-lg border border-gray-200 p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">{productAck.productName}</h3>
            <div className="space-y-3">
              {(productAck.acknowledgements || []).map((ack: any) => (
                <div key={ack.id} className="flex items-start p-4 bg-gray-50 rounded-lg border border-gray-200">
                  <input
                    type="checkbox"
                    id={`ack-${productAck.productId}-${ack.id}`}
                    checked={acknowledgementResponses[`${productAck.productId}-${ack.id || ack.question}`] || false}
                    onChange={(e) => {
                      setAcknowledgementResponses(prev => ({
                        ...prev,
                        [`${productAck.productId}-${ack.id || ack.question}`]: e.target.checked
                      }));
                    }}
                    className="mt-1 h-5 w-5 flex-shrink-0 rounded border-gray-300 text-[#1f8dbf] focus:ring-[#1f8dbf]"
                  />
                  <div className="ml-3 flex-1">
                    <label
                      htmlFor={`ack-${productAck.productId}-${ack.id}`}
                      className="text-sm text-gray-700 cursor-pointer whitespace-pre-line block max-h-48 overflow-y-auto pr-2"
                    >
                      {ack.question}
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Digital Signature Section - Only required for NEW products */}
      {productAcknowledgements.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Digital Signature</h3>
          <p className="text-sm text-gray-600 mb-4">
            A digital signature is required for the new products you are adding.
          </p>
          <SignaturePad
            onSignatureChange={(signature) => {
              setDigitalSignature(signature || '');
              setIsSignatureValid((signature || '').length > 0);
            }}
          />

          <div className="mt-6 pt-6 border-t border-gray-200">
            <label className="flex items-start cursor-pointer">
              <input
                type="checkbox"
                checked={signatureAgreement}
                onChange={(e) => setSignatureAgreement(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-gray-300 text-[#1f8dbf] focus:ring-[#1f8dbf]"
              />
              <span className="ml-3 text-sm text-gray-700">
                I certify that the information provided is accurate and complete. I understand that my electronic signature
                is legally binding and has the same effect as a handwritten signature.
              </span>
            </label>
          </div>
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}
    </div>
  );

  // Render current step
  const renderCurrentStep = () => {
    const currentStepData = steps[currentStep];
    
    switch (currentStepData?.id) {
      case 'action-selection':
        return renderActionSelection();
      case 'manage-dependents':
        return renderManageDependents();
      case 'tobacco-question':
        return renderTobaccoQuestion();
      case 'manage-plans':
        return renderManagePlans();
      case 'acknowledgements':
        return renderAcknowledgements();
      case 'review':
        return renderReview();
      default:
        return <div>Unknown step</div>;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 -m-4 md:-m-6">
      {/* Sticky Header Container */}
      <div className="sticky top-0 z-50">
        {/* Header */}
        <div className={`${isManagingForMember ? 'bg-oe-primary text-white' : 'bg-white border-b border-gray-200'} shadow-sm`}>
          <div className="px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between min-h-16 py-2">
              <div className="flex items-center min-w-0">
              <button
                onClick={() => {
                  if (onClose) {
                    onClose();
                  } else if (memberId) {
                    // Navigate back to members page if managing on behalf
                    // Determine the correct route base
                    const roleBase = user?.currentRole === 'SysAdmin' ? 'admin'
                                    : user?.currentRole === 'TenantAdmin' ? 'tenant-admin'
                                    : user?.currentRole === 'Agent' ? 'agent'
                                    : user?.currentRole === 'GroupAdmin' ? 'group-admin'
                                    : 'member';
                    navigate(`/${roleBase}/members`, {
                      state: { reopenMemberId: memberId }
                    });
                  } else {
                    // Navigate to member's own plans page
                    navigate('/member/plans');
                  }
                }}
                className={`mr-2 md:mr-4 p-2 flex-shrink-0 ${isManagingForMember ? 'text-white hover:text-oe-light' : 'text-gray-400 hover:text-gray-600'}`}
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
                <div className="min-w-0">
                  <h1 className={`text-base md:text-xl font-semibold truncate ${isManagingForMember ? 'text-white' : 'text-gray-900'}`}>
                    {isManagingForMember ? `Modify ${memberName}'s Plan` : 'Modify Your Plan'}
                  </h1>
                  <p className={`text-xs md:text-sm truncate ${isManagingForMember ? 'text-oe-light' : 'text-gray-600'}`}>
                    Step {currentStep + 1} of {steps.length}: {steps[currentStep]?.title}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Progress Bar - Add padding to prevent overlap with sticky header */}
      <div className="bg-white border-b border-gray-200">
        <div className="px-4 sm:px-6 lg:px-8 pt-4 pb-4 md:pt-8 md:pb-6">
          <div className="flex items-center justify-between">
            {steps.map((step, index) => (
              <React.Fragment key={step.id}>
                <div className="flex items-center flex-shrink-0">
                  <div className={`flex items-center justify-center w-8 h-8 rounded-full text-sm ${
                    index < currentStep ? 'bg-oe-success text-white' :
                    index === currentStep ? 'bg-oe-primary text-white' :
                    'bg-gray-200 text-gray-600'
                  }`}>
                    {index < currentStep ? <Check className="h-4 w-4" /> : index + 1}
                  </div>
                  <span className={`hidden sm:inline ml-2 text-sm font-medium ${
                    index <= currentStep ? 'text-gray-900' : 'text-gray-500'
                  }`}>
                    {step.title}
                  </span>
                </div>
                {index < steps.length - 1 && (
                  <div className={`flex-1 h-1 mx-2 sm:mx-4 ${
                    index < currentStep ? 'bg-oe-success' : 'bg-gray-200'
                  }`} />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 py-4 md:py-8 pb-24">
        <div className="max-w-4xl mx-auto">
          {renderCurrentStep()}
        </div>
      </div>

      {/* Footer Navigation */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 py-4 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto flex justify-between">
          <button
            onClick={handleBack}
            disabled={currentStep === 0}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Back
          </button>
          <div className="flex flex-col items-end">
            <button
              onClick={handleNext}
              disabled={isNextDisabled() || submitting}
              className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              title={currentStep === steps.length - 1 && !hasAnyChanges() ? "You must make at least 1 change before submitting" : undefined}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Processing...
                </>
              ) : currentStep === steps.length - 1 ? (
                'Confirm Enrollment Changes'
              ) : (
                'Next'
              )}
            </button>
            {currentStep === steps.length - 1 && !hasAnyChanges() && (
              <p className="text-sm text-gray-500 mt-1">You must make at least 1 change before submitting</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProductChangeWizard;


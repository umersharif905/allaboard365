import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useMemo, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import IDCard from '../../components/IDCard';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import {
  MemberEnrollment,
  MemberEnrollmentService,
  fetchMemberEnrollmentsAllStatuses,
} from '../../services/member/member-enrollments.service';
import { Member, applyProductMemberIdPrefixMask, resolveHouseholdMemberId } from '../../types/member.types';

interface BundleComponentProduct {
  IncludedProductId: string;
  ProductName: string;
  Description?: string;
  ProductType?: string;
  ProductLogoUrl?: string;
  ProductImageUrl?: string;
  IDCardData?: any;
  IDCardMemberIdPrefixMask?: string | null;
}

const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';

const isIDCardDisabled = (idCardData: any): boolean => idCardData?.DisableIDCard === true;

const waitForAllImages = async () => {
  const images = Array.from(document.images);
  await Promise.all(
    images.map((img) => {
      if (img.complete) return Promise.resolve();
      return new Promise<void>((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
      });
    })
  );
};

export default function PrintIDCards() {
  const { user } = useAuth();
  const params = useParams<{ enrollmentId?: string }>();
  const [searchParams] = useSearchParams();
  const hasTriggeredPrint = useRef(false);

  const requestedMemberId = searchParams.get('memberId') || '';
  const requestedEnrollmentId = params.enrollmentId || searchParams.get('enrollmentId') || '';
  const requestedProductId = searchParams.get('productId') || '';

  const { data: resolvedMemberId, isLoading: isLoadingMemberId, error: memberIdError } = useQuery({
    queryKey: ['print-id-cards-resolved-member-id', requestedMemberId, user?.currentRole],
    queryFn: async () => {
      if (requestedMemberId) return requestedMemberId;

      if (user?.currentRole !== 'Member') {
        throw new Error('memberId is required for this print page.');
      }

      const profile = await apiService.get<{ success: boolean; data?: { id?: string }; message?: string }>(
        '/api/me/member/profile'
      );
      const resolvedFromProfile =
        (profile as any)?.data?.id ||
        (profile as any)?.data?.memberId ||
        (profile as any)?.data?.MemberId;

      if (!profile.success || !resolvedFromProfile) {
        throw new Error(profile.message || 'Unable to determine current member.');
      }
      return resolvedFromProfile;
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });

  const { data: enrollments = [], isLoading: isLoadingEnrollments, error: enrollmentsError } = useQuery({
    queryKey: ['print-id-cards-enrollments', resolvedMemberId, user?.currentRole],
    queryFn: async () => {
      const enrollmentRowAllowed = (e: MemberEnrollment) => {
        const enrollmentType =
          e.enrollmentType ?? (e as MemberEnrollment & { EnrollmentType?: string }).EnrollmentType;
        return (
          !enrollmentType ||
          enrollmentType === 'Product' ||
          enrollmentType === 'Contribution' ||
          enrollmentType === 'PaymentProcessingFee' ||
          enrollmentType === 'ProcessingFee' ||
          enrollmentType === 'SystemFee'
        );
      };

      // Members cannot call GET /api/enrollments; use member enrollments (includes idCardMemberIdPrefixMask + memberTenantMemberIdPrefix).
      if (user?.currentRole === 'Member') {
        const response = await apiService.get<{ success: boolean; data: MemberEnrollment[]; message?: string }>(
          '/api/me/member/enrollments'
        );
        if (!response.success) {
          throw new Error(response.message || 'Failed to load enrollments.');
        }
        return (response.data || []).filter(enrollmentRowAllowed) as MemberEnrollment[];
      }

      return fetchMemberEnrollmentsAllStatuses(resolvedMemberId);
    },
    enabled: !!resolvedMemberId,
    staleTime: 0,
  });

  const { data: householdData, isLoading: isLoadingHousehold, error: householdError } = useQuery({
    queryKey: ['print-id-cards-household', resolvedMemberId, user?.currentRole],
    queryFn: async () => {
      // Members cannot use GET /api/members/:id/with-household (staff-only); use self household API.
      if (user?.currentRole === 'Member') {
        const response = await apiService.get<{
          success: boolean;
          data?: { householdMembers: any[] };
          message?: string;
        }>('/api/me/member/household');
        if (!response.success || !response.data?.householdMembers) {
          throw new Error(response.message || 'Failed to load household.');
        }
        const { householdMembers } = response.data;
        const self =
          householdMembers.find((m: any) => m.MemberId === resolvedMemberId) ||
          householdMembers.find((m: any) => m.IsCurrentUser);
        return {
          member: self ?? null,
          householdMembers,
        };
      }

      const response = await apiService.get<{ success: boolean; data: { member: any; householdMembers: any[] }; message?: string }>(
        `/api/members/${resolvedMemberId}/with-household`
      );
      if (!response.success) {
        throw new Error(response.message || 'Failed to load household.');
      }
      return response.data;
    },
    enabled: !!resolvedMemberId,
    staleTime: 0,
  });

  const groupedEnrollments = useMemo(() => {
    const productEnrollments = enrollments.filter((e: any) => {
      if (e.productId === ALL_PRODUCTS_GUID && (e.enrollmentType === 'Contribution' || e.EnrollmentType === 'Contribution')) {
        return false;
      }
      if (
        e.enrollmentType === 'ProcessingFee' ||
        e.EnrollmentType === 'ProcessingFee' ||
        e.enrollmentType === 'SystemFee' ||
        e.EnrollmentType === 'SystemFee'
      ) {
        return false;
      }
      return true;
    });
    return MemberEnrollmentService.groupEnrollmentsByBundle(productEnrollments).filter(
      (e: any) => e.primaryEnrollment?.productId !== ALL_PRODUCTS_GUID
    );
  }, [enrollments]);

  const bundleProductIds = useMemo(() => {
    const ids = new Set<string>();
    groupedEnrollments.forEach((grouped: any) => {
      if (grouped.type === 'individual' && grouped.primaryEnrollment?.product) {
        const product = grouped.primaryEnrollment.product;
        if (!product.idCardData && grouped.primaryEnrollment.status === 'Active' && product.productType === 'Bundle') {
          ids.add(grouped.primaryEnrollment.productId);
        }
      }
    });
    return Array.from(ids);
  }, [groupedEnrollments]);

  const { data: bundleComponentsMap = {} } = useQuery({
    queryKey: ['print-id-cards-bundle-components', bundleProductIds],
    queryFn: async () => {
      const map: Record<string, BundleComponentProduct[]> = {};
      await Promise.all(
        bundleProductIds.map(async (bundleProductId) => {
          try {
            const response = await apiService.get<{ success: boolean; data: any[] }>(
              `/api/products/${bundleProductId}/bundle-products`
            );
            if (response.success && response.data) {
              const componentsWithIDCards = await Promise.all(
                response.data.map(async (component: any) => {
                  try {
                    const productResponse = await apiService.get<{ success: boolean; product: any }>(
                      `/api/products/${component.IncludedProductId}`
                    );
                    if (productResponse.success && productResponse.product) {
                      const p = productResponse.product;
                      let idCardData = p.IDCardData;
                      if (idCardData && typeof idCardData === 'string') {
                        idCardData = JSON.parse(idCardData);
                      }
                      return {
                        IncludedProductId: component.IncludedProductId,
                        ProductName: component.ProductName || p.Name,
                        Description: component.Description || p.Description,
                        ProductType: component.ProductType || p.ProductType,
                        ProductLogoUrl: p.ProductLogoUrl,
                        ProductImageUrl: p.ProductImageUrl,
                        IDCardData: idCardData,
                        IDCardMemberIdPrefixMask: p.IDCardMemberIdPrefixMask ?? p.idCardMemberIdPrefixMask ?? null,
                      };
                    }
                  } catch (error) {
                    console.error(`Error fetching bundle component ${component.IncludedProductId}:`, error);
                  }
                  return {
                    IncludedProductId: component.IncludedProductId,
                    ProductName: component.ProductName,
                    Description: component.Description,
                    ProductType: component.ProductType,
                    IDCardData: null,
                  };
                })
              );
              map[bundleProductId] = componentsWithIDCards;
            }
          } catch (error) {
            console.error(`Error fetching bundle product components for ${bundleProductId}:`, error);
          }
        })
      );
      return map;
    },
    enabled: bundleProductIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const activeEnrollmentsWithIDCards = useMemo(() => {
    const all: MemberEnrollment[] = [];

    groupedEnrollments.forEach((grouped: any) => {
      if (grouped.type === 'bundle' && grouped.componentEnrollments) {
        grouped.componentEnrollments.forEach((comp: any) => {
          if (comp.product?.idCardData && !isIDCardDisabled(comp.product.idCardData) && comp.status === 'Active') {
            all.push(comp);
          }
        });
      } else if (grouped.type === 'individual' && grouped.primaryEnrollment) {
        if (
          grouped.primaryEnrollment.product?.idCardData &&
          !isIDCardDisabled(grouped.primaryEnrollment.product.idCardData) &&
          grouped.primaryEnrollment.status === 'Active'
        ) {
          all.push(grouped.primaryEnrollment);
        } else if (!grouped.primaryEnrollment.product?.idCardData && grouped.primaryEnrollment.status === 'Active') {
          const components = bundleComponentsMap[grouped.primaryEnrollment.productId] || [];
          components.forEach((component) => {
            if (component.IDCardData && !isIDCardDisabled(component.IDCardData)) {
              all.push({
                ...grouped.primaryEnrollment,
                enrollmentId: `${grouped.primaryEnrollment.enrollmentId}-component-${component.IncludedProductId}`,
                productId: component.IncludedProductId,
                product: {
                  productId: component.IncludedProductId,
                  name: component.ProductName,
                  description: component.Description || '',
                  productType: component.ProductType || '',
                  productLogoUrl: component.ProductLogoUrl,
                  productImageUrl: component.ProductImageUrl,
                  idCardData: component.IDCardData,
                  idCardMemberIdPrefixMask: component.IDCardMemberIdPrefixMask ?? null,
                  requiredDataFields: [],
                  features: [],
                  hidePricing: false,
                  linkedToProductId: null,
                },
              } as MemberEnrollment);
            }
          });
        }
      }
    });

    return all;
  }, [groupedEnrollments, bundleComponentsMap]);

  const filteredEnrollments = useMemo(() => {
    if (requestedEnrollmentId) {
      return activeEnrollmentsWithIDCards.filter((e) => e.enrollmentId === requestedEnrollmentId);
    }
    if (requestedProductId) {
      return activeEnrollmentsWithIDCards.filter((e) => e.product?.productId === requestedProductId);
    }
    return activeEnrollmentsWithIDCards;
  }, [activeEnrollmentsWithIDCards, requestedEnrollmentId, requestedProductId]);

  const getMemberInfo = (enrollment: MemberEnrollment) => {
    const raw =
      householdData?.householdMembers?.find((m) => m.MemberId === resolvedMemberId) ||
      householdData?.householdMembers?.find((m) => m.IsCurrentUser) ||
      householdData?.member;
    const primaryMember: Member | undefined = raw
      ? ({
          ...householdData?.member,
          ...raw,
          TenantMemberIDPrefix: raw.TenantMemberIDPrefix ?? householdData?.member?.TenantMemberIDPrefix,
          TenantIndividualMemberIDPrefix:
            raw.TenantIndividualMemberIDPrefix ?? householdData?.member?.TenantIndividualMemberIDPrefix,
          HouseholdMemberID: raw.HouseholdMemberID ?? householdData?.member?.HouseholdMemberID,
          GroupId: raw.GroupId ?? householdData?.member?.GroupId
        } as Member)
      : undefined;

    const rawId = primaryMember ? resolveHouseholdMemberId(primaryMember) : undefined;
    const tenantPrefix =
      primaryMember?.TenantMemberIDPrefix ??
      householdData?.member?.TenantMemberIDPrefix ??
      enrollment.memberTenantMemberIdPrefix;
    const tenantIndividualPrefix =
      primaryMember?.TenantIndividualMemberIDPrefix ?? householdData?.member?.TenantIndividualMemberIDPrefix;
    const masked =
      rawId != null
        ? applyProductMemberIdPrefixMask(
            rawId,
            tenantPrefix,
            enrollment.product?.idCardMemberIdPrefixMask,
            tenantIndividualPrefix
          )
        : undefined;

    return {
      firstName: enrollment.memberName?.split(' ')[0] || primaryMember?.FirstName || '',
      lastName: enrollment.memberName?.split(' ').slice(1).join(' ') || primaryMember?.LastName || '',
      memberId:
        primaryMember ? (masked ?? rawId ?? 'Not Assigned') : 'Not Assigned',
      dateOfBirth: primaryMember?.DateOfBirth || '',
      planName: enrollment.product?.name || 'Unknown Product',
      effectiveDate: enrollment.effectiveDate,
      spouse: (() => {
        if (!householdData?.householdMembers) return undefined;
        const spouse = householdData.householdMembers.find(
          (m) => m.MemberId !== resolvedMemberId && m.RelationshipType === 'S' && m.Status !== 'Terminated'
        );
        if (!spouse) return undefined;
        return {
          name: `${spouse.FirstName} ${spouse.LastName}`,
          dob: spouse.DateOfBirth || '',
          gender: (spouse.Gender || '').toString(),
        };
      })(),
      dependents: (() => {
        if (!householdData?.householdMembers) return undefined;
        const dependents = householdData.householdMembers
          .filter((m) => m.MemberId !== resolvedMemberId && m.RelationshipType === 'C' && m.Status !== 'Terminated')
          .map((m) => ({
            name: `${m.FirstName} ${m.LastName}`,
            dob: m.DateOfBirth || '',
            gender: (m.Gender || '').toString(),
          }));
        return dependents.length > 0 ? dependents : undefined;
      })(),
    };
  };

  const isLoading = isLoadingMemberId || isLoadingEnrollments || isLoadingHousehold;
  const error = memberIdError || enrollmentsError || householdError;

  useEffect(() => {
    if (isLoading || error || filteredEnrollments.length === 0 || hasTriggeredPrint.current) return;

    hasTriggeredPrint.current = true;
    const runPrint = async () => {
      await waitForAllImages();
      setTimeout(() => window.print(), 350);
    };
    runPrint();
  }, [isLoading, error, filteredEnrollments.length]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <p className="text-gray-600">Preparing ID cards for print...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-white p-6">
        <div className="max-w-3xl mx-auto bg-red-50 border border-red-200 rounded-lg p-4 text-red-800">
          {(error as Error).message || 'Failed to load ID cards for printing.'}
        </div>
      </div>
    );
  }

  if (filteredEnrollments.length === 0) {
    return (
      <div className="min-h-screen bg-white p-6">
        <div className="max-w-3xl mx-auto bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-800">
          No printable ID cards were found for this request.
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white p-6 print:p-2">
      <style>{`
        @media print {
          @page { margin: 0.5in; size: auto; }
          .print-break { page-break-inside: avoid; break-inside: avoid; }
        }
      `}</style>

      <div className="max-w-5xl mx-auto">
        <div className="space-y-8">
          {filteredEnrollments.map((enrollment) => (
            <div key={enrollment.enrollmentId} className="print-break">
              <IDCard
                idCardData={enrollment.product?.idCardData}
                memberInfo={getMemberInfo(enrollment)}
                productName={enrollment.product?.name || 'Unknown Product'}
                groupId={(enrollment.product as any)?.groupId || null}
                showGroupId={(enrollment.product as any)?.showGroupIdOnIDCard || false}
                fallbackLogoUrl={enrollment.product?.productLogoUrl || enrollment.product?.productImageUrl || ''}
                idCardConfigurationDisplay={enrollment.idCardConfigurationDisplay ?? null}
                isPreview
                showPreviewLabels={false}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


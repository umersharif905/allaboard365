import { Download, Printer } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import IDCard from '../../components/IDCard';
import { useGroupedMemberEnrollments } from '../../hooks/member/useMemberEnrollments';
import { useMemberHousehold } from '../../hooks/member/useMemberHousehold';
import { useMemberProfile } from '../../hooks/member/useMemberProfile';
import { MemberEnrollment } from '../../services/member/member-enrollments.service';
import { Member, applyProductMemberIdPrefixMask, resolveHouseholdMemberId } from '../../types/member.types';
import { openIDCardPrintView } from '../../utils/idCardPrint';

const isIDCardDisabled = (idCardData: any): boolean => {
  return idCardData?.DisableIDCard === true;
};

export default function IDCards() {
  const [selectedProductFilter, setSelectedProductFilter] = useState<string>('all');

  // Get grouped enrollments
  const {
    data: groupedEnrollmentsRaw,
    isLoading: isLoadingEnrollments,
    isError: hasEnrollmentsError,
    error: enrollmentsError
  } = useGroupedMemberEnrollments();

  const { data: householdData } = useMemberHousehold();
  const { profile: memberProfile } = useMemberProfile();

  // Filter out the "All Products" sentinel row AND any non-Product enrollment types
  // (Contribution / ProcessingFee / PaymentProcessingFee / SystemFee rows mirror real Product
  // enrollments — including them causes the same product to render twice on this tab).
  const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';
  const isRenderableEnrollmentType = (t: any) => !t || t === 'Product';
  const groupedEnrollments = (groupedEnrollmentsRaw || []).filter((e: any) => {
    if (e.primaryEnrollment?.productId === ALL_PRODUCTS_GUID) return false;
    if (e.type === 'individual') {
      return isRenderableEnrollmentType(e.primaryEnrollment?.enrollmentType);
    }
    return true;
  });

  // Get all active enrollments that have ID cards
  const activeEnrollmentsWithIDCards = useMemo(() => {
    const allEnrollments: MemberEnrollment[] = [];
    
    groupedEnrollments.forEach((grouped: any) => {
      if (grouped.type === 'bundle' && grouped.componentEnrollments) {
        // Add all component enrollments from bundles
        grouped.componentEnrollments.forEach((comp: any) => {
          if (!isRenderableEnrollmentType(comp.enrollmentType)) return;
          if (comp.product.idCardData && !isIDCardDisabled(comp.product.idCardData) && grouped.status === 'Active') {
            allEnrollments.push(comp);
          }
        });
      } else if (grouped.type === 'individual' && grouped.primaryEnrollment) {
        // Add individual product enrollments
        if (grouped.primaryEnrollment.product.idCardData && !isIDCardDisabled(grouped.primaryEnrollment.product.idCardData) && grouped.status === 'Active') {
          allEnrollments.push(grouped.primaryEnrollment);
        }
      }
    });

    return allEnrollments;
  }, [groupedEnrollments]);

  // Filter by selected product and sort: Healthcare products first, then alphabetical by name.
  const filteredEnrollments = useMemo(() => {
    let filtered = selectedProductFilter === 'all'
      ? activeEnrollmentsWithIDCards
      : activeEnrollmentsWithIDCards.filter(
          (enrollment) => enrollment.product.productId === selectedProductFilter
        );
    
    const healthcareRank = (e: MemberEnrollment) =>
      String(e.product?.productType || '').toLowerCase() === 'healthcare' ? 0 : 1;
    return [...filtered].sort((a, b) => {
      const rankDiff = healthcareRank(a) - healthcareRank(b);
      if (rankDiff !== 0) return rankDiff;
      const nameA = (a.product.name || '').toLowerCase();
      const nameB = (b.product.name || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [activeEnrollmentsWithIDCards, selectedProductFilter]);

  // Get unique products for filter dropdown
  const availableProducts = useMemo(() => {
    const products = new Map();
    activeEnrollmentsWithIDCards.forEach((enrollment) => {
      if (!products.has(enrollment.product.productId)) {
        products.set(enrollment.product.productId, {
          productId: enrollment.product.productId,
          name: enrollment.product.name
        });
      }
    });
    return Array.from(products.values());
  }, [activeEnrollmentsWithIDCards]);

  // Helper function to get member info for an enrollment
  const getMemberInfo = (enrollment: MemberEnrollment) => {
    const currentMember = householdData?.householdMembers?.find(member => member.IsCurrentUser);
    const merged: Partial<Member> | undefined = currentMember
      ? ({
          ...currentMember,
          GroupId: currentMember.GroupId ?? undefined,
          TenantMemberIDPrefix: currentMember.TenantMemberIDPrefix ?? memberProfile?.tenantMemberIDPrefix,
          TenantIndividualMemberIDPrefix:
            currentMember.TenantIndividualMemberIDPrefix ?? memberProfile?.tenantIndividualMemberIDPrefix
        } as Partial<Member>)
      : undefined;

    const rawId = merged ? resolveHouseholdMemberId(merged) : undefined;
    const tenantPrefix =
      (merged as Partial<Member>)?.TenantMemberIDPrefix ??
      memberProfile?.tenantMemberIDPrefix ??
      enrollment.memberTenantMemberIdPrefix;
    const tenantIndividualPrefix =
      (merged as Partial<Member>)?.TenantIndividualMemberIDPrefix ??
      memberProfile?.tenantIndividualMemberIDPrefix;
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
      firstName: enrollment.memberName.split(' ')[0] || '',
      lastName: enrollment.memberName.split(' ').slice(1).join(' ') || '',
      memberId: merged ? (masked ?? rawId ?? 'Not Assigned') : 'Not Assigned',
      dateOfBirth: (() => {
        const dob = currentMember?.DateOfBirth || memberProfile?.dateOfBirth || '1990-01-01';
        return dob instanceof Date ? dob.toISOString().split('T')[0] : String(dob);
      })(),
      planName: enrollment.product?.name ?? 'Unknown Product',
      effectiveDate: enrollment.effectiveDate,
      spouse: (() => {
        // Get spouse from household data
        if (!householdData?.householdMembers) return undefined;
        const spouse = householdData.householdMembers.find(member => 
          !member.IsCurrentUser && 
          member.RelationshipType === 'S' &&
          member.Status !== 'Terminated'
        );
        if (!spouse) return undefined;
        // Handle Gender property
        const genderValue = (spouse.Gender || '').toString();
        return {
          name: `${spouse.FirstName} ${spouse.LastName}`,
          dob: spouse.DateOfBirth || '',
          gender: genderValue
        };
      })(),
      dependents: (() => {
        // Get children (dependents) from household data
        if (!householdData?.householdMembers) return undefined;
        const dependents = householdData.householdMembers
          .filter(member => 
            !member.IsCurrentUser && 
            member.RelationshipType === 'C' &&
            member.Status !== 'Terminated'
          )
          .map(member => {
            // Handle Gender property
            const genderValue = (member.Gender || '').toString();
            return {
              name: `${member.FirstName} ${member.LastName}`,
              dob: member.DateOfBirth || '',
              gender: genderValue
            };
          });
        return dependents.length > 0 ? dependents : undefined;
      })()
    };
  };

  const handlePrintAll = () => {
    if (filteredEnrollments.length === 0) {
      alert('No ID cards to print');
      return;
    }
    const memberIdForPrint = filteredEnrollments[0]?.memberId;
    openIDCardPrintView({ memberId: memberIdForPrint });
  };

  if (isLoadingEnrollments) {
    return (
      <div className="space-y-6">
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto"></div>
          <p className="mt-2 text-gray-600">Loading your ID cards...</p>
        </div>
      </div>
    );
  }

  if (hasEnrollmentsError) {
    return (
      <div className="space-y-6">
        <div className="text-center py-12">
          <p className="text-red-600">Failed to load your ID cards</p>
          {enrollmentsError && <p className="text-sm text-gray-500 mt-1">{enrollmentsError.message}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filter + Print All */}
      {(availableProducts.length > 1 || filteredEnrollments.length > 0) && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4 flex-wrap min-w-0">
              {availableProducts.length > 1 && (
                <>
                  <label htmlFor="product-filter" className="text-sm font-medium text-gray-700 shrink-0">
                    Filter by Product:
                  </label>
                  <select
                    id="product-filter"
                    value={selectedProductFilter}
                    onChange={(e) => setSelectedProductFilter(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary min-w-[12rem]"
                  >
                    <option value="all">All Products</option>
                    {availableProducts.map((product) => (
                      <option key={product.productId} value={product.productId}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
            {filteredEnrollments.length > 0 && (
              <button
                type="button"
                onClick={handlePrintAll}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 shrink-0"
              >
                <Printer className="h-4 w-4 mr-2" />
                Print All
              </button>
            )}
          </div>
        </div>
      )}

      {/* ID Cards Grid */}
      {filteredEnrollments.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-4 md:gap-6">
          {filteredEnrollments.map((enrollment) => (
            <div
              key={enrollment.enrollmentId}
              className="bg-white rounded-lg border border-gray-200 p-3 md:p-4 flex flex-col"
            >
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-medium text-gray-900 text-center text-sm md:text-base flex-1">{enrollment.product?.name}</h3>
                <div className="flex gap-2 ml-2">
                  <button
                    onClick={() =>
                      openIDCardPrintView({
                        memberId: enrollment.memberId,
                        enrollmentId: enrollment.enrollmentId,
                        productId: enrollment.product?.productId,
                      })
                    }
                    className="inline-flex items-center px-2 py-1 border border-blue-300 rounded text-xs font-medium text-oe-primary-dark bg-white hover:bg-blue-50"
                    title="Print / Download ID card"
                  >
                    <Download className="h-3 w-3 mr-1" />
                    Print / Download
                  </button>
                </div>
              </div>
              <div className="flex-1 flex items-center justify-center">
                <div className="w-full max-w-full overflow-x-auto" data-id-card-enrollment={enrollment.enrollmentId}>
                  <IDCard
                    idCardData={enrollment.product?.idCardData || {
                      Card_Front: {
                        Header: { Image: '' },
                        Footer: { Header: 'Contact Information', Text1: 'For Eligibility, Benefits & Customer Service', Text2: '(904) 373-6872' }
                      },
                      Card_Back: {
                        Top_Left: { Image: '', Header: 'ER Visits', Text1: 'Request an Itemized Bill\n(Submit Sharing Request)', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
                        Top_Right: { Image: '', Header: 'Planned Healthcare', Text1: 'Contact Member Success\nfor Payment Services', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
                        Middle: { Image: '', Header: 'Contact ShareWELL Partners', Text1: 'Member Success Phone (904) 373-6872\nHow to Submit a Share Request', Link_Name1: 'How to Submit a Share Request', URL1: 'https://sharewellpartners.com/sharingrequest/', Link_Name2: '', URL2: '' },
                        Bottom_Left: { Image: '', Header: 'Member Success Email', Text1: '', Link_Name1: 'membersuccess@sharewellpartners.com', URL1: 'mailto:membersuccess@sharewellpartners.com', Link_Name2: '', URL2: '' },
                        Bottom_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', URL2: '' }
                      }
                    }}
                    memberInfo={getMemberInfo(enrollment)}
                    productName={enrollment.product.name}
                    groupId={(enrollment.product as any)?.groupId || null}
                    showGroupId={(enrollment.product as any)?.showGroupIdOnIDCard || false}
                    fallbackLogoUrl={enrollment.product?.productLogoUrl || enrollment.product?.productImageUrl || ''}
                    idCardConfigurationDisplay={enrollment.idCardConfigurationDisplay ?? null}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-gray-600">No ID cards available</p>
          {selectedProductFilter !== 'all' && (
            <button
              onClick={() => setSelectedProductFilter('all')}
              className="mt-4 text-oe-primary hover:text-oe-dark text-sm font-medium transition-colors"
            >
              Show all products
            </button>
          )}
        </div>
      )}
    </div>
  );
}


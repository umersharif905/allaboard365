// File: frontend/src/pages/members/tabs/MemberIDCardsTab.tsx
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import IDCard from '../../../components/IDCard';
import { apiService } from '../../../services/api.service';
import { GroupedEnrollment, MemberEnrollment, MemberEnrollmentService, fetchMemberEnrollmentsAllStatuses, isVendorVisiblePlanEnrollment, normalizeEnrollmentStatus } from '../../../services/member/member-enrollments.service';
import { Member, applyProductMemberIdPrefixMask, resolveHouseholdMemberId } from '../../../types/member.types';
import { openIDCardPrintView } from '../../../utils/idCardPrint';

interface Props {
  member: Member;
  onRefresh?: () => void;
  extraCardActions?: (enrollment: MemberEnrollment) => React.ReactNode;
  // When embedded in a parent that already renders its own "ID Cards" section
  // header (e.g., vendor CombinedPlansTab), suppress this component's heading
  // to avoid the duplicate.
  hideHeading?: boolean;
}

interface BundleComponentProduct {
  IncludedProductId: string;
  ProductName: string;
  Description?: string;
  ProductType?: string;
  IDCardData?: any;
}

const isIDCardDisabled = (idCardData: any): boolean => {
  return idCardData?.DisableIDCard === true;
};

type IdCardEnrollmentFilter = 'active' | 'pending' | 'all';

function isPendingMigrationEnrollment(
  enrollment: Pick<MemberEnrollment, 'status' | 'isPendingMigration'>
): boolean {
  if (enrollment.isPendingMigration === true) return true;
  const status = normalizeEnrollmentStatus(enrollment.status);
  return status === 'Pending' || status === 'PaymentHold';
}

function enrollmentMatchesIdCardStatusFilter(
  enrollment: MemberEnrollment,
  filter: IdCardEnrollmentFilter
): boolean {
  const status = normalizeEnrollmentStatus(enrollment.status);
  const pending = isPendingMigrationEnrollment(enrollment);
  if (filter === 'active') return status === 'Active' && !pending;
  if (filter === 'pending') return pending;
  return status === 'Active' || pending;
}

function collectEnrollmentsWithIDCards(
  groupedEnrollments: GroupedEnrollment[],
  bundleComponentsMap: Record<string, BundleComponentProduct[]> | undefined,
  filter: IdCardEnrollmentFilter
): MemberEnrollment[] {
  const allEnrollments: MemberEnrollment[] = [];

  groupedEnrollments.forEach((grouped: any) => {
    if (grouped.type === 'bundle' && grouped.componentEnrollments) {
      grouped.componentEnrollments.forEach((comp: any) => {
        if (
          comp.product?.idCardData
          && !isIDCardDisabled(comp.product?.idCardData)
          && enrollmentMatchesIdCardStatusFilter(comp, filter)
        ) {
          allEnrollments.push(comp);
        }
      });
    } else if (grouped.type === 'individual' && grouped.primaryEnrollment) {
      if (
        grouped.primaryEnrollment.product?.idCardData
        && !isIDCardDisabled(grouped.primaryEnrollment.product?.idCardData)
        && enrollmentMatchesIdCardStatusFilter(grouped.primaryEnrollment, filter)
      ) {
        allEnrollments.push(grouped.primaryEnrollment);
      } else if (
        !grouped.primaryEnrollment.product?.idCardData
        && enrollmentMatchesIdCardStatusFilter(grouped.primaryEnrollment, filter)
      ) {
        const bundleProductId = grouped.primaryEnrollment.productId;
        const components = bundleComponentsMap?.[bundleProductId] || [];

        components.forEach((component) => {
          if (component.IDCardData && !isIDCardDisabled(component.IDCardData)) {
            allEnrollments.push({
              ...grouped.primaryEnrollment,
              enrollmentId: `${grouped.primaryEnrollment.enrollmentId}-component-${component.IncludedProductId}`,
              productId: component.IncludedProductId,
              product: {
                productId: component.IncludedProductId,
                name: component.ProductName,
                description: component.Description || '',
                productType: component.ProductType || '',
                idCardData: component.IDCardData,
                requiredDataFields: [],
                features: [],
                hidePricing: false,
                linkedToProductId: null
              }
            });
          }
        });
      }
    }
  });

  return allEnrollments;
}

export default function MemberIDCardsTab({ member, extraCardActions, hideHeading = false }: Props) {
  const memberIsPendingMigration = member.IsPendingMigration === true || member.IsPendingMigration === 1;
  const [selectedProductFilter, setSelectedProductFilter] = useState<string>('all');
  const [enrollmentStatusFilter, setEnrollmentStatusFilter] = useState<IdCardEnrollmentFilter>(() =>
    memberIsPendingMigration ? 'all' : 'active'
  );

  // Fetch member enrollments
  const { data: enrollments, isLoading: isLoadingEnrollments, isError: hasEnrollmentsError, error: enrollmentsError } = useQuery({
    queryKey: ['memberEnrollments', member.MemberId],
    queryFn: () => fetchMemberEnrollmentsAllStatuses(member.MemberId),
    staleTime: 0,
    refetchOnMount: true,
  });

  const productEnrollments = useMemo(() => {
    if (!enrollments) return [];
    return enrollments.filter((enrollment) => {
      const enrollmentType = enrollment.enrollmentType;
      if (enrollmentType && enrollmentType !== 'Product') return false;
      return isVendorVisiblePlanEnrollment(enrollment);
    });
  }, [enrollments]);

  // Fetch member household data
  const { data: householdData } = useQuery({
    queryKey: ['memberHousehold', member.MemberId],
    queryFn: async () => {
      const response = await apiService.get<{ success: boolean; data: { member: Member; householdMembers: Member[] }; message?: string }>(`/api/members/${member.MemberId}/with-household`);
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch household data');
      }
      return response.data;
    },
    staleTime: 5 * 60 * 1000,
  });

  // Defensive: exclude the "All Products" sentinel row in case it ever slips through.
  const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';
  const groupedEnrollmentsRaw = useMemo(() => {
    if (!productEnrollments.length) return [];
    const filtered = productEnrollments.filter((e) => e.productId !== ALL_PRODUCTS_GUID);
    return MemberEnrollmentService.groupEnrollmentsByBundle(filtered);
  }, [productEnrollments]);

  const groupedEnrollments = groupedEnrollmentsRaw?.filter((e: GroupedEnrollment) => 
    e.primaryEnrollment?.productId !== ALL_PRODUCTS_GUID
  ) || [];

  // Fetch bundle component products for bundle product enrollments
  // This is needed when someone enrolls directly in a bundle product (not as individual components)
  const bundleProductIds = useMemo(() => {
    const ids = new Set<string>();
    groupedEnrollments.forEach((grouped: any) => {
      if (grouped.type === 'individual' && grouped.primaryEnrollment?.product) {
        // Check if this is a bundle product enrollment (product is a bundle but enrollment is individual)
        // We'll fetch component products for individual enrollments that:
        // 1. Don't have idCardData on the product itself
        // 2. Have productType === 'Bundle' (indicating it's a bundle product)
        const product = grouped.primaryEnrollment.product;
        if (!product.idCardData &&
            enrollmentMatchesIdCardStatusFilter(grouped.primaryEnrollment, 'all') &&
            product.productType === 'Bundle') {
          ids.add(grouped.primaryEnrollment.productId);
        }
      }
    });
    return Array.from(ids);
  }, [groupedEnrollments]);

  // Fetch bundle component products for bundle product enrollments
  const { data: bundleComponentsMap } = useQuery({
    queryKey: ['bundleComponents', bundleProductIds],
    queryFn: async () => {
      const map: Record<string, BundleComponentProduct[]> = {};
      await Promise.all(
        bundleProductIds.map(async (bundleProductId) => {
          try {
            const response = await apiService.get<{ success: boolean; data: any[] }>(
              `/api/products/${bundleProductId}/bundle-products`
            );
            if (response.success && response.data) {
              // Fetch full product details including IDCardData for each component
              const componentsWithIDCards = await Promise.all(
                response.data.map(async (component: any) => {
                  try {
                    const productResponse = await apiService.get<{ success: boolean; product: any }>(
                      `/api/products/${component.IncludedProductId}`
                    );
                    if (productResponse.success && productResponse.product) {
                      const product = productResponse.product;
                      // Parse IDCardData if it's a string
                      let idCardData = product.IDCardData;
                      if (idCardData && typeof idCardData === 'string') {
                        try {
                          idCardData = JSON.parse(idCardData);
                        } catch (e) {
                          console.error(`Error parsing IDCardData for ${component.IncludedProductId}:`, e);
                          idCardData = null;
                        }
                      }
                      return {
                        IncludedProductId: component.IncludedProductId,
                        ProductName: component.ProductName || product.Name,
                        Description: component.Description || product.Description,
                        ProductType: component.ProductType || product.ProductType,
                        IDCardData: idCardData
                      };
                    }
                  } catch (error) {
                    console.error(`Error fetching product details for ${component.IncludedProductId}:`, error);
                  }
                  return {
                    IncludedProductId: component.IncludedProductId,
                    ProductName: component.ProductName,
                    Description: component.Description,
                    ProductType: component.ProductType,
                    IDCardData: null
                  };
                })
              );
              map[bundleProductId] = componentsWithIDCards;
            }
          } catch (error) {
            console.error(`Error fetching bundle products for ${bundleProductId}:`, error);
          }
        })
      );
      return map;
    },
    enabled: bundleProductIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const allEnrollmentsWithIDCards = useMemo(
    () => collectEnrollmentsWithIDCards(groupedEnrollments, bundleComponentsMap, 'all'),
    [groupedEnrollments, bundleComponentsMap]
  );

  const enrollmentsWithIDCards = useMemo(
    () => allEnrollmentsWithIDCards.filter((enrollment) =>
      enrollmentMatchesIdCardStatusFilter(enrollment, enrollmentStatusFilter)
    ),
    [allEnrollmentsWithIDCards, enrollmentStatusFilter]
  );

  const idCardCountsByFilter = useMemo(() => ({
    active: allEnrollmentsWithIDCards.filter((e) => enrollmentMatchesIdCardStatusFilter(e, 'active')).length,
    pending: allEnrollmentsWithIDCards.filter((e) => enrollmentMatchesIdCardStatusFilter(e, 'pending')).length,
    all: allEnrollmentsWithIDCards.length,
  }), [allEnrollmentsWithIDCards]);

  const hiddenPendingIdCardCount = useMemo(() => {
    if (enrollmentStatusFilter !== 'active') return 0;
    return Math.max(0, idCardCountsByFilter.all - idCardCountsByFilter.active);
  }, [enrollmentStatusFilter, idCardCountsByFilter]);

  // Filter by selected product, then sort: Healthcare products first, then alphabetical by name.
  const filteredEnrollments = useMemo(() => {
    const filtered =
      selectedProductFilter === 'all'
        ? enrollmentsWithIDCards
        : enrollmentsWithIDCards.filter(
            (enrollment) => enrollment.product?.productId === selectedProductFilter
          );
    const healthcareRank = (e: MemberEnrollment) =>
      String(e.product?.productType || '').toLowerCase() === 'healthcare' ? 0 : 1;
    return [...filtered].sort((a, b) => {
      const rankDiff = healthcareRank(a) - healthcareRank(b);
      if (rankDiff !== 0) return rankDiff;
      const nameA = (a.product?.name || '').toLowerCase();
      const nameB = (b.product?.name || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [enrollmentsWithIDCards, selectedProductFilter]);

  // Get unique products for filter dropdown
  const availableProducts = useMemo(() => {
    const products = new Map();
    enrollmentsWithIDCards.forEach((enrollment) => {
      const productId = enrollment.product?.productId;
      if (productId && !products.has(productId)) {
        products.set(productId, {
          productId: productId,
          name: enrollment.product?.name || 'Unknown Product'
        });
      }
    });
    return Array.from(products.values());
  }, [enrollmentsWithIDCards]);

  const showStatusFilter = memberIsPendingMigration || idCardCountsByFilter.pending > 0 || idCardCountsByFilter.active > 0;

  // Helper function to get member info for an enrollment
  const getMemberInfo = (enrollment: MemberEnrollment) => {
    const currentMember = householdData?.householdMembers?.find(m => m.MemberId === member.MemberId);
    const merged = {
      ...member,
      ...currentMember,
      HouseholdMemberID: currentMember?.HouseholdMemberID ?? member.HouseholdMemberID,
      GroupId: currentMember?.GroupId ?? member.GroupId,
      TenantIndividualMemberIDPrefix:
        currentMember?.TenantIndividualMemberIDPrefix ?? member.TenantIndividualMemberIDPrefix
    } as Member;

    const rawId = resolveHouseholdMemberId(merged);
    const tenantPrefix =
      merged.TenantMemberIDPrefix ??
      (enrollment as { memberTenantMemberIdPrefix?: string }).memberTenantMemberIdPrefix;
    const masked =
      rawId != null
        ? applyProductMemberIdPrefixMask(
            rawId,
            tenantPrefix,
            enrollment.product?.idCardMemberIdPrefixMask,
            merged.TenantIndividualMemberIDPrefix
          )
        : undefined;

    return {
      firstName: enrollment.memberName?.split(' ')[0] || member.FirstName || '',
      lastName: enrollment.memberName?.split(' ').slice(1).join(' ') || member.LastName || '',
      memberId: masked ?? rawId ?? 'Not Assigned',
      dateOfBirth: (() => {
        const dob = currentMember?.DateOfBirth || member.DateOfBirth || '1990-01-01';
        // DateOfBirth is always a string from the API, but handle edge cases
        if (typeof dob === 'string') {
          return dob;
        }
        // Fallback for any unexpected types
        return String(dob);
      })(),
      planName: enrollment.product?.name || 'Unknown Product',
      effectiveDate: enrollment.effectiveDate,
      spouse: (() => {
        if (!householdData?.householdMembers) return undefined;
        const spouse = householdData.householdMembers.find(m => 
          m.MemberId !== member.MemberId && 
          m.RelationshipType === 'S' &&
          m.Status !== 'Terminated'
        );
        if (!spouse) return undefined;
        const genderValue = (spouse.Gender || '').toString();
        return {
          name: `${spouse.FirstName} ${spouse.LastName}`,
          dob: spouse.DateOfBirth || '',
          gender: genderValue
        };
      })(),
      dependents: (() => {
        if (!householdData?.householdMembers) return undefined;
        const dependents = householdData.householdMembers
          .filter(m => 
            m.MemberId !== member.MemberId && 
            m.RelationshipType === 'C' &&
            m.Status !== 'Terminated'
          )
          .map(m => {
            const genderValue = (m.Gender || '').toString();
            return {
              name: `${m.FirstName} ${m.LastName}`,
              dob: m.DateOfBirth || '',
              gender: genderValue
            };
          });
        return dependents.length > 0 ? dependents : undefined;
      })()
    };
  };

  if (isLoadingEnrollments) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto"></div>
          <p className="mt-2 text-gray-600">Loading ID cards...</p>
        </div>
      </div>
    );
  }

  if (hasEnrollmentsError) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <p className="text-red-600">Failed to load ID cards</p>
          {enrollmentsError && <p className="text-sm text-gray-500 mt-1">{enrollmentsError.message}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {!hideHeading && (
        <div className="flex items-center">
          <h3 className="text-lg font-semibold text-gray-900">ID Cards</h3>
        </div>
      )}

      {hiddenPendingIdCardCount > 0 && (
        <div className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900 flex flex-wrap items-center justify-between gap-2">
          <span>
            {hiddenPendingIdCardCount} pending migration ID card{hiddenPendingIdCardCount === 1 ? '' : 's'} not shown.
          </span>
          <button
            type="button"
            onClick={() => setEnrollmentStatusFilter('all')}
            className="font-medium text-violet-800 hover:text-violet-950 underline"
          >
            Show pending migration cards
          </button>
        </div>
      )}

      {/* Status + product filters + Print All */}
      {(showStatusFilter || filteredEnrollments.length > 0) && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center gap-4 justify-between flex-wrap">
            <div className="flex items-center gap-4 flex-wrap">
              {showStatusFilter ? (
                <div className="flex items-center gap-2">
                  <label htmlFor="id-card-status-filter" className="text-sm font-medium text-gray-700">
                    Plan status:
                  </label>
                  <select
                    id="id-card-status-filter"
                    value={enrollmentStatusFilter}
                    onChange={(e) => {
                      setEnrollmentStatusFilter(e.target.value as IdCardEnrollmentFilter);
                      setSelectedProductFilter('all');
                    }}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="active">
                      Active{idCardCountsByFilter.active > 0 ? ` (${idCardCountsByFilter.active})` : ''}
                    </option>
                    <option value="pending">
                      Pending migration{idCardCountsByFilter.pending > 0 ? ` (${idCardCountsByFilter.pending})` : ''}
                    </option>
                    <option value="all">
                      All plans{idCardCountsByFilter.all > 0 ? ` (${idCardCountsByFilter.all})` : ''}
                    </option>
                  </select>
                </div>
              ) : null}
              {availableProducts.length > 1 ? (
                <div className="flex items-center gap-2">
                  <label htmlFor="product-filter" className="text-sm font-medium text-gray-700">
                    Product:
                  </label>
                  <select
                    id="product-filter"
                    value={selectedProductFilter}
                    onChange={(e) => setSelectedProductFilter(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="all">All Products</option>
                    {availableProducts.map((product: any) => (
                      <option key={product.productId} value={product.productId}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
            {filteredEnrollments.length > 0 ? (
              <button
                onClick={() => openIDCardPrintView({ memberId: member.MemberId })}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                <Download className="h-4 w-4 mr-2" />
                Print All
              </button>
            ) : (
              <div />
            )}
          </div>
        </div>
      )}

      {/* ID Cards Grid */}
      {filteredEnrollments.length > 0 ? (
        <div className="grid gap-6 grid-cols-[repeat(auto-fill,minmax(340px,1fr))]">
          {filteredEnrollments.map((enrollment) => (
            <div
              key={enrollment.enrollmentId}
              className="bg-white rounded-lg border border-gray-200 p-4"
            >
              <div className="mb-3 space-y-2">
                <div className="flex flex-col items-center gap-1">
                  <h3 className="font-medium text-gray-900 text-center truncate w-full" title={enrollment.product?.name || 'Unknown Product'}>
                    {enrollment.product?.name || 'Unknown Product'}
                  </h3>
                  {isPendingMigrationEnrollment(enrollment) ? (
                    <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-violet-100 text-violet-800">
                      Pending migration
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    onClick={() =>
                      openIDCardPrintView({
                        memberId: member.MemberId,
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
                  {extraCardActions?.(enrollment)}
                </div>
              </div>
              <div data-id-card-enrollment={enrollment.enrollmentId} className="overflow-x-auto">
                <IDCard
                  idCardData={enrollment.product?.idCardData}
                  memberInfo={getMemberInfo(enrollment)}
                  productName={enrollment.product?.name || 'Unknown Product'}
                  groupId={(enrollment.product as any)?.groupId || null}
                  showGroupId={(enrollment.product as any)?.showGroupIdOnIDCard || false}
                  fallbackLogoUrl={enrollment.product?.productLogoUrl || enrollment.product?.productImageUrl || ''}
                  idCardConfigurationDisplay={enrollment.idCardConfigurationDisplay ?? null}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-gray-600">
            {enrollmentStatusFilter === 'pending'
              ? 'No pending migration ID cards available'
              : enrollmentStatusFilter === 'active'
                ? 'No active ID cards available'
                : 'No ID cards available'}
          </p>
          {enrollmentStatusFilter === 'active' && idCardCountsByFilter.pending > 0 ? (
            <button
              type="button"
              onClick={() => setEnrollmentStatusFilter('pending')}
              className="mt-4 text-oe-primary hover:text-blue-800 text-sm font-medium"
            >
              Show pending migration ID cards ({idCardCountsByFilter.pending})
            </button>
          ) : null}
          {selectedProductFilter !== 'all' && (
            <button
              onClick={() => setSelectedProductFilter('all')}
              className="mt-4 text-oe-primary hover:text-blue-800 text-sm font-medium"
            >
              Show all products
            </button>
          )}
        </div>
      )}
    </div>
  );
}


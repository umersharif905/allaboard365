import { CheckCircle, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { apiService } from '../../../services/api.service';
import { EffectiveDatesService } from '../../../services/effective-dates.service';
import { GroupProductsService } from '../../../services/group-products.service';
import {
  hasDimeApplyWarning,
  isPrimaryEnrollmentPreviewRow,
  shouldSkipDimeRecurringForMember
} from './planModificationWizardHelpers';
import { GroupedEnrollment, MemberEnrollment } from '../../../services/member/member-enrollments.service';
import { Member } from '../../../types/member.types';
import { validateSSN } from '../../../utils/helpers';

type ChangeKind = 'dependents' | 'planSelection' | 'terminations' | 'editEffectiveDates';

type StepId = 'selectChanges' | 'effectiveDate' | 'configure' | 'review' | 'confirm';

interface Props {
  member: Member;
  enrollments: MemberEnrollment[];
  groupedEnrollments: GroupedEnrollment[];
  onCancel: () => void;
  onApplied: () => Promise<void> | void;
}

type ProductListItem = {
  ProductId: string;
  Name: string;
  Description: string;
  ProductType: string;
  IsBundle: boolean;
  /** API may return 0/1 or boolean */
  IsHidden?: boolean | number;
  SalesType?: string;
  RequiredDataFields?: Array<{ fieldName?: string; fieldOptions?: string[]; isDeductible?: boolean }>;
  ProductLogoUrl?: string | null;
  ProductImageUrl?: string | null;
  ProductDocumentUrl?: string | null;
  vendorName?: string | null;
  bundleProducts?: Array<{
    productId: string;
    name: string;
    description?: string;
    productType?: string;
    hidePricing?: boolean;
    requiredDataFields?: Array<{ fieldName?: string; fieldOptions?: string[] }>;
  }>;
};

type ConfigValueMap = Record<string, string>;

type TerminationPlanCardType = 'bundle' | 'individual' | 'Contribution' | 'PaymentProcessingFee' | 'SystemFee';

type TerminationSelection = {
  planCardId: string; // bundleId, productId, or enrollmentId for Contribution/ProcessingFee/SystemFee
  planCardType: TerminationPlanCardType;
  terminationDateOverride?: string | null; // YYYY-MM-DD
};

type DryRunResponse = {
  success: boolean;
  data?: {
    enrollmentsToTerminate: Array<{
      enrollmentId: string;
      memberId: string;
      productId: string;
      productBundleId?: string | null;
      enrollmentType?: string | null;
      existingEffectiveDate?: string | null;
      existingTerminationDate?: string | null;
      terminationDate: string;
      premiumAmount: number;
      employerContributionAmount?: number;
      householdId?: string | null;
      enrollmentDetails?: any;
      netRate?: number;
      overrideRate?: number;
      commission?: number;
      includedPaymentProcessingFeeAmount?: number;
      includedSystemFeeAmount?: number;
      isDependentRow: boolean;
    }>;
    enrollmentsToCreate: Array<{
      memberId: string;
      relationshipType: string;
      enrollmentType?: string | null;
      productId: string;
      productBundleId?: string | null;
      effectiveDate: string;
      premiumAmount: number;
      employerContributionAmount?: number;
      householdId?: string | null;
      enrollmentDetails?: any;
      netRate?: number;
      overrideRate?: number;
      commission?: number;
      includedPaymentProcessingFeeAmount?: number;
      includedSystemFeeAmount?: number;
      configValue1?: string | null;
    }>;
    dependents: {
      toAdd: any[];
      toRemove: string[];
    };
    dependentRemovalMode?: 'disable' | 'hardDelete';
    hardDeletePreview?: Array<{
      memberId: string;
      memberName: string;
      email?: string | null;
      userId: string | null;
      enrollmentIds: string[];
      enrollments?: Array<{
        enrollmentId: string;
        enrollmentType?: string | null;
        productId?: string | null;
        effectiveDate?: string | null;
        terminationDate?: string | null;
      }>;
    }>;
    reactivateMemberIds?: string[];
    currentPrimaryTier?: string | null;
    primaryTierAfterChanges?: string | null;
    contributionEnrollmentsToCreate?: Array<{
      enrollmentType: 'Contribution';
      memberId: string;
      effectiveDate: string;
      premiumAmount: number;
      employerContributionAmount: number;
    }>;
    feeEnrollmentsToCreate?: Array<{ enrollmentType: string; premiumAmount: number; memberId?: string | null; effectiveDate?: string | null }>;
    feeMonthlyTotal?: number;
    includedProcessingFeeTotal?: number;
    includedSystemFeeTotal?: number;
    nonIncludedProcessingFeeAmount?: number;
    currentFeeAmounts?: { systemFee: number; paymentProcessingFee: number } | null;
    pricingSummary?: {
      premiumTotal: number;
      employerContributionTotal: number;
      employeeContributionTotal: number;
      memberMonthlyDue: number;
      currentPremiumTotal?: number | null;
      currentEmployerContributionTotal?: number | null;
      currentEmployeeContributionTotal?: number | null;
      currentIncludedFeesTotal?: number | null;
      /** Sum of PremiumAmount on active Product/Bundle/SystemFee/PaymentProcessingFee enrollments (dry-run Current). */
      currentMonthlyDue?: number | null;
    };
    dimeImpact: {
      willUpdateRecurring: boolean;
      willCancelRecurring: boolean;
      reason: string;
    };
    /** Matches backend plan gate for DIME (group id and/or list-bill). */
    isGroupBilledMember?: boolean;
    billType?: string | null;
    enrollmentsToUpdateEffectiveDate?: Array<{
      enrollmentId: string;
      memberId: string;
      productId?: string | null;
      productBundleId?: string | null;
      enrollmentType?: string | null;
      currentEffectiveDate: string;
      newEffectiveDate: string;
      isDependentRow?: boolean;
    }>;
    /** Pricing / persist: Y or N */
    tobaccoUseResolved?: string | null;
    persistTobaccoUse?: boolean;
    /**
     * Existing invoices that the planned changes would render over-billed.
     * (Removed from plan-mod wizard — issue credits manually elsewhere if needed.)
     */
    invoiceDriftPreview?: {
      candidates: Array<{
        invoiceId: string;
        invoiceNumber: string | null;
        billingPeriodStart: string | null;
        billingPeriodEnd: string | null;
        totalAmount: number;
        paidAmount: number;
        creditAlreadyApplied: number;
        recomputedTotal: number;
        suggestedCredit: number;
        status: string;
      }>;
      summary: { count: number; totalSuggestedCredit: number };
    };
    /** Apply-only: result of the post-commit credit issuance. */
    invoiceDriftRemediation?: {
      attempted: boolean;
      applied: Array<{
        invoiceId: string;
        invoiceNumber: string | null;
        amount: number;
        entryId: string;
      }>;
      error?: string;
    };
    /**
     * Open (Unpaid/Partial/Overdue) individual invoices whose TotalAmount
     * will change once enrollments are applied. Computed by the same
     * reconcile path the nightly job uses (reconcileUnfulfilledInvoice),
     * so the wizard preview matches what apply will write.
     */
    openInvoiceReconcilePreview?: {
      candidates: Array<{
        invoiceId: string;
        invoiceNumber: string | null;
        periodStart: string | null;
        periodEnd: string | null;
        status: string;
        currentTotal: number;
        projectedTotal: number;
        delta: number;
      }>;
      summary: { count: number; totalDelta: number };
    };
    /** Apply-only: result of the post-commit open invoice reconcile. */
    openInvoiceReconcile?: {
      attempted: boolean;
      updated: Array<{
        invoiceId: string;
        invoiceNumber: string | null;
        periodStart: string | null;
        periodEnd: string | null;
        status: string;
        previousTotal: number;
        newTotal: number;
        delta: number;
      }>;
      skipped: Array<{
        invoiceId: string;
        invoiceNumber: string | null;
        reason: string;
        error?: string;
      }>;
      error?: string;
    };
    /**
     * Paid Individual invoices where projected enrollment premium vs invoice header differs.
     * Align step matches reconcilePaidIndividualInvoiceTotalsWhenEligible (paid ≈ enrollment sum).
     */
    paidInvoiceAlignmentPreview?: {
      candidates: Array<{
        invoiceId: string;
        invoiceNumber: string | null;
        billingPeriodStart: string | null;
        billingPeriodEnd: string | null;
        storedTotal: number;
        paidAmount: number;
        balanceDue: number;
        enrollmentSum: number;
        alignEligible: boolean;
        reasonIfNotEligible: string | null;
        potentialUnderbill: boolean;
        underbillDelta: number | null;
      }>;
      summary: { count: number; alignEligibleCount: number; potentialUnderbillCount: number };
    };
    paidInvoiceAlignmentRemediation?: {
      attempted: boolean;
      updated: Array<Record<string, unknown>>;
      skipped: Array<Record<string, unknown>>;
      error?: string;
    };
  };
  message?: string;
};

const steps: Array<{ id: StepId; title: string; description: string }> = [
  { id: 'selectChanges', title: 'Select changes', description: 'Choose what you want to modify' },
  { id: 'effectiveDate', title: 'Effective date', description: 'Pick when changes take effect' },
  { id: 'configure', title: 'Configure', description: 'Select plans and terminations' },
  { id: 'review', title: 'Dry run preview', description: 'Preview database changes before applying' },
  { id: 'confirm', title: 'Confirm', description: 'Apply changes' }
];

function toYMD(d: Date) {
  return d.toISOString().split('T')[0];
}

/** Format a calendar date from API/DB for display without timezone shift (backend returns UTC; avoid showing a day behind). */
function formatCalendarDateForDisplay(value: string | Date | null | undefined): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.split('T')[0];
  const d = new Date(value);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatCurrency(amount: number) {
  const n = Number(amount || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function paidAlignReasonLabel(code: string | null | undefined): string {
  if (!code) return '—';
  if (code === 'totals_already_match_enrollments') return 'Totals already match enrollments';
  if (code === 'paid_amount_mismatch_enrollments') return 'Paid amount ≠ projected enrollment total (manual review)';
  if (code === 'not_eligible') return 'Not eligible';
  return code;
}

function normalizeDetailsJson(raw: any) {
  if (raw == null) return { rawText: '', prettyText: '' };
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return { rawText: '', prettyText: '' };
    try {
      const parsed = JSON.parse(t);
      return { rawText: t, prettyText: JSON.stringify(parsed, null, 2) };
    } catch {
      return { rawText: t, prettyText: t };
    }
  }
  try {
    return { rawText: JSON.stringify(raw), prettyText: JSON.stringify(raw, null, 2) };
  } catch {
    const s = String(raw);
    return { rawText: s, prettyText: s };
  }
}

function detailsPreview(raw: any) {
  const { prettyText } = normalizeDetailsJson(raw);
  if (!prettyText) return '';
  if (prettyText.length <= 80) return prettyText;
  return `${prettyText.slice(0, 80)}…`;
}

type DependentToAddForm = {
  _rowId?: string;
  firstName: string;
  lastName: string;
  relationshipType: 'S' | 'C';
  dateOfBirth: string;
  gender: 'Male' | 'Female' | '';
  ssn?: string;
  email?: string;
};

function dependentRowKey(dep: DependentToAddForm, idx: number) {
  return dep._rowId ?? `idx-${idx}`;
}

/** Strip UI-only fields and send 9-digit SSN + spouse email for API. */
function normalizeDependentsForPlanApi(list: DependentToAddForm[]) {
  return list.map((dep) => {
    const digits = (dep.ssn || '').replace(/\D/g, '');
    const emailTrim = (dep.email || '').trim();
    const out: Record<string, unknown> = {
      firstName: dep.firstName,
      lastName: dep.lastName,
      relationshipType: dep.relationshipType,
      dateOfBirth: dep.dateOfBirth,
      gender: dep.gender,
    };
    if (digits.length === 9) {
      out.ssn = digits;
    }
    if (dep.relationshipType === 'S' && emailTrim) {
      out.email = emailTrim;
    }
    return out;
  });
}

export default function TenantAdminPlanModificationWizard({
  member,
  enrollments,
  groupedEnrollments,
  onCancel,
  onApplied
}: Props) {
  const [stepIdx, setStepIdx] = useState(0);
  const step = steps[stepIdx];

  const [selectedChangeKinds, setSelectedChangeKinds] = useState<ChangeKind[]>([]);

  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [configValues, setConfigValues] = useState<ConfigValueMap>({});

  const [terminations, setTerminations] = useState<TerminationSelection[]>([]);
  const [terminationDateSetAll, setTerminationDateSetAll] = useState<string>(''); // "Apply same termination date to all" at top

  const [effectiveDateEdits, setEffectiveDateEdits] = useState<Record<string, string>>({}); // enrollmentId -> newEffectiveDate (YYYY-MM-DD)
  const [effectiveDateSetAll, setEffectiveDateSetAll] = useState<string>(''); // "Set all to" date input

  const [effectiveDate, setEffectiveDate] = useState<string>('');

  /** Y/N for primary — defaults from member; sent to plan-modifications API for pricing and oe.Members.TobaccoUse on apply. */
  const [tobaccoUse, setTobaccoUse] = useState<'Y' | 'N'>(() => (member.TobaccoUse === 'Y' ? 'Y' : 'N'));

  const [currentDependentsLoading, setCurrentDependentsLoading] = useState(false);
  const [currentDependentsError, setCurrentDependentsError] = useState<string | null>(null);
  const [currentDependents, setCurrentDependents] = useState<Array<any>>([]);
  const [dependentsToRemove, setDependentsToRemove] = useState<string[]>([]);
  const [dependentRemovalMode, setDependentRemovalMode] = useState<'disable' | 'hardDelete'>('disable');
  const [reactivateMemberIds, setReactivateMemberIds] = useState<string[]>([]);
  const [dependentsToAdd, setDependentsToAdd] = useState<DependentToAddForm[]>([]);
  const [dependentSsnVisible, setDependentSsnVisible] = useState<Record<string, boolean>>({});

  const [productsLoading, setProductsLoading] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [allTenantProducts, setAllTenantProducts] = useState<ProductListItem[]>([]);
  /** Include rows with IsHidden (individual products and bundle parents share oe.Products.IsHidden) */
  const [showHiddenPlanProducts, setShowHiddenPlanProducts] = useState(false);
  /** Group members: product IDs assigned on the group (GroupProductsTab parity). */
  const [groupAssignedProductIds, setGroupAssignedProductIds] = useState<Set<string>>(new Set());
  const [groupProductsLoading, setGroupProductsLoading] = useState(false);
  const [productCatalogScope, setProductCatalogScope] = useState<'group' | 'all'>('group');
  const [showDependentEnrollmentPreview, setShowDependentEnrollmentPreview] = useState(false);

  const isProductHidden = (p: ProductListItem) => {
    const x = p as any;
    return (
      p.IsHidden === true || Number(p.IsHidden) === 1 ||
      x.isHidden === true || x.isHidden === 1 ||
      x.IsHidden === 'true' || x.isHidden === 'true'
    );
  };

  /** Group members: hide Individual-only. Non-group: hide Group-only. Empty/Both always allowed. */
  const isSalesTypeAllowedForMemberProduct = (p: ProductListItem | any, memberInGroup: boolean): boolean => {
    const st = (p.SalesType ?? (p as any).salesType ?? '').toString().trim().toLowerCase();
    if (!st) return true;
    if (memberInGroup) return st !== 'individual';
    return st !== 'group';
  };

  const memberInGroup = !!member.GroupId;

  useEffect(() => {
    setTobaccoUse(member.TobaccoUse === 'Y' ? 'Y' : 'N');
  }, [member.MemberId, member.TobaccoUse]);

  const tobaccoDirty = useMemo(() => {
    const stored = member.TobaccoUse === 'Y' ? 'Y' : 'N';
    return tobaccoUse !== stored;
  }, [member.TobaccoUse, tobaccoUse]);

  /** Product/bundle IDs on the member's current enrollments (always show these rows even when catalog-hidden) */
  const currentPlanIdSet = useMemo(() => {
    const s = new Set<string>();
    for (const ge of groupedEnrollments || []) {
      const id = ge.type === 'bundle' ? ge.bundleId : ge.primaryEnrollment?.productId;
      if (id) s.add(String(id));
    }
    return s;
  }, [groupedEnrollments]);

  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<DryRunResponse['data'] | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [dataChangesMode, setDataChangesMode] = useState<'hidden' | 'shown'>('shown');
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<any | null>(null);

  /** Group / list-bill: no individual DIME UI or recurring updates in this wizard. */
  const isGroupBilledForDime = useMemo(
    () => shouldSkipDimeRecurringForMember(member, dryRunResult?.isGroupBilledMember),
    [dryRunResult?.isGroupBilledMember, member.GroupId, member.BillType]
  );

  const [updateDimeRecurring, setUpdateDimeRecurring] = useState(true);
  /** Apply-only: align paid invoice TotalAmount/breakdown when PaidAmount already matches enrollment-derived total. */
  const [alignPaidInvoiceTotalsWhenEligible, setAlignPaidInvoiceTotalsWhenEligible] = useState(false);
  const [detailsModal, setDetailsModal] = useState<{ title: string; details: any } | null>(null);

  // Only surface actively-held plans for termination. groupedEnrollments splits rows by status (Active vs Inactive)
  // so without this filter the wizard shows both the Active and the superseded "ghost" copy of the same product,
  // inviting admins to re-terminate something already terminated.
  const currentPlanCards = useMemo(() => {
    const todayYmd = toYMD(new Date());
    const isActiveGroup = (ge: GroupedEnrollment) => {
      const status = (ge.status as string | undefined) || ge.primaryEnrollment?.status;
      if (status && String(status).toLowerCase() !== 'active') return false;
      const termRaw = ge.terminationDate || ge.primaryEnrollment?.terminationDate;
      if (termRaw) {
        const termYmd = String(termRaw).slice(0, 10);
        if (termYmd <= todayYmd) return false;
      }
      return true;
    };
    const seenId = new Set<string>();
    return (groupedEnrollments || [])
      .filter(isActiveGroup)
      .map((ge) => {
        const id = ge.type === 'bundle' ? ge.bundleId : ge.primaryEnrollment?.productId;
        const type = ge.type === 'bundle' ? 'bundle' : 'individual';
        const totalPremium = ge.totalPremium ?? 0;
        return {
          id: id || '',
          type,
          name: ge.type === 'bundle'
            ? (ge.bundleName || 'Bundle')
            : (ge.primaryEnrollment?.product?.name || 'Plan'),
          products: ge.type === 'bundle'
            ? (ge.componentEnrollments || []).map((c: any) => ({ id: c.productId, name: c.product?.name || 'Product' }))
            : [],
          premiumAmount: totalPremium
        };
      })
      .filter((c) => {
        if (!c.id) return false;
        if (seenId.has(c.id)) return false;
        seenId.add(c.id);
        return true;
      });
  }, [groupedEnrollments]);

  /** Enrollment-only rows when my-products omits a product the member still has (e.g. legacy / hidden) */
  const enrollmentProductStubs = useMemo((): ProductListItem[] => {
    const tenantIds = new Set(allTenantProducts.map((p) => String(p.ProductId)));
    const out: ProductListItem[] = [];
    for (const ge of groupedEnrollments || []) {
      const planIdRaw = ge.type === 'bundle' ? (ge.bundleId || ge.bundleProduct?.productId) : ge.primaryEnrollment?.productId;
      const planId = planIdRaw ? String(planIdRaw) : '';
      if (!planId || tenantIds.has(planId)) continue;
      if (ge.type === 'bundle') {
        const bp = ge.bundleProduct;
        out.push({
          ProductId: planId,
          Name: bp?.name || ge.bundleName || 'Bundle',
          Description: bp?.description || '',
          ProductType: bp?.productType || 'Bundle',
          IsBundle: true,
          IsHidden: true,
          ProductLogoUrl: bp?.productLogoUrl ?? null,
          ProductImageUrl: bp?.productImageUrl ?? null,
          bundleProducts: []
        });
      } else if (ge.primaryEnrollment?.product) {
        const pr = ge.primaryEnrollment.product;
        out.push({
          ProductId: String(pr.productId),
          Name: pr.name,
          Description: pr.description || '',
          ProductType: pr.productType,
          IsBundle: false,
          IsHidden: true,
          ProductLogoUrl: pr.productLogoUrl ?? null,
          ProductImageUrl: pr.productImageUrl ?? null
        });
      }
    }
    return out;
  }, [groupedEnrollments, allTenantProducts]);

  const catalogProductsForPicker = useMemo(() => {
    const map = new Map<string, ProductListItem>();
    for (const p of allTenantProducts) {
      map.set(String(p.ProductId), p);
    }
    for (const stub of enrollmentProductStubs) {
      const sid = String(stub.ProductId);
      if (!map.has(sid)) map.set(sid, stub);
    }
    return Array.from(map.values());
  }, [allTenantProducts, enrollmentProductStubs]);

  /** Hidden toggle + SalesType + group assignment; current enrollments always listed */
  const products = useMemo(() => {
    const restrictToGroupCatalog =
      memberInGroup && !!member.GroupId && groupAssignedProductIds.size > 0 && productCatalogScope === 'group';
    return catalogProductsForPicker.filter((p) => {
      const sid = String(p.ProductId);
      const isCurrent = currentPlanIdSet.has(sid);
      if (!showHiddenPlanProducts && isProductHidden(p) && !isCurrent) return false;
      if (!isSalesTypeAllowedForMemberProduct(p, memberInGroup) && !isCurrent) return false;
      if (restrictToGroupCatalog && !groupAssignedProductIds.has(sid) && !isCurrent) return false;
      return true;
    });
  }, [
    catalogProductsForPicker,
    showHiddenPlanProducts,
    currentPlanIdSet,
    memberInGroup,
    member.GroupId,
    groupAssignedProductIds,
    productCatalogScope
  ]);

  // Effective-date picker is server-driven so cohort lock + AllowMidMonthEffective
  // (group) and product EffectiveDateLogic (individual) are honored. Window:
  // 2 months past to 3 months future. Backend may return either a 'dropdown' of
  // explicit dates (cohort-locked group OR FirstOfMonth product) OR a 'calendar'
  // range (flexible individual). UI handles both.
  const [effectiveDateOptions, setEffectiveDateOptions] = useState<{
    type: 'dropdown' | 'calendar';
    fixedDate: null;
    availableDates: string[];
    dateRange: { earliest: string; latest: string } | null;
    defaultDate: string | null;
    allowedDays: number[];
    householdCohort: 'FIRST' | 'FIFTEENTH' | null;
  }>({
    type: 'dropdown',
    fixedDate: null,
    availableDates: [],
    dateRange: null,
    defaultDate: null,
    allowedDays: [1],
    householdCohort: null
  });
  const [effectiveDateLoading, setEffectiveDateLoading] = useState(false);
  const [effectiveDateError, setEffectiveDateError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    (async () => {
      setEffectiveDateLoading(true);
      setEffectiveDateError(null);
      try {
        const res = await EffectiveDatesService.getEffectiveDates(
          member.MemberId,
          [],
          { pastMonths: 2, futureMonths: 3 }
        );
        if (canceled) return;
        if (!res.success || !res.data) {
          throw new Error(res.message || 'Failed to fetch effective dates');
        }
        const opts = res.data.effectiveDateOptions;
        const isCalendar = opts.type === 'calendar';
        const dates = opts.availableDates || [];
        const dateRange = opts.dateRange ?? null;
        const allowed = opts.restrictions?.allowedDays || (opts.restrictions?.mustBeFirstOfMonth ? [1] : []);
        const cohort = opts.restrictions?.householdCohort ?? null;
        const todayYmd = toYMD(new Date());

        let defaultDate: string | null = null;
        if (isCalendar && dateRange) {
          // Calendar mode (flexible individuals): default to today if it's in
          // range, else the earliest allowed date.
          if (todayYmd >= dateRange.earliest && todayYmd <= dateRange.latest) {
            defaultDate = todayYmd;
          } else {
            defaultDate = dateRange.earliest;
          }
        } else {
          // Dropdown mode: first cohort-day in the future, else last available.
          const future = dates.filter((d) => d >= todayYmd);
          defaultDate = future[0] ?? dates[dates.length - 1] ?? null;
        }

        setEffectiveDateOptions({
          type: isCalendar ? 'calendar' : 'dropdown',
          fixedDate: null,
          availableDates: dates,
          dateRange,
          defaultDate,
          allowedDays: allowed,
          householdCohort: cohort
        });
      } catch (e: any) {
        if (!canceled) setEffectiveDateError(e?.message || 'Failed to fetch effective dates');
      } finally {
        if (!canceled) setEffectiveDateLoading(false);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [member.MemberId]);

  useEffect(() => {
    if (effectiveDate) return;
    if (effectiveDateOptions.defaultDate) {
      setEffectiveDate(effectiveDateOptions.defaultDate);
    } else if (effectiveDateOptions.availableDates?.length) {
      setEffectiveDate(effectiveDateOptions.availableDates[effectiveDateOptions.availableDates.length - 1]);
    }
  }, [effectiveDateOptions, effectiveDate]);

  // Termination-only flows still require an effectiveDate anchor for the backend
  // buildPlan call, but the household cohort may return no available dates (e.g.
  // backdated termination on a member with no future enrollments). Fall back to
  // today so the dry-run can run; per-row terminationDateOverride drives actual
  // termination dates.
  useEffect(() => {
    if (effectiveDate) return;
    if (effectiveDateLoading) return;
    const isTerminationsOnly =
      selectedChangeKinds.length === 1 && selectedChangeKinds[0] === 'terminations';
    if (!isTerminationsOnly) return;
    if ((effectiveDateOptions.availableDates?.length ?? 0) > 0) return;
    if (effectiveDateOptions.dateRange) return;
    setEffectiveDate(toYMD(new Date()));
  }, [effectiveDate, effectiveDateLoading, selectedChangeKinds, effectiveDateOptions.availableDates, effectiveDateOptions.dateRange]);

  const effectiveDateLabel = useMemo(() => {
    if (effectiveDateOptions.type === 'calendar') {
      return 'Effective date';
    }
    const days = effectiveDateOptions.allowedDays;
    const cohort = effectiveDateOptions.householdCohort;
    if (days.length === 1 && days[0] === 15) {
      return cohort === 'FIFTEENTH'
        ? 'Effective date (household locked to 15th cohort)'
        : 'Effective date (15th of month only)';
    }
    if (days.length === 1 && days[0] === 1) {
      return cohort === 'FIRST'
        ? 'Effective date (household locked to 1st cohort)'
        : 'Effective date (1st of month only)';
    }
    return 'Effective date (1st or 15th of month)';
  }, [effectiveDateOptions]);

  useEffect(() => {
    const shouldLoadDependents = selectedChangeKinds.includes('dependents');
    if (!shouldLoadDependents) return;

    let canceled = false;
    (async () => {
      setCurrentDependentsLoading(true);
      setCurrentDependentsError(null);
      try {
        const r = await apiService.get(`/api/members/${member.MemberId}/dependents`) as { success: boolean; data?: any[]; message?: string };
        if (!r.success) throw new Error(r.message || 'Failed to load dependents');
        if (!canceled) setCurrentDependents(r.data || []);
      } catch (e: any) {
        if (!canceled) setCurrentDependentsError(e.message || 'Failed to load dependents');
      } finally {
        if (!canceled) setCurrentDependentsLoading(false);
      }
    })();

    return () => {
      canceled = true;
    };
  }, [member.MemberId, selectedChangeKinds]);

  const loadTenantProducts = async () => {
    setProductsLoading(true);
    setProductsError(null);
    setProductCatalogScope('group');
    try {
      const r = await apiService.get(`/api/me/tenant-admin/my-products?filter=all`) as { success: boolean; data?: any[]; message?: string };
      if (!r.success) throw new Error(r.message || 'Failed to load tenant products');
      const list = (r.data || []) as ProductListItem[];
      setAllTenantProducts(list);
      if (member.GroupId) {
        setGroupProductsLoading(true);
        try {
          const gr = await GroupProductsService.getGroupProducts(member.GroupId, { includeHidden: true });
          const gp =
            gr.success && gr.data?.groupProducts
              ? gr.data.groupProducts
              : [];
          const ids = new Set<string>();
          for (const row of gp) {
            const active = row.IsActive !== false;
            if (active && row.ProductId) ids.add(String(row.ProductId));
          }
          setGroupAssignedProductIds(ids);
        } catch {
          setGroupAssignedProductIds(new Set());
        } finally {
          setGroupProductsLoading(false);
        }
      } else {
        setGroupAssignedProductIds(new Set());
      }
    } catch (e: any) {
      setProductsError(e.message || 'Failed to load tenant products');
    } finally {
      setProductsLoading(false);
    }
  };

  // Default select current plans and config values when entering configure step with plan selection (run once when products loaded and none selected)
  useEffect(() => {
    if (step.id !== 'configure' || !selectedChangeKinds.includes('planSelection') || products.length === 0 || selectedProductIds.length > 0) return;
    const ids = Array.from(new Set(currentPlanCards.map((c) => String(c.id || '').trim()).filter(Boolean)));
    if (ids.length === 0) return;
    setSelectedProductIds(ids);
    const nextConfig: ConfigValueMap = {};
    for (const ge of groupedEnrollments || []) {
      const planId = ge.bundleId || ge.primaryEnrollment?.productId;
      if (!planId) continue;
      const raw = ge.primaryEnrollment?.enrollmentDetails;
      if (raw == null) continue;
      let parsed: any = null;
      if (typeof raw === 'string') {
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
      } else if (typeof raw === 'object') {
        parsed = raw;
      }
      const cfg = parsed?.configuration ?? parsed?.configValues?.configValue1;
      if (cfg != null && String(cfg).trim() !== '') nextConfig[planId] = String(cfg);
    }
    if (Object.keys(nextConfig).length > 0) setConfigValues((prev) => ({ ...prev, ...nextConfig }));
  }, [step.id, selectedChangeKinds, products.length, currentPlanCards, groupedEnrollments]);

  // Drop selections that are hidden (when toggle off) or wrong SalesType for this member (keep current enrollments)
  useEffect(() => {
    setSelectedProductIds((ids) =>
      ids.filter((id) => {
        const sid = String(id);
        if (currentPlanIdSet.has(sid)) return true;
        const p = catalogProductsForPicker.find((x) => String(x.ProductId) === sid);
        if (!p) return false;
        if (!isSalesTypeAllowedForMemberProduct(p, memberInGroup)) return false;
        if (!showHiddenPlanProducts && isProductHidden(p)) return false;
        if (
          memberInGroup &&
          member.GroupId &&
          groupAssignedProductIds.size > 0 &&
          productCatalogScope === 'group' &&
          !groupAssignedProductIds.has(sid)
        ) {
          return false;
        }
        return true;
      })
    );
  }, [
    showHiddenPlanProducts,
    catalogProductsForPicker,
    currentPlanIdSet,
    memberInGroup,
    member.GroupId,
    groupAssignedProductIds,
    productCatalogScope
  ]);

  const productNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of catalogProductsForPicker) {
      m.set(String(p.ProductId), p.Name);
      if (p.IsBundle && Array.isArray(p.bundleProducts)) {
        for (const bp of p.bundleProducts) {
          if (bp?.productId && bp?.name) {
            m.set(String(bp.productId), String(bp.name));
          }
        }
      }
    }
    return m;
  }, [catalogProductsForPicker]);

  // Configuration options for a product or bundle (from RequiredDataFields first field's fieldOptions, like EnrollmentWizard)
  const getConfigOptions = (p: ProductListItem): { options: string[]; fieldName: string } => {
    const fields = p.RequiredDataFields ?? (p as any).requiredDataFields;
    if (Array.isArray(fields) && fields.length > 0) {
      const first = fields[0];
      const opts = (first?.fieldOptions ?? (first as any)?.fieldOptions) ?? [];
      if (opts.length > 0) return { options: opts.map(String), fieldName: (first?.fieldName as string) || 'Configuration' };
    }
    if (p.IsBundle && Array.isArray(p.bundleProducts)) {
      for (const bp of p.bundleProducts) {
        const bf = bp.requiredDataFields ?? (bp as any).requiredDataFields;
        if (Array.isArray(bf) && bf.length > 0) {
          const first = bf[0];
          const opts = (first?.fieldOptions ?? (first as any)?.fieldOptions) ?? [];
          if (opts.length > 0) return { options: opts.map(String), fieldName: (first?.fieldName as string) || 'Configuration' };
        }
      }
    }
    return { options: [], fieldName: 'Configuration' };
  };

  const formatProductLabel = (productId?: string | null, bundleId?: string | null) => {
    const productName = productId ? (productNameById.get(productId) || productId) : '—';
    if (!bundleId) return productName;
    const bundleName = productNameById.get(bundleId) || bundleId;
    return `${bundleName} • ${productName}`;
  };

  // Enrollments that can have effective date edited: active or future (not terminated)
  const editableEnrollmentsForEffectiveDate = useMemo(() => {
    const list = enrollments || [];
    const today = toYMD(new Date());
    return list.filter((e: any) => {
      const term = e.terminationDate ?? e.TerminationDate;
      if (term) {
        const termStr = typeof term === 'string' ? term.split('T')[0] : toYMD(new Date(term));
        if (termStr <= today) return false; // already terminated
      }
      const eff = e.effectiveDate ?? e.EffectiveDate;
      return !!eff;
    }).map((e: any) => {
      const id = e.enrollmentId ?? e.EnrollmentId;
      const eff = e.effectiveDate ?? e.EffectiveDate;
      const et = e.enrollmentType ?? e.EnrollmentType ?? 'Product';
      const name = et === 'Contribution' ? 'Contribution' : et === 'PaymentProcessingFee' ? 'Processing fee' : et === 'SystemFee' ? 'System fee' : (e.product?.name ?? e.bundleProduct?.name ?? e.ProductName ?? 'Product');
      return { enrollmentId: id, currentEffectiveDate: formatCalendarDateForDisplay(eff), enrollmentType: et, name };
    });
  }, [enrollments]);

  // All terminable rows: plan cards + Contribution + PaymentProcessingFee + SystemFee from enrollments.
  // Only include currently-active fee rows (Status=Active AND termination null/in future) so the list is not
  // polluted by superseded ghost rows left behind by earlier plan modifications.
  const terminationCards = useMemo(() => {
    type Card = { id: string; type: TerminationPlanCardType; name: string; products?: Array<{ id: string; name: string }>; enrollmentId?: string; premiumAmount?: number };
    const cards: Card[] = currentPlanCards.map((c) => ({ ...c, type: c.type as TerminationPlanCardType, premiumAmount: c.premiumAmount ?? 0 } as Card));
    const enrollmentsList = enrollments || [];
    const feeTypes = ['Contribution', 'PaymentProcessingFee', 'SystemFee'] as const;
    const typeLabels: Record<string, string> = { Contribution: 'Contribution', PaymentProcessingFee: 'Processing fee', SystemFee: 'System fee' };
    const todayYmd = toYMD(new Date());
    const seenFeeKey = new Set<string>();
    for (const e of enrollmentsList) {
      const et = (e.enrollmentType ?? (e as any).EnrollmentType) as string;
      if (!feeTypes.includes(et as any)) continue;
      const enrollmentId = e.enrollmentId ?? (e as any).EnrollmentId;
      if (!enrollmentId) continue;

      const status = (e as any).status ?? (e as any).Status;
      if (status && String(status).toLowerCase() !== 'active') continue;

      // Skip rows already ending (termination <= today) — they're effectively past and should not appear as terminable.
      const termDateRaw = (e as any).terminationDate ?? (e as any).TerminationDate;
      if (termDateRaw) {
        const termYmd = String(termDateRaw).slice(0, 10);
        if (termYmd <= todayYmd) continue;
      }

      // De-duplicate by type — backend keeps a single active SystemFee / PaymentProcessingFee per household,
      // so if somehow more than one slipped through, only surface the most-recent.
      if (et === 'PaymentProcessingFee' || et === 'SystemFee') {
        if (seenFeeKey.has(et)) continue;
        seenFeeKey.add(et);
      }

      const premium = Number((e as any).premiumAmount ?? (e as any).PremiumAmount ?? 0);
      const name = et === 'Contribution'
        ? `Contribution${e.employerContributionAmount != null ? ` (${formatCurrency(Number(e.employerContributionAmount))})` : ''}`
        : typeLabels[et] || et;
      cards.push({
        id: enrollmentId,
        type: et as TerminationPlanCardType,
        name,
        products: [],
        enrollmentId,
        premiumAmount: premium
      });
    }
    return cards;
  }, [currentPlanCards, enrollments]);

  // Day before next effective date: if effective date is selected use day before it; else use last day of current month (day before first of next month)
  const defaultTerminationDate = useMemo(() => {
    if (effectiveDate) {
      const d = new Date(effectiveDate + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      return toYMD(d);
    }
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return toYMD(lastDay);
  }, [effectiveDate]);

  const canGoNext = () => {
    if (step.id === 'selectChanges') return selectedChangeKinds.length > 0;
    if (step.id === 'effectiveDate') return (selectedChangeKinds.includes('editEffectiveDates') && selectedChangeKinds.length === 1) || !!effectiveDate;
    if (step.id === 'configure') {
      if (selectedChangeKinds.includes('dependents')) {
        const hasInvalidNewDependent = dependentsToAdd.some(d => {
          const ssnDigits = (d.ssn || '').replace(/\D/g, '');
          const ssnHasPartial = ssnDigits.length > 0 && ssnDigits.length !== 9;
          const ssnNineInvalid = ssnDigits.length === 9 && !validateSSN(ssnDigits).isValid;
          const spouseEmail = (d.email || '').trim();
          const spouseEmailBad =
            d.relationshipType === 'S' &&
            spouseEmail.length > 0 &&
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(spouseEmail);
          return (
            !d.firstName.trim() ||
            !d.lastName.trim() ||
            !d.dateOfBirth ||
            !d.gender ||
            d.gender.trim() === '' ||
            ssnHasPartial ||
            ssnNineInvalid ||
            spouseEmailBad
          );
        });
        if (hasInvalidNewDependent) return false;
      }
      if (selectedChangeKinds.includes('planSelection') && selectedProductIds.length === 0 && !tobaccoDirty) return false;
      if (selectedChangeKinds.includes('terminations') && terminations.length === 0) return false;
      if (selectedChangeKinds.includes('editEffectiveDates')) {
        const hasEdit = editableEnrollmentsForEffectiveDate.some(
          (row) => effectiveDateEdits[row.enrollmentId] && effectiveDateEdits[row.enrollmentId] !== row.currentEffectiveDate
        );
        if (!hasEdit) return false;
      }
      return true;
    }
    if (step.id === 'review') return dryRunResult != null && confirmChecked;
    return true;
  };

  const goNext = async () => {
    if (step.id === 'selectChanges') {
      await loadTenantProducts();
      // Skip effective date step when only "Edit effective dates" is selected (that flow uses per-row dates in Configure)
      if (selectedChangeKinds.length === 1 && selectedChangeKinds[0] === 'editEffectiveDates') {
        setStepIdx(2); // configure
        return;
      }
      // Skip effective date step when only "Terminate plans" is selected (termination dates are set in Configure; use default for API).
      // effectiveDate is still required by the backend buildPlan; fall back to today
      // when the household cohort returns no available dates (common for backdated
      // terminations on members with no future enrollments).
      if (selectedChangeKinds.length === 1 && selectedChangeKinds[0] === 'terminations') {
        setEffectiveDate((prev) => prev || effectiveDateOptions.defaultDate || toYMD(new Date()));
        setStepIdx(2); // configure
        return;
      }
    }
    setStepIdx((i) => Math.min(steps.length - 1, i + 1));
  };

  const goBack = () => {
    if (step.id === 'configure' && selectedChangeKinds.length === 1) {
      const only = selectedChangeKinds[0];
      if (only === 'editEffectiveDates' || only === 'terminations') {
        setStepIdx(0); // selectChanges (skip effective date step)
        return;
      }
    }
    setStepIdx((i) => Math.max(0, i - 1));
  };

  const toggleChange = (k: ChangeKind) => {
    setSelectedChangeKinds((prev) => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k]);
  };

  const toggleProduct = (pid: string) => {
    const sid = String(pid);
    const p = catalogProductsForPicker.find((x) => String(x.ProductId) === sid);
    if (p && !currentPlanIdSet.has(sid)) {
      if (!isSalesTypeAllowedForMemberProduct(p, memberInGroup)) return;
      if (!showHiddenPlanProducts && isProductHidden(p)) return;
    }
    setSelectedProductIds((prev) =>
      prev.some((x) => String(x) === sid) ? prev.filter((x) => String(x) !== sid) : [...prev, pid]
    );
  };

  const setConfigValue = (productId: string, value: string) => {
    setConfigValues((prev) => ({ ...prev, [productId]: value }));
  };

  const toggleTermination = (planCardId: string, planCardType: TerminationPlanCardType) => {
    setTerminations((prev) => {
      const exists = prev.find(t => t.planCardId === planCardId);
      if (exists) return prev.filter(t => t.planCardId !== planCardId);
      return prev.concat([{ planCardId, planCardType, terminationDateOverride: null }]);
    });
  };

  const terminateAllChecked = terminationCards.length > 0 && terminationCards.every((c) =>
    terminations.some(t => t.planCardId === c.id)
  );
  const setTerminateAll = (checked: boolean) => {
    if (checked) {
      setTerminations(terminationCards.map((c) => ({
        planCardId: c.id,
        planCardType: c.type,
        terminationDateOverride: null
      })));
    } else {
      setTerminations([]);
    }
  };

  const setTerminationOverride = (planCardId: string, dateStr: string) => {
    setTerminations((prev) => prev.map(t => t.planCardId === planCardId ? { ...t, terminationDateOverride: dateStr } : t));
  };

  const applyTerminationDateToAll = () => {
    const dateStr = terminationDateSetAll || defaultTerminationDate;
    if (!dateStr) return;
    setTerminations((prev) => prev.map(t => ({ ...t, terminationDateOverride: dateStr })));
  };

  const effectiveDateEditsPayload = useMemo(() => {
    if (!selectedChangeKinds.includes('editEffectiveDates')) return [];
    return editableEnrollmentsForEffectiveDate
      .filter((row) => effectiveDateEdits[row.enrollmentId] && effectiveDateEdits[row.enrollmentId] !== row.currentEffectiveDate)
      .map((row) => ({ enrollmentId: row.enrollmentId, newEffectiveDate: effectiveDateEdits[row.enrollmentId] }));
  }, [selectedChangeKinds, editableEnrollmentsForEffectiveDate, effectiveDateEdits]);

  const handleGenerateDryRun = async () => {
    setDryRunLoading(true);
    setDryRunError(null);
    setDryRunResult(null);
    setConfirmChecked(false);
    setDataChangesMode('shown');
    setAlignPaidInvoiceTotalsWhenEligible(false);
    setShowDependentEnrollmentPreview(false);
    try {
      const payload: any = {
        memberId: member.MemberId,
        effectiveDate,
        selectedPlans: selectedProductIds,
        configValues,
        terminations,
        dependentsToAdd: normalizeDependentsForPlanApi(dependentsToAdd),
        dependentsToRemove,
        dependentRemovalMode,
        reactivateMemberIds,
        tobaccoUse,
        updateDimeRecurring: isGroupBilledForDime ? false : updateDimeRecurring
      };
      if (selectedChangeKinds.includes('editEffectiveDates') && effectiveDateEditsPayload.length > 0) {
        payload.effectiveDateEdits = effectiveDateEditsPayload;
      }
      const r = await apiService.post('/api/me/tenant-admin/plan-modifications/dry-run', payload) as DryRunResponse;
      if (!r.success) throw new Error(r.message || 'Dry run failed');
      setDryRunResult(r.data || null);
    } catch (e: any) {
      setDryRunError(e.message || 'Dry run failed');
    } finally {
      setDryRunLoading(false);
    }
  };

  const handleApply = async () => {
    setApplyLoading(true);
    setApplyError(null);
    setApplyResult(null);
    try {
      const payload: any = {
        memberId: member.MemberId,
        effectiveDate,
        selectedPlans: selectedProductIds,
        configValues,
        terminations,
        dependentsToAdd: normalizeDependentsForPlanApi(dependentsToAdd),
        dependentsToRemove,
        dependentRemovalMode,
        reactivateMemberIds,
        tobaccoUse,
        updateDimeRecurring: isGroupBilledForDime ? false : updateDimeRecurring,
        alignPaidInvoiceTotalsWhenEligible
      };
      if (selectedChangeKinds.includes('editEffectiveDates') && effectiveDateEditsPayload.length > 0) {
        payload.effectiveDateEdits = effectiveDateEditsPayload;
      }
      const r = await apiService.post('/api/me/tenant-admin/plan-modifications/apply', payload) as DryRunResponse;
      if (!r.success) throw new Error(r.message || 'Apply failed');
      setApplyResult(r.data || null);
      await onApplied();
    } catch (e: any) {
      setApplyError(e.message || 'Apply failed');
    } finally {
      setApplyLoading(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="p-6 border-b border-gray-200">
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Plan modification wizard</h1>
          <p className="text-gray-600">This wizard always generates a dry run preview before applying any changes.</p>
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-lg font-medium text-gray-900">{step.title}</h2>
              <p className="text-gray-600 text-sm">{step.description}</p>
            </div>
            <div className="text-sm text-gray-500">Step {stepIdx + 1} of {steps.length}</div>
          </div>

          {step.id === 'selectChanges' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <label className="bg-white rounded-lg border border-gray-200 p-4 flex items-start gap-3 cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={selectedChangeKinds.includes('dependents')}
                    onChange={() => toggleChange('dependents')}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm font-medium text-gray-900">Add / remove dependents</div>
                    <div className="text-sm text-gray-600">Update household members (V1 UI placeholder).</div>
                  </div>
                </label>
                <label className="bg-white rounded-lg border border-gray-200 p-4 flex items-start gap-3 cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={selectedChangeKinds.includes('planSelection')}
                    onChange={() => toggleChange('planSelection')}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm font-medium text-gray-900">Modify plan</div>
                    <div className="text-sm text-gray-600">Choose products / bundles for the new effective date.</div>
                  </div>
                </label>
                <label className="bg-white rounded-lg border border-gray-200 p-4 flex items-start gap-3 cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={selectedChangeKinds.includes('terminations')}
                    onChange={() => toggleChange('terminations')}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm font-medium text-gray-900">Terminate plans</div>
                    <div className="text-sm text-gray-600">Terminate selected plans (household-wide).</div>
                  </div>
                </label>
                <label className="bg-white rounded-lg border border-gray-200 p-4 flex items-start gap-3 cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={selectedChangeKinds.includes('editEffectiveDates')}
                    onChange={() => toggleChange('editEffectiveDates')}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm font-medium text-gray-900">Edit effective dates</div>
                    <div className="text-sm text-gray-600">Change effective date on existing enrollments (admin).</div>
                  </div>
                </label>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onCancel}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!canGoNext()}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {step.id === 'effectiveDate' && (
            <div className="space-y-4">
              <div className="space-y-1">
                <label className="block text-sm font-medium text-gray-700">{effectiveDateLabel}</label>
                {effectiveDateOptions.type === 'calendar' && effectiveDateOptions.dateRange ? (
                  <input
                    type="date"
                    value={effectiveDate}
                    onChange={(e) => setEffectiveDate(e.target.value)}
                    disabled={effectiveDateLoading || !!effectiveDateError}
                    min={effectiveDateOptions.dateRange.earliest}
                    max={effectiveDateOptions.dateRange.latest}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
                  />
                ) : (
                  <select
                    value={effectiveDate}
                    onChange={(e) => setEffectiveDate(e.target.value)}
                    disabled={effectiveDateLoading || !!effectiveDateError}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
                  >
                    <option value="">
                      {effectiveDateLoading ? 'Loading available dates…' : 'Select effective date'}
                    </option>
                    {(effectiveDateOptions.availableDates || []).map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                )}
                {effectiveDateError ? (
                  <p className="text-xs text-red-600">{effectiveDateError}</p>
                ) : (
                  <p className="text-xs text-gray-500">Default termination date will be {defaultTerminationDate || '—'}.</p>
                )}
              </div>

              <div className="flex justify-between gap-3 pt-2">
                <button
                  type="button"
                  onClick={goBack}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                >
                  <ChevronLeft className="h-4 w-4 mr-2" />
                  Back
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!canGoNext()}
                  className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Continue
                  <ChevronRight className="h-4 w-4 ml-2" />
                </button>
              </div>
            </div>
          )}

          {step.id === 'configure' && (
            <div className="space-y-6">
              <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Primary member tobacco use</label>
                <p className="text-xs text-gray-500 mb-2">
                  Affects product pricing for this modification (same as enrollment). On apply, updates{' '}
                  <span className="font-mono text-gray-600">oe.Members.TobaccoUse</span> when this value differs from the current record.
                </p>
                <select
                  value={tobaccoUse}
                  onChange={(e) => setTobaccoUse(e.target.value === 'Y' ? 'Y' : 'N')}
                  className="w-full max-w-xs px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="N">No</option>
                  <option value="Y">Yes</option>
                </select>
                {member.TobaccoUse != null && member.TobaccoUse !== 'Y' && member.TobaccoUse !== 'N' && (
                  <p className="text-xs text-amber-700 mt-2">
                    Member was marked unknown/other in the database; pricing defaults to &quot;No&quot; until you save.
                  </p>
                )}
              </div>

              {productsLoading && (
                <div className="flex items-center gap-2 text-gray-600 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading tenant products…
                </div>
              )}
              {productsError && (
                <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 text-sm">
                  {productsError}
                </div>
              )}

              {selectedChangeKinds.includes('dependents') && (
                <div className="bg-white rounded-lg border border-gray-200">
                  <div className="p-6 border-b border-gray-200">
                    <h2 className="text-lg font-medium text-gray-900">Dependents</h2>
                    <p className="text-gray-600 text-sm">Add/remove dependents effective on the selected date.</p>
                  </div>
                  <div className="p-6 space-y-6">
                    {currentDependentsLoading && (
                      <div className="flex items-center gap-2 text-gray-600 text-sm">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading current dependents…
                      </div>
                    )}
                    {currentDependentsError && (
                      <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 text-sm">
                        {currentDependentsError}
                      </div>
                    )}

                    <div>
                      <h3 className="text-sm font-medium text-gray-900 mb-2">Remove existing</h3>
                      {(() => {
                        const activeDependents = currentDependents.filter((d: any) => (d.Status ?? d.status) !== 'Inactive');
                        return activeDependents.length === 0 ? (
                          <p className="text-sm text-gray-600">No active dependents found.</p>
                        ) : (
                          <div className="space-y-2">
                            {activeDependents.map((d: any) => (
                              <label key={d.MemberId} className="flex items-start gap-3 border border-gray-200 rounded-lg p-3 cursor-pointer hover:bg-gray-50">
                                <input
                                  type="checkbox"
                                  checked={dependentsToRemove.includes(d.MemberId)}
                                  onChange={() => {
                                    setDependentsToRemove((prev) => prev.includes(d.MemberId) ? prev.filter(x => x !== d.MemberId) : prev.concat([d.MemberId]));
                                  }}
                                  className="mt-1"
                                />
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-gray-900">{d.FirstName} {d.LastName}</div>
                                  <div className="text-xs text-gray-500">{d.RelationshipDescription} • DOB {d.DateOfBirth}</div>
                                </div>
                              </label>
                            ))}
                          </div>
                        );
                      })()}
                      {dependentsToRemove.length > 0 && (
                        <div className="mt-4 p-4 border border-gray-200 rounded-lg bg-gray-50">
                          <h4 className="text-sm font-medium text-gray-900 mb-2">When removing dependents</h4>
                          <label className="flex items-start gap-3 cursor-pointer">
                            <input
                              type="radio"
                              name="dependentRemovalMode"
                              checked={dependentRemovalMode === 'disable'}
                              onChange={() => setDependentRemovalMode('disable')}
                              className="mt-1"
                            />
                            <div>
                              <span className="text-sm font-medium text-gray-900">Set to Inactive (default)</span>
                              <p className="text-xs text-gray-500">oe.Members and oe.Users: Status → &quot;Inactive&quot;. Rows stay in DB; they can be reactivated later from the list below.</p>
                            </div>
                          </label>
                          <label className="flex items-start gap-3 cursor-pointer mt-2">
                            <input
                              type="radio"
                              name="dependentRemovalMode"
                              checked={dependentRemovalMode === 'hardDelete'}
                              onChange={() => setDependentRemovalMode('hardDelete')}
                              className="mt-1"
                            />
                            <div>
                              <span className="text-sm font-medium text-red-700">Hard delete (dangerous)</span>
                              <p className="text-xs text-gray-500">oe.Enrollments (for that member) DELETED. oe.Members row DELETED. oe.Users row DELETED. Irreversible.</p>
                            </div>
                          </label>
                        </div>
                      )}
                    </div>

                    {(() => {
                      const inactiveDependents = currentDependents.filter((d: any) => (d.Status ?? d.status) === 'Inactive');
                      if (inactiveDependents.length === 0) return null;
                      return (
                        <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                          <h3 className="text-sm font-medium text-gray-900 mb-2">Inactive dependents</h3>
                          <p className="text-xs text-gray-600 mb-3">Reactivate and add them back to the household plans.</p>
                          <div className="space-y-2">
                            {inactiveDependents.map((d: any) => (
                              <div key={d.MemberId} className="flex items-center justify-between border border-gray-200 rounded-lg p-3 bg-white">
                                <div>
                                  <div className="text-sm font-medium text-gray-900">{d.FirstName} {d.LastName}</div>
                                  <div className="text-xs text-gray-500">{d.RelationshipDescription} • DOB {d.DateOfBirth}</div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setReactivateMemberIds((prev) => prev.includes(d.MemberId) ? prev.filter((id) => id !== d.MemberId) : prev.concat([d.MemberId]))}
                                  className={`px-3 py-1.5 rounded-lg text-sm font-medium ${reactivateMemberIds.includes(d.MemberId) ? 'bg-green-100 text-green-800' : 'border border-gray-300 text-gray-700 hover:bg-gray-50'}`}
                                >
                                  {reactivateMemberIds.includes(d.MemberId) ? 'Added to reactivate' : 'Reactivate and add to plans'}
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-sm font-medium text-gray-900">Add new</h3>
                        <button
                          type="button"
                          onClick={() => setDependentsToAdd((prev) => prev.concat([{
                            _rowId: globalThis.crypto?.randomUUID?.() ?? `r-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                            firstName: '',
                            lastName: '',
                            relationshipType: 'C',
                            dateOfBirth: '',
                            gender: '',
                            ssn: '',
                            email: ''
                          }]))}
                          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                        >
                          Add dependent
                        </button>
                      </div>

                      {dependentsToAdd.length === 0 ? (
                        <p className="text-sm text-gray-600">No new dependents to add.</p>
                      ) : (
                        <div className="space-y-3">
                          {dependentsToAdd.map((dep, idx) => {
                            const rowKey = dependentRowKey(dep, idx);
                            const ssnDigits = (dep.ssn || '').replace(/\D/g, '').slice(0, 9);
                            const showSsn = !!dependentSsnVisible[rowKey];
                            const ssnCheck = ssnDigits.length === 9 ? validateSSN(ssnDigits) : { isValid: true as boolean };
                            return (
                              <div key={rowKey} className="border border-gray-200 rounded-lg p-4 space-y-4">
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                                  <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">First name</label>
                                    <input
                                      value={dep.firstName}
                                      onChange={(e) => setDependentsToAdd((prev) => prev.map((x, i) => i === idx ? { ...x, firstName: e.target.value } : x))}
                                      className="w-full min-h-[42px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Last name</label>
                                    <input
                                      value={dep.lastName}
                                      onChange={(e) => setDependentsToAdd((prev) => prev.map((x, i) => i === idx ? { ...x, lastName: e.target.value } : x))}
                                      className="w-full min-h-[42px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Relationship</label>
                                    <select
                                      value={dep.relationshipType}
                                      onChange={(e) => {
                                        const v = e.target.value as 'S' | 'C';
                                        setDependentsToAdd((prev) =>
                                          prev.map((x, i) =>
                                            i === idx ? { ...x, relationshipType: v, email: v === 'C' ? '' : x.email } : x
                                          )
                                        );
                                      }}
                                      className="w-full min-h-[42px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                    >
                                      <option value="C">Child</option>
                                      <option value="S">Spouse</option>
                                    </select>
                                  </div>
                                  <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Date of birth</label>
                                    <input
                                      type="date"
                                      value={dep.dateOfBirth}
                                      onChange={(e) => setDependentsToAdd((prev) => prev.map((x, i) => i === idx ? { ...x, dateOfBirth: e.target.value } : x))}
                                      className="w-full min-h-[42px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                    />
                                  </div>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Gender</label>
                                    <select
                                      value={dep.gender}
                                      onChange={(e) => setDependentsToAdd((prev) => prev.map((x, i) => i === idx ? { ...x, gender: e.target.value as 'Male' | 'Female' | '' } : x))}
                                      className="w-full min-h-[42px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                    >
                                      <option value="">Select gender</option>
                                      <option value="Male">Male</option>
                                      <option value="Female">Female</option>
                                    </select>
                                  </div>
                                  {dep.relationshipType === 'S' && (
                                    <div>
                                      <label className="block text-sm font-medium text-gray-700 mb-1">Spouse email (optional)</label>
                                      <input
                                        type="email"
                                        value={dep.email || ''}
                                        onChange={(e) => setDependentsToAdd((prev) => prev.map((x, i) => i === idx ? { ...x, email: e.target.value } : x))}
                                        className="w-full min-h-[42px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                        placeholder="spouse@example.com"
                                        autoComplete="off"
                                      />
                                    </div>
                                  )}
                                </div>
                                <div>
                                  <label className="block text-sm font-medium text-gray-700 mb-1">Social Security Number (optional)</label>
                                  <div className="flex gap-2 items-stretch">
                                    <div className="relative flex-1 min-w-0 max-w-xl">
                                      <input
                                        type={showSsn ? 'text' : 'password'}
                                        inputMode="numeric"
                                        autoComplete="off"
                                        maxLength={11}
                                        value={
                                          showSsn
                                            ? dep.ssn || ''
                                            : ssnDigits.length > 0
                                              ? `${ssnDigits.slice(0, 3)}${ssnDigits.length > 3 ? '-' : ''}${ssnDigits.slice(3, 5)}${ssnDigits.length > 5 ? '-' : ''}${ssnDigits.slice(5, 9)}`
                                              : ''
                                        }
                                        onChange={(e) => {
                                          const dOnly = e.target.value.replace(/\D/g, '').slice(0, 9);
                                          setDependentsToAdd((prev) => prev.map((x, i) => i === idx ? { ...x, ssn: dOnly } : x));
                                        }}
                                        className="w-full min-h-[44px] pl-3 pr-11 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 font-mono text-base"
                                        placeholder="XXX-XX-XXXX"
                                      />
                                      <button
                                        type="button"
                                        aria-label={showSsn ? 'Hide SSN' : 'Show SSN'}
                                        onClick={() => setDependentSsnVisible((prev) => ({ ...prev, [rowKey]: !prev[rowKey] }))}
                                        className="absolute right-1 top-1/2 -translate-y-1/2 p-2 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                                      >
                                        {showSsn ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                                      </button>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setDependentsToAdd((prev) => prev.filter((_, i) => i !== idx));
                                        setDependentSsnVisible((prev) => {
                                          const next = { ...prev };
                                          delete next[rowKey];
                                          return next;
                                        });
                                      }}
                                      className="shrink-0 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 self-end"
                                    >
                                      Remove
                                    </button>
                                  </div>
                                  {ssnDigits.length === 9 && !ssnCheck.isValid && (
                                    <p className="mt-1 text-sm text-red-600">{ssnCheck.error || 'Invalid SSN'}</p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {selectedChangeKinds.includes('planSelection') && (
                <div className="bg-white rounded-lg border border-gray-200">
                  <div className="p-6 border-b border-gray-200">
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                      <div>
                        <h2 className="text-lg font-medium text-gray-900">Modify plan</h2>
                        <p className="text-gray-600 text-sm">
                          Choose products and bundles for the effective date. Current plans stay listed even if catalog-hidden; use the toggle to show every hidden product.
                          {memberInGroup && member.GroupId && groupAssignedProductIds.size > 0
                            ? ' Default list matches products assigned to this group (same as the group Products tab).'
                            : memberInGroup
                              ? ' Group members only see group-channel products (not individual-only).'
                              : ' Direct members only see individual-channel products (not group-only).'}
                        </p>
                      </div>
                      <div className="flex flex-col sm:items-end gap-2 shrink-0">
                        {memberInGroup && member.GroupId && groupAssignedProductIds.size > 0 && (
                          <div className="w-full sm:w-64">
                            <label className="block text-xs font-medium text-gray-600 mb-1">Product catalog</label>
                            <select
                              value={productCatalogScope}
                              onChange={(e) => setProductCatalogScope(e.target.value as 'group' | 'all')}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                            >
                              <option value="group">Assigned to this group</option>
                              <option value="all">All tenant products (not recommended)</option>
                            </select>
                          </div>
                        )}
                        <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={showHiddenPlanProducts}
                            onChange={(e) => setShowHiddenPlanProducts(e.target.checked)}
                            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span>Show all hidden products &amp; bundles</span>
                        </label>
                      </div>
                    </div>
                    {productCatalogScope === 'all' && memberInGroup && member.GroupId && (
                      <p className="px-6 pb-0 -mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg mx-6 py-2">
                        Products not assigned to this group are shown for reference only. Selecting them can cause enrollment or billing mismatches—use group-assigned products when possible.
                      </p>
                    )}
                  </div>
                  <div className="p-6">
                    {(productsLoading || groupProductsLoading) && (
                      <p className="text-sm text-gray-500 mb-3">Loading product catalog…</p>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {products.map((p) => {
                        const sid = String(p.ProductId);
                        const notOnGroup =
                          memberInGroup &&
                          member.GroupId &&
                          groupAssignedProductIds.size > 0 &&
                          !groupAssignedProductIds.has(sid) &&
                          !currentPlanIdSet.has(sid);
                        const configOpts = getConfigOptions(p);
                        const isSelected = selectedProductIds.includes(p.ProductId);
                        const hasConfig = configOpts.options.length > 0;
                        const currentConfig = configValues[p.ProductId] ?? (configOpts.options[0] ?? '');
                        return (
                          <div key={p.ProductId} className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 flex flex-col gap-3">
                            <label className="cursor-pointer flex gap-3">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleProduct(p.ProductId)}
                                className="mt-1"
                              />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <div className="text-sm font-medium text-gray-900 truncate">{p.Name}</div>
                                  {p.IsBundle && (
                                    <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">
                                      Bundle
                                    </span>
                                  )}
                                  {isProductHidden(p) && (
                                    <span className="inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-700 border border-gray-200">
                                      Hidden
                                    </span>
                                  )}
                                  {notOnGroup && (
                                    <span className="inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-900 border border-amber-200">
                                      Not on group
                                    </span>
                                  )}
                                </div>
                                <div className="text-sm text-gray-600 line-clamp-2">{p.Description}</div>
                                {p.IsBundle && p.bundleProducts && p.bundleProducts.length > 0 && (
                                  <div className="mt-2 text-xs text-gray-500">
                                    Includes: {p.bundleProducts.map(bp => bp.name).slice(0, 4).join(', ')}{p.bundleProducts.length > 4 ? '…' : ''}
                                  </div>
                                )}
                              </div>
                            </label>
                            {isSelected && hasConfig && (
                              <div onClick={(e) => e.stopPropagation()} className="mt-1">
                                <label className="block text-xs font-medium text-gray-700 mb-1">{configOpts.fieldName}</label>
                                <select
                                  value={currentConfig}
                                  onChange={(e) => setConfigValue(p.ProductId, e.target.value)}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                                >
                                  {configOpts.options.map((opt) => (
                                    <option key={opt} value={opt}>{opt}</option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {selectedChangeKinds.includes('terminations') && (
                <div className="bg-white rounded-lg border border-gray-200">
                  <div className="p-6 border-b border-gray-200">
                    <h2 className="text-lg font-medium text-gray-900">Terminate plans and fees</h2>
                    <p className="text-gray-600 text-sm">Select plans, contributions, and fee rows to terminate. Plan termination applies household-wide (includes dependent $0 rows). Only active enrollments (not already terminated) get a termination date set.</p>
                    {terminationCards.length > 0 && (
                      <>
                        <label className="mt-3 flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={terminateAllChecked}
                            onChange={(e) => setTerminateAll(e.target.checked)}
                            className="rounded border-gray-300"
                          />
                          <span className="text-sm font-medium text-gray-700">Terminate all</span>
                        </label>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <label className="text-sm font-medium text-gray-700">Apply same termination date to all:</label>
                          <input
                            type="date"
                            value={terminationDateSetAll || defaultTerminationDate}
                            onChange={(e) => setTerminationDateSetAll(e.target.value)}
                            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                          />
                          <button
                            type="button"
                            onClick={applyTerminationDateToAll}
                            disabled={terminations.length === 0}
                            className="px-3 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:pointer-events-none"
                          >
                            Apply to all
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="p-6 space-y-3">
                    {terminationCards.length === 0 ? (
                      <p className="text-sm text-gray-600">No plans or fee rows to terminate.</p>
                    ) : (
                      terminationCards.map((c) => {
                        const selected = terminations.some(t => t.planCardId === c.id);
                        const override = terminations.find(t => t.planCardId === c.id)?.terminationDateOverride || '';
                        const typeLabel = c.type === 'bundle' ? 'Bundle' : c.type === 'individual' ? 'Individual plan' : c.type === 'Contribution' ? 'Contribution' : c.type === 'PaymentProcessingFee' ? 'Processing fee' : c.type === 'SystemFee' ? 'System fee' : c.type;
                        return (
                          <div
                            key={c.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => toggleTermination(c.id, c.type)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTermination(c.id, c.type); } }}
                            className="border border-gray-200 rounded-lg p-4 cursor-pointer hover:bg-gray-50 transition-colors"
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex items-start gap-3 flex-1 min-w-0">
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  onChange={() => toggleTermination(c.id, c.type)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="mt-1"
                                />
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-gray-900">{c.name}</div>
                                  <div className="text-xs text-gray-500">{typeLabel}</div>
                                  {c.type === 'bundle' && c.products && c.products.length > 0 && (
                                    <div className="mt-1 text-xs text-gray-600">
                                      Cancels: {c.products.map(p => p.name).slice(0, 6).join(', ')}{c.products.length > 6 ? '…' : ''}
                                    </div>
                                  )}
                                  {(c.premiumAmount != null && c.premiumAmount > 0) && (
                                    <div className="mt-1 text-xs font-medium text-gray-700">
                                      {c.type === 'bundle' ? 'Total premium: ' : 'Premium: '}{formatCurrency(c.premiumAmount)}
                                    </div>
                                  )}
                                </div>
                              </div>
                              <div className="min-w-[220px]" onClick={(e) => e.stopPropagation()}>
                                <label className="block text-xs font-medium text-gray-700 mb-1">Termination date</label>
                                <input
                                  type="date"
                                  disabled={!selected}
                                  value={override || (selected ? defaultTerminationDate : '')}
                                  onChange={(e) => setTerminationOverride(c.id, e.target.value)}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg disabled:bg-gray-50 disabled:opacity-60"
                                />
                                <p className="text-xs text-gray-500 mt-1">Default: {defaultTerminationDate || '—'}</p>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {selectedChangeKinds.includes('editEffectiveDates') && (
                <div className="bg-white rounded-lg border border-gray-200">
                  <div className="p-6 border-b border-gray-200">
                    <h2 className="text-lg font-medium text-gray-900">Edit effective dates</h2>
                    <p className="text-gray-600 text-sm">Change effective date on active or future enrollments. Product changes will also update dependent enrollments with the same product.</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <label className="text-sm font-medium text-gray-700">Set all to:</label>
                      <input
                        type="date"
                        value={effectiveDateSetAll}
                        onChange={(e) => setEffectiveDateSetAll(e.target.value)}
                        className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!effectiveDateSetAll) return;
                          setEffectiveDateEdits((prev) => {
                            const next = { ...prev };
                            editableEnrollmentsForEffectiveDate.forEach((row) => {
                              next[row.enrollmentId] = effectiveDateSetAll;
                            });
                            return next;
                          });
                        }}
                        className="px-3 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
                      >
                        Apply to all
                      </button>
                    </div>
                  </div>
                  <div className="p-6">
                    {editableEnrollmentsForEffectiveDate.length === 0 ? (
                      <p className="text-sm text-gray-600">No active or future enrollments to edit.</p>
                    ) : (
                      <div className="space-y-3">
                        {editableEnrollmentsForEffectiveDate.map((row) => {
                          const newDate = effectiveDateEdits[row.enrollmentId] ?? row.currentEffectiveDate;
                          return (
                            <div key={row.enrollmentId} className="flex flex-wrap items-center gap-4 border border-gray-200 rounded-lg p-3">
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium text-gray-900">{row.name}</div>
                                <div className="text-xs text-gray-500">{row.enrollmentType}</div>
                              </div>
                              <div className="text-sm text-gray-600">Current: {row.currentEffectiveDate}</div>
                              <div>
                                <label className="block text-xs font-medium text-gray-700 mb-1">New effective date</label>
                                <input
                                  type="date"
                                  value={newDate}
                                  onChange={(e) => setEffectiveDateEdits((prev) => ({ ...prev, [row.enrollmentId]: e.target.value }))}
                                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex justify-between gap-3 pt-2">
                <button
                  type="button"
                  onClick={goBack}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                >
                  <ChevronLeft className="h-4 w-4 mr-2" />
                  Back
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!canGoNext()}
                  className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Continue
                  <ChevronRight className="h-4 w-4 ml-2" />
                </button>
              </div>
            </div>
          )}

          {step.id === 'review' && (
            <div className="space-y-4">
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-gray-900">Generate dry run preview</div>
                    <div className="text-sm text-gray-600">This will show exactly what will be added/updated/terminated before applying.</div>
                  </div>
                  <button
                    type="button"
                    onClick={handleGenerateDryRun}
                    disabled={
                      dryRunLoading ||
                      (!effectiveDate && effectiveDateEditsPayload.length === 0 && !tobaccoDirty)
                    }
                    className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {dryRunLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle className="h-4 w-4 mr-2" />}
                    Generate preview
                  </button>
                </div>
              </div>

              {dryRunError && (
                <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 text-sm">
                  {dryRunError}
                </div>
              )}

              {dryRunResult && (() => {
                const ps = dryRunResult.pricingSummary;
                const contributionRows = dryRunResult.contributionEnrollmentsToCreate?.length ?? 0;
                const newEmp = Math.abs(ps?.employerContributionTotal ?? 0);
                const curEmp =
                  typeof ps?.currentEmployerContributionTotal === 'number' ? Math.abs(ps.currentEmployerContributionTotal) : null;
                const showContributionSections =
                  memberInGroup &&
                  (contributionRows > 0 ||
                    newEmp > 0.005 ||
                    (curEmp != null && curEmp > 0.005));

                const createsCount =
                  (dryRunResult.enrollmentsToCreate || []).length +
                  (dryRunResult.feeEnrollmentsToCreate || []).length +
                  (dryRunResult.contributionEnrollmentsToCreate || []).length;
                const isEffectiveDateOnlyDryRun =
                  (dryRunResult.enrollmentsToUpdateEffectiveDate?.length ?? 0) > 0 &&
                  createsCount === 0 &&
                  (dryRunResult.enrollmentsToTerminate || []).length === 0;

                const displayNewEmployer =
                  isEffectiveDateOnlyDryRun &&
                  typeof ps?.currentEmployerContributionTotal === 'number' &&
                  Math.abs(ps?.employerContributionTotal ?? 0) < 0.005
                    ? ps.currentEmployerContributionTotal
                    : (ps?.employerContributionTotal ?? 0);
                const sumPremAmount = (rows: Array<{ premiumAmount?: number }> = []) =>
                  rows.reduce((s, r) => s + Number(r.premiumAmount || 0), 0);
                const newPremiumSumFromCreates =
                  sumPremAmount(dryRunResult.enrollmentsToCreate || []) +
                  sumPremAmount(dryRunResult.feeEnrollmentsToCreate || []);
                const feeCreatesForDisplay = dryRunResult.feeEnrollmentsToCreate ?? [];
                const displayCurrentPremiumWithFees =
                  ps?.currentMonthlyDue != null && !Number.isNaN(Number(ps.currentMonthlyDue))
                    ? Number(ps.currentMonthlyDue)
                    : typeof ps?.currentPremiumTotal === 'number'
                      ? ps.currentPremiumTotal +
                        Number(ps?.currentIncludedFeesTotal || 0) +
                        Math.max(
                          0,
                          Number(dryRunResult.currentFeeAmounts?.systemFee || 0) +
                            Number(dryRunResult.currentFeeAmounts?.paymentProcessingFee || 0) -
                            Number(ps?.currentIncludedFeesTotal || 0)
                        )
                      : null;
                let displayNewPremiumWithFees: number;
                if (isEffectiveDateOnlyDryRun) {
                  displayNewPremiumWithFees = Number(
                    ps?.currentMonthlyDue ?? displayCurrentPremiumWithFees ?? ps?.memberMonthlyDue ?? 0
                  );
                } else if (memberInGroup) {
                  displayNewPremiumWithFees =
                    newPremiumSumFromCreates > 0.005
                      ? newPremiumSumFromCreates
                      : Number(ps?.memberMonthlyDue ?? 0);
                } else {
                  const termCount = (dryRunResult.enrollmentsToTerminate || []).length;
                  const noNewRows = newPremiumSumFromCreates < 0.005;
                  if (noNewRows && termCount === 0) {
                    displayNewPremiumWithFees = Number(
                      ps?.currentMonthlyDue ?? ps?.memberMonthlyDue ?? 0
                    );
                  } else {
                    displayNewPremiumWithFees = Number(ps?.memberMonthlyDue ?? 0);
                  }
                }
                const displayCurrentEmployeeFromTotals =
                  displayCurrentPremiumWithFees != null && typeof ps?.currentEmployerContributionTotal === 'number'
                    ? Math.max(0, displayCurrentPremiumWithFees - Math.abs(ps.currentEmployerContributionTotal))
                    : null;
                const displayNewEmployeeFromTotals = Math.max(
                  0,
                  displayNewPremiumWithFees - Math.abs(displayNewEmployer)
                );
                const projectedRecurringAmount = Number(ps?.memberMonthlyDue ?? 0);
                const projectedRecurringDate =
                  effectiveDate ||
                  dryRunResult.enrollmentsToCreate?.[0]?.effectiveDate ||
                  dryRunResult.feeEnrollmentsToCreate?.[0]?.effectiveDate ||
                  '';

                const terminateAll = dryRunResult.enrollmentsToTerminate || [];
                const effDateAll = dryRunResult.enrollmentsToUpdateEffectiveDate || [];
                const createProductAll = dryRunResult.enrollmentsToCreate || [];
                const primaryTerminateCount = terminateAll.filter((r) => isPrimaryEnrollmentPreviewRow(r)).length;
                const primaryCreateCount = createProductAll.filter((r) =>
                  isPrimaryEnrollmentPreviewRow({ rel: r.relationshipType, enrollmentType: r.enrollmentType })
                ).length;
                const primaryEffCount = effDateAll.filter((r) => isPrimaryEnrollmentPreviewRow(r)).length;
                const dependentPreviewCount =
                  terminateAll.length -
                  primaryTerminateCount +
                  (createProductAll.length - primaryCreateCount) +
                  (effDateAll.length - primaryEffCount);
                const feeCreateCount =
                  (dryRunResult.feeEnrollmentsToCreate || []).length +
                  (dryRunResult.contributionEnrollmentsToCreate || []).length;

                return (
                <div className="space-y-4">
                  <p className="text-xs text-gray-500">
                    {primaryTerminateCount} primary enrollment row(s) to terminate ·{' '}
                    {primaryCreateCount + feeCreateCount} to create
                    {dependentPreviewCount > 0 && (
                      <> · {dependentPreviewCount} dependent row(s) (expand below)</>
                    )}
                    {primaryEffCount > 0 && (
                      <> · {primaryEffCount} primary effective date update(s)</>
                    )}
                    {dryRunResult.persistTobaccoUse && (
                      <>
                        {' '}
                        · Tobacco on member → {dryRunResult.tobaccoUseResolved === 'Y' ? 'Yes' : 'No'} (saved on apply)
                      </>
                    )}
                  </p>

                  <div className="bg-white rounded-lg border border-gray-200 p-6">
                    <h3 className="text-lg font-medium text-gray-900 mb-4">Preview summary</h3>

                    {ps && (
                      <div className="space-y-4">
                        <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">Premium</div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="border border-gray-200 rounded-lg p-3 bg-white">
                              <div className="text-xs text-gray-500 mb-1">Current</div>
                              <div className="text-lg font-semibold text-gray-900">
                                {displayCurrentPremiumWithFees != null ? formatCurrency(displayCurrentPremiumWithFees) : '—'}
                              </div>
                            </div>
                            <div className="border border-gray-200 rounded-lg p-3 bg-white">
                              <div className="text-xs text-gray-500 mb-1">New</div>
                              <div className="text-lg font-semibold text-gray-900">{formatCurrency(displayNewPremiumWithFees)}</div>
                            </div>
                          </div>
                          <div className="text-xs text-gray-500 mt-2">
                            {isEffectiveDateOnlyDryRun
                              ? 'Premium totals are unchanged; only effective dates on existing enrollments are updated.'
                              : 'Totals sum PremiumAmount on active Product, Bundle, System fee, and Processing fee enrollments (Current) vs rows to be created (New for groups) or member monthly due (New for individuals).'}
                          </div>
                        </div>

                        {showContributionSections && (
                          <>
                            <div className="border border-gray-200 rounded-lg p-4 bg-green-50/50">
                              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">Employer contribution</div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div className="border border-gray-200 rounded-lg p-3 bg-white">
                                  <div className="text-xs text-gray-500 mb-1">Current</div>
                                  <div className="text-lg font-semibold text-green-800">
                                    {typeof ps.currentEmployerContributionTotal === 'number'
                                      ? formatCurrency(ps.currentEmployerContributionTotal)
                                      : '—'}
                                  </div>
                                </div>
                                <div className="border border-gray-200 rounded-lg p-3 bg-white">
                                  <div className="text-xs text-gray-500 mb-1">New</div>
                                  <div className="text-lg font-semibold text-green-800">{formatCurrency(displayNewEmployer)}</div>
                                </div>
                              </div>
                              <div className="text-xs text-gray-500 mt-2">
                                {isEffectiveDateOnlyDryRun
                                  ? 'Contribution splits are unchanged for this update.'
                                  : 'Current: sum of active Contribution enrollment rows (same as Plans tab). New: same calculation as Group Contributions → Apply to existing (rules + fees).'}
                              </div>
                            </div>
                            <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">Employee contribution</div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div className="border border-gray-200 rounded-lg p-3 bg-white">
                                  <div className="text-xs text-gray-500 mb-1">Current</div>
                                  <div className="text-lg font-semibold text-gray-900">
                                    {displayCurrentEmployeeFromTotals != null
                                      ? formatCurrency(displayCurrentEmployeeFromTotals)
                                      : typeof ps.currentEmployeeContributionTotal === 'number'
                                      ? formatCurrency(ps.currentEmployeeContributionTotal)
                                      : '—'}
                                  </div>
                                </div>
                                <div className="border border-gray-200 rounded-lg p-3 bg-white">
                                  <div className="text-xs text-gray-500 mb-1">New</div>
                                  <div className="text-lg font-semibold text-gray-900">{formatCurrency(displayNewEmployeeFromTotals)}</div>
                                </div>
                              </div>
                              <div className="text-xs text-gray-500 mt-2">
                                {isEffectiveDateOnlyDryRun
                                  ? 'Contribution splits are unchanged for this update.'
                                  : 'Current/New shown as fee-inclusive premium total minus employer contribution above.'}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    <div className={`border border-gray-200 rounded-lg p-4 ${dryRunResult.pricingSummary ? 'mt-4' : ''}`}>
                      <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">DIME</div>
                      <div className="text-sm font-medium text-gray-900">
                        {isGroupBilledForDime
                          ? 'No change'
                          : !updateDimeRecurring
                            ? 'Manual (no automatic update)'
                            : dryRunResult.dimeImpact?.willCancelRecurring
                              ? 'Cancel recurring'
                              : dryRunResult.dimeImpact?.willUpdateRecurring
                                ? 'Replace recurring'
                                : 'No change'}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {isGroupBilledForDime
                          ? 'For group-billed and list-bill members this wizard only changes enrollments. It does not alter DIME recurring payments, re-total open invoices, or post automatic account credits—handle those manually if needed.'
                          : !updateDimeRecurring
                            ? 'Recurring payment schedule will not be changed by this apply.'
                            : (dryRunResult.dimeImpact?.reason ?? '—')}
                      </div>
                      {!isGroupBilledForDime && (
                        <div className="mt-3 border border-gray-200 rounded-lg p-3 bg-gray-50">
                          <label className="flex items-start gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={updateDimeRecurring}
                              onChange={(e) => setUpdateDimeRecurring(e.target.checked)}
                              className="mt-1"
                            />
                            <div>
                              <div className="text-sm font-medium text-gray-900">Automatically update recurring payment in DIME</div>
                              <div className="text-xs text-gray-600 mt-0.5">
                                {updateDimeRecurring ? (
                                  <>
                                    On apply, active DIME recurring schedule(s) for this household are canceled
                                    {projectedRecurringAmount > 0
                                      ? ` and creates a new schedule for ${formatCurrency(projectedRecurringAmount)}`
                                      : ' and does not create a new schedule when the new monthly due is $0'}
                                    {projectedRecurringDate ? ` (next charge date ${projectedRecurringDate}).` : '.'}
                                  </>
                                ) : (
                                  'Recurring schedule will stay as-is. You can update it manually later.'
                                )}
                              </div>
                            </div>
                          </label>
                        </div>
                      )}
                    </div>

                    {(feeCreatesForDisplay.length > 0 && dryRunResult.currentFeeAmounts && (
                      <div className="border border-gray-200 rounded-lg p-4">
                        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">Fee changes</div>
                        <div className="text-xs text-gray-600 space-y-1">
                          {feeCreatesForDisplay.some((f) => f.enrollmentType === 'PaymentProcessingFee') && (
                            <div>
                              Payment processing fee:{' '}
                              {formatCurrency(dryRunResult.currentFeeAmounts.paymentProcessingFee)} →{' '}
                              {formatCurrency(
                                feeCreatesForDisplay.find((f) => f.enrollmentType === 'PaymentProcessingFee')?.premiumAmount ?? 0
                              )}
                            </div>
                          )}
                          {feeCreatesForDisplay.some((f) => f.enrollmentType === 'SystemFee') && (
                            <div>
                              System fee:{' '}
                              {formatCurrency(dryRunResult.currentFeeAmounts.systemFee)} →{' '}
                              {formatCurrency(feeCreatesForDisplay.find((f) => f.enrollmentType === 'SystemFee')?.premiumAmount ?? 0)}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}

                    {(dryRunResult.dependents.toAdd.length > 0 || dryRunResult.dependents.toRemove.length > 0 || reactivateMemberIds.length > 0) && (
                      <div className="mt-4 text-sm text-gray-700">
                        <div className="font-medium text-gray-900 mb-1">Dependents</div>
                        <div className="text-gray-600">
                          Add: <span className="font-medium text-gray-900">{dryRunResult.dependents.toAdd.length}</span> • Remove:{' '}
                          <span className="font-medium text-gray-900">{dryRunResult.dependents.toRemove.length}</span>
                          {reactivateMemberIds.length > 0 && (
                            <> • Reactivate: <span className="font-medium text-gray-900">{reactivateMemberIds.length}</span></>
                          )}
                        </div>
                        {dryRunResult.primaryTierAfterChanges && dryRunResult.currentPrimaryTier !== dryRunResult.primaryTierAfterChanges && (
                          <div className="mt-2 text-gray-700">
                            Primary member tier will change from <span className="font-medium">{dryRunResult.currentPrimaryTier ?? '—'}</span> to <span className="font-medium text-gray-900">{dryRunResult.primaryTierAfterChanges}</span>.
                          </div>
                        )}
                        {(dryRunResult.dependents.toRemove.length > 0) && (
                          <div className={`mt-3 p-3 border rounded-lg ${(dryRunResult.dependentRemovalMode ?? dependentRemovalMode) === 'hardDelete' ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50'}`}>
                            <div className="font-medium text-gray-900 mb-1">Removed dependents: impact on data</div>
                            {(dryRunResult.dependentRemovalMode ?? dependentRemovalMode) === 'hardDelete' ? (
                              <>
                                <p className="text-xs text-red-800 mb-2">Rows will be permanently deleted. Irreversible.</p>
                                <ul className="text-xs text-red-700 list-disc list-inside space-y-0.5 mb-3">
                                  <li><strong>oe.Enrollments</strong>: all rows for that member <strong>DELETED</strong></li>
                                  <li><strong>oe.Members</strong>: row <strong>DELETED</strong></li>
                                  <li><strong>oe.Users</strong>: row <strong>DELETED</strong></li>
                                </ul>
                                {(dryRunResult.hardDeletePreview && dryRunResult.hardDeletePreview.length > 0) && (
                                  <div className="mt-3 border border-red-200 rounded bg-white overflow-hidden">
                                    <div className="px-3 py-2 bg-red-50 border-b border-red-200 text-xs font-medium text-red-900">Exact rows that will be deleted (verify no other data is affected)</div>
                                    {dryRunResult.hardDeletePreview.map((preview: any) => (
                                      <div key={preview.memberId} className="p-3 border-b border-gray-100 last:border-b-0">
                                        <div className="font-medium text-gray-900 text-sm mb-1">{preview.memberName || 'Unknown'}</div>
                                        {preview.email && <div className="text-xs text-gray-600 mb-1">Email: {preview.email}</div>}
                                        <div className="text-xs text-gray-500 mb-2">
                                          <span className="font-mono">oe.Members</span> row: <span className="font-mono break-all">{preview.memberId}</span>
                                          {preview.userId && <> • <span className="font-mono">oe.Users</span> row: <span className="font-mono break-all">{preview.userId}</span></>}
                                        </div>
                                        <div className="text-xs font-medium text-gray-700 mb-1">
                                          oe.Enrollments to delete ({preview.enrollmentIds?.length ?? 0} row{(preview.enrollmentIds?.length ?? 0) !== 1 ? 's' : ''}):
                                        </div>
                                        {(preview.enrollments && preview.enrollments.length > 0) ? (
                                          <div className="overflow-x-auto max-h-48 overflow-y-auto">
                                            <table className="min-w-full text-xs border border-gray-200 rounded">
                                              <thead className="bg-gray-50 sticky top-0">
                                                <tr>
                                                  <th className="px-2 py-1.5 text-left font-medium text-gray-700">EnrollmentId</th>
                                                  <th className="px-2 py-1.5 text-left font-medium text-gray-700">Type</th>
                                                  <th className="px-2 py-1.5 text-left font-medium text-gray-700">ProductId</th>
                                                  <th className="px-2 py-1.5 text-left font-medium text-gray-700">Effective</th>
                                                  <th className="px-2 py-1.5 text-left font-medium text-gray-700">Termination</th>
                                                </tr>
                                              </thead>
                                              <tbody className="divide-y divide-gray-100">
                                                {preview.enrollments.map((e: any) => (
                                                  <tr key={e.enrollmentId}>
                                                    <td className="px-2 py-1 font-mono break-all">{e.enrollmentId}</td>
                                                    <td className="px-2 py-1">{e.enrollmentType ?? '—'}</td>
                                                    <td className="px-2 py-1 font-mono break-all">{e.productId ?? '—'}</td>
                                                    <td className="px-2 py-1">{e.effectiveDate ?? '—'}</td>
                                                    <td className="px-2 py-1">{e.terminationDate ?? '—'}</td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          </div>
                                        ) : (
                                          <p className="text-xs text-gray-500 italic">No enrollment rows for this member.</p>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </>
                            ) : (
                              <>
                                <p className="text-xs text-gray-600 mb-2">
                                  For each removed dependent, Status will be set to <strong>Inactive</strong> (oe.Members + oe.Users). Rows stay in DB; they can be reactivated later.
                                </p>
                                <ul className="text-xs text-gray-700 list-disc list-inside space-y-0.5">
                                  <li><strong>oe.Members</strong>: row kept; Status set to &quot;Inactive&quot;</li>
                                  <li><strong>oe.Users</strong>: row kept; Status set to &quot;Inactive&quot;</li>
                                </ul>
                              </>
                            )}
                          </div>
                        )}
                        {reactivateMemberIds.length > 0 && (
                          <div className="mt-3 p-3 border border-green-200 rounded-lg bg-green-50">
                            <div className="font-medium text-green-900 mb-1">Reactivated dependents</div>
                            <p className="text-xs text-green-800">The selected inactive dependent(s) will be set back to Active and enrollments will be created for the current plan selection.</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg p-4 text-sm">
                    This wizard does not process refunds, issue account credits, or run immediate one-off card charges. Terminations update enrollments and (for direct-billed members) can cancel/replace DIME recurring when that option is on. Paid invoices are not credited here—use manual goodwill elsewhere if a credit is warranted.
                  </div>

                  {/* Open invoice reconcile preview: open (Unpaid/Partial/Overdue) invoices whose
                      TotalAmount will change once apply runs. Mirrors the nightly job's reconcile path. */}
                  {dryRunResult.openInvoiceReconcilePreview && dryRunResult.openInvoiceReconcilePreview.summary.count > 0 && (
                    <div className="bg-white rounded-lg border border-blue-300">
                      <div className="p-4 border-b border-blue-200 bg-blue-50">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h4 className="text-sm font-semibold text-blue-900">
                              {dryRunResult.openInvoiceReconcilePreview.summary.count} open invoice{dryRunResult.openInvoiceReconcilePreview.summary.count === 1 ? '' : 's'} will be re-totaled
                            </h4>
                            <p className="mt-1 text-xs text-blue-800">
                              Net change:{' '}
                              <strong>
                                {dryRunResult.openInvoiceReconcilePreview.summary.totalDelta >= 0 ? '+' : '−'}$
                                {Math.abs(Number(dryRunResult.openInvoiceReconcilePreview.summary.totalDelta)).toFixed(2)}
                              </strong>
                              . Only open Unpaid/Partial/Overdue invoices are recomputed on apply (same logic as the nightly job&apos;s open reconcile).{' '}
                              <span className="font-medium">Nightly does not fix paid invoice headers from enrollments.</span>{' '}
                              Paid invoice header alignment is optional in the next section.
                            </p>
                          </div>
                        </div>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200 text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Invoice</th>
                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Period</th>
                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Current</th>
                              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">New</th>
                              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Δ</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-200">
                            {dryRunResult.openInvoiceReconcilePreview.candidates.map((c) => (
                              <tr key={c.invoiceId}>
                                <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{c.invoiceNumber || c.invoiceId.slice(0, 8)}</td>
                                <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                                  {c.periodStart
                                    ? new Date(c.periodStart).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
                                    : '—'}
                                </td>
                                <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{c.status}</td>
                                <td className="px-3 py-2 text-right text-gray-700 whitespace-nowrap">${Number(c.currentTotal).toFixed(2)}</td>
                                <td className="px-3 py-2 text-right text-gray-700 whitespace-nowrap">${Number(c.projectedTotal).toFixed(2)}</td>
                                <td
                                  className={`px-3 py-2 text-right font-semibold whitespace-nowrap ${
                                    c.delta >= 0 ? 'text-blue-800' : 'text-red-700'
                                  }`}
                                >
                                  {c.delta >= 0 ? '+' : '−'}${Math.abs(Number(c.delta)).toFixed(2)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Paid invoice header alignment preview (Individual / Paid only). */}
                  {dryRunResult.paidInvoiceAlignmentPreview &&
                    dryRunResult.paidInvoiceAlignmentPreview.summary.count > 0 &&
                    !dryRunResult.isGroupBilledMember && (
                      <div className="bg-white rounded-lg border border-indigo-300">
                        <div className="p-4 border-b border-indigo-200 bg-indigo-50">
                          <h4 className="text-sm font-semibold text-indigo-900">
                            Paid invoices (header alignment){' '}
                            <span className="font-normal text-indigo-800">
                              — {dryRunResult.paidInvoiceAlignmentPreview.summary.count} invoice
                              {dryRunResult.paidInvoiceAlignmentPreview.summary.count === 1 ? '' : 's'} in scope
                              {effectiveDate ? ` (billing period contains ${effectiveDate})` : ''}
                            </span>
                          </h4>
                          <p className="mt-1 text-xs text-indigo-900">
                            Updates <strong>Paid</strong> invoice <strong>TotalAmount</strong> and breakdown columns to match{' '}
                            <strong>projected enrollment premiums</strong> for that period when{' '}
                            <strong>paid amount already matches</strong> that projected total — fixes stale headers / commission JSON.{' '}
                            Does <strong>not</strong> change PaidAmount or remove existing credit ledger rows (
                            <strong>ManualGoodwill</strong> / <strong>OverpaymentRecognized</strong> stay as-is).
                          </p>
                          {dryRunResult.paidInvoiceAlignmentPreview.summary.potentialUnderbillCount > 0 && (
                            <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
                              <strong>Possible under-billing:</strong>{' '}
                              {dryRunResult.paidInvoiceAlignmentPreview.summary.potentialUnderbillCount} row
                              {dryRunResult.paidInvoiceAlignmentPreview.summary.potentialUnderbillCount === 1 ? '' : 's'} show projected enrollment total{' '}
                              <strong>above</strong> the invoiced amount while status is Paid. There is <strong>no automatic collection</strong> here (
                              phase 2: supplemental invoice, Charge Now, or ledger debit — product choice).
                            </div>
                          )}
                        </div>
                        <div className="overflow-x-auto">
                          <table className="min-w-full divide-y divide-gray-200 text-sm">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Invoice</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Period</th>
                                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Invoiced</th>
                                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Paid</th>
                                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Projected</th>
                                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Bal. due</th>
                                <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase">Align?</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Notes</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                              {dryRunResult.paidInvoiceAlignmentPreview.candidates.map((c) => (
                                <tr key={c.invoiceId}>
                                  <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                                    {c.invoiceNumber || c.invoiceId.slice(0, 8)}
                                  </td>
                                  <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                                    {c.billingPeriodStart
                                      ? new Date(c.billingPeriodStart).toLocaleString('en-US', {
                                          month: 'short',
                                          year: 'numeric',
                                          timeZone: 'UTC'
                                        })
                                      : '—'}
                                  </td>
                                  <td className="px-3 py-2 text-right text-gray-700 whitespace-nowrap">
                                    {formatCurrency(c.storedTotal)}
                                  </td>
                                  <td className="px-3 py-2 text-right text-gray-700 whitespace-nowrap">
                                    {formatCurrency(c.paidAmount)}
                                  </td>
                                  <td className="px-3 py-2 text-right text-gray-700 whitespace-nowrap">
                                    {formatCurrency(c.enrollmentSum)}
                                  </td>
                                  <td className="px-3 py-2 text-right text-gray-600 whitespace-nowrap">
                                    {formatCurrency(c.balanceDue)}
                                  </td>
                                  <td className="px-3 py-2 text-center whitespace-nowrap">
                                    <span
                                      className={
                                        c.alignEligible ? 'font-semibold text-green-800' : 'text-gray-500'
                                      }
                                    >
                                      {c.alignEligible ? 'Yes' : 'No'}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 text-xs text-gray-700">
                                    {c.potentialUnderbill && (
                                      <div className="mb-1 font-medium text-amber-900">
                                        Under-billed ~{formatCurrency(Number(c.underbillDelta || 0))} vs invoice — no auto collect (phase 2).
                                      </div>
                                    )}
                                    {!c.alignEligible && (
                                      <div>{paidAlignReasonLabel(c.reasonIfNotEligible)}</div>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <label className="flex items-start gap-3 p-4 border-t border-gray-200 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={alignPaidInvoiceTotalsWhenEligible}
                            onChange={(e) => setAlignPaidInvoiceTotalsWhenEligible(e.target.checked)}
                            disabled={
                              (dryRunResult.paidInvoiceAlignmentPreview.summary.alignEligibleCount ?? 0) === 0
                            }
                            className="mt-1"
                          />
                          <div>
                            <div className="text-sm font-medium text-gray-900">
                              Align paid invoice totals when eligible (
                              {dryRunResult.paidInvoiceAlignmentPreview.summary.alignEligibleCount ?? 0} invoice
                              {(dryRunResult.paidInvoiceAlignmentPreview.summary.alignEligibleCount ?? 0) === 1
                                ? ''
                                : 's'}
                              )
                            </div>
                            <div className="text-sm text-gray-600">
                              Off by default. When checked, apply runs header/breakdown alignment only for rows marked Align? Yes (paid already matches projected enrollment total).
                            </div>
                          </div>
                        </label>
                      </div>
                    )}

                  <label className="flex items-start gap-3 bg-white rounded-lg border border-gray-200 p-4 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={confirmChecked}
                      onChange={(e) => setConfirmChecked(e.target.checked)}
                      className="mt-1"
                    />
                    <div>
                      <div className="text-sm font-medium text-gray-900">I have reviewed the preview and want to proceed.</div>
                      <div className="text-sm text-gray-600">Confirming enables Apply on the next step.</div>
                    </div>
                  </label>

                  <div className="bg-white rounded-lg border border-gray-200 p-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">Data changes</label>
                    <select
                      value={dataChangesMode}
                      onChange={(e) => setDataChangesMode(e.target.value as any)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="hidden">Hide data changes</option>
                      <option value="shown">View data changes</option>
                    </select>
                    <p className="mt-2 text-xs text-gray-500">Dev view of the `oe.Enrollments` rows that will change.</p>
                  </div>

                  {dataChangesMode === 'shown' && (
                    <div className="space-y-4">
                      {(() => {
                        const createdProductRows = (dryRunResult.enrollmentsToCreate || []).map((r: any) => ({
                          kind: 'create' as const,
                          enrollmentType: (r.enrollmentType || 'Product') as string,
                          memberId: r.memberId,
                          rel: r.relationshipType,
                          householdId: r.householdId || '',
                          productBundleId: r.productBundleId || '',
                          productId: r.productId,
                          productLabel: formatProductLabel(r.productId, r.productBundleId || null),
                          effectiveDate: r.effectiveDate,
                          terminationDate: null as string | null,
                          premiumAmount: Number(r.premiumAmount || 0),
                          includedPaymentProcessingFeeAmount: Number(r.includedPaymentProcessingFeeAmount ?? r.IncludedPaymentProcessingFeeAmount ?? 0),
                          includedSystemFeeAmount: Number(r.includedSystemFeeAmount ?? r.IncludedSystemFeeAmount ?? 0),
                          employerContributionAmount: Number(r.employerContributionAmount || 0),
                          netRate: Number(r.netRate || 0),
                          overrideRate: Number(r.overrideRate || 0),
                          commission: Number(r.commission || 0),
                          enrollmentDetails: r.enrollmentDetails
                        }));

                        const createdFeeRows = (dryRunResult.feeEnrollmentsToCreate || []).map((f) => ({
                          kind: 'create' as const,
                          enrollmentType: f.enrollmentType,
                          memberId: f.memberId || '',
                          rel: '',
                          householdId: '',
                          productBundleId: '',
                          productId: '00000000-0000-0000-0000-000000000000',
                          productLabel: f.enrollmentType,
                          effectiveDate: f.effectiveDate || effectiveDate,
                          terminationDate: null as string | null,
                          premiumAmount: Number(f.premiumAmount || 0),
                          includedPaymentProcessingFeeAmount: 0,
                          includedSystemFeeAmount: 0,
                          employerContributionAmount: 0,
                          netRate: 0,
                          overrideRate: 0,
                          commission: 0,
                          enrollmentDetails: null as any
                        }));

                        const createdContributionRows = (dryRunResult.contributionEnrollmentsToCreate || []).map((c) => ({
                          kind: 'create' as const,
                          enrollmentType: 'Contribution',
                          memberId: c.memberId,
                          rel: 'P',
                          householdId: '',
                          productBundleId: '',
                          productId: '00000000-0000-0000-0000-000000000000',
                          productLabel: 'Contribution',
                          effectiveDate: c.effectiveDate || effectiveDate,
                          terminationDate: null as string | null,
                          premiumAmount: 0,
                          includedPaymentProcessingFeeAmount: 0,
                          includedSystemFeeAmount: 0,
                          employerContributionAmount: Number(c.employerContributionAmount || 0),
                          netRate: 0,
                          overrideRate: 0,
                          commission: 0,
                          enrollmentDetails: null as any
                        }));

                        const createdRowsAll = createdProductRows.concat(createdFeeRows).concat(createdContributionRows);

                        const terminateSorted = [...(dryRunResult.enrollmentsToTerminate || [])].sort((a, b) =>
                          String(a.enrollmentId).localeCompare(String(b.enrollmentId))
                        );
                        const effDateSorted = [...(dryRunResult.enrollmentsToUpdateEffectiveDate || [])].sort((a, b) =>
                          String(a.enrollmentId).localeCompare(String(b.enrollmentId))
                        );
                        const dependentRowCount =
                          terminateSorted.filter((r) => !isPrimaryEnrollmentPreviewRow(r)).length +
                          effDateSorted.filter((r) => !isPrimaryEnrollmentPreviewRow(r)).length +
                          createdRowsAll.filter((r) => !isPrimaryEnrollmentPreviewRow(r)).length;
                        const showPrimaryOnly = !showDependentEnrollmentPreview;
                        const terminateVisible = showPrimaryOnly
                          ? terminateSorted.filter((r) => isPrimaryEnrollmentPreviewRow(r))
                          : terminateSorted;
                        const effDateVisible = showPrimaryOnly
                          ? effDateSorted.filter((r) => isPrimaryEnrollmentPreviewRow(r))
                          : effDateSorted;
                        const createdVisible = showPrimaryOnly
                          ? createdRowsAll.filter((r) => isPrimaryEnrollmentPreviewRow(r))
                          : createdRowsAll;
                        const unifiedRowCount =
                          terminateVisible.length + effDateVisible.length + createdVisible.length;

                        return (
                          <div className="bg-white rounded-lg border border-gray-200">
                            <div className="p-6 border-b border-gray-200">
                              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                                <div>
                                  <h3 className="text-lg font-medium text-gray-900">Enrollment row changes</h3>
                                  <p className="text-sm text-gray-600">
                                    Primary member rows shown by default. Row background: terminate (red), effective date update (blue), new enrollment (green).
                                  </p>
                                </div>
                                {dependentRowCount > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => setShowDependentEnrollmentPreview((v) => !v)}
                                    className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
                                  >
                                    <ChevronDown
                                      className={`h-4 w-4 transition-transform ${showDependentEnrollmentPreview ? 'rotate-180' : ''}`}
                                    />
                                    {showDependentEnrollmentPreview
                                      ? 'Hide dependent rows'
                                      : `Show ${dependentRowCount} dependent row${dependentRowCount === 1 ? '' : 's'}`}
                                  </button>
                                )}
                              </div>
                              <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-700">
                                <span className="inline-flex items-center gap-2">
                                  <span className="inline-block w-3 h-3 rounded border border-red-300 bg-red-50" aria-hidden />
                                  Terminate
                                </span>
                                <span className="inline-flex items-center gap-2">
                                  <span className="inline-block w-3 h-3 rounded border border-blue-300 bg-blue-50" aria-hidden />
                                  Update effective date
                                </span>
                                <span className="inline-flex items-center gap-2">
                                  <span className="inline-block w-3 h-3 rounded border border-green-300 bg-green-50" aria-hidden />
                                  New row
                                </span>
                              </div>
                            </div>
                            <div className="p-6 overflow-auto">
                              <table className="min-w-[2200px] divide-y divide-gray-200 text-xs">
                                <thead className="bg-gray-50">
                                  <tr>
                                    <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide w-[120px]">Change</th>
                                    <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">EnrollmentId</th>
                                    <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">MemberId</th>
                                    <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">HouseholdId</th>
                                    <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">Rel</th>
                                    <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">EnrollmentType</th>
                                    <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">ProductBundleId</th>
                                    <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">ProductId</th>
                                    <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">Label</th>
                                    <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">EffectiveDate</th>
                                    <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">TerminationDate</th>
                                    <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">PremiumAmount</th>
                                    <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">IncludedPaymentProcessingFeeAmount</th>
                                    <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">IncludedSystemFeeAmount</th>
                                    <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">EmployerContributionAmount</th>
                                    <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">NetRate</th>
                                    <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">OverrideRate</th>
                                    <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">Commission</th>
                                    <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">EnrollmentDetails</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-200">
                                  {terminateVisible.map((r) => (
                                    <tr
                                      key={`term-${r.enrollmentId}`}
                                      className="bg-red-50 border-l-4 border-l-red-600"
                                    >
                                      <td className="px-3 py-2 font-medium text-red-800 whitespace-nowrap">Terminate</td>
                                      <td className="px-3 py-2 font-mono break-all text-gray-900">{r.enrollmentId}</td>
                                      <td className="px-3 py-2 font-mono break-all text-gray-900">{r.memberId}</td>
                                      <td className="px-3 py-2 font-mono break-all text-gray-600">{r.householdId || ''}</td>
                                      <td className="px-3 py-2 text-gray-900">{r.isDependentRow ? 'D' : 'P'}</td>
                                      <td className="px-3 py-2 font-mono text-gray-900">{r.enrollmentType || 'Product'}</td>
                                      <td className="px-3 py-2 font-mono break-all text-gray-600">{r.productBundleId || ''}</td>
                                      <td className="px-3 py-2 font-mono break-all text-gray-600">{r.productId}</td>
                                      <td className="px-3 py-2 text-gray-900">
                                        {r.enrollmentType && r.enrollmentType !== 'Product' && r.enrollmentType !== 'Bundle'
                                          ? r.enrollmentType
                                          : formatProductLabel(r.productId, r.productBundleId || null)}
                                      </td>
                                      <td className="px-3 py-2 font-mono text-gray-900">{r.existingEffectiveDate || ''}</td>
                                      <td className="px-3 py-2 font-mono text-red-900 font-medium">{r.terminationDate}</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(r.premiumAmount)}</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(r.includedPaymentProcessingFeeAmount || 0)}</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(r.includedSystemFeeAmount || 0)}</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(r.employerContributionAmount || 0)}</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(r.netRate || 0)}</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(r.overrideRate || 0)}</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(r.commission || 0)}</td>
                                      <td className="px-3 py-2 font-mono text-gray-600">
                                        <button
                                          type="button"
                                          onClick={() => setDetailsModal({ title: `EnrollmentDetails • ${r.enrollmentId}`, details: r.enrollmentDetails })}
                                          className="max-w-[520px] truncate text-left font-mono text-blue-600 hover:text-blue-700"
                                          title="Click to view full JSON"
                                        >
                                          {detailsPreview(r.enrollmentDetails) || '—'}
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                  {effDateVisible.map((r: any) => (
                                    <tr
                                      key={`eff-${r.enrollmentId}`}
                                      className="bg-blue-50 border-l-4 border-l-blue-600"
                                    >
                                      <td className="px-3 py-2 font-medium text-blue-800 whitespace-nowrap">Eff. date</td>
                                      <td className="px-3 py-2 font-mono break-all text-gray-900">{r.enrollmentId}</td>
                                      <td className="px-3 py-2 font-mono break-all text-gray-900">{r.memberId}</td>
                                      <td className="px-3 py-2 font-mono text-gray-400">—</td>
                                      <td className="px-3 py-2 text-gray-900">{r.isDependentRow ? 'D' : 'P'}</td>
                                      <td className="px-3 py-2 font-mono text-gray-900">{r.enrollmentType ?? 'Product'}</td>
                                      <td className="px-3 py-2 font-mono break-all text-gray-600">{r.productBundleId || ''}</td>
                                      <td className="px-3 py-2 font-mono break-all text-gray-600">{r.productId ?? '—'}</td>
                                      <td className="px-3 py-2 text-gray-900">
                                        {r.enrollmentType && r.enrollmentType !== 'Product' && r.enrollmentType !== 'Bundle'
                                          ? r.enrollmentType
                                          : formatProductLabel(r.productId || '', r.productBundleId || null)}
                                      </td>
                                      <td className="px-3 py-2 font-mono text-blue-900">
                                        <span className="text-gray-600">{r.currentEffectiveDate}</span>
                                        {' → '}
                                        <span className="font-medium">{r.newEffectiveDate}</span>
                                      </td>
                                      <td className="px-3 py-2 font-mono text-gray-400">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-400">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-400">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-400">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-400">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-400">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-400">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-400">—</td>
                                      <td className="px-3 py-2 font-mono text-gray-400">—</td>
                                    </tr>
                                  ))}
                                  {createdVisible.map((r, idx) => (
                                    <tr
                                      key={`new-${r.enrollmentType}-${r.memberId}-${r.productId}-${r.productBundleId || ''}-${idx}`}
                                      className="bg-green-50 border-l-4 border-l-green-600"
                                    >
                                      <td className="px-3 py-2 font-medium text-green-800 whitespace-nowrap">New</td>
                                      <td className="px-3 py-2 font-mono text-gray-500">(new)</td>
                                      <td className="px-3 py-2 font-mono break-all text-gray-900">{r.memberId}</td>
                                      <td className="px-3 py-2 font-mono break-all text-gray-600">{r.householdId || ''}</td>
                                      <td className="px-3 py-2 text-gray-900">{r.rel}</td>
                                      <td className="px-3 py-2 font-mono text-gray-900">{r.enrollmentType}</td>
                                      <td className="px-3 py-2 font-mono break-all text-gray-600">{r.productBundleId || ''}</td>
                                      <td className="px-3 py-2 font-mono break-all text-gray-600">{r.productId}</td>
                                      <td className="px-3 py-2 text-gray-900">{r.productLabel}</td>
                                      <td className="px-3 py-2 font-mono text-gray-900">{r.effectiveDate}</td>
                                      <td className="px-3 py-2 font-mono text-gray-400">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(r.premiumAmount)}</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(r.includedPaymentProcessingFeeAmount || 0)}</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(r.includedSystemFeeAmount || 0)}</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(r.employerContributionAmount)}</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(r.netRate || 0)}</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(r.overrideRate || 0)}</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(r.commission || 0)}</td>
                                      <td className="px-3 py-2 font-mono text-gray-600">
                                        <button
                                          type="button"
                                          onClick={() => setDetailsModal({ title: `EnrollmentDetails • (new) ${r.enrollmentType}`, details: r.enrollmentDetails })}
                                          className="max-w-[520px] truncate text-left font-mono text-blue-600 hover:text-blue-700"
                                          title="Click to view full JSON"
                                        >
                                          {detailsPreview(r.enrollmentDetails) || '—'}
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                  {unifiedRowCount === 0 && (
                                    <tr>
                                      <td className="px-3 py-3 text-gray-500" colSpan={19}>
                                        No enrollment rows will change.
                                      </td>
                                    </tr>
                                  )}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              );
              })()}

              <div className="flex justify-between gap-3 pt-2">
                <button
                  type="button"
                  onClick={goBack}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                >
                  <ChevronLeft className="h-4 w-4 mr-2" />
                  Back
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!canGoNext()}
                  className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Continue
                  <ChevronRight className="h-4 w-4 ml-2" />
                </button>
              </div>
            </div>
          )}

          {step.id === 'confirm' && (
            <div className="space-y-4">
              {applyError && (
                <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 text-sm">
                  {applyError}
                </div>
              )}
              {applyResult?.paidInvoiceAlignmentRemediation?.attempted && (
                <div className="bg-indigo-50 border border-indigo-200 text-indigo-900 rounded-lg p-4 text-sm">
                  <div className="font-medium">Paid invoice alignment</div>
                  <div className="mt-1 text-xs">
                    Updated {(applyResult.paidInvoiceAlignmentRemediation.updated || []).length}, skipped{' '}
                    {(applyResult.paidInvoiceAlignmentRemediation.skipped || []).length}.
                    {applyResult.paidInvoiceAlignmentRemediation.error && (
                      <span className="block mt-1 text-red-800">{applyResult.paidInvoiceAlignmentRemediation.error}</span>
                    )}
                  </div>
                </div>
              )}
              {applyResult && (
                <div
                  className={`rounded-lg p-4 text-sm border ${
                    hasDimeApplyWarning(applyResult, isGroupBilledForDime)
                      ? 'bg-yellow-50 border-yellow-200 text-yellow-800'
                      : 'bg-green-50 border-green-200 text-green-800'
                  }`}
                >
                  <div className="font-medium">
                    {hasDimeApplyWarning(applyResult, isGroupBilledForDime)
                      ? applyResult.dimeUpdate?.success === false
                        ? 'Applied with DIME warning'
                        : 'Applied — some old DIME schedule(s) could not be canceled'
                      : 'Applied successfully'}
                  </div>
                  {hasDimeApplyWarning(applyResult, isGroupBilledForDime) && (
                    <div className="mt-1">
                      {applyResult.dimeUpdate?.message ||
                        'Recurring payment update failed after database changes were saved.'}
                    </div>
                  )}
                  {hasDimeApplyWarning(applyResult, isGroupBilledForDime) &&
                    (applyResult.dimeUpdate?.details?.cancelFailures?.length ?? 0) > 0 && (
                    <ul className="mt-2 list-disc list-inside text-xs">
                      {applyResult.dimeUpdate.details.cancelFailures.map(
                        (f: { scheduleId: string; error: string }, i: number) => (
                          <li key={i}>
                            {f.scheduleId}: {f.error}
                          </li>
                        )
                      )}
                    </ul>
                  )}
                </div>
              )}
              <div className="bg-white rounded-lg border border-gray-200 p-6">
                <h3 className="text-lg font-medium text-gray-900 mb-2">Apply changes</h3>
                <p className="text-sm text-gray-600">
                  {isGroupBilledForDime ? (
                    <>
                      This saves enrollment changes only. Group-billed and list-bill members: <span className="font-medium text-gray-800">no</span> DIME recurring updates, <span className="font-medium text-gray-800">no</span> open-invoice re-total, and <span className="font-medium text-gray-800">no</span> automatic account credits from this wizard—handle recurring and credits manually if needed.
                    </>
                  ) : updateDimeRecurring ? (
                    Number(dryRunResult?.pricingSummary?.memberMonthlyDue ?? 0) > 0 ? (
                      <>
                        This saves enrollments, then <span className="font-medium text-gray-800">immediately</span> updates DIME: existing active recurring schedule(s) for this household are canceled and a new schedule is created for{' '}
                        <span className="font-medium text-gray-800">{formatCurrency(Number(dryRunResult?.pricingSummary?.memberMonthlyDue ?? 0))}</span>.
                      </>
                    ) : (
                      <>
                        This saves enrollments, then <span className="font-medium text-gray-800">immediately</span> updates DIME: existing active recurring schedule(s) are canceled and no new schedule is created because the new monthly due is $0.
                      </>
                    )
                  ) : (
                    <>
                      This saves enrollments only. DIME recurring payment is <span className="font-medium text-gray-800">not</span> changed because you turned off the auto-update option above.
                    </>
                  )}
                </p>
                <div className="mt-4 flex justify-between gap-3">
                  <button
                    type="button"
                    onClick={goBack}
                    className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                  >
                    <ChevronLeft className="h-4 w-4 mr-2" />
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleApply}
                    disabled={applyLoading || !dryRunResult || !confirmChecked || !!applyResult}
                    className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {applyLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    {applyResult ? 'Applied' : 'Apply changes'}
                  </button>
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={onCancel}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {detailsModal && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-200 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-lg font-medium text-gray-900 truncate">{detailsModal.title}</h3>
                <p className="text-sm text-gray-600">Full JSON</p>
              </div>
              <button
                type="button"
                onClick={() => setDetailsModal(null)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors"
                aria-label="Close"
              >
                <X className="h-6 w-6" />
              </button>
            </div>
            <div className="p-6 overflow-auto">
              <pre className="text-xs text-gray-900 whitespace-pre-wrap break-words font-mono">
                {normalizeDetailsJson(detailsModal.details).prettyText || '—'}
              </pre>
            </div>
            <div className="p-6 border-t border-gray-200 flex justify-end">
              <button
                type="button"
                onClick={() => setDetailsModal(null)}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


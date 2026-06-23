/** Full-screen wizard: bulk-migrate members to latest ProductPricing row for a product (tenant admin). */
import {
  AlertCircle,
  ArrowRightLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Heart,
  Loader2,
  User,
  UserCheck,
  X
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'react-hot-toast';
import MemberManagementModal from '../../members/MemberManagementModal';
import { apiService } from '../../../services/api.service';
import type { ApiResponse } from '../../../types/index';
import type { Member } from '../../../types/member.types';

export type MigrationCandidate = {
  memberId: string;
  householdId: string;
  memberTenantId?: string | null;
  groupId?: string | null;
  billType?: string | null;
  firstName: string;
  lastName: string;
  memberName: string;
  tierType: string;
  age: number;
  tobaccoUse: string;
  dependentCount: number;
  configValue1?: string | null;
  configValue2?: string | null;
  configValue3?: string | null;
  configValue4?: string | null;
  configValue5?: string | null;
  configurationLabel?: string | null;
  configurationDisplay?: string | null;
  enrollmentId: string;
  currentEnrollmentEffectiveDate: string;
  currentProductPricingId: string;
  currentPremium: number;
  currentIncludedProcessingFee: number;
  currentIncludedSystemFee?: number;
  currentProductAllIn: number;
  targetProductPricingId: string | null;
  targetPremiumMsrp: number | null;
  targetPricingEffectiveDate: string | null;
  newProductAllIn: number | null;
  newProductAllInWithFeeCap?: number | null;
  /** Included processing on this product row after migration (display rules; same value in keep-premium preview). */
  projectedIncludedProcessingFeeEngine?: number | null;
  projectedIncludedProcessingFeeFeeCap?: number | null;
  currentPaymentProcessingFeeEnrollment?: number | null;
  currentSystemFeeEnrollment?: number | null;
  projectedPaymentProcessingFeeEnrollmentEngine?: number | null;
  projectedPaymentProcessingFeeEnrollmentFeeCap?: number | null;
  nextMigrationEffectiveDate: string;
  householdTotalCurrent: number;
  householdTotalProjected: number | null;
  householdTotalProjectedWithFeeCap?: number | null;
  eligible: boolean;
  ineligibleReason: string | null;
};

type CandidatesPayload = {
  productId: string;
  productName: string;
  asOfDate: string;
  candidates: MigrationCandidate[];
  summary: {
    totalActive: number;
    eligible: number;
    alreadyOnLatest: number;
    ineligible: number;
    bundleProduct?: boolean;
  };
};

type ProductMigrationTenantsPayload = {
  tenants: { tenantId: string; name: string }[];
  canSelectMultipleTenants: boolean;
  defaultTenantIds: string[];
};

type DimeUpdateResult = {
  attempted?: boolean;
  success?: boolean;
  action?: string;
  message?: string;
};

type ApplyResultRow = {
  memberId: string;
  status: string;
  message?: string;
  newEnrollmentId?: string | null;
  /** Household monthly total (products + fees) before / after migration. */
  oldPremium?: number | null;
  newPremium?: number | null;
  /** Household payment-processing-fee enrollment total before / after migration. */
  oldFee?: number | null;
  newFee?: number | null;
  /** Migrated product's PremiumAmount before / after migration (single product, primary row). */
  oldProductPremium?: number | null;
  newProductPremium?: number | null;
  ineligibleReason?: string | null;
  /** Post-apply DIME recurring sync (when Step 2 "Update DIME recurring" is on). */
  dimeUpdate?: DimeUpdateResult;
};

function formatDimeRecurringReport(
  r: ApplyResultRow,
  updateDimeEnabled: boolean,
  billType?: string | null
): { short: string; detail?: string; className: string } {
  if (String(billType || '').toUpperCase() === 'LB') {
    return { short: 'N/A', detail: 'List-bill — individual DIME not updated here', className: 'text-gray-500' };
  }
  if (!updateDimeEnabled) {
    return { short: 'Off', detail: 'Update DIME recurring was not enabled in Step 2', className: 'text-gray-500' };
  }
  const d = r.dimeUpdate;
  if (!d) {
    return { short: '—', className: 'text-gray-400' };
  }
  if (!d.attempted) {
    return { short: 'Skipped', detail: d.message, className: 'text-gray-600' };
  }
  if (d.success) {
    return { short: 'Updated', detail: d.message, className: 'text-green-700 font-medium' };
  }
  return { short: 'Failed', detail: d.message, className: 'text-red-700 font-medium' };
}

interface EnrollmentRow {
  EnrollmentId: string;
  ProductName: string;
  ProductType: string;
  Status: string;
  EffectiveDate: string;
  TerminationDate?: string;
  Premium: number;
  PaymentFrequency: string;
}

const INELIGIBLE_HELP: Record<string, string> = {
  already_on_latest: 'Already on the latest pricing tier.',
  config_no_longer_offered: 'Configuration option is no longer available in active pricing.',
  age_out_of_range: "Member's age is not covered by any active rate for this tier.",
  tier_no_match: 'No active pricing exists for this coverage tier.',
  current_pricing_inactive_or_null: 'Enrollment is missing pricing or the pricing row is inactive.',
  bundle_product: 'Bundle products are not supported in this wizard yet.',
  not_eligible: 'Not eligible for migration.'
};

function formatCurrency(n: number) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getStatusColor(status: string) {
  switch (status) {
    case 'Active':
      return 'bg-green-100 text-green-800';
    case 'Pending':
      return 'bg-yellow-100 text-yellow-800';
    case 'Terminated':
      return 'bg-red-100 text-red-800';
    case 'Inactive':
      return 'bg-gray-100 text-gray-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

function getRelationshipIcon(relationshipType?: string) {
  switch (relationshipType) {
    case 'P':
      return <UserCheck className="h-4 w-4 text-blue-600" />;
    case 'S':
      return <Heart className="h-4 w-4 text-pink-600" />;
    case 'C':
      return <User className="h-4 w-4 text-gray-600" />;
    default:
      return <UserCheck className="h-4 w-4 text-blue-600" />;
  }
}

function getRelationshipColor(relationshipType?: string) {
  switch (relationshipType) {
    case 'P':
      return 'bg-blue-100 text-blue-800';
    case 'S':
      return 'bg-pink-100 text-pink-800';
    case 'C':
      return 'bg-gray-100 text-gray-800';
    default:
      return 'bg-blue-100 text-blue-800';
  }
}

function configLine(c: MigrationCandidate): string | null {
  const v =
    (c.configurationDisplay && String(c.configurationDisplay).trim()) ||
    [c.configValue1, c.configValue2, c.configValue3, c.configValue4, c.configValue5]
      .map((x) => (x != null ? String(x).trim() : ''))
      .find(Boolean);
  if (!v || v === 'Default') return null;
  const label = c.configurationLabel || 'Configuration';
  const num = Number(v);
  const display = Number.isFinite(num) && String(v) === String(num) ? formatCurrency(num) : v;
  return `${label}: ${display}`;
}

/** Lower row in Effective Date column: matches apply (UTC), overriding API next renewal when options demand it. */
function migrationEffectiveDateShown(
  c: MigrationCandidate,
  useCustomEffectiveDate: boolean,
  customEffectiveDate: string,
  useEnrollmentBillingDayCurrentMonth: boolean
): string {
  const custom = customEffectiveDate.trim().slice(0, 10);
  if (useCustomEffectiveDate && /^\d{4}-\d{2}-\d{2}$/.test(custom)) return custom;
  if (!useEnrollmentBillingDayCurrentMonth) return c.nextMigrationEffectiveDate;
  const head = (c.currentEnrollmentEffectiveDate || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) return c.nextMigrationEffectiveDate;
  const [y0, mo0, da0] = head.split('-').map((x) => Number(x));
  const anchor = new Date(Date.UTC(y0, mo0 - 1, da0));
  if (
    anchor.getUTCFullYear() !== y0 ||
    anchor.getUTCMonth() !== mo0 - 1 ||
    anchor.getUTCDate() !== da0
  ) {
    return c.nextMigrationEffectiveDate;
  }
  const day = anchor.getUTCDate();
  const refDate = new Date();
  const y = refDate.getUTCFullYear();
  const m = refDate.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = Math.min(day, lastDay);
  return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
}

/** Client HTTP timeout for migration preview + apply (backend/socket allow ~60m). */
const MIGRATION_REQUEST_TIMEOUT_MS = 45 * 60 * 1000;

function MigrationLongRunNotice({ phase }: { phase: 'preview' | 'apply' }) {
  const title = phase === 'preview' ? 'Building member preview…' : 'Applying migration…';
  const detail =
    phase === 'preview'
      ? 'Pricing and fee preview runs per member. Large tenant lists can take up to 45 minutes.'
      : 'Each selected member is migrated in sequence. Large batches can take up to 45 minutes.';
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 max-w-2xl">
      <div className="flex items-start gap-3">
        <Loader2 className="w-6 h-6 animate-spin text-amber-800 shrink-0 mt-0.5" aria-hidden />
        <div>
          <p className="font-medium text-amber-950">{title}</p>
          <p className="text-sm text-amber-900 mt-1.5 leading-relaxed">{detail}</p>
          <p className="text-sm text-amber-900 mt-2 font-medium">
            Do not close this tab or navigate away until the {phase === 'preview' ? 'table' : 'results'} finish
            loading.
          </p>
        </div>
      </div>
    </div>
  );
}

type Props = {
  isOpen: boolean;
  onClose: () => void;
  /** Non-bundle products (filtered list from parent). */
  products: any[];
};

const ProductMigrationWizard: React.FC<Props> = ({ isOpen, onClose, products }) => {
  const [step, setStep] = useState(1);
  const [pickSearch, setPickSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);

  const [useProcessingFeeToKeepPremium, setUseProcessingFeeToKeepPremium] = useState(false);
  const [updateDimeRecurring, setUpdateDimeRecurring] = useState(true);
  const [useCustomEffectiveDate, setUseCustomEffectiveDate] = useState(false);
  const [customEffectiveDate, setCustomEffectiveDate] = useState('');
  const [useEnrollmentBillingDayCurrentMonth, setUseEnrollmentBillingDayCurrentMonth] = useState(false);

  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesPayload, setCandidatesPayload] = useState<CandidatesPayload | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);

  const [migrationTenants, setMigrationTenants] = useState<ProductMigrationTenantsPayload | null>(null);
  const [migrationTenantsLoading, setMigrationTenantsLoading] = useState(false);
  const [migrationTenantsError, setMigrationTenantsError] = useState<string | null>(null);
  /** Member-data tenants to include (server validates). Default all for owners. */
  const [selectedTenantIds, setSelectedTenantIds] = useState<string[]>([]);
  const [tenantDropdownOpen, setTenantDropdownOpen] = useState(false);
  const tenantDropdownRef = useRef<HTMLDivElement>(null);

  const [selectedEligibleIds, setSelectedEligibleIds] = useState<Set<string>>(new Set());
  const masterRef = useRef<HTMLInputElement>(null);

  const [applyLoading, setApplyLoading] = useState(false);
  const [applyResults, setApplyResults] = useState<ApplyResultRow[] | null>(null);
  const [applySummary, setApplySummary] = useState<{ success: number; skipped: number; failed: number } | null>(null);

  const [memberModalMember, setMemberModalMember] = useState<Member | null>(null);
  const [memberModalHousehold, setMemberModalHousehold] = useState<Member[]>([]);
  const [memberModalEnrollments, setMemberModalEnrollments] = useState<EnrollmentRow[]>([]);
  const [memberModalLoading, setMemberModalLoading] = useState(false);

  const eligibleList = useMemo(
    () => (candidatesPayload?.candidates || []).filter((c) => c.eligible),
    [candidatesPayload]
  );

  const ineligibleList = useMemo(
    () => (candidatesPayload?.candidates || []).filter((c) => !c.eligible),
    [candidatesPayload]
  );

  const resetWizard = () => {
    setStep(1);
    setPickSearch('');
    setSelectedProductId(null);
    setUseProcessingFeeToKeepPremium(false);
    setUpdateDimeRecurring(true);
    setUseCustomEffectiveDate(false);
    setCustomEffectiveDate('');
    setUseEnrollmentBillingDayCurrentMonth(false);
    setCandidatesLoading(false);
    setCandidatesPayload(null);
    setCandidatesError(null);
    setSelectedEligibleIds(new Set());
    setApplyLoading(false);
    setApplyResults(null);
    setApplySummary(null);
    setMemberModalMember(null);
    setMemberModalHousehold([]);
    setMemberModalEnrollments([]);
    setMemberModalLoading(false);
    setMigrationTenants(null);
    setMigrationTenantsLoading(false);
    setMigrationTenantsError(null);
    setSelectedTenantIds([]);
    setTenantDropdownOpen(false);
  };

  useEffect(() => {
    if (!isOpen) resetWizard();
  }, [isOpen]);

  useEffect(() => {
    if (step !== 2) setTenantDropdownOpen(false);
  }, [step]);

  useEffect(() => {
    if (!tenantDropdownOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = tenantDropdownRef.current;
      if (el && !el.contains(e.target as Node)) setTenantDropdownOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [tenantDropdownOpen]);

  useEffect(() => {
    setCandidatesPayload(null);
    setCandidatesError(null);
    setSelectedEligibleIds(new Set());
    setMigrationTenants(null);
    setMigrationTenantsError(null);
    setSelectedTenantIds([]);
    setUseCustomEffectiveDate(false);
    setCustomEffectiveDate('');
    setUseEnrollmentBillingDayCurrentMonth(false);
  }, [selectedProductId]);

  const loadMigrationTenants = useCallback(async () => {
    if (!selectedProductId) return;
    setMigrationTenantsLoading(true);
    setMigrationTenantsError(null);
    try {
      const res = await apiService.get<ApiResponse<ProductMigrationTenantsPayload>>(
        `/api/me/tenant-admin/product-migrations/${selectedProductId}/tenants`
      );
      if (!res.success || !res.data) {
        throw new Error((res as any)?.message || 'Failed to load tenant scope');
      }
      setMigrationTenants(res.data);
      setSelectedTenantIds([...(res.data.defaultTenantIds || [])]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load tenant scope';
      setMigrationTenantsError(msg);
      setMigrationTenants(null);
      setSelectedTenantIds([]);
    } finally {
      setMigrationTenantsLoading(false);
    }
  }, [selectedProductId]);

  useEffect(() => {
    if (selectedProductId) {
      void loadMigrationTenants();
    }
  }, [selectedProductId, loadMigrationTenants]);

  const filteredProducts = useMemo(() => {
    const q = pickSearch.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => {
      const name = String(p.Name || p.name || '').toLowerCase();
      const pid = String(p.ProductId || p.productId || '').toLowerCase();
      return name.includes(q) || pid.includes(q);
    });
  }, [products, pickSearch]);

  const selectedTenantKey = useMemo(() => [...selectedTenantIds].sort().join('|'), [selectedTenantIds]);

  const tenantDropdownButtonLabel = useMemo(() => {
    if (!migrationTenants?.tenants?.length) return 'Select tenants…';
    if (!migrationTenants.canSelectMultipleTenants) {
      const t = migrationTenants.tenants[0];
      return t?.name || t?.tenantId || 'Current tenant';
    }
    const n = selectedTenantIds.length;
    const total = migrationTenants.tenants.length;
    if (n === 0) return 'Select tenants…';
    if (n === total) return `All tenants (${total})`;
    const names = migrationTenants.tenants
      .filter((t) => selectedTenantIds.includes(t.tenantId))
      .map((t) => t.name || t.tenantId);
    if (names.length <= 2) return names.join(', ');
    return `${names.slice(0, 2).join(', ')} +${n - 2} more`;
  }, [migrationTenants, selectedTenantIds]);

  const loadCandidates = useCallback(async () => {
    if (!selectedProductId || selectedTenantIds.length === 0) return;
    setCandidatesLoading(true);
    setCandidatesError(null);
    setCandidatesPayload(null);
    setSelectedEligibleIds(new Set());
    try {
      const tenantQs = encodeURIComponent(selectedTenantIds.join(','));
      const res = await apiService.get<ApiResponse<CandidatesPayload>>(
        `/api/me/tenant-admin/product-migrations/${selectedProductId}/candidates?tenantIds=${tenantQs}`,
        { timeout: MIGRATION_REQUEST_TIMEOUT_MS }
      );
      if (!res.success || !res.data) {
        throw new Error((res as any)?.message || 'Failed to load members');
      }
      setCandidatesPayload(res.data);
      const elig = (res.data.candidates || []).filter((c) => c.eligible).map((c) => c.memberId);
      setSelectedEligibleIds(new Set(elig));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load members';
      setCandidatesError(msg);
      toast.error(msg);
    } finally {
      setCandidatesLoading(false);
    }
  }, [selectedProductId, selectedTenantIds]);

  useEffect(() => {
    // Load eligible members only after tenant scope is chosen (step 3 — preview).
    if (step === 3 && selectedProductId && selectedTenantIds.length > 0 && !migrationTenantsLoading) {
      void loadCandidates();
    }
  }, [step, selectedProductId, selectedTenantKey, migrationTenantsLoading, loadCandidates]);

  const selectedCount = useMemo(() => {
    let n = 0;
    for (const id of selectedEligibleIds) {
      if (eligibleList.some((c) => c.memberId === id)) n += 1;
    }
    return n;
  }, [selectedEligibleIds, eligibleList]);

  const masterChecked = eligibleList.length > 0 && selectedCount === eligibleList.length;
  const masterIndeterminate = selectedCount > 0 && selectedCount < eligibleList.length;

  useEffect(() => {
    const el = masterRef.current;
    if (el) el.indeterminate = masterIndeterminate;
  }, [masterIndeterminate]);

  const migrationInProgress = candidatesLoading || applyLoading;
  useEffect(() => {
    if (!migrationInProgress) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [migrationInProgress]);

  const toggleAllEligible = () => {
    if (eligibleList.length === 0) return;
    if (masterChecked) {
      setSelectedEligibleIds(new Set());
    } else {
      setSelectedEligibleIds(new Set(eligibleList.map((c) => c.memberId)));
    }
  };

  const toggleOne = (memberId: string) => {
    const next = new Set(selectedEligibleIds);
    if (next.has(memberId)) next.delete(memberId);
    else next.add(memberId);
    setSelectedEligibleIds(next);
  };

  const projectedHouseholdTotalForPreview = (c: MigrationCandidate) => {
    if (useProcessingFeeToKeepPremium && c.householdTotalProjectedWithFeeCap != null) {
      return c.householdTotalProjectedWithFeeCap;
    }
    return c.householdTotalProjected;
  };

  /** Household PaymentProcessingFee enrollment (keep-premium may lower projected PPF only). */
  const projectedProcessingFeeTotalForPreview = (c: MigrationCandidate) => {
    if (useProcessingFeeToKeepPremium && c.projectedPaymentProcessingFeeEnrollmentFeeCap != null) {
      return c.projectedPaymentProcessingFeeEnrollmentFeeCap;
    }
    return c.projectedPaymentProcessingFeeEnrollmentEngine ?? c.currentPaymentProcessingFeeEnrollment ?? 0;
  };

  /** Display-only round-up on migrated product row (plan UI), not part of PPF or keep-premium math. */
  const projectedIncludedProcessingOnProductForPreview = (c: MigrationCandidate) => {
    if (useProcessingFeeToKeepPremium && c.projectedIncludedProcessingFeeFeeCap != null) {
      return c.projectedIncludedProcessingFeeFeeCap;
    }
    if (c.projectedIncludedProcessingFeeEngine != null) return c.projectedIncludedProcessingFeeEngine;
    return c.currentIncludedProcessingFee ?? 0;
  };

  const openMemberModal = async (memberId: string) => {
    setMemberModalLoading(true);
    setMemberModalMember(null);
    try {
      const householdRes = await apiService.get<{ success: boolean; data: { member: Member; householdMembers: Member[] } }>(
        `/api/members/${memberId}/with-household`
      );
      let member: Member | null = null;
      let household: Member[] = [];
      if (householdRes.success && householdRes.data) {
        member = householdRes.data.member;
        household = householdRes.data.householdMembers || [];
      }
      const [activeRes, pendingRes] = await Promise.all([
        apiService.get<{ success: boolean; data: EnrollmentRow[] }>(`/api/enrollments?memberId=${memberId}&status=Active`),
        apiService.get<{ success: boolean; data: EnrollmentRow[] }>(`/api/enrollments?memberId=${memberId}&status=Pending`)
      ]);
      const active = activeRes.success ? activeRes.data || [] : [];
      const pending = pendingRes.success ? pendingRes.data || [] : [];
      const combined = [...active, ...pending];
      const unique = combined.filter(
        (e, i, self) =>
          self.findIndex((x) => (x.EnrollmentId || (x as any).enrollmentId) === (e.EnrollmentId || (e as any).enrollmentId)) === i
      );
      if (!member) throw new Error('Member not found');
      setMemberModalHousehold(household);
      setMemberModalEnrollments(unique);
      setMemberModalMember(member);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to open member');
      setMemberModalMember(null);
      setMemberModalHousehold([]);
      setMemberModalEnrollments([]);
    } finally {
      setMemberModalLoading(false);
    }
  };

  const runApply = async () => {
    if (!selectedProductId || selectedCount === 0 || selectedTenantIds.length === 0) return;
    if (useCustomEffectiveDate && !customEffectiveDate.trim()) {
      toast.error('Choose a custom effective date or turn off the override.');
      return;
    }
    setApplyLoading(true);
    setApplyResults(null);
    setApplySummary(null);
    try {
      const ids = eligibleList.filter((c) => selectedEligibleIds.has(c.memberId)).map((c) => c.memberId);
      const res = await apiService.post<
        ApiResponse<{ results: ApplyResultRow[]; summary: { success: number; skipped: number; failed: number } }>
      >(
        `/api/me/tenant-admin/product-migrations/${selectedProductId}/apply`,
        {
          memberIds: ids,
          tenantIds: selectedTenantIds,
          settings: {
            useProcessingFeeToKeepPremium,
            updateDimeRecurring,
            ...(useCustomEffectiveDate && customEffectiveDate.trim()
              ? { customEffectiveDate: customEffectiveDate.trim() }
              : useEnrollmentBillingDayCurrentMonth
                ? { useEnrollmentBillingDayCurrentMonth: true }
                : {})
          }
        },
        { timeout: MIGRATION_REQUEST_TIMEOUT_MS }
      );
      if (!res.success || !res.data) {
        throw new Error((res as any)?.message || 'Migration failed');
      }
      setApplyResults(res.data.results || []);
      setApplySummary(res.data.summary || null);
      setStep(5);
      toast.success('Migration run completed');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Migration failed');
    } finally {
      setApplyLoading(false);
    }
  };

  const handleClose = () => {
    onClose();
  };

  const summary = candidatesPayload?.summary;

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-[2147483647]">
      <div className="bg-white rounded-lg w-full max-w-[90rem] h-[90vh] max-h-[90vh] overflow-hidden shadow-2xl flex flex-col mt-8">
        <div className="flex justify-between items-center p-3 border-b border-gray-200 bg-gradient-to-r from-oe-primary to-oe-dark">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <ArrowRightLeft className="w-5 h-5" />
            Migrate Members — pricing tier
          </h2>
          <button
            type="button"
            onClick={handleClose}
            disabled={migrationInProgress}
            title={migrationInProgress ? 'Wait for preview or apply to finish' : 'Close'}
            className="text-white hover:bg-white hover:bg-opacity-20 p-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4 pt-3 pb-2 border-b border-gray-100 flex items-center gap-2 text-sm text-gray-600 flex-wrap">
          {[1, 2, 3, 4, 5].map((s) => (
            <React.Fragment key={s}>
              <span
                className={`font-medium ${step === s ? 'text-oe-primary' : step > s ? 'text-green-600' : 'text-gray-400'}`}
              >{`Step ${s}`}</span>
              {s < 5 && <ChevronRight className="w-4 h-4 text-gray-300" />}
            </React.Fragment>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {step === 1 && (
            <div className="space-y-4">
              <p className="text-gray-700">Choose a product to migrate members to its latest active pricing tier.</p>
              <input
                type="text"
                placeholder="Search products..."
                value={pickSearch}
                onChange={(e) => setPickSearch(e.target.value)}
                className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg"
              />
              <div className="border border-gray-200 rounded-lg max-h-[50vh] overflow-y-auto divide-y divide-gray-100 bg-white">
                {filteredProducts.map((p) => {
                  const pid = p.ProductId || p.productId;
                  const name = p.Name || p.name || '(unnamed)';
                  const active = selectedProductId === pid;
                  return (
                    <button
                      type="button"
                      key={pid}
                      onClick={() => setSelectedProductId(pid)}
                      className={`w-full text-left px-4 py-3 transition-all ${
                        active
                          ? 'bg-blue-50 border-l-4 border-l-oe-primary ring-2 ring-inset ring-oe-primary/40'
                          : 'border-l-4 border-l-transparent hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className={`font-medium ${active ? 'text-oe-primary' : 'text-gray-900'}`}>{name}</div>
                          <div className="text-xs text-gray-500 font-mono truncate">{pid}</div>
                          {active && <div className="text-xs font-medium text-oe-primary mt-1">Selected</div>}
                        </div>
                        {active ? (
                          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-oe-primary text-white shadow-sm" aria-hidden>
                            <Check className="h-4 w-4" />
                          </span>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
                {filteredProducts.length === 0 && <div className="p-6 text-gray-500">No products match.</div>}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6 max-w-2xl">
              <div>
                {migrationTenantsLoading && (
                  <div className="flex items-center gap-2 text-gray-600 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading tenant scope…
                  </div>
                )}
                {migrationTenantsError && (
                  <div className="flex items-center gap-2 text-red-600 text-sm">
                    <AlertCircle className="w-4 h-4" /> {migrationTenantsError}
                  </div>
                )}
                {migrationTenants && !migrationTenantsLoading && (
                  <div className="mt-3">
                    <div className="text-sm font-medium text-gray-800 mb-1">Include members from tenants</div>
                    {migrationTenants.canSelectMultipleTenants ? (
                      <div ref={tenantDropdownRef} className="relative w-full max-w-md">
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-left text-sm text-gray-900 shadow-sm hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-oe-primary/30"
                          aria-expanded={tenantDropdownOpen}
                          aria-haspopup="listbox"
                          onClick={() => setTenantDropdownOpen((o) => !o)}
                        >
                          <span className="truncate">{tenantDropdownButtonLabel}</span>
                          <ChevronDown className={`h-4 w-4 shrink-0 text-gray-500 transition-transform ${tenantDropdownOpen ? 'rotate-180' : ''}`} />
                        </button>
                        {tenantDropdownOpen && (
                          <div
                            className="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
                            role="listbox"
                            aria-multiselectable="true"
                          >
                            <div className="flex flex-wrap gap-2 border-b border-gray-100 px-2 py-2">
                              <button
                                type="button"
                                className="text-xs font-medium text-oe-primary hover:underline"
                                onClick={() => {
                                  setSelectedTenantIds(migrationTenants.tenants.map((t) => t.tenantId));
                                  setCandidatesPayload(null);
                                }}
                              >
                                Select all
                              </button>
                              <button
                                type="button"
                                className="text-xs font-medium text-gray-600 hover:underline"
                                onClick={() => {
                                  setSelectedTenantIds([]);
                                  setCandidatesPayload(null);
                                }}
                              >
                                Clear
                              </button>
                            </div>
                            <ul className="py-1">
                              {migrationTenants.tenants.map((t) => (
                                <li key={t.tenantId} role="option" aria-selected={selectedTenantIds.includes(t.tenantId)}>
                                  <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50">
                                    <input
                                      type="checkbox"
                                      className="rounded border-gray-300"
                                      checked={selectedTenantIds.includes(t.tenantId)}
                                      onChange={() => {
                                        setSelectedTenantIds((prev) => {
                                          const has = prev.includes(t.tenantId);
                                          if (has) return prev.filter((x) => x !== t.tenantId);
                                          return [...prev, t.tenantId];
                                        });
                                        setCandidatesPayload(null);
                                      }}
                                    />
                                    <span className="text-gray-800">{t.name || t.tenantId}</span>
                                  </label>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <p className="text-xs text-gray-500 mt-1.5">
                          Changing selection clears the member preview until you open that step again.
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-800">
                        {migrationTenants.tenants[0]?.name || 'Current tenant'}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-4 border-t border-gray-100 pt-6">
                <p className="text-sm text-gray-600">
                  {useCustomEffectiveDate && customEffectiveDate.trim()
                    ? `Apply will use ${customEffectiveDate} as the plan-change effective date for every selected member (overlapping household enrollments terminate the prior calendar day).`
                    : useEnrollmentBillingDayCurrentMonth
                      ? 'Apply backdates to each member’s enrollment cycle day in the current month (UTC), not the next renewal.'
                      : 'Effective/billing dates follow each member’s normal next renewal unless you choose an override below.'}
                </p>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={useProcessingFeeToKeepPremium}
                    onChange={(e) => setUseProcessingFeeToKeepPremium(e.target.checked)}
                  />
                  <span>
                    Use processing fee to keep your current household total when possible (only lowers the payment processing
                    fee enrollment if the new total would exceed today&apos;s—never raises fees when the new total is lower).
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={updateDimeRecurring}
                    onChange={(e) => setUpdateDimeRecurring(e.target.checked)}
                  />
                  <span>Update DIME recurring for individual / non–group-billed members after migration.</span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer rounded-md border border-slate-200 bg-slate-50/80 px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={useEnrollmentBillingDayCurrentMonth}
                    disabled={useCustomEffectiveDate}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setUseEnrollmentBillingDayCurrentMonth(on);
                      if (on) {
                        setUseCustomEffectiveDate(false);
                        setCustomEffectiveDate('');
                      }
                    }}
                  />
                  <span>
                    <span className="font-medium text-gray-900">Backdate effective date to last enrollment cycle date</span>
                    <span className="block text-xs text-gray-600 mt-1 leading-relaxed">
                      Uses this product enrollment’s day-of-month in the current month (UTC). Exclusive with custom date.
                    </span>
                  </span>
                </label>
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-2">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={useCustomEffectiveDate}
                      disabled={useEnrollmentBillingDayCurrentMonth}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setUseCustomEffectiveDate(on);
                        if (on) setUseEnrollmentBillingDayCurrentMonth(false);
                        if (!on) setCustomEffectiveDate('');
                      }}
                    />
                    <span className="font-medium text-amber-950">
                      Custom effective date (dangerous — not recommended)
                    </span>
                  </label>
                  <p className="text-xs text-amber-900/90 leading-relaxed pl-6">
                    Forces the plan modification’s effective date for all selected members. Active household product, fee,
                    and contribution rows that overlap that date are terminated on the day before, then recreated by this
                    migration where applicable. Only use when you understand replacement termination for the whole household.
                  </p>
                  {useCustomEffectiveDate && (
                    <div className="pl-6 pt-1">
                      <label className="block text-xs font-medium text-gray-700 mb-1">Effective date (YYYY-MM-DD)</label>
                      <input
                        type="date"
                        className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                        value={customEffectiveDate}
                        onChange={(e) => setCustomEffectiveDate(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              {candidatesLoading && <MigrationLongRunNotice phase="preview" />}
              {!candidatesLoading && !candidatesPayload && !candidatesError && (
                <p className="text-sm text-gray-600 max-w-2xl">
                  Preview loads automatically. Large lists may take up to <strong>45 minutes</strong> — keep this tab open.
                </p>
              )}
              {candidatesError && (
                <div className="flex items-center gap-2 text-red-600 text-sm">
                  <AlertCircle className="w-4 h-4" /> {candidatesError}
                </div>
              )}
              {!candidatesLoading && summary && (
                <div className="flex flex-wrap gap-2 text-sm">
                  <span className="px-2 py-1 rounded-full bg-green-100 text-green-800">{summary.eligible} eligible</span>
                  <span className="px-2 py-1 rounded-full bg-gray-100 text-gray-800">{summary.alreadyOnLatest} already latest</span>
                  <span className="px-2 py-1 rounded-full bg-amber-100 text-amber-900">{summary.ineligible} ineligible</span>
                  {summary.bundleProduct && (
                    <span className="px-2 py-1 rounded-full bg-red-100 text-red-800">Bundle product — not supported</span>
                  )}
                </div>
              )}
              {!candidatesLoading && (
                <p className="text-sm font-medium text-gray-800">
                  Selected: {selectedCount} of {eligibleList.length} eligible
                </p>
              )}
              {!candidatesLoading && (
                <div className="text-xs text-gray-600 max-w-4xl space-y-1.5 leading-snug">
                  <p>
                    <strong>Premium</strong> = household monthly bill (premiums + system fee + PPF).{' '}
                    <strong>Processing fee</strong> = PPF enrollment only.{' '}
                    <strong>Incl. processing</strong> = display round-up on the migrated product (plan UI only; not added to premium or PPF).
                  </p>
                  <p>
                    <span className="text-green-600 font-medium">Green</span> = higher $ ·{' '}
                    <span className="text-red-600 font-medium">Red</span> = lower $ · Black = no change.
                  </p>
                  {useProcessingFeeToKeepPremium && (
                    <p>
                      <strong>Keep premium</strong> is on: if the new household total would go <em>above</em> today&apos;s, PPF is lowered until it matches (or as close as possible). If the new total is already lower, we do not raise fees.
                    </p>
                  )}
                  <p className="text-gray-500">
                    Effective dates follow Step 2 (UTC).
                  </p>
                </div>
              )}
              {!candidatesLoading && eligibleList.length > 0 && (
                <div className="overflow-x-auto border border-gray-200 rounded-lg">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                      <tr>
                        <th className="px-2 py-2 w-10">
                          <input
                            ref={masterRef}
                            type="checkbox"
                            checked={masterChecked}
                            onChange={toggleAllEligible}
                            aria-label="Select all eligible"
                          />
                        </th>
                        <th className="px-2 py-2">Member</th>
                        <th className="px-2 py-2">Tier</th>
                        <th className="px-2 py-2">Age</th>
                        <th className="px-2 py-2">Tobacco</th>
                        <th className="px-2 py-2">Deps</th>
                        <th className="px-2 py-2">Config</th>
                        <th className="px-2 py-2">
                          <span className="block">Effective Date</span>
                          <span className="block text-[10px] font-normal normal-case text-gray-500">
                            Current / migration
                          </span>
                        </th>
                        <th className="px-2 py-2">
                          <span className="block">New Tier Eff.</span>
                          <span className="block text-[10px] font-normal normal-case text-gray-500">Latest pricing row</span>
                        </th>
                        <th className="px-2 py-2 text-right">
                          <span className="block">Current Premium</span>
                          <span className="block text-[10px] font-normal normal-case text-gray-500">Household total w/ fees</span>
                        </th>
                        <th className="px-2 py-2 text-right">
                          <span className="block">New Premium</span>
                          <span className="block text-[10px] font-normal normal-case text-gray-500">Household total w/ fees</span>
                        </th>
                        <th className="px-2 py-2 text-right">
                          <span className="block">Current incl. processing</span>
                          <span className="block text-[10px] font-normal normal-case text-gray-500">Display on plan only</span>
                        </th>
                        <th className="px-2 py-2 text-right">
                          <span className="block">New incl. processing</span>
                          <span className="block text-[10px] font-normal normal-case text-gray-500">Display on plan only</span>
                        </th>
                        <th className="px-2 py-2 text-right">
                          <span className="block">Current processing fee</span>
                          <span className="block text-[10px] font-normal normal-case text-gray-500">PPF enrollment</span>
                        </th>
                        <th className="px-2 py-2 text-right">
                          <span className="block">New processing fee</span>
                          <span className="block text-[10px] font-normal normal-case text-gray-500">PPF enrollment</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {eligibleList.map((c) => {
                        const hhProjected = projectedHouseholdTotalForPreview(c);
                        const curTotal = Number(c.householdTotalCurrent || 0);
                        const hhDelta =
                          hhProjected != null ? Math.round((hhProjected - curTotal) * 100) / 100 : null;
                        /** User request: green = increase, red = decrease, black = no change. */
                        const newPremiumClass =
                          hhDelta == null || hhDelta === 0
                            ? 'text-gray-900'
                            : hhDelta > 0
                              ? 'text-green-600 font-medium'
                              : 'text-red-600 font-medium';
                        const curProcTotal = Number(c.currentPaymentProcessingFeeEnrollment ?? 0);
                        const newProcTotal = projectedProcessingFeeTotalForPreview(c);
                        const procDelta =
                          newProcTotal != null
                            ? Math.round((Number(newProcTotal) - curProcTotal) * 100) / 100
                            : null;
                        const newProcClass =
                          procDelta == null || procDelta === 0
                            ? 'text-gray-900'
                            : procDelta > 0
                              ? 'text-green-600 font-medium'
                              : 'text-red-600 font-medium';
                        const curInc = Number(c.currentIncludedProcessingFee ?? 0);
                        const newInc = projectedIncludedProcessingOnProductForPreview(c);
                        const incDelta = Math.round((Number(newInc) - curInc) * 100) / 100;
                        const newIncClass =
                          incDelta === 0 ? 'text-gray-900' : incDelta > 0 ? 'text-green-600 font-medium' : 'text-red-600 font-medium';
                        const line = configLine(c);
                        return (
                          <tr key={c.memberId} className="hover:bg-gray-50">
                            <td className="px-2 py-2">
                              <input
                                type="checkbox"
                                checked={selectedEligibleIds.has(c.memberId)}
                                onChange={() => toggleOne(c.memberId)}
                              />
                            </td>
                            <td className="px-2 py-2">
                              <button
                                type="button"
                                className="text-oe-primary hover:underline font-medium text-left"
                                onClick={() => void openMemberModal(c.memberId)}
                              >
                                {c.memberName || `${c.firstName} ${c.lastName}`}
                              </button>
                            </td>
                            <td className="px-2 py-2">{c.tierType}</td>
                            <td className="px-2 py-2">{c.age}</td>
                            <td className="px-2 py-2">{c.tobaccoUse}</td>
                            <td className="px-2 py-2">{c.dependentCount}</td>
                            <td className="px-2 py-2 text-gray-700 max-w-[12rem] truncate" title={line || ''}>
                              {line || '—'}
                            </td>
                            <td className="px-2 py-2 text-xs">
                              <div className="text-gray-600">{c.currentEnrollmentEffectiveDate}</div>
                              <div>
                                {migrationEffectiveDateShown(
                                  c,
                                  useCustomEffectiveDate,
                                  customEffectiveDate,
                                  useEnrollmentBillingDayCurrentMonth
                                )}
                              </div>
                            </td>
                            <td className="px-2 py-2 text-xs text-gray-700" title={c.targetProductPricingId || ''}>
                              {c.targetPricingEffectiveDate || '—'}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums text-xs text-gray-900">
                              {formatCurrency(curTotal)}
                            </td>
                            <td className={`px-2 py-2 text-right tabular-nums text-xs ${newPremiumClass}`}>
                              {hhProjected != null ? formatCurrency(hhProjected) : '—'}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums text-xs text-gray-900">{formatCurrency(curInc)}</td>
                            <td className={`px-2 py-2 text-right tabular-nums text-xs ${newIncClass}`}>{formatCurrency(newInc)}</td>
                            <td className="px-2 py-2 text-right tabular-nums text-xs text-gray-900">
                              {c.currentPaymentProcessingFeeEnrollment != null
                                ? formatCurrency(c.currentPaymentProcessingFeeEnrollment)
                                : '—'}
                            </td>
                            <td className={`px-2 py-2 text-right tabular-nums text-xs ${newProcClass}`}>
                              {newProcTotal != null ? formatCurrency(newProcTotal) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {!candidatesLoading && ineligibleList.length > 0 && (
                <div className="mt-6">
                  <h3 className="font-semibold text-gray-800 mb-2">Not eligible ({ineligibleList.length})</h3>
                  <ul className="text-sm space-y-1 max-h-40 overflow-y-auto border border-gray-100 rounded p-2 bg-gray-50">
                    {ineligibleList.map((c) => (
                      <li key={c.memberId} className="flex justify-between gap-4">
                        <button
                          type="button"
                          className="text-oe-primary hover:underline text-left"
                          onClick={() => void openMemberModal(c.memberId)}
                        >
                          {c.memberName}
                        </button>
                        <span className="text-gray-600 text-right">
                          {c.ineligibleReason ? INELIGIBLE_HELP[c.ineligibleReason] || c.ineligibleReason : '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4 max-w-xl">
              <p className="text-lg font-semibold text-gray-900">
                Migrating {selectedCount} of {eligibleList.length} eligible member
                {eligibleList.length === 1 ? '' : 's'}
                {candidatesPayload?.productName ? ` for ${candidatesPayload.productName}` : ''}.
              </p>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 leading-relaxed">
                <p className="font-medium text-amber-950">This step can take a long time</p>
                <p className="mt-1">
                  Applying runs one member at a time. For large selections, expect <strong>up to 45 minutes</strong>.
                  Keep this tab open until the results table appears.
                </p>
              </div>
              {applyLoading && <MigrationLongRunNotice phase="apply" />}
            </div>
          )}

          {step === 5 && applyResults && (
            <div className="space-y-4">
              {applySummary && (
                <div className="flex flex-wrap gap-2 text-sm">
                  <span className="px-2 py-1 rounded-full bg-green-100 text-green-800">{applySummary.success} success</span>
                  <span className="px-2 py-1 rounded-full bg-amber-100 text-amber-900">{applySummary.skipped} skipped</span>
                  <span className="px-2 py-1 rounded-full bg-red-100 text-red-800">{applySummary.failed} failed</span>
                  {updateDimeRecurring &&
                    (() => {
                      const dimeFailed = applyResults.filter(
                        (row) => row.dimeUpdate?.attempted && row.dimeUpdate.success === false
                      ).length;
                      return dimeFailed > 0 ? (
                        <span className="px-2 py-1 rounded-full bg-orange-100 text-orange-900">
                          {dimeFailed} DIME not updated
                        </span>
                      ) : null;
                    })()}
                </div>
              )}
              <div className="overflow-x-auto border border-gray-200 rounded-lg">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-2 py-2">Member</th>
                      <th className="px-2 py-2">Status</th>
                      <th className="px-2 py-2">Message</th>
                      <th className="px-2 py-2">
                        <span className="block">DIME recurring</span>
                        <span className="block text-[10px] font-normal normal-case text-gray-500">If enabled in Step 2</span>
                      </th>
                      <th className="px-2 py-2 text-right">
                        <span className="block">Current Premium</span>
                        <span className="block text-[10px] font-normal normal-case text-gray-500">Household total w/ fees</span>
                      </th>
                      <th className="px-2 py-2 text-right">
                        <span className="block">New Premium</span>
                        <span className="block text-[10px] font-normal normal-case text-gray-500">Household total w/ fees</span>
                      </th>
                      <th className="px-2 py-2 text-right">
                        <span className="block">New product premium</span>
                        <span className="block text-[10px] font-normal normal-case text-gray-500">Migrated product only</span>
                      </th>
                      <th className="px-2 py-2 text-right">
                        <span className="block">Current processing fee total</span>
                        <span className="block text-[10px] font-normal normal-case text-gray-500">Household total</span>
                      </th>
                      <th className="px-2 py-2 text-right">
                        <span className="block">New processing fee total</span>
                        <span className="block text-[10px] font-normal normal-case text-gray-500">Household total</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {applyResults.map((r) => {
                      const cand = (candidatesPayload?.candidates || []).find((c) => c.memberId === r.memberId);
                      const name = cand?.memberName || r.memberId;
                      const statusStyles =
                        r.status === 'success'
                          ? 'text-green-700 bg-green-50'
                          : r.status === 'skipped'
                            ? 'text-amber-800 bg-amber-50'
                            : 'text-red-700 bg-red-50';
                      const premDelta =
                        r.oldPremium != null && r.newPremium != null
                          ? Math.round((Number(r.newPremium) - Number(r.oldPremium)) * 100) / 100
                          : null;
                      const newPremClass =
                        premDelta == null ? 'text-gray-900' : premDelta === 0 ? 'text-gray-900' : premDelta > 0 ? 'text-green-600 font-medium' : 'text-red-600 font-medium';
                      const productDelta =
                        r.oldProductPremium != null && r.newProductPremium != null
                          ? Math.round((Number(r.newProductPremium) - Number(r.oldProductPremium)) * 100) / 100
                          : null;
                      const newProductClass =
                        productDelta == null
                          ? 'text-gray-900'
                          : productDelta === 0
                            ? 'text-gray-900'
                            : productDelta > 0
                              ? 'text-green-600 font-medium'
                              : 'text-red-600 font-medium';
                      const feeDelta =
                        r.oldFee != null && r.newFee != null
                          ? Math.round((Number(r.newFee) - Number(r.oldFee)) * 100) / 100
                          : null;
                      const newFeeClass =
                        feeDelta == null ? 'text-gray-900' : feeDelta === 0 ? 'text-gray-900' : feeDelta > 0 ? 'text-green-600 font-medium' : 'text-red-600 font-medium';
                      const dimeReport = formatDimeRecurringReport(r, updateDimeRecurring, cand?.billType);
                      return (
                        <tr key={`${r.memberId}-${r.status}`} className="hover:bg-gray-50">
                          <td className="px-2 py-2">
                            <button
                              type="button"
                              className="text-oe-primary hover:underline font-medium"
                              onClick={() => void openMemberModal(r.memberId)}
                            >
                              {name}
                            </button>
                          </td>
                          <td className="px-2 py-2">
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusStyles}`}>{r.status}</span>
                          </td>
                          <td className="px-2 py-2 text-gray-700 text-xs">{r.message}</td>
                          <td className="px-2 py-2 text-xs max-w-[14rem]">
                            <span className={dimeReport.className}>{dimeReport.short}</span>
                            {dimeReport.detail && dimeReport.short !== 'Updated' && dimeReport.short !== 'Off' ? (
                              <p className="text-gray-600 mt-0.5 leading-snug break-words" title={dimeReport.detail}>
                                {dimeReport.detail}
                              </p>
                            ) : dimeReport.detail && dimeReport.short === 'Updated' ? (
                              <p className="text-gray-500 mt-0.5 leading-snug break-words">{dimeReport.detail}</p>
                            ) : null}
                          </td>
                          <td className="px-2 py-2 text-right text-xs tabular-nums text-gray-900">
                            {r.oldPremium != null ? formatCurrency(r.oldPremium) : '—'}
                          </td>
                          <td className={`px-2 py-2 text-right text-xs tabular-nums ${newPremClass}`}>
                            {r.newPremium != null ? formatCurrency(r.newPremium) : '—'}
                          </td>
                          <td className={`px-2 py-2 text-right text-xs tabular-nums ${newProductClass}`}>
                            {r.newProductPremium != null ? formatCurrency(r.newProductPremium) : '—'}
                          </td>
                          <td className="px-2 py-2 text-right text-xs tabular-nums text-gray-900">
                            {r.oldFee != null ? formatCurrency(r.oldFee) : '—'}
                          </td>
                          <td className={`px-2 py-2 text-right text-xs tabular-nums ${newFeeClass}`}>
                            {r.newFee != null ? formatCurrency(r.newFee) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-between items-center p-4 border-t border-gray-200 bg-oe-light bg-opacity-30">
          <button
            type="button"
            onClick={() => {
              if (step === 1 || step === 5) handleClose();
              else setStep(step - 1);
            }}
            className="btn-secondary flex items-center gap-1"
            disabled={migrationInProgress}
          >
            <ChevronLeft className="w-4 h-4" />
            {step === 1 ? 'Cancel' : step === 5 ? 'Done' : 'Back'}
          </button>

          {step < 5 && (
            <button
              type="button"
              disabled={
                applyLoading ||
                (step === 1 && !selectedProductId) ||
                (step === 2 &&
                  (migrationTenantsLoading ||
                    !!migrationTenantsError ||
                    selectedTenantIds.length === 0 ||
                    !migrationTenants)) ||
                (step === 3 && (candidatesLoading || !!candidatesError || eligibleList.length === 0)) ||
                migrationInProgress ||
                (step === 4 && selectedCount === 0)
              }
              onClick={() => {
                if (step === 4) void runApply();
                else setStep(step + 1);
              }}
              className="btn-primary flex items-center gap-1 disabled:opacity-50"
            >
              {step === 4 ? (applyLoading ? 'Working…' : 'Confirm migration') : 'Next'}
              {step !== 4 && <ChevronRight className="w-4 h-4" />}
            </button>
          )}
        </div>
      </div>

      {memberModalLoading && (
        <div className="fixed inset-0 z-[2147483648] flex items-center justify-center bg-black/25 pointer-events-none">
          <Loader2 className="w-10 h-10 animate-spin text-white drop-shadow" aria-hidden />
        </div>
      )}
      {memberModalMember && !memberModalLoading && (
        <MemberManagementModal
          key={memberModalMember.MemberId}
          member={memberModalMember}
          householdMembers={memberModalHousehold}
          memberEnrollments={memberModalEnrollments as any}
          enrollmentsLoading={false}
          onClose={() => {
            setMemberModalMember(null);
            setMemberModalHousehold([]);
            setMemberModalEnrollments([]);
          }}
          onEdit={() => {}}
          formatCurrency={formatCurrency}
          getStatusColor={getStatusColor}
          getRelationshipIcon={getRelationshipIcon}
          getRelationshipColor={getRelationshipColor}
          canEdit={false}
          canDelete={false}
          overlayZIndexClass="z-[2147483648]"
          nestedOverlayZIndexClass="z-[2147483649]"
        />
      )}
    </div>,
    document.body
  );
};

export default ProductMigrationWizard;

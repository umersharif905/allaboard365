/**
 * GroupTypeChangeWizard.tsx
 *
 * Route: /groups/:groupId/type-change/wizard
 *
 * A 5-step wizard that guides an Agent or TenantAdmin through converting a
 * group from Standard → ListBill (or vice-versa) after a type-change request
 * has been approved.
 *
 * Steps:
 *   1. Review   — show affected members bucketed by action (Task 5.1)
 *   2. Products — pick individual products for the new type (Task 5.2)
 *   3. Confirm  — clear HouseholdMemberIds, cancel future enrollments (Task 5.2)
 *   4. Links    — resend enrollment links to re-enroll members (Task 5.3)
 *   5. Done     — summary screen (Task 5.3)
 */

import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ArrowLeft, ArrowRight, CheckCircle, AlertTriangle } from 'lucide-react';
import { GroupBadge } from '../../components/groups/GroupBadge';
import {
  getPreview,
  getAvailableProducts,
  apply,
  sendLinks,
  type PreviewMember,
  type WizardAction,
  type ApplyResult,
  type SendLinksResult
} from '../../services/groupTypeChangeWizard.service';
import { type Product } from '../../services/group-products.service';
import { EnrollmentLinkTemplatesService, type EnrollmentLinkTemplate } from '../../services/enrollment-link-templates.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEPS = ['Review', 'Products', 'Confirm', 'Links', 'Done'] as const;
type Step = typeof STEPS[number];

const ACTION_CONFIG: Record<
  WizardAction,
  { label: string; summary: string; description: string; badgeClass: string }
> = {
  // 'preserve' is in the union for back-compat with the service typing but is
  // never produced by the backend or used by Step 1 anymore. The entry is
  // kept so TypeScript's exhaustiveness check on `Record<WizardAction, …>` is
  // satisfied without changing the shared type.
  preserve: {
    label: 'Preserve',
    summary: 'no action needed',
    description: '',
    badgeClass: 'bg-green-100 text-green-800'
  },
  reEnroll: {
    label: 'Re-enroll',
    summary: 're-enroll required',
    description: 'These members have a future effective date — their pending enrollment will be cancelled and they will need to re-enroll on the new product.',
    badgeClass: 'bg-yellow-100 text-yellow-800'
  },
  letFinishThenCancel: {
    label: 'Let finish, then cancel',
    summary: 'terminate at end of month',
    description: 'These members have active coverage that will run through the end of the current month and then end. Re-enroll them on the new product before that date or their coverage will lapse.',
    badgeClass: 'bg-orange-100 text-orange-800'
  }
};

/** End-of-month label, e.g. "April 30, 2026" — used in the let-finish callout. */
function formatEndOfCurrentMonth(): string {
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return lastDay.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ActionSectionProps {
  action: WizardAction;
  members: PreviewMember[];
  defaultOpen?: boolean;
}

function ActionSection({ action, members, defaultOpen = false }: ActionSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const config = ACTION_CONFIG[action];
  const isLetFinish = action === 'letFinishThenCancel';

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 text-left"
        aria-expanded={isOpen}
        data-testid={`section-${action}`}
      >
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${config.badgeClass}`}>
            {config.label}
          </span>
          <span className="text-sm font-medium text-gray-700">
            {members.length} member{members.length !== 1 ? 's' : ''}
          </span>
        </div>
        {isOpen ? (
          <ChevronDown className="h-4 w-4 text-gray-400" />
        ) : (
          <ChevronRight className="h-4 w-4 text-gray-400" />
        )}
      </button>

      {isOpen && (
        <div className="border-t border-gray-100">
          <p className="px-4 py-2 text-xs text-gray-500 bg-gray-50">
            {config.description}
          </p>
          {/* Hard-deadline callout for the let-finish bucket — these members
              keep coverage only through the end of the current month. The
              agent has to re-enroll them by then, hence the explicit date. */}
          {isLetFinish && members.length > 0 && (
            <div
              className="mx-4 mt-3 mb-1 bg-amber-50 border border-amber-300 rounded-md p-3 text-sm text-amber-900"
              data-testid="letfinish-deadline-callout"
            >
              <span className="font-medium">⚠ Make sure these members are re-enrolled in the new products before {formatEndOfCurrentMonth()}</span>, or their coverage will lapse the next day.
            </div>
          )}
          {members.length === 0 ? (
            <p className="px-4 py-3 text-sm text-gray-400 italic">No members in this category.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {members.map((member) => {
                const count = member.enrollments.length;
                return (
                  <li key={member.memberId} className="px-4 py-3 flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-gray-800 truncate">{member.displayName}</span>
                    <span className="text-xs text-gray-500 whitespace-nowrap">
                      {count} enrollment{count !== 1 ? 's' : ''} — {config.summary}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Members not yet enrolled" panel — shown at the bottom of Step 1 so the
// agent sees that nobody is being silently dropped. Their existing enrollment
// link auto-resolves to the new ListBill product set after the wizard runs
// (oe.GroupProducts is the source of truth at link-render time).
// ---------------------------------------------------------------------------

interface NoEnrollmentSectionProps {
  members: Array<{ memberId: string; displayName: string; email: string | null; memberStatus: string | null }>;
}

function NoEnrollmentSection({ members }: NoEnrollmentSectionProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border border-blue-200 bg-blue-50 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-blue-100"
        aria-expanded={isOpen}
        data-testid="section-no-enrollments"
      >
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center rounded-full bg-blue-100 text-blue-800 px-2.5 py-0.5 text-xs font-medium border border-blue-300">
            No enrollments yet
          </span>
          <span className="text-sm font-medium text-gray-700">
            {members.length} member{members.length !== 1 ? 's' : ''}
          </span>
        </div>
        {isOpen ? (
          <ChevronDown className="h-4 w-4 text-gray-400" />
        ) : (
          <ChevronRight className="h-4 w-4 text-gray-400" />
        )}
      </button>

      {isOpen && (
        <div className="border-t border-blue-100">
          <p className="px-4 py-2 text-xs text-blue-900 bg-blue-100/50">
            These members are in the group but haven't enrolled in any product. After the conversion runs, their existing enrollment links will automatically show the new List Bill products — no action needed from you unless you want to nudge them.
          </p>
          <ul className="divide-y divide-blue-100">
            {members.map((m) => (
              <li key={m.memberId} className="px-4 py-3 flex items-center justify-between gap-3">
                <span className="text-sm text-gray-800 font-medium truncate">{m.displayName || '(no name)'}</span>
                <span className="text-xs text-gray-500 truncate">
                  {m.email || ''}
                  {m.memberStatus && m.memberStatus !== 'Active' ? ` • ${m.memberStatus}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Review
// ---------------------------------------------------------------------------

interface Step1Props {
  groupId: string;
  /** Called with step-1 derived data on Next */
  onNext: (data: {
    targetType: 'ListBill' | 'Standard';
    reEnrollMemberIds: string[];
    reEnrollMembers: PreviewMember[];
    letFinishMembers: PreviewMember[];
  }) => void;
}

function Step1Review({ groupId, onNext }: Step1Props) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['type-change-preview', groupId],
    queryFn: () => getPreview(groupId),
    retry: false
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400 text-sm">
        Loading enrollment preview…
      </div>
    );
  }

  if (isError) {
    const message = error instanceof Error ? error.message : 'Failed to load preview.';
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
        <p className="text-sm text-red-700">{message}</p>
      </div>
    );
  }

  const members = data?.members ?? [];
  const membersWithoutEnrollments = data?.membersWithoutEnrollments ?? [];

  // Two buckets only — the preserve concept was retired. Every member with an
  // active or pending enrollment falls into one of these based on EffectiveDate.
  const reEnrollMembers = members.filter((m) => m.action === 'reEnroll');
  const letFinishMembers = members.filter((m) => m.action === 'letFinishThenCancel');

  function handleNext() {
    onNext({
      targetType: data?.targetType ?? 'ListBill',
      reEnrollMemberIds: reEnrollMembers.map((m) => m.memberId),
      reEnrollMembers,
      letFinishMembers
    });
  }

  return (
    <div className="space-y-4">
      <div className="mb-2">
        <h2 className="text-base font-semibold text-gray-900">Review existing enrollments</h2>
        <p className="text-sm text-gray-500 mt-1">
          The following members have active or upcoming enrollments on this group. Review how each
          will be handled during the type conversion.
        </p>
      </div>

      {members.length === 0 && membersWithoutEnrollments.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-8 text-center">
          <CheckCircle className="mx-auto h-8 w-8 text-green-400 mb-2" />
          <p className="text-sm text-gray-500">
            No members have active or upcoming enrollments — the conversion can proceed immediately.
          </p>
        </div>
      ) : (
        <>
          <ActionSection action="reEnroll" members={reEnrollMembers} defaultOpen={reEnrollMembers.length > 0} />
          <ActionSection action="letFinishThenCancel" members={letFinishMembers} defaultOpen={letFinishMembers.length > 0} />
          {membersWithoutEnrollments.length > 0 && (
            <NoEnrollmentSection members={membersWithoutEnrollments} />
          )}
        </>
      )}

      <div className="flex justify-end pt-4">
        <button
          type="button"
          onClick={handleNext}
          className="inline-flex items-center gap-2 rounded-md bg-oe-primary hover:bg-oe-dark text-white px-4 py-2 text-sm font-medium"
        >
          Next
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Product picker
// ---------------------------------------------------------------------------

interface Step2Props {
  groupId: string;
  /**
   * Direction the wizard is converting toward. Filters the product list:
   *   - 'ListBill' → SalesType IN ('Individual', 'Both')
   *   - 'Standard' → SalesType IN ('Group', 'Both')
   */
  targetType: 'ListBill' | 'Standard';
  onBack: () => void;
  onNext: (selectedProductIds: string[]) => void;
}

function Step2Products({ groupId, targetType, onBack, onNext }: Step2Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);

  const { data: productsData, isLoading } = useQuery({
    queryKey: ['type-change-wizard-products', groupId],
    // Wizard-specific endpoint: requires explicit ProductSubscription for the
    // tenant; no marketplace fall-through, so cross-tenant products owned by
    // other tenants don't leak into the picker. See
    // backend/routes/groups.js → /:id/type-change/available-products.
    queryFn: () => getAvailableProducts(groupId),
    retry: false
  });

  // Direction-driven copy + filter. The product picker shows products that
  // match the *target* group type's sales channel:
  //   - Converting → ListBill: show Individual / Both products
  //   - Converting → Standard: show Group / Both products
  // 'Both' is always eligible because it's billable either way.
  const isToListBill = targetType === 'ListBill';
  const allowedSalesTypes: Array<'Individual' | 'Group' | 'Both'> = isToListBill
    ? ['Individual', 'Both']
    : ['Group', 'Both'];
  const directionLabel = isToListBill ? 'individual' : 'group';
  const directionLabelTitleCase = isToListBill ? 'Individual' : 'Group';

  // Pre-select existing group products whose SalesType is already valid for
  // the target direction so the agent doesn't have to re-tick them. Anything
  // not valid for the new direction stays unchecked (it'll be hidden on apply).
  const [initialized, setInitialized] = useState(false);

  if (!initialized && productsData) {
    const preSelected = new Set<string>(
      (productsData.groupProducts ?? [])
        .filter((gp) => allowedSalesTypes.includes(gp.SalesType as 'Individual' | 'Group' | 'Both'))
        .map((gp) => gp.ProductId)
    );
    setSelectedIds(preSelected);
    setInitialized(true);
  }

  const eligible: Product[] = (productsData?.availableProducts ?? []).filter(
    (p) => allowedSalesTypes.includes(p.SalesType as 'Individual' | 'Group' | 'Both')
  );

  function toggleProduct(productId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
      }
      return next;
    });
  }

  function handleNext() {
    if (selectedIds.size === 0) {
      setLoadError('Select at least one product before continuing.');
      return;
    }
    setLoadError(null);
    onNext(Array.from(selectedIds));
  }

  return (
    <div className="space-y-4">
      <div className="mb-2">
        <h2 className="text-base font-semibold text-gray-900">
          Select {directionLabel} products
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          Choose the {directionLabel} products that will be available to members after conversion.
          Products are filtered to those with a Sales Type of <strong>{directionLabelTitleCase}</strong> or <strong>Both</strong>.
        </p>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-400 text-sm">
          Loading products…
        </div>
      )}

      {!isLoading && eligible.length === 0 && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-6 text-center">
          <AlertTriangle className="mx-auto h-7 w-7 text-yellow-500 mb-2" />
          <p className="text-sm text-gray-700">
            No {directionLabel}-type products are available for this tenant. Contact your administrator to add products.
          </p>
        </div>
      )}

      {/* Flat product list — no vendor grouping. The previous vendor headers
          forced agents to scroll through nested sections; one alphabetised
          list reads faster when there are typically < 20 products. */}
      {!isLoading && eligible.length > 0 && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <ul className="divide-y divide-gray-100">
            {eligible.map((p) => (
              <li key={p.ProductId} className="px-4 py-3 flex items-center gap-3">
                <input
                  id={`product-${p.ProductId}`}
                  type="checkbox"
                  checked={selectedIds.has(p.ProductId)}
                  onChange={() => toggleProduct(p.ProductId)}
                  className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                  data-testid={`product-checkbox-${p.ProductId}`}
                />
                <label
                  htmlFor={`product-${p.ProductId}`}
                  className="flex-1 cursor-pointer"
                >
                  <span className="text-sm font-medium text-gray-800">{p.Name}</span>
                  {p.ProductType && (
                    <span className="ml-2 text-xs text-gray-400">{p.ProductType}</span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3" data-testid="step2-error">
          <p className="text-sm text-red-700">{loadError}</p>
        </div>
      )}

      <div className="flex justify-between pt-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 px-4 py-2 text-sm font-medium"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <button
          type="button"
          onClick={handleNext}
          disabled={isLoading}
          className="inline-flex items-center gap-2 rounded-md bg-oe-primary hover:bg-oe-dark text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
          data-testid="step2-next"
        >
          Next
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Confirm — clear IDs + cancel enrollments
// ---------------------------------------------------------------------------

interface Step3Props {
  groupId: string;
  selectedProductIds: string[];
  reEnrollMemberIds: string[];
  letFinishMembers: PreviewMember[];
  onBack: () => void;
  onNext: (result: ApplyResult) => void;
}

function Step3Confirm({
  groupId,
  selectedProductIds,
  reEnrollMemberIds,
  letFinishMembers,
  onBack,
  onNext
}: Step3Props) {
  const [understood, setUnderstood] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const memberIdsToLetFinish = letFinishMembers.map((m) => m.memberId);

  async function handleApply() {
    if (!understood) return;
    setIsApplying(true);
    setApplyError(null);
    try {
      const result = await apply(groupId, {
        productIds: selectedProductIds,
        memberIdsToReEnroll: reEnrollMemberIds,
        // preserveMappings is always empty now that the preserve bucket is
        // gone — kept on the payload for backend back-compat (the apply
        // route still accepts it but no-ops on an empty array).
        preserveMappings: [],
        memberIdsToLetFinish
      });
      onNext(result);
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'Apply failed. Please try again.');
    } finally {
      setIsApplying(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="mb-2">
        <h2 className="text-base font-semibold text-gray-900">Confirm conversion</h2>
        <p className="text-sm text-gray-500 mt-1">
          Review the actions that will be performed when you confirm. This cannot be undone.
        </p>
      </div>

      {/* Impact summary */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 divide-y divide-gray-100">
        <div className="px-4 py-3 flex items-center justify-between">
          <span className="text-sm text-gray-700">Products being added to the group</span>
          <span className="text-sm font-semibold text-gray-900">{selectedProductIds.length}</span>
        </div>
        <div className="px-4 py-3 flex items-center justify-between">
          <span className="text-sm text-gray-700">Members finishing out the current month, then dropping off</span>
          <span className="text-sm font-semibold text-gray-900" data-testid="confirm-letfinish-count">
            {memberIdsToLetFinish.length}
          </span>
        </div>
        <div className="px-4 py-3 flex items-center justify-between">
          <span className="text-sm text-gray-700">Members who will get a new enrollment link to re-sign up</span>
          <span
            className="text-sm font-semibold text-gray-900"
            data-testid="confirm-household-count"
          >
            {reEnrollMemberIds.length + memberIdsToLetFinish.length}
          </span>
        </div>
        <div className="px-4 py-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
          <p className="text-xs text-gray-600">
            {reEnrollMemberIds.length} member{reEnrollMemberIds.length !== 1 ? 's' : ''} signed up but
            not yet active will be cancelled and need to re-enroll on the new plan. {memberIdsToLetFinish.length}{' '}
            member{memberIdsToLetFinish.length !== 1 ? 's' : ''} already on coverage will keep it through the
            end of the current month and then drop off. You'll send everyone new enrollment links in the next step.
          </p>
        </div>
      </div>

      {/* I understand checkbox */}
      <label className="flex items-start gap-3 cursor-pointer select-none">
        <input
          id="confirm-understood"
          type="checkbox"
          checked={understood}
          onChange={(e) => setUnderstood(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
          data-testid="confirm-understood"
        />
        <span className="text-sm text-gray-700">
          I understand the members listed above will need to re-enroll, and that this conversion can't be undone.
        </span>
      </label>

      {applyError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3" data-testid="step3-error">
          <p className="text-sm text-red-700">{applyError}</p>
        </div>
      )}

      <div className="flex justify-between pt-4">
        <button
          type="button"
          onClick={onBack}
          disabled={isApplying}
          className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <button
          type="button"
          onClick={handleApply}
          disabled={!understood || isApplying}
          className="inline-flex items-center gap-2 rounded-md bg-oe-primary hover:bg-oe-dark text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
          data-testid="step3-apply"
        >
          {isApplying ? 'Applying…' : 'Apply conversion'}
          {!isApplying && <ArrowRight className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Links — resend enrollment links to re-enroll members
// ---------------------------------------------------------------------------

interface Step4Props {
  groupId: string;
  reEnrollMembers: PreviewMember[];
  letFinishMembers: PreviewMember[];
  onBack: () => void;
  onNext: (result: SendLinksResult) => void;
}

function Step4Links({ groupId, reEnrollMembers, letFinishMembers, onBack, onNext }: Step4Props) {
  // Both buckets need new enrollment links — re-enroll members because their
  // future enrollment was cancelled, and let-finish members because their
  // current enrollment is scheduled to terminate at month end and they need
  // a new individual-product enrollment for the next period.
  const linkRecipients = [
    ...reEnrollMembers.map((m) => ({ ...m, _bucket: 'reEnroll' as const })),
    ...letFinishMembers.map((m) => ({ ...m, _bucket: 'letFinish' as const }))
  ];
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // When there are recipients, "Continue without sending" goes through a
  // confirmation modal so an agent doesn't accidentally strand members
  // without an enrollment link.
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);

  // Fetch Group-type templates for this group
  const { data: templatesData, isLoading: templatesLoading } = useQuery({
    queryKey: ['enrollment-link-templates-for-wizard', groupId],
    queryFn: async () => {
      const resp = await EnrollmentLinkTemplatesService.getTemplates(
        { templateType: 'Group', isActive: true, groupId },
        'Agent'
      );
      if (!resp.success) throw new Error(resp.message ?? 'Failed to load templates.');
      return (resp.data?.data ?? []).filter(
        (t: EnrollmentLinkTemplate) => t.TemplateType === 'Group' && t.IsActive
      );
    },
    retry: false
  });

  const templates: EnrollmentLinkTemplate[] = templatesData ?? [];

  // 99% of groups have exactly one active Group template. Auto-select it so the
  // agent doesn't have to click a one-option dropdown. Only show the dropdown
  // when there's a real choice to make (2+).
  useEffect(() => {
    if (templates.length === 1 && selectedTemplateId !== templates[0].TemplateId) {
      setSelectedTemplateId(templates[0].TemplateId);
    }
  }, [templates, selectedTemplateId]);

  async function handleSend() {
    if (!selectedTemplateId) return;
    setIsSending(true);
    setSendError(null);
    try {
      const memberIds = linkRecipients.map((m) => m.memberId);
      const result = await sendLinks(groupId, memberIds, selectedTemplateId);
      onNext(result);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send links. Please try again.');
    } finally {
      setIsSending(false);
    }
  }

  // Skip this step. When there are no recipients we proceed silently; when
  // there ARE recipients we open the confirmation modal first so the agent
  // has to acknowledge that those people will be left without a link.
  function handleContinueWithoutSending() {
    if (linkRecipients.length > 0) {
      setShowSkipConfirm(true);
      return;
    }
    onNext({ sentCount: 0 });
  }

  function confirmSkip() {
    setShowSkipConfirm(false);
    onNext({ sentCount: 0 });
  }

  return (
    <div className="space-y-4">
      <div className="mb-2">
        <h2 className="text-base font-semibold text-gray-900">Send enrollment links</h2>
        <p className="text-sm text-gray-500 mt-1">
          The members below need new enrollment links — either because their pending enrollment was
          cancelled, or because their active coverage is scheduled to end at month end. Select a
          template and send.
        </p>
      </div>

      {/* Member list */}
      {linkRecipients.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-8 text-center">
          <CheckCircle className="mx-auto h-8 w-8 text-green-400 mb-2" />
          <p className="text-sm text-gray-500">
            No members require new links. You can skip this step.
          </p>
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden" data-testid="reenroll-member-list">
          <div className="px-4 py-2 bg-oe-light/40 border-b border-gray-200">
            <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
              Members needing new links ({linkRecipients.length})
            </span>
          </div>
          <ul className="divide-y divide-gray-100">
            {linkRecipients.map((m) => (
              <li key={m.memberId} className="px-4 py-3 flex items-center justify-between">
                <span className="text-sm font-medium text-gray-800">{m.displayName}</span>
                <span className={`text-xs ${m._bucket === 'letFinish' ? 'text-orange-600' : 'text-yellow-700'}`}>
                  {m._bucket === 'letFinish' ? 'After current term ends' : 'Re-enroll now'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Template selector */}
      <div className="space-y-1">
        <label
          htmlFor="step4-template-select"
          className="block text-sm font-medium text-gray-700"
        >
          Enrollment link template
        </label>
        {templatesLoading ? (
          <p className="text-sm text-gray-400">Loading templates…</p>
        ) : templates.length === 0 ? (
          <p className="text-sm text-yellow-700">
            No active Group templates found for this group. Set one up in the link templates
            settings before sending links.
          </p>
        ) : templates.length === 1 ? (
          <div
            className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800"
            data-testid="step4-template-auto"
          >
            <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
            <span>
              Using template: <strong>{templates[0].TemplateName}</strong>
            </span>
          </div>
        ) : (
          <select
            id="step4-template-select"
            value={selectedTemplateId}
            onChange={(e) => setSelectedTemplateId(e.target.value)}
            className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 focus:border-oe-primary focus:outline-none focus:ring-1 focus:ring-oe-primary"
            data-testid="step4-template-select"
          >
            <option value="">— Select a template —</option>
            {templates.map((t) => (
              <option key={t.TemplateId} value={t.TemplateId}>
                {t.TemplateName}
              </option>
            ))}
          </select>
        )}
      </div>

      {sendError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3" data-testid="step4-error">
          <p className="text-sm text-red-700">{sendError}</p>
        </div>
      )}

      <div className="flex justify-between pt-4">
        <button
          type="button"
          onClick={onBack}
          disabled={isSending}
          className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        {/* Right-side action cluster.
            - Send button: only shown when there are recipients to send to.
              Disabled until a template is selected.
            - Continue button: ALWAYS available so the agent can finish the
              wizard. Sending is now optional — agents can defer to the
              Members tab or the Enrollment Links tab to send links manually.
              The button label changes based on whether sending is even an
              option, so the agent isn't surprised. */}
        <div className="flex items-center gap-2">
          {linkRecipients.length > 0 && (
            <button
              type="button"
              onClick={handleSend}
              disabled={!selectedTemplateId || isSending}
              className="inline-flex items-center gap-2 rounded-md bg-oe-primary hover:bg-oe-dark text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
              data-testid="step4-send"
            >
              {isSending ? 'Sending…' : 'Send links'}
            </button>
          )}
          <button
            type="button"
            onClick={handleContinueWithoutSending}
            disabled={isSending}
            className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 ${
              linkRecipients.length === 0
                ? 'bg-oe-primary hover:bg-oe-dark text-white'
                : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
            data-testid="step4-continue"
          >
            {linkRecipients.length === 0 ? 'Continue' : 'Continue without sending'}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {showSkipConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          role="dialog"
          aria-modal="true"
          data-testid="step4-skip-confirm"
        >
          <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-gray-900">
                  Skip sending — {linkRecipients.length} member{linkRecipients.length !== 1 ? 's' : ''} will be left without a link
                </h3>
                <p className="mt-2 text-sm text-gray-600">
                  These members no longer have an active enrollment under the new group type and the system won't send them anything automatically. You'll need to send a link manually from the Members tab or the Enrollment Links tab before they can re-enroll.
                </p>
                <ul className="mt-3 max-h-40 overflow-auto rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                  {linkRecipients.map((m) => (
                    <li key={m.memberId} className="py-0.5 flex items-center justify-between gap-2">
                      <span className="truncate">{m.displayName}</span>
                      <span className={`text-xs ${m._bucket === 'letFinish' ? 'text-orange-600' : 'text-yellow-700'}`}>
                        {m._bucket === 'letFinish' ? 'After current term ends' : 'Re-enroll now'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowSkipConfirm(false)}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                data-testid="step4-skip-cancel"
              >
                Go back and send
              </button>
              <button
                type="button"
                onClick={confirmSkip}
                className="rounded-md bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 text-sm font-medium"
                data-testid="step4-skip-confirm-button"
              >
                Skip anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5: Done — summary
// ---------------------------------------------------------------------------

interface Step5Props {
  groupId: string;
  applyResult: ApplyResult;
  sendLinksResult: SendLinksResult;
}

function Step5Done({ groupId, applyResult, sendLinksResult }: Step5Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  function handleBackToGroup() {
    // The wizard just changed GroupType, GroupProducts, and member enrollments.
    // `invalidateQueries` only marks entries stale, so the destination page can
    // briefly render the pre-wizard cached data before refetching — that's how
    // we ended up with "still shows Standard" reports right after a successful
    // ListBill conversion. `removeQueries` evicts the entries entirely, forcing
    // the next observer to fetch fresh from the server. Cheap on a navigation
    // that's already going to refetch anyway.
    queryClient.removeQueries({ queryKey: ['group', groupId] });
    queryClient.removeQueries({ queryKey: ['groupDetails', groupId] });
    queryClient.removeQueries({ queryKey: ['groupSetupStatus', groupId] });
    queryClient.removeQueries({ queryKey: ['groupProducts', groupId] });
    queryClient.removeQueries({ queryKey: ['groupContributions', groupId] });
    // The wizard mounts under a role prefix (/admin/groups/:groupId/type-change/wizard,
    // /agent/groups/:groupId/type-change/wizard, etc). Navigate up two segments to land
    // on the role-correct group page rather than hard-coding '/groups/:groupId' (which
    // doesn't match any top-level route → blank screen).
    navigate('../..', { relative: 'path' });
  }

  return (
    <div className="space-y-6">
      <div className="mb-2">
        <h2 className="text-base font-semibold text-gray-900">Conversion complete</h2>
        <p className="text-sm text-gray-500 mt-1">
          The group type conversion has been applied. Here is a summary of what was done.
        </p>
      </div>

      <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 flex items-center gap-3">
        <CheckCircle className="h-5 w-5 text-green-500 shrink-0" />
        <p className="text-sm font-medium text-green-800">
          All steps completed successfully.
        </p>
      </div>

      <div className="border border-gray-200 rounded-lg overflow-hidden" data-testid="step5-summary">
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
          <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Summary</span>
        </div>
        <ul className="divide-y divide-gray-100">
          <li className="px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-gray-700">Active enrollments scheduled to terminate</span>
            <span className="text-sm font-semibold text-gray-900" data-testid="summary-terminating">
              {applyResult.enrollmentsTerminationScheduled}
            </span>
          </li>
          <li className="px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-gray-700">Pending enrollments cancelled</span>
            <span className="text-sm font-semibold text-gray-900" data-testid="summary-cancelled">
              {applyResult.enrollmentsCancelled}
            </span>
          </li>
          <li className="px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-gray-700">HouseholdMemberIds cleared</span>
            <span className="text-sm font-semibold text-gray-900" data-testid="summary-ids-cleared">
              {applyResult.householdIdsCleared}
            </span>
          </li>
          <li className="px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-gray-700">New enrollment links sent</span>
            <span className="text-sm font-semibold text-gray-900" data-testid="summary-links-sent">
              {sendLinksResult.sentCount}
            </span>
          </li>
        </ul>
      </div>

      <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3">
        <p className="text-sm text-blue-900">
          <strong>Existing enrollment links auto-adjust.</strong> Any link that hasn't been used yet (members who never enrolled, or links you sent before today) will now show only the new List Bill products when opened — no need to resend.
        </p>
      </div>

      <div className="flex justify-end pt-2">
        <button
          type="button"
          onClick={handleBackToGroup}
          className="inline-flex items-center gap-2 rounded-md bg-oe-primary hover:bg-oe-dark text-white px-4 py-2 text-sm font-medium"
          data-testid="step5-back-to-group"
        >
          Back to group
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

interface ProgressBarProps {
  currentIndex: number;
}

function ProgressBar({ currentIndex }: ProgressBarProps) {
  return (
    <nav aria-label="Wizard progress" className="mb-8">
      <ol className="flex items-center">
        {STEPS.map((step, idx) => {
          const isCompleted = idx < currentIndex;
          const isCurrent = idx === currentIndex;

          return (
            <li key={step} className={`flex items-center ${idx < STEPS.length - 1 ? 'flex-1' : ''}`}>
              <div className="flex flex-col items-center">
                <div
                  className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-medium
                    ${isCompleted ? 'bg-oe-primary text-white' : ''}
                    ${isCurrent ? 'border-2 border-oe-primary text-oe-primary bg-white' : ''}
                    ${!isCompleted && !isCurrent ? 'border-2 border-gray-200 text-gray-400 bg-white' : ''}
                  `}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  {isCompleted ? <CheckCircle className="h-4 w-4" /> : idx + 1}
                </div>
                <span
                  className={`mt-1 text-xs font-medium
                    ${isCurrent ? 'text-oe-primary' : ''}
                    ${isCompleted ? 'text-oe-dark' : ''}
                    ${!isCompleted && !isCurrent ? 'text-gray-400' : ''}
                  `}
                >
                  {step}
                </span>
              </div>
              {idx < STEPS.length - 1 && (
                <div
                  className={`flex-1 h-0.5 mx-2 mt-[-1rem]
                    ${idx < currentIndex ? 'bg-oe-primary' : 'bg-gray-200'}
                  `}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Main wizard component
// ---------------------------------------------------------------------------

export default function GroupTypeChangeWizard() {
  const { identifier: groupId } = useParams<{ identifier: string }>();
  const navigate = useNavigate();
  const [stepIndex, setStepIndex] = useState(0);

  // State passed between steps. Two member buckets only — the preserve
  // bucket was retired and every member now flows through reEnroll or
  // letFinishThenCancel (see Step 1 + backend preview route).
  const [targetType, setTargetType] = useState<'ListBill' | 'Standard'>('ListBill');
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [reEnrollMemberIds, setReEnrollMemberIds] = useState<string[]>([]);
  const [reEnrollMembers, setReEnrollMembers] = useState<PreviewMember[]>([]);
  const [letFinishMembers, setLetFinishMembers] = useState<PreviewMember[]>([]);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [sendLinksResult, setSendLinksResult] = useState<SendLinksResult | null>(null);

  if (!groupId) {
    return (
      <div className="p-6">
        <p className="text-sm text-red-600">Missing group ID in URL.</p>
      </div>
    );
  }

  const currentStep = STEPS[stepIndex];

  const goNext = () => setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  const goBack = () => {
    if (stepIndex === 0) {
      navigate(-1);
    } else {
      setStepIndex((i) => Math.max(i - 1, 0));
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          type="button"
          onClick={goBack}
          className="text-gray-400 hover:text-gray-600"
          aria-label="Go back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            Group Type Conversion
            <GroupBadge type={targetType} />
          </h1>
          <p className="text-sm text-gray-500">Step {stepIndex + 1} of {STEPS.length}</p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <ProgressBar currentIndex={stepIndex} />

        {/* Step content */}
        {currentStep === 'Review' && (
          <Step1Review
            groupId={groupId}
            onNext={({ targetType: tt, reEnrollMemberIds: ids, reEnrollMembers: members, letFinishMembers: lfm }) => {
              setTargetType(tt);
              setReEnrollMemberIds(ids);
              setReEnrollMembers(members);
              setLetFinishMembers(lfm);
              goNext();
            }}
          />
        )}
        {currentStep === 'Products' && (
          <Step2Products
            groupId={groupId}
            targetType={targetType}
            onBack={goBack}
            onNext={(ids) => {
              setSelectedProductIds(ids);
              goNext();
            }}
          />
        )}
        {currentStep === 'Confirm' && (
          <Step3Confirm
            groupId={groupId}
            selectedProductIds={selectedProductIds}
            reEnrollMemberIds={reEnrollMemberIds}
            letFinishMembers={letFinishMembers}
            onBack={goBack}
            onNext={(result) => {
              setApplyResult(result);
              goNext();
            }}
          />
        )}
        {currentStep === 'Links' && (
          <Step4Links
            groupId={groupId}
            reEnrollMembers={reEnrollMembers}
            letFinishMembers={letFinishMembers}
            onBack={goBack}
            onNext={(result) => {
              setSendLinksResult(result);
              goNext();
            }}
          />
        )}
        {currentStep === 'Done' && applyResult && sendLinksResult && (
          <Step5Done
            groupId={groupId}
            applyResult={applyResult}
            sendLinksResult={sendLinksResult}
          />
        )}
      </div>
    </div>
  );
}

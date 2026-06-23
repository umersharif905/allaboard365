/**
 * Human-readable labels for vendor import household preview (dates, tiers, plan changes).
 */

export type PlanChangeTone = 'change' | 'same' | 'new' | 'end' | 'unmapped' | 'warn' | 'muted';

export interface PlanLineDisplay {
  tone: PlanChangeTone;
  statusLabel: string;
  tierLabel: string;
  detail?: string;
  memberLabel?: string;
}

/** Parse preview/API dates (M/D/YYYY, YYYYMMDD, ISO) for display. */
export function formatImportPreviewDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;

  if (/^\d{8}$/.test(s)) {
    const y = Number(s.slice(0, 4));
    const m = Number(s.slice(4, 6));
    const d = Number(s.slice(6, 8));
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${m}/${d}/${y}`;
  }

  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return s;

  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime())) {
    const m = iso.getUTCMonth() + 1;
    const d = iso.getUTCDate();
    const y = iso.getUTCFullYear();
    return `${m}/${d}/${y}`;
  }

  return s;
}

/** Short tier line from long catalog label or plan key. */
export function shortPricingTierLabel(
  mappedTierLabel: string | null | undefined,
  planKey?: string,
): string {
  const label = (mappedTierLabel || '').trim();
  if (!label) return (planKey || '').trim() || '—';

  const parts = label.split('—').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.slice(1).join(' · ');

  if (/^essential/i.test(label) && planKey) return planKey.replace(/_/g, ' ');

  return label;
}

export function planChangeTone(action: string): PlanChangeTone {
  if (action === 'skip_unmapped') return 'unmapped';
  if (action === 'enroll_replace') return 'change';
  if (action === 'enroll_create') return 'new';
  if (action === 'terminate' || action === 'terminate_pending') return 'end';
  if (action === 'enroll_supplementary') return 'muted';
  if (action === 'enroll_unchanged') return 'same';
  if (action === 'enroll_update') return 'muted';
  return 'muted';
}

export function planStatusLabel(action: string): string {
  if (action === 'terminate') return 'Ending';
  if (action === 'terminate_pending') return 'Historical term';
  if (action === 'enroll_create') return 'New plan';
  if (action === 'enroll_replace') return 'Changing';
  if (action === 'enroll_unchanged') return 'Same plan';
  if (action === 'enroll_supplementary') return 'Billing ID only';
  if (action === 'enroll_update') return 'Updating';
  if (action === 'skip_unmapped') return 'Unmapped';
  return action;
}

export function planToneClass(tone: PlanChangeTone): string {
  switch (tone) {
    case 'change':
      return 'bg-violet-100 text-violet-900';
    case 'same':
      return 'bg-slate-100 text-slate-700';
    case 'new':
      return 'bg-green-100 text-green-800';
    case 'end':
      return 'bg-red-100 text-red-800';
    case 'unmapped':
      return 'bg-amber-100 text-amber-900';
    case 'warn':
      return 'bg-orange-100 text-orange-900';
    default:
      return 'bg-gray-100 text-gray-700';
  }
}

export function planLineTextClass(tone: PlanChangeTone): string {
  switch (tone) {
    case 'change':
      return 'text-violet-900 font-medium';
    case 'same':
      return 'text-slate-600';
    case 'new':
      return 'text-green-900';
    case 'end':
      return 'text-red-800';
    case 'unmapped':
      return 'font-mono text-amber-900';
    default:
      return 'text-gray-800';
  }
}

export function formatPlanDateDetail(plan: {
  action: string;
  terminateDate?: string | null;
  effectiveDate?: string | null;
  replacementTerminateDate?: string | null;
}): string | null {
  const parts: string[] = [];

  if (plan.action === 'enroll_replace') {
    const term = formatImportPreviewDate(plan.replacementTerminateDate);
    const eff = formatImportPreviewDate(plan.effectiveDate);
    if (term) parts.push(`Prior plan ends ${term}`);
    if (eff) parts.push(`New plan starts ${eff}`);
  } else if (plan.terminateDate) {
    const term = formatImportPreviewDate(plan.terminateDate);
    if (term) parts.push(`Ends ${term}`);
  } else if (plan.effectiveDate) {
    const eff = formatImportPreviewDate(plan.effectiveDate);
    if (eff) parts.push(`Effective ${eff}`);
  }

  return parts.length ? parts.join(' · ') : null;
}

export function formatPlanLineDisplay(plan: {
  planKey: string;
  action: string;
  productName?: string | null;
  mappedTierLabel?: string | null;
  currentMappedTierLabel?: string | null;
  memberLabel?: string;
  terminateDate?: string | null;
  effectiveDate?: string | null;
  replacementTerminateDate?: string | null;
}): PlanLineDisplay {
  const tone = planChangeTone(plan.action);
  const statusLabel = planStatusLabel(plan.action);

  let tierLabel: string;
  if (plan.action === 'skip_unmapped') {
    tierLabel = plan.planKey;
  } else if (plan.action === 'enroll_supplementary') {
    tierLabel = 'Uses main plan row (11321)';
  } else if (plan.action === 'enroll_replace' && plan.currentMappedTierLabel && plan.mappedTierLabel) {
    tierLabel = `${shortPricingTierLabel(plan.currentMappedTierLabel, plan.planKey)} → ${shortPricingTierLabel(plan.mappedTierLabel, plan.planKey)}`;
  } else {
    tierLabel = shortPricingTierLabel(plan.mappedTierLabel, plan.planKey);
  }

  const detail = formatPlanDateDetail(plan);
  const memberLabel = plan.memberLabel && plan.memberLabel !== 'Primary' ? plan.memberLabel : undefined;

  return { tone, statusLabel, tierLabel, detail, memberLabel };
}

export interface HouseholdSkipReasonDisplay {
  badge: string;
  detail: string;
}

/** Human-readable skip explanation for preview Action / name columns. */
export function householdSkipReasonDisplay(household: {
  action?: string;
  skipReason?: string | null;
  missingDependents?: boolean;
  requiredCoverageTier?: string | null;
  requiredCoverageTierLabel?: string | null;
  missingDependentsDetail?: string | null;
  importBlockedByEmail?: boolean;
  allPlansTerminated?: boolean;
}): HouseholdSkipReasonDisplay | null {
  if (household.missingDependents || household.skipReason === 'missing_dependents') {
    const tier = household.requiredCoverageTier || 'ES/EC/EF';
    const tierLabel = household.requiredCoverageTierLabel || tier;
    const detail = household.missingDependentsDetail
      || `Plan bills ${tier} (${tierLabel}) but this household has no matching dependent rows in the file.`;
    return {
      badge: 'Missing dependents',
      detail: `${detail} Not imported until the file includes those rows.`,
    };
  }
  if (household.importBlockedByEmail || household.skipReason === 'invalid_email') {
    return {
      badge: 'Bad email',
      detail: 'Primary email is missing or invalid. Fix the file or member record before import.',
    };
  }
  if (household.skipReason === 'terminated_only_new_household' || household.allPlansTerminated) {
    return {
      badge: 'Terminated only',
      detail: 'Member is not in AB365 yet and every plan row is a termination. Use “Terminated only (import history)” to include.',
    };
  }
  if (household.action === 'skip') {
    return {
      badge: 'Skipped',
      detail: household.skipReason
        ? `Skipped (${household.skipReason.replace(/_/g, ' ')}).`
        : 'Skipped by import rules.',
    };
  }
  return null;
}

export function coverageTierCellDisplay(household: {
  coverageTier?: string;
  coverageTierLabel?: string;
  missingDependents?: boolean;
  requiredCoverageTier?: string | null;
  requiredCoverageTierLabel?: string | null;
  missingDependentsDetail?: string | null;
  memberFieldChanges?: Array<{ field: string; from: string; to: string }>;
}): { main: string; sub?: string; isChanging: boolean } {
  if (household.missingDependents && household.requiredCoverageTier) {
    return {
      main: `Needs ${household.requiredCoverageTier}`,
      sub: household.missingDependentsDetail
        || household.requiredCoverageTierLabel
        || 'Missing dependents in file',
      isChanging: true,
    };
  }
  const tierChange = household.memberFieldChanges?.find((c) => c.field === 'Tier');
  if (tierChange?.from && tierChange?.to) {
    return {
      main: `${tierChange.from} → ${tierChange.to}`,
      sub: 'Family size in file',
      isChanging: true,
    };
  }
  const main = household.coverageTier || '—';
  const sub = household.coverageTierLabel || undefined;
  return { main, sub, isChanging: false };
}

export interface HouseholdChangeChip {
  label: string;
  className: string;
}

/** Compact summary chips (deps, terms) formerly in a separate Changes column. */
export function householdChangeChips(household: {
  hasTerminationsInFile?: boolean;
  plansWithTermDateInFile?: number;
  planTerminations?: number;
  planCreates?: number;
  planReplaces?: number;
  planUpdates?: number;
  memberFieldChanges?: Array<{ field: string }>;
  newDependentCount?: number;
  updatedDependentCount?: number;
  skipReason?: string | null;
}): HouseholdChangeChip[] {
  const chips: HouseholdChangeChip[] = [];

  if (household.hasTerminationsInFile) {
    const n = household.plansWithTermDateInFile ?? household.planTerminations ?? 1;
    chips.push({ label: `${n} term in file`, className: 'text-red-700' });
  }
  if ((household.planTerminations ?? 0) > 0) {
    chips.push({ label: `${household.planTerminations} to terminate`, className: 'text-red-700' });
  }
  if ((household.planCreates ?? 0) > 0) {
    chips.push({ label: `${household.planCreates} new plan`, className: 'text-green-700' });
  }
  if ((household.planReplaces ?? 0) > 0) {
    chips.push({ label: `${household.planReplaces} tier change`, className: 'text-violet-800 font-medium' });
  }
  if ((household.planUpdates ?? 0) > 0) {
    chips.push({ label: `${household.planUpdates} plan update`, className: 'text-blue-700' });
  }
  const memberFld = household.memberFieldChanges?.length ?? 0;
  if (memberFld > 0) {
    chips.push({ label: `${memberFld} member field`, className: 'text-teal-800' });
  }
  if ((household.newDependentCount ?? 0) > 0) {
    chips.push({ label: `+${household.newDependentCount} dependent`, className: 'text-purple-700' });
  }
  if ((household.updatedDependentCount ?? 0) > 0) {
    chips.push({ label: `${household.updatedDependentCount} dep update`, className: 'text-blue-700' });
  }
  if (household.skipReason === 'missing_dependents') {
    chips.push({ label: 'Needs dependent rows', className: 'text-fuchsia-800 font-medium' });
  }

  return chips;
}

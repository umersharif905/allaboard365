const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: string | null | undefined): boolean {
  return !!value && GUID_RE.test(value.trim());
}

/** Human label for import rows — never show raw GUIDs in the UI. */
export function importDisplayName(
  name: string | null | undefined,
  fallback = 'Unnamed request'
): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed || isGuid(trimmed)) return fallback;
  return trimmed;
}

/** Strip UUIDs from progress/status strings shown to users. */
export function sanitizeUserFacingText(text: string): string {
  return text
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      'request'
    )
    .replace(/\brequest request\b/gi, 'request');
}

/** Turn API/job/import row errors into readable text (never "[object Object]"). */
/** Browser IANA zone (e.g. America/New_York). */
export function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Short zone label for table headers (e.g. EST, EDT). */
export function getBrowserTimeZoneShortLabel(date: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', {
      timeZone: getBrowserTimeZone(),
      timeZoneName: 'short',
    }).formatToParts(date).find((p) => p.type === 'timeZoneName');
    return part?.value?.trim() || 'local';
  } catch {
    return 'local';
  }
}

/** UTC instant from API → wall clock in the user's timezone. */
export function formatImportUtcInLocalTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const tz = getBrowserTimeZone();
  const when = d.toLocaleString('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  const abbr = getBrowserTimeZoneShortLabel(d);
  return `${when} ${abbr}`;
}

/** Household has plan rows with no product-mapping match. */
export function householdHasUnmappedPlans(household: {
  unmappedProducts?: string[];
  plans?: Array<{ action: string }>;
}): boolean {
  if ((household.unmappedProducts?.length ?? 0) > 0) return true;
  return (household.plans ?? []).some((p) => p.action === 'skip_unmapped');
}

/** Preview table order: blocked/skipped issues first, then tenant moves, unmapped, rest. */
export function householdPreviewSortPriority(household: {
  action: string;
  skipReason?: string | null;
  missingDependents?: boolean;
  importBlockedByEmail?: boolean;
  unmappedProducts?: string[];
  plans?: Array<{ action: string }>;
}): number {
  if (household.missingDependents || household.skipReason === 'missing_dependents') return -1;
  if (household.action === 'skip' || household.importBlockedByEmail) return 0;
  if (household.action === 'move_tenant') return 1;
  if (householdHasUnmappedPlans(household)) return 2;
  return 3;
}

export function isMissingDependentsHousehold(household: {
  skipReason?: string | null;
  missingDependents?: boolean;
}): boolean {
  return !!household.missingDependents || household.skipReason === 'missing_dependents';
}

export function sortHouseholdPreviews<T extends {
  action: string;
  primaryName: string;
  skipReason?: string | null;
  missingDependents?: boolean;
  importBlockedByEmail?: boolean;
  unmappedProducts?: string[];
  plans?: Array<{ action: string }>;
}>(households: T[]): T[] {
  return [...households].sort((a, b) => {
    const rank = householdPreviewSortPriority(a) - householdPreviewSortPriority(b);
    if (rank !== 0) return rank;
    return a.primaryName.localeCompare(b.primaryName);
  });
}

const PLAN_PREVIEW_SORT_RANK: Record<string, number> = {
  skip_unmapped: 0,
  enroll_replace: 1,
  terminate: 2,
  terminate_pending: 3,
  enroll_create: 4,
  enroll_update: 5,
  enroll_supplementary: 6,
  enroll_unchanged: 7,
};

export function sortPlanPreviewsForDisplay<T extends { action: string }>(plans: T[]): T[] {
  return [...plans].sort((a, b) => {
    const ra = PLAN_PREVIEW_SORT_RANK[a.action] ?? 9;
    const rb = PLAN_PREVIEW_SORT_RANK[b.action] ?? 9;
    return ra - rb;
  });
}

export type FormatSuggestionLike = {
  matchesSelected?: boolean;
  suggestedSlug?: string | null;
};

/** True when upload should pause for explicit format choice before preview/import. */
export function needsFormatChoice(suggestion: FormatSuggestionLike | null | undefined): boolean {
  if (!suggestion?.suggestedSlug) return false;
  return suggestion.matchesSelected === false;
}

export function collectDistinctUnmappedPlanKeys(households: Array<{
  unmappedProducts?: string[];
  plans?: Array<{ action: string; planKey: string }>;
}>): string[] {
  const keys = new Set<string>();
  for (const h of households) {
    for (const k of h.unmappedProducts ?? []) {
      if (k) keys.add(k);
    }
    for (const p of h.plans ?? []) {
      if (p.action === 'skip_unmapped' && p.planKey) keys.add(p.planKey);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

export function formatImportErrorMessage(value: unknown, fallback = 'Import failed'): string {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '[object Object]') return fallback;
    return sanitizeUserFacingText(trimmed);
  }
  if (value instanceof Error) {
    return formatImportErrorMessage(value.message, fallback);
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      return formatImportErrorMessage(obj.message, fallback);
    }
    if (typeof obj.error === 'string') {
      return formatImportErrorMessage(obj.error, fallback);
    }
    try {
      const serialized = JSON.stringify(value);
      if (serialized && serialized !== '{}' && serialized !== 'null') {
        return sanitizeUserFacingText(serialized);
      }
    } catch {
      /* fall through */
    }
  }
  const asString = String(value);
  if (asString === '[object Object]') return fallback;
  return sanitizeUserFacingText(asString);
}

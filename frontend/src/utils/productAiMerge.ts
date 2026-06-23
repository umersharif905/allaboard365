import type {
  AgeBand,
  PricingTier,
  ProductFormData,
} from '../types/sysadmin/addproductswizard.types';
import { formatFieldLabel } from './productAiChatDisplay';
import { pickSourceBandsForTier } from './productAiPricingPhase';

export const IGNORED_AI_PATCH_FIELDS = new Set([
  'productImageUrl',
  'productLogoUrl',
  'productDocumentUrl',
  'productImageFile',
  'productLogoFile',
  'productDocumentFile',
  'productDocumentFiles',
  'idCardLogoFile',
  // Snapshot metadata — never apply to wizard
  'pricingTierIds',
  'pricingTiersSummary',
  'productId',
  'currentStep',
  'currentStepLabel',
  'configurationFieldCount',
  'configurationFieldNames',
  'acknowledgementQuestionCount',
  'aiChunkCount',
  'productQuestionnaireCount',
  'networkVariationCount',
  'descriptionPreview',
  'hasProductImage',
  'hasProductLogo',
  'hasProductDocument',
  'idCardDisabled',
]);

export type ProductFieldChange = {
  field: string;
  oldValue: unknown;
  newValue: unknown;
};

function parseAiNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/^[$€£]\s*/, '').replace(/,/g, '').replace(/%$/, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function todayIsoDate(): string {
  return new Date().toISOString().split('T')[0];
}

function trimDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = String(value).trim();
  return t || null;
}

function latestTierEffectiveDate(tier: PricingTier): string {
  const dates = (tier.ageBands || [])
    .map((b) => trimDate(b.effectiveDate))
    .filter((d): d is string => Boolean(d))
    .sort((a, b) => b.localeCompare(a));
  return dates[0] || '';
}

function isGenericAiTierLabel(label: string): boolean {
  const t = label.trim();
  if (!t) return true;
  return /^tier\s*\d+$/i.test(t) || /^unnamed/i.test(t);
}

/** Keep wizard config columns unless AI sent a non-empty replacement. */
function preserveConfigField(incoming: string | undefined, existing: string | undefined): string {
  if (incoming === undefined || incoming === null) return existing ?? '';
  const t = String(incoming).trim();
  return t !== '' ? String(incoming) : existing ?? '';
}

function preserveOptionalNumber(incoming: number | undefined, existing: number | undefined): number | undefined {
  if (incoming === undefined || incoming === null) return existing;
  if (typeof incoming === 'number' && Number.isFinite(incoming)) return incoming;
  return existing;
}

/** Normalize one age band from AI (strings → numbers, msrp derived, preserve existing ids/dates). */
export function normalizeAgeBand(incoming: Partial<AgeBand>, existing?: AgeBand): AgeBand {
  const base: AgeBand = existing ?? {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    tobaccoStatus: 'N/A',
    minAge: 0,
    maxAge: 65,
    netRate: 0,
    overrideRate: 0,
    commission: 0,
    systemFees: 0,
    msrpRate: 0,
    affiliateRate: 0,
    locked: false,
    effectiveDate: todayIsoDate(),
    terminationDate: null,
    configValue1: '',
    configValue2: '',
    configValue3: '',
    configValue4: '',
    configValue5: '',
    productPricingId: null,
    overrides: [],
  };

  const netRate = parseAiNumber(incoming.netRate ?? base.netRate);
  const overrideRate = parseAiNumber(incoming.overrideRate ?? base.overrideRate);
  const commission = parseAiNumber(incoming.commission ?? base.commission);
  const systemFees = parseAiNumber(incoming.systemFees ?? base.systemFees);
  let msrpRate = parseAiNumber(incoming.msrpRate);
  const hasComponents = overrideRate > 0 || commission > 0;
  if (hasComponents) {
    msrpRate = netRate + overrideRate + commission;
  } else if (!msrpRate || (incoming.msrpRate === undefined && incoming.netRate !== undefined)) {
    msrpRate = netRate + overrideRate + commission;
  }
  const affiliateRate =
    parseAiNumber(incoming.affiliateRate) || netRate + overrideRate;

  return {
    ...base,
    id: String(incoming.id ?? base.id),
    tobaccoStatus: String(incoming.tobaccoStatus ?? base.tobaccoStatus ?? 'N/A'),
    minAge: parseAiNumber(incoming.minAge ?? base.minAge),
    maxAge: parseAiNumber(incoming.maxAge ?? base.maxAge),
    netRate,
    overrideRate,
    commission,
    systemFees,
    msrpRate,
    affiliateRate,
    includedProcessingFee: preserveOptionalNumber(
      incoming.includedProcessingFee,
      base.includedProcessingFee
    ),
    effectiveDate:
      incoming.effectiveDate !== undefined
        ? incoming.effectiveDate
        : base.effectiveDate ?? todayIsoDate(),
    terminationDate:
      incoming.terminationDate !== undefined ? incoming.terminationDate : base.terminationDate,
    configValue1: preserveConfigField(incoming.configValue1, base.configValue1),
    configValue2: preserveConfigField(incoming.configValue2, base.configValue2),
    configValue3: preserveConfigField(incoming.configValue3, base.configValue3),
    configValue4: preserveConfigField(incoming.configValue4, base.configValue4),
    configValue5: preserveConfigField(incoming.configValue5, base.configValue5),
    configField1: incoming.configField1 ?? base.configField1,
    configField2: incoming.configField2 ?? base.configField2,
    configField3: incoming.configField3 ?? base.configField3,
    configField4: incoming.configField4 ?? base.configField4,
    configField5: incoming.configField5 ?? base.configField5,
    locked: incoming.locked ?? base.locked ?? false,
    productPricingId: incoming.productPricingId ?? base.productPricingId ?? null,
    overrides: incoming.overrides ?? base.overrides ?? [],
  };
}

/** Drop single-age bands (e.g. 48-48) when the tier also has normal multi-year ranges. */
export function stripStraySingletonAgeBands(bands: Partial<AgeBand>[]): Partial<AgeBand>[] {
  if (bands.length <= 1) return bands;
  const hasWideBand = bands.some(
    (b) => parseAiNumber(b.maxAge) - parseAiNumber(b.minAge) >= 2
  );
  if (!hasWideBand) return bands;
  return bands.filter((b) => parseAiNumber(b.minAge) !== parseAiNumber(b.maxAge));
}

/** Config-value fingerprint so bands that differ ONLY by configValue1-5 are distinct variations. */
export function bandConfigSignature(b: Partial<AgeBand>): string {
  return [b.configValue1, b.configValue2, b.configValue3, b.configValue4, b.configValue5]
    .map((v) => (v == null ? '' : String(v).trim()))
    .join('|');
}

function bandHasConfigValues(b: Partial<AgeBand>): boolean {
  return bandConfigSignature(b).replace(/\|/g, '') !== '';
}

/**
 * Find the existing band an incoming patch band should update.
 * Match priority: explicit id → same age+tobacco+config signature → (config-less incoming) the sole
 * age+tobacco band. When the incoming band carries config values that no existing band shares, return
 * undefined so it is treated as a NEW configuration variation (e.g. same EE 40-50 N/A with $2000 vs $3500).
 */
function findExistingBandMatch(
  existing: AgeBand[],
  raw: Partial<AgeBand>,
  usedIds?: Set<string>
): AgeBand | undefined {
  const available = (b: AgeBand) => !usedIds || !usedIds.has(String(b.id));

  if (raw.id != null) {
    const byId = existing.find((b) => String(b.id) === String(raw.id) && available(b));
    if (byId) return byId;
  }

  const minAge = parseAiNumber(raw.minAge);
  const maxAge = parseAiNumber(raw.maxAge);
  const tobacco = raw.tobaccoStatus != null ? String(raw.tobaccoStatus) : 'N/A';
  const ageTobaccoMatches = existing.filter(
    (b) =>
      available(b) &&
      b.minAge === minAge &&
      b.maxAge === maxAge &&
      (b.tobaccoStatus || 'N/A') === tobacco
  );
  if (ageTobaccoMatches.length === 0) return undefined;

  const rawSignature = bandConfigSignature(raw);
  const exact = ageTobaccoMatches.find((b) => bandConfigSignature(b) === rawSignature);
  if (exact) return exact;

  // Incoming names config values not present on any existing band → new variation, do not overwrite.
  if (bandHasConfigValues(raw)) return undefined;

  // Incoming has no config: safe to update only when there is a single age+tobacco band (rate-only edit).
  return ageTobaccoMatches.length === 1 ? ageTobaccoMatches[0] : undefined;
}

/** Apply AI age bands: REPLACE listed bands only (omitted bands are removed). Preserves ids by match. */
export function applyAiAgeBands(existing: AgeBand[], incoming: Partial<AgeBand>[]): AgeBand[] {
  if (!incoming?.length) return existing;

  const cleanedIncoming = stripStraySingletonAgeBands(incoming);
  const result: AgeBand[] = [];
  const usedIds = new Set<string>();
  for (const raw of cleanedIncoming) {
    const match = findExistingBandMatch(existing, raw, usedIds);
    if (match) usedIds.add(String(match.id));
    const band = normalizeAgeBand(raw, match);
    result.push(match ? { ...band, id: match.id } : band);
  }
  return result;
}

/** Spreadsheet "ES/EC" combined row → separate ES and EC pricing tiers (same rates). */
export function expandCombinedSpreadsheetTiers(
  tiers: Partial<PricingTier>[]
): Partial<PricingTier>[] {
  const out: Partial<PricingTier>[] = [];

  for (const tier of tiers) {
    const ttRaw = String(tier.tierType || '');
    const tt = ttRaw.toUpperCase().replace(/\s+/g, '');
    const label = String(tier.label || '');
    const combined =
      tt === 'ES/EC' ||
      tt === 'ES_EC' ||
      tt === 'ESEC' ||
      /ES\s*\/\s*EC/i.test(ttRaw) ||
      /ES\s*\/\s*EC/i.test(label);

    if (combined && Array.isArray(tier.ageBands) && tier.ageBands.length > 0) {
      const bands = tier.ageBands;
      out.push({
        ...tier,
        id: undefined,
        tierType: 'ES',
        label: 'Employee + Spouse (ES)',
        ageBands: bands.map((b) => ({ ...b, id: undefined })),
      });
      out.push({
        ...tier,
        tierType: 'EC',
        label: 'Employee + Child(ren) (EC)',
        ageBands: bands.map((b) => ({ ...b, id: undefined })),
      });
    } else {
      out.push(tier);
    }
  }

  return out;
}

/**
 * When AI wrongly stacks ES+EC rates as duplicate age ranges in one tier (e.g. 4 bands:
 * 18-39, 40-65, 18-39, 40-65), split into separate ES and EC tiers.
 */
export function splitStackedEsEcAgeBands(
  tiers: Partial<PricingTier>[]
): Partial<PricingTier>[] {
  const out: Partial<PricingTier>[] = [];

  for (const tier of tiers) {
    const bands = Array.isArray(tier.ageBands) ? tier.ageBands : [];
    const naBands = bands.filter((b) => !b.tobaccoStatus || b.tobaccoStatus === 'N/A');

    if (naBands.length < 4) {
      out.push(tier);
      continue;
    }

    const byRange = new Map<string, Partial<AgeBand>[]>();
    for (const b of naBands) {
      const key = `${parseAiNumber(b.minAge)}-${parseAiNumber(b.maxAge)}`;
      if (!byRange.has(key)) byRange.set(key, []);
      byRange.get(key)!.push(b);
    }

    const doubled = [...byRange.values()].every((arr) => arr.length === 2);
    const tierType = String(tier.tierType || '').toUpperCase();

    if (doubled && byRange.size >= 2 && (tierType === 'EC' || tierType === 'ES' || tierType === 'ES/EC')) {
      const sortedKeys = [...byRange.keys()].sort((a, b) => {
        const [aMin] = a.split('-').map(Number);
        const [bMin] = b.split('-').map(Number);
        return aMin - bMin;
      });
      const esBands = sortedKeys.map((k) => byRange.get(k)![0]);
      const ecBands = sortedKeys.map((k) => byRange.get(k)![1]);
      out.push({
        ...tier,
        id: undefined,
        tierType: 'ES',
        label: 'Employee + Spouse (ES)',
        ageBands: esBands.map((b) => normalizeAgeBand(b)),
      });
      out.push({
        ...tier,
        tierType: 'EC',
        label: 'Employee + Child(ren) (EC)',
        ageBands: ecBands.map((b) => normalizeAgeBand(b)),
      });
    } else {
      out.push(tier);
    }
  }

  return out;
}

/**
 * Merge age bands by id, then age/tobacco + config match; keep unchanged bands.
 * Bands sharing age/tobacco but differing by configValue1-5 are kept as separate variations.
 */
export function mergeAgeBands(existing: AgeBand[], incoming: Partial<AgeBand>[]): AgeBand[] {
  if (!incoming?.length) return existing;

  const merged: AgeBand[] = [];
  const processedIds = new Set<string>();

  for (const raw of incoming) {
    const match = findExistingBandMatch(existing, raw, processedIds);
    if (match) {
      const band = normalizeAgeBand(raw, match);
      merged.push({ ...band, id: match.id });
      processedIds.add(String(match.id));
    } else {
      merged.push(normalizeAgeBand(raw));
    }
  }

  for (const band of existing) {
    if (!processedIds.has(String(band.id))) {
      merged.push(band);
    }
  }

  return merged;
}

/** Match patch tier to one existing row when ids are missing (phase-in may duplicate tierType). */
function findExistingTierForPatch(
  incoming: Partial<PricingTier>,
  existingTiers: PricingTier[],
  processedIds: Set<string>
): PricingTier | null {
  const patchId = incoming.id != null ? String(incoming.id) : '';
  if (patchId) {
    const byId = existingTiers.find((t) => String(t.id) === patchId);
    if (byId) return byId;
  }

  const available = existingTiers.filter((t) => {
    const eid = t.id ? String(t.id) : '';
    return !eid || !processedIds.has(eid);
  });

  if (incoming.label) {
    const byLabel = available.find((t) => t.label === incoming.label);
    if (byLabel) return byLabel;
  }

  const tierType =
    incoming.tierType && incoming.tierType !== 'N/A' ? String(incoming.tierType) : '';
  if (!tierType) return null;

  const sameType = available.filter((t) => t.tierType === tierType);
  if (sameType.length === 0) return null;
  if (sameType.length === 1) return sameType[0];

  const patchBandIds = new Set(
    (incoming.ageBands || [])
      .map((b) => (b.id != null ? String(b.id) : ''))
      .filter(Boolean)
  );
  if (patchBandIds.size > 0) {
    const byBandId = sameType.find((t) =>
      (t.ageBands || []).some((b) => patchBandIds.has(String(b.id)))
    );
    if (byBandId) return byBandId;
  }

  const withActiveBands = sameType.filter((t) => pickSourceBandsForTier(t).length > 0);
  if (withActiveBands.length === 1) return withActiveBands[0];

  const sorted = [...sameType].sort((a, b) =>
    latestTierEffectiveDate(b).localeCompare(latestTierEffectiveDate(a))
  );
  return sorted[0] || null;
}

function resolveTierLabel(incoming: Partial<PricingTier>, existing?: PricingTier): string {
  const inc = incoming.label != null ? String(incoming.label).trim() : '';
  const base = existing?.label?.trim() || '';
  if (!inc || isGenericAiTierLabel(inc)) return base || inc;
  return inc;
}

function normalizePricingTier(incoming: Partial<PricingTier>, existing?: PricingTier): PricingTier {
  const base: PricingTier = existing ?? {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    tierType: '',
    label: '',
    ageBands: [],
  };

  const rawBands = Array.isArray(incoming.ageBands) ? incoming.ageBands : [];
  let ageBands = base.ageBands;
  if (rawBands.length > 0) {
    const bandsForApply = stripStraySingletonAgeBands(rawBands as Partial<AgeBand>[]);
    ageBands = existing
      ? mergeAgeBands(base.ageBands, bandsForApply)
      : bandsForApply.map((b) => normalizeAgeBand(b as Partial<AgeBand>));
  }

  return {
    ...base,
    id: String(incoming.id ?? base.id),
    tierType:
      incoming.tierType && incoming.tierType !== 'N/A'
        ? String(incoming.tierType)
        : base.tierType,
    label: resolveTierLabel(incoming, existing),
    ageBands,
  };
}

/** Coerce patch shape before preview/apply (AI often sends string amounts or snapshot keys). */
export function normalizeProductAiPatch(patch: Partial<ProductFormData>): Partial<ProductFormData> {
  const out: Partial<ProductFormData> = { ...patch };

  for (const key of IGNORED_AI_PATCH_FIELDS) {
    delete (out as Record<string, unknown>)[key];
  }

  if (patch.manualIncludedProcessingFee !== undefined) {
    out.manualIncludedProcessingFee =
      patch.manualIncludedProcessingFee === true ||
      String(patch.manualIncludedProcessingFee).toLowerCase() === 'true';
    if (out.manualIncludedProcessingFee) {
      out.includeProcessingFee = true;
      out.roundUpProcessingFee = false;
      out.processingFeePercentage = null;
    }
  }
  if (patch.includeProcessingFee !== undefined) {
    out.includeProcessingFee =
      patch.includeProcessingFee === true || String(patch.includeProcessingFee).toLowerCase() === 'true';
  }
  if (patch.roundUpProcessingFee !== undefined) {
    const v = patch.roundUpProcessingFee;
    out.roundUpProcessingFee =
      v !== false && String(v).toLowerCase() !== 'false';
  }
  if (patch.processingFeePercentage !== undefined) {
    const rawPct = patch.processingFeePercentage as unknown;
    if (rawPct === null || rawPct === '') {
      out.processingFeePercentage = null;
    } else {
      const n = parseAiNumber(rawPct);
      out.processingFeePercentage = Number.isFinite(n) ? n : null;
    }
  }

  if (Array.isArray(patch.pricingTiers)) {
    const expanded = expandCombinedSpreadsheetTiers(patch.pricingTiers as Partial<PricingTier>[]);
    const repaired = splitStackedEsEcAgeBands(expanded);
    out.pricingTiers = repaired.map((t) => {
      const partial = t as Partial<PricingTier>;
      const bands = stripStraySingletonAgeBands(
        Array.isArray(partial.ageBands) ? partial.ageBands : []
      );
      return normalizePricingTier({ ...partial, ageBands: bands.map((b) => normalizeAgeBand(b)) });
    });
  }

  return out;
}

/** Human-readable summary after Apply for wizard banner. */
export function buildProductAiApplySummary(
  before: ProductFormData,
  after: ProductFormData,
  patch: Partial<ProductFormData>
): string[] {
  const normalized = normalizeProductAiPatch(patch);
  const messages: string[] = [];

  if (normalized.pricingTiers !== undefined) {
    const tiersChanged = JSON.stringify(before.pricingTiers) !== JSON.stringify(after.pricingTiers);
    if (tiersChanged) {
      const bandCount = after.pricingTiers.reduce((n, t) => n + (t.ageBands?.length || 0), 0);
      messages.push(
        `Updated pricing (${after.pricingTiers.length} tier(s), ${bandCount} age band(s)) — save product changes to implement the changes`
      );
    } else {
      messages.push('Pricing patch had no effect — proposal may have been missing age bands or rates');
    }
  }

  if (
    normalized.manualIncludedProcessingFee !== undefined &&
    before.manualIncludedProcessingFee !== after.manualIncludedProcessingFee
  ) {
    messages.push(`Manual included fee entry: ${after.manualIncludedProcessingFee ? 'On' : 'Off'}`);
  }
  if (
    normalized.includeProcessingFee !== undefined &&
    before.includeProcessingFee !== after.includeProcessingFee
  ) {
    messages.push(`Include processing fee: ${after.includeProcessingFee ? 'On' : 'Off'}`);
  }
  if (
    normalized.roundUpProcessingFee !== undefined &&
    before.roundUpProcessingFee !== after.roundUpProcessingFee
  ) {
    messages.push(`Round up fee: ${after.roundUpProcessingFee !== false ? 'On' : 'Off'}`);
  }
  if (
    normalized.processingFeePercentage !== undefined &&
    before.processingFeePercentage !== after.processingFeePercentage
  ) {
    messages.push(
      `Processing fee %: ${after.processingFeePercentage != null ? after.processingFeePercentage : 'tenant default'}`
    );
  }

  const otherFields = Object.keys(normalized).filter(
    (k) =>
      !IGNORED_AI_PATCH_FIELDS.has(k) &&
      !['pricingTiers', 'manualIncludedProcessingFee', 'includeProcessingFee', 'roundUpProcessingFee', 'processingFeePercentage'].includes(k)
  );
  if (otherFields.length > 0) {
    messages.push(`Also updated: ${otherFields.map(formatFieldLabel).join(', ')}`);
  }

  if (messages.length > 0 && !messages.some((m) => m.includes('save product changes'))) {
    messages.push('Save product changes to implement the changes');
  }

  return messages;
}

/** Compare patch to current form data; returns human-readable field paths. */
export function getChangedFields(
  oldData: ProductFormData,
  newData: Partial<ProductFormData>
): ProductFieldChange[] {
  const changes: ProductFieldChange[] = [];
  const normalized = normalizeProductAiPatch(newData);

  const compareValue = (oldVal: unknown, newVal: unknown, path: string = '') => {
    if (newVal === undefined) return;

    if (IGNORED_AI_PATCH_FIELDS.has(path)) return;

    if (newVal === null && oldVal !== null) {
      changes.push({ field: path, oldValue: oldVal, newValue: null });
      return;
    }

    if (Array.isArray(newVal)) {
      const oldArray = Array.isArray(oldVal) ? oldVal : [];
      if (JSON.stringify(oldArray) !== JSON.stringify(newVal)) {
        changes.push({ field: path, oldValue: oldArray, newValue: newVal });
      }
      return;
    }

    if (typeof newVal === 'object' && newVal !== null && !Array.isArray(newVal)) {
      const oldObj =
        typeof oldVal === 'object' && oldVal !== null && !Array.isArray(oldVal)
          ? (oldVal as Record<string, unknown>)
          : {};
      Object.keys(newVal as Record<string, unknown>).forEach((key) => {
        compareValue(
          oldObj[key],
          (newVal as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key
        );
      });
      return;
    }

    if (oldVal !== newVal) {
      changes.push({ field: path, oldValue: oldVal, newValue: newVal });
    }
  };

  Object.keys(normalized).forEach((key) => {
    if (IGNORED_AI_PATCH_FIELDS.has(key)) return;

    const typedKey = key as keyof ProductFormData;
    if (typedKey in oldData) {
      compareValue(oldData[typedKey], normalized[typedKey], key);
    } else {
      changes.push({ field: key, oldValue: undefined, newValue: normalized[typedKey] });
    }
  });

  return changes;
}

/** Merge pricing tiers by id (fallback: label, then active cohort for duplicate tierType). */
export function mergePricingTiers(
  existingTiers: PricingTier[],
  newTiers: PricingTier[]
): PricingTier[] {
  if (!newTiers || newTiers.length === 0) return existingTiers;

  const mergedTiers: PricingTier[] = [];
  const processedIds = new Set<string>();

  for (const rawTier of newTiers) {
    const matchedExistingTier = findExistingTierForPatch(rawTier, existingTiers, processedIds);

    const merged = normalizePricingTier(rawTier, matchedExistingTier ?? undefined);
    if (matchedExistingTier) {
      merged.id = matchedExistingTier.id;
      processedIds.add(String(matchedExistingTier.id));
    }
    mergedTiers.push(merged);
  }

  for (const existingTier of existingTiers) {
    const eid = existingTier.id ? String(existingTier.id) : '';
    if (eid && processedIds.has(eid)) continue;
    mergedTiers.push(existingTier);
  }

  return mergedTiers;
}

/** Apply AI patch into wizard form data (media guards + tier merge). */
export function applyProductAiPatch(
  formData: ProductFormData,
  patch: Partial<ProductFormData>
): ProductFormData {
  const filteredUpdates = normalizeProductAiPatch({ ...patch });
  for (const key of IGNORED_AI_PATCH_FIELDS) {
    delete (filteredUpdates as Record<string, unknown>)[key];
  }

  let updatedData: ProductFormData = {
    ...formData,
    ...filteredUpdates,
    vendorId: filteredUpdates.vendorId || formData.vendorId,
    productOwnerId: filteredUpdates.productOwnerId || formData.productOwnerId,
    productImageFile:
      filteredUpdates.productImageFile !== undefined
        ? filteredUpdates.productImageFile
        : formData.productImageFile,
    productLogoFile:
      filteredUpdates.productLogoFile !== undefined
        ? filteredUpdates.productLogoFile
        : formData.productLogoFile,
    productDocumentFile:
      filteredUpdates.productDocumentFile !== undefined
        ? filteredUpdates.productDocumentFile
        : formData.productDocumentFile,
    productDocumentFiles:
      filteredUpdates.productDocumentFiles !== undefined
        ? filteredUpdates.productDocumentFiles
        : formData.productDocumentFiles,
    idCardLogoFile:
      filteredUpdates.idCardLogoFile !== undefined
        ? filteredUpdates.idCardLogoFile
        : formData.idCardLogoFile,
  };

  if (filteredUpdates.pricingTiers !== undefined) {
    updatedData.pricingTiers = mergePricingTiers(
      formData.pricingTiers,
      filteredUpdates.pricingTiers
    );
  }

  return updatedData;
}

/** Whether Apply should be enabled for this proposal. */
export function isProductPatchApplyable(
  formData: ProductFormData,
  patch: Partial<ProductFormData>
): boolean {
  const normalized = normalizeProductAiPatch(patch);
  if (Object.keys(normalized).length === 0) return false;
  if (!isPricingPatchApplyable(normalized)) return false;

  const changes = getChangedFields(formData, normalized).filter(
    (c) => !IGNORED_AI_PATCH_FIELDS.has(c.field)
  );
  if (changes.length > 0) return true;

  if (Array.isArray(normalized.pricingTiers) && normalized.pricingTiers.length > 0) {
    return isPricingPatchApplyable(normalized);
  }

  return (
    normalized.includeProcessingFee !== undefined ||
    normalized.roundUpProcessingFee !== undefined ||
    normalized.processingFeePercentage !== undefined
  );
}

/** Bands with net but no override or commission (spreadsheet Lyric/Agent Comp likely skipped). */
export function pricingPatchMissingComponents(tiers: PricingTier[]): boolean {
  if (!tiers?.length) return false;
  const bands = tiers.flatMap((t) => t.ageBands || []);
  if (bands.length === 0) return false;
  return bands.every(
    (b) =>
      (b.netRate || 0) > 0 &&
      (b.overrideRate || 0) === 0 &&
      (b.commission || 0) === 0
  );
}

/** True when patch pricing tiers include at least one band with dollar amounts. */
export function isPricingPatchApplyable(patch: Partial<ProductFormData>): boolean {
  const normalized = normalizeProductAiPatch(patch);
  if (!Array.isArray(normalized.pricingTiers) || normalized.pricingTiers.length === 0) {
    return true;
  }
  // Net-only pricing (override = commission = 0) is a valid configuration the user can
  // explicitly request ("everything in Net Rate"). Do NOT block Apply on it — only require
  // that bands have actual dollar amounts.
  return normalized.pricingTiers.some((t) =>
    (t.ageBands || []).some((b) => (b.netRate || 0) > 0 || (b.msrpRate || 0) > 0)
  );
}

/** Preview merged pricing tiers without mutating form state. */
export function previewMergedPricingTiers(
  existingTiers: PricingTier[],
  patchTiers: PricingTier[]
): PricingTier[] {
  return mergePricingTiers(existingTiers, patchTiers);
}

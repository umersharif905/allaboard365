import {
  parseEligibilityTemplateColumns,
  validateTemplatePlaceholders,
} from './eligibilityRowTemplate';
import type { VendorEligibilityFormSlice } from '../types/ai/eligibilityFormatAssistant.types';
import type { VendorImportRules } from '../types/vendor/vendorImportRules.types';
import { normalizeVendorImportRules } from './vendorImportRulesNormalize';

export type EligibilityFormatPatch = {
  eligibilityRowTemplate?: string;
  eligibilityDateFormat?: string;
  eligibilityIntegrationPartner?: string;
  importRules?: VendorImportRules | null;
};

export function normalizeEligibilityAiPatch(patch: EligibilityFormatPatch): EligibilityFormatPatch {
  const out: EligibilityFormatPatch = {};
  if (patch.eligibilityRowTemplate !== undefined) {
    const v = patch.eligibilityRowTemplate;
    if (Array.isArray(v)) {
      out.eligibilityRowTemplate = (v as string[]).map(String).join(',');
    } else {
      out.eligibilityRowTemplate = String(v).trim();
    }
  }
  if (patch.eligibilityDateFormat != null && String(patch.eligibilityDateFormat).trim()) {
    out.eligibilityDateFormat = String(patch.eligibilityDateFormat).trim();
  }
  if (patch.eligibilityIntegrationPartner !== undefined) {
    out.eligibilityIntegrationPartner = String(patch.eligibilityIntegrationPartner).trim();
  }
  if (patch.importRules !== undefined) {
    out.importRules = patch.importRules === null
      ? null
      : normalizeVendorImportRules(patch.importRules);
  }
  return out;
}

function columnSignature(template: string): string {
  const cols = parseEligibilityTemplateColumns(template);
  return cols
    .map((c) => `${c.placeholders.join('|')}:${c.headerLabel}`)
    .join(';');
}

export function hasEligibilityPatchDiff(
  formData: VendorEligibilityFormSlice,
  patch: EligibilityFormatPatch
): boolean {
  const normalized = normalizeEligibilityAiPatch(patch);
  if (Object.keys(normalized).length === 0) return false;

  if (normalized.eligibilityRowTemplate !== undefined) {
    const before = (formData.EligibilityRowTemplate || '').trim();
    const after = normalized.eligibilityRowTemplate.trim();
    if (columnSignature(before) !== columnSignature(after)) return true;
    if (before !== after) return true;
  }
  if (
    normalized.eligibilityDateFormat !== undefined &&
    (formData.EligibilityDateFormat || 'ARM') !== normalized.eligibilityDateFormat
  ) {
    return true;
  }
  if (
    normalized.eligibilityIntegrationPartner !== undefined &&
    (formData.EligibilityIntegrationPartner || '').trim() !==
      normalized.eligibilityIntegrationPartner.trim()
  ) {
    return true;
  }
  if (normalized.importRules !== undefined) {
    const before = JSON.stringify(formData.ImportRules ?? null);
    const after = JSON.stringify(normalized.importRules);
    if (before !== after) return true;
  }
  return false;
}

export function buildEligibilityFormatSnapshot(
  formData: VendorEligibilityFormSlice
): {
  vendorId: string;
  vendorName?: string;
  eligibilityRowTemplate: string;
  eligibilityDateFormat: string;
  eligibilityIntegrationPartner: string;
  eligibilityPrimaryExportGrain: string;
  columnCount: number;
  columnHeaders: string[];
  invalidPlaceholders: string[];
  importRules: VendorImportRules | null;
} {
  const template = formData.EligibilityRowTemplate?.trim() || '';
  const columns = parseEligibilityTemplateColumns(template);
  return {
    vendorId: formData.Id || '',
    vendorName: formData.VendorName,
    eligibilityRowTemplate: template,
    eligibilityDateFormat: formData.EligibilityDateFormat || 'ARM',
    eligibilityIntegrationPartner: formData.EligibilityIntegrationPartner?.trim() || '',
    eligibilityPrimaryExportGrain:
      formData.EligibilityPrimaryExportGrain === 'SinglePrimaryRow'
        ? 'SinglePrimaryRow'
        : 'PerProduct',
    importRules: formData.ImportRules
      ? normalizeVendorImportRules(formData.ImportRules)
      : null,
    columnCount: columns.length,
    columnHeaders: columns.map((c) => c.headerLabel),
    invalidPlaceholders: validateTemplatePlaceholders(template),
  };
}

export function applyEligibilityPatchToFormData(
  formData: VendorEligibilityFormSlice,
  patch: EligibilityFormatPatch
): VendorEligibilityFormSlice {
  const normalized = normalizeEligibilityAiPatch(patch);
  const next = { ...formData };
  if (normalized.eligibilityRowTemplate !== undefined) {
    next.EligibilityRowTemplate = normalized.eligibilityRowTemplate;
  }
  if (normalized.eligibilityDateFormat !== undefined) {
    next.EligibilityDateFormat = normalized.eligibilityDateFormat;
  }
  if (normalized.eligibilityIntegrationPartner !== undefined) {
    next.EligibilityIntegrationPartner = normalized.eligibilityIntegrationPartner;
  }
  if (normalized.importRules !== undefined) {
    next.ImportRules = normalized.importRules;
  }
  return next;
}

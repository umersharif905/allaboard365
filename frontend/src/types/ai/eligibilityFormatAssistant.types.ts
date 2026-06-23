import type { EligibilityFormatPatch } from '../../utils/eligibilityFormatAiMerge';
import type { VendorImportRules } from '../vendor/vendorImportRules.types';

export type AISetupProductSuggestion = {
  id: string;
  label: string;
  suggestedTargetProductId?: string | null;
  matchConfidence?: 'high' | 'medium' | 'low';
  keyStrategyType?: string;
  sampleSourceValues?: string[];
};

export type AIKeyTierPairingSuggestion = {
  sourceKey: string;
  suggestedProductPricingId?: string | null;
  sampleRows?: number;
  importProductLabel?: string | null;
};

export type AIEligibilityFormatReply =
  | { kind: 'question'; text: string }
  | {
      kind: 'proposal';
      summary: string;
      patch: EligibilityFormatPatch;
      warnings?: string[];
      hasEffectiveDiff?: boolean;
    }
  | {
      kind: 'setupProposal';
      summary: string;
      products: AISetupProductSuggestion[];
      keyTierPairings: AIKeyTierPairingSuggestion[];
      patch?: EligibilityFormatPatch;
      warnings?: string[];
    }
  | { kind: 'error'; text: string };

export type EligibilityFormatChatMessage =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; kind: 'question'; text: string }
  | { id: string; role: 'assistant'; kind: 'streaming'; text: string }
  | { id: string; role: 'assistant'; kind: 'proposal'; reply: Extract<AIEligibilityFormatReply, { kind: 'proposal' }> }
  | { id: string; role: 'assistant'; kind: 'setupProposal'; reply: Extract<AIEligibilityFormatReply, { kind: 'setupProposal' }> }
  | { id: string; role: 'assistant'; kind: 'error'; text: string }
  | { id: string; role: 'assistant'; kind: 'system'; text: string };

export type EligibilityFormatSnapshot = {
  vendorId: string;
  vendorName?: string;
  eligibilityRowTemplate: string;
  eligibilityDateFormat: string;
  eligibilityIntegrationPartner: string;
  eligibilityPrimaryExportGrain: string;
  columnCount: number;
  columnHeaders: string[];
  invalidPlaceholders: string[];
  importRules?: VendorImportRules | null;
};

export type EligibilityFormatAiSessionPayload = {
  messages: EligibilityFormatChatMessage[];
  sessionDocExtract?: string;
  updatedAt: number;
};

export type VendorEligibilityFormSlice = {
  Id?: string;
  VendorName?: string;
  EligibilityRowTemplate?: string;
  EligibilityDateFormat?: string;
  EligibilityIntegrationPartner?: string;
  EligibilityPrimaryExportGrain?: string;
  ImportRules?: VendorImportRules | null;
};

export type EligibilityFormatAIAssistantProps = {
  open: boolean;
  onClose: () => void;
  formData: VendorEligibilityFormSlice;
  storageKey: string;
  onApplyPatch: (patch: EligibilityFormatPatch) => void;
};

export type EligibilityTemplatePreviewColumn = {
  index: number;
  placeholders: string[];
  headerLabel: string;
  modifiers?: string[];
};

export type EligibilityTemplatePreviewResponse = {
  success: boolean;
  columns: EligibilityTemplatePreviewColumn[];
  csv?: string;
  rows?: string[][];
  parseErrors?: string[];
  usesDefaultColumns?: boolean;
  rowCount?: number;
  message?: string;
};

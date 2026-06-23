import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  FileSpreadsheet,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';
import EligibilityFormatAIAssistant from '../../ai/EligibilityFormatAIAssistant';
import FormatBuilderCard from './FormatBuilderCard';
import ImportRulesEditor from './ImportRulesEditor';
import TobaccoDetectionConfig from './TobaccoDetectionConfig';
import VendorImportProductMappingPanel from './VendorImportProductMappingPanel';
import { apiService } from '../../../services/api.service';
import { applyEligibilityPatchToFormData } from '../../../utils/eligibilityFormatAiMerge';
import { eligibilityAiChatStorageKey } from '../../../utils/eligibilityFormatAiSession';
import { ELIGIBILITY_DATE_FORMAT_OPTIONS } from '../../../constants/eligibilityDateFormats';
import {
  AB365_OPTIONAL_MULTI_PRODUCT_TEMPLATE,
  getEligibilityTemplateErrors,
  SHAREWELL_24_COLUMN_TEMPLATE,
} from '../../../utils/eligibilityRowTemplate';
import type { FormatPreset } from '../../../types/vendor/vendorSftpImport.types';
import type { VendorImportRules } from '../../../types/vendor/vendorImportRules.types';
import { DEFAULT_VENDOR_IMPORT_RULES } from '../../../types/vendor/vendorImportRules.types';
import { normalizeVendorImportRules } from '../../../utils/vendorImportRulesNormalize';
import { defaultTobaccoColumnFromTemplate } from '../../../utils/formatPresetTobacco';

interface EligibilityFormatConfig {
  vendorId: string;
  vendorName: string;
  eligibilityDateFormat: string;
  eligibilityIntegrationPartner: string;
  defaultEligibilityFormatSlug: string;
}

interface Props {
  vendorId: string;
}

const selectClass =
  'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-oe-primary/30 focus:border-oe-primary';

const TEMPLATE_STARTERS = [
  { label: 'ShareWELL 24-col', template: SHAREWELL_24_COLUMN_TEMPLATE },
  { label: 'AB365 multi-product', template: AB365_OPTIONAL_MULTI_PRODUCT_TEMPLATE },
];

const VendorImportFormatsPanel: React.FC<Props> = ({ vendorId }) => {
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [config, setConfig] = useState<EligibilityFormatConfig | null>(null);
  const [selectedPresetSlug, setSelectedPresetSlug] = useState<string>('sharewell_default');
  const [dateFormat, setDateFormat] = useState('Padded');
  const [integrationPartner, setIntegrationPartner] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const [builderLabel, setBuilderLabel] = useState('');
  const [builderTemplate, setBuilderTemplate] = useState('');
  const [builderImportRules, setBuilderImportRules] = useState<VendorImportRules>(
    DEFAULT_VENDOR_IMPORT_RULES,
  );
  const [newImportRules, setNewImportRules] = useState<VendorImportRules>(DEFAULT_VENDOR_IMPORT_RULES);
  const [builderTobaccoCsvColumn, setBuilderTobaccoCsvColumn] = useState('Tobacco Surcharge');
  const [builderTobaccoYesValues, setBuilderTobaccoYesValues] = useState<string[]>([]);
  const [newTobaccoCsvColumn, setNewTobaccoCsvColumn] = useState('Tobacco Surcharge');
  const [newTobaccoYesValues, setNewTobaccoYesValues] = useState<string[]>([]);
  const [presetSaving, setPresetSaving] = useState(false);

  const [newSlug, setNewSlug] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newTemplate, setNewTemplate] = useState(SHAREWELL_24_COLUMN_TEMPLATE);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [presetsRes, configRes] = await Promise.all([
        apiService.get<{ success: boolean; data: FormatPreset[] }>('/api/me/vendor/import/format-presets'),
        apiService.get<{ success: boolean; data: EligibilityFormatConfig }>('/api/me/vendor/import/eligibility-format'),
      ]);
      if (presetsRes.success) setPresets(presetsRes.data || []);
      if (configRes.success && configRes.data) {
        setConfig(configRes.data);
        setDateFormat(configRes.data.eligibilityDateFormat || 'Padded');
        setIntegrationPartner(configRes.data.eligibilityIntegrationPartner || '');
        setSelectedPresetSlug(configRes.data.defaultEligibilityFormatSlug || 'sharewell_default');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load formats');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedPreset = presets.find((p) => p.slug === selectedPresetSlug);

  const syncBuilderFromPreset = useCallback((preset: FormatPreset | undefined) => {
    if (!preset) return;
    setBuilderLabel(preset.label);
    setBuilderTemplate(preset.template?.trim() || SHAREWELL_24_COLUMN_TEMPLATE);
    setBuilderImportRules(
      normalizeVendorImportRules(preset.importRules ?? DEFAULT_VENDOR_IMPORT_RULES),
    );
    const template = preset.template?.trim() || SHAREWELL_24_COLUMN_TEMPLATE;
    setBuilderTobaccoCsvColumn(
      preset.tobaccoCsvColumn || defaultTobaccoColumnFromTemplate(template),
    );
    setBuilderTobaccoYesValues(preset.tobaccoYesValues || []);
  }, []);

  useEffect(() => {
    if (createOpen) return;
    syncBuilderFromPreset(selectedPreset);
  }, [selectedPresetSlug, presets, createOpen, selectedPreset, syncBuilderFromPreset]);

  const builderTemplateErrors = useMemo(
    () => getEligibilityTemplateErrors(builderTemplate),
    [builderTemplate]
  );

  const newTemplateErrors = useMemo(
    () => getEligibilityTemplateErrors(newTemplate),
    [newTemplate]
  );

  const builderDirty = useMemo(() => {
    if (!selectedPreset) return false;
    const savedT = selectedPreset.template?.trim() || SHAREWELL_24_COLUMN_TEMPLATE;
    const savedRules = JSON.stringify(
      normalizeVendorImportRules(selectedPreset.importRules ?? DEFAULT_VENDOR_IMPORT_RULES),
    );
    const editRules = JSON.stringify(normalizeVendorImportRules(builderImportRules));
    const savedTobaccoCol = selectedPreset.tobaccoCsvColumn || '';
    const savedTobaccoYes = JSON.stringify(selectedPreset.tobaccoYesValues || []);
    return (
      builderLabel.trim() !== selectedPreset.label
      || builderTemplate.trim() !== savedT
      || savedRules !== editRules
      || builderTobaccoCsvColumn !== savedTobaccoCol
      || JSON.stringify(builderTobaccoYesValues) !== savedTobaccoYes
    );
  }, [
    selectedPreset,
    builderLabel,
    builderTemplate,
    builderImportRules,
    builderTobaccoCsvColumn,
    builderTobaccoYesValues,
  ]);

  const handlePresetChange = (slug: string) => {
    setSelectedPresetSlug(slug);
    setCreateOpen(false);
  };

  const saveVendorDefaults = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await apiService.put<{ success: boolean; message?: string }>(
        '/api/me/vendor/import/eligibility-format',
        {
          eligibilityDateFormat: dateFormat,
          eligibilityIntegrationPartner: integrationPartner.trim() || null,
          defaultEligibilityFormatSlug: selectedPresetSlug,
        }
      );
      if (res.success) setSaved(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const saveFormatBuilder = async () => {
    if (!selectedPreset || builderTemplateErrors.length) return;
    setPresetSaving(true);
    setError(null);
    try {
      const res = await apiService.put<{ success: boolean; message?: string }>(
        `/api/me/vendor/import/format-presets/${encodeURIComponent(selectedPreset.slug)}`,
        {
          label: builderLabel.trim(),
          rowTemplate: builderTemplate.trim(),
          importRules: normalizeVendorImportRules(builderImportRules),
          tobaccoCsvColumn: builderTobaccoCsvColumn,
          tobaccoYesValues: builderTobaccoYesValues,
        }
      );
      if (!res.success) throw new Error(res.message || 'Save failed');
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save format');
    } finally {
      setPresetSaving(false);
    }
  };

  const deleteSelectedPreset = async () => {
    if (!selectedPreset) return;
    if (!window.confirm(`Remove format "${selectedPreset.label}"? Scheduled jobs using it must be changed first.`)) return;
    setError(null);
    try {
      const res = await apiService.delete<{ success: boolean; message?: string }>(
        `/api/me/vendor/import/format-presets/${encodeURIComponent(selectedPreset.slug)}`
      );
      if (!res.success) throw new Error(res.message || 'Delete failed');
      if (selectedPresetSlug === selectedPreset.slug) setSelectedPresetSlug('sharewell_default');
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to remove format');
    }
  };

  const saveTobaccoToPreset = async () => {
    if (!selectedPreset) return;
    setPresetSaving(true);
    setError(null);
    try {
      const res = await apiService.put<{ success: boolean; message?: string }>(
        `/api/me/vendor/import/format-presets/${encodeURIComponent(selectedPreset.slug)}`,
        {
          tobaccoCsvColumn: builderTobaccoCsvColumn,
          tobaccoYesValues: builderTobaccoYesValues,
        },
      );
      if (!res.success) throw new Error(res.message || 'Save failed');
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save tobacco detection');
    } finally {
      setPresetSaving(false);
    }
  };

  const createPreset = async () => {
    if (newTemplateErrors.length || !newLabel.trim()) return;
    setPresetSaving(true);
    setError(null);
    try {
      const slug = newSlug.trim() || newLabel.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 50);
      const res = await apiService.post<{ success: boolean; message?: string; data?: FormatPreset }>(
        '/api/me/vendor/import/format-presets',
        {
          slug,
          label: newLabel.trim(),
          rowTemplate: newTemplate.trim(),
          importRules: normalizeVendorImportRules(newImportRules),
          tobaccoCsvColumn: newTobaccoCsvColumn,
          tobaccoYesValues: newTobaccoYesValues,
        }
      );
      if (!res.success) throw new Error(res.message || 'Create failed');
      setCreateOpen(false);
      setNewSlug('');
      setNewLabel('');
      await load();
      if (res.data?.slug) setSelectedPresetSlug(res.data.slug);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create format');
    } finally {
      setPresetSaving(false);
    }
  };

  const aiFormSlice = useMemo(
    () => ({
      Id: vendorId,
      VendorName: config?.vendorName,
      EligibilityRowTemplate: createOpen ? newTemplate : builderTemplate,
      EligibilityDateFormat: dateFormat,
      EligibilityIntegrationPartner: integrationPartner,
      ImportRules: createOpen ? newImportRules : builderImportRules,
    }),
    [
      vendorId,
      config?.vendorName,
      createOpen,
      newTemplate,
      builderTemplate,
      dateFormat,
      integrationPartner,
      newImportRules,
      builderImportRules,
    ]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-gray-500 gap-2">
        <Loader2 className="h-5 w-5 animate-spin text-oe-primary" />
        Loading import formats…
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-oe-light text-oe-primary shrink-0">
          <FileSpreadsheet className="h-6 w-6" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-gray-900">Import formats</h2>
          <p className="text-sm text-gray-600 mt-0.5">
            One template per carrier layout. Used by{' '}
            <button
              type="button"
              className="text-oe-primary hover:underline font-medium"
              onClick={() => {
                const el = document.querySelector('[data-import-tab="members"]');
                if (el instanceof HTMLElement) el.click();
              }}
            >
              Members import
            </button>{' '}
            and scheduled SFTP jobs. Plan code mapping stays on the Members tab.
          </p>
        </div>
      </div>

      <section className="bg-white border border-gray-200 rounded-xl shadow-soft p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Job defaults</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Default format</label>
            <div className="flex gap-2">
              <select
                className={`${selectClass} flex-1`}
                value={selectedPresetSlug}
                onChange={(e) => handlePresetChange(e.target.value)}
              >
                {presets.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="shrink-0 inline-flex items-center gap-1 px-3 py-2 text-sm font-medium border border-oe-primary text-oe-primary rounded-lg hover:bg-oe-light transition-colors"
              >
                <Plus className="h-4 w-4" /> New
              </button>
              <button
                type="button"
                onClick={() => void deleteSelectedPreset()}
                disabled={!selectedPreset}
                className="shrink-0 p-2 border border-gray-300 rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-40 transition-colors"
                title="Delete format"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Date format</label>
            <select className={selectClass} value={dateFormat} onChange={(e) => setDateFormat(e.target.value)}>
              {ELIGIBILITY_DATE_FORMAT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} — {opt.example}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Integration partner</label>
            <input
              type="text"
              className={selectClass}
              value={integrationPartner}
              onChange={(e) => setIntegrationPartner(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-4 pt-4 border-t border-gray-100">
          <button
            type="button"
            disabled={saving}
            onClick={() => void saveVendorDefaults()}
            className="px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save job defaults'}
          </button>
          {saved && (
            <span className="inline-flex items-center gap-1 text-sm text-green-700">
              <CheckCircle className="h-4 w-4" /> Saved
            </span>
          )}
        </div>
      </section>

      <section className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
        <h3 className="text-base font-semibold text-gray-900">Product & pricing tier mapping</h3>
        <p className="text-xs text-gray-500 mt-1 mb-4">
          Connect file plan codes to catalog tiers. Required after format presets extract keys like EE_1500 or ES_3000.
        </p>
        <VendorImportProductMappingPanel
          formatSlug={selectedPresetSlug}
          formatLabel={selectedPreset?.label}
          rowTemplate={selectedPreset?.template?.trim() || builderTemplate}
          tobaccoCsvColumn={builderTobaccoCsvColumn}
          tobaccoYesValues={builderTobaccoYesValues}
          onTobaccoChange={({ tobaccoCsvColumn, tobaccoYesValues }) => {
            setBuilderTobaccoCsvColumn(tobaccoCsvColumn);
            setBuilderTobaccoYesValues(tobaccoYesValues);
          }}
          onSaveTobacco={() => void saveTobaccoToPreset()}
          tobaccoSaving={presetSaving}
          importRules={normalizeVendorImportRules(
            selectedPreset?.importRules ?? DEFAULT_VENDOR_IMPORT_RULES,
          )}
        />
      </section>

      {createOpen ? (
        <FormatBuilderCard
          title="New import format"
          subtitle="Creates a separate preset you can assign to SFTP jobs"
          displayName={newLabel}
          onDisplayNameChange={setNewLabel}
          template={newTemplate}
          onTemplateChange={setNewTemplate}
          templateErrors={newTemplateErrors}
          saving={presetSaving}
          onSave={() => void createPreset()}
          onAi={() => setAiOpen(true)}
          saveLabel="Create format"
          starters={TEMPLATE_STARTERS}
          showSlugField
          slugValue={newSlug}
          onSlugChange={setNewSlug}
          rulesEditor={
            <>
              <ImportRulesEditor rules={newImportRules} onChange={setNewImportRules} disabled={presetSaving} />
              <TobaccoDetectionConfig
                rowTemplate={newTemplate}
                tobaccoCsvColumn={newTobaccoCsvColumn}
                tobaccoYesValues={newTobaccoYesValues}
                onChange={({ tobaccoCsvColumn, tobaccoYesValues }) => {
                  setNewTobaccoCsvColumn(tobaccoCsvColumn);
                  setNewTobaccoYesValues(tobaccoYesValues);
                }}
                disabled={presetSaving}
              />
            </>
          }
        />
      ) : selectedPreset ? (
        <FormatBuilderCard
          title="Format builder"
          subtitle="Column layout for this preset — Members import & SFTP use this when this format is selected"
          slug={selectedPreset.slug}
          displayName={builderLabel}
          onDisplayNameChange={setBuilderLabel}
          template={builderTemplate}
          onTemplateChange={setBuilderTemplate}
          templateErrors={builderTemplateErrors}
          dirty={builderDirty}
          saving={presetSaving}
          onSave={() => void saveFormatBuilder()}
          onRevert={() => syncBuilderFromPreset(selectedPreset)}
          onAi={() => setAiOpen(true)}
          starters={TEMPLATE_STARTERS}
          rulesEditor={
            <ImportRulesEditor
              rules={builderImportRules}
              onChange={setBuilderImportRules}
              disabled={presetSaving}
            />
          }
        />
      ) : null}

      {error && (
        <div className="flex items-center gap-2 p-3 text-red-800 bg-red-50 border border-red-200 rounded-lg text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      <EligibilityFormatAIAssistant
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        formData={aiFormSlice}
        storageKey={eligibilityAiChatStorageKey(vendorId)}
        onApplyPatch={(patch) => {
          const next = applyEligibilityPatchToFormData(aiFormSlice, patch);
          if (next.EligibilityRowTemplate !== undefined) {
            if (createOpen) setNewTemplate(next.EligibilityRowTemplate || '');
            else setBuilderTemplate(next.EligibilityRowTemplate || '');
          }
          if (next.EligibilityDateFormat !== undefined) setDateFormat(next.EligibilityDateFormat || 'Padded');
          if (next.EligibilityIntegrationPartner !== undefined) {
            setIntegrationPartner(next.EligibilityIntegrationPartner || '');
          }
          if (next.ImportRules !== undefined) {
            const rules = normalizeVendorImportRules(next.ImportRules ?? DEFAULT_VENDOR_IMPORT_RULES);
            if (createOpen) setNewImportRules(rules);
            else setBuilderImportRules(rules);
          }
        }}
      />
    </div>
  );
};

export default VendorImportFormatsPanel;

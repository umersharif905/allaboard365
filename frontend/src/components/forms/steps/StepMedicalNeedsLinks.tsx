import { ExternalLink, Plus, Stethoscope, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { apiService, withTenantScope } from '../../../services/api.service';
import type {
  MedicalNeedsLinkItem,
  MedicalNeedsLinksConfig,
  StepProps
} from '../../../types/sysadmin/addproductswizard.types';
import {
  MEDICAL_NEEDS_PRESETS,
  isMedicalNeedsHexColor,
  medicalNeedsButtonPresetClasses,
  medicalNeedsColorPickerValue,
  medicalNeedsPresetSwatchBg
} from '../../../utils/medicalNeedsLinkColors';
import {
  clampMedicalNeedsDisplayPriority,
  MEDICAL_NEEDS_PRIORITY_MAX
} from '../../../utils/medicalNeedsDisplayPriority';

function defaultConfig(): MedicalNeedsLinksConfig {
  return { categoryTitle: '', links: [], displayPriority: 1 };
}

function getConfig(formData: { medicalNeedsLinksConfig?: MedicalNeedsLinksConfig }): MedicalNeedsLinksConfig {
  const c = formData.medicalNeedsLinksConfig;
  if (!c || typeof c !== 'object') return defaultConfig();
  return {
    categoryTitle: typeof c.categoryTitle === 'string' ? c.categoryTitle : '',
    links: Array.isArray(c.links) ? c.links : [],
    displayPriority: clampMedicalNeedsDisplayPriority(
      'displayPriority' in c ? (c as MedicalNeedsLinksConfig).displayPriority : undefined
    )
  };
}

type FormTemplateOpt = { FormTemplateId: string; Title: string };

export default function StepMedicalNeedsLinks({ formData, updateFormData }: StepProps) {
  const { user } = useAuth();
  const tenantId = user?.currentTenantId || user?.tenantId || '';
  const config = getConfig(formData);
  const [templates, setTemplates] = useState<FormTemplateOpt[]>([]);
  const [templatesErr, setTemplatesErr] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    if (!tenantId) {
      setTemplates([]);
      return;
    }
    setTemplatesErr(null);
    try {
      const res = await apiService.get<{
        success: boolean;
        data?: FormTemplateOpt[];
      }>('/api/me/tenant-admin/public-forms/templates', withTenantScope(tenantId));
      if (res.success && Array.isArray(res.data)) {
        setTemplates(res.data);
      } else {
        setTemplates([]);
      }
    } catch (e: unknown) {
      setTemplatesErr(e instanceof Error ? e.message : 'Could not load tenant forms');
      setTemplates([]);
    }
  }, [tenantId]);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const updateRoot = (updates: Partial<MedicalNeedsLinksConfig>) => {
    const next = { ...getConfig(formData), ...updates };
    updateFormData({ medicalNeedsLinksConfig: next });
  };

  const addLink = () => {
    const links = [...config.links];
    const newLink: MedicalNeedsLinkItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      label: '',
      linkType: 'tenantForm',
      formTemplateId: templates[0]?.FormTemplateId ?? '',
      customUrl: '',
      buttonColor: 'teal'
    };
    updateRoot({ links: [...links, newLink] });
  };

  const updateLink = (id: string, updates: Partial<MedicalNeedsLinkItem>) => {
    const links = config.links.map((l) => (l.id === id ? { ...l, ...updates } : l));
    updateRoot({ links });
  };

  const removeLink = (id: string) => {
    updateRoot({ links: config.links.filter((l) => l.id !== id) });
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-oe-light p-2 shrink-0">
          <Stethoscope className="h-8 w-8 text-oe-primary" />
        </div>
        <div>
          <h3 className="text-xl font-semibold text-gray-900">Medical Needs Request Links</h3>
          <p className="text-sm text-gray-600 mt-1">
            Configure member portal buttons for this product. Each active enrollment can show these links under one category title.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Category title</label>
          <input
            type="text"
            value={config.categoryTitle}
            onChange={(e) => updateRoot({ categoryTitle: e.target.value })}
            placeholder="e.g. Sharing requests"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
          />
          <p className="text-xs text-gray-500 mt-1">Shown as the section label above all links for this product.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Section priority (member portal)</label>
          <select
            value={String(config.displayPriority)}
            onChange={(e) =>
              updateRoot({ displayPriority: clampMedicalNeedsDisplayPriority(parseInt(e.target.value, 10)) })
            }
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary bg-white"
          >
            {Array.from({ length: MEDICAL_NEEDS_PRIORITY_MAX }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Lower numbers appear first when a member has enrollments in multiple products with Medical Needs links.
          </p>
        </div>
      </div>

      {templatesErr ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {templatesErr} You can still use <strong>Custom link</strong> with an https URL.
        </div>
      ) : null}
      <div className="space-y-4">
        {config.links.map((link) => {
          const previewText = link.label.trim() || 'Button preview';
          const isHex = isMedicalNeedsHexColor(link.buttonColor);
          const presetCls = !isHex ? medicalNeedsButtonPresetClasses(link.buttonColor) : '';

          return (
            <div key={link.id} className="border border-gray-200 rounded-lg p-4 bg-gray-50 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Link title</label>
                  <input
                    type="text"
                    value={link.label}
                    onChange={(e) => updateLink(link.id, { label: e.target.value })}
                    placeholder="Button label"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Destination</label>
                  <select
                    value={link.linkType}
                    onChange={(e) =>
                      updateLink(link.id, {
                        linkType: e.target.value as MedicalNeedsLinkItem['linkType']
                      })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary bg-white"
                  >
                    <option value="tenantForm">Tenant form</option>
                    <option value="custom">Custom link (https)</option>
                  </select>
                </div>
              </div>

              {link.linkType === 'tenantForm' ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Form</label>
                  <select
                    value={link.formTemplateId || ''}
                    onChange={(e) => updateLink(link.id, { formTemplateId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary bg-white"
                  >
                    <option value="">Select a form…</option>
                    {templates.map((t) => (
                      <option key={t.FormTemplateId} value={t.FormTemplateId}>
                        {t.Title || t.FormTemplateId}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">URL</label>
                  <input
                    type="url"
                    value={link.customUrl || ''}
                    onChange={(e) => updateLink(link.id, { customUrl: e.target.value })}
                    placeholder="https://…"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Theme colors</label>
                <p className="text-xs text-gray-500 mb-2">Click a swatch to use a preset. Each option matches the member portal.</p>
                <div className="flex flex-wrap gap-2">
                  {MEDICAL_NEEDS_PRESETS.map((p) => {
                    const selected = !isMedicalNeedsHexColor(link.buttonColor) && link.buttonColor === p.value;
                    return (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => updateLink(link.id, { buttonColor: p.value })}
                        title={p.label}
                        className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm font-medium transition-colors ${
                          selected
                            ? 'border-oe-primary bg-oe-light ring-2 ring-oe-primary ring-offset-1'
                            : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        <span
                          className={`h-7 w-7 rounded-md shrink-0 border border-black/10 shadow-inner ${medicalNeedsPresetSwatchBg(p.value)}`}
                          aria-hidden
                        />
                        <span className="text-gray-800">{p.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-lg border border-dashed border-gray-300 bg-white p-3">
                <p className="text-sm font-medium text-gray-800">Custom color</p>
                <p className="text-xs text-gray-500 mt-0.5 mb-3">
                  Pick a color or type <span className="font-mono">#RRGGBB</span>. Using custom replaces the theme swatch until you select a theme color again.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-600 whitespace-nowrap">Color picker</span>
                    <input
                      type="color"
                      aria-label="Custom button color"
                      className="h-10 w-14 cursor-pointer rounded border border-gray-300 bg-white p-0.5"
                      value={medicalNeedsColorPickerValue(link.buttonColor)}
                      onChange={(e) =>
                        updateLink(link.id, { buttonColor: e.target.value.toLowerCase() })
                      }
                    />
                  </div>
                  <div className="flex flex-1 min-w-[180px] items-center gap-2">
                    <label className="text-xs font-medium text-gray-600 whitespace-nowrap" htmlFor={`hex-${link.id}`}>
                      Hex
                    </label>
                    <input
                      id={`hex-${link.id}`}
                      type="text"
                      value={isMedicalNeedsHexColor(link.buttonColor) ? link.buttonColor : ''}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        if (raw === '' || /^#[0-9A-Fa-f]{0,6}$/.test(raw)) {
                          updateLink(link.id, { buttonColor: raw });
                        }
                      }}
                      placeholder="#7e57c2"
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm"
                    />
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-gray-200 bg-white p-3">
                <p className="text-xs font-medium text-gray-600 mb-2">Preview (member portal)</p>
                <div
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-4 py-3 text-left text-sm font-medium shadow-sm ${
                    isHex ? 'text-white' : `${presetCls}`
                  }`}
                  style={isHex ? { backgroundColor: link.buttonColor } : undefined}
                >
                  <span className="truncate">{previewText}</span>
                  <ExternalLink className="h-4 w-4 shrink-0 opacity-95" aria-hidden />
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => removeLink(link.id)}
                  className="inline-flex items-center gap-1 text-sm text-red-600 hover:text-red-800 hover:bg-red-50 px-3 py-1.5 rounded-lg"
                >
                  <Trash2 className="h-4 w-4" />
                  Remove link
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={addLink}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 text-gray-800 bg-white hover:bg-gray-50 font-medium"
      >
        <Plus className="h-5 w-5" />
        Add link
      </button>
    </div>
  );
}

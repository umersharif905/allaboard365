import { FileText, Loader2, Sparkles, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiService } from '../../services/api.service';
import type { ProductFormData } from '../../types/sysadmin/addproductswizard.types';
import {
  buildPlanDetailsDocumentSources,
  collectFilesForPlanDetailsGeneration,
  type PlanDetailsDocSource,
} from '../../utils/planDetailsDocumentSources';

interface PlanDetailsGenerateModalProps {
  open: boolean;
  onClose: () => void;
  formData: ProductFormData;
  existingProductDocumentUrl?: string;
  onApply: (planDetailsData: Record<string, unknown>) => void;
}

export default function PlanDetailsGenerateModal({
  open,
  onClose,
  formData,
  existingProductDocumentUrl,
  onApply,
}: PlanDetailsGenerateModalProps) {
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [generateOnlyFiles, setGenerateOnlyFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<{
    planDetailsData: Record<string, unknown>;
    sectionCount: number;
    sourceFiles: string[];
  } | null>(null);
  const initRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sources = useMemo(
    () => buildPlanDetailsDocumentSources(formData, existingProductDocumentUrl),
    [formData, existingProductDocumentUrl]
  );

  const resetState = useCallback(() => {
    setCheckingStatus(false);
    setAiAvailable(false);
    setGenerating(false);
    setError(null);
    setSelectedIds(new Set());
    setGenerateOnlyFiles([]);
    setPreview(null);
    initRef.current = false;
  }, []);

  useEffect(() => {
    if (!open) {
      resetState();
      return;
    }
    if (initRef.current) return;
    initRef.current = true;

    setSelectedIds(new Set(sources.map((s) => s.id)));
    setCheckingStatus(true);
    apiService
      .get<{ success: boolean; available: boolean }>('/api/ai/generate-plan-details/status')
      .then((res) => setAiAvailable(Boolean(res.available)))
      .catch(() => setAiAvailable(false))
      .finally(() => setCheckingStatus(false));
  }, [open, resetState, sources]);

  const toggleSource = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPreview(null);
  };

  const addGenerateOnlyFiles = (files: FileList | null) => {
    if (!files?.length) return;
    setGenerateOnlyFiles((prev) => [...prev, ...Array.from(files)].slice(0, 5));
    setPreview(null);
  };

  const removeGenerateOnlyFile = (index: number) => {
    setGenerateOnlyFiles((prev) => prev.filter((_, i) => i !== index));
    setPreview(null);
  };

  const handleGenerate = async () => {
    setError(null);
    setPreview(null);

    const hasSelection = selectedIds.size > 0 || generateOnlyFiles.length > 0;
    if (!hasSelection) {
      setError('Select at least one document.');
      return;
    }

    setGenerating(true);
    try {
      const files = await collectFilesForPlanDetailsGeneration(
        sources,
        selectedIds,
        generateOnlyFiles
      );
      if (!files.length) {
        throw new Error('Could not prepare any documents for generation.');
      }

      const fd = new FormData();
      files.forEach((file) => fd.append('files', file));
      fd.append('productName', formData.name || '');
      fd.append('productType', formData.productType || '');
      fd.append('description', formData.description || '');
      if (formData.planDetailsData) {
        fd.append('existingPlanDetails', JSON.stringify(formData.planDetailsData));
      }

      const result = await apiService.post<{
        success: boolean;
        planDetailsData?: Record<string, unknown>;
        sectionCount?: number;
        sourceFiles?: string[];
        message?: string;
      }>('/api/ai/generate-plan-details', fd, {
        timeout: 300000,
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      if (!result.success || !result.planDetailsData) {
        throw new Error(result.message || 'Failed to generate plan details');
      }

      setPreview({
        planDetailsData: result.planDetailsData,
        sectionCount: result.sectionCount || 0,
        sourceFiles: result.sourceFiles || [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate plan details.');
    } finally {
      setGenerating(false);
    }
  };

  const handleApply = () => {
    if (!preview?.planDetailsData) return;
    onApply(preview.planDetailsData);
    onClose();
  };

  const previewSections = useMemo(() => {
    if (!preview?.planDetailsData?.Plan_Body) return [] as { header: string; preview: string }[];
    const body = preview.planDetailsData.Plan_Body as Record<string, unknown>;
    const count = parseInt(String(body.Body_Count || '0'), 10);
    const rows: { header: string; preview: string }[] = [];
    for (let i = 1; i <= count; i += 1) {
      const section = body[`Body${i}`] as { Header?: string; Text1?: string } | undefined;
      if (!section) continue;
      rows.push({
        header: section.Header || `Section ${i}`,
        preview: (section.Text1 || '').slice(0, 160),
      });
    }
    return rows;
  }, [preview]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black bg-opacity-50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !generating) onClose();
      }}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-gradient-to-r from-oe-primary to-oe-dark shrink-0">
          <div className="flex items-center gap-2 text-white">
            <Sparkles className="w-5 h-5" />
            <h3 className="text-lg font-semibold">Generate from product documents</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={generating}
            className="text-white hover:bg-white hover:bg-opacity-20 p-1.5 rounded-lg transition-colors disabled:opacity-50"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {checkingStatus ? (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <Loader2 className="w-4 h-4 animate-spin" />
              Checking AI availability…
            </div>
          ) : !aiAvailable ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              AI generation is not available right now.
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-600">
                Select product document(s) to build content sections from. Pending uploads from the
                Media step are included. You can also add a document used only for generation — it
                will not be saved unless you add it on the Media step. Nothing is saved until you
                save the product wizard.
              </p>

              <div>
                <h4 className="text-sm font-medium text-gray-800 mb-2">Product documents</h4>
                {sources.length === 0 && generateOnlyFiles.length === 0 ? (
                  <p className="text-sm text-gray-500 rounded-lg border border-dashed border-gray-300 p-4">
                    No saved or pending product documents yet. Upload one below for generation only,
                    or add documents on the Media step first.
                  </p>
                ) : (
                  <ul className="space-y-2 rounded-lg border border-gray-200 divide-y divide-gray-100">
                    {sources.map((source: PlanDetailsDocSource) => (
                      <li key={source.id} className="flex items-start gap-3 p-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(source.id)}
                          onChange={() => toggleSource(source.id)}
                          disabled={generating}
                          className="mt-1 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-900 truncate">{source.label}</p>
                          <p className="text-xs text-gray-500">
                            {source.kind === 'existing'
                              ? 'Saved on product'
                              : 'Pending upload on save'}
                          </p>
                        </div>
                        <FileText className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" />
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-800 mb-2">
                  Additional document (generation only)
                </h4>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.doc,.docx,.csv,.xls,.xlsx,image/*,text/plain"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    addGenerateOnlyFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={generating || generateOnlyFiles.length >= 5}
                  className="btn-secondary text-sm inline-flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Upload className="w-4 h-4" />
                  Upload document
                </button>
                {generateOnlyFiles.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {generateOnlyFiles.map((file, index) => (
                      <li
                        key={`${file.name}-${file.size}-${index}`}
                        className="flex items-center justify-between text-sm text-gray-700 bg-gray-50 rounded px-2 py-1.5"
                      >
                        <span className="truncate">{file.name}</span>
                        <button
                          type="button"
                          onClick={() => removeGenerateOnlyFile(index)}
                          className="text-red-500 hover:text-red-700 text-xs shrink-0 ml-2"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {generating && (
                <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  Analyzing documents and generating sections… this may take a few minutes.
                </div>
              )}

              {preview && (
                <div className="rounded-lg border border-green-200 bg-green-50 p-4 space-y-3">
                  <p className="text-sm font-medium text-green-900">
                    Generated {preview.sectionCount} section{preview.sectionCount === 1 ? '' : 's'}
                    {preview.sourceFiles.length > 0
                      ? ` from ${preview.sourceFiles.join(', ')}`
                      : ''}
                  </p>
                  <ul className="space-y-2 max-h-48 overflow-y-auto">
                    {previewSections.map((row, index) => (
                      <li key={index} className="text-sm bg-white rounded border border-green-100 p-2">
                        <p className="font-medium text-gray-900">{row.header}</p>
                        {row.preview && (
                          <p className="text-xs text-gray-600 mt-1 whitespace-pre-line">{row.preview}…</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200 bg-gray-50 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={generating}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          {aiAvailable && !checkingStatus && (
            <>
              {preview ? (
                <button
                  type="button"
                  onClick={() => void handleGenerate()}
                  disabled={generating}
                  className="btn-secondary text-sm disabled:opacity-50"
                >
                  Regenerate
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => (preview ? handleApply() : void handleGenerate())}
                disabled={generating}
                className="btn-primary text-sm flex items-center gap-1.5 disabled:opacity-50"
              >
                {generating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating…
                  </>
                ) : preview ? (
                  'Apply'
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Generate
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

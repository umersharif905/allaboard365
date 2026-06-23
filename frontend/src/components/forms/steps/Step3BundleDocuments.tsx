import { File as GenericFileIcon, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { BundleFormData } from '../../../types/sysadmin/addproductswizard.types';

interface Step3BundleDocumentsProps {
  formData: BundleFormData;
  updateFormData: (updates: Partial<BundleFormData>) => void;
}

const extractionBadge = (status?: string | null): { label: string; cls: string } | null => {
  if (!status) return null;
  const s = String(status).toLowerCase();
  if (s === 'completed') return { label: 'Indexed', cls: 'bg-green-100 text-green-800' };
  if (s === 'running' || s === 'queued') return { label: 'Indexing…', cls: 'bg-blue-100 text-blue-800' };
  if (s === 'failed') return { label: 'Indexing failed', cls: 'bg-red-100 text-red-800' };
  return { label: status, cls: 'bg-gray-100 text-gray-800' };
};

export default function Step3BundleDocuments({ formData, updateFormData }: Step3BundleDocumentsProps) {
  const [documentToRemoveIndex, setDocumentToRemoveIndex] = useState<number | null>(null);

  const existingDocs = formData.productDocuments || [];
  const pendingFiles = formData.productDocumentFiles || [];

  const setDocumentLabel = (index: number, displayName: string) => {
    if (index < existingDocs.length) {
      const next = existingDocs.map((d, i) => (i === index ? { ...d, displayName: displayName || d.displayName } : d));
      updateFormData({ productDocuments: next });
    } else {
      const pendingIndex = index - existingDocs.length;
      const next = [...pendingFiles];
      if (next[pendingIndex]) next[pendingIndex] = { ...next[pendingIndex], displayName: displayName || next[pendingIndex].displayName };
      updateFormData({ productDocumentFiles: next });
    }
  };

  const removeDocument = (index: number) => {
    if (index < existingDocs.length) {
      const next = existingDocs.filter((_, i) => i !== index);
      updateFormData({ productDocuments: next.length ? next : undefined });
    } else {
      const pendingIndex = index - existingDocs.length;
      const next = pendingFiles.filter((_, i) => i !== pendingIndex);
      updateFormData({ productDocumentFiles: next.length ? next : undefined });
    }
    setDocumentToRemoveIndex(null);
  };

  const addPendingDocument = (file: File) => {
    const next = [...pendingFiles, { file, displayName: file.name || 'Document' }];
    updateFormData({ productDocumentFiles: next });
  };

  const hasDocs = existingDocs.length > 0 || pendingFiles.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 mb-2">Bundle Documents</h3>
        <p className="text-sm text-gray-600">
          Upload a bundle-level guide (PDF or DOCX) so Columbus can answer member questions about how the bundle
          works as a whole. Bundle docs are <strong>authoritative</strong> — Columbus prefers them over the individual
          product docs when a member is enrolled in this bundle.
        </p>
        <p className="text-xs text-gray-500 mt-2">
          <strong>Optional.</strong> Save the bundle whenever you're ready — AI extraction runs in the background and
          usually completes in 1-3 minutes. You can return later to view, edit, or re-extract chunks on the AI Knowledge step.
        </p>
      </div>

      <div>
        <label className="form-label">Documents</label>
        <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 hover:border-oe-primary transition-colors min-h-[200px] flex flex-col justify-center">
          {hasDocs ? (
            <div className="space-y-3 w-full text-left">
              <p className="text-sm text-gray-600">Add as many documents as you need. Labels appear in the member portal and in chunk metadata.</p>
              {existingDocs.map((doc, index) => {
                const badge = extractionBadge(doc.extractionStatus);
                return (
                  <div key={doc.productDocumentId ?? doc.documentUrl ?? index} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg border border-gray-200">
                    <input
                      type="text"
                      value={doc.displayName || ''}
                      onChange={(e) => setDocumentLabel(index, e.target.value)}
                      placeholder="Label (e.g. Bundle Guide)"
                      className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    />
                    {badge && (
                      <span className={`text-xs px-2 py-1 rounded-full font-medium shrink-0 ${badge.cls}`}>{badge.label}</span>
                    )}
                    <a
                      href={doc.documentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-oe-primary hover:underline shrink-0"
                    >
                      Preview
                    </a>
                    <button
                      type="button"
                      onClick={() => setDocumentToRemoveIndex(index)}
                      className="p-1.5 text-red-500 hover:bg-red-50 rounded"
                      title="Remove document"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
              {pendingFiles.map((item, i) => (
                <div key={`pending-${i}`} className="flex items-center gap-2 p-2 bg-green-50 rounded-lg border border-green-200">
                  <input
                    type="text"
                    value={item.displayName || ''}
                    onChange={(e) => setDocumentLabel(existingDocs.length + i, e.target.value)}
                    placeholder="Label for new document"
                    className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                  <span className="text-xs text-green-700 shrink-0 truncate max-w-[160px]" title={item.file.name}>{item.file.name}</span>
                  <button
                    type="button"
                    onClick={() => setDocumentToRemoveIndex(existingDocs.length + i)}
                    className="p-1.5 text-red-500 hover:bg-red-50 rounded"
                    title="Remove document"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <input
                type="file"
                accept=".pdf,.doc,.docx"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    addPendingDocument(file);
                    e.target.value = '';
                  }
                }}
                className="hidden"
                id="bundle-document-add"
              />
              <label htmlFor="bundle-document-add" className="inline-flex items-center gap-1.5 text-sm text-oe-primary hover:text-oe-dark cursor-pointer">
                <Plus className="h-4 w-4" />
                Add another document
              </label>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="w-full h-32 flex items-center justify-center bg-gray-100 rounded">
                <div className="text-center">
                  <GenericFileIcon className="w-12 h-12 text-gray-400 mx-auto mb-2" />
                  <p className="text-sm text-gray-500">No bundle documents yet</p>
                  <p className="text-xs text-gray-400 mt-1">Add a bundle guide so Columbus can answer bundle-level questions. PDF or DOCX.</p>
                </div>
              </div>
              <div className="text-center">
                <input
                  type="file"
                  accept=".pdf,.doc,.docx"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      addPendingDocument(file);
                      e.target.value = '';
                    }
                  }}
                  className="hidden"
                  id="bundle-document"
                />
                <label htmlFor="bundle-document" className="text-sm text-oe-primary hover:text-oe-dark cursor-pointer transition-colors inline-flex items-center gap-1.5">
                  <Plus className="h-4 w-4" />
                  Add document
                </label>
              </div>
            </div>
          )}
        </div>
      </div>

      {documentToRemoveIndex !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Remove document?</h3>
            <p className="text-sm text-gray-600 mb-4">
              This document will be removed from the bundle. Save the bundle to apply changes.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDocumentToRemoveIndex(null)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => removeDocument(documentToRemoveIndex)}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Brain,
  Download,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import type { AIChunk, StepProps } from '../../../types/sysadmin/addproductswizard.types';
import {
  useProductChunks,
  useRegenerateAll,
} from '../../../hooks/useProductChunks';
import { useProductDocuments, useRegenerateDocument } from '../../../hooks/useProductDocuments';
import AIKnowledgeTab from './ai-chunks/AIKnowledgeTab';

const DOCUMENT_IMPORT_EXTENSIONS = ['.pdf', '.doc', '.docx'];

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function isDocumentImportFile(file: File): boolean {
  const ext = getFileExtension(file.name);
  if (DOCUMENT_IMPORT_EXTENSIONS.includes(ext)) return true;
  const mime = (file.type || '').toLowerCase();
  return (
    mime === 'application/pdf'
    || mime === 'application/msword'
    || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

export default function Step9AIChunks({ formData, updateFormData, editingProductId }: StepProps) {
  return (
    <Step9DraftChunks
      formData={formData}
      updateFormData={updateFormData}
      productId={editingProductId}
    />
  );
}

/** In-wizard editor — manual chunks in form state; auto-extract from docs when product is saved. */
function Step9DraftChunks({
  formData,
  updateFormData,
  productId,
}: Pick<StepProps, 'formData' | 'updateFormData'> & { productId?: string }) {
  const aiChunks = formData.aiChunks ?? [];
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(
    aiChunks.length > 0 && aiChunks[0].id ? aiChunks[0].id : null
  );
  const [bulkText, setBulkText] = useState('');
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [actionMessage, setActionMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [stagedDocMessage, setStagedDocMessage] = useState<string | null>(null);

  const { data: apiChunks = [] } = useProductChunks(productId);
  const { data: docs = [] } = useProductDocuments(productId);
  const regenAll = useRegenerateAll(productId || '');
  const regenDoc = useRegenerateDocument(productId || '');
  const isRegenerating = Boolean(productId) && (regenDoc.isPending || regenAll.isPending);

  const extractedAiChunks = useMemo(
    () => apiChunks.filter((c) => c.ChunkType === 'prose' && c.Source === 'ai'),
    [apiChunks]
  );

  const hasPendingDocs =
    (formData.productDocumentFiles?.length ?? 0) > 0 ||
    (formData.productDocuments?.some((d) => d.documentUrl?.trim()) ?? false) ||
    Boolean(formData.productDocumentUrl?.trim());

  // Merge document-extracted chunks into wizard form state for the OG list (manual rows preserved).
  const extractedSignature = useMemo(
    () =>
      extractedAiChunks
        .map((c) => `${c.AIChunkId}:${c.ChunkText || ''}`)
        .join('\n'),
    [extractedAiChunks]
  );

  useEffect(() => {
    if (!productId || extractedAiChunks.length === 0) return;

    const extractedMapped = extractedAiChunks.map((c) => ({
      id: c.AIChunkId,
      chunk_text: c.ChunkText || '',
      created_at: c.CreatedDate || new Date().toISOString(),
      _fromDocumentExtraction: true as const,
    }));

    const currentChunks = formData.aiChunks ?? [];
    const manualChunks = currentChunks.filter(
      (c) => !(c as { _fromDocumentExtraction?: boolean })._fromDocumentExtraction
    );
    const merged = [...extractedMapped, ...manualChunks];
    const current = currentChunks;
    const same =
      merged.length === current.length &&
      merged.every(
        (c, i) => c.id === current[i]?.id && c.chunk_text === (current[i]?.chunk_text || '')
      );
    if (!same) {
      updateFormData({ aiChunks: merged });
    }
  }, [productId, extractedSignature, formData.aiChunks, updateFormData]);

  const handleRegenerateDoc = (documentId: string) => {
    if (!productId) return;
    setActionMessage(null);
    regenDoc.mutate(documentId, {
      onSuccess: () => {
        setActionMessage({
          type: 'success',
          text: 'Document extraction queued — chunks will appear below when processing finishes.',
        });
      },
      onError: (err) => {
        setActionMessage({
          type: 'error',
          text: err instanceof Error ? err.message : 'Failed to regenerate document chunks.',
        });
      },
    });
  };

  const handleRegenerateAll = () => {
    if (!productId) return;
    setActionMessage(null);
    regenAll.mutate(undefined, {
      onSuccess: () => {
        setConfirmRegen(false);
        setActionMessage({
          type: 'success',
          text: 'Regeneration queued for all documents — chunks will update shortly.',
        });
      },
      onError: (err) => {
        setActionMessage({
          type: 'error',
          text: err instanceof Error ? err.message : 'Failed to regenerate AI chunks.',
        });
      },
    });
  };

  const selectedChunk = aiChunks.find((chunk) => chunk.id === selectedChunkId);
  const selectedChunkIndex = aiChunks.findIndex((chunk) => chunk.id === selectedChunkId);

  const addChunk = () => {
    const newChunk: AIChunk = {
      id: Date.now().toString(),
      chunk_text: '',
      created_at: new Date().toISOString(),
    };
    updateFormData({ aiChunks: [...aiChunks, newChunk] });
    setSelectedChunkId(newChunk.id || null);
  };

  const updateChunk = (id: string | undefined, text: string) => {
    if (!id) return;
    updateFormData({
      aiChunks: aiChunks.map((chunk) =>
        chunk.id === id ? { ...chunk, chunk_text: text } : chunk
      ),
    });
  };

  const removeChunk = (id: string | undefined) => {
    if (!id) return;
    const chunks = aiChunks.filter((chunk) => chunk.id !== id);
    updateFormData({ aiChunks: chunks });

    if (selectedChunkId === id && chunks.length > 0) {
      setSelectedChunkId(chunks[0].id || null);
    } else if (chunks.length === 0) {
      setSelectedChunkId(null);
    }
  };

  const handleBulkImport = () => {
    if (!bulkText.trim()) return;

    const newChunks = bulkText
      .split('\n\n')
      .filter((text) => text.trim())
      .map((text) => ({
        id: `${Date.now().toString()}${Math.random()}`,
        chunk_text: text.trim(),
        created_at: new Date().toISOString(),
      }));

    updateFormData({ aiChunks: [...aiChunks, ...newChunks] });

    if (newChunks.length > 0 && !selectedChunkId) {
      setSelectedChunkId(newChunks[0].id || null);
    }

    setBulkText('');
    setShowBulkImport(false);
  };

  const exportChunks = () => {
    const content = aiChunks.map((chunk) => chunk.chunk_text || '').join('\n\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${formData.name.replace(/\s+/g, '_')}_ai_chunks.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleFileImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';

    if (isDocumentImportFile(file)) {
      const next = [
        ...(formData.productDocumentFiles || []),
        { file, displayName: file.name || 'Document' },
      ];
      updateFormData({ productDocumentFiles: next });
      setStagedDocMessage(`"${file.name}" staged for AI extraction on save.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (content) {
        setBulkText(content);
        setShowBulkImport(true);
      }
    };
    reader.readAsText(file);
  };

  const getChunkPreview = (text?: string) => {
    const words = (text || '').split(' ').filter((word) => word.length > 0);
    const wordCount = words.length;
    const preview = words.slice(0, 10).join(' ');
    return {
      preview: preview + (words.length > 10 ? '...' : ''),
      wordCount,
    };
  };

  return (
    <div className="space-y-6">
      {!productId && hasPendingDocs && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-medium">Auto-generation on save</p>
          <p className="mt-1 text-blue-800">
            Product document(s) will be parsed automatically after you save this product — usually
            within 1–3 minutes. Re-open the product to review extracted chunks, or add manual chunks
            below now.
          </p>
        </div>
      )}

      {stagedDocMessage && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900">
          {stagedDocMessage}
        </div>
      )}

      {productId && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-gray-600">
              Uploaded documents are parsed automatically. Extracted chunks sync into the list below;
              add manual chunks anytime.
            </p>
            <button
              type="button"
              onClick={() => setConfirmRegen(true)}
              disabled={isRegenerating || docs.length === 0}
              className="px-3 py-1.5 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md flex items-center gap-1 text-sm shrink-0 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${regenAll.isPending ? 'animate-spin' : ''}`} />
              {regenAll.isPending ? 'Queuing…' : 'Regenerate all'}
            </button>
          </div>
          <AIKnowledgeTab
            chunks={apiChunks}
            documents={docs}
            onSaveChunk={async () => {}}
            onRegenerateDoc={handleRegenerateDoc}
            onRetryDoc={handleRegenerateDoc}
            isRegenerating={isRegenerating}
            regeneratingDocumentId={regenDoc.isPending ? regenDoc.variables : undefined}
            readOnly
          />
          {actionMessage && (
            <div
              className={`rounded-lg border px-4 py-3 text-sm ${
                actionMessage.type === 'success'
                  ? 'border-green-200 bg-green-50 text-green-900'
                  : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              {actionMessage.text}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-xl font-bold text-gray-800">AI Knowledge Configuration</h3>
        <div className="flex gap-2">
          <label className="btn-secondary flex items-center text-sm cursor-pointer">
            <Upload className="w-4 h-4 mr-2" />
            Import file
            <input
              type="file"
              accept=".txt,.md,.pdf,.doc,.docx"
              className="hidden"
              onChange={handleFileImport}
            />
          </label>
          <button
            onClick={() => setShowBulkImport(!showBulkImport)}
            className="btn-secondary flex items-center text-sm"
          >
            <Upload className="w-4 h-4 mr-2" />
            Bulk Import
          </button>
          {aiChunks.length > 0 && (
            <button onClick={exportChunks} className="btn-secondary flex items-center text-sm">
              <Download className="w-4 h-4 mr-2" />
              Export
            </button>
          )}
        </div>
      </div>

      {showBulkImport && (
        <div className="card space-y-3">
          <p className="text-sm text-gray-600">
            Paste text below. Separate chunks with a blank line.
          </p>
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            className="w-full h-40 form-input text-sm"
            placeholder="Chunk one content&#10;&#10;Chunk two content"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setShowBulkImport(false); setBulkText(''); }}
              className="btn-secondary text-sm"
            >
              Cancel
            </button>
            <button onClick={handleBulkImport} className="btn-primary text-sm">
              Import chunks
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-6">
        <div className="w-80 flex-shrink-0">
          <div className="flex justify-between items-center mb-4">
            <h4 className="text-sm font-semibold text-gray-600">AI Chunks</h4>
            <button onClick={addChunk} className="btn-primary flex items-center text-sm">
              <Plus className="w-4 h-4 mr-1" />
              Add AI Chunk
            </button>
          </div>

          <div className="space-y-2 max-h-[600px] overflow-y-auto">
            {aiChunks.length === 0 ? (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
                <Brain className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 text-sm">No AI chunks configured</p>
                <p className="text-gray-400 text-xs mt-1">Click &quot;Add AI Chunk&quot; to get started</p>
              </div>
            ) : (
              aiChunks.map((chunk, index) => {
                const { preview, wordCount } = getChunkPreview(chunk.chunk_text);
                const isSelected = chunk.id === selectedChunkId;
                const chunkId = chunk.id || `temp-${index}`;

                return (
                  <div
                    key={chunkId}
                    onClick={() => { if (chunk.id) setSelectedChunkId(chunk.id); }}
                    className={`p-3 border rounded-lg cursor-pointer transition-all ${
                      isSelected
                        ? 'border-oe-primary bg-blue-50'
                        : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
                    }`}
                  >
                    <div className="flex justify-between items-start mb-1">
                      <h5 className="font-medium text-sm text-gray-800">Chunk {index + 1}</h5>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (chunk.id) removeChunk(chunk.id);
                        }}
                        className="p-1 text-oe-error hover:bg-red-50 rounded transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="text-xs text-gray-500 mb-2">{wordCount} words</p>
                    {preview ? (
                      <p className="text-xs text-gray-600 line-clamp-2">{preview}</p>
                    ) : (
                      <p className="text-xs text-gray-400 italic">Empty chunk</p>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="flex-1">
          <h4 className="text-sm font-semibold text-gray-600 mb-4">Chunk Configuration</h4>

          {selectedChunk ? (
            <div className="card">
              <div className="mb-4">
                <div className="flex justify-between items-center mb-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Chunk {selectedChunkIndex + 1} Content
                  </label>
                  <span className="text-xs text-gray-500">
                    {getChunkPreview(selectedChunk.chunk_text).wordCount} words
                  </span>
                </div>
                <textarea
                  value={selectedChunk.chunk_text || ''}
                  onChange={(e) => updateChunk(selectedChunk.id, e.target.value)}
                  className="w-full h-64 form-input text-sm"
                  placeholder="Enter AI chunk content here. This text will be used to help the AI understand and answer questions about this product."
                />
              </div>

              {(selectedChunk.chunk_text || '').length > 1000 && (
                <div className="mt-3 alert-warning flex items-start">
                  <AlertCircle className="w-4 h-4 text-yellow-600 mr-2 mt-0.5 flex-shrink-0" />
                  <div className="text-sm">
                    <p className="font-medium">Large chunk detected</p>
                    <p className="mt-1">
                      This chunk contains over 1000 characters. Consider splitting it into smaller,
                      more focused chunks for better AI performance.
                    </p>
                  </div>
                </div>
              )}

              <div className="mt-4 alert-info">
                <div className="flex items-start">
                  <Brain className="w-4 h-4 text-oe-primary mr-2 mt-0.5 flex-shrink-0" />
                  <div className="text-sm">
                    <p className="font-medium mb-1">Best Practices:</p>
                    <ul className="list-disc list-inside space-y-1 text-xs">
                      <li>Keep chunks focused on single topics</li>
                      <li>Use clear, descriptive language</li>
                      <li>Include relevant keywords users might search for</li>
                      <li>Aim for 100-500 words per chunk for optimal results</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-12 text-center">
              <Brain className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500">No chunk selected</p>
              <p className="text-gray-400 text-sm mt-2">
                {aiChunks.length === 0
                  ? 'Add a chunk to get started'
                  : 'Select a chunk from the list to configure it'}
              </p>
            </div>
          )}
        </div>
      </div>

      {confirmRegen && productId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h3 className="text-lg font-bold text-gray-800 mb-2">Regenerate all AI chunks?</h3>
            <p className="text-sm text-gray-600 mb-4">
              Re-runs extraction on every uploaded document. Manual chunks you added below are kept.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmRegen(false)}
                className="px-4 py-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRegenerateAll}
                disabled={regenAll.isPending}
                className="px-4 py-2 bg-oe-primary hover:bg-oe-dark text-white rounded-md disabled:opacity-50 flex items-center gap-1.5"
              >
                <RefreshCw className={`w-4 h-4 ${regenAll.isPending ? 'animate-spin' : ''}`} />
                {regenAll.isPending ? 'Queuing…' : 'Regenerate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

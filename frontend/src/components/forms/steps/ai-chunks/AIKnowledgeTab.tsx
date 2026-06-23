import { useState, useMemo } from 'react';
import { ChevronRight, Pencil, FileText } from 'lucide-react';
import type { AIChunk, ProductDocumentWithExtraction } from '../../../../types/aiChunks';
import EditChunkModal from './EditChunkModal';
import ExtractionStatusBanner from './ExtractionStatusBanner';

interface Props {
  chunks: AIChunk[];
  documents: ProductDocumentWithExtraction[];
  onSaveChunk: (chunkId: string, patch: { chunkText: string; title?: string }) => Promise<void>;
  onRegenerateDoc: (documentId: string) => void;
  onRetryDoc: (documentId: string) => void;
  isRegenerating?: boolean;
  regeneratingDocumentId?: string;
  readOnly?: boolean;
}

export default function AIKnowledgeTab({
  chunks,
  documents,
  onSaveChunk,
  onRegenerateDoc,
  onRetryDoc,
  isRegenerating,
  regeneratingDocumentId,
  readOnly = false,
}: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AIChunk | null>(null);

  const proseAI = useMemo(
    () => chunks.filter(c => c.ChunkType === 'prose' && c.Source === 'ai'),
    [chunks]
  );

  const byDoc = useMemo(() => {
    const m = new Map<string | null, AIChunk[]>();
    for (const c of proseAI) {
      const k = c.SourceDocumentId;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(c);
    }
    return m;
  }, [proseAI]);

  return (
    <div className="space-y-4">
      <ExtractionStatusBanner
        documents={documents}
        onRegenerate={onRegenerateDoc}
        onRetry={onRetryDoc}
        isRegenerating={isRegenerating}
        regeneratingDocumentId={regeneratingDocumentId}
      />
      {[...byDoc.entries()].map(([docId, list]) => {
        const doc = documents.find(d => d.ProductDocumentId === docId);
        return (
          <div key={docId || 'unknown'} className="bg-white rounded-lg border border-gray-200">
            <div className="flex items-center px-4 py-2 bg-gray-50 border-b border-gray-200 rounded-t-lg">
              <FileText className="w-4 h-4 text-gray-400 mr-2" />
              <span className="text-sm font-medium text-gray-700">
                {doc?.DisplayName || 'Unknown source'} — {list.length} chunks
              </span>
            </div>
            <ul className="divide-y divide-gray-100">
              {list.map(c => (
                <li key={c.AIChunkId}>
                  <div
                    onClick={() => setOpenId(openId === c.AIChunkId ? null : c.AIChunkId)}
                    className="w-full flex items-center justify-between px-4 py-2 hover:bg-gray-50 text-left cursor-pointer"
                  >
                    <span className="flex items-center min-w-0">
                      <ChevronRight
                        className={`w-4 h-4 mr-2 transition-transform ${openId === c.AIChunkId ? 'rotate-90' : ''}`}
                      />
                      <span className="text-sm text-gray-800 truncate">{c.Title || '(untitled)'}</span>
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); setEditing(c); }}
                      className="text-gray-400 hover:text-oe-primary p-1"
                      disabled={readOnly}
                      type="button"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </div>
                  {openId === c.AIChunkId && (
                    <div className="px-10 pb-3 text-sm text-gray-600 whitespace-pre-wrap">
                      {c.ChunkText}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {editing && !readOnly && (
        <EditChunkModal
          chunk={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => onSaveChunk(editing.AIChunkId, patch)}
        />
      )}
    </div>
  );
}

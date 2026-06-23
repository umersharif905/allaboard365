import { useState, useMemo } from 'react';
import { ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import type { AIChunk } from '../../../../types/aiChunks';
import EditChunkModal from './EditChunkModal';
import AddFAQModal from './AddFAQModal';

interface Props {
  chunks: AIChunk[];
  onSaveChunk: (chunkId: string, patch: { chunkText: string; question?: string }) => Promise<void>;
  onCreate: (data: { question: string; answer: string }) => Promise<void>;
  onDelete: (chunkId: string) => Promise<void>;
}

export default function FAQsTab({ chunks, onSaveChunk, onCreate, onDelete }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AIChunk | null>(null);
  const [adding, setAdding] = useState(false);

  const faqs = useMemo(() =>
    chunks.filter(c => c.ChunkType === 'faq')
          .sort((a, b) => {
            if (a.Source === b.Source) return 0;
            return a.Source === 'manual' ? -1 : 1;
          }),
    [chunks]
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setAdding(true)}
                className="px-3 py-1.5 bg-oe-primary hover:bg-oe-dark text-white rounded-md flex items-center gap-1 text-sm">
          <Plus className="w-4 h-4" /> Add FAQ
        </button>
      </div>
      <ul className="space-y-2">
        {faqs.map(c => (
          <li key={c.AIChunkId} className="bg-white border border-gray-200 rounded-lg">
            <div className="flex items-center justify-between px-4 py-3">
              <div
                onClick={() => setOpenId(openId === c.AIChunkId ? null : c.AIChunkId)}
                className="flex items-center min-w-0 flex-1 cursor-pointer"
              >
                <ChevronRight className={`w-4 h-4 mr-2 transition-transform flex-shrink-0 ${openId === c.AIChunkId ? 'rotate-90' : ''}`} />
                <span className="text-sm font-medium text-gray-800 truncate">Q: {c.Question}</span>
              </div>
              <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                <span className={`text-xs px-2 py-0.5 rounded ${c.Source === 'manual' ? 'bg-oe-light text-oe-dark' : 'bg-gray-100 text-gray-600'}`}>
                  {c.Source === 'manual' ? 'Manual' : 'AI'}
                </span>
                <button onClick={() => setEditing(c)} className="text-gray-400 hover:text-oe-primary p-1">
                  <Pencil className="w-4 h-4" />
                </button>
                {c.Source === 'manual' && (
                  <button onClick={() => onDelete(c.AIChunkId)} className="text-gray-400 hover:text-red-600 p-1">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            {openId === c.AIChunkId && (
              <div className="px-10 pb-3 text-sm text-gray-600 whitespace-pre-wrap">
                {c.ChunkText}
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <EditChunkModal chunk={editing}
                        onClose={() => setEditing(null)}
                        onSave={(patch) => onSaveChunk(editing.AIChunkId, patch)} />
      )}
      {adding && (
        <AddFAQModal onClose={() => setAdding(false)} onSave={onCreate} />
      )}
    </div>
  );
}

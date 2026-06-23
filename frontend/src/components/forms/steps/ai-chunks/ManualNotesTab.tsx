import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import type { AIChunk } from '../../../../types/aiChunks';
import EditChunkModal from './EditChunkModal';

interface Props {
  chunks: AIChunk[];
  onSaveChunk: (chunkId: string, patch: { chunkText: string; title?: string }) => Promise<void>;
  onCreate: (data: { chunkText: string; title?: string }) => Promise<void>;
  onDelete: (chunkId: string) => Promise<void>;
}

export default function ManualNotesTab({ chunks, onSaveChunk, onCreate, onDelete }: Props) {
  const [editing, setEditing] = useState<AIChunk | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const notes = chunks.filter(c => c.ChunkType === 'prose' && c.Source === 'manual');

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setDrafting(true)}
                className="px-3 py-1.5 bg-oe-primary hover:bg-oe-dark text-white rounded-md flex items-center gap-1 text-sm">
          <Plus className="w-4 h-4" /> Add Note
        </button>
      </div>
      <ul className="space-y-2">
        {notes.map(c => (
          <li key={c.AIChunkId} className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-start justify-between">
              <div className="min-w-0 flex-1">
                {c.Title && <p className="text-sm font-semibold text-gray-800 mb-1">{c.Title}</p>}
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{c.ChunkText}</p>
              </div>
              <div className="flex items-center gap-2 ml-3">
                <button onClick={() => setEditing(c)} className="text-gray-400 hover:text-oe-primary p-1">
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={() => onDelete(c.AIChunkId)} className="text-gray-400 hover:text-red-600 p-1">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {drafting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6">
            <h3 className="text-lg font-bold text-gray-800 mb-4">Add Note</h3>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Title (optional)</label>
              <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} className="w-full form-input" />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Content</label>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="w-full form-input h-48" />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setDrafting(false); setDraft(''); setDraftTitle(''); }}
                      className="px-4 py-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md">
                Cancel
              </button>
              <button
                onClick={async () => {
                  await onCreate({ chunkText: draft, title: draftTitle || undefined });
                  setDraft(''); setDraftTitle(''); setDrafting(false);
                }}
                disabled={!draft.trim()}
                className="px-4 py-2 bg-oe-primary hover:bg-oe-dark text-white rounded-md disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <EditChunkModal chunk={editing}
                        onClose={() => setEditing(null)}
                        onSave={(patch) => onSaveChunk(editing.AIChunkId, patch)} />
      )}
    </div>
  );
}

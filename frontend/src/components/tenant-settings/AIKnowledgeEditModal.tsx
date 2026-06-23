import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { TenantKnowledgeChunk } from '../../services/aiTenantKnowledge.service';

interface Props {
  chunk: TenantKnowledgeChunk | null;
  onClose: () => void;
  onSave: (payload: { chunkText: string; question?: string; title?: string }) => Promise<void>;
  saving: boolean;
}

export default function AIKnowledgeEditModal({ chunk, onClose, onSave, saving }: Props) {
  const [chunkText, setChunkText] = useState('');
  const [question, setQuestion] = useState('');
  const [title, setTitle] = useState('');

  useEffect(() => {
    if (chunk) {
      setChunkText(chunk.ChunkText || '');
      setQuestion(chunk.Question || '');
      setTitle(chunk.Title || '');
    }
  }, [chunk]);

  if (!chunk) return null;

  const isFaq = chunk.ChunkType === 'faq';
  const wasAi = chunk.Source === 'ai';

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chunkText.trim()) return;
    if (isFaq && !question.trim()) return;
    await onSave({
      chunkText: chunkText.trim(),
      question: isFaq ? question.trim() : undefined,
      title: !isFaq ? title.trim() || undefined : undefined,
    });
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[80] p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">
            Edit {isFaq ? 'FAQ' : 'chunk'}
            {chunk.ProductName ? ` — ${chunk.ProductName}` : ''}
          </h3>
          <button type="button" className="p-1 text-gray-400 hover:text-gray-600" onClick={onClose}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSave} className="flex-1 overflow-auto p-6 space-y-4">
          {wasAi && (
            <p className="text-xs text-gray-600 bg-oe-light border border-oe-primary/30 rounded p-2">
              This chunk was AI-generated. Saving will convert it to a manual chunk so future
              document regenerations won't overwrite your edit.
            </p>
          )}
          {isFaq ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Question</label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                required
              />
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Title (optional)</label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {isFaq ? 'Answer' : 'Content'}
            </label>
            <textarea
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary min-h-[200px]"
              value={chunkText}
              onChange={(e) => setChunkText(e.target.value)}
              required
            />
            <p className="text-xs text-gray-500 mt-1">{chunkText.length} characters</p>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-200">
            <button
              type="button"
              className="px-4 py-2 text-sm border border-gray-300 text-gray-700 bg-white rounded-md hover:bg-gray-50"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm text-white bg-oe-primary rounded-md hover:bg-oe-dark disabled:opacity-50"
              disabled={saving || !chunkText.trim() || (isFaq && !question.trim())}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

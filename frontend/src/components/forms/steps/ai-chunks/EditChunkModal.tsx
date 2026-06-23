import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { AIChunk } from '../../../../types/aiChunks';

interface Props {
  chunk: AIChunk;
  onClose: () => void;
  onSave: (patch: { chunkText: string; title?: string; question?: string }) => Promise<void>;
}

export default function EditChunkModal({ chunk, onClose, onSave }: Props) {
  const [chunkText, setChunkText] = useState(chunk.ChunkText);
  const [title, setTitle] = useState(chunk.Title || '');
  const [question, setQuestion] = useState(chunk.Question || '');
  const [saving, setSaving] = useState(false);
  const [confirmAfterSave, setConfirmAfterSave] = useState(false);

  const isAI = chunk.Source === 'ai';
  const isFAQ = chunk.ChunkType === 'faq';

  useEffect(() => {
    if (confirmAfterSave) {
      const t = setTimeout(onClose, 2500);
      return () => clearTimeout(t);
    }
  }, [confirmAfterSave, onClose]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        chunkText,
        title: isFAQ ? undefined : title,
        question: isFAQ ? question : undefined,
      });
      if (isAI) setConfirmAfterSave(true);
      else onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-800">
            Edit {isFAQ ? 'FAQ' : 'chunk'}{isAI && ' (will move to Manual)'}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {confirmAfterSave ? (
          <div className="bg-oe-light border border-oe-primary rounded-lg p-4 text-sm text-gray-800">
            This chunk is now a manual chunk and will be preserved across regenerations.
          </div>
        ) : (
          <>
            {isFAQ && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Question</label>
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  className="w-full form-input"
                />
              </div>
            )}
            {!isFAQ && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full form-input"
                />
              </div>
            )}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {isFAQ ? 'Answer' : 'Content'}
              </label>
              <textarea
                value={chunkText}
                onChange={(e) => setChunkText(e.target.value)}
                className="w-full form-input h-48"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !chunkText.trim()}
                className="px-4 py-2 bg-oe-primary hover:bg-oe-dark text-white rounded-md disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

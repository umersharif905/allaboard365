import { useState } from 'react';
import { X } from 'lucide-react';

interface Props {
  onClose: () => void;
  onSave: (data: { question: string; answer: string }) => Promise<void>;
}

export default function AddFAQModal({ onClose, onSave }: Props) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [saving, setSaving] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-800">Add FAQ</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Question</label>
          <input value={question} onChange={(e) => setQuestion(e.target.value)}
                 className="w-full form-input"
                 placeholder="e.g. How do I file a claim?" />
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Answer</label>
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)}
                    className="w-full form-input h-40" />
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose}
                  className="px-4 py-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md">
            Cancel
          </button>
          <button
            onClick={async () => { setSaving(true); try { await onSave({ question, answer }); onClose(); } finally { setSaving(false); } }}
            disabled={saving || !question.trim() || !answer.trim()}
            className="px-4 py-2 bg-oe-primary hover:bg-oe-dark text-white rounded-md disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Add FAQ'}
          </button>
        </div>
      </div>
    </div>
  );
}

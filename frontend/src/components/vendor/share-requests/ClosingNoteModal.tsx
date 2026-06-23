import { useEffect, useState } from 'react';
import { X, Eye } from 'lucide-react';
import type { ShareRequestStatus } from '../../../types/shareRequest.types';

interface ClosingNoteModalProps {
  open: boolean;
  /** The terminal status being set (Completed / Denied / Withdrawn). */
  status: ShareRequestStatus | null;
  /** Existing member-facing note, used to prefill the textarea. */
  initialNote?: string;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (note: string) => void;
}

// Generic fallback the member sees when no explanation is provided. Mirrors the
// defaults in the member portal (ShareRequestCard).
const GENERIC: Record<string, string> = {
  Completed: 'Your share request is complete.',
  Denied: 'Your share request was denied.',
  Withdrawn: 'Your share request was withdrawn.',
};

/**
 * Shown when the care team moves a share request to a terminal status. Lets them
 * leave a member-facing explanation that surfaces on the member dashboard. The
 * note is optional — leaving it blank shows the member a generic default.
 */
export default function ClosingNoteModal({
  open,
  status,
  initialNote = '',
  busy = false,
  onClose,
  onSubmit,
}: ClosingNoteModalProps) {
  const [note, setNote] = useState(initialNote);

  // Reseed the textarea each time the modal opens for a request.
  useEffect(() => {
    if (open) setNote(initialNote);
  }, [open, initialNote]);

  if (!open || !status) return null;

  const generic = GENERIC[status] ?? 'Your share request has been processed.';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">Mark request as {status}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="flex items-start gap-2 rounded-md bg-oe-light text-oe-dark px-3 py-2 text-sm">
            <Eye className="h-4 w-4 mt-0.5 shrink-0" />
            <span>This note will be shown to the member on their dashboard.</span>
          </div>

          <label htmlFor="closing-note" className="block text-sm font-medium text-gray-700">
            Explanation for the member <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <textarea
            id="closing-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={5}
            autoFocus
            placeholder={`Explain why this request is ${status.toLowerCase()}…`}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
          />
          <p className="text-xs text-gray-500">
            Leave blank to show the member the default message: “{generic}”
          </p>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(note)}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
          >
            {busy ? 'Saving…' : `Save & mark ${status}`}
          </button>
        </div>
      </div>
    </div>
  );
}

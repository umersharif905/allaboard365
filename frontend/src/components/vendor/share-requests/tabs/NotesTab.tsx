import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, StickyNote, Trash2, X } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import { type ShareRequestNote } from '../../../../types/shareRequest.types';
import {
  listMentionableVendorUsers,
  mentionDisplayName,
  type MentionableUser,
} from '../../../../services/vendorMentions.service';
import MentionTextarea, {
  renderNoteWithMentions,
} from '../../shared/MentionTextarea';
import Skeleton from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';

interface NotesTabProps {
  shareRequestId: string;
}

interface NotesResponse {
  success: boolean;
  data: ShareRequestNote[];
}

const fmtDateTime = (v?: string) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const NotesTab = ({ shareRequestId }: NotesTabProps) => {
  const [notes, setNotes] = useState<ShareRequestNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [newNote, setNewNote] = useState('');
  const [mentionedIds, setMentionedIds] = useState<string[]>([]);
  const [mentionables, setMentionables] = useState<MentionableUser[]>([]);
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        // ?category=manual returns only user-authored notes — system
        // activity and status-change entries live on the History tab now.
        const response = await apiService.get<NotesResponse>(
          `/api/me/vendor/share-requests/${shareRequestId}/notes?category=manual`,
          signal ? { signal } : undefined
        );
        if (signal?.aborted) return;
        if (response.success) setNotes(response.data);
        else setError('load_failed');
      } catch (err) {
        if (signal?.aborted) return;
        console.error('share-request NotesTab load failed', err);
        setError('load_failed');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [shareRequestId]
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    listMentionableVendorUsers(controller.signal)
      .then((u) => {
        if (!controller.signal.aborted) setMentionables(u);
      })
      .catch(() => {
        /* mentions are best-effort; notes still work without the directory */
      });
    return () => controller.abort();
  }, []);

  const mentionNames = useMemo(
    () => mentionables.map(mentionDisplayName).filter(Boolean),
    [mentionables]
  );

  const closeAdd = useCallback(() => {
    setShowAdd(false);
    setNewNote('');
    setMentionedIds([]);
  }, []);

  const handleAdd = async () => {
    if (!newNote.trim()) return;
    // Closure-capture srId per Concurrency Policy
    const srId = shareRequestId;
    setSaving(true);
    try {
      await apiService.post(`/api/me/vendor/share-requests/${srId}/notes`, {
        note: newNote.trim(),
        noteType: 'Note',
        isInternal: true,
        mentionedUserIds: mentionedIds,
      });
      setNewNote('');
      setMentionedIds([]);
      setShowAdd(false);
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to add note');
    } finally {
      setSaving(false);
    }
  };

  const handleStartEdit = (note: ShareRequestNote) => {
    setEditingId(note.NoteId);
    setEditText(note.Note);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditText('');
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editText.trim()) return;
    const srId = shareRequestId;
    setSaving(true);
    try {
      await apiService.put(
        `/api/me/vendor/share-requests/${srId}/notes/${editingId}`,
        { note: editText.trim() }
      );
      setEditingId(null);
      setEditText('');
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to update note');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (noteId: string) => {
    if (!window.confirm('Archive this note? This cannot be undone.')) return;
    const srId = shareRequestId;
    try {
      await apiService.delete(`/api/me/vendor/share-requests/${srId}/notes/${noteId}`);
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to archive note');
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Notes</h2>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add note
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : notes.length === 0 ? (
        // Empty state wins over a transient load error so the panel stays calm on
        // first paint. Failures are logged to the console; users can retry by
        // adding a note or refreshing.
        <EmptyState
          icon={StickyNote}
          title={error ? "Couldn't load notes" : 'No notes'}
          description={error ? 'Try refreshing the page.' : 'Add the first note for this share request.'}
          tone="subtle"
        />
      ) : (
        <ul className="space-y-2">
          {notes.map((note) => {
            const isEditing = editingId === note.NoteId;
            const author =
              note.CreatedByName ??
              [note.UserFirstName, note.UserLastName].filter(Boolean).join(' ') ??
              'System';
            return (
              <li
                key={note.NoteId}
                className="bg-white border border-gray-200 rounded-lg p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="text-xs text-gray-500">
                    <span className="font-medium text-gray-700">{author}</span>
                    {' · '}
                    {fmtDateTime(note.CreatedDate)}
                  </div>
                  {!isEditing && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleStartEdit(note)}
                        className="p-1 text-gray-400 hover:text-oe-primary rounded"
                        aria-label="Edit note"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(note.NoteId)}
                        className="p-1 text-gray-400 hover:text-red-600 rounded"
                        aria-label="Archive note"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
                {isEditing ? (
                  <div className="space-y-2">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={3}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      autoFocus
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        className="px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 rounded"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveEdit}
                        disabled={saving || !editText.trim()}
                        className="px-3 py-1 text-xs font-medium text-white bg-oe-primary hover:bg-oe-dark rounded disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">
                    {renderNoteWithMentions(note.Note, mentionNames)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {showAdd && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-note-title"
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeAdd();
          }}
        >
          <div className="w-full max-w-md bg-white rounded-lg shadow-xl p-4 space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 id="add-note-title" className="text-base font-semibold text-gray-900">
                Add note
              </h3>
              <button
                type="button"
                onClick={closeAdd}
                className="p-1 text-gray-400 hover:text-gray-600 rounded"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <MentionTextarea
              value={newNote}
              onChange={setNewNote}
              users={mentionables}
              onMentionsChange={setMentionedIds}
              rows={5}
              placeholder="Type a note… use @ to tag a teammate"
              autoFocus
            />
            <p className="text-xs text-gray-500">
              Tagged teammates get an email with a link to this note.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closeAdd}
                className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAdd}
                disabled={saving || !newNote.trim()}
                className="px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NotesTab;

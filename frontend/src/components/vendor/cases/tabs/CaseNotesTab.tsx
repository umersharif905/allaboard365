// Support ticket notes — internal-only notes. Backend also writes audit entries
// (status changes, claim/unclaim) into the same table with NoteType='status_change'
// etc. The list view here only shows user-authored notes by default.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, StickyNote, X } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import type { CaseNote } from '../../../../types/case.types';
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

interface ListResp { success: boolean; data: CaseNote[] }
interface AddResp  { success: boolean; data: CaseNote; message?: string }

interface CaseNotesTabProps { caseId: string }

const fmtDateTime = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const CaseNotesTab = ({ caseId }: CaseNotesTabProps) => {
  const [notes, setNotes] = useState<CaseNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [text, setText] = useState('');
  const [mentionedIds, setMentionedIds] = useState<string[]>([]);
  const [mentionables, setMentionables] = useState<MentionableUser[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await apiService.get<ListResp>(`/api/me/vendor/cases/${caseId}/notes`, { signal });
      if (signal?.aborted) return;
      if (resp.success) setNotes(resp.data);
      else setError('load_failed');
    } catch (e) {
      if (signal?.aborted) return;
      console.error('CaseNotesTab load failed', e);
      setError('load_failed');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  useEffect(() => {
    const ac = new AbortController();
    listMentionableVendorUsers(ac.signal)
      .then((u) => {
        if (!ac.signal.aborted) setMentionables(u);
      })
      .catch(() => {
        /* mentions are best-effort; notes still work without the directory */
      });
    return () => ac.abort();
  }, []);

  const mentionNames = useMemo(
    () => mentionables.map(mentionDisplayName).filter(Boolean),
    [mentionables]
  );

  const closeAdd = useCallback(() => {
    setShowAdd(false);
    setText('');
    setMentionedIds([]);
  }, []);

  const handleAdd = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      const resp = await apiService.post<AddResp>(`/api/me/vendor/cases/${caseId}/notes`, {
        note: text.trim(),
        mentionedUserIds: mentionedIds,
      });
      if (resp.success && resp.data) {
        setNotes((prev) => [resp.data, ...prev]);
        setText('');
        setMentionedIds([]);
        setShowAdd(false);
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Failed to add note');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6">
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <StickyNote className="h-4 w-4 text-oe-primary" />
            <h3 className="text-sm font-semibold text-gray-900">Notes</h3>
          </div>
          {!showAdd && (
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-md"
            >
              <Plus className="h-4 w-4" /> Add note
            </button>
          )}
        </div>

        {showAdd && (
          <div className="p-5 border-b border-gray-200">
            <MentionTextarea
              value={text}
              onChange={setText}
              users={mentionables}
              onMentionsChange={setMentionedIds}
              rows={4}
              placeholder="Write a note… use @ to tag a teammate"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
            />
            <p className="text-xs text-gray-500 mt-1.5">
              Tagged teammates get an email with a link to this note.
            </p>
            <div className="flex items-center justify-end gap-2 mt-2">
              <button
                type="button"
                onClick={closeAdd}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                <X className="h-4 w-4" /> Cancel
              </button>
              <button
                type="button"
                onClick={handleAdd}
                disabled={saving || !text.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-md disabled:opacity-60"
              >
                {saving ? 'Saving...' : 'Save note'}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="p-5 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded" />)}
          </div>
        ) : notes.length === 0 ? (
          // Empty state wins over a transient load error so first-paint stays calm.
          // Load failures are logged to console; users can retry by adding a note or refreshing.
          <div className="p-5">
            <EmptyState
              icon={StickyNote}
              title={error ? "Couldn't load notes" : 'No notes'}
              description={error ? 'Try refreshing the page.' : 'Notes you add here are visible to your vendor team.'}
              tone="subtle"
            />
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {notes.map((n) => (
              <li key={n.NoteId} className="p-4">
                <div className="text-xs text-gray-500 mb-1 flex items-center gap-2">
                  <span>{n.CreatedByName || 'Unknown'}</span>
                  <span>·</span>
                  <span>{fmtDateTime(n.CreatedDate)}</span>
                </div>
                <div className="text-sm text-gray-900 whitespace-pre-wrap">
                  {renderNoteWithMentions(n.Note, mentionNames)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default CaseNotesTab;

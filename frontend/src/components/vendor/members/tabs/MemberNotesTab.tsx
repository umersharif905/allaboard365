import { useEffect, useState } from 'react';
import { StickyNote } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import { SkeletonRows } from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';

interface MemberNote {
  NoteId: string;
  ShareRequestId: string;
  RequestNumber?: string;
  NoteType?: string;
  Note: string;
  IsInternal?: boolean;
  CreatedDate?: string;
  CreatedByName?: string;
}

interface MemberNotesTabProps {
  memberId: string;
}

const formatDateTime = (raw?: string) => {
  if (!raw) return '';
  try {
    return new Date(raw).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return raw;
  }
};

const MemberNotesTab = ({ memberId }: MemberNotesTabProps) => {
  const [notes, setNotes] = useState<MemberNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await apiService.get<{ success: boolean; data: MemberNote[] }>(
          `/api/me/vendor/members/${memberId}/notes`,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        if (response.success) {
          setNotes(response.data ?? []);
        } else {
          setError('Unable to load notes');
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('Error loading notes:', err);
        setError('Unable to load notes');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [memberId]);

  if (loading) {
    return (
      <div className="p-6">
        <SkeletonRows count={4} rowClassName="h-20" />
      </div>
    );
  }

  if (error) {
    return <EmptyState icon={StickyNote} title={error} tone="error" />;
  }

  if (notes.length === 0) {
    return (
      <EmptyState
        icon={StickyNote}
        title="No notes yet"
        description="Notes added on this member's share requests will appear here."
      />
    );
  }

  return (
    <div className="p-6 animate-fade-up">
      <ol className="relative space-y-3 border-l-2 border-gray-100 pl-5">
        {notes.map((n) => (
          <li
            key={n.NoteId}
            className="relative bg-white border border-gray-200 rounded-lg p-4 shadow-soft hover:shadow-medium transition-shadow"
          >
            <span className="absolute -left-[27px] top-5 h-3 w-3 rounded-full bg-oe-primary ring-4 ring-white" />
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex flex-wrap items-center gap-2">
                {n.RequestNumber && (
                  <span className="inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-oe-light text-oe-dark">
                    {n.RequestNumber}
                  </span>
                )}
                {n.NoteType && (
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">
                    {n.NoteType}
                  </span>
                )}
                {n.IsInternal && (
                  <span className="text-[10px] text-amber-700 bg-amber-50 ring-1 ring-amber-200 px-2 py-0.5 rounded font-medium">
                    Internal
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-500 whitespace-nowrap">
                {formatDateTime(n.CreatedDate)}
              </div>
            </div>
            <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{n.Note}</p>
            {n.CreatedByName && (
              <p className="text-xs text-gray-400 mt-2">— {n.CreatedByName}</p>
            )}
          </li>
        ))}
      </ol>
      <p className="text-xs text-gray-400 mt-3">Rows: {notes.length}</p>
    </div>
  );
};

export default MemberNotesTab;

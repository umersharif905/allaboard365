// CustomerHistoryModal — read-only "Show history" view for a customer. Lists every
// email thread for the linked member and/or counterparty address, grouped by
// conversation (each message stays its own card, with a per-conversation grouping
// header). Conversations linked to the case/SR being worked are highlighted.
// Replying stays in the real thread — each group has an "Open" link, no reply here.
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md
import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, History, ExternalLink, Paperclip, Loader2, Inbox } from 'lucide-react';
import { inboxService, type HistoryScope } from '../../../services/inbox.service';
import { senderDisplay } from '../../../types/email.types';
import type { CustomerHistoryThread, EmailMessage } from '../../../types/email.types';

interface Props {
  open: boolean;
  onClose: () => void;
  memberId: string | null;
  address: string | null;
  caseId: string | null;
  shareRequestId: string | null;
  /** Navigate to a real thread (closes the modal). */
  onOpenThread: (threadId: string) => void;
}

const fmtWhen = (v?: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const HistoryMessageCard = ({ m }: { m: EmailMessage }) => {
  const outbound = m.Direction === 'outbound';
  return (
    <div className={`rounded-md border p-2.5 ${outbound ? 'bg-oe-light/40 border-oe-light' : 'bg-gray-50 border-gray-200'}`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded-full ${outbound ? 'bg-oe-primary text-white' : 'bg-gray-200 text-gray-700'}`}>
            {outbound ? 'Sent' : 'Received'}
          </span>
          <span className="text-sm font-medium text-gray-800 truncate">{senderDisplay(m)}</span>
          {m.HasAttachments && <Paperclip className="h-3 w-3 text-gray-400 shrink-0" />}
        </div>
        <span className="text-xs text-gray-400 shrink-0">{fmtWhen(m.SentAt || m.ReceivedAt)}</span>
      </div>
      <p className="text-sm text-gray-600 whitespace-pre-wrap break-words line-clamp-4">{m.BodyPreview || '(no preview)'}</p>
    </div>
  );
};

const CustomerHistoryModal = ({ open, onClose, memberId, address, caseId, shareRequestId, onOpenThread }: Props) => {
  // Scope: default to the widest available. With no member, address-only.
  const [scope, setScope] = useState<HistoryScope>(memberId ? 'both' : 'address');
  const [threads, setThreads] = useState<CustomerHistoryThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true); setError(null);
    inboxService.customerHistory({ memberId, address, scope, caseId, shareRequestId }, { signal })
      .then((r) => { if (!signal?.aborted) { if (r.success) setThreads(r.data.threads); else setError('Failed to load history'); } })
      .catch((e) => { if (!signal?.aborted) setError(e instanceof Error ? e.message : 'Failed to load history'); })
      .finally(() => { if (!signal?.aborted) setLoading(false); });
  }, [memberId, address, scope, caseId, shareRequestId]);

  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [open, load]);

  const totalMessages = useMemo(() => threads.reduce((n, t) => n + t.messages.length, 0), [threads]);
  const hasCurrentContext = useMemo(() => threads.some((t) => t.isCurrentContext), [threads]);

  if (!open) return null;

  const scopeBtn = (val: HistoryScope, label: string, disabled = false) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setScope(val)}
      className={`text-xs px-2.5 py-1 rounded-md border ${scope === val ? 'bg-oe-primary text-white border-oe-primary' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'} disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black bg-opacity-50">
      <div className="bg-white rounded-lg border border-gray-200 w-full max-w-2xl max-h-[88vh] flex flex-col shadow-xl"
        role="dialog" aria-modal="true" aria-labelledby="customer-history-title">
        {/* header */}
        <div className="px-5 py-4 border-b border-gray-200">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <History className="h-5 w-5 text-oe-primary shrink-0" />
              <div className="min-w-0">
                <h3 id="customer-history-title" className="text-base font-semibold text-gray-900">Customer history</h3>
                <p className="text-xs text-gray-500 truncate">{address || 'this customer'}</p>
              </div>
            </div>
            <button type="button" onClick={onClose} className="p-1 rounded-md hover:bg-gray-100 text-gray-500" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-400 mr-1">Match by</span>
              {scopeBtn('member', 'Member', !memberId)}
              {scopeBtn('address', 'Address', !address)}
              {scopeBtn('both', 'Both', !memberId || !address)}
            </div>
            {!loading && (
              <span className="text-xs text-gray-400">{threads.length} conversation{threads.length === 1 ? '' : 's'} · {totalMessages} message{totalMessages === 1 ? '' : 's'}</span>
            )}
          </div>
          {hasCurrentContext && (
            <div className="mt-2 text-[11px] text-oe-dark inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-sm bg-oe-primary" /> Highlighted conversations belong to the linked case / share request.
            </div>
          )}
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : error ? (
            <div className="text-sm text-red-600 py-6 text-center">{error}</div>
          ) : threads.length === 0 ? (
            <div className="text-center py-10 text-gray-500">
              <Inbox className="h-10 w-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm">No other email found for this customer.</p>
            </div>
          ) : (
            threads.map((t) => {
              const ref = t.LinkedShareRequestNumber || t.LinkedCaseNumber;
              return (
                <section
                  key={t.ThreadId}
                  className={`rounded-lg border pl-3 ${t.isCurrentContext ? 'border-oe-primary border-l-4 bg-oe-light/10' : 'border-gray-200 border-l-4 border-l-gray-200'}`}
                >
                  <div className="flex items-start justify-between gap-3 px-2 py-2 border-b border-gray-100">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-semibold text-gray-900 truncate">{t.Subject || '(no subject)'}</h4>
                        {t.isCurrentContext && ref && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-oe-primary text-white shrink-0">This {t.ShareRequestId ? 'SR' : 'case'}</span>
                        )}
                        {!t.isCurrentContext && ref && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 shrink-0">{ref}</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400">{t.messages.length} message{t.messages.length === 1 ? '' : 's'} · last {fmtWhen(t.LastMessageAt)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenThread(t.ThreadId)}
                      className="shrink-0 inline-flex items-center gap-1 text-xs font-medium text-oe-dark hover:text-oe-primary"
                    >
                      Open <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="px-2 py-2 space-y-2">
                    {t.messages.map((m) => <HistoryMessageCard key={m.EmailMessageId} m={m} />)}
                  </div>
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default CustomerHistoryModal;

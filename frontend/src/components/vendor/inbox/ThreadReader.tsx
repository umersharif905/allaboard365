// ThreadReader — center pane: the conversation, header pills + Ref, link
// control, compose box, and the Phase-2 AI slot.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Link2, Loader2, Hash, Paperclip, Download, Pencil, Eye, UserPlus, UserMinus, History, CheckCircle2, StickyNote, RotateCcw } from 'lucide-react';
import { inboxService, type ThreadPresence } from '../../../services/inbox.service';
import { useAuth } from '../../../contexts/AuthContext';
import { senderDisplay, type EmailAttachment, type EmailMessage, type EmailThreadDetail, type EmailThreadNote } from '../../../types/email.types';

const fmtSize = (n?: number | null) => (n == null ? '' : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// The actual email address(es) for a message — so the care team sees who/where,
// not just a display name.
const addressLine = (m: EmailMessage): string => {
  if (m.Direction === 'outbound') {
    try { const to = m.ToAddresses ? (JSON.parse(m.ToAddresses) as string[]) : []; return to.length ? `to ${to.join(', ')}` : ''; }
    catch { return ''; }
  }
  return m.FromAddress || '';
};
import EmailStatusPills from './EmailStatusPills';
import ComposeReply from './ComposeReply';
import LinkThreadModal from './LinkThreadModal';
import ThreadContextPanel from './ThreadContextPanel';
import CustomerHistoryModal from './CustomerHistoryModal';
import OwnerPill from './OwnerPill';
import { trimEmailHtml } from './emailDisplay';

interface Props {
  threadId: string;
  onBack: () => void;
  onChanged: () => void;
}

const fmtTime = (v?: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const parseAddrs = (json?: string | null): string[] => {
  if (!json) return [];
  try { return (JSON.parse(json) as string[]).filter(Boolean).map((a) => String(a).toLowerCase()); }
  catch { return []; }
};
// For detecting "who joined": new senders + new CCs (never the To field — the
// shared mailbox only ever appears there, and we don't want to flag ourselves).
const detectAddrs = (m: EmailMessage): string[] => {
  const out = m.FromAddress ? [m.FromAddress.toLowerCase()] : [];
  return out.concat(parseAddrs(m.CcAddresses));
};
const allAddrs = (m: EmailMessage): string[] =>
  [...(m.FromAddress ? [m.FromAddress.toLowerCase()] : []), ...parseAddrs(m.ToAddresses), ...parseAddrs(m.CcAddresses)];

/** Map of messageId → addresses that first appear (as sender/CC) on that message. */
const computeAddedParticipants = (messages: EmailMessage[]): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  const seen = new Set<string>();
  messages.forEach((m, i) => {
    if (i === 0) { allAddrs(m).forEach((a) => seen.add(a)); return; }
    const fresh = detectAddrs(m).filter((a) => a && !seen.has(a));
    if (fresh.length) out[m.EmailMessageId] = fresh;
    allAddrs(m).forEach((a) => seen.add(a));
  });
  return out;
};

// Untrusted email HTML rendered in a sandboxed iframe (scripts disabled) — safe
// against XSS without a sanitizer dependency. allow-same-origin (NOT
// allow-scripts) lets us auto-size while blocking script execution.
const MessageBody = ({ html }: { html: string | null }) => {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);
  const onLoad = useCallback(() => {
    try {
      const doc = ref.current?.contentDocument;
      if (doc) setHeight(Math.min(800, Math.max(40, doc.body.scrollHeight + 16)));
    } catch { /* cross-origin guard */ }
  }, []);
  // Constrain everything to the bubble width so an oversized signature/table/image
  // (legacy messages, or a customer's own image signature) can't cause horizontal
  // scroll inside the chat. New outbound messages already drop the signature via
  // the data-aab-msg trim; this is the safety net for everything else.
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
    <style>
      html,body{margin:0;padding:0;}
      body{font-family:Inter,system-ui,sans-serif;font-size:14px;color:#1f2937;overflow-wrap:break-word;word-break:break-word;}
      img{max-width:100%;height:auto;}
      table{max-width:100%!important;}
      td,th{word-break:break-word;}
    </style>
    </head><body>${html || '<p style="color:#9ca3af">(no content)</p>'}</body></html>`;
  return (
    <iframe
      ref={ref}
      title="email-body"
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      onLoad={onLoad}
      style={{ height }}
      className="w-full border-0"
    />
  );
};

const MessageCard = ({ m, attachments = [] }: { m: EmailMessage; attachments?: EmailAttachment[] }) => {
  const outbound = m.Direction === 'outbound';
  const [showFull, setShowFull] = useState(false);
  // Show only this message's new content in the bubble; the thread already is the
  // conversation, so the quoted history (and our own signature) is just noise.
  const trimmed = useMemo(() => trimEmailHtml(m.BodyHtml, outbound ? 'outbound' : 'inbound'), [m.BodyHtml, outbound]);
  return (
    <div className={`max-w-2xl ${outbound ? 'ml-auto' : ''}`}>
      <div className={`mb-1 ${outbound ? 'text-right' : ''}`}>
        <div className={`flex items-center gap-2 ${outbound ? 'justify-end' : ''}`}>
          <span className="text-sm font-medium text-gray-800">{senderDisplay(m)}</span>
          <span className="text-xs text-gray-400">{fmtTime(m.SentAt || m.ReceivedAt)}</span>
          {m.HasAttachments && <Paperclip className="h-3 w-3 text-gray-400" />}
        </div>
        {addressLine(m) && <div className="text-xs text-gray-400 truncate">{addressLine(m)}</div>}
      </div>
      <div className={`rounded-lg border p-3 ${outbound ? 'bg-oe-light/40 border-oe-light' : 'bg-gray-50 border-gray-200'}`}>
        <MessageBody html={showFull ? m.BodyHtml : trimmed.html} />
        {trimmed.truncated && (
          <button
            type="button"
            onClick={() => setShowFull((v) => !v)}
            className={`mt-1 text-xs text-gray-400 hover:text-oe-primary ${outbound ? 'ml-auto block' : ''}`}
          >
            {showFull ? 'Hide earlier conversation' : '••• Show earlier conversation (what they replied to)'}
          </button>
        )}
        {attachments.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-200 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <a key={a.AttachmentId} href={a.AuthenticatedUrl || '#'} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs bg-white border border-gray-300 rounded px-2 py-1 text-gray-700 hover:bg-gray-50">
                <Download className="h-3 w-3 text-oe-primary" />{a.FileName}
                {a.FileSize != null && <span className="text-gray-400">{fmtSize(a.FileSize)}</span>}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const ThreadReader = ({ threadId, onBack, onChanged }: Props) => {
  const [thread, setThread] = useState<EmailThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showLink, setShowLink] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const navigate = useNavigate();
  const [notes, setNotes] = useState<EmailThreadNote[]>([]);
  const [noteText, setNoteText] = useState('');
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const { user } = useAuth();
  const currentUserId = user?.userId;
  const [presence, setPresence] = useState<ThreadPresence>({ viewers: [], repliers: [] });
  const [isReplying, setIsReplying] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const assign = useCallback((ownerUserId: string | null) => {
    setAssigning(true);
    inboxService.assignThread(threadId, ownerUserId)
      .then((r) => { if (r.success) { setThread(r.data); onChanged(); } })
      .catch(() => { /* non-fatal */ })
      .finally(() => setAssigning(false));
  }, [threadId, onChanged]);

  const load = useCallback((markRead: boolean) => {
    const ac = new AbortController();
    setLoading(true); setError(null);
    const p = markRead ? inboxService.markRead(threadId) : inboxService.getThread(threadId, { signal: ac.signal });
    p.then((r) => { if (r.success) setThread(r.data); else setError('Failed to load thread'); })
      .catch((e) => { if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'Failed to load thread'); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [threadId]);

  // Open = mark read.
  useEffect(() => { const cancel = load(true); return cancel; }, [load]);

  // Fetch attachments; refetch when the message count changes (e.g. after a reply).
  const messageCount = thread?.messages.length ?? 0;
  useEffect(() => {
    const ac = new AbortController();
    inboxService.threadAttachments(threadId, { signal: ac.signal })
      .then((r) => { if (r.success) setAttachments(r.data); })
      .catch(() => { /* non-fatal */ });
    return () => ac.abort();
  }, [threadId, messageCount]);

  const attachmentsByMessage = useMemo(() => {
    const map: Record<string, EmailAttachment[]> = {};
    for (const a of attachments) (map[a.EmailMessageId] ||= []).push(a);
    return map;
  }, [attachments]);

  const addedByMessage = useMemo(() => computeAddedParticipants(thread?.messages || []), [thread]);

  // The customer's address for this thread: the earliest inbound sender, else the
  // earliest outbound recipient, else the linked member's email. Feeds "Show history".
  const customerAddress = useMemo(() => {
    const msgs = thread?.messages || [];
    const inb = msgs.find((m) => m.Direction === 'inbound' && m.FromAddress);
    if (inb?.FromAddress) return inb.FromAddress;
    const outb = msgs.find((m) => m.Direction === 'outbound' && m.ToAddresses);
    if (outb?.ToAddresses) { try { return (JSON.parse(outb.ToAddresses) as string[])[0] || null; } catch { /* ignore */ } }
    return thread?.MemberEmail || null;
  }, [thread]);

  // Internal notes for this thread (team-only).
  useEffect(() => {
    let active = true;
    setNotes([]);
    inboxService.threadNotes(threadId)
      .then((r) => { if (active && r.success) setNotes(r.data); })
      .catch(() => { /* non-fatal */ });
    return () => { active = false; };
  }, [threadId]);

  // Messages + notes woven into one time-ordered timeline.
  const timeline = useMemo(() => {
    const items: (
      | { kind: 'message'; ts: string | null; m: EmailMessage }
      | { kind: 'note'; ts: string | null; n: EmailThreadNote }
    )[] = [
      ...(thread?.messages || []).map((m) => ({ kind: 'message' as const, ts: m.SentAt || m.ReceivedAt || m.CreatedDate, m })),
      ...notes.map((n) => ({ kind: 'note' as const, ts: n.CreatedDate, n })),
    ];
    items.sort((a, b) => new Date(a.ts || 0).getTime() - new Date(b.ts || 0).getTime());
    return items;
  }, [thread, notes]);

  const addNote = useCallback(() => {
    const text = noteText.trim();
    if (!text) return;
    setNoteSaving(true);
    inboxService.addThreadNote(threadId, { note: text })
      .then((r) => { if (r.success) { setNotes((prev) => [...prev, r.data]); setNoteText(''); setShowNoteInput(false); } })
      .catch(() => { /* non-fatal */ })
      .finally(() => setNoteSaving(false));
  }, [threadId, noteText]);

  const resolved = !!thread?.ResolvedAt;
  const toggleResolved = useCallback(() => {
    setResolving(true);
    const p = thread?.ResolvedAt ? inboxService.unresolveThread(threadId) : inboxService.resolveThread(threadId);
    p.then((r) => { if (r.success) { setThread(r.data); onChanged(); } })
      .catch(() => { /* non-fatal */ })
      .finally(() => setResolving(false));
  }, [threadId, thread, onChanged]);

  // Background refresh: pull new inbound replies into an open thread every 25s
  // without a loading flash, so a conversation you're reading stays current.
  // Silent and paused while the tab is hidden; getThread does not mark-read.
  useEffect(() => {
    let active = true;
    const tick = () => {
      if (document.hidden) return;
      inboxService.getThread(threadId)
        .then((r) => { if (active && r.success) setThread(r.data); })
        .catch(() => { /* silent; foreground load owns errors */ });
    };
    const id = setInterval(tick, 25000);
    return () => { active = false; clearInterval(id); };
  }, [threadId]);

  // Poll others' presence (~live).
  useEffect(() => {
    let active = true;
    const poll = () => inboxService.presence(threadId).then((r) => { if (active && r.success) setPresence(r.data); }).catch(() => { /* ignore */ });
    poll();
    const id = setInterval(poll, 4000);
    return () => { active = false; clearInterval(id); };
  }, [threadId]);

  // Broadcast my presence (viewing vs replying); re-fires immediately on state change.
  useEffect(() => {
    const state: 'viewing' | 'replying' = isReplying ? 'replying' : 'viewing';
    inboxService.heartbeatPresence(threadId, state).catch(() => { /* ignore */ });
    const id = setInterval(() => { inboxService.heartbeatPresence(threadId, state).catch(() => { /* ignore */ }); }, 8000);
    return () => clearInterval(id);
  }, [threadId, isReplying]);

  // Release my presence when leaving the thread.
  useEffect(() => () => { inboxService.stopPresence(threadId).catch(() => { /* ignore */ }); }, [threadId]);

  const othersReplying = presence.repliers.filter((p) => p.userId !== currentUserId);
  const othersViewing = presence.viewers.filter((p) => p.userId !== currentUserId);
  const names = (list: { name: string | null }[]) => list.map((p) => p.name || 'Another agent').join(', ');

  const refLabel = thread?.LinkedShareRequestNumber || thread?.LinkedCaseNumber || null;
  const isLinked = !!(thread?.ShareRequestId || thread?.CaseId);

  if (loading && !thread) {
    return <div className="flex-1 flex items-center justify-center text-gray-400"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }
  if (error && !thread) {
    return <div className="flex-1 flex items-center justify-center text-sm text-red-600">{error}</div>;
  }
  if (!thread) return null;

  return (
    <div className="flex-1 flex min-w-0">
      <main className="flex-1 flex flex-col min-w-0 bg-white">
        {/* header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <button type="button" onClick={onBack} className="md:hidden inline-flex items-center gap-1 text-sm text-gray-500 mb-2">
            <ArrowLeft className="h-4 w-4" /> Inbox
          </button>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-gray-900 truncate">{thread.Subject || '(no subject)'}</h2>
              <EmailStatusPills thread={thread} size="md" />
            </div>
            <div className="shrink-0 flex flex-col items-end gap-2">
              {/* Soft ownership — who's handling this thread. Nothing is locked. */}
              <div className="flex items-center gap-1.5">
                {thread.OwnerName && (
                  <OwnerPill name={thread.OwnerName} color={thread.OwnerColor} isMine={thread.AssignedToUserId === currentUserId} size="md" />
                )}
                {thread.AssignedToUserId === currentUserId ? (
                  <button
                    type="button" disabled={assigning} onClick={() => assign(null)}
                    className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-red-600 disabled:opacity-50"
                  >
                    <UserMinus className="h-3.5 w-3.5" /> Unassign
                  </button>
                ) : (
                  <button
                    type="button" disabled={assigning || !currentUserId} onClick={() => assign(currentUserId || null)}
                    className="inline-flex items-center gap-1 text-xs text-oe-dark hover:text-oe-primary disabled:opacity-50"
                  >
                    <UserPlus className="h-3.5 w-3.5" /> {thread.AssignedToUserId ? 'Claim' : 'Assign to me'}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleResolved}
                  disabled={resolving}
                  title={resolved ? 'Reopen this thread' : 'Mark handled — clears it from "Needs reply" (reopens if the customer replies)'}
                  className={`inline-flex items-center gap-1.5 text-sm rounded-md px-3 py-1.5 disabled:opacity-50 ${resolved ? 'border border-gray-300 text-gray-700 bg-white hover:bg-gray-50' : 'bg-oe-primary text-white hover:bg-oe-dark'}`}
                >
                  {resolved ? <><RotateCcw className="h-4 w-4" /> Reopen</> : <><CheckCircle2 className="h-4 w-4" /> Mark handled</>}
                </button>
                {(thread.MemberId || customerAddress) && (
                  <button
                    type="button"
                    onClick={() => setShowHistory(true)}
                    title="See all email to and from this customer"
                    className="inline-flex items-center gap-1.5 text-sm border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md px-3 py-1.5"
                  >
                    <History className="h-4 w-4" />
                    Show history
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowLink(true)}
                  className="inline-flex items-center gap-1.5 text-sm border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md px-3 py-1.5"
                >
                  <Link2 className="h-4 w-4" />
                  {isLinked ? 'Re-link' : 'Link to SR / Case'}
                </button>
              </div>
            </div>
          </div>
          {isLinked && (
            <div className="mt-2 text-xs text-gray-500 inline-flex items-center gap-1">
              <Hash className="h-3 w-3" /> Linked to {refLabel} · every message logged as an encounter
            </div>
          )}
        </div>

        {resolved && (
          <div className="px-4 py-2 bg-green-50 border-b border-green-200 text-xs text-green-800 flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" /> Handled{thread.ResolvedByName ? ` by ${thread.ResolvedByName}` : ''} · reopens automatically if the customer replies
          </div>
        )}

        {/* timeline: messages + internal notes, time-ordered */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {timeline.map((item) => (
            item.kind === 'note' ? (
              <div key={`note-${item.n.NoteId}`} className="flex justify-center">
                <div className="max-w-xl w-full bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                  <div className="flex items-center gap-1.5 text-[11px] text-amber-700 mb-0.5">
                    <StickyNote className="h-3 w-3" /> Internal note · {item.n.CreatedByName || 'Team'} · {fmtTime(item.n.CreatedDate)}
                  </div>
                  <p className="text-sm text-amber-900 whitespace-pre-wrap break-words">{item.n.Note}</p>
                </div>
              </div>
            ) : (
              <Fragment key={item.m.EmailMessageId}>
                {addedByMessage[item.m.EmailMessageId] && (
                  <div className="flex items-center justify-center">
                    <span className="inline-flex items-center gap-1 text-[11px] text-gray-500 bg-gray-100 border border-gray-200 rounded-full px-2.5 py-0.5">
                      <UserPlus className="h-3 w-3" aria-hidden />
                      {addedByMessage[item.m.EmailMessageId].join(', ')} added to the conversation
                    </span>
                  </div>
                )}
                <MessageCard m={item.m} attachments={attachmentsByMessage[item.m.EmailMessageId]} />
              </Fragment>
            )
          ))}
        </div>

        {/* collision presence */}
        {othersReplying.length > 0 ? (
          <div className="px-4 py-2 bg-amber-50 border-t border-amber-200 text-xs text-amber-800 flex items-center gap-1.5">
            <Pencil className="h-3.5 w-3.5" /> {names(othersReplying)} {othersReplying.length > 1 ? 'are' : 'is'} replying to this conversation…
          </div>
        ) : othersViewing.length > 0 ? (
          <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 text-xs text-gray-500 flex items-center gap-1.5">
            <Eye className="h-3.5 w-3.5" /> {names(othersViewing)} {othersViewing.length > 1 ? 'are' : 'is'} viewing this conversation
          </div>
        ) : null}

        {/* internal note composer (team-only) */}
        <div className="px-4 py-2 border-t border-gray-200 bg-gray-50">
          {showNoteInput ? (
            <div className="flex items-start gap-2">
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                rows={2}
                autoFocus
                placeholder="Internal note — team-only, never sent to the customer (e.g. &quot;sent ACH form via forms page&quot;)…"
                className="flex-1 text-sm border border-gray-300 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <div className="flex flex-col gap-1 shrink-0">
                <button type="button" onClick={addNote} disabled={noteSaving || !noteText.trim()}
                  className="text-xs font-medium text-white bg-amber-500 hover:bg-amber-600 rounded-md px-3 py-1.5 disabled:opacity-50">
                  {noteSaving ? 'Saving…' : 'Add note'}
                </button>
                <button type="button" onClick={() => { setShowNoteInput(false); setNoteText(''); }}
                  className="text-xs text-gray-500 hover:text-gray-700">Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setShowNoteInput(true)}
              className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-amber-600">
              <StickyNote className="h-3.5 w-3.5" /> Add internal note
            </button>
          )}
        </div>

        {/* compose */}
        <ComposeReply
          threadId={threadId}
          refLabel={refLabel}
          othersReplyingName={othersReplying[0]?.name ?? null}
          onReplyingChange={setIsReplying}
          onSent={() => { load(false); onChanged(); }}
        />
      </main>

      <ThreadContextPanel thread={thread} onMatch={() => setShowLink(true)} onChanged={() => { load(false); onChanged(); }} />

      <LinkThreadModal
        threadId={threadId}
        open={showLink}
        onClose={() => setShowLink(false)}
        onLinked={() => { load(false); onChanged(); }}
      />

      <CustomerHistoryModal
        open={showHistory}
        onClose={() => setShowHistory(false)}
        memberId={thread.MemberId}
        address={customerAddress}
        caseId={thread.CaseId}
        shareRequestId={thread.ShareRequestId}
        onOpenThread={(id) => { setShowHistory(false); if (id !== threadId) navigate(`/vendor/inbox/${id}`); }}
      />
    </div>
  );
};

export default ThreadReader;

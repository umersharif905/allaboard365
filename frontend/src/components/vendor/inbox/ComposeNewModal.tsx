// ComposeNewModal — compose a brand-new email (starts a new thread). Reused by
// the Inbox, Share Request detail, and Case detail. Recipient = member picker
// (email auto-fills, editable) or a raw address; optionally links to the
// member's case/SR so it logs as an encounter in History.
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md
import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Mail, Search, Loader2, Paperclip } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import { inboxService } from '../../../services/inbox.service';
import useUserProfile from '../../../hooks/useUserProfile';
import type { EmailThreadDetail } from '../../../types/email.types';
import EmailPreview from './EmailPreview';

interface MemberSearchResult {
  MemberId: string;
  FirstName: string;
  LastName: string;
  Email: string;
}
interface LinkOption { ShareRequestId?: string; RequestNumber?: string; CaseId?: string; CaseNumber?: string; Status: string }

export interface ComposePrefill {
  to?: string;
  toName?: string;
  memberId?: string;
  caseId?: string;
  shareRequestId?: string;
  /** Hide the member search (recipient is fixed by the SR/Case we launched from). */
  lockMember?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSent: (thread: EmailThreadDetail) => void;
  prefill?: ComposePrefill;
}

const ComposeNewModal = ({ open, onClose, onSent, prefill }: Props) => {
  const [to, setTo] = useState('');
  const [toName, setToName] = useState('');
  const [memberId, setMemberId] = useState<string | undefined>();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [caseId, setCaseId] = useState<string | undefined>();
  const [shareRequestId, setShareRequestId] = useState<string | undefined>();
  const [shareRequests, setShareRequests] = useState<LinkOption[]>([]);
  const [cases, setCases] = useState<LinkOption[]>([]);

  const [memberQuery, setMemberQuery] = useState('');
  const [memberResults, setMemberResults] = useState<MemberSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  const { data: profile } = useUserProfile();
  const senderName = `${profile?.FirstName || ''} ${profile?.LastName || ''}`.trim();
  const refLabel = useMemo(() => {
    if (shareRequestId) return shareRequests.find((s) => s.ShareRequestId === shareRequestId)?.RequestNumber || null;
    if (caseId) return cases.find((c) => c.CaseId === caseId)?.CaseNumber || null;
    return null;
  }, [shareRequestId, caseId, shareRequests, cases]);

  // (Re)initialize on open.
  useEffect(() => {
    if (!open) return;
    setTo(prefill?.to || '');
    setToName(prefill?.toName || '');
    setMemberId(prefill?.memberId);
    setCaseId(prefill?.caseId);
    setShareRequestId(prefill?.shareRequestId);
    setSubject(''); setBody(''); setError(null); setFiles([]);
    setMemberQuery(''); setMemberResults([]);
    setShareRequests([]); setCases([]);
    if (prefill?.memberId) void loadLinkOptions(prefill.memberId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const loadLinkOptions = async (mid: string) => {
    try {
      const r = await inboxService.memberLinkOptions(mid);
      if (r.success) { setShareRequests(r.data.shareRequests || []); setCases(r.data.cases || []); }
    } catch { /* non-fatal */ }
  };

  // Debounced member search.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (memberQuery.trim().length < 2) { setMemberResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await apiService.get<{ success: boolean; data: MemberSearchResult[] }>(
          `/api/me/vendor/members/search?q=${encodeURIComponent(memberQuery.trim())}&limit=10`
        );
        setMemberResults(r.success ? r.data : []);
      } catch { setMemberResults([]); } finally { setSearching(false); }
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [memberQuery, open]);

  if (!open) return null;

  const selectMember = (m: MemberSearchResult) => {
    setMemberId(m.MemberId);
    setTo(m.Email || '');
    setToName(`${m.FirstName} ${m.LastName}`.trim());
    setMemberQuery('');
    setMemberResults([]);
    setShareRequestId(undefined); setCaseId(undefined);
    void loadLinkOptions(m.MemberId);
  };

  const send = async () => {
    if (!to.trim()) { setError('Enter a recipient.'); return; }
    if (!body.trim()) { setError('Enter a message.'); return; }
    setSending(true); setError(null);
    try {
      const html = body.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('');
      const r = await inboxService.compose({ to: to.trim(), toName, subject, bodyHtml: html, memberId, caseId, shareRequestId, files });
      if (r.success) { onSent(r.data); onClose(); }
      else setError(r.message || 'Failed to send');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally { setSending(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-5xl flex flex-col max-h-[88vh]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Mail className="h-4 w-4 text-oe-primary" /> New email</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex flex-col lg:flex-row flex-1 min-h-0">
          {/* LEFT: compose form */}
          <div className="lg:w-[380px] shrink-0 flex flex-col min-h-0 lg:border-r border-gray-200">

        {/* Recipient search kept outside the scroll area so results aren't clipped. */}
        {!prefill?.lockMember && (
          <div className="px-5 pt-4">
            <div className="relative">
              <label className="block text-xs font-medium text-gray-500 mb-1">Find member (optional)</label>
              <div className="relative">
                <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-gray-400" />
                <input value={memberQuery} onChange={(e) => setMemberQuery(e.target.value)} placeholder="Search members by name or email"
                  className="w-full text-sm border border-gray-300 rounded-md pl-8 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-oe-primary" />
                {searching && <Loader2 className="h-4 w-4 absolute right-2.5 top-2.5 text-gray-400 animate-spin" />}
              </div>
              {memberResults.length > 0 && (
                <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-48 overflow-y-auto">
                  {memberResults.map((m) => (
                    <button key={m.MemberId} type="button" onClick={() => selectMember(m)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50">
                      {m.FirstName} {m.LastName} <span className="text-gray-400">· {m.Email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="p-5 pt-3 space-y-3 overflow-y-auto">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
            <input value={to} onChange={(e) => { setTo(e.target.value); }} placeholder="recipient@email.com"
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-oe-primary" />
          </div>

          {memberId && (shareRequests.length > 0 || cases.length > 0) && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Share request</label>
                <select value={shareRequestId || ''} onChange={(e) => setShareRequestId(e.target.value || undefined)}
                  className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5">
                  <option value="">— none —</option>
                  {shareRequests.map((sr) => <option key={sr.ShareRequestId} value={sr.ShareRequestId}>{sr.RequestNumber} · {sr.Status}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Case</label>
                <select value={caseId || ''} onChange={(e) => setCaseId(e.target.value || undefined)}
                  className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5">
                  <option value="">— none —</option>
                  {cases.map((c) => <option key={c.CaseId} value={c.CaseId}>{c.CaseNumber} · {c.Status}</option>)}
                </select>
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Subject</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject"
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-oe-primary" />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Message</label>
            <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your message…"
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-oe-primary resize-none" />
            <p className="mt-1 text-[11px] text-gray-400">Sent from the shared mailbox. A friendly footer{(shareRequestId || caseId) ? ' + case reference' : ''} is added automatically.</p>
          </div>

          {/* Attachments */}
          <div>
            <input ref={fileInputRef} type="file" multiple className="hidden"
              onChange={(e) => { if (e.target.files) setFiles((p) => [...p, ...Array.from(e.target.files!)].slice(0, 10)); }} />
            <button type="button" onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1 text-xs text-oe-dark hover:underline">
              <Paperclip className="h-3.5 w-3.5" /> Attach files
            </button>
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {files.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1 text-xs bg-oe-light text-oe-dark rounded px-2 py-0.5">
                    <Paperclip className="h-3 w-3" />{f.name} <span className="text-gray-400">{fmtSize(f.size)}</span>
                    <button type="button" onClick={() => setFiles((p) => p.filter((_, idx) => idx !== i))} className="hover:text-red-600"><X className="h-3 w-3" /></button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>
          </div>

          {/* RIGHT: live preview (always visible for a new email) */}
          <div className="flex-1 min-w-0 bg-gray-100 overflow-y-auto p-4 border-t lg:border-t-0 border-gray-200">
            <div className="text-xs font-medium text-gray-500 mb-2 px-1">Preview</div>
            <EmailPreview
              bodyText={body}
              senderName={senderName}
              emailSignature={profile?.EmailSignature}
              emailCard={profile?.EmailCard}
              userId={profile?.UserId || ''}
              refLabel={refLabel}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200">
          <button type="button" onClick={onClose} className="text-sm border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md px-3 py-1.5">Cancel</button>
          <button type="button" onClick={send} disabled={sending} className="text-sm bg-oe-primary hover:bg-oe-dark disabled:opacity-50 text-white rounded-md px-4 py-1.5 inline-flex items-center gap-1">
            <Mail className="h-4 w-4" />{sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ComposeNewModal;

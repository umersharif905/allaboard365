// LinkThreadModal — match an email thread to a member + (share request and/or
// case). Auto-suggests from the sender's email; also lets the care team search
// for any member manually. Linking creates one encounter per message (server-side).
import { useEffect, useRef, useState } from 'react';
import { X, Link2, Loader2, Search } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import { inboxService } from '../../../services/inbox.service';
import type { LinkSuggestions } from '../../../types/email.types';

interface Props {
  threadId: string;
  open: boolean;
  onClose: () => void;
  onLinked: () => void;
}
interface MemberSearchResult { MemberId: string; FirstName: string; LastName: string; Email: string }
type LinkOption = { ShareRequestId?: string; RequestNumber?: string; CaseId?: string; CaseNumber?: string; Status: string };

const LinkThreadModal = ({ threadId, open, onClose, onLinked }: Props) => {
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<LinkSuggestions | null>(null);
  const [memberId, setMemberId] = useState<string | undefined>();
  const [memberLabel, setMemberLabel] = useState<string | undefined>(); // set when chosen via search
  const [memberOptions, setMemberOptions] = useState<{ shareRequests: LinkOption[]; cases: LinkOption[] } | null>(null);
  const [shareRequestId, setShareRequestId] = useState<string | undefined>();
  const [caseId, setCaseId] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [memberQuery, setMemberQuery] = useState('');
  const [memberResults, setMemberResults] = useState<MemberSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setSuggestions(null); setMemberId(undefined); setMemberLabel(undefined); setMemberOptions(null);
    setShareRequestId(undefined); setCaseId(undefined); setError(null);
    setMemberQuery(''); setMemberResults([]);
    const ac = new AbortController();
    setLoading(true);
    inboxService.suggestLinks(threadId, { signal: ac.signal })
      .then((r) => {
        if (r.success) {
          setSuggestions(r.data);
          if (r.data.members.length === 1) setMemberId(r.data.members[0].MemberId);
        }
      })
      .catch((e) => { if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'Failed to load suggestions'); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [open, threadId]);

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

  const pickSearchedMember = async (m: MemberSearchResult) => {
    setMemberId(m.MemberId);
    setMemberLabel(`${m.FirstName} ${m.LastName} · ${m.Email}`);
    setMemberQuery(''); setMemberResults([]);
    setShareRequestId(undefined); setCaseId(undefined);
    try {
      const r = await inboxService.memberLinkOptions(m.MemberId);
      if (r.success) setMemberOptions({ shareRequests: r.data.shareRequests, cases: r.data.cases });
    } catch { setMemberOptions({ shareRequests: [], cases: [] }); }
  };

  const pickSuggestedMember = (id: string) => {
    setMemberId(id); setMemberLabel(undefined); setMemberOptions(null);
    setShareRequestId(undefined); setCaseId(undefined);
  };

  const srOptions = memberOptions ? memberOptions.shareRequests : (suggestions?.shareRequests || []);
  const caseOptions = memberOptions ? memberOptions.cases : (suggestions?.cases || []);

  const confirm = async () => {
    if (!memberId && !shareRequestId && !caseId) { setError('Pick a member, share request, or case to link.'); return; }
    setSaving(true); setError(null);
    try {
      await inboxService.linkThread(threadId, { memberId, shareRequestId, caseId });
      onLinked();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <Link2 className="h-4 w-4 text-oe-primary" /> Match to member / case
          </h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>

        {/* Member search — kept OUTSIDE the scroll area so the results dropdown
            isn't clipped by the modal's overflow. */}
        <div className="px-5 pt-4">
          <div className="relative">
            <label className="block text-xs font-medium text-gray-500 mb-1">Search for a member</label>
            <div className="relative">
              <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-gray-400" />
              <input value={memberQuery} onChange={(e) => setMemberQuery(e.target.value)} placeholder="Name or email"
                className="w-full text-sm border border-gray-300 rounded-md pl-8 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-oe-primary" />
              {searching && <Loader2 className="h-4 w-4 absolute right-2.5 top-2.5 text-gray-400 animate-spin" />}
            </div>
            {memberResults.length > 0 && (
              <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-44 overflow-y-auto">
                {memberResults.map((m) => (
                  <button key={m.MemberId} type="button" onClick={() => pickSearchedMember(m)} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50">
                    {m.FirstName} {m.LastName} <span className="text-gray-400">· {m.Email}</span>
                  </button>
                ))}
              </div>
            )}
            {memberLabel && (
              <div className="mt-1.5 inline-flex items-center gap-1 text-xs bg-oe-light text-oe-dark rounded px-2 py-1">
                Selected: {memberLabel}
                <button type="button" onClick={() => { setMemberId(undefined); setMemberLabel(undefined); setMemberOptions(null); }} className="hover:text-red-600"><X className="h-3 w-3" /></button>
              </div>
            )}
          </div>
        </div>

        <div className="p-5 pt-3 space-y-4 max-h-[55vh] overflow-y-auto">
          {loading && <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Finding matches…</div>}

          {/* Auto-suggested members (sender match) */}
          {!memberLabel && suggestions && suggestions.members.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Suggested (matched the sender)</label>
              <div className="space-y-1.5">
                {suggestions.members.map((m) => (
                  <label key={m.MemberId} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="radio" name="member" checked={memberId === m.MemberId} onChange={() => pickSuggestedMember(m.MemberId)} />
                    <span>{m.FirstName} {m.LastName} <span className="text-gray-400">· {m.Email}</span></span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {memberId && srOptions.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Share request (optional)</label>
              <select className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5" value={shareRequestId || ''} onChange={(e) => setShareRequestId(e.target.value || undefined)}>
                <option value="">— none —</option>
                {srOptions.map((sr) => <option key={sr.ShareRequestId} value={sr.ShareRequestId}>{sr.RequestNumber} · {sr.Status}</option>)}
              </select>
            </div>
          )}

          {memberId && caseOptions.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Case (optional)</label>
              <select className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5" value={caseId || ''} onChange={(e) => setCaseId(e.target.value || undefined)}>
                <option value="">— none —</option>
                {caseOptions.map((c) => <option key={c.CaseId} value={c.CaseId}>{c.CaseNumber} · {c.Status}</option>)}
              </select>
            </div>
          )}

          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200">
          <button type="button" onClick={onClose} className="text-sm border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md px-3 py-1.5">Cancel</button>
          <button type="button" onClick={confirm} disabled={saving} className="text-sm bg-oe-primary hover:bg-oe-dark disabled:opacity-50 text-white rounded-md px-4 py-1.5">
            {saving ? 'Linking…' : 'Link'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default LinkThreadModal;

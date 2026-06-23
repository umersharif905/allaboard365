// ThreadContextPanel — right side of the thread reader. Top: the member this
// email is matched to (or a *suggested* match to Accept/Deny), with jump-to
// buttons and quick links. Bottom: the compact Phase-2 AI slot.
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserRound, ExternalLink, Link2, Mail, Phone, FileText, Briefcase, Sparkles, Check, X, Loader2, Search } from 'lucide-react';
import { inboxService } from '../../../services/inbox.service';
import type { EmailThreadDetail, MatchSuggestion } from '../../../types/email.types';

const AI_ASSIST_ENABLED = false; // Phase 2

interface Props {
  thread: EmailThreadDetail;
  onMatch: () => void;   // open the manual search/link modal
  onChanged: () => void; // reload the thread after a link
}

const ThreadContextPanel = ({ thread, onMatch, onChanged }: Props) => {
  const navigate = useNavigate();
  const matched = !!thread.MemberId;
  const memberName = `${thread.MemberFirstName || ''} ${thread.MemberLastName || ''}`.trim() || thread.LinkedMemberName;

  const [suggestion, setSuggestion] = useState<MatchSuggestion | null>(null);
  const [loadingSuggestion, setLoadingSuggestion] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (matched) { setSuggestion(null); return; }
    const ac = new AbortController();
    setLoadingSuggestion(true);
    inboxService.matchSuggestion(thread.ThreadId, { signal: ac.signal })
      .then((r) => { if (r.success) setSuggestion(r.data); })
      .catch(() => { /* non-fatal */ })
      .finally(() => { if (!ac.signal.aborted) setLoadingSuggestion(false); });
    return () => ac.abort();
  }, [thread.ThreadId, matched]);

  const accept = async () => {
    if (!suggestion) return;
    setBusy(true);
    try {
      await inboxService.linkThread(thread.ThreadId, {
        memberId: suggestion.member?.MemberId,
        shareRequestId: suggestion.shareRequestId || undefined,
        caseId: suggestion.caseId || undefined,
      });
      onChanged();
    } finally { setBusy(false); }
  };
  const deny = async () => {
    setBusy(true);
    try { await inboxService.dismissSuggestion(thread.ThreadId); setSuggestion(null); }
    finally { setBusy(false); }
  };

  const QuickLink = ({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) => (
    <button type="button" onClick={onClick}
      className="w-full flex items-center justify-between gap-2 text-sm px-2.5 py-2 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-700">
      <span className="flex items-center gap-2 min-w-0 truncate">{icon}<span className="truncate">{label}</span></span>
      <ExternalLink className="h-3.5 w-3.5 text-gray-400 shrink-0" />
    </button>
  );

  const suggMemberName = suggestion?.member
    ? `${suggestion.member.FirstName} ${suggestion.member.LastName}`.trim()
    : (suggestion?.shareRequestNumber || suggestion?.caseNumber || 'this record');

  return (
    <aside className="hidden xl:flex w-80 shrink-0 flex-col border-l border-gray-200 bg-gray-50/40">
      {/* Member */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Member</span>
          <button type="button" onClick={onMatch} className="text-xs text-oe-dark hover:underline inline-flex items-center gap-1">
            <Link2 className="h-3 w-3" /> {matched ? 'Change' : 'Match'}
          </button>
        </div>

        {matched ? (
          <>
            <div className="flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-full bg-oe-light text-oe-dark flex items-center justify-center font-semibold text-sm shrink-0">
                {(memberName || '?').slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-gray-900 truncate">{memberName || 'Member'}</div>
                {thread.MemberEmail && <div className="text-xs text-gray-500 truncate flex items-center gap-1"><Mail className="h-3 w-3" />{thread.MemberEmail}</div>}
                {thread.MemberPhone && <div className="text-xs text-gray-500 truncate flex items-center gap-1"><Phone className="h-3 w-3" />{thread.MemberPhone}</div>}
              </div>
            </div>
            <button type="button" onClick={() => navigate(`/vendor/members/${thread.MemberId}`)}
              className="mt-3 w-full inline-flex items-center justify-center gap-1.5 text-sm bg-oe-primary hover:bg-oe-dark text-white rounded-md px-3 py-1.5">
              <UserRound className="h-4 w-4" /> Open member profile
            </button>
          </>
        ) : loadingSuggestion ? (
          <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /> Looking for a match…</div>
        ) : suggestion ? (
          /* Pending suggested match — dashed/amber affordance until accepted */
          <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/60 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 mb-1.5">Suggested match — not linked yet</div>
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-full bg-amber-100 text-amber-800 flex items-center justify-center font-semibold text-sm shrink-0">
                {suggMemberName.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-gray-900 truncate">{suggMemberName}</div>
                {suggestion.member?.Email && <div className="text-xs text-gray-500 truncate">{suggestion.member.Email}</div>}
                {suggestion.member?.Phone && <div className="text-xs text-gray-500 truncate">{suggestion.member.Phone}</div>}
              </div>
            </div>
            {suggestion.planMember && (
              <div className="mt-2 rounded-md bg-white/70 border border-amber-200 px-2 py-1.5 text-[11px] text-gray-600">
                Email names{' '}
                <span className="font-medium text-gray-900">
                  {suggestion.planMember.FirstName} {suggestion.planMember.LastName}
                </span>{' '}
                ({suggestion.planMember.Relationship}) — on this plan. Linking the primary account holder.
              </div>
            )}
            {suggestion.reason && (
              <div className="text-[11px] text-amber-700 mt-1.5">
                {suggestion.reason}
                {suggestion.shareRequestNumber ? ` · ${suggestion.shareRequestNumber}` : ''}
                {suggestion.caseNumber ? ` · ${suggestion.caseNumber}` : ''}
              </div>
            )}
            <div className="flex gap-2 mt-2.5">
              <button type="button" onClick={accept} disabled={busy}
                className="flex-1 inline-flex items-center justify-center gap-1 text-sm bg-oe-primary hover:bg-oe-dark disabled:opacity-50 text-white rounded-md px-2 py-1.5">
                <Check className="h-4 w-4" /> Accept
              </button>
              <button type="button" onClick={deny} disabled={busy}
                className="flex-1 inline-flex items-center justify-center gap-1 text-sm border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 rounded-md px-2 py-1.5">
                <X className="h-4 w-4" /> Deny
              </button>
            </div>
            <button type="button" onClick={onMatch} className="mt-2 w-full text-xs text-oe-dark hover:underline inline-flex items-center justify-center gap-1">
              <Search className="h-3 w-3" /> Search for a different member
            </button>
          </div>
        ) : (
          <div className="text-sm text-gray-500">
            <p>Not matched to a member yet.</p>
            <button type="button" onClick={onMatch}
              className="mt-2 w-full inline-flex items-center justify-center gap-1.5 text-sm bg-oe-primary hover:bg-oe-dark text-white rounded-md px-3 py-1.5">
              <Link2 className="h-4 w-4" /> Match to member
            </button>
          </div>
        )}
      </div>

      {/* Quick links */}
      {matched && (
        <div className="p-4 border-b border-gray-200 space-y-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Quick links</span>
          {thread.ShareRequestId && (
            <QuickLink icon={<FileText className="h-4 w-4 text-oe-primary" />}
              label={thread.LinkedShareRequestNumber || 'Share request'}
              onClick={() => navigate(`/vendor/share-requests/${thread.ShareRequestId}`)} />
          )}
          {thread.CaseId && (
            <QuickLink icon={<Briefcase className="h-4 w-4 text-oe-primary" />}
              label={thread.LinkedCaseNumber || 'Case'}
              onClick={() => navigate(`/vendor/cases/${thread.CaseId}`)} />
          )}
          <QuickLink icon={<FileText className="h-4 w-4 text-gray-400" />} label="Member's share requests"
            onClick={() => navigate(`/vendor/share-requests?member=${thread.MemberId}`)} />
          <QuickLink icon={<Briefcase className="h-4 w-4 text-gray-400" />} label="Member's cases"
            onClick={() => navigate(`/vendor/cases?member=${thread.MemberId}`)} />
        </div>
      )}

      {/* Compact AI slot (Phase 2) */}
      <div className="p-4 mt-auto">
        <div className="rounded-lg border border-violet-200 bg-gradient-to-b from-violet-50 to-white p-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-700">
            <Sparkles className="h-3.5 w-3.5" /> AI Assist
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-600 text-white font-medium">Phase 2</span>
          </div>
          <p className="text-[11px] text-violet-500 mt-1.5 leading-relaxed">
            {AI_ASSIST_ENABLED ? null : 'Suggested next step & draft reply — coming soon.'}
          </p>
        </div>
      </div>
    </aside>
  );
};

export default ThreadContextPanel;

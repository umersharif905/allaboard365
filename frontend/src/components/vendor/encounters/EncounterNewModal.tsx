// EncounterNewModal — single-screen, summary-only-required.
// Layout: member search (optional) → optional case/SR pin → channel/direction
// → occurred-at → big summary textarea → optional follow-up.
// Save button enables once Summary has any non-whitespace text.
// If member is blank, the encounter saves without a member and can be
// assigned one later. Maps to future Zoom (inbound call with no caller-id
// match → no member).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Briefcase, CalendarClock, ClipboardList, Phone, Mail, Users, MessageCircle, Video, MoreHorizontal, Search, User, X } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import type { CaseRow, MemberSearchResult } from '../../../types/case.types';
import {
  CHANNEL_LABELS,
  DIRECTION_LABELS,
  ENCOUNTER_CHANNELS,
  ENCOUNTER_DIRECTIONS,
  type EncounterChannel,
  type EncounterDirection,
  type EncounterRow,
  type EncounterScope,
} from '../../../types/encounter.types';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (created: EncounterRow) => void;
  /** Pre-fill the modal with a scope (e.g. opened from a case tab). */
  prefillScope?: EncounterScope;
}

interface SearchResp { success: boolean; data: MemberSearchResult[] }
interface CreateResp { success: boolean; data: EncounterRow; message?: string }
interface WithHouseholdResp {
  success: boolean;
  data?: {
    member: {
      MemberId: string;
      FirstName?: string | null;
      LastName?: string | null;
      Email?: string | null;
      PhoneNumber?: string | null;
      HouseholdId?: string | null;
      HouseholdMemberID?: string | null;
    };
  };
}
interface CasesListResp { success: boolean; data: CaseRow[] }
interface SrListItem {
  ShareRequestId: string;
  RequestNumber: string;
  Status?: string | null;
  // Plenty more fields exist; we only render number + status.
}
interface SrListResp { success: boolean; data: SrListItem[] }

const ChannelIcon = ({ ch }: { ch: EncounterChannel }) => {
  switch (ch) {
    case 'phone':     return <Phone className="h-3.5 w-3.5" />;
    case 'email':     return <Mail className="h-3.5 w-3.5" />;
    case 'in_person': return <Users className="h-3.5 w-3.5" />;
    case 'sms':       return <MessageCircle className="h-3.5 w-3.5" />;
    case 'video':     return <Video className="h-3.5 w-3.5" />;
    default:          return <MoreHorizontal className="h-3.5 w-3.5" />;
  }
};

// HTML datetime-local needs YYYY-MM-DDTHH:MM (no seconds, no Z). Build
// from a local Date so the picker shows the user's local time.
const toLocalInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const EncounterNewModal = ({ open, onClose, onCreated, prefillScope }: Props) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemberSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<MemberSearchResult | null>(null);
  const [channel, setChannel] = useState<EncounterChannel | ''>('');
  const [direction, setDirection] = useState<EncounterDirection | ''>('');
  const [occurredAt, setOccurredAt] = useState<string>('');
  const [summary, setSummary] = useState('');
  const [needsFollowUp, setNeedsFollowUp] = useState(false);
  const [followUpDate, setFollowUpDate] = useState('');
  const [pinnedCaseId, setPinnedCaseId] = useState<string | null>(null);
  const [pinnedSrId, setPinnedSrId] = useState<string | null>(null);
  const [memberCases, setMemberCases] = useState<CaseRow[]>([]);
  const [memberSrs, setMemberSrs] = useState<SrListItem[]>([]);
  const [linksLoading, setLinksLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    setQuery('');
    setResults([]);
    setSelected(null);
    setChannel('');
    setDirection('');
    setOccurredAt(toLocalInput(new Date()));
    setSummary('');
    setNeedsFollowUp(false);
    setFollowUpDate('');
    setPinnedCaseId(prefillScope?.kind === 'case' ? prefillScope.caseId : null);
    setPinnedSrId(prefillScope?.kind === 'shareRequest' ? prefillScope.shareRequestId : null);
    setMemberCases([]);
    setMemberSrs([]);
    setError(null);
  }, [prefillScope]);

  useEffect(() => {
    if (!open) return;
    reset();
    // Resolve a memberId from the scope, regardless of kind — the case +
    // share-request tabs also know their member, so autofill it.
    const prefilledMemberId =
      prefillScope?.kind === 'member' ? prefillScope.memberId
        : prefillScope?.kind === 'case' ? prefillScope.memberId
        : prefillScope?.kind === 'shareRequest' ? prefillScope.memberId
        : undefined;
    if (prefilledMemberId) {
      void (async () => {
        // /members/search filters by FirstName/LastName/Email/HouseholdMemberID
        // with a LIKE — it does NOT match on the MemberId GUID, so the old
        // search-by-id approach silently returned no results. Use the
        // /members/:id/with-household endpoint instead (authorized for both
        // VendorAdmin and VendorAgent) and map the Member shape into the
        // MemberSearchResult shape the rest of the modal expects.
        try {
          const resp = await apiService.get<WithHouseholdResp>(
            `/api/members/${prefilledMemberId}/with-household`
          );
          const m = resp.data?.member;
          if (m && m.MemberId) {
            setSelected({
              MemberId: m.MemberId,
              FirstName: m.FirstName || '',
              LastName: m.LastName || '',
              Email: m.Email ?? null,
              Phone: m.PhoneNumber ?? null,
              HouseholdId: m.HouseholdId ?? null,
              HouseholdMemberID: m.HouseholdMemberID ?? null,
            });
          }
        } catch {
          // soft-fail; user can search again manually.
        }
      })();
    }
  }, [open, prefillScope, reset]);

  useEffect(() => {
    if (!open || selected) return;
    if (!query || query.trim().length < 2) {
      setResults([]);
      return;
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const resp = await apiService.get<SearchResp>(
          `/api/me/vendor/members/search?q=${encodeURIComponent(query.trim())}&limit=10`
        );
        if (resp.success) setResults(resp.data);
      } catch {
        // soft-fail
      } finally {
        setSearching(false);
      }
    }, 200);

    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, selected, open]);

  // When a member is set, fetch their cases + share requests so the user
  // can pin one. Open items only would be ideal, but the existing list
  // endpoints don't have an "open" filter — we fetch up to 50 of each
  // (newest first by default) and let the UI label closed items as such.
  useEffect(() => {
    if (!open || !selected) {
      setMemberCases([]);
      setMemberSrs([]);
      return;
    }
    const ac = new AbortController();
    setLinksLoading(true);
    void (async () => {
      try {
        const [casesResp, srResp] = await Promise.all([
          apiService.get<CasesListResp>(
            `/api/me/vendor/cases?memberId=${selected.MemberId}&limit=50`,
            { signal: ac.signal }
          ),
          apiService.get<SrListResp>(
            `/api/me/vendor/share-requests?memberId=${selected.MemberId}&limit=50`,
            { signal: ac.signal }
          ),
        ]);
        if (ac.signal.aborted) return;
        setMemberCases(casesResp.success ? casesResp.data : []);
        setMemberSrs(srResp.success ? srResp.data : []);
      } catch {
        // soft-fail; user just won't see options.
      } finally {
        if (!ac.signal.aborted) setLinksLoading(false);
      }
    })();
    return () => ac.abort();
  }, [open, selected]);

  const canSubmit = summary.trim().length > 0 && !saving;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);

    const payload: Record<string, unknown> = {
      summary: summary.trim(),
      memberId: selected?.MemberId ?? null,
      caseId: pinnedCaseId,
      shareRequestId: pinnedSrId,
      channel: channel || null,
      direction: direction || null,
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null,
      followUpDueDate: needsFollowUp && followUpDate ? new Date(followUpDate).toISOString() : null,
    };

    try {
      const resp = await apiService.post<CreateResp>('/api/me/vendor/encounters', payload);
      if (resp.success && resp.data) {
        onCreated(resp.data);
      } else {
        setError(resp.message || 'Failed to create encounter');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create encounter');
    } finally {
      setSaving(false);
    }
  }, [canSubmit, summary, selected, pinnedCaseId, pinnedSrId, channel, direction, occurredAt, needsFollowUp, followUpDate, onCreated]);

  if (!open) return null;

  const showNoMemberHint = !selected;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="w-full max-w-2xl bg-white rounded-lg shadow-xl border border-gray-200 max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">New Encounter</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Just type — fill in the rest as you go.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-700 rounded"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Member search */}
          <section>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Member <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            {selected ? (
              <div className="flex items-start justify-between gap-3 p-3 bg-oe-light/40 rounded-lg border border-oe-light">
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 rounded-full bg-white border border-oe-light flex items-center justify-center text-oe-primary">
                    <User className="h-5 w-5" />
                  </div>
                  <div className="text-sm">
                    <div className="font-medium text-gray-900">
                      {selected.FirstName} {selected.LastName}
                    </div>
                    <div className="text-gray-600">
                      {selected.Email || '—'}{selected.Phone ? ` · ${selected.Phone}` : ''}
                    </div>
                    {selected.HouseholdMemberID && (
                      <div className="text-xs text-gray-500 mt-0.5">
                        Member ID: {selected.HouseholdMemberID}
                      </div>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { setSelected(null); setQuery(''); }}
                  className="text-xs text-gray-500 hover:text-oe-primary"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name, email, or member ID…"
                    className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    autoFocus={!summary}
                  />
                </div>
                {searching && <p className="text-xs text-gray-500 mt-2">Searching…</p>}
                {results.length > 0 && (
                  <ul className="mt-2 max-h-56 overflow-y-auto border border-gray-200 rounded-md divide-y divide-gray-100">
                    {results.map((m) => (
                      <li key={m.MemberId}>
                        <button
                          type="button"
                          onClick={() => { setSelected(m); setResults([]); }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-oe-light/30 transition-colors"
                        >
                          <div className="font-medium text-gray-900">
                            {m.FirstName} {m.LastName}
                          </div>
                          <div className="text-xs text-gray-500">
                            {m.Email || '—'}{m.HouseholdMemberID ? ` · #${m.HouseholdMemberID}` : ''}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {showNoMemberHint && (
                  <p className="mt-2 text-xs text-gray-500">
                    No member yet? That's fine — you can save without one and assign one later.
                  </p>
                )}
              </>
            )}
          </section>

          {/* Optional links to a Case / Share Request — visible only when a member is selected. */}
          {selected && (
            <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
                  <Briefcase className="h-3.5 w-3.5 text-gray-400" />
                  Link to a case <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <select
                  value={pinnedCaseId ?? ''}
                  onChange={(e) => setPinnedCaseId(e.target.value || null)}
                  disabled={linksLoading}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary disabled:bg-gray-50"
                >
                  <option value="">{linksLoading ? 'Loading…' : memberCases.length === 0 ? 'No cases for this member' : '— None —'}</option>
                  {memberCases.map((c) => (
                    <option key={c.CaseId} value={c.CaseId}>
                      {c.CaseNumber}{c.Title ? ` · ${c.Title}` : ''}{c.Status ? ` · ${c.Status}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
                  <ClipboardList className="h-3.5 w-3.5 text-gray-400" />
                  Link to a share request <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <select
                  value={pinnedSrId ?? ''}
                  onChange={(e) => setPinnedSrId(e.target.value || null)}
                  disabled={linksLoading}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary disabled:bg-gray-50"
                >
                  <option value="">{linksLoading ? 'Loading…' : memberSrs.length === 0 ? 'No share requests for this member' : '— None —'}</option>
                  {memberSrs.map((s) => (
                    <option key={s.ShareRequestId} value={s.ShareRequestId}>
                      {s.RequestNumber}{s.Status ? ` · ${s.Status}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </section>
          )}

          {/* Channel + Direction */}
          <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Channel</label>
              <div className="grid grid-cols-3 gap-1 p-1 bg-gray-50 rounded-lg border border-gray-200">
                {ENCOUNTER_CHANNELS.map((ch) => {
                  const active = channel === ch;
                  return (
                    <button
                      key={ch}
                      type="button"
                      onClick={() => setChannel(active ? '' : ch)}
                      className={`inline-flex items-center justify-center gap-1 py-1.5 text-xs rounded-md transition-colors ${
                        active ? 'bg-white text-oe-dark shadow-sm font-medium' : 'text-gray-600 hover:text-gray-900'
                      }`}
                      aria-pressed={active}
                    >
                      <ChannelIcon ch={ch} />
                      {CHANNEL_LABELS[ch]}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Direction</label>
              <div className="grid grid-cols-3 gap-1 p-1 bg-gray-50 rounded-lg border border-gray-200">
                {ENCOUNTER_DIRECTIONS.map((d) => {
                  const active = direction === d;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDirection(active ? '' : d)}
                      className={`py-1.5 text-xs rounded-md transition-colors ${
                        active ? 'bg-white text-oe-dark shadow-sm font-medium' : 'text-gray-600 hover:text-gray-900'
                      }`}
                      aria-pressed={active}
                    >
                      {DIRECTION_LABELS[d]}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          {/* Occurred at */}
          <section>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              When did this happen?
            </label>
            <div className="relative">
              <CalendarClock className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="datetime-local"
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
              />
            </div>
          </section>

          {/* Summary — the only required field */}
          <section>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              What was discussed? <span className="text-red-500">*</span>
            </label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Type as the conversation happens — names, key points, action items…"
              rows={6}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
              autoFocus={!!summary}
            />
          </section>

          {/* Follow-up */}
          <section>
            <label className="inline-flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={needsFollowUp}
                onChange={(e) => setNeedsFollowUp(e.target.checked)}
                className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
              />
              Needs follow-up by
            </label>
            {needsFollowUp && (
              <input
                type="datetime-local"
                value={followUpDate}
                onChange={(e) => setFollowUpDate(e.target.value)}
                className="ml-6 mt-1 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
              />
            )}
          </section>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-6 py-3 border-t border-gray-200 bg-gray-50/40">
          <span className="text-xs text-gray-500">
            {selected
              ? null
              : <span>Saves without a member until one is assigned.</span>}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm border border-gray-300 rounded-md bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-md disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save encounter'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EncounterNewModal;

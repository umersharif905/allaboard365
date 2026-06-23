// EncounterDetailCard — detail panel for the dashboard's right side.
// Shows summary + meta + actions (mark follow-up done, convert to support
// ticket, archive, edit summary inline).

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Briefcase, Check, ClipboardList, Edit3, Search, Trash2, User, UserPlus, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiService } from '../../../services/api.service';
import { updateEncounterNotes } from '../../../services/vendorCallCenter.service';
import type {
  CaseRow,
  MemberSearchResult,
  CaseType,
  CaseSubcategory,
} from '../../../types/case.types';
import { useCaseTaxonomy } from '../../../hooks/useCaseTaxonomy';
import {
  channelLabel,
  directionLabel,
  type EncounterRow,
} from '../../../types/encounter.types';
import EncounterFollowUpBadge from './EncounterFollowUpBadge';
import EncounterAttachmentsSection from './EncounterAttachmentsSection';
import { useMemberModalLauncher } from '../../../hooks/useMemberModalLauncher';
import { AttachToCase, AttachToShareRequest } from './AttachPicker';

interface Props {
  encounterId: string;
  onChanged: () => void;
  onArchived: () => void;
}

interface GetResp { success: boolean; data: EncounterRow }
interface ConvertResp { success: boolean; data: { encounter: EncounterRow; case: CaseRow } }
interface SearchResp { success: boolean; data: MemberSearchResult[] }

const fmtDateTime = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const EncounterDetailCard = ({ encounterId, onChanged, onArchived }: Props) => {
  const navigate = useNavigate();
  const { types: caseTypes, subcategoriesForType } = useCaseTaxonomy();
  const [encounter, setEncounter] = useState<EncounterRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingSummary, setEditingSummary] = useState(false);
  const [draftSummary, setDraftSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [notesValue, setNotesValue] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);

  // Member assign / change state.
  const [showMemberPicker, setShowMemberPicker] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');
  const [memberResults, setMemberResults] = useState<MemberSearchResult[]>([]);
  const [memberSearching, setMemberSearching] = useState(false);
  const memberDebounceRef = useRef<number | null>(null);

  // Click the member chip to open the full member modal directly.
  const { openMember, MemberModalElement } = useMemberModalLauncher();

  // Convert-to-support-ticket confirmation modal + the type/subcategory fields
  // captured there. Default type is 'encounter_escalation' since this is the
  // most common reason to escalate an encounter; user can override.
  const [showConvertModal, setShowConvertModal] = useState(false);
  const [convertCaseType, setConvertCaseType] = useState<CaseType>('encounter_escalation');
  const [convertCaseSubcategory, setConvertCaseSubcategory] = useState<CaseSubcategory | ''>('');
  const [convertSubcategoryDetail, setConvertSubcategoryDetail] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await apiService.get<GetResp>(
        `/api/me/vendor/encounters/${encounterId}`,
        signal ? { signal } : undefined
      );
      if (signal?.aborted) return;
      if (resp.success) {
        setEncounter(resp.data);
        setNotesValue(resp.data.Notes ?? '');
      } else setError('Failed to load encounter');
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : 'Failed to load encounter');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [encounterId]);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  // Debounced member search inside the assign panel.
  useEffect(() => {
    if (!showMemberPicker) return;
    if (!memberQuery || memberQuery.trim().length < 2) {
      setMemberResults([]);
      return;
    }
    if (memberDebounceRef.current) window.clearTimeout(memberDebounceRef.current);
    memberDebounceRef.current = window.setTimeout(async () => {
      setMemberSearching(true);
      try {
        const resp = await apiService.get<SearchResp>(
          `/api/me/vendor/members/search?q=${encodeURIComponent(memberQuery.trim())}&limit=10`
        );
        if (resp.success) setMemberResults(resp.data);
      } catch {
        // soft-fail
      } finally {
        setMemberSearching(false);
      }
    }, 200);
    return () => { if (memberDebounceRef.current) window.clearTimeout(memberDebounceRef.current); };
  }, [memberQuery, showMemberPicker]);


  const handleAssignMember = useCallback(async (memberId: string) => {
    if (!encounter) return;
    setBusy(true);
    try {
      const resp = await apiService.patch<GetResp>(
        `/api/me/vendor/encounters/${encounter.EncounterId}`,
        { memberId }
      );
      if (resp.success) {
        setEncounter(resp.data);
        setShowMemberPicker(false);
        setMemberQuery('');
        setMemberResults([]);
        onChanged();
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Assign failed');
    } finally {
      setBusy(false);
    }
  }, [encounter, onChanged]);

  const handleSaveSummary = useCallback(async () => {
    if (!encounter || !draftSummary.trim()) return;
    setBusy(true);
    try {
      const resp = await apiService.patch<GetResp>(
        `/api/me/vendor/encounters/${encounter.EncounterId}`,
        { summary: draftSummary.trim() }
      );
      if (resp.success) {
        setEncounter(resp.data);
        setEditingSummary(false);
        onChanged();
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }, [encounter, draftSummary, onChanged]);

  const handleCompleteFollowUp = useCallback(async () => {
    if (!encounter) return;
    setBusy(true);
    try {
      const resp = await apiService.post<GetResp>(
        `/api/me/vendor/encounters/${encounter.EncounterId}/follow-up/complete`,
        {}
      );
      if (resp.success) {
        setEncounter(resp.data);
        onChanged();
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Failed to complete follow-up');
    } finally {
      setBusy(false);
    }
  }, [encounter, onChanged]);

  // The button is only rendered when MemberId && !CaseId, so we don't
  // need defensive guards here — just open the styled confirm modal and reset
  // the type/subcategory fields to defaults.
  const handleConvertToCase = useCallback(() => {
    setConvertCaseType('encounter_escalation');
    setConvertCaseSubcategory('');
    setConvertSubcategoryDetail('');
    setShowConvertModal(true);
  }, []);

  // Clear subcategory when type changes (subcategories are type-specific).
  useEffect(() => {
    setConvertCaseSubcategory('');
    setConvertSubcategoryDetail('');
  }, [convertCaseType]);

  const handleConfirmConvertToCase = useCallback(async () => {
    if (!encounter) return;
    setBusy(true);
    try {
      const resp = await apiService.post<ConvertResp>(
        `/api/me/vendor/encounters/${encounter.EncounterId}/convert-to-case`,
        {
          description: encounter.Summary,
          caseType: convertCaseType,
          caseSubcategory: convertCaseSubcategory || null,
          subcategoryDetail: convertSubcategoryDetail.trim() || null,
        }
      );
      if (resp.success) {
        setShowConvertModal(false);
        navigate(`/vendor/cases/${resp.data.case.CaseId}`);
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Convert failed');
    } finally {
      setBusy(false);
    }
  }, [encounter, navigate, convertCaseType, convertCaseSubcategory, convertSubcategoryDetail]);

  const handleArchive = useCallback(async () => {
    if (!encounter) return;
    if (!window.confirm('Archive this encounter?')) return;
    setBusy(true);
    try {
      await apiService.delete(`/api/me/vendor/encounters/${encounter.EncounterId}`);
      onArchived();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Archive failed');
    } finally {
      setBusy(false);
    }
  }, [encounter, onArchived]);

  const handleSaveNotes = useCallback(async () => {
    if (!encounter) return;
    setSavingNotes(true);
    setNotesSaved(false);
    try {
      await updateEncounterNotes(encounter.EncounterId, notesValue);
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
      onChanged();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSavingNotes(false);
    }
  }, [encounter, notesValue, onChanged]);

  // Called by attach pickers after a successful attach so the display refreshes.
  const handleAttached = useCallback(() => {
    void load();
    onChanged();
  }, [load, onChanged]);

  if (loading) return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  if (error) return <div className="p-6"><div className="bg-red-50 border border-red-200 rounded p-4 text-sm text-red-700">{error}</div></div>;
  if (!encounter) return <div className="p-6 text-sm text-gray-500">Encounter not found.</div>;

  const memberName = `${encounter.MemberFirstName || ''} ${encounter.MemberLastName || ''}`.trim();
  const followUpOpen = encounter.FollowUpDueDate && !encounter.FollowUpCompletedAt;

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-3xl">
      {/* Header card */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span className="font-mono font-semibold text-gray-900 text-sm">{encounter.EncounterNumber}</span>
              <span>·</span>
              <span>{fmtDateTime(encounter.OccurredAt || encounter.CreatedDate)}</span>
              {encounter.Channel && <><span>·</span><span>{channelLabel(encounter.Channel)}</span></>}
              {encounter.Direction && <><span>·</span><span>{directionLabel(encounter.Direction)}</span></>}
              {!encounter.MemberId && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-800">
                  No member
                </span>
              )}
              <EncounterFollowUpBadge encounter={encounter} size="sm" />
            </div>

            {/* Member row — assign button when no member set; name + Change when set. */}
            <div className="mt-3">
              {encounter.MemberId ? (
                <div className="flex items-center gap-2 text-sm">
                  <button
                    type="button"
                    onClick={() => encounter.MemberId && void openMember(encounter.MemberId)}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left rounded-md hover:bg-oe-light/30 px-1 -mx-1 py-0.5 transition-colors"
                    aria-label={`Open ${memberName || 'member'} profile`}
                  >
                    <div className="h-7 w-7 rounded-full bg-oe-light/60 border border-oe-light flex items-center justify-center text-oe-primary shrink-0">
                      <User className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate hover:text-oe-primary">{memberName || 'Member'}</div>
                      {encounter.MemberEmail && <div className="text-xs text-gray-500 truncate">{encounter.MemberEmail}</div>}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowMemberPicker((v) => !v)}
                    className="text-xs text-gray-500 hover:text-oe-primary shrink-0"
                  >
                    {showMemberPicker ? 'Cancel' : 'Change'}
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2 p-2.5 rounded-md bg-amber-50 border border-amber-200">
                  <div className="text-xs text-amber-900">
                    No member assigned yet.
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowMemberPicker((v) => !v)}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-md disabled:opacity-50"
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    {showMemberPicker ? 'Cancel' : 'Assign member'}
                  </button>
                </div>
              )}

              {showMemberPicker && (
                <div className="mt-2 p-3 border border-gray-200 rounded-md bg-gray-50/40">
                  <div className="relative">
                    <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={memberQuery}
                      onChange={(e) => setMemberQuery(e.target.value)}
                      placeholder="Search by name, email, or member ID…"
                      className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      autoFocus
                    />
                  </div>
                  {memberSearching && <p className="text-xs text-gray-500 mt-2">Searching…</p>}
                  {memberResults.length > 0 && (
                    <ul className="mt-2 max-h-56 overflow-y-auto border border-gray-200 rounded-md divide-y divide-gray-100 bg-white">
                      {memberResults.map((m) => {
                        const isCurrent = m.MemberId === encounter.MemberId;
                        return (
                          <li key={m.MemberId}>
                            <button
                              type="button"
                              disabled={isCurrent || busy}
                              onClick={() => handleAssignMember(m.MemberId)}
                              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                                isCurrent ? 'opacity-50 cursor-not-allowed' : 'hover:bg-oe-light/30'
                              }`}
                            >
                              <div className="font-medium text-gray-900">{m.FirstName} {m.LastName}</div>
                              <div className="text-xs text-gray-500">
                                {m.Email || '—'}{m.HouseholdMemberID ? ` · #${m.HouseholdMemberID}` : ''}
                                {isCurrent ? ' · current' : ''}
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {!memberSearching && memberQuery.trim().length >= 2 && memberResults.length === 0 && (
                    <p className="text-xs text-gray-500 mt-2">No matching members.</p>
                  )}
                </div>
              )}
            </div>

            {/* Linked case / SR — display + attach pickers. Available for all encounters. */}
            <div className="mt-3 p-2.5 rounded-md border border-gray-200 bg-gray-50/40">
              {/* Status display (when a member is assigned, show linked case/SR numbers) */}
              {encounter.MemberId && (
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    <span className="inline-flex items-center gap-1 text-gray-700">
                      <Briefcase className="h-3.5 w-3.5 text-gray-400" />
                      Case:{' '}
                      {encounter.PinnedCaseNumber ? (
                        <button
                          type="button"
                          onClick={() => navigate(`/vendor/cases/${encounter.CaseId}`)}
                          className="font-mono text-oe-dark hover:text-oe-primary"
                        >
                          {encounter.PinnedCaseNumber}
                        </button>
                      ) : (
                        <span className="text-gray-500">none</span>
                      )}
                    </span>
                    <span className="inline-flex items-center gap-1 text-gray-700">
                      <ClipboardList className="h-3.5 w-3.5 text-gray-400" />
                      SR:{' '}
                      {encounter.PinnedShareRequestNumber ? (
                        <button
                          type="button"
                          onClick={() => navigate(`/vendor/share-requests/${encounter.ShareRequestId}`)}
                          className="font-mono text-oe-dark hover:text-oe-primary"
                        >
                          {encounter.PinnedShareRequestNumber}
                        </button>
                      ) : (
                        <span className="text-gray-500">none</span>
                      )}
                    </span>
                  </div>
                </div>
              )}
              {/* Attach pickers — work for all encounters (with or without member) */}
              <div className="space-y-2">
                <AttachToCase
                  encounterId={encounter.EncounterId}
                  memberId={encounter.MemberId}
                  currentCaseId={encounter.CaseId}
                  onAttached={handleAttached}
                />
                <AttachToShareRequest
                  encounterId={encounter.EncounterId}
                  memberId={encounter.MemberId}
                  currentShareRequestId={encounter.ShareRequestId}
                  onAttached={handleAttached}
                />
              </div>
            </div>

            <div className="mt-3 text-xs text-gray-600">
              <span className="text-gray-500">By: </span>{encounter.CreatedByName || '—'}
            </div>
          </div>
        </div>
      </div>

      {/* Summary card */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900">Summary</h3>
          {!editingSummary && (
            <button
              type="button"
              onClick={() => { setDraftSummary(encounter.Summary); setEditingSummary(true); }}
              className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-oe-primary"
            >
              <Edit3 className="h-3 w-3" /> Edit
            </button>
          )}
        </div>
        {editingSummary ? (
          <div className="space-y-2">
            <textarea
              value={draftSummary}
              onChange={(e) => setDraftSummary(e.target.value)}
              rows={6}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingSummary(false)}
                disabled={busy}
                className="px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 rounded inline-flex items-center gap-1"
              >
                <X className="h-3 w-3" /> Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveSummary}
                disabled={busy || !draftSummary.trim()}
                className="px-3 py-1 text-xs font-medium text-white bg-oe-primary hover:bg-oe-dark rounded disabled:opacity-50 inline-flex items-center gap-1"
              >
                <Check className="h-3 w-3" /> Save
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-800 whitespace-pre-wrap">{encounter.Summary}</p>
        )}
      </div>

      {/* Notes card */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Notes</h3>
        <textarea
          value={notesValue}
          onChange={(e) => setNotesValue(e.target.value)}
          rows={3}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary resize-y"
          placeholder="Add internal notes about this encounter…"
        />
        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            onClick={handleSaveNotes}
            disabled={savingNotes}
            className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium text-white bg-oe-primary hover:bg-oe-dark rounded disabled:opacity-50"
          >
            <Check className="h-3 w-3" />
            {savingNotes ? 'Saving…' : 'Save notes'}
          </button>
          {notesSaved && (
            <span className="text-xs text-oe-success">Saved</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Actions</h3>
        {!encounter.MemberId && (
          <div className="mb-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-2">
            Assign a member to this encounter before performing actions like escalating to a case.
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {followUpOpen && (
            <button
              type="button"
              onClick={handleCompleteFollowUp}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-300 rounded-md bg-white hover:bg-gray-50 disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" /> Mark follow-up done
            </button>
          )}
          {encounter.MemberId && !encounter.CaseId && (
            <button
              type="button"
              onClick={handleConvertToCase}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-oe-primary text-oe-dark bg-white hover:bg-oe-light rounded-md disabled:opacity-50"
            >
              <Briefcase className="h-3.5 w-3.5" /> Convert to case <ArrowRight className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={handleArchive}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-md disabled:opacity-50 ml-auto"
          >
            <Trash2 className="h-3.5 w-3.5" /> Archive
          </button>
        </div>
      </div>

      {/* Attachments */}
      <EncounterAttachmentsSection encounterId={encounter.EncounterId} />

      {showConvertModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="convert-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setShowConvertModal(false); }}
        >
          <div className="w-full max-w-md bg-white rounded-lg shadow-xl border border-gray-200">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <h2 id="convert-modal-title" className="text-base font-semibold text-gray-900 inline-flex items-center gap-2">
                <Briefcase className="h-4 w-4 text-oe-primary" />
                Convert to case
              </h2>
              <button
                type="button"
                onClick={() => setShowConvertModal(false)}
                disabled={busy}
                className="p-1 text-gray-400 hover:text-gray-700 rounded disabled:opacity-50"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3 text-sm text-gray-700">
              <p>
                A new case will be created for{' '}
                <span className="font-medium text-gray-900">{memberName || 'this member'}</span>{' '}
                and linked back to encounter{' '}
                <span className="font-mono text-xs text-gray-700">{encounter.EncounterNumber}</span>.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Type <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={convertCaseType}
                    onChange={(e) => setConvertCaseType(e.target.value as CaseType)}
                    disabled={busy}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary disabled:opacity-50"
                  >
                    {caseTypes.map((t) => (
                      <option key={t.code} value={t.code}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Subcategory <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <select
                    value={convertCaseSubcategory}
                    onChange={(e) => setConvertCaseSubcategory(e.target.value as CaseSubcategory | '')}
                    disabled={busy}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary disabled:opacity-50"
                  >
                    <option value="">— None —</option>
                    {subcategoriesForType(convertCaseType).map((s) => (
                      <option key={s.code} value={s.code}>{s.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {convertCaseSubcategory && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Subcategory detail <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={convertSubcategoryDetail}
                    onChange={(e) => setConvertSubcategoryDetail(e.target.value)}
                    disabled={busy}
                    placeholder="e.g. denied claim 2025-04, follow-up needed…"
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary disabled:opacity-50"
                  />
                </div>
              )}

              <p className="pt-1">The ticket description will start as this encounter's summary:</p>
              <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 max-h-40 overflow-y-auto text-xs text-gray-700 whitespace-pre-wrap">
                {encounter.Summary}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50/40">
              <button
                type="button"
                onClick={() => setShowConvertModal(false)}
                disabled={busy}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmConvertToCase}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-md disabled:opacity-50"
              >
                <Briefcase className="h-3.5 w-3.5" />
                {busy ? 'Creating case…' : 'Convert to case'}
              </button>
            </div>
          </div>
        </div>
      )}

      {MemberModalElement}
    </div>
  );
};

export default EncounterDetailCard;

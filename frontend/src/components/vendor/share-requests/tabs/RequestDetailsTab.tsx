// RequestDetailsTab — primary read/edit surface for one share request.
//
// Layout:
//   • System-data card grid (3 columns on desktop). Each card groups one
//     facet — Classification, Status, Service, Financial, Dates, Notes.
//   • Member direct deposit lives full-width below the grid (unchanged).
//   • Member submission(s) render at the bottom — every form field the
//     member filled, grouped by the form's pages, in a 2-col grid per page.
//
// Edit mode swaps the read rows inside the system cards for inputs. The
// member-submission section is always read-only.

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert, FileText, Pencil, Save, X } from 'lucide-react';
import CaseStudyModal from '../CaseStudyModal';
import { apiService } from '../../../../services/api.service';
import { vendorRequestTypesService } from '../../../../services/vendorRequestTypes.service';
import {
  type ShareRequest,
  type ShareRequestDetailResponse,
  type VendorRequestType,
} from '../../../../types/shareRequest.types';
import Skeleton from '../../ui/Skeleton';
import VendorMemberDirectDepositSection from '../../VendorMemberDirectDepositSection';
import PlanMembersCard from './PlanMembersCard';
import ProcedureCodeList from '../ProcedureCodeList';
import DiagnosisList from '../DiagnosisList';

interface RequestDetailsTabProps {
  shareRequestId: string;
}

interface EditForm {
  requestTypeId: string;
  subType: string;
  dateOfService: string;
  dateOfServiceEnd: string;
  nextSteps: string;
  generalNotes: string;
  eligibilityNotes: string;
  // Editable form-derived fields (2026-05-28 migration).
  procedureName: string;
  eventNarrative: string;
  symptomsBeganDate: string;
  isNewCondition: string;
  otherInsurance: string;
  /** Tri-state: '' (not asked), 'yes', 'no'. Converted to bool at save time. */
  wouldSwitchDoctor: string;
  erCharityCareApplied: string;
  maternityDeliveryStatus: string;
  /** Tri-state: '' / 'yes' / 'no'. Converted to bool at save time. */
  surgeonInNetwork: string;
  patientRelationToPrimary: string;
  /** Unshared Amount for this incident. Empty string = cleared. */
  incidentUAAmount: string;
}

const GUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const fmtDate = (v?: string) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const fmtCurrency = (n?: number) =>
  typeof n === 'number'
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
    : '—';

const toInputDate = (v?: string) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().split('T')[0];
};

const boolToYesNo = (v: boolean | null | undefined): string => {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return '';
};

const toForm = (r: ShareRequest): EditForm => ({
  requestTypeId: r.RequestTypeId ?? '',
  subType: r.SubType ?? '',
  dateOfService: toInputDate(r.DateOfService),
  dateOfServiceEnd: toInputDate(r.DateOfServiceEnd),
  nextSteps: r.NextSteps ?? '',
  generalNotes: r.GeneralNotes ?? '',
  eligibilityNotes: r.EligibilityNotes ?? '',
  procedureName: r.ProcedureName ?? '',
  eventNarrative: r.EventNarrative ?? '',
  symptomsBeganDate: toInputDate(r.SymptomsBeganDate ?? undefined),
  isNewCondition: r.IsNewCondition ?? '',
  otherInsurance: r.OtherInsurance ?? '',
  wouldSwitchDoctor: boolToYesNo(r.WouldSwitchDoctor),
  erCharityCareApplied: r.ErCharityCareApplied ?? '',
  maternityDeliveryStatus: r.MaternityDeliveryStatus ?? '',
  surgeonInNetwork: boolToYesNo(r.SurgeonInNetwork),
  patientRelationToPrimary: r.PatientRelationToPrimary ?? '',
  incidentUAAmount:
    r.IncidentUAAmount === null || r.IncidentUAAmount === undefined
      ? ''
      : String(r.IncidentUAAmount),
});

const RequestDetailsTab = ({ shareRequestId }: RequestDetailsTabProps) => {
  const [request, setRequest] = useState<ShareRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [showCaseStudy, setShowCaseStudy] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [requestTypes, setRequestTypes] = useState<VendorRequestType[]>([]);

  useEffect(() => {
    let cancelled = false;
    vendorRequestTypesService
      .list()
      .then((rows) => { if (!cancelled) setRequestTypes(rows); })
      .catch((err) => console.error('Error loading request types:', err));
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const detailRes = await apiService.get<ShareRequestDetailResponse>(
          `/api/me/vendor/share-requests/${shareRequestId}`,
          signal ? { signal } : undefined
        );
        if (signal?.aborted) return;
        if (detailRes.success) {
          setRequest(detailRes.data);
          setForm(toForm(detailRes.data));
        } else {
          setError('Failed to load request details');
        }
      } catch (err) {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load request details');
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

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await apiService.put(`/api/me/vendor/share-requests/${shareRequestId}`, {
        requestTypeId: form.requestTypeId || null,
        subType: form.subType || null,
        dateOfService: form.dateOfService || null,
        dateOfServiceEnd: form.dateOfServiceEnd || null,
        nextSteps: form.nextSteps || null,
        generalNotes: form.generalNotes || null,
        eligibilityNotes: form.eligibilityNotes || null,
        procedureName: form.procedureName || null,
        eventNarrative: form.eventNarrative || null,
        symptomsBeganDate: form.symptomsBeganDate || null,
        isNewCondition: form.isNewCondition || null,
        otherInsurance: form.otherInsurance || null,
        wouldSwitchDoctor:
          form.wouldSwitchDoctor === 'yes' ? true
          : form.wouldSwitchDoctor === 'no' ? false
          : null,
        erCharityCareApplied: form.erCharityCareApplied || null,
        maternityDeliveryStatus: form.maternityDeliveryStatus || null,
        surgeonInNetwork:
          form.surgeonInNetwork === 'yes' ? true
          : form.surgeonInNetwork === 'no' ? false
          : null,
        patientRelationToPrimary: form.patientRelationToPrimary || null,
        incidentUAAmount: form.incidentUAAmount === '' ? null : Number(form.incidentUAAmount),
      });
      setIsEditing(false);
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to save request');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (request) setForm(toForm(request));
    setIsEditing(false);
  };

  if (loading && !request) {
    return (
      <div className="p-4 sm:p-6 space-y-4">
        <Skeleton className="h-5 w-40" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-2 bg-white border border-gray-200 rounded-lg p-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-40" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 sm:p-6 flex items-center gap-2 text-red-600 text-sm">
        <CircleAlert className="h-4 w-4" />
        <span>{error}</span>
      </div>
    );
  }

  if (!request || !form) return null;

  const hasNotes = !!(request.NextSteps || request.GeneralNotes || request.EligibilityNotes);

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Request Details</h2>
        {isEditing ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCancel}
              className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 rounded-lg inline-flex items-center gap-1.5"
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {GUID_RE.test(shareRequestId) && (
              <button
                type="button"
                onClick={() => setShowCaseStudy(true)}
                className="px-3 py-1.5 text-sm border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg inline-flex items-center gap-1.5"
              >
                <FileText className="h-3.5 w-3.5" />
                Create Case Study
              </button>
            )}
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="px-3 py-1.5 text-sm border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg inline-flex items-center gap-1.5"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </button>
          </div>
        )}
      </div>

      {showCaseStudy && GUID_RE.test(shareRequestId) && (
        <CaseStudyModal shareRequestId={shareRequestId} onClose={() => setShowCaseStudy(false)} />
      )}

      {/* System-data card grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <Card title="Clinical details">
          {isEditing ? (
            <>
              <Field label="Request type">
                <select
                  value={form.requestTypeId}
                  onChange={(e) => setForm({ ...form, requestTypeId: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                >
                  <option value="">—</option>
                  {requestTypes.map((t) => (
                    <option key={t.TypeId} value={t.TypeId}>{t.Name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Sub-type">
                <input
                  type="text"
                  value={form.subType}
                  onChange={(e) => setForm({ ...form, subType: e.target.value })}
                  maxLength={500}
                  placeholder="e.g. inpatient knee replacement"
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
              <Field label="Procedure">
                <input
                  type="text"
                  value={form.procedureName}
                  onChange={(e) => setForm({ ...form, procedureName: e.target.value })}
                  maxLength={500}
                  placeholder="e.g. ACL reconstruction"
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
              <Field label="Narrative">
                <textarea
                  value={form.eventNarrative}
                  onChange={(e) => setForm({ ...form, eventNarrative: e.target.value })}
                  rows={3}
                  placeholder="Member's account of what happened. Edit to correct."
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
              <Field label="Symptoms began">
                <input
                  type="date"
                  value={form.symptomsBeganDate}
                  onChange={(e) => setForm({ ...form, symptomsBeganDate: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
              <Field label="New condition?">
                <select
                  value={form.isNewCondition}
                  onChange={(e) => setForm({ ...form, isNewCondition: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                >
                  <option value="">—</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </Field>
              <Field label="Other insurance">
                <input
                  type="text"
                  value={form.otherInsurance}
                  onChange={(e) => setForm({ ...form, otherInsurance: e.target.value })}
                  maxLength={50}
                  placeholder="None / Health / Auto / Medicaid / WC / Other"
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
              <Field label="Switch doctor?">
                <select
                  value={form.wouldSwitchDoctor}
                  onChange={(e) => setForm({ ...form, wouldSwitchDoctor: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                >
                  <option value="">—</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </Field>
              <Field label="Charity care?">
                <input
                  type="text"
                  value={form.erCharityCareApplied}
                  onChange={(e) => setForm({ ...form, erCharityCareApplied: e.target.value })}
                  maxLength={20}
                  placeholder="ER only — yes / no / unknown"
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
              <Field label="Maternity status">
                <input
                  type="text"
                  value={form.maternityDeliveryStatus}
                  onChange={(e) => setForm({ ...form, maternityDeliveryStatus: e.target.value })}
                  maxLength={20}
                  placeholder="Maternity only — expecting / delivered"
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
              <Field label="Surgeon in-net?">
                <select
                  value={form.surgeonInNetwork}
                  onChange={(e) => setForm({ ...form, surgeonInNetwork: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                >
                  <option value="">—</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </Field>
              <Field label="Relation to primary">
                <input
                  type="text"
                  value={form.patientRelationToPrimary}
                  onChange={(e) => setForm({ ...form, patientRelationToPrimary: e.target.value })}
                  maxLength={50}
                  placeholder="self / spouse / child / dependent / other"
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
            </>
          ) : (
            <>
              <ReadField label="Request type" value={request.RequestTypeName} />
              <ReadField label="Sub-type" value={request.SubType} />
              <ReadField label="Procedure" value={request.ProcedureName} />
              {request.EventNarrative ? (
                <NoteBlock label="Narrative" value={request.EventNarrative} />
              ) : (
                <ReadField label="Narrative" value={null} />
              )}
              <ReadField label="Symptoms began" value={fmtDate(request.SymptomsBeganDate ?? undefined)} />
              <ReadField label="New condition?" value={request.IsNewCondition} />
              <ReadField label="Other insurance" value={request.OtherInsurance} />
              <ReadField
                label="Switch doctor?"
                value={
                  request.WouldSwitchDoctor === true ? 'Yes'
                  : request.WouldSwitchDoctor === false ? 'No'
                  : null
                }
              />
              <ReadField label="Charity care?" value={request.ErCharityCareApplied} />
              <ReadField label="Maternity status" value={request.MaternityDeliveryStatus} />
              <ReadField
                label="Surgeon in-net?"
                value={
                  request.SurgeonInNetwork === true ? 'Yes'
                  : request.SurgeonInNetwork === false ? 'No'
                  : null
                }
              />
              <ReadField label="Relation to primary" value={request.PatientRelationToPrimary} />
            </>
          )}
        </Card>

        <Card title="Coding">
          <ProcedureCodeList shareRequestId={shareRequestId} />
          <div className="border-t border-gray-100 !mt-3 pt-3" />
          <DiagnosisList shareRequestId={shareRequestId} />
        </Card>

        <Card title="Financial summary">
          {/* Unshared Amount is the single editable UA field. Snapshotted at SR
              creation from the member's enrollment; the care team can correct it.
              The legacy "UA amount" (TotalUAAmount) and "Member-stated UA"
              (MemberStatedUA) fields were retired from the UI 2026-05-30. */}
          {isEditing ? (
            <Field label="Unshared amount">
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.incidentUAAmount}
                onChange={(e) => setForm({ ...form, incidentUAAmount: e.target.value })}
                placeholder="e.g. 2500"
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
              />
            </Field>
          ) : (
            <ReadField label="Unshared amount" value={fmtCurrency(request.IncidentUAAmount ?? undefined)} />
          )}
          <ReadField label="Billed" value={fmtCurrency(request.TotalBilledAmount)} />
          <ReadField label="Discounts" value={fmtCurrency(request.TotalDiscounts)} />
          <ReadField label="Share amount" value={fmtCurrency(request.TotalShareAmount)} />
          <ReadField label="Paid" value={fmtCurrency(request.TotalPaidAmount)} />
          <ReadField label="Balance" value={fmtCurrency(request.Balance)} />
        </Card>

        <Card title="Dates">
          {isEditing ? (
            <>
              <Field label="Date of service">
                <input
                  type="date"
                  value={form.dateOfService}
                  onChange={(e) => setForm({ ...form, dateOfService: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
              <Field label="Service end">
                <input
                  type="date"
                  value={form.dateOfServiceEnd}
                  onChange={(e) => setForm({ ...form, dateOfServiceEnd: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
            </>
          ) : (
            <>
              <ReadField label="Date of service" value={fmtDate(request.DateOfService)} />
              <ReadField label="Service end" value={fmtDate(request.DateOfServiceEnd)} />
            </>
          )}
          <ReadField label="Submitted" value={fmtDate(request.SubmittedDate)} />
          <ReadField label="Intake" value={fmtDate(request.IntakeDate)} />
          <ReadField label="Determination" value={fmtDate(request.DeterminationDate)} />
          <ReadField label="Completed" value={fmtDate(request.CompletedDate)} />
        </Card>

        <Card title="Notes">
          {isEditing ? (
            <>
              <Field label="Next steps">
                <textarea
                  value={form.nextSteps}
                  onChange={(e) => setForm({ ...form, nextSteps: e.target.value })}
                  rows={2}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
              <Field label="General notes">
                <textarea
                  value={form.generalNotes}
                  onChange={(e) => setForm({ ...form, generalNotes: e.target.value })}
                  rows={3}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
              <Field label="Eligibility notes">
                <textarea
                  value={form.eligibilityNotes}
                  onChange={(e) => setForm({ ...form, eligibilityNotes: e.target.value })}
                  rows={3}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
            </>
          ) : hasNotes ? (
            <>
              {request.NextSteps ? (
                <NoteBlock label="Next steps" value={request.NextSteps} />
              ) : null}
              {request.GeneralNotes ? (
                <NoteBlock label="General notes" value={request.GeneralNotes} />
              ) : null}
              {request.EligibilityNotes ? (
                <NoteBlock label="Eligibility notes" value={request.EligibilityNotes} />
              ) : null}
            </>
          ) : (
            <p className="text-sm text-gray-400">No notes yet.</p>
          )}
        </Card>

        {/* Plan members — everyone on the same household/plan as this request's
            member; click a member for their contact details. */}
        {request.MemberId ? (
          <PlanMembersCard
            memberId={request.MemberId}
            patientName={request.PatientName ?? request.RequestName}
            patientRelation={request.PatientRelationToPrimary}
          />
        ) : null}
      </div>

      {/* Member direct deposit — read-only, always full width. */}
      {request.MemberId ? (
        <VendorMemberDirectDepositSection memberId={request.MemberId} />
      ) : null}
    </div>
  );
};

const Card = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
    <header className="bg-gray-50 px-3 py-2 border-b border-gray-200">
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
    </header>
    <div className="p-3 space-y-2">{children}</div>
  </div>
);

const ReadField = ({ label, value }: { label: string; value?: string | null }) => (
  <div className="text-sm flex items-start gap-2">
    <span className="text-gray-500 w-28 shrink-0">{label}</span>
    <span className="text-gray-900 break-words">
      {value && value.toString().trim() ? value : '—'}
    </span>
  </div>
);

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="text-sm flex items-start gap-2">
    <span className="text-gray-500 w-28 shrink-0 pt-1.5">{label}</span>
    <div className="flex-1 min-w-0">{children}</div>
  </div>
);

const NoteBlock = ({ label, value }: { label: string; value: string }) => (
  <div className="text-sm">
    <div className="text-gray-500 mb-0.5">{label}</div>
    <p className="text-gray-700 whitespace-pre-wrap">{value}</p>
  </div>
);

export default RequestDetailsTab;

// components/vendor/share-requests/CaseStudyModal.tsx
// Create/edit a Patient/Client Success Story (case study) from a share request.
// Opens pre-populated from the share request — figures are pulled directly, and the
// headline / procedure type / narrative are drafted by AI (Haiku). Every field is
// editable so the care team can refine it before saving to oe.CaseStudies.

import { useEffect, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { CircleAlert, FileText, X } from 'lucide-react';
import { CaseStudyService } from '../../../services/case-study.service';
import type { CaseStudy, CaseStudyDraft } from '../../../types/caseStudy.types';

interface CaseStudyModalProps {
  shareRequestId?: string | null; // present → prefill from share request
  caseStudyId?: string | null; // present → edit existing
  onClose: () => void;
  onSaved?: (caseStudy: CaseStudy) => void;
}

const toNum = (v: string): number | null => {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};
const numStr = (v: number | null | undefined) => (v == null ? '' : String(v));

const blankDraft = (): CaseStudyDraft => ({
  shareRequestId: null,
  headline: '',
  procedureType: '',
  cptCodes: '',
  storyDate: new Date().toISOString().slice(0, 10),
  totalBilledAmount: null,
  totalPaidToProvider: null,
  unsharedAmount: null,
  patientPaidAmount: null,
  percentValue: null,
  percentLabel: 'SAVED',
  briefDescription: '',
  outcomeParagraph: '',
  patientQuote: '',
  quoteAttribution: '— Anonymous Member',
  status: 'Draft',
});

const CaseStudyModal = ({ shareRequestId, caseStudyId, onClose, onSaved }: CaseStudyModalProps) => {
  const [draft, setDraft] = useState<CaseStudyDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (caseStudyId) {
          const res = await CaseStudyService.getById(caseStudyId);
          if (cancelled) return;
          if (res.success) setDraft(res.data);
          else setError(res.message ?? 'Failed to load case study');
        } else if (shareRequestId) {
          const res = await CaseStudyService.getPrefill(shareRequestId);
          if (cancelled) return;
          if (res.success) setDraft(res.data);
          else setError(res.message ?? 'Failed to build draft');
        } else {
          // Blank create (from the Case Studies management tab) — no AI prefill.
          if (!cancelled) setDraft(blankDraft());
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load case study');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shareRequestId, caseStudyId]);

  const set = <K extends keyof CaseStudyDraft>(key: K, value: CaseStudyDraft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const negotiated =
    draft && draft.totalBilledAmount != null && draft.totalPaidToProvider != null
      ? Math.round((draft.totalBilledAmount - draft.totalPaidToProvider) * 100) / 100
      : null;

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      // Preserve the draft's own shareRequestId (edit mode); only override when prefilling from an SR.
      const payload = { ...draft };
      if (shareRequestId) payload.shareRequestId = shareRequestId;
      const res = caseStudyId
        ? await CaseStudyService.update(caseStudyId, payload)
        : await CaseStudyService.create(payload);
      if (res.success) {
        onSaved?.(res.data);
        onClose();
      } else {
        throw new Error(res.message ?? 'Failed to save case study');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save case study');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="case-study-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget && !saving) onClose();
      }}
    >
      <div className="w-full max-w-2xl bg-white rounded-lg shadow-xl max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-200 sticky top-0 bg-white z-10">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-oe-light p-2 text-oe-dark">
              <FileText className="h-5 w-5" />
            </div>
            <div>
              <h3 id="case-study-title" className="text-base font-semibold text-gray-900">
                {caseStudyId ? 'Edit Case Study' : 'Create Case Study'}
              </h3>
              <p className="text-xs text-gray-500 mt-1 max-w-xl">
                A shareable success story showing how much the member saved. Figures are pulled from
                this share request and the copy is AI-drafted — review and edit anything before
                saving. Names are withheld for privacy (HIPAA).
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="p-1 text-gray-400 hover:text-gray-600 rounded"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">
            {shareRequestId && !caseStudyId ? 'Generating draft…' : 'Loading…'}
          </div>
        ) : !draft ? (
          <div className="p-8 flex items-center gap-2 text-red-600 text-sm">
            <CircleAlert className="h-4 w-4" />
            <span>{error ?? 'Unable to load case study'}</span>
          </div>
        ) : (
          <div className="p-5 space-y-6">
            {error && (
              <div className="flex items-center gap-2 text-red-600 text-sm">
                <CircleAlert className="h-4 w-4" />
                <span>{error}</span>
              </div>
            )}

            {/* Details */}
            <Section title="Details">
              <Field label="Headline (AI-drafted)">
                <Text
                  value={draft.headline}
                  onChange={(e) => set('headline', e.target.value)}
                  placeholder="$29,600 for a 4-procedure repair, brought down to $4,080."
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Story date">
                  <input
                    type="date"
                    value={draft.storyDate ? String(draft.storyDate).slice(0, 10) : ''}
                    onChange={(e) => set('storyDate', e.target.value || null)}
                    className={inputCls}
                  />
                </Field>
                <Field label="Procedure type (AI-drafted)">
                  <Text value={draft.procedureType} onChange={(e) => set('procedureType', e.target.value)} placeholder="Prolapse Repair" />
                </Field>
              </div>
              <Field label="CPT code(s)">
                <Text value={draft.cptCodes} onChange={(e) => set('cptCodes', e.target.value)} placeholder="57240, 57250" />
              </Field>
            </Section>

            {/* Figures (auto-pulled, editable) */}
            <Section title="Figures">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Total Bill ($)">
                  <Num value={draft.totalBilledAmount} onChange={(e) => set('totalBilledAmount', toNum(e.target.value))} />
                </Field>
                <Field label="Total Paid ($) — negotiated down to">
                  <Num value={draft.totalPaidToProvider ?? null} onChange={(e) => set('totalPaidToProvider', toNum(e.target.value))} />
                </Field>
                <Field label="Unshared Amount / UA ($)">
                  <Num value={draft.unsharedAmount} onChange={(e) => set('unsharedAmount', toNum(e.target.value))} />
                </Field>
                <Field label="Patient Paid ($)">
                  <Num value={draft.patientPaidAmount} onChange={(e) => set('patientPaidAmount', toNum(e.target.value))} />
                </Field>
                <Field label="Percent Saved (%)">
                  <Num value={draft.percentValue} onChange={(e) => set('percentValue', toNum(e.target.value))} />
                </Field>
              </div>
              {negotiated != null && negotiated > 0 && (
                <p className="text-xs text-oe-dark bg-oe-light rounded px-2 py-1.5">
                  That means you negotiated{' '}
                  <span className="font-semibold">
                    ${negotiated.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                  </span>{' '}
                  off the bill (Total Bill − Total Paid).
                </p>
              )}
            </Section>

            {/* Description (single field) */}
            <Section title="Description (AI-drafted)">
              <Field label="Description">
                <Area value={draft.briefDescription} onChange={(e) => set('briefDescription', e.target.value)} rows={5} />
              </Field>
            </Section>

            {/* Patient quote (optional) */}
            <Section title="Patient quote (optional)">
              <Field label="Quote">
                <Area value={draft.patientQuote} onChange={(e) => set('patientQuote', e.target.value)} rows={3} />
              </Field>
              <Field label="Attribution">
                <Text value={draft.quoteAttribution} onChange={(e) => set('quoteAttribution', e.target.value)} placeholder="— ShareWELL Patient" />
              </Field>
            </Section>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-gray-200 sticky bottom-0 bg-white">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 rounded-lg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading || !draft}
            className="px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : caseStudyId ? 'Save changes' : 'Save case study'}
          </button>
        </div>
      </div>
    </div>
  );
};

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="space-y-3">
    <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h4>
    {children}
  </div>
);

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
    {children}
  </div>
);

const inputCls = 'w-full px-2 py-1.5 text-sm border border-gray-300 rounded';

const Text = (props: { value: string; onChange: (e: ChangeEvent<HTMLInputElement>) => void; placeholder?: string }) => (
  <input type="text" value={props.value} onChange={props.onChange} placeholder={props.placeholder} className={inputCls} />
);

const Num = (props: { value: number | null; onChange: (e: ChangeEvent<HTMLInputElement>) => void }) => (
  <input type="number" step="0.01" value={numStr(props.value)} onChange={props.onChange} className={inputCls} />
);

const Area = (props: { value: string; onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void; rows?: number }) => (
  <textarea value={props.value} onChange={props.onChange} rows={props.rows ?? 3} className={inputCls} />
);

export default CaseStudyModal;

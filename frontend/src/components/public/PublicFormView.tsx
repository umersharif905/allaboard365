import { useState, useMemo, useEffect, useRef, type ComponentType, type FormEvent, type ReactNode } from 'react';
import * as LucideIcons from 'lucide-react';
import { MAX_DOCUMENT_UPLOAD_BYTES, MAX_DOCUMENT_UPLOAD_MB } from '../../constants/uploads';
import { apiService } from '../../services/api.service';
import type { FieldDef, FormDefinition, HeaderImageDef } from '../../types/publicFormDefinition';
import {
  effectiveDateMinMax,
  effectiveFieldWidth,
  effectivePages,
  pageIdForField,
  validateDateFieldValue
} from '../../types/publicFormDefinition';
import {
  resolveVisibility,
  visiblePages as computeVisiblePages,
  type PreScreenAnswers
} from '../../utils/publicFormVisibility';
import { PublicSignaturePad } from './PublicSignaturePad';
import ProviderSearchField from './fields/ProviderSearchField';
import { isProviderValue } from '../../utils/providerFieldValue';
import type { ProviderFieldValue, PriorProvider } from '../../types/providerSearch';
import AnatomySurgerySelector from '../forms/anatomy/AnatomySurgerySelector';

/** Localhost-only feature gate (mirrors EnrollmentWizard.tsx). */
function isLocalhost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = (window.location.hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** Tiny valid-enough PDF used as a stand-in attachment for localhost autofill. */
function buildTestPdfFile(): File {
  const pdf =
    '%PDF-1.4\n' +
    '1 0 obj <</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj\n' +
    '4 0 obj <</Length 44>>stream\nBT /F1 12 Tf 50 100 Td (Autofill test) Tj ET\nendstream endobj\n' +
    'xref\n0 5\n0000000000 65535 f \ntrailer <</Size 5/Root 1 0 R>>\nstartxref\n300\n%%EOF\n';
  const bytes = new TextEncoder().encode(pdf);
  return new File([bytes], 'autofill-test.pdf', { type: 'application/pdf' });
}

/**
 * Build a sensible localhost-only test value for a given field. Field-name
 * overrides take precedence so banking/PCP fields get realistic values.
 */
function autofillValueForField(field: { name: string; type: string; options?: { value: string; label?: string }[] }): unknown {
  const name = field.name;
  const named: Record<string, string | boolean> = {
    firstName: 'Joey',
    lastName: 'Desai',
    email: 'jonah@jhdesai.com',
    phone: '(555) 123-4567',
    memberId: 'MW15990740',
    dateOfBirth: '1990-01-15',
    relationToPrimary: 'Self',
    sharingRequestType: 'Medical',
    detailedDescription: 'Autofill test — routine office visit.',
    additionalNotes: 'Autofill test note.',
    providerInformation: 'Autofill test provider info.',
    symptomsStartDate: '2026-04-01',
    isNewCondition: 'No',
    otherInsurance: 'No',
    uaTier: '1500',
    pcpProviderName: 'Dr. Test Provider',
    pcpProviderPhone: '(555) 234-5678',
    pcpProviderFax: '(555) 234-5679',
    dd_accountHolderName: 'Joey Desai',
    dd_bankName: 'Capital One',
    dd_accountType: 'Checking',
    dd_routingNumber: '031176110',
    dd_accountNumber: '987654321'
  };
  if (name in named) return named[name];

  switch (field.type) {
    case 'email':
      return 'test@example.com';
    case 'tel':
      return '(555) 123-4567';
    case 'date':
      return new Date().toISOString().slice(0, 10);
    case 'first_name':
      return 'Test';
    case 'last_name':
      return 'User';
    case 'member_id':
      return 'MW15990740';
    case 'textarea':
      return 'Autofill test value.';
    case 'paragraph':
      return 'Autofill test — longer paragraph value to satisfy any minimum-length requirement on this field. Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
    case 'select':
    case 'radio': {
      // Prefer the first option with a real (non-empty) value so we never land on
      // a placeholder-style empty option.
      const opt =
        field.options?.find((o) => String(o.value ?? '').trim() !== '') ?? field.options?.[0];
      return opt?.value ?? '';
    }
    case 'checkbox_group': {
      const opt = field.options?.find((o) => String(o.value ?? '').trim() !== '') ?? field.options?.[0];
      return opt?.value ? [opt.value] : [];
    }
    case 'checkbox':
    case 'terms':
      return true;
    case 'signature':
      return { imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=' };
    case 'provider_search':
      return { name: 'Dr. Test Provider', source: 'manual', npi: '1234567890' };
    case 'anatomy_surgery':
      return { region: 'knee', procedureName: 'Total Knee Replacement', cptCodes: ['27447'] };
    default:
      return 'Test';
  }
}

const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.heic',
  '.heif'
]);

const FILE_INPUT_ACCEPT =
  'application/pdf,.pdf,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*,.heic,.heif';

const MAX_ATTACHMENTS = 20;

function extensionOf(filename: string) {
  const name = (filename || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot) : '';
}

function validateAttachments(files: File[]): string | null {
  if (files.length > MAX_ATTACHMENTS) {
    return `Too many files attached (max ${MAX_ATTACHMENTS}).`;
  }
  for (const f of files) {
    if (f.size > MAX_DOCUMENT_UPLOAD_BYTES) {
      const mb = Math.max(1, Math.round(f.size / (1024 * 1024)));
      return `"${f.name}" is ${mb}MB. Each file must be ${MAX_DOCUMENT_UPLOAD_MB}MB or less.`;
    }
    const ext = extensionOf(f.name);
    if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
      return `"${f.name}" is not a supported file type. Upload PDF, Word, or images (PDF, DOC, DOCX, JPG, PNG, GIF, WEBP, HEIC).`;
    }
  }
  return null;
}

function errorMessageFrom(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message?: unknown }).message === 'string' &&
    (err as { message: string }).message.trim()
  ) {
    return (err as { message: string }).message;
  }
  return fallback;
}

function introToText(html: string) {
  if (typeof document === 'undefined') return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const d = document.createElement('div');
  d.innerHTML = html;
  return (d.textContent || '').trim();
}

function headerImageLayout(img: HeaderImageDef): { wrap: string; imgCls: string } {
  const justify =
    img.align === 'left' ? 'justify-start' : img.align === 'right' ? 'justify-end' : 'justify-center';
  const mw =
    img.maxWidth === 'sm'
      ? 'max-w-[120px]'
      : img.maxWidth === 'lg'
        ? 'max-w-[320px]'
        : img.maxWidth === 'full'
          ? 'max-w-full'
          : 'max-w-[200px]';
  return {
    wrap: `flex ${justify} mb-4`,
    imgCls: `${mw} h-auto max-h-[clamp(7rem,calc(5rem+18vw),12rem)] w-auto object-contain rounded`
  };
}

function groupValues(values: Record<string, unknown>, name: string): string[] {
  const v = values[name];
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string') as string[];
  return [];
}

/**
 * Groups a page's visible fields into render rows: two consecutive half-width
 * fields pair into one row; everything else is its own row.
 */
function fieldRows(fields: FieldDef[]): FieldDef[][] {
  const rows: FieldDef[][] = [];
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    const next = fields[i + 1];
    if (
      effectiveFieldWidth(f) === 'half' &&
      next &&
      effectiveFieldWidth(next) === 'half'
    ) {
      rows.push([f, next]);
      i += 2;
    } else {
      rows.push([f]);
      i += 1;
    }
  }
  return rows;
}

/**
 * First required-field / date-rule violation among the given fields, or null.
 * Used both for per-page Next and the final submit — paging means earlier
 * pages are unmounted, so native `required` can't be relied on alone.
 */
function firstValidationError(
  fields: FieldDef[],
  values: Record<string, unknown>,
  fieldFiles: Record<string, File[]>
): string | null {
  for (const field of fields) {
    if (field.type === 'static_html') continue;
    const req = !!field.required;
    if (field.type === 'file') {
      if (req && (fieldFiles[field.name] || []).length === 0) {
        return `Please add at least one file for “${field.label}”.`;
      }
      continue;
    }
    if (field.type === 'checkbox_group') {
      if (req && groupValues(values, field.name).length === 0) {
        return `Please select at least one option for “${field.label}”.`;
      }
      continue;
    }
    if (field.type === 'terms' || field.type === 'checkbox') {
      if (req && !values[field.name]) return `Please accept “${field.label}” to continue.`;
      continue;
    }
    if (field.type === 'signature') {
      if (req) {
        const v = values[field.name];
        const ok =
          v &&
          typeof v === 'object' &&
          typeof (v as { imageDataUrl?: string }).imageDataUrl === 'string' &&
          (v as { imageDataUrl: string }).imageDataUrl.startsWith('data:image');
        if (!ok) return `Please sign “${field.label}”.`;
      }
      continue;
    }
    if (field.type === 'date') {
      const val = values[field.name];
      if (req && (val == null || String(val).trim() === '')) {
        return `Please fill in “${field.label}”.`;
      }
      if (val) {
        const msg = validateDateFieldValue(field, String(val));
        if (msg) return msg;
      }
      continue;
    }
    if (field.type === 'radio') {
      if (req && (values[field.name] == null || values[field.name] === '')) {
        return `Please choose an option for “${field.label}”.`;
      }
      continue;
    }
    if (field.type === 'provider_search') {
      if (req) {
        const v = values[field.name];
        const ok =
          !!v &&
          typeof v === 'object' &&
          typeof (v as { name?: unknown }).name === 'string' &&
          (v as { name: string }).name.trim() !== '';
        if (!ok) return `Please find and select a provider for “${field.label}”.`;
      }
      continue;
    }
    if (field.type === 'anatomy_surgery') {
      if (req) {
        const v = values[field.name];
        const ok =
          !!v &&
          typeof v === 'object' &&
          typeof (v as { procedureName?: unknown }).procedureName === 'string' &&
          (v as { procedureName: string }).procedureName.trim() !== '';
        if (!ok) return `Please select a procedure for “${field.label}”.`;
      }
      continue;
    }
    // text-like: text / email / tel / first_name / last_name / member_id / textarea / paragraph / select
    if (req) {
      const v = values[field.name];
      if (v == null || String(v).trim() === '') {
        return `Please fill in “${field.label}”.`;
      }
    }
    // Min-character check for long-text fields (only when a value is present;
    // emptiness is the required check's job).
    if (
      (field.type === 'textarea' || field.type === 'paragraph') &&
      typeof field.minLength === 'number' &&
      field.minLength > 0
    ) {
      const raw = values[field.name];
      const trimmedLen = typeof raw === 'string' ? raw.trim().length : 0;
      if (trimmedLen > 0 && trimmedLen < field.minLength) {
        return `Please enter at least ${field.minLength} characters in “${field.label}”.`;
      }
    }
  }
  return null;
}

/** True when a field has no usable value — for the submit-time soft warning. */
function isFieldValueEmpty(
  field: FieldDef,
  values: Record<string, unknown>,
  fieldFiles: Record<string, File[]>
): boolean {
  if (field.type === 'file') return (fieldFiles[field.name] || []).length === 0;
  const v = values[field.name];
  if (field.type === 'checkbox_group') return !Array.isArray(v) || v.length === 0;
  if (field.type === 'terms' || field.type === 'checkbox') return !v;
  if (field.type === 'signature') {
    if (!v || typeof v !== 'object') return true;
    return typeof (v as { imageDataUrl?: string }).imageDataUrl !== 'string';
  }
  return v == null || String(v).trim() === '';
}

/** Fluid type via clamp(min, calc(rem + vw), max) — scales smoothly between phone and wide desktop */
const fluid = {
  title: 'text-[clamp(1.375rem,calc(0.75rem+2.4vw),2rem)] leading-tight',
  body: 'text-[clamp(0.875rem,calc(0.8rem+0.45vw),1rem)]',
  small: 'text-[clamp(0.8125rem,calc(0.74rem+0.35vw),0.9375rem)]',
  xs: 'text-[clamp(0.6875rem,calc(0.62rem+0.28vw),0.75rem)]',
  control:
    'text-[clamp(0.875rem,calc(0.8rem+0.45vw),1rem)] py-[clamp(0.45rem,calc(0.35rem+0.5vw),0.55rem)]',
  btn: 'text-[clamp(0.9375rem,calc(0.82rem+0.5vw),1.0625rem)] py-[clamp(0.55rem,calc(0.45rem+0.65vw),0.7rem)]'
} as const;

/** Thin progress bar with an "X of N" label — reused for pre-screening and form pages. */
function StepProgress({ label, current, total }: { label: string; current: number; total: number }) {
  const pct = total > 0 ? Math.round(((current + 1) / total) * 100) : 0;
  return (
    <div className="mb-5">
      <div className={`flex justify-between text-slate-500 mb-1 ${fluid.xs}`}>
        <span>{label}</span>
        <span>
          {Math.min(current + 1, total)} of {total}
        </span>
      </div>
      <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-oe-primary rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export type PublicFormViewProps = {
  definition: FormDefinition;
  pageTitle: string;
  tenantName?: string;
  /** When true, submit runs validation only and shows a notice; no API call. */
  previewMode?: boolean;
  /** Public form UUID; required when not previewMode and submitUrl is not set. */
  formId?: string;
  /** Override the submit URL (e.g. for invitation flows). Falls back to the
   * anonymous /api/public/forms/{formId}/submit endpoint when omitted. */
  submitUrl?: string;
  /** Extra multipart fields appended to the (non-draft) submit FormData — e.g.
   * `forMemberId` for the invitation "Who is this for?" override. */
  extraSubmitFields?: Record<string, string>;
  /** Initial field values (used by the authenticated-invitation prefill). */
  initialValues?: Record<string, unknown>;
  /** Fires on every user edit with the raw current values. Used by the
   * anonymous "sign in to save" flow to preserve typed values across sign-in. */
  onValuesChange?: (values: Record<string, unknown>) => void;
  /** Optional block rendered between the title and the form fields (used for
   * the recipient greeting in targeted-mode invitations). */
  topBanner?: ReactNode;
  /** Signed-in member's prior providers — shown as "Your providers" suggestions
   * in provider_search fields. */
  priorProviders?: PriorProvider[];
  /** Draft mode (signed-in members): enables autosave, file staging, and
   * promote-on-submit. When omitted, the form behaves anonymously. */
  draft?: {
    /** Called whenever form values change (parent debounces + persists). */
    onValuesChange: (payload: Record<string, unknown>) => void;
    /** Files already staged for this draft (from a resumed draft). */
    stagedFiles: Array<{ draftFileId: string; fieldName: string; originalFileName: string }>;
    /** Upload one file to the staging endpoint for a field. */
    stageFile: (fieldName: string, file: File) => Promise<void> | void;
    /** Remove a previously staged file. */
    removeStagedFile: (draftFileId: string) => Promise<void> | void;
    /** Promote the draft to a submission (overrides the default submit). */
    submit: (payload: Record<string, unknown>) => Promise<void>;
  };
  /** Called after a successful live submission. */
  onSubmitSuccess?: () => void;
};

export function PublicFormView({
  definition: def,
  pageTitle,
  tenantName,
  previewMode = false,
  formId,
  submitUrl,
  extraSubmitFields,
  initialValues,
  onValuesChange,
  topBanner,
  priorProviders,
  draft,
  onSubmitSuccess
}: PublicFormViewProps) {
  // A resumed draft carries the navigation position under `__position` (see
  // buildDraftPayload). Pull it out so it seeds the paging state below and never
  // leaks into form values or the eventual submission.
  const resumedPosition =
    (initialValues?.__position as
      | { phase?: 'prescreen' | 'form'; preScreenIndex?: number; pageIndex?: number }
      | undefined) || null;
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    if (!initialValues) return {};
    const { __position: _pos, ...rest } = initialValues;
    void _pos;
    return rest;
  });

  // The registry doctor selected on this form (if any) — drives the
  // co-located hospital suggestion for organization-mode provider fields.
  const linkedDoctor = useMemo<ProviderFieldValue | undefined>(() => {
    let found: ProviderFieldValue | undefined;
    for (const f of def.fields || []) {
      if (f.type === 'provider_search' && f.providerSearchMode === 'individual') {
        const v = values[f.name];
        if (isProviderValue(v) && v.source === 'registry') found = v;
      }
    }
    return found;
  }, [def.fields, values]);

  const [files, setFiles] = useState<File[]>([]);
  const [fieldFiles, setFieldFiles] = useState<Record<string, File[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // Anchor at the top of the form card; we scroll to it on every page/question
  // change so a long page doesn't leave the recipient stranded mid-scroll.
  const topRef = useRef<HTMLDivElement>(null);
  const navMountedRef = useRef(false);
  /** Pre-screening hard-stop popup — set when the recipient picks an option
   *  whose `block` carries a message. They can't proceed until they close
   *  the modal and pick a different answer. */
  const [blockedNotice, setBlockedNotice] = useState<{
    title?: string;
    message: string;
  } | null>(null);
  /** Submit-time soft-warning modal — set when one or more optional fields
   *  with `softWarnIfMissing` were left empty. Cancel aborts; Submit anyway
   *  clears and proceeds. */
  const [softWarnPending, setSoftWarnPending] = useState<Array<{
    label: string;
    message: string;
  }> | null>(null);

  // --- pre-screening + paging state ----------------------------------------
  const preScreenQuestions = useMemo(
    () => (def.preScreeningEnabled ? def.preScreening ?? [] : []),
    [def.preScreeningEnabled, def.preScreening]
  );
  // On resume, restore the saved pre-screening answers so visibility (and thus
  // the visible page set) matches what the member saw when they left — without
  // them, jumping straight to a later page could land on the wrong content.
  const [preScreenAnswers, setPreScreenAnswers] = useState<PreScreenAnswers>(
    () => (resumedPosition ? ((initialValues?.__preScreenAnswers as PreScreenAnswers) ?? {}) : {})
  );
  const [phase, setPhase] = useState<'prescreen' | 'form'>(
    resumedPosition?.phase ?? (preScreenQuestions.length > 0 ? 'prescreen' : 'form')
  );
  const [preScreenIndex, setPreScreenIndex] = useState(resumedPosition?.preScreenIndex ?? 0);
  const [pageIndex, setPageIndex] = useState(resumedPosition?.pageIndex ?? 0);

  const allPages = useMemo(() => effectivePages(def), [def]);
  const visibility = useMemo(
    () => resolveVisibility(def, preScreenAnswers),
    [def, preScreenAnswers]
  );
  const visPages = useMemo(() => computeVisiblePages(def, visibility), [def, visibility]);
  /**
   * Prescreen questions to actually render in order — filters out any question
   * a prior answer has hidden (via a `preScreenQuestion`-targeted effect).
   */
  const visiblePreScreenQuestions = useMemo(
    () => preScreenQuestions.filter((q) => visibility.visiblePreScreenQuestionIds.has(q.id)),
    [preScreenQuestions, visibility]
  );

  // Keep preScreenIndex in range when the visible question set shrinks
  // (answer change can hide a downstream question).
  useEffect(() => {
    if (phase === 'prescreen' && preScreenIndex > Math.max(0, visiblePreScreenQuestions.length - 1)) {
      const nextIdx = Math.max(0, visiblePreScreenQuestions.length - 1);
      setPreScreenIndex(nextIdx);
      if (visiblePreScreenQuestions.length === 0) {
        setPhase('form');
        setPageIndex(0);
      }
    }
  }, [phase, preScreenIndex, visiblePreScreenQuestions.length]);

  // Keep pageIndex in range when the visible page set shrinks (answer change).
  useEffect(() => {
    if (pageIndex > Math.max(0, visPages.length - 1)) {
      setPageIndex(Math.max(0, visPages.length - 1));
    }
  }, [visPages.length, pageIndex]);

  // Scroll back to the top of the form on every page/question change. Skips the
  // initial mount so we don't yank the viewport when the form first appears.
  useEffect(() => {
    if (!navMountedRef.current) {
      navMountedRef.current = true;
      return;
    }
    topRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [phase, pageIndex, preScreenIndex]);

  const introText = useMemo(() => (def.introHtml ? introToText(def.introHtml) : ''), [def.introHtml]);

  const hasPerFieldFiles = useMemo(
    () => !!(def.fields || []).some((f) => f.type === 'file'),
    [def.fields]
  );

  const userEditedRef = useRef(false);
  const setField = (name: string, v: unknown) => {
    userEditedRef.current = true;
    setValues((prev) => ({ ...prev, [name]: v }));
  };

  // In draft mode, files are staged on the server (not in fieldFiles), so fold
  // them into the file map used for required-file validation.
  const effectiveFieldFiles = useMemo(() => {
    if (!draft) return fieldFiles;
    const merged: Record<string, File[]> = { ...fieldFiles };
    for (const s of draft.stagedFiles) {
      (merged[s.fieldName] ||= []).push({ name: s.originalFileName } as unknown as File);
    }
    return merged;
  }, [draft, fieldFiles]);

  const toggleGroupValue = (fieldName: string, optionValue: string, checked: boolean) => {
    setValues((prev) => {
      const cur = groupValues(prev, fieldName);
      const set = new Set(cur);
      if (checked) set.add(optionValue);
      else set.delete(optionValue);
      return { ...prev, [fieldName]: [...set] };
    });
  };

  const handleAutofill = () => {
    // `def.fields` is the complete field list across every page/route (pages are
    // sections referenced by FieldDef.pageId), so we fill all of them — including
    // fields only revealed by a pre-screening branch and the previously-skipped
    // paragraph / provider_search types.
    const newValues: Record<string, unknown> = {};
    const fileFieldNames: string[] = [];
    for (const f of def.fields || []) {
      if (f.type === 'static_html') continue;
      if (f.type === 'file') {
        // This form has many file fields across all routes (28+ on the SR form);
        // staging a test file for every one blows past the max-attachments cap.
        // Only stage test files for file fields on the CURRENT visible route,
        // capped at the limit.
        if (visibility.visibleFieldNames.has(f.name) && fileFieldNames.length < MAX_ATTACHMENTS) {
          fileFieldNames.push(f.name);
        }
        continue;
      }
      newValues[f.name] = autofillValueForField(f);
    }
    setValues(newValues);

    // Only when still on the pre-screening step: auto-answer it (first option per
    // question) and advance into the form so every routed page is reachable. If the
    // user is already in the form (e.g. clicking autofill on page 2), leave their
    // current phase/page untouched — don't yank them back to page 1.
    if (phase === 'prescreen' && preScreenQuestions.length > 0) {
      const answers: PreScreenAnswers = {};
      for (const q of preScreenQuestions) {
        const first = q.options?.[0]?.id;
        if (first) answers[q.id] = q.multiSelect ? [first] : first;
      }
      setPreScreenAnswers(answers);
      setPhase('form');
      setPreScreenIndex(0);
      setPageIndex(0);
    }

    if (hasPerFieldFiles) {
      const nf: Record<string, File[]> = {};
      for (const n of fileFieldNames) nf[n] = [buildTestPdfFile()];
      setFieldFiles(nf);
    } else {
      setFiles([buildTestPdfFile()]);
    }
    setError(null);
    setInfoMessage('Autofilled every field on all pages with localhost test data — review and submit.');
  };

  // --- derived current-page view -------------------------------------------
  const currentPage = visPages[pageIndex] ?? null;
  const currentPageFields = useMemo(() => {
    if (!currentPage) return [];
    return def.fields.filter(
      (f) =>
        pageIdForField(f, allPages) === currentPage.id &&
        visibility.visibleFieldNames.has(f.name)
    );
  }, [def.fields, allPages, currentPage, visibility]);
  const isLastPage = pageIndex >= visPages.length - 1;
  const showStepNav = preScreenQuestions.length > 0 || visPages.length > 1;

  // --- pre-screening navigation --------------------------------------------
  /**
   * Advance to the next *visible* prescreen question. When the just-answered
   * option hides a downstream question (via a `preScreenQuestion`-targeted
   * effect), the visible list shrinks — we must recompute visibility against
   * the about-to-commit answers so the next index lands on a still-visible
   * question, not one that's been hidden by this very click.
   */
  const advancePreScreen = (overrideAnswers?: PreScreenAnswers) => {
    setError(null);
    const effectiveAnswers = overrideAnswers ?? preScreenAnswers;
    const newVis = resolveVisibility(def, effectiveAnswers);
    const newVisibleQs = preScreenQuestions.filter((q) =>
      newVis.visiblePreScreenQuestionIds.has(q.id)
    );
    const currentQId = visiblePreScreenQuestions[preScreenIndex]?.id;
    const curIdxInNew = currentQId
      ? newVisibleQs.findIndex((q) => q.id === currentQId)
      : -1;
    if (curIdxInNew === -1 || curIdxInNew >= newVisibleQs.length - 1) {
      setPhase('form');
      setPageIndex(0);
    } else {
      setPreScreenIndex(curIdxInNew + 1);
    }
  };

  /** Look up the option a pre-screening click refers to — used to check `block`. */
  const findPreScreenOption = (questionId: string, optionId: string) => {
    const q = preScreenQuestions.find((x) => x.id === questionId);
    return q?.options.find((o) => o.id === optionId);
  };

  /** Single-select: record the answer and auto-advance — unless the option
   *  carries a `block`, in which case open the hard-stop modal instead. */
  const selectPreScreenOption = (questionId: string, optionId: string) => {
    const opt = findPreScreenOption(questionId, optionId);
    const blockMsg = opt?.block?.message?.trim();
    if (blockMsg) {
      setBlockedNotice({ title: opt!.block!.title, message: blockMsg });
      return;
    }
    const nextAnswers: PreScreenAnswers = { ...preScreenAnswers, [questionId]: optionId };
    setPreScreenAnswers(nextAnswers);
    advancePreScreen(nextAnswers);
  };

  /** Multi-select: toggle the option in/out of the answer array (no advance).
   *  A blocked option can never be added — toggling it ON triggers the modal
   *  instead. Toggling OFF (deselection) is always fine. */
  const toggleMultiOption = (questionId: string, optionId: string) => {
    const cur = preScreenAnswers[questionId];
    const arr = Array.isArray(cur) ? cur : [];
    const adding = !arr.includes(optionId);
    if (adding) {
      const opt = findPreScreenOption(questionId, optionId);
      const blockMsg = opt?.block?.message?.trim();
      if (blockMsg) {
        setBlockedNotice({ title: opt!.block!.title, message: blockMsg });
        return;
      }
    }
    setError(null);
    setPreScreenAnswers((prev) => {
      const prevArr = Array.isArray(prev[questionId]) ? (prev[questionId] as string[]) : [];
      const next = prevArr.includes(optionId)
        ? prevArr.filter((x) => x !== optionId)
        : [...prevArr, optionId];
      return { ...prev, [questionId]: next };
    });
  };

  const handleBack = () => {
    setError(null);
    if (phase === 'prescreen') {
      if (preScreenIndex > 0) setPreScreenIndex(preScreenIndex - 1);
      return;
    }
    if (pageIndex > 0) {
      setPageIndex(pageIndex - 1);
    } else if (visiblePreScreenQuestions.length > 0) {
      setPhase('prescreen');
      setPreScreenIndex(visiblePreScreenQuestions.length - 1);
    }
  };

  const handleNext = () => {
    // Preview / walk-through mode lets back-office reviewers page through the
    // whole form without filling required fields — the goal is to see how the
    // form looks, not to submit it. Validation still gates real submissions.
    if (!previewMode) {
      const pageError = firstValidationError(currentPageFields, values, effectiveFieldFiles);
      if (pageError) {
        setError(pageError);
        return;
      }
    }
    setError(null);
    setPageIndex(pageIndex + 1);
  };

  const canGoBack =
    phase === 'prescreen'
      ? preScreenIndex > 0
      : pageIndex > 0 || visiblePreScreenQuestions.length > 0;

  // --- submit ---------------------------------------------------------------
  /**
   * Build the payload + post. Assumes upstream validation (required fields,
   * attachments, soft-warn confirmation) has already passed. Called from
   * `onSubmit` directly when there's nothing to confirm, and from the
   * soft-warn modal's "Submit anyway" button.
   */
  // Build the cleaned submission payload (drops content blocks + hidden fields,
  // adds the pre-screening snapshot). Shared by anonymous submit, draft autosave,
  // and draft promote so a draft submits identically to a live form.
  const buildFullPayload = (): Record<string, unknown> => {
    const payload: Record<string, unknown> = { ...values };
    for (const f of def.fields || []) {
      if (f.type === 'static_html') delete payload[f.name];
      else if (!visibility.visibleFieldNames.has(f.name)) delete payload[f.name];
    }
    if (preScreenQuestions.length > 0) {
      payload.__preScreenAnswers = preScreenAnswers;
      payload.__preScreening = preScreenQuestions.map((q) => {
        const ans = preScreenAnswers[q.id];
        const selectedIds = Array.isArray(ans) ? ans : ans ? [ans] : [];
        return {
          questionId: q.id,
          prompt: q.prompt,
          multiSelect: !!q.multiSelect,
          options: q.options.map((o) => ({
            optionId: o.id,
            label: o.label,
            selected: selectedIds.includes(o.id)
          }))
        };
      });
    }
    return payload;
  };

  // Draft payload = the submission payload plus the member's current navigation
  // position, so resuming returns them to the exact step/page they left off on.
  // `__position` lives only in the draft (buildFullPayload, used for the real
  // submit, omits it), so it never reaches a finished submission.
  const buildDraftPayload = (): Record<string, unknown> => ({
    ...buildFullPayload(),
    __position: { phase, preScreenIndex, pageIndex }
  });

  // Draft autosave: persist on every user edit and every page/step move (parent
  // debounces). Skips the initial prefill/resume render so merely opening the
  // form doesn't create a draft.
  useEffect(() => {
    if (!draft || !userEditedRef.current) return;
    draft.onValuesChange(buildDraftPayload());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, phase, pageIndex, preScreenIndex]);

  // Always surface raw values to the parent (anonymous sign-in-to-save uses this
  // to preserve typed values across sign-in). Only after a real user edit.
  useEffect(() => {
    if (!onValuesChange || !userEditedRef.current) return;
    onValuesChange(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  const performSubmit = async () => {
    if (previewMode) {
      setInfoMessage('Preview only — nothing was submitted.');
      return;
    }
    const effectiveUrl = submitUrl || (formId ? `/api/public/forms/${formId}/submit` : null);
    if (!effectiveUrl && !draft) return;
    if (submitting) return; // ignore double-clicks

    const allVisibleFields = def.fields.filter((f) => visibility.visibleFieldNames.has(f.name));
    const allAttachments: File[] = [];
    if (hasPerFieldFiles) {
      for (const field of allVisibleFields) {
        if (field.type !== 'file') continue;
        for (const f of fieldFiles[field.name] || []) allAttachments.push(f);
      }
    } else {
      for (const f of files) allAttachments.push(f);
    }

    setSubmitting(true);
    try {
      if (draft) {
        // Promote the draft (values flushed, files already staged) — no re-upload.
        await draft.submit(buildFullPayload());
      } else {
        const fd = new FormData();
        fd.append('payload', JSON.stringify(buildFullPayload()));
        for (const [k, v] of Object.entries(extraSubmitFields || {})) {
          if (v != null) fd.append(k, String(v));
        }
        for (const f of allAttachments) {
          fd.append('files', f);
        }
        await apiService.post(effectiveUrl as string, fd);
      }
      try {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch {
        /* SSR / older browsers */
      }
      onSubmitSuccess?.();
    } catch (err: unknown) {
      setError(errorMessageFrom(err, 'Submission failed. Please try again or contact support.'));
      setSubmitting(false);
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);

    const allVisibleFields = def.fields.filter((f) => visibility.visibleFieldNames.has(f.name));
    const validationError = firstValidationError(allVisibleFields, values, effectiveFieldFiles);
    if (validationError) {
      setError(validationError);
      return;
    }

    const allAttachments: File[] = [];
    if (hasPerFieldFiles) {
      for (const field of allVisibleFields) {
        if (field.type !== 'file') continue;
        for (const f of fieldFiles[field.name] || []) {
          allAttachments.push(f);
        }
      }
    } else {
      for (const f of files) allAttachments.push(f);
    }
    const attachmentError = validateAttachments(allAttachments);
    if (attachmentError) {
      setError(attachmentError);
      return;
    }

    // Soft-warn — open the styled modal when any visible soft-warn field is
    // empty. The modal's "Submit anyway" finishes the submission via
    // `performSubmit`.
    const softWarnings = allVisibleFields
      .filter((f) => f.softWarnIfMissing && isFieldValueEmpty(f, values, fieldFiles))
      .map((f) => ({
        label: f.label || f.name,
        message: f.softWarnIfMissing!.message
      }));
    if (softWarnings.length > 0 && !previewMode) {
      setSoftWarnPending(softWarnings);
      return;
    }

    await performSubmit();
  };

  // --- per-field renderer ---------------------------------------------------
  const renderField = (field: FieldDef) => {
    // In preview mode we keep the visual "* required" marker (so reviewers can
    // see which fields are required on the live form) but don't actually enforce
    // it — native validation would otherwise block page-nav and submit.
    const enforceRequired = !!field.required && !previewMode;
    return (
    <div key={field.name}>
      {field.type !== 'checkbox' &&
        field.type !== 'terms' &&
        field.type !== 'static_html' && (
          <label className={`block font-medium text-slate-800 mb-1 ${fluid.body}`} htmlFor={field.name}>
            {field.label}
            {field.required ? <span className="text-red-600"> *</span> : null}
          </label>
        )}
      {field.type === 'static_html' && field.label?.trim() ? (
        <p className={`font-medium text-slate-800 mb-2 ${fluid.body}`}>{field.label}</p>
      ) : null}
      {field.type === 'text' ||
      field.type === 'first_name' ||
      field.type === 'last_name' ||
      field.type === 'member_id' ? (
        <input
          id={field.name}
          type="text"
          autoComplete={
            field.type === 'first_name'
              ? 'given-name'
              : field.type === 'last_name'
                ? 'family-name'
                : undefined
          }
          placeholder={field.placeholder}
          className={`w-full border border-slate-300 rounded px-[clamp(0.65rem,calc(0.5rem+0.6vw),0.85rem)] text-slate-900 ${fluid.control}`}
          value={(values[field.name] as string) || ''}
          onChange={(e) => setField(field.name, e.target.value)}
          required={enforceRequired}
        />
      ) : null}
      {field.type === 'email' ? (
        <input
          id={field.name}
          type="email"
          placeholder={field.placeholder}
          className={`w-full border border-slate-300 rounded px-[clamp(0.65rem,calc(0.5rem+0.6vw),0.85rem)] text-slate-900 ${fluid.control}`}
          value={(values[field.name] as string) || ''}
          onChange={(e) => setField(field.name, e.target.value)}
          required={enforceRequired}
        />
      ) : null}
      {field.type === 'tel' ? (
        <input
          id={field.name}
          type="tel"
          placeholder={field.placeholder}
          className={`w-full border border-slate-300 rounded px-[clamp(0.65rem,calc(0.5rem+0.6vw),0.85rem)] text-slate-900 ${fluid.control}`}
          value={(values[field.name] as string) || ''}
          onChange={(e) => setField(field.name, e.target.value)}
          required={enforceRequired}
        />
      ) : null}
      {field.type === 'date' ? (
        <input
          id={field.name}
          type="date"
          min={effectiveDateMinMax(field).min}
          max={effectiveDateMinMax(field).max}
          className={`w-full border border-slate-300 rounded px-[clamp(0.65rem,calc(0.5rem+0.6vw),0.85rem)] text-slate-900 ${fluid.control}`}
          value={(values[field.name] as string) || ''}
          onChange={(e) => setField(field.name, e.target.value)}
          required={enforceRequired}
        />
      ) : null}
      {field.type === 'textarea' || field.type === 'paragraph' ? (
        <textarea
          id={field.name}
          rows={field.rows ?? (field.type === 'paragraph' ? 8 : 4)}
          placeholder={field.placeholder}
          className={`w-full border border-slate-300 rounded px-[clamp(0.65rem,calc(0.5rem+0.6vw),0.85rem)] text-slate-900 ${fluid.control}`}
          value={(values[field.name] as string) || ''}
          onChange={(e) => setField(field.name, e.target.value)}
          required={enforceRequired}
        />
      ) : null}
      {field.type === 'static_html' ? (
        <div
          className={`text-slate-700 border border-slate-200 rounded-lg p-[clamp(0.85rem,calc(0.65rem+1vw),1.15rem)] bg-slate-50 leading-relaxed ${fluid.body} [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_a]:text-blue-700 [&_a]:underline`}
          dangerouslySetInnerHTML={{ __html: field.contentHtml ?? '' }}
        />
      ) : null}
      {field.type === 'select' ? (
        <select
          id={field.name}
          className={`w-full border border-slate-300 rounded px-[clamp(0.65rem,calc(0.5rem+0.6vw),0.85rem)] text-slate-900 bg-white ${fluid.control}`}
          value={(values[field.name] as string) || ''}
          onChange={(e) => setField(field.name, e.target.value)}
          required={enforceRequired}
        >
          <option value="">Please select…</option>
          {(field.options || []).map((o) => (
            <option key={o.value + o.label} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : null}
      {field.type === 'radio' ? (
        <div id={field.name} className="space-y-2">
          {(field.options || []).map((o, i) => (
            <label key={o.value} className={`flex items-center gap-2 cursor-pointer text-slate-800 ${fluid.small}`}>
              <input
                type="radio"
                name={field.name}
                value={o.value}
                checked={(values[field.name] as string) === o.value}
                onChange={() => setField(field.name, o.value)}
                required={enforceRequired && i === 0}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      ) : null}
      {field.type === 'checkbox_group' ? (
        <div id={field.name} className="space-y-2">
          {(field.options || []).map((o) => {
            const selected = groupValues(values, field.name);
            const checked = selected.includes(o.value);
            return (
              <label key={o.value} className={`flex items-center gap-2 cursor-pointer text-slate-800 ${fluid.small}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => toggleGroupValue(field.name, o.value, e.target.checked)}
                />
                <span>{o.label}</span>
              </label>
            );
          })}
        </div>
      ) : null}
      {field.type === 'checkbox' ? (
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="mt-1"
            checked={!!values[field.name]}
            onChange={(e) => setField(field.name, e.target.checked)}
            required={enforceRequired}
          />
          <span className={`text-slate-800 ${fluid.small}`}>
            {field.label}
            {field.required ? <span className="text-red-600"> *</span> : null}
          </span>
        </label>
      ) : null}
      {field.type === 'terms' ? (
        <div className="space-y-3">
          {field.termsHtml?.trim() ? (
            <div
              // Long legal text (e.g. the HIPAA authorization) renders in a fixed-height
              // scrollable box with the accept checkbox below — the standard terms pattern,
              // so the page stays short. Opt-in via `scrollable` on the field definition.
              className={`text-slate-700 border border-slate-200 rounded-lg p-[clamp(0.85rem,calc(0.65rem+1vw),1.15rem)] bg-slate-50 leading-relaxed ${fluid.body} [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_a]:text-blue-700 [&_a]:underline ${field.scrollable ? 'max-h-64 overflow-y-auto' : ''}`}
              dangerouslySetInnerHTML={{ __html: field.termsHtml }}
            />
          ) : null}
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1"
              checked={!!values[field.name]}
              onChange={(e) => setField(field.name, e.target.checked)}
            />
            <span className={`text-slate-800 ${fluid.small}`}>
              {field.label}
              {field.required ? <span className="text-red-600"> *</span> : null}
            </span>
          </label>
        </div>
      ) : null}
      {field.type === 'signature' ? (
        <PublicSignaturePad
          id={field.name}
          value={
            typeof values[field.name] === 'object' &&
            values[field.name] !== null &&
            'imageDataUrl' in (values[field.name] as object)
              ? String((values[field.name] as { imageDataUrl: string }).imageDataUrl)
              : ''
          }
          onChange={(dataUrl) =>
            setField(field.name, dataUrl ? { imageDataUrl: dataUrl } : undefined)
          }
          disabled={previewMode}
        />
      ) : null}
      {field.type === 'provider_search' ? (
        <ProviderSearchField
          field={field}
          formId={formId}
          value={values[field.name]}
          onChange={(v) => setField(field.name, v)}
          disabled={previewMode}
          linkedProvider={linkedDoctor}
          priorProviders={priorProviders}
        />
      ) : null}
      {field.type === 'anatomy_surgery' ? (
        <AnatomySurgerySelector
          value={values[field.name] as { region: string; procedureName: string; cptCodes: string[] } | null | undefined}
          onChange={(v) => setField(field.name, v)}
          disabled={previewMode}
          label={field.label}
        />
      ) : null}
      {field.type === 'file' ? (
        draft ? (
          <div className="space-y-1">
            <input
              id={field.name}
              type="file"
              multiple
              accept={FILE_INPUT_ACCEPT}
              className={`w-full text-slate-600 ${fluid.small}`}
              onChange={(e) => {
                const fs = e.target.files;
                if (fs) Array.from(fs).forEach((f) => draft.stageFile(field.name, f));
                e.target.value = ''; // allow re-selecting the same file
              }}
            />
            {draft.stagedFiles
              .filter((s) => s.fieldName === field.name)
              .map((s) => (
                <div
                  key={s.draftFileId}
                  className="flex items-center justify-between gap-2 rounded bg-oe-light/40 px-2 py-1 text-xs"
                >
                  <span className="truncate text-slate-700">{s.originalFileName}</span>
                  <button
                    type="button"
                    data-testid="draft-remove-file"
                    onClick={() => draft.removeStagedFile(s.draftFileId)}
                    className="shrink-0 text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ))}
          </div>
        ) : (
          <input
            id={field.name}
            type="file"
            multiple
            accept={FILE_INPUT_ACCEPT}
            className={`w-full text-slate-600 ${fluid.small}`}
            onChange={(e) =>
              setFieldFiles((prev) => ({
                ...prev,
                [field.name]: Array.from(e.target.files || [])
              }))
            }
          />
        )
      ) : null}
      {field.helperText && field.type !== 'checkbox' && (
        <p className={`text-slate-500 mt-1 ${fluid.xs}`}>{field.helperText}</p>
      )}
    </div>
    );
  };

  const displayTitle = def.title.trim() || pageTitle.trim();
  const hi = def.headerImage?.url?.trim() ? def.headerImage : null;
  const headerImgLayout = hi ? headerImageLayout(hi) : null;

  // Preview/walk-through fills its container (the review page is what sets the
  // outer width). The live public form keeps a comfortable reading column.
  const shellWidth = previewMode
    ? 'w-full min-w-0 max-w-full mx-auto'
    : 'w-full min-w-0 max-w-full md:w-4/5 mx-auto';

  const currentQuestion =
    phase === 'prescreen' ? visiblePreScreenQuestions[preScreenIndex] ?? null : null;

  // The logo is prominent only on the very first screen the recipient lands on
  // ("you're in the right place"); after that it shrinks to a small mark so it
  // doesn't eat vertical space on every page.
  const isFirstScreen =
    phase === 'prescreen'
      ? preScreenIndex === 0
      : visiblePreScreenQuestions.length === 0 && pageIndex === 0;

  const navBtnBase = `rounded font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${fluid.btn}`;
  const primaryBtn = `${navBtnBase} bg-oe-primary hover:bg-oe-dark text-white px-6`;
  const secondaryBtn = `${navBtnBase} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 px-6`;

  return (
    <div
      className={`${shellWidth} box-border bg-white rounded-lg shadow border border-slate-200 p-[clamp(1rem,calc(0.75rem+1.5vw),2rem)]`}
    >
      <div ref={topRef} aria-hidden className="scroll-mt-4" />
      {hi && headerImgLayout ? (
        isFirstScreen ? (
          <div className={headerImgLayout.wrap}>
            <img src={hi.url} alt="" className={headerImgLayout.imgCls} />
          </div>
        ) : (
          // Shrunk mark on every page after the first.
          <div className="flex justify-center mb-3">
            <img src={hi.url} alt="" className="h-7 w-auto object-contain opacity-80" />
          </div>
        )
      ) : null}
      {def.headerHtml?.trim() ? (
        <div
          className={`public-form-header mb-6 text-slate-800 leading-relaxed ${fluid.body} [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_a]:text-blue-700 [&_a]:underline`}
          dangerouslySetInnerHTML={{ __html: def.headerHtml }}
        />
      ) : null}
      <h1 className={`font-bold text-slate-900 mb-1 ${fluid.title}`}>{displayTitle}</h1>
      {tenantName ? <p className={`text-slate-500 mb-4 ${fluid.small}`}>{tenantName}</p> : null}
      {introText ? (
        <p className={`text-slate-600 mb-6 leading-relaxed ${fluid.body}`}>{introText}</p>
      ) : null}

      {topBanner}

      {phase === 'prescreen' && currentQuestion ? (
        /* ---- Pre-screening step ---- */
        <div>
          <StepProgress
            label="A few quick questions"
            current={preScreenIndex}
            total={visiblePreScreenQuestions.length}
          />
          <h2 className={`font-semibold text-slate-900 mb-1 ${fluid.body}`}>
            {currentQuestion.prompt?.trim() || 'Please choose an option'}
          </h2>
          <p className={`text-slate-500 mb-4 ${fluid.xs}`}>
            {currentQuestion.multiSelect ? 'Select all that apply.' : 'Choose one.'}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {currentQuestion.options.map((opt) => {
              const ans = preScreenAnswers[currentQuestion.id];
              const selected = currentQuestion.multiSelect
                ? Array.isArray(ans) && ans.includes(opt.id)
                : ans === opt.id;
              const isTile = Boolean(opt.iconName || opt.helperText);
              const IconComp = opt.iconName
                ? ((LucideIcons as unknown as Record<string, ComponentType<{ className?: string }>>)[opt.iconName] ?? null)
                : null;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() =>
                    currentQuestion.multiSelect
                      ? toggleMultiOption(currentQuestion.id, opt.id)
                      : selectPreScreenOption(currentQuestion.id, opt.id)
                  }
                  className={
                    isTile
                      ? `min-h-[160px] flex flex-col items-start text-left rounded-lg border-2 p-5 transition-colors ${fluid.body} ${
                          selected
                            ? 'border-oe-primary bg-oe-light text-oe-dark'
                            : 'border-slate-300 bg-white text-slate-800 hover:border-oe-primary hover:bg-oe-light/40'
                        }`
                      : `min-h-[110px] flex items-center justify-center text-center rounded-lg border-2 p-5 font-medium transition-colors ${fluid.body} ${
                          selected
                            ? 'border-oe-primary bg-oe-light text-oe-dark'
                            : 'border-slate-300 bg-white text-slate-800 hover:border-oe-primary hover:bg-oe-light/40'
                        }`
                  }
                >
                  {isTile ? (
                    <>
                      {IconComp ? (
                        <IconComp className="w-8 h-8 mb-3 text-oe-primary" />
                      ) : null}
                      <span className={`font-semibold mb-1 ${fluid.body}`}>
                        {opt.label?.trim() || 'Option'}
                      </span>
                      {opt.helperText ? (
                        <span className={`text-slate-600 ${fluid.small}`}>{opt.helperText}</span>
                      ) : null}
                    </>
                  ) : (
                    opt.label?.trim() || 'Option'
                  )}
                </button>
              );
            })}
          </div>
          {error ? <p className={`text-red-600 mt-4 ${fluid.small}`}>{error}</p> : null}
          <div className="mt-6 flex items-center gap-3 justify-between">
            {canGoBack ? (
              <button type="button" onClick={handleBack} className={secondaryBtn}>
                Back
              </button>
            ) : (
              <span />
            )}
            {currentQuestion.multiSelect ? (
              <button type="button" onClick={() => advancePreScreen()} className={primaryBtn}>
                Next
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        /* ---- Paged form ---- */
        <form
          ref={formRef}
          onSubmit={onSubmit}
          className="space-y-[clamp(1rem,calc(0.75rem+1vw),1.35rem)]"
        >
          {/* Enables Enter-to-submit only on the final page. The visible nav
              button below is intentionally type="button" — a button that flips
              type="button" -> type="submit" at the same position is reused by
              React and its type is mutated mid-click, which makes the browser
              auto-submit the form when advancing pages. */}
          {isLastPage ? (
            <button type="submit" aria-hidden="true" tabIndex={-1} className="hidden" />
          ) : null}
          {visPages.length > 1 ? (
            <StepProgress label="Form progress" current={pageIndex} total={visPages.length} />
          ) : null}

          {currentPage ? (
            <>
              {def.multiPage && currentPage.title?.trim() ? (
                <h2 className={`font-semibold text-slate-900 ${fluid.body}`}>
                  {currentPage.title}
                </h2>
              ) : null}
              {def.multiPage && currentPage.description?.trim() ? (
                <p className={`text-slate-600 ${fluid.small}`}>{currentPage.description}</p>
              ) : null}

              {currentPageFields.length === 0 ? (
                <p className={`text-slate-500 ${fluid.small}`}>
                  Nothing to fill in on this page.
                </p>
              ) : (
                fieldRows(currentPageFields).map((row, ri) => {
                  if (row.length === 2) {
                    return (
                      <div key={`row-${ri}`} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {row.map(renderField)}
                      </div>
                    );
                  }
                  const loneHalf = effectiveFieldWidth(row[0]) === 'half';
                  return (
                    <div key={`row-${ri}`} className={loneHalf ? 'sm:w-1/2' : ''}>
                      {renderField(row[0])}
                    </div>
                  );
                })
              )}
            </>
          ) : (
            <p className={`text-slate-500 ${fluid.small}`}>Ready to submit.</p>
          )}

          {/* Global attachments drop-zone — last page only (when no per-field file inputs). */}
          {isLastPage && !hasPerFieldFiles ? (
            <div>
              <label className={`block font-medium text-slate-800 mb-1 ${fluid.body}`}>Attachments</label>
              <input
                type="file"
                multiple
                accept={FILE_INPUT_ACCEPT}
                className={`w-full text-slate-600 ${fluid.small}`}
                onChange={(e) => setFiles(Array.from(e.target.files || []))}
              />
              <p className={`text-slate-500 mt-1 ${fluid.xs}`}>
                PDF, Word, or images (incl. iPhone HEIC) up to {MAX_DOCUMENT_UPLOAD_MB}MB each.
              </p>
            </div>
          ) : null}

          {error && <p className={`text-red-600 ${fluid.small}`}>{error}</p>}
          {infoMessage && <p className={`text-slate-600 ${fluid.small}`}>{infoMessage}</p>}

          {isLocalhost() && !previewMode ? (
            <button
              type="button"
              onClick={handleAutofill}
              className="w-full border border-dashed border-oe-primary text-oe-primary hover:bg-oe-light font-medium rounded py-2 transition-colors text-sm"
              data-testid="public-form-autofill-btn"
            >
              🪄 Autofill (localhost only)
            </button>
          ) : null}

          <div className={`flex items-center gap-3 ${showStepNav ? 'justify-between' : ''}`}>
            {showStepNav && canGoBack ? (
              <button type="button" onClick={handleBack} className={secondaryBtn}>
                Back
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={isLastPage ? () => formRef.current?.requestSubmit() : handleNext}
              disabled={isLastPage && submitting}
              className={`${primaryBtn} ${showStepNav ? '' : 'w-full'}`}
            >
              {isLastPage ? (submitting ? 'Submitting…' : 'Submit') : 'Next'}
            </button>
          </div>
        </form>
      )}

      {/* Pre-screening hard-stop modal — appears when the recipient picks an
          option whose `block` carries a message. Closing dismisses; the
          option was never recorded, so they can pick a different answer. */}
      {blockedNotice && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setBlockedNotice(null);
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="prescreen-block-title"
        >
          <div className="w-full max-w-md bg-white rounded-lg shadow-xl p-5 space-y-3">
            <h2
              id="prescreen-block-title"
              className={`font-semibold text-gray-900 ${fluid.body}`}
            >
              {blockedNotice.title?.trim() || 'Please contact us'}
            </h2>
            <p className={`text-gray-700 leading-relaxed whitespace-pre-wrap ${fluid.small}`}>
              {blockedNotice.message}
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setBlockedNotice(null)}
                className={`${primaryBtn} px-5`}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Submit-time soft-warning modal — lists every optional soft-warn
          field the recipient left empty. Cancel returns them to the form;
          Submit anyway proceeds with the post. */}
      {softWarnPending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSoftWarnPending(null);
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="soft-warn-title"
        >
          <div className="w-full max-w-md bg-white rounded-lg shadow-xl p-5 space-y-3">
            <h2 id="soft-warn-title" className={`font-semibold text-gray-900 ${fluid.body}`}>
              Before you submit
            </h2>
            <p className={`text-gray-700 ${fluid.small}`}>
              You skipped some optional fields. Submitting without them is fine, but processing
              may take longer:
            </p>
            <ul className={`space-y-1.5 ${fluid.small}`}>
              {softWarnPending.map((w, i) => (
                <li
                  key={i}
                  className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900"
                >
                  <span className="font-medium">{w.label}</span>
                  {w.message ? <> — {w.message}</> : null}
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setSoftWarnPending(null)}
                className={`${secondaryBtn} px-4`}
              >
                Go back
              </button>
              <button
                type="button"
                onClick={() => {
                  setSoftWarnPending(null);
                  void performSubmit();
                }}
                disabled={submitting}
                className={`${primaryBtn} px-4`}
              >
                {submitting ? 'Submitting…' : 'Submit anyway'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

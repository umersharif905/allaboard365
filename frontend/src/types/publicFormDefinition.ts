/**
 * Public sharing form definition stored in DefinitionJson (backend) and rendered on PublicFormPage.
 */

export type FieldOption = { value: string; label: string };

/** Layout width for a field on the rendered form. */
export type FieldWidth = 'full' | 'half';

/** Optional logo/banner image above the rich HTML header on public forms. */
export type HeaderImageDef = {
  url: string;
  /** Horizontal placement of the image block */
  align?: 'left' | 'center' | 'right';
  /** Display width (height scales, object-fit contain) */
  maxWidth?: 'sm' | 'md' | 'lg' | 'full';
};

export type FieldDef = {
  name: string;
  type: string;
  label: string;
  required?: boolean;
  helperText?: string;
  placeholder?: string;
  options?: FieldOption[];
  /** Rich HTML shown above the acceptance checkbox (`type: 'terms'`). */
  termsHtml?: string;
  /** `type: 'terms'`: render termsHtml in a fixed-height scrollable box (long legal text). */
  scrollable?: boolean;
  /** For `type: 'textarea'` or `type: 'paragraph'`. */
  rows?: number;
  /** Author-only rich block (`type: 'static_html'`). */
  contentHtml?: string;
  /** Date field: max = today (local). */
  dateDisallowFuture?: boolean;
  /** Date field: max = yesterday (implies no future); combined with dateMax. */
  dateDisallowToday?: boolean;
  /** ISO yyyy-mm-dd */
  dateMin?: string;
  /** ISO yyyy-mm-dd; effective max is earlier of rule-based max and this. */
  dateMax?: string;
  /**
   * When false, field is omitted from the server-generated submission PDF.
   * For `static_html`, undefined defaults to included (disclosures/legal copy).
   */
  includeInPdf?: boolean;
  /** Layout width. Missing/unknown is treated as 'full'. Two consecutive 'half' fields pair into a row. */
  width?: FieldWidth;
  /** Which page this field belongs to (FormPage.id). Missing/unmatched => first page. */
  pageId?: string;
  /** Field starts hidden; revealed only by a pre-screening 'show' effect. */
  defaultHidden?: boolean;
  /** Minimum trimmed character count for non-empty values on textarea / paragraph. */
  minLength?: number;
  /** Confirm-before-submit when this field is left empty. UX-only. */
  softWarnIfMissing?: SoftWarning;
  /** Provider-search field mode (`type: 'provider_search'`). */
  providerSearchMode?: 'individual' | 'organization' | 'both';
};

/** Submit-time soft confirm for optional-but-recommended fields. */
export type SoftWarning = {
  /** Message shown in the single submit-time confirm dialog. */
  message: string;
};

export type SubmissionPdfSettings = {
  /** When true, each submission stores a generated PDF in submission files. */
  enabled?: boolean;
  /**
   * Plain text shown on the submission PDF below the header image (company name, address, phone, etc.).
   * The public form title and PDF generation timestamp are not printed on the PDF.
   */
  companyLetterhead?: string;
};

/** A page (section) of a multi-page form. Fields reference a page via `FieldDef.pageId`. */
export type FormPage = {
  id: string;
  title: string;
  description?: string;
  /** Page starts hidden; revealed only by a pre-screening 'show' effect. */
  defaultHidden?: boolean;
};

/** One effect applied when a pre-screening option is selected. */
export type PreScreenEffect = {
  action: 'show' | 'hide';
  targetType: 'page' | 'field' | 'preScreenQuestion';
  /** Page id (`FormPage.id`), field name (`FieldDef.name`), or pre-screen question id (`PreScreenQuestion.id`). */
  targetId: string;
};

/** A selectable answer box for a pre-screening question. */
export type PreScreenOption = {
  id: string;
  /** Box label — "Yes" / "No" / "I have other coverage" / etc. */
  label: string;
  effects: PreScreenEffect[];
  /** Selecting this option blocks the form with a modal — the recipient
   *  cannot proceed and must choose a different answer. Used for cases
   *  like "surgery within 7-14 days" that warrant manual care-team handling. */
  block?: PreScreenBlock;
  /** Tile-mode under-headline copy. Renders the question as TurboTax-style tiles when any option in the question has helperText or iconName. */
  helperText?: string;
  /** Tile-mode Lucide icon name (e.g. 'Stethoscope', 'Hospital'). Pairs with helperText for tile rendering. */
  iconName?: string;
  /** Optional hint passed to the share-request type resolver so the submitted answer drives SR type/category. */
  srTypeHint?: string;
  /** When this option is the answer, what should auto-create at submit time?
   *  `'shareRequest'` → only the SR auto-create path fires (Case path skipped).
   *  `'case'` → only the Case auto-create path fires (SR path skipped).
   *  `'none'` → neither fires for this answer.
   *  Omit to fall through to each template-level flag firing independently. */
  autoCreateOnSubmit?: 'shareRequest' | 'case' | 'none';
};

/** Per-option hard stop — shown as a modal when the option is chosen. */
export type PreScreenBlock = {
  /** Optional popup title; defaults to "Please contact us". */
  title?: string;
  /** Required body of the popup. Empty/missing means no block. */
  message: string;
};

/** A pre-screening question shown before the form pages. */
export type PreScreenQuestion = {
  id: string;
  /** The question prompt shown above the option boxes. */
  prompt: string;
  /** When true, the recipient may select multiple options — the effects of
   *  every chosen option apply. Single-select (auto-advance) otherwise. */
  multiSelect?: boolean;
  /** Default 2 options; author can add more. */
  options: PreScreenOption[];
  /** Question starts hidden; only rendered when an earlier option's effect shows it.
   *  Symmetric with FormPage.defaultHidden / FieldDef.defaultHidden. */
  defaultHidden?: boolean;
};

export type FormDefinition = {
  version: number;
  title: string;
  /** Plain text under the heading on the public form only; omitted from the generated submission PDF. */
  introHtml?: string;
  /** Optional image above the rich HTML header (uploaded asset URL). */
  headerImage?: HeaderImageDef;
  /** Rich HTML header inside the public form card (logos, intro copy). */
  headerHtml?: string;
  fields: FieldDef[];
  /** Optional: generate and attach a PDF snapshot of answers (field selection via includeInPdf). */
  submissionPdf?: SubmissionPdfSettings;
  /** When true, the form is authored and rendered as ordered pages. */
  multiPage?: boolean;
  /** When true, pre-screening questions are authored/shown before the form pages. */
  preScreeningEnabled?: boolean;
  /** Ordered page metadata. Absent => single implicit page holding all fields. */
  pages?: FormPage[];
  /** Pre-screening questions shown before the form pages. Absent => none. */
  preScreening?: PreScreenQuestion[];
  /**
   * Offer an anonymous visitor the chance to sign in mid-form to save progress
   * (banner + on-exit prompt). Opt-out: undefined/true = offer; explicit false
   * = never offer (e.g. forms that don't benefit from a member account).
   */
  suggestSignIn?: boolean;
};

/** Stable id for the implicit single page used when a form has no `pages`. */
export const IMPLICIT_PAGE_ID = 'page_main';

export const PALETTE_FIELD_TYPES = [
  'text',
  'email',
  'tel',
  'first_name',
  'last_name',
  'member_id',
  'date',
  'textarea',
  'paragraph',
  'static_html',
  'select',
  'radio',
  'checkbox_group',
  'terms',
  'file',
  'signature',
  'provider_search',
  'anatomy_surgery'
] as const;
export type PaletteFieldType = (typeof PALETTE_FIELD_TYPES)[number];

/** Types the public page and builder understand (includes legacy `checkbox` not on palette). */
export const KNOWN_FIELD_TYPES = new Set<string>([...PALETTE_FIELD_TYPES, 'checkbox']);

const DEFAULT_OPTIONS = (): FieldOption[] => [
  { value: 'opt_a', label: 'Option A' },
  { value: 'opt_b', label: 'Option B' }
];

/** Local calendar date as yyyy-mm-dd */
export function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Effective min/max for `<input type="date">` from field rules and optional dateMin/dateMax. */
export function effectiveDateMinMax(field: FieldDef): { min?: string; max?: string } {
  if (field.type !== 'date') return {};
  const today = new Date();
  const todayStr = localYmd(today);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = localYmd(yesterday);

  let max: string | undefined;
  if (field.dateDisallowToday) {
    max = yesterdayStr;
  } else if (field.dateDisallowFuture) {
    max = todayStr;
  }
  if (field.dateMax) {
    max = max ? (field.dateMax < max ? field.dateMax : max) : field.dateMax;
  }

  const min = field.dateMin || undefined;
  return { min, max };
}

/** Non-null error message if value violates date rules; null if OK. Empty value not checked here. */
export function validateDateFieldValue(field: FieldDef, value: string): string | null {
  if (field.type !== 'date' || !value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return 'Please enter a valid date.';
  }
  const { min, max } = effectiveDateMinMax(field);
  if (min && value < min) {
    return `Date must be on or after ${min}.`;
  }
  if (max && value > max) {
    return `Date must be on or before ${max}.`;
  }
  return null;
}

export function uniqueFieldName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

function normalizeHeaderImage(raw: unknown): HeaderImageDef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  if (!url) return undefined;
  const align = o.align === 'left' || o.align === 'center' || o.align === 'right' ? o.align : undefined;
  const maxWidth =
    o.maxWidth === 'sm' || o.maxWidth === 'md' || o.maxWidth === 'lg' || o.maxWidth === 'full'
      ? o.maxWidth
      : undefined;
  return { url, ...(align ? { align } : {}), ...(maxWidth ? { maxWidth } : {}) };
}

export function parseFormDefinition(json: string): FormDefinition {
  try {
    const raw = JSON.parse(json || '{}');
    const sp = (raw as { submissionPdf?: unknown; SubmissionPdf?: unknown }).submissionPdf ??
      (raw as { SubmissionPdf?: unknown }).SubmissionPdf;
    const submissionPdf: SubmissionPdfSettings =
      sp && typeof sp === 'object'
        ? {
            enabled:
              (sp as { enabled?: unknown; Enabled?: unknown }).enabled === true ||
              (sp as { Enabled?: unknown }).Enabled === true,
            ...(typeof (sp as { companyLetterhead?: unknown }).companyLetterhead === 'string'
              ? { companyLetterhead: (sp as { companyLetterhead: string }).companyLetterhead }
              : typeof (sp as { CompanyLetterhead?: unknown }).CompanyLetterhead === 'string'
                ? { companyLetterhead: (sp as { CompanyLetterhead: string }).CompanyLetterhead }
                : {})
          }
        : { enabled: false };
    const pagesRaw = (raw as { pages?: unknown }).pages;
    const pages = Array.isArray(pagesRaw)
      ? pagesRaw.map(normalizePage).filter((p): p is FormPage => p !== null)
      : [];
    const preScreeningRaw = (raw as { preScreening?: unknown }).preScreening;
    const preScreening = dedupePreScreeningIds(
      Array.isArray(preScreeningRaw)
        ? preScreeningRaw
            .map(normalizePreScreenQuestion)
            .filter((q): q is PreScreenQuestion => q !== null)
        : []
    );
    return {
      version: typeof raw.version === 'number' ? raw.version : 1,
      title: typeof raw.title === 'string' ? raw.title : '',
      introHtml: typeof raw.introHtml === 'string' ? raw.introHtml : undefined,
      headerImage: normalizeHeaderImage(
        (raw as { headerImage?: unknown; HeaderImage?: unknown }).headerImage ??
          (raw as { HeaderImage?: unknown }).HeaderImage
      ),
      headerHtml: typeof raw.headerHtml === 'string' ? raw.headerHtml : undefined,
      fields: Array.isArray(raw.fields) ? raw.fields.map(normalizeField) : [],
      submissionPdf,
      multiPage: (raw as { multiPage?: unknown }).multiPage === true ? true : undefined,
      preScreeningEnabled:
        (raw as { preScreeningEnabled?: unknown }).preScreeningEnabled === true ? true : undefined,
      // Opt-out: only an explicit `false` disables the sign-in-to-save offer.
      suggestSignIn:
        (raw as { suggestSignIn?: unknown }).suggestSignIn === false ? false : undefined,
      ...(pages.length ? { pages } : {}),
      ...(preScreening.length ? { preScreening } : {})
    };
  } catch {
    return emptyFormDefinition();
  }
}

function normalizeField(f: unknown): FieldDef {
  if (!f || typeof f !== 'object') {
    return { name: 'field', type: 'text', label: 'Field', required: false };
  }
  const o = f as Record<string, unknown>;
  const rowsRaw = o.rows;
  const rows =
    typeof rowsRaw === 'number' && Number.isFinite(rowsRaw) && rowsRaw >= 1
      ? Math.min(40, Math.floor(rowsRaw))
      : undefined;
  return {
    name: String(o.name ?? 'field'),
    type: String(o.type ?? 'text'),
    label: String(o.label ?? ''),
    required: Boolean(o.required),
    helperText: typeof o.helperText === 'string' ? o.helperText : undefined,
    placeholder: typeof o.placeholder === 'string' ? o.placeholder : undefined,
    options: Array.isArray(o.options) ? (o.options as FieldOption[]) : undefined,
    termsHtml: typeof o.termsHtml === 'string' ? o.termsHtml : undefined,
    scrollable: o.scrollable === true ? true : undefined,
    rows,
    contentHtml: typeof o.contentHtml === 'string' ? o.contentHtml : undefined,
    dateDisallowFuture: o.dateDisallowFuture === true,
    dateDisallowToday: o.dateDisallowToday === true,
    dateMin: typeof o.dateMin === 'string' ? o.dateMin : undefined,
    dateMax: typeof o.dateMax === 'string' ? o.dateMax : undefined,
    includeInPdf: normalizeIncludeInPdf(o.includeInPdf ?? o.IncludeInPdf),
    width: o.width === 'half' ? 'half' : undefined,
    pageId: typeof o.pageId === 'string' && o.pageId.trim() ? o.pageId : undefined,
    defaultHidden: o.defaultHidden === true ? true : undefined,
    minLength:
      typeof o.minLength === 'number' && Number.isFinite(o.minLength) && o.minLength > 0
        ? Math.floor(o.minLength)
        : undefined,
    softWarnIfMissing: normalizeSoftWarning(o.softWarnIfMissing),
    providerSearchMode:
      o.providerSearchMode === 'individual' ||
      o.providerSearchMode === 'organization' ||
      o.providerSearchMode === 'both'
        ? (o.providerSearchMode as FieldDef['providerSearchMode'])
        : undefined
  };
}

function normalizeSoftWarning(raw: unknown): SoftWarning | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = (raw as { message?: unknown }).message;
  return typeof m === 'string' && m.trim() ? { message: m } : undefined;
}

function normalizePreScreenBlock(raw: unknown): PreScreenBlock | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const message = typeof r.message === 'string' && r.message.trim() ? r.message : '';
  if (!message) return undefined;
  const title = typeof r.title === 'string' && r.title.trim() ? r.title : undefined;
  return title ? { title, message } : { message };
}

function normalizePage(raw: unknown): FormPage | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id.trim() ? o.id : '';
  if (!id) return null;
  return {
    id,
    title: typeof o.title === 'string' ? o.title : '',
    description:
      typeof o.description === 'string' && o.description.trim() ? o.description : undefined,
    defaultHidden: o.defaultHidden === true ? true : undefined
  };
}

function normalizePreScreenEffect(raw: unknown): PreScreenEffect | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const action = o.action === 'show' || o.action === 'hide' ? o.action : null;
  const targetType =
    o.targetType === 'page' || o.targetType === 'field' || o.targetType === 'preScreenQuestion'
      ? o.targetType
      : null;
  const targetId = typeof o.targetId === 'string' && o.targetId.trim() ? o.targetId : '';
  if (!action || !targetType || !targetId) return null;
  return { action, targetType, targetId };
}

function normalizePreScreenOption(raw: unknown): PreScreenOption | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id.trim() ? o.id : '';
  if (!id) return null;
  const block = normalizePreScreenBlock(o.block);
  const helperText =
    typeof o.helperText === 'string' && o.helperText.trim() ? o.helperText : undefined;
  const iconName = typeof o.iconName === 'string' && o.iconName.trim() ? o.iconName : undefined;
  const srTypeHint =
    typeof o.srTypeHint === 'string' && o.srTypeHint.trim() ? o.srTypeHint : undefined;
  const autoCreateOnSubmit =
    o.autoCreateOnSubmit === 'shareRequest' ||
    o.autoCreateOnSubmit === 'case' ||
    o.autoCreateOnSubmit === 'none'
      ? o.autoCreateOnSubmit
      : undefined;
  return {
    id,
    label: typeof o.label === 'string' ? o.label : '',
    effects: Array.isArray(o.effects)
      ? o.effects.map(normalizePreScreenEffect).filter((e): e is PreScreenEffect => e !== null)
      : [],
    ...(block ? { block } : {}),
    ...(helperText ? { helperText } : {}),
    ...(iconName ? { iconName } : {}),
    ...(srTypeHint ? { srTypeHint } : {}),
    ...(autoCreateOnSubmit ? { autoCreateOnSubmit } : {})
  };
}

function normalizePreScreenQuestion(raw: unknown): PreScreenQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id.trim() ? o.id : '';
  if (!id) return null;
  return {
    id,
    prompt: typeof o.prompt === 'string' ? o.prompt : '',
    multiSelect: o.multiSelect === true ? true : undefined,
    options: Array.isArray(o.options)
      ? o.options.map(normalizePreScreenOption).filter((x): x is PreScreenOption => x !== null)
      : [],
    defaultHidden: o.defaultHidden === true ? true : undefined
  };
}

/**
 * Repairs colliding ids in pre-screening data. Older builds generated ids via
 * `String(Date.now())` when `crypto.randomUUID` was unavailable, so the two
 * options of a freshly-added question could share an id — making them edit in
 * lock-step and mis-render with duplicate React keys. Reassignment is safe and
 * deterministic: question / option ids are referenced only by runtime answers,
 * never within the definition itself, so repeated parses heal to the same shape.
 */
function dedupePreScreeningIds(questions: PreScreenQuestion[]): PreScreenQuestion[] {
  const seenQ = new Set<string>();
  return questions.map((q, qi) => {
    const qId = seenQ.has(q.id) ? `${q.id}__q${qi}` : q.id;
    seenQ.add(qId);
    const seenO = new Set<string>();
    const options = q.options.map((o, oi) => {
      const oId = seenO.has(o.id) ? `${o.id}__o${oi}` : o.id;
      seenO.add(oId);
      return oId === o.id ? o : { ...o, id: oId };
    });
    return { ...q, id: qId, options };
  });
}

/**
 * Normalizes `includeInPdf` from JSON/DB (boolean, string, or number quirks).
 * `false` means omit from PDF; undefined means default (include).
 */
export function coerceIncludeInPdf(raw: unknown): boolean | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (raw === false || raw === 0) return false;
  if (raw === true || raw === 1) return true;
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (t === 'false' || t === '0') return false;
    if (t === 'true' || t === '1') return true;
  }
  return undefined;
}

function normalizeIncludeInPdf(raw: unknown): boolean | undefined {
  return coerceIncludeInPdf(raw);
}

/** Whether this field should appear on the submission PDF (honors includeInPdf / IncludeInPdf from JSON). */
export function shouldIncludeFieldInPdf(field: {
  includeInPdf?: boolean;
  IncludeInPdf?: unknown;
  excludeFromPdf?: boolean;
  ExcludeFromPdf?: boolean;
  excludeFromSubmissionPdf?: boolean;
}): boolean {
  if (field.excludeFromPdf === true || field.ExcludeFromPdf === true) return false;
  if (field.excludeFromSubmissionPdf === true) return false;
  const raw =
    field.includeInPdf ?? (field as { IncludeInPdf?: unknown }).IncludeInPdf ?? (field as { include_in_pdf?: unknown }).include_in_pdf;
  return coerceIncludeInPdf(raw as unknown) !== false;
}

export function emptyFormDefinition(): FormDefinition {
  return { version: 1, title: '', introHtml: '', fields: [], submissionPdf: { enabled: false } };
}

export function stringifyFormDefinition(def: FormDefinition): string {
  return JSON.stringify(def, null, 2);
}

export function newFieldFromPalette(type: PaletteFieldType, usedNames: Set<string>): FieldDef {
  const id = shortId();

  switch (type) {
    case 'first_name': {
      const name = uniqueFieldName('firstName', usedNames);
      return {
        name,
        type: 'first_name',
        label: 'First name',
        required: false
      };
    }
    case 'last_name': {
      const name = uniqueFieldName('lastName', usedNames);
      return {
        name,
        type: 'last_name',
        label: 'Last name',
        required: false
      };
    }
    case 'member_id': {
      const name = uniqueFieldName('memberId', usedNames);
      return {
        name,
        type: 'member_id',
        label: 'Member ID',
        required: false,
        placeholder: 'Member ID'
      };
    }
    case 'email': {
      // Default name `email` so the authenticated-mode prefill key matches
      // (publicFormInvitationPrefillService returns { email: ... }). Older
      // forms with field_xxx names still work — see mapPrefillToInitialValues
      // for type-based fallback.
      const name = uniqueFieldName('email', usedNames);
      return {
        name,
        type: 'email',
        label: 'Email',
        required: false,
        placeholder: 'name@example.com'
      };
    }
    case 'tel': {
      // Default name `phone` to match the prefill key from the prefill
      // service (which returns { phone: ... } regardless of the schema's
      // PhoneNumber column).
      const name = uniqueFieldName('phone', usedNames);
      return {
        name,
        type: 'tel',
        label: 'Phone',
        required: false,
        placeholder: '(555) 123-4567'
      };
    }
    case 'paragraph': {
      return {
        name: uniqueFieldName(`field_${id}`, usedNames),
        type: 'paragraph',
        label: 'Paragraph',
        required: false,
        rows: 8
      };
    }
    case 'static_html': {
      return {
        name: uniqueFieldName(`static_${id}`, usedNames),
        type: 'static_html',
        label: 'Content block',
        required: false,
        contentHtml: '<p>Instructional or legal text for respondents.</p>',
        includeInPdf: true
      };
    }
    case 'signature': {
      const name = uniqueFieldName('signature', usedNames);
      return {
        name,
        type: 'signature',
        label: 'Signature',
        required: true,
        includeInPdf: true,
        helperText:
          'Sign below. A timestamp and IP hash are recorded with your signature for audit purposes (not full IP storage).'
      };
    }
    case 'provider_search': {
      const name = uniqueFieldName(`provider_${id}`, usedNames);
      return {
        name,
        type: 'provider_search',
        label: 'Find your provider',
        required: false,
        providerSearchMode: 'individual'
      };
    }
    case 'anatomy_surgery': {
      const name = uniqueFieldName(`procedure_${id}`, usedNames);
      return {
        name,
        type: 'anatomy_surgery',
        label: 'What procedure or surgery are you having?',
        required: false
      };
    }
    default: {
      const name = uniqueFieldName(`field_${id}`, usedNames);
      const common: FieldDef = {
        name,
        type,
        label: defaultLabelForType(type),
        required: false
      };
      switch (type) {
        case 'select':
        case 'radio':
        case 'checkbox_group':
          return { ...common, options: DEFAULT_OPTIONS() };
        case 'terms':
          return {
            ...common,
            label: 'I agree to the terms and conditions',
            termsHtml: '<p>Enter your terms and conditions here.</p>'
          };
        case 'textarea':
          return { ...common, rows: 5 };
        case 'file':
          return { ...common, label: 'Files' };
        default:
          return common;
      }
    }
  }
}

function defaultLabelForType(type: PaletteFieldType): string {
  switch (type) {
    case 'text':
      return 'Text field';
    case 'email':
      return 'Email';
    case 'tel':
      return 'Phone';
    case 'first_name':
      return 'First name';
    case 'last_name':
      return 'Last name';
    case 'member_id':
      return 'Member ID';
    case 'date':
      return 'Date';
    case 'textarea':
      return 'Explanation';
    case 'paragraph':
      return 'Paragraph';
    case 'static_html':
      return 'Content block';
    case 'select':
      return 'Dropdown';
    case 'radio':
      return 'Choose one';
    case 'checkbox_group':
      return 'Select all that apply';
    case 'terms':
      return 'I agree to the terms and conditions';
    case 'file':
      return 'Files';
    case 'signature':
      return 'Signature';
    case 'provider_search':
      return 'Find your provider';
    case 'anatomy_surgery':
      return 'What procedure or surgery are you having?';
    default:
      return 'Field';
  }
}

export function isLegacyFieldType(type: string): boolean {
  return !KNOWN_FIELD_TYPES.has(type);
}

export function fieldTypeUsesOptions(type: string): boolean {
  return type === 'select' || type === 'radio' || type === 'checkbox_group';
}

/**
 * The form's pages as an always-non-empty list. Legacy / single-page forms
 * (no `def.pages`) yield one implicit page so callers can iterate pages
 * without special-casing.
 */
export function effectivePages(def: FormDefinition): FormPage[] {
  if (def.pages && def.pages.length > 0) return def.pages;
  return [{ id: IMPLICIT_PAGE_ID, title: def.title || '' }];
}

/**
 * The page a field belongs to. A field whose `pageId` is missing or doesn't
 * match any page falls back to the first page.
 */
export function pageIdForField(field: FieldDef, pages: FormPage[]): string {
  if (field.pageId && pages.some((p) => p.id === field.pageId)) return field.pageId;
  return pages[0]?.id ?? IMPLICIT_PAGE_ID;
}

/** Effective width for a field; treats missing/unknown as 'full'. */
export function effectiveFieldWidth(field: FieldDef): FieldWidth {
  return field.width === 'half' ? 'half' : 'full';
}

/** Fields belonging to a given page, in flat-array order. */
export function fieldsForPage(def: FormDefinition, pageId: string): FieldDef[] {
  const pages = effectivePages(def);
  return def.fields.filter((f) => pageIdForField(f, pages) === pageId);
}

/**
 * Module-level monotonic counter. Guarantees ids generated in the same
 * synchronous call (or same millisecond) never collide, even when
 * `crypto.randomUUID` is unavailable — which is the case in a non-secure
 * context, e.g. the dev app served over plain http from a LAN IP rather than
 * localhost/https.
 */
let __idSeq = 0;

/** Collision-proof short id (time + monotonic counter + randomness). */
function shortId(): string {
  __idSeq += 1;
  const c = globalThis.crypto;
  const rand =
    c && typeof c.randomUUID === 'function'
      ? c.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}${__idSeq.toString(36)}${rand}`;
}

/** Generates a short unique id for a new page / question / option. */
export function newDefId(prefix: 'page' | 'psq' | 'pso'): string {
  return `${prefix}_${shortId()}`;
}

/** A fresh page with a unique id. */
export function newFormPage(title: string): FormPage {
  return { id: newDefId('page'), title };
}

/** A fresh pre-screening option with a unique id and no effects. */
export function newPreScreenOption(label: string): PreScreenOption {
  return { id: newDefId('pso'), label, effects: [] };
}

/** A fresh binary pre-screening question with two starter options. */
export function newPreScreenQuestion(): PreScreenQuestion {
  return {
    id: newDefId('psq'),
    prompt: '',
    options: [newPreScreenOption('Yes'), newPreScreenOption('No')]
  };
}

import { Link2, X } from 'lucide-react';
import type { FieldDef, FieldOption, FormPage } from '../../../types/publicFormDefinition';
import {
  MEMBER_AUTOFILL_FIELDS,
  isMemberAutofillKey,
  memberAutofillLabel
} from '../../../types/memberAutofillKeys';
import {
  fieldTypeUsesOptions,
  isLegacyFieldType,
  pageIdForField,
  shouldIncludeFieldInPdf
} from '../../../types/publicFormDefinition';
import { RichHtmlEditor } from './RichHtmlEditor';
import {
  fbAddOptionBtn,
  fbInspectorDangerIconBtn,
  fbInspectorIconBtn,
  fbRemoveFieldBtn
} from './formBuilderButtonClasses';

function typeBadgeLabel(type: string): string {
  return `Unknown type: ${type} — edit label/key only or fix JSON`;
}

function showHelperPlaceholder(type: string): boolean {
  return (
    type === 'text' ||
    type === 'email' ||
    type === 'tel' ||
    type === 'textarea' ||
    type === 'paragraph' ||
    type === 'first_name' ||
    type === 'last_name' ||
    type === 'member_id'
  );
}

function FieldOptionsEditor({
  options,
  onChange
}: {
  options: FieldOption[];
  onChange: (next: FieldOption[]) => void;
}) {
  const list = options.length ? options : [{ value: 'a', label: 'Option A' }];

  const sync = (next: FieldOption[]) => onChange(next);

  const update = (i: number, patch: Partial<FieldOption>) => {
    sync(list.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  };

  const add = () => {
    const n = list.length + 1;
    sync([...list, { value: `opt_${n}`, label: `Option ${n}` }]);
  };

  const remove = (i: number) => {
    if (list.length <= 1) return;
    sync(list.filter((_, j) => j !== i));
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    sync(next);
  };

  return (
    <div className="space-y-2">
      <span className="text-[10px] font-medium text-gray-500 uppercase">Options</span>
      {list.map((opt, i) => (
        <div
          key={i}
          className="flex flex-col gap-1 p-2 rounded border border-gray-200 bg-gray-50/80"
        >
          <div className="flex gap-1">
            <button
              type="button"
              className={fbInspectorIconBtn}
              onClick={() => move(i, -1)}
              disabled={i === 0}
            >
              Up
            </button>
            <button
              type="button"
              className={fbInspectorIconBtn}
              onClick={() => move(i, 1)}
              disabled={i === list.length - 1}
            >
              Down
            </button>
            <button
              type="button"
              className={`${fbInspectorDangerIconBtn} ml-auto`}
              onClick={() => remove(i)}
            >
              Remove
            </button>
          </div>
          <label className="block text-xs">
            <span className="text-gray-500">Value (payload)</span>
            <input
              className="mt-0.5 w-full border border-gray-300 rounded px-2 py-1 font-mono text-xs"
              value={opt.value}
              onChange={(e) => update(i, { value: e.target.value })}
            />
          </label>
          <label className="block text-xs">
            <span className="text-gray-500">Label</span>
            <input
              className="mt-0.5 w-full border border-gray-300 rounded px-2 py-1 text-xs"
              value={opt.label}
              onChange={(e) => update(i, { label: e.target.value })}
            />
          </label>
        </div>
      ))}
      <button type="button" onClick={add} className={fbAddOptionBtn}>
        + Add option
      </button>
    </div>
  );
}

export function FieldInspector({
  field,
  nameDuplicate,
  multiPage,
  pages,
  onChange,
  onRemove,
  onClose
}: {
  field: FieldDef | null;
  nameDuplicate: boolean;
  multiPage: boolean;
  pages: FormPage[];
  onChange: (patch: Partial<FieldDef>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  // The inspector only renders when a field is selected — the builder shows a
  // full-width canvas otherwise, so there is no empty state.
  if (!field) return null;

  const legacy = isLegacyFieldType(field.type);
  const usesOptions = fieldTypeUsesOptions(field.type);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Field</h3>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onRemove} className={fbRemoveFieldBtn}>
            Remove
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close field editor"
            className="text-gray-400 hover:text-gray-600 rounded p-0.5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {legacy && (
        <div>
          <span className="text-[10px] font-medium text-gray-500 uppercase">Type</span>
          <p className="mt-1 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded px-2 py-1.5">
            {typeBadgeLabel(field.type)}
          </p>
        </div>
      )}

      {!legacy && (
        <p className="text-[10px] text-gray-500 font-mono bg-gray-100 rounded px-2 py-1">{field.type}</p>
      )}

      <label className="block text-sm">
        <span className="text-gray-600">
          {field.type === 'terms'
            ? 'Acceptance label'
            : field.type === 'static_html'
              ? 'Block title (optional)'
              : 'Label'}
        </span>
        <input
          className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
          value={field.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </label>

      {(field.type === 'first_name' || field.type === 'last_name' || field.type === 'member_id') && (
        <p className="text-[11px] text-gray-500 leading-snug">
          Uses standard payload keys (firstName, lastName, memberId) by default for export mapping; you
          can change the field key above if needed.
        </p>
      )}

      {field.type !== 'static_html' && (
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={!!field.required}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
          <span className="text-gray-700">Required</span>
        </label>
      )}

      {field.type === 'provider_search' && (
        <label className="block text-sm">
          <span className="text-gray-600">Provider search mode</span>
          <select
            className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
            value={field.providerSearchMode || 'individual'}
            onChange={(e) =>
              onChange({
                providerSearchMode: e.target.value as 'individual' | 'organization' | 'both'
              })
            }
          >
            <option value="individual">Individual provider (PCP, doctor)</option>
            <option value="organization">Organization (hospital, facility)</option>
            <option value="both">Both</option>
          </select>
        </label>
      )}

      {field.type !== 'static_html' && (
        <div className="space-y-1.5">
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 rounded border-gray-300"
              checked={!!field.softWarnIfMissing}
              onChange={(e) =>
                onChange({
                  softWarnIfMissing: e.target.checked ? { message: '' } : undefined
                })
              }
            />
            <span>
              <span className="text-gray-700">Soft-warn if left empty</span>
              <span className="block text-[10px] text-gray-500">
                Shows a confirm at submit-time when this field is blank. Use for
                optional-but-recommended info (e.g. ACH details).
              </span>
            </span>
          </label>
          {field.softWarnIfMissing && (
            <textarea
              className="ml-6 w-[calc(100%-1.5rem)] border border-gray-300 rounded px-2 py-1.5 text-xs min-h-[48px]"
              rows={2}
              placeholder="e.g. ACH info isn't required, but skipping it slows processing."
              value={field.softWarnIfMissing.message}
              onChange={(e) =>
                onChange({ softWarnIfMissing: { message: e.target.value } })
              }
            />
          )}
        </div>
      )}

      <label className="block text-sm">
        <span className="text-gray-600">Autofills from member account</span>
        <select
          className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-xs bg-white"
          value={isMemberAutofillKey(field.name) ? field.name : ''}
          onChange={(e) => {
            if (e.target.value) onChange({ name: e.target.value });
          }}
        >
          <option value="">Not autofilled</option>
          {MEMBER_AUTOFILL_FIELDS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      {isMemberAutofillKey(field.name) && (
        <p className="-mt-2 inline-flex items-center gap-1 text-[11px] text-oe-dark">
          <Link2 className="h-3 w-3" />
          Autofills {memberAutofillLabel(field.name)} when the member is signed in
        </p>
      )}

      <label className="block text-sm">
        <span className="text-gray-600">Field key (payload)</span>
        <input
          className={`mt-1 w-full border rounded px-2 py-1.5 font-mono text-xs ${
            nameDuplicate ? 'border-red-400 bg-red-50' : 'border-gray-300'
          }`}
          value={field.name}
          onChange={(e) => onChange({ name: e.target.value.trim() })}
        />
        {nameDuplicate && (
          <p className="text-xs text-red-600 mt-1">This key must be unique among fields.</p>
        )}
        <p className="text-[11px] text-gray-500 mt-1">
          Tip: pick a value above to autofill this field from the member's account, or set the key
          by hand.
        </p>
      </label>

      <div className="space-y-2.5 border border-gray-200 rounded-lg p-3 bg-gray-50/80">
        <span className="text-[10px] font-medium text-gray-500 uppercase">Layout &amp; visibility</span>
        <div>
          <span className="block text-xs text-gray-600 mb-1">Width</span>
          <div className="inline-flex rounded border border-gray-300 overflow-hidden">
            <button
              type="button"
              onClick={() => onChange({ width: undefined })}
              className={`px-3 py-1 text-xs ${
                field.width !== 'half'
                  ? 'bg-oe-primary text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              Full
            </button>
            <button
              type="button"
              onClick={() => onChange({ width: 'half' })}
              className={`px-3 py-1 text-xs border-l border-gray-300 ${
                field.width === 'half'
                  ? 'bg-oe-primary text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              Half
            </button>
          </div>
          <p className="text-[10px] text-gray-500 mt-1">
            Two consecutive half-width fields sit side by side on the form.
          </p>
        </div>
        {multiPage && pages.length > 1 && (
          <label className="block text-xs">
            <span className="text-gray-600">Move to page</span>
            <select
              className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
              value={pageIdForField(field, pages)}
              onChange={(e) => onChange({ pageId: e.target.value })}
            >
              {pages.map((p, i) => (
                <option key={p.id} value={p.id}>
                  {p.title?.trim() || `Page ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 rounded border-gray-300"
            checked={!!field.defaultHidden}
            onChange={(e) => onChange({ defaultHidden: e.target.checked ? true : undefined })}
          />
          <span>
            <span className="text-gray-700">Hidden by default</span>
            <span className="block text-[10px] text-gray-500">
              Only shown when a pre-screening answer reveals it.
            </span>
          </span>
        </label>
      </div>

      {field.type === 'static_html' ? (
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={shouldIncludeFieldInPdf(field)}
            onChange={(e) => onChange({ includeInPdf: e.target.checked })}
          />
          <span className="text-gray-700">Include in submission PDF (plain text)</span>
        </label>
      ) : (
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={shouldIncludeFieldInPdf(field)}
            onChange={(e) => onChange({ includeInPdf: e.target.checked })}
          />
          <span className="text-gray-700">Include in submission PDF</span>
        </label>
      )}

      {field.type === 'signature' && (
        <p className="text-[11px] text-gray-600 border border-gray-200 rounded p-2 bg-gray-50 leading-snug">
          Public respondents draw a signature; the server stores UTC time, a SHA-256 hash of the client IP
          (not the raw IP), browser language, and edge country code when available. Signature image and audit
          data are encrypted with the rest of the submission payload.
        </p>
      )}

      {field.type === 'terms' && (
        <div className="space-y-1">
          <span className="text-[10px] font-medium text-gray-500 uppercase">Terms text (rich)</span>
          <RichHtmlEditor
            value={field.termsHtml ?? ''}
            onChange={(html) => onChange({ termsHtml: html || undefined })}
          />
        </div>
      )}

      {field.type === 'static_html' && (
        <div className="space-y-1">
          <span className="text-[10px] font-medium text-gray-500 uppercase">Content (rich, read-only)</span>
          <RichHtmlEditor
            value={field.contentHtml ?? ''}
            onChange={(html) => onChange({ contentHtml: html || undefined })}
          />
          <p className="text-[11px] text-gray-500">
            Shown to respondents as display-only text; nothing is submitted for this block.
          </p>
        </div>
      )}

      {usesOptions && (
        <FieldOptionsEditor
          options={field.options ?? []}
          onChange={(options) => onChange({ options })}
        />
      )}

      {(field.type === 'textarea' || field.type === 'paragraph') && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm">
            <span className="text-gray-600">Rows</span>
            <input
              type="number"
              min={2}
              max={40}
              className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              value={field.rows ?? (field.type === 'paragraph' ? 8 : 4)}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                onChange({
                  rows: Number.isFinite(n) ? Math.min(40, Math.max(2, n)) : 4
                });
              }}
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">Min characters</span>
            <input
              type="number"
              min={0}
              max={10000}
              placeholder="0"
              className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              value={field.minLength ?? ''}
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (raw === '') {
                  onChange({ minLength: undefined });
                  return;
                }
                const n = parseInt(raw, 10);
                onChange({
                  minLength: Number.isFinite(n) && n > 0 ? Math.min(10000, n) : undefined
                });
              }}
            />
          </label>
        </div>
      )}

      {field.type === 'date' && (
        <div className="space-y-3 border border-gray-200 rounded-lg p-3 bg-gray-50/80">
          <span className="text-[10px] font-medium text-gray-500 uppercase">Date rules</span>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={!!field.dateDisallowFuture}
              onChange={(e) => {
                const on = e.target.checked;
                onChange({
                  dateDisallowFuture: on ? true : undefined,
                  ...(!on ? { dateDisallowToday: undefined } : {})
                });
              }}
            />
            <span className="text-gray-700">Disallow future dates (max = today)</span>
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={!!field.dateDisallowToday}
              onChange={(e) => {
                const on = e.target.checked;
                onChange({
                  dateDisallowToday: on ? true : undefined,
                  ...(on ? { dateDisallowFuture: true } : {})
                });
              }}
            />
            <span className="text-gray-700">Disallow today (max = yesterday)</span>
          </label>
          <label className="block text-xs">
            <span className="text-gray-600">Min date (yyyy-mm-dd)</span>
            <input
              type="date"
              className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              value={field.dateMin ?? ''}
              onChange={(e) => onChange({ dateMin: e.target.value || undefined })}
            />
          </label>
          <label className="block text-xs">
            <span className="text-gray-600">Max date (yyyy-mm-dd, optional cap)</span>
            <input
              type="date"
              className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              value={field.dateMax ?? ''}
              onChange={(e) => onChange({ dateMax: e.target.value || undefined })}
            />
          </label>
        </div>
      )}

      {showHelperPlaceholder(field.type) && (
        <>
          <label className="block text-sm">
            <span className="text-gray-600">Placeholder</span>
            <input
              className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              value={field.placeholder ?? ''}
              onChange={(e) => onChange({ placeholder: e.target.value || undefined })}
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">Helper text</span>
            <input
              className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              value={field.helperText ?? ''}
              onChange={(e) => onChange({ helperText: e.target.value || undefined })}
            />
          </label>
        </>
      )}

      {(field.type === 'date' ||
        field.type === 'file' ||
        field.type === 'radio' ||
        field.type === 'select' ||
        field.type === 'checkbox_group' ||
        field.type === 'static_html') && (
        <label className="block text-sm">
          <span className="text-gray-600">Helper text</span>
          <input
            className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
            value={field.helperText ?? ''}
            onChange={(e) => onChange({ helperText: e.target.value || undefined })}
          />
        </label>
      )}
    </div>
  );
}

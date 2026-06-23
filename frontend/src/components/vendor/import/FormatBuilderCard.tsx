import React from 'react';
import { AlertCircle, CheckCircle, RotateCcw, Sparkles } from 'lucide-react';
import EligibilityTemplatePlaceholderGuide from './EligibilityTemplatePlaceholderGuide';

const inputClass =
  'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-oe-primary/30 focus:border-oe-primary';

const textareaClass =
  'w-full font-mono text-[13px] leading-relaxed border rounded-lg px-3 py-2.5 min-h-[140px] resize-y bg-white focus:outline-none focus:ring-2 focus:ring-oe-primary/30 focus:border-oe-primary';

export interface FormatBuilderCardProps {
  title: string;
  subtitle?: string;
  slug?: string;
  displayName: string;
  onDisplayNameChange: (v: string) => void;
  template: string;
  onTemplateChange: (v: string) => void;
  templateErrors: string[];
  dirty?: boolean;
  saving?: boolean;
  onSave: () => void;
  onRevert?: () => void;
  onAi: () => void;
  saveLabel?: string;
  starters?: Array<{ label: string; template: string }>;
  showSlugField?: boolean;
  slugValue?: string;
  onSlugChange?: (v: string) => void;
  rulesEditor?: React.ReactNode;
}

const FormatBuilderCard: React.FC<FormatBuilderCardProps> = ({
  title,
  subtitle,
  slug,
  displayName,
  onDisplayNameChange,
  template,
  onTemplateChange,
  templateErrors,
  dirty,
  saving,
  onSave,
  onRevert,
  onAi,
  saveLabel = 'Save format',
  starters,
  showSlugField,
  slugValue,
  onSlugChange,
  rulesEditor,
}) => {
  const valid = templateErrors.length === 0;

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-soft overflow-hidden">
      <div className="flex flex-wrap items-start gap-3 px-4 py-3 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white">
        <div className="flex-1 min-w-[200px]">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
          {slug && (
            <code className="mt-1 inline-block text-[11px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
              {slug}
            </code>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {valid ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-800 bg-green-50 border border-green-200 rounded-full">
              <CheckCircle className="h-3.5 w-3.5" /> Valid template
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-full">
              <AlertCircle className="h-3.5 w-3.5" /> {templateErrors.length} error{templateErrors.length !== 1 ? 's' : ''}
            </span>
          )}
          {dirty && (
            <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-full">
              Unsaved changes
            </span>
          )}
          <button
            type="button"
            onClick={onAi}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg shadow-sm transition-colors"
          >
            <Sparkles className="h-4 w-4" /> Edit with AI
          </button>
        </div>
      </div>

      <div className="grid lg:grid-cols-5 gap-0 lg:divide-x divide-gray-100">
        <div className="lg:col-span-3 p-4 space-y-3">
          <div className={`grid gap-3 ${showSlugField ? 'sm:grid-cols-2' : ''}`}>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Display name</label>
              <input
                className={inputClass}
                value={displayName}
                onChange={(e) => onDisplayNameChange(e.target.value)}
                placeholder="e.g. ShareWELL Standard"
              />
            </div>
            {showSlugField && onSlugChange && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Slug</label>
                <input
                  className={`${inputClass} font-mono`}
                  value={slugValue || ''}
                  onChange={(e) => onSlugChange(e.target.value)}
                  placeholder="auto-generated"
                />
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Column template</label>
            {!valid && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-2.5 py-2 mb-2">
                Unknown placeholders: {templateErrors.join(', ')}
              </p>
            )}
            <textarea
              className={`${textareaClass} ${valid ? 'border-gray-300' : 'border-red-300'}`}
              value={template}
              onChange={(e) => onTemplateChange(e.target.value)}
              placeholder="{LastName:Last Name},{FirstName:First Name},…"
              spellCheck={false}
            />
            <p className="text-[11px] text-gray-500 mt-1.5">
              Comma-separated tokens. Use <code className="bg-gray-100 px-1 rounded">{'{Field:Header}'}</code> to map
              CSV columns.
            </p>
          </div>

          {starters && starters.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <span className="text-xs text-gray-500 w-full">Quick starters</span>
              {starters.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => onTemplateChange(s.template)}
                  className="px-2.5 py-1 text-xs font-medium border border-gray-200 rounded-md text-gray-700 hover:border-oe-primary hover:text-oe-primary hover:bg-oe-light/50 transition-colors"
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {rulesEditor}
        </div>

        <div className="lg:col-span-2 p-4 bg-gray-50/80 lg:max-h-[min(520px,70vh)] lg:overflow-y-auto">
          <p className="text-xs font-semibold text-gray-800 mb-2">Insert fields</p>
          <p className="text-[11px] text-gray-500 mb-3">Search or expand a group, then click to append.</p>
          <EligibilityTemplatePlaceholderGuide template={template} onInsert={onTemplateChange} compact />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-gray-100 bg-gray-50/50">
        <button
          type="button"
          disabled={saving || !valid || (onRevert != null && dirty === false)}
          onClick={onSave}
          className="px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving…' : saveLabel}
        </button>
        {onRevert && dirty && (
          <button
            type="button"
            onClick={onRevert}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-white transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Revert
          </button>
        )}
      </div>
    </div>
  );
};

export default FormatBuilderCard;

import { useEffect, useState } from 'react';
import { PublicFormView } from '../../public/PublicFormView';
import { parseFormDefinition } from '../../../types/publicFormDefinition';
import { fbDialogCloseBtn } from './formBuilderButtonClasses';

export function PublicFormPreviewDialog({
  open,
  onClose,
  definitionJson,
  templateTitle
}: {
  open: boolean;
  onClose: () => void;
  definitionJson: string;
  templateTitle: string;
}) {
  const [parseError, setParseError] = useState<string | null>(null);
  const [remountKey, setRemountKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    setParseError(null);
    try {
      JSON.parse(definitionJson);
    } catch {
      setParseError('Fix JSON errors in the definition before previewing.');
    }
    setRemountKey((k) => k + 1);
  }, [open, definitionJson]);

  if (!open) return null;

  const definition = parseFormDefinition(definitionJson);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-gray-900/50 transition-colors duration-150 active:bg-gray-900/65"
        aria-label="Close preview"
        onClick={onClose}
      />
      <div
        className="relative z-10 flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border border-gray-200 bg-white shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-form-preview-title"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
          <h2 id="public-form-preview-title" className="text-lg font-semibold text-gray-900">
            Form preview
          </h2>
          <button type="button" onClick={onClose} className={fbDialogCloseBtn}>
            Close
          </button>
        </div>
        <p className="shrink-0 border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-950">
          Preview only — submissions are not saved.
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto bg-gray-100 p-4">
          {parseError ? (
            <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{parseError}</p>
          ) : (
            <PublicFormView
              key={remountKey}
              previewMode
              definition={definition}
              pageTitle={templateTitle}
            />
          )}
        </div>
      </div>
    </div>
  );
}

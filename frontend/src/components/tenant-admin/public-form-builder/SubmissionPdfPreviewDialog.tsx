import { useEffect, useState } from 'react';
import { parseFormDefinition } from '../../../types/publicFormDefinition';
import { buildSubmissionPdfPreviewBlob } from '../../../utils/submissionPdfPreview';
import { fbDialogCloseBtn } from './formBuilderButtonClasses';

export function SubmissionPdfPreviewDialog({
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
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setPdfUrl(null);
      setError(null);
      setLoading(false);
      return;
    }

    setPdfUrl(null);
    setError(null);
    setLoading(true);
    let createdUrl: string | null = null;
    let cancelled = false;

    try {
      JSON.parse(definitionJson);
    } catch {
      setError('Fix JSON errors in the definition before previewing the PDF.');
      setPdfUrl(null);
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const def = parseFormDefinition(definitionJson);
        const blob = await buildSubmissionPdfPreviewBlob(def, { templateTitle });
        const url = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        createdUrl = url;
        setPdfUrl(url);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not build PDF preview');
          setPdfUrl(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [open, definitionJson, templateTitle]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-gray-900/50 transition-colors duration-150 active:bg-gray-900/65"
        aria-label="Close PDF preview"
        onClick={onClose}
      />
      <div
        className="relative z-10 flex max-h-[92vh] w-full max-w-4xl flex-col rounded-lg border border-gray-200 bg-white shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="submission-pdf-preview-title"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
          <h2 id="submission-pdf-preview-title" className="text-lg font-semibold text-gray-900">
            Submission PDF preview
          </h2>
          <button type="button" onClick={onClose} className={fbDialogCloseBtn}>
            Close
          </button>
        </div>
        <p className="shrink-0 border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-950">
          Sample data only — layout matches the stored submission PDF when “Submission PDF” is enabled and the
          form is published. Header image may not load here if the host blocks cross-origin requests.
        </p>
        <div className="min-h-0 flex-1 overflow-hidden bg-gray-100 p-2 sm:p-4">
          {error ? (
            <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>
          ) : loading || !pdfUrl ? (
            <p className="text-sm text-gray-600 p-4">Building preview…</p>
          ) : (
            <iframe
              title="Submission PDF preview"
              src={`${pdfUrl}#view=FitH`}
              className="h-[min(78vh,720px)] w-full rounded border border-gray-200 bg-white"
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the pre-screening context captured on a form submission: each
 * question prompt, every answer choice, and which one(s) the recipient
 * selected. Reads the self-contained `__preScreening` snapshot stored in the
 * submission payload at submit time — so it stays readable even if the form
 * template is later edited or deleted.
 *
 * Used by the submission detail page and the submission preview modal.
 */

export type PreScreenSnapshotOption = {
  optionId: string;
  label: string;
  selected: boolean;
};

export type PreScreenSnapshotQuestion = {
  questionId: string;
  prompt: string;
  multiSelect: boolean;
  options: PreScreenSnapshotOption[];
};

/** Reads + normalizes the `__preScreening` snapshot from a submission payload. */
export function readPreScreeningSnapshot(payload: unknown): PreScreenSnapshotQuestion[] {
  const raw =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).__preScreening
      : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object')
    .map((q) => ({
      questionId: typeof q.questionId === 'string' ? q.questionId : '',
      prompt: typeof q.prompt === 'string' ? q.prompt : '',
      multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options)
        ? q.options
            .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
            .map((o) => ({
              optionId: typeof o.optionId === 'string' ? o.optionId : '',
              label: typeof o.label === 'string' ? o.label : '',
              selected: o.selected === true
            }))
        : []
    }));
}

export function PreScreeningSubmissionSummary({
  questions,
  compact = false
}: {
  questions: PreScreenSnapshotQuestion[];
  /** Tighter spacing + no helper text — for the submission preview modal. */
  compact?: boolean;
}) {
  if (questions.length === 0) return null;

  return (
    <div className="space-y-2">
      <h2 className={compact ? 'text-sm font-semibold text-gray-900' : 'font-medium text-gray-800'}>
        Pre-screening
      </h2>
      {!compact && (
        <p className="text-xs text-gray-500">
          Questions the recipient answered before the form. The selected answer is highlighted.
        </p>
      )}
      <div className="space-y-2">
        {questions.map((q, qi) => {
          const noneSelected = q.options.every((o) => !o.selected);
          return (
            <div key={q.questionId || qi} className="rounded border border-gray-200 bg-white p-3">
              <div className="text-gray-900 font-semibold text-sm leading-snug">
                {q.prompt.trim() || `Question ${qi + 1}`}
              </div>
              {q.multiSelect && (
                <div className="text-[11px] text-gray-400 mt-0.5">Multiple answers allowed</div>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {q.options.map((o, oi) => (
                  <span
                    key={o.optionId || oi}
                    className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${
                      o.selected
                        ? 'border-oe-primary bg-oe-light text-oe-dark font-medium'
                        : 'border-gray-200 bg-gray-50 text-gray-500'
                    }`}
                  >
                    {o.selected ? <span aria-hidden="true">✓</span> : null}
                    {o.label.trim() || '(no label)'}
                  </span>
                ))}
              </div>
              {noneSelected && (
                <div className="text-[11px] text-gray-400 mt-1.5 italic">No answer selected</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

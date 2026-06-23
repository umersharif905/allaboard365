import type {
  FieldDef,
  FormPage,
  PreScreenEffect,
  PreScreenOption,
  PreScreenQuestion
} from '../../../types/publicFormDefinition';
import { newPreScreenOption, newPreScreenQuestion } from '../../../types/publicFormDefinition';
import { fbInspectorIconBtn } from './formBuilderButtonClasses';

type TargetEntry = {
  key: string; // `${targetType}::${targetId}`
  targetType: 'page' | 'field' | 'preScreenQuestion';
  targetId: string;
  label: string;
  defaultHidden: boolean;
  /** For 'preScreenQuestion' entries — the question id, so an option's editor
   *  can filter the parent question out (no self-reference effects). */
  parentQuestionId?: string;
};

function buildTargets(
  pages: FormPage[],
  fields: FieldDef[],
  questions: PreScreenQuestion[]
): TargetEntry[] {
  const pageTargets: TargetEntry[] = pages.map((p, i) => ({
    key: `page::${p.id}`,
    targetType: 'page',
    targetId: p.id,
    label: `Page · ${p.title?.trim() || `Page ${i + 1}`}`,
    defaultHidden: !!p.defaultHidden
  }));
  const fieldTargets: TargetEntry[] = fields.map((f) => ({
    key: `field::${f.name}`,
    targetType: 'field',
    targetId: f.name,
    label: `Field · ${f.label?.trim() || f.name}`,
    defaultHidden: !!f.defaultHidden
  }));
  const questionTargets: TargetEntry[] = questions.map((q, i) => ({
    key: `preScreenQuestion::${q.id}`,
    targetType: 'preScreenQuestion',
    targetId: q.id,
    label: `Pre-screen question · ${q.prompt?.trim() || `Question ${i + 1}`}`,
    defaultHidden: !!q.defaultHidden,
    parentQuestionId: q.id
  }));
  return [...pageTargets, ...fieldTargets, ...questionTargets];
}

function EffectsEditor({
  effects,
  targets,
  onChange
}: {
  effects: PreScreenEffect[];
  targets: TargetEntry[];
  onChange: (next: PreScreenEffect[]) => void;
}) {
  const update = (i: number, patch: Partial<PreScreenEffect>) => {
    onChange(effects.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  };
  const remove = (i: number) => onChange(effects.filter((_, j) => j !== i));
  const add = () => {
    const first = targets[0];
    onChange([
      ...effects,
      {
        action: 'show',
        targetType: first?.targetType ?? 'page',
        targetId: first?.targetId ?? ''
      }
    ]);
  };

  return (
    <div className="space-y-1.5">
      {effects.length === 0 && (
        <p className="text-[11px] text-amber-700">
          No effect — the recipient sees the base form unchanged.
        </p>
      )}
      {effects.map((eff, i) => {
        const entry = targets.find(
          (t) => t.targetType === eff.targetType && t.targetId === eff.targetId
        );
        let mismatch: string | null = null;
        if (entry) {
          if (eff.action === 'show' && !entry.defaultHidden) {
            mismatch = 'Already visible by default — this show has no effect.';
          } else if (eff.action === 'hide' && entry.defaultHidden) {
            mismatch = 'Already hidden by default — this hide has no effect.';
          }
        } else if (eff.targetId) {
          mismatch = 'Target no longer exists — remove this effect.';
        }
        return (
          <div key={i}>
            <div className="flex items-center gap-1.5">
              <div className="inline-flex shrink-0 rounded border border-gray-300 overflow-hidden">
                <button
                  type="button"
                  onClick={() => update(i, { action: 'show' })}
                  className={`px-2 py-1 text-xs ${
                    eff.action === 'show'
                      ? 'bg-oe-primary text-white'
                      : 'bg-white text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  Show
                </button>
                <button
                  type="button"
                  onClick={() => update(i, { action: 'hide' })}
                  className={`px-2 py-1 text-xs border-l border-gray-300 ${
                    eff.action === 'hide'
                      ? 'bg-oe-primary text-white'
                      : 'bg-white text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  Hide
                </button>
              </div>
              <select
                className="flex-1 min-w-0 border border-gray-300 rounded px-1.5 py-1 text-xs bg-white"
                value={entry ? entry.key : ''}
                onChange={(e) => {
                  const t = targets.find((x) => x.key === e.target.value);
                  if (t) update(i, { targetType: t.targetType, targetId: t.targetId });
                }}
              >
                <option value="" disabled>
                  Select a page or field…
                </option>
                {targets.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="text-[10px] text-red-700 hover:underline shrink-0 px-1"
                onClick={() => remove(i)}
              >
                Remove
              </button>
            </div>
            {mismatch && <p className="text-[10px] text-amber-700 mt-0.5">{mismatch}</p>}
          </div>
        );
      })}
      <button
        type="button"
        onClick={add}
        disabled={targets.length === 0}
        className="text-[11px] text-oe-primary hover:text-oe-dark hover:underline disabled:opacity-40 disabled:no-underline"
      >
        + Add effect
      </button>
    </div>
  );
}

/** One answer choice — a self-contained card, laid out side-by-side with its siblings. */
function AnswerCard({
  option,
  index,
  count,
  targets,
  onChange,
  onRemove,
  onMove
}: {
  option: PreScreenOption;
  index: number;
  count: number;
  targets: TargetEntry[];
  onChange: (patch: Partial<PreScreenOption>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50/60 p-2.5 space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold text-gray-400 uppercase">
          Answer {index + 1}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className={fbInspectorIconBtn}
            onClick={() => onMove(-1)}
            disabled={index === 0}
            title="Move answer left"
          >
            ←
          </button>
          <button
            type="button"
            className={fbInspectorIconBtn}
            onClick={() => onMove(1)}
            disabled={index === count - 1}
            title="Move answer right"
          >
            →
          </button>
          <button
            type="button"
            className="text-[10px] text-red-700 hover:underline disabled:opacity-40 disabled:no-underline px-1"
            onClick={onRemove}
            disabled={count <= 2}
            title={count <= 2 ? 'A question needs at least two answers' : 'Remove answer'}
          >
            Remove
          </button>
        </div>
      </div>
      <input
        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
        value={option.label}
        placeholder='e.g. "Yes" or "I have other coverage"'
        onChange={(e) => onChange({ label: e.target.value })}
      />
      <label className="block">
        <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
          When this is the answer, auto-create
        </span>
        <select
          className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-xs bg-white"
          value={option.autoCreateOnSubmit ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            onChange({
              autoCreateOnSubmit:
                v === 'shareRequest' || v === 'case' || v === 'none' ? v : undefined
            });
          }}
        >
          <option value="">Fall through to form-level toggles</option>
          <option value="shareRequest">Create a share request</option>
          <option value="case">Create a case</option>
          <option value="none">Create nothing (submission only)</option>
        </select>
        <span className="block text-[10px] text-gray-500 mt-0.5">
          Overrides the form-level toggles for submissions where this answer is picked. Leave on
          “Fall through” for single-purpose forms.
        </span>
      </label>
      <div>
        <span className="text-[10px] font-medium text-gray-500 uppercase">When chosen</span>
        <div className="mt-1">
          <EffectsEditor
            effects={option.effects}
            targets={targets}
            onChange={(effects) => onChange({ effects })}
          />
        </div>
      </div>
      <div className="border-t border-gray-200 pt-2 space-y-1.5">
        <label className="flex items-start gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 rounded border-gray-300"
            checked={!!option.block}
            onChange={(e) =>
              onChange({
                block: e.target.checked ? { message: option.block?.message ?? '' } : undefined
              })
            }
          />
          <span>
            <span className="text-gray-800">Stop the form when this is chosen</span>
            <span className="block text-[10px] text-gray-500">
              Shows a modal — the recipient can&apos;t proceed and must pick a different answer.
            </span>
          </span>
        </label>
        {option.block && (
          <div className="ml-6 space-y-1.5">
            <input
              className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white"
              placeholder='Popup title (optional) — defaults to "Please contact us"'
              value={option.block.title ?? ''}
              onChange={(e) =>
                onChange({
                  block: {
                    ...option.block,
                    message: option.block?.message ?? '',
                    title: e.target.value || undefined
                  }
                })
              }
            />
            <textarea
              rows={2}
              className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white min-h-[48px]"
              placeholder="e.g. Please call the care team — we need to handle this case manually."
              value={option.block.message}
              onChange={(e) =>
                onChange({
                  block: {
                    ...option.block,
                    message: e.target.value
                  }
                })
              }
            />
            {!option.block.message.trim() && (
              <p className="text-[10px] text-amber-700">
                Add a message — the popup needs something to say.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Authoring UI for pre-screening questions. Each question is a clearly-bounded
 * block; its answers sit side-by-side as cards, each carrying the show/hide
 * effects that tailor which pages/fields the recipient then sees.
 */
export function PreScreeningManager({
  questions,
  pages,
  fields,
  onChange
}: {
  questions: PreScreenQuestion[];
  pages: FormPage[];
  fields: FieldDef[];
  onChange: (next: PreScreenQuestion[]) => void;
}) {
  const allTargets = buildTargets(pages, fields, questions);

  const updateQuestion = (qId: string, patch: Partial<PreScreenQuestion>) => {
    onChange(questions.map((q) => (q.id === qId ? { ...q, ...patch } : q)));
  };
  const removeQuestion = (qId: string) => onChange(questions.filter((q) => q.id !== qId));
  const moveQuestion = (qId: string, dir: -1 | 1) => {
    const i = questions.findIndex((q) => q.id === qId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= questions.length) return;
    const next = [...questions];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const addQuestion = () => onChange([...questions, newPreScreenQuestion()]);

  const updateOption = (qId: string, oId: string, patch: Partial<PreScreenOption>) => {
    updateQuestion(qId, {
      options: (questions.find((q) => q.id === qId)?.options ?? []).map((o) =>
        o.id === oId ? { ...o, ...patch } : o
      )
    });
  };
  const addOption = (qId: string) => {
    const q = questions.find((x) => x.id === qId);
    if (!q) return;
    updateQuestion(qId, { options: [...q.options, newPreScreenOption('')] });
  };
  const removeOption = (qId: string, oId: string) => {
    const q = questions.find((x) => x.id === qId);
    if (!q || q.options.length <= 2) return;
    updateQuestion(qId, { options: q.options.filter((o) => o.id !== oId) });
  };
  const moveOption = (qId: string, oId: string, dir: -1 | 1) => {
    const q = questions.find((x) => x.id === qId);
    if (!q) return;
    const i = q.options.findIndex((o) => o.id === oId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= q.options.length) return;
    const next = [...q.options];
    [next[i], next[j]] = [next[j], next[i]];
    updateQuestion(qId, { options: next });
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-gray-800">Pre-screening questions</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Shown before the form. Each answer can reveal or hide pages and fields so the recipient
          only fills in what their situation needs.
        </p>
      </div>

      {questions.length === 0 ? (
        <p className="text-sm text-gray-500 py-4 text-center border border-dashed border-gray-200 rounded-lg">
          No pre-screening questions yet.
        </p>
      ) : (
        <div className="space-y-5">
          {questions.map((q, qi) => (
            <div key={q.id} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              {/* Question header strip — clear boundary between questions. */}
              <div className="flex items-center justify-between gap-2 border-b border-gray-200 bg-gray-50/70 px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Question {qi + 1}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className={fbInspectorIconBtn}
                    onClick={() => moveQuestion(q.id, -1)}
                    disabled={qi === 0}
                    title="Move question up"
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className={fbInspectorIconBtn}
                    onClick={() => moveQuestion(q.id, 1)}
                    disabled={qi === questions.length - 1}
                    title="Move question down"
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    className="text-[10px] px-1.5 py-0.5 rounded border border-red-200 bg-white text-red-700 hover:bg-red-50"
                    onClick={() => removeQuestion(q.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>

              {/* Question body */}
              <div className="p-3 space-y-3">
                <label className="block text-sm">
                  <span className="text-gray-600">Question prompt</span>
                  <input
                    className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                    value={q.prompt}
                    placeholder="e.g. Do you have other health coverage?"
                    onChange={(e) => updateQuestion(q.id, { prompt: e.target.value })}
                  />
                </label>

                <label className="flex items-start gap-2 text-xs cursor-pointer text-gray-600">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-gray-300"
                    checked={!!q.multiSelect}
                    onChange={(e) =>
                      updateQuestion(q.id, { multiSelect: e.target.checked ? true : undefined })
                    }
                  />
                  <span>
                    Allow multiple answers — the recipient can pick any that apply, and the effects
                    of every chosen answer apply.
                  </span>
                </label>

                <label className="flex items-start gap-2 text-xs cursor-pointer text-gray-600">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-gray-300"
                    checked={!!q.defaultHidden}
                    onChange={(e) =>
                      updateQuestion(q.id, { defaultHidden: e.target.checked ? true : undefined })
                    }
                  />
                  <span>
                    Start hidden — only render this question if an earlier question&apos;s answer
                    has a &ldquo;show this pre-screen question&rdquo; effect targeting it.
                  </span>
                </label>

                <div>
                  <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
                    Answers
                  </span>
                  <div className="mt-1.5 grid grid-cols-1 md:grid-cols-2 gap-3">
                    {q.options.map((opt, oi) => (
                      <AnswerCard
                        key={opt.id}
                        option={opt}
                        index={oi}
                        count={q.options.length}
                        targets={allTargets.filter(
                          (t) => t.parentQuestionId !== q.id
                        )}
                        onChange={(patch) => updateOption(q.id, opt.id, patch)}
                        onRemove={() => removeOption(q.id, opt.id)}
                        onMove={(dir) => moveOption(q.id, opt.id, dir)}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => addOption(q.id)}
                    className="mt-2 text-xs text-oe-primary hover:text-oe-dark hover:underline"
                  >
                    + Add answer
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={addQuestion}
        className="text-sm text-oe-primary hover:text-oe-dark hover:underline"
      >
        + Add pre-screening question
      </button>
    </div>
  );
}

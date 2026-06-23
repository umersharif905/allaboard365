/**
 * Resolves which pages and fields of a public form are visible given the
 * recipient's pre-screening answers.
 *
 * Keep in sync with the CommonJS source of truth:
 *   shared/public-form-visibility/index.js
 *
 * Rules (see docs/superpowers/specs/2026-05-14-form-editor-redesign/design.md §4):
 *   1. Every page/field starts visible unless `defaultHidden` is true.
 *   2. Each answered pre-screening question applies the effects of every
 *      selected option, in order: `show` adds the target, `hide` removes it.
 *   3. A field on a hidden page is hidden regardless of its own state.
 *   4. Unanswered questions apply no effects.
 */
import type { FormDefinition, FormPage } from '../types/publicFormDefinition';
import { effectivePages, pageIdForField } from '../types/publicFormDefinition';

/**
 * Map of pre-screening question id -> answer. A single-select answer is one
 * option id; a multi-select answer is an array of option ids.
 */
export type PreScreenAnswers = Record<string, string | string[]>;

export type FormVisibility = {
  visiblePageIds: Set<string>;
  visibleFieldNames: Set<string>;
  visiblePreScreenQuestionIds: Set<string>;
};

export function resolveVisibility(
  def: FormDefinition,
  answers: PreScreenAnswers | null | undefined
): FormVisibility {
  const pages = effectivePages(def);
  const fields = def.fields ?? [];
  const preScreening = def.preScreening ?? [];
  const ans = answers ?? {};

  // Step 1 — defaults.
  const visiblePageIds = new Set<string>();
  for (const p of pages) {
    if (!p.defaultHidden) visiblePageIds.add(p.id);
  }
  const visibleFieldNames = new Set<string>();
  for (const f of fields) {
    if (!f.defaultHidden && f.name) visibleFieldNames.add(f.name);
  }
  const visiblePreScreenQuestionIds = new Set<string>();
  for (const q of preScreening) {
    if (q.id && !q.defaultHidden) visiblePreScreenQuestionIds.add(q.id);
  }

  // Step 2 — apply effects from answered questions, in array order. A question
  // hidden by an earlier effect is a no-op (its own effects never fire), so
  // one option can silently disable a downstream prescreen question.
  for (const q of preScreening) {
    if (!visiblePreScreenQuestionIds.has(q.id)) continue;
    const raw = ans[q.id];
    const selectedIds = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const selectedId of selectedIds) {
      const opt = q.options.find((o) => o.id === selectedId);
      if (!opt) continue;
      for (const eff of opt.effects) {
        if (!eff.targetId) continue;
        const set =
          eff.targetType === 'page'
            ? visiblePageIds
            : eff.targetType === 'preScreenQuestion'
              ? visiblePreScreenQuestionIds
              : visibleFieldNames;
        if (eff.action === 'show') set.add(eff.targetId);
        else if (eff.action === 'hide') set.delete(eff.targetId);
      }
    }
  }

  // Step 3 — a field on a hidden page is hidden regardless of its own state.
  for (const f of fields) {
    if (!f.name) continue;
    const pid = pageIdForField(f, pages);
    if (!visiblePageIds.has(pid)) visibleFieldNames.delete(f.name);
  }

  return { visiblePageIds, visibleFieldNames, visiblePreScreenQuestionIds };
}

/** Ordered list of currently-visible pages. */
export function visiblePages(def: FormDefinition, vis: FormVisibility): FormPage[] {
  return effectivePages(def).filter((p) => vis.visiblePageIds.has(p.id));
}

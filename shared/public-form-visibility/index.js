'use strict';

/**
 * Single source of truth for resolving which pages and fields of a public form
 * are visible, given the recipient's pre-screening answers.
 *
 * Used by:
 *   - backend (publicFormSubmissionService — required-field validation must
 *     skip conditionally-hidden fields).
 * Frontend ESM copy: frontend/src/utils/publicFormVisibility.ts (keep in sync).
 *
 * Rules (see docs/superpowers/specs/2026-05-14-form-editor-redesign/design.md §4):
 *   1. Every page/field starts visible unless `defaultHidden` is true.
 *   2. Each answered pre-screening question applies the effects of every
 *      selected option, in order: `show` adds the target, `hide` removes it.
 *      A single-select answer is one option id; a multi-select answer is an
 *      array of option ids.
 *   3. A field on a hidden page is hidden regardless of its own state.
 *   4. Unanswered questions apply no effects.
 */

/** Stable id for the implicit single page used when a form has no `pages`. */
const IMPLICIT_PAGE_ID = 'page_main';

/** The form's pages as an always-non-empty list (implicit single page fallback). */
function effectivePages(def) {
  const pages = def && Array.isArray(def.pages) ? def.pages : null;
  if (pages && pages.length > 0) return pages;
  return [{ id: IMPLICIT_PAGE_ID, title: (def && def.title) || '' }];
}

/**
 * The page a field belongs to. A field whose `pageId` is missing or doesn't
 * match any page falls back to the first page.
 */
function pageIdForField(field, pages) {
  if (field && field.pageId && pages.some((p) => p.id === field.pageId)) {
    return field.pageId;
  }
  return (pages[0] && pages[0].id) || IMPLICIT_PAGE_ID;
}

/**
 * Resolve visible pages/fields/prescreen-questions from pre-screening answers.
 *
 * @param {object} def - parsed FormDefinition
 * @param {Record<string,string>} answers - { [questionId]: optionId }
 * @returns {{ visiblePageIds: Set<string>, visibleFieldNames: Set<string>, visiblePreScreenQuestionIds: Set<string> }}
 */
function resolveVisibility(def, answers) {
  const pages = effectivePages(def);
  const fields = def && Array.isArray(def.fields) ? def.fields : [];
  const preScreening = def && Array.isArray(def.preScreening) ? def.preScreening : [];
  const ans = answers && typeof answers === 'object' ? answers : {};

  // Step 1 — defaults.
  const visiblePageIds = new Set();
  for (const p of pages) {
    if (!p.defaultHidden) visiblePageIds.add(p.id);
  }
  const visibleFieldNames = new Set();
  for (const f of fields) {
    if (f && !f.defaultHidden && f.name) visibleFieldNames.add(f.name);
  }
  const visiblePreScreenQuestionIds = new Set();
  for (const q of preScreening) {
    if (q && q.id && !q.defaultHidden) visiblePreScreenQuestionIds.add(q.id);
  }

  // Step 2 — apply effects from answered questions, in array order.
  // A question whose visibility has been hidden by an earlier effect does not
  // fire its own effects (a hidden question is a no-op). This lets one
  // pre-screen option silently disable another pre-screen question.
  for (const q of preScreening) {
    if (!q || !q.id) continue;
    if (!visiblePreScreenQuestionIds.has(q.id)) continue;
    const raw = ans[q.id];
    const selectedIds = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const selectedId of selectedIds) {
      const opt = (q.options || []).find((o) => o && o.id === selectedId);
      if (!opt) continue;
      for (const eff of opt.effects || []) {
        if (!eff || !eff.targetId) continue;
        let set;
        if (eff.targetType === 'page') set = visiblePageIds;
        else if (eff.targetType === 'preScreenQuestion') set = visiblePreScreenQuestionIds;
        else set = visibleFieldNames;
        if (eff.action === 'show') set.add(eff.targetId);
        else if (eff.action === 'hide') set.delete(eff.targetId);
      }
    }
  }

  // Step 3 — a field on a hidden page is hidden regardless of its own state.
  for (const f of fields) {
    if (!f || !f.name) continue;
    const pid = pageIdForField(f, pages);
    if (!visiblePageIds.has(pid)) visibleFieldNames.delete(f.name);
  }

  return { visiblePageIds, visibleFieldNames, visiblePreScreenQuestionIds };
}

module.exports = {
  IMPLICIT_PAGE_ID,
  effectivePages,
  pageIdForField,
  resolveVisibility,
};

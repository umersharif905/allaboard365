# Form editor redesign — implementation log

Running log for the `fix/back-office/form-editor` branch. Captures anything
that should be surfaced in the eventual PR description: notable code touched,
decisions made, and a per-commit summary so the PR write-up is well-rounded.

Branch: `fix/back-office/form-editor`
Based on: `fix/back-office/forms-redesign` (PR #371, **still open / unmerged**)
Started: 2026-05-14

---

## PR-prep notes (do before / when opening the PR)

- **Set the PR base branch to `fix/back-office/forms-redesign`, NOT `staging`.**
  This branch is stacked on the unmerged forms-redesign PR (#371). Opening it
  against `staging` would show all 30+ forms-redesign commits as part of this
  PR. Use `gh pr create --base fix/back-office/forms-redesign`. Once #371
  merges, retarget the base to `staging`.

- **`frontend/package-lock.json` change should not ship in this PR.** It is
  currently tracked in git and shows a 7-insert / 40-delete diff that comes
  from the local Docker dev build (a different npm version regenerating the
  lockfile); it does not reflect a real dependency change and does not exist
  on production. Decision needed before PR: either revert the working-tree
  change (`git checkout -- frontend/package-lock.json`) so it stays clean, or
  if it should be permanently untracked, do `git rm --cached` + add to
  `.gitignore` as a *separate, deliberate* change — not folded silently into
  this PR, since it affects every dev and CI (`npm ci` needs the lockfile).

---

## Environment note

The repo runs inside the `allaboard365-frontend` / `allaboard365-backend`
Docker containers (`node:22`, repo mounted at `/app`). Run the toolchain via
`sudo docker exec -w /app/frontend allaboard365-frontend npx tsc --noEmit`
(and likewise `npx eslint .`). The TrueNAS host itself has no Node.

**Pre-existing baseline:** `tsc --noEmit` reports ~598 errors across the
codebase before this branch — mostly `noUnusedLocals` noise plus some real
type bugs inherited from the forms-redesign branch (e.g. `SendToMemberModal.tsx`
uses `template.AllowAnonymous` / `IsPublished`, which aren't on its prop type).
Per-commit verification here checks only that **files touched by this branch
add zero new errors**, not that the whole tree is clean.

---

## Commit log

- **Step 1 — schema** (`publicFormDefinition.ts`): added `FieldWidth`,
  `FormPage`, `PreScreenEffect/Option/Question` types; extended `FieldDef`
  (`width`, `pageId`, `defaultHidden`) and `FormDefinition` (`multiPage`,
  `pages`, `preScreening`). `def.fields` stays the flat canonical list — no
  backend impact. Added parse normalizers and helpers (`effectivePages`,
  `pageIdForField`, `effectiveFieldWidth`, `fieldsForPage`, `newDefId`,
  `IMPLICIT_PAGE_ID`). All additive; legacy definitions round-trip unchanged.
- **Step 2 — shared visibility resolver**: `shared/public-form-visibility/`
  (CJS canonical, bundled to backend at deploy) + `frontend/src/utils/
  publicFormVisibility.ts` (typed ESM copy). Pure `resolveVisibility(def,
  answers)` → `{ visiblePageIds, visibleFieldNames }`.
- **Steps 3–6 — editor authoring capability** (one cohesive change; all in
  the builder files): form-structure gate (`multiPage` + `preScreeningEnabled`
  toggles, added `preScreeningEnabled` to schema + `newFormPage` /
  `newPreScreenQuestion` / `newPreScreenOption` helpers); two-column `width`
  control in `FieldInspector` + `½ width` / `hidden by default` badges in
  `FieldCanvas`; new `PageManager` (page rail, add/rename/reorder/delete,
  per-page description + hidden-by-default); new `PreScreeningManager`
  (questions → options → show/hide effect picker over pages & fields, with
  no-op/mismatch hints). `PublicFormBuilder` rewritten: name-based field
  selection, active-page state, page-scoped canvas + drag-reorder,
  toggle-off confirm dialogs that preserve fields. Editor canvas stays a
  reliable vertical list with width badges — true side-by-side rendering
  lands in the recipient renderer + preview (step 9).
- **Steps 7-8 — editor page overhaul + inherited blockers**
  (`TenantSharingFormEditorPage.tsx`, rewritten): **B-006** Kind input
  removed, `kindLabel` no longer sent on save; **B-008** the two save
  buttons collapsed into one `save()` that PATCHes settings, creates a new
  definition version only when it changed, and publishes when the user can;
  **B-007** publish redirects to the forms list, draft saves show a
  fixed-position success toast (and a fixed error toast) seen regardless of
  scroll; **B-018** the anonymous-no-identity warning is a derived value
  rendered always-visible in Settings (was buried in the collapsed Delivery
  settings panel). Single Save lives in a sticky bottom bar.
- **Step 9 — recipient renderer** (`PublicFormView.tsx`, rewritten): pre-
  screening phase renders one question per step as large option boxes
  (auto-advance on select, Back to revise) with its own progress bar; the
  form phase renders visible pages one at a time, enrollment-stepper style,
  with Back / Next / Submit and a page progress bar; `resolveVisibility`
  drives which pages/fields show; two consecutive half-width fields render
  side by side; required-field validation runs per-page on Next and over
  all visible fields on Submit (native `required` alone is insufficient
  once earlier pages unmount); payload drops conditionally-hidden field
  values and carries `__preScreenAnswers`. Single-page / no-prescreening
  forms render exactly as before. Submit button moved off raw `blue-700`
  onto `oe-primary` per the UI rules.
- **Step 10 — backend touch** (`publicFormSubmissionService.js`):
  `validatePayloadAgainstDefinition` now resolves visibility from
  `payload.__preScreenAnswers` via the shared `resolveVisibility` helper
  (`requireShared('public-form-visibility')`) and skips validation for
  fields hidden by the recipient's pre-screening answers. Legacy forms
  resolve every field visible, so behavior is unchanged for them. Verified
  the module loads in the backend container and the resolver behaves
  (`defaultHidden` field correctly excluded). No existing tests reference
  this service.
- **Step 11 — verification pass**: full `tsc --noEmit` — 598 errors, equal
  to the pre-existing baseline; **all 8 touched frontend files report zero
  errors**. `eslint` on the 9 touched frontend files — clean (one `React`
  global error in `PublicFormView` fixed by importing `type ReactNode`; the
  4 `catch (e: any)` warnings in the editor page are the original file's
  unchanged pattern). Backend modules load in-container. Functional test of
  the shared `resolveVisibility` against a 3-page / 2-question definition:
  all five answer combinations resolve the expected pages + fields,
  including a field-level show on a visible page while a sibling field on a
  hidden page stays hidden; legacy (no pages / no pre-screening) forms
  resolve every field visible. **Browser/UI manual pass is still to be done
  in the Docker dev environment** — drag-reorder, the page/pre-screening
  authoring UI, and the recipient stepper were not exercised in a browser
  here.
- **Bugfix — colliding generated ids** (`publicFormDefinition.ts`): the dev
  app is served over plain http from a LAN IP, so `crypto.randomUUID` is
  unavailable and `newDefId` fell back to `String(Date.now())` — the two
  options of a freshly-added pre-screening question were created in the same
  millisecond and got identical ids, so editing one edited both and React
  duplicate-keys mis-rendered the second question. Confirmed against the
  stored "half width test" definition in `allaboard-testing`. Fix:
  `shortId()` now uses a module-level monotonic counter (collision-proof
  regardless of `crypto.randomUUID`); `newFieldFromPalette` uses it too and
  routes all generated field names through `uniqueFieldName`; and
  `parseFormDefinition` runs `dedupePreScreeningIds` — a deterministic
  load-time repair so existing broken forms heal on next open and round-trip
  stably. Logged the editor side-by-side rendering deferral as **B-030**.
- **Feature — multi-select pre-screening questions**: a per-question
  "Allow multiple answers" toggle (`PreScreenQuestion.multiSelect`). The
  recipient sees toggleable boxes plus a Next button instead of
  auto-advance; the effects of every selected option apply. `resolveVisibility`
  (both the shared CJS and frontend copies) now accepts an answer that is
  either one option id or an array of ids — single-string answers still
  resolve, so it's backward compatible. Verified multi/single/empty answer
  resolution in the backend container. Logged **B-031** — the form editor
  needs a broader visual redesign pass (subsumes B-030).
- **Feature — duplicate form**: a Duplicate action in the forms-list kebab
  menu (gated on `canEdit`). New service `publicFormAdminService.duplicateTemplate`
  copies all template settings + the latest definition into a new unpublished
  draft titled `"<original> (Copy)"`; exposed as
  `POST /templates/:id/duplicate` on both the tenant-admin and vendor routes
  (vendor gated on `authorizeWrite`). The list stays put and refreshes so the
  copy appears in place. Also tidied a pre-existing `no-extra-boolean-cast`
  lint error in the same file. Logged **B-032** — a "Discard" action for a
  just-created form (shown only on first landing after "+ New form").
- **Bugfix — multi-page form auto-submitted on reaching the last page**
  (`PublicFormView.tsx`): the nav button swapped `type="button"` (Next) ->
  `type="submit"` (Submit) at the same JSX position, so React reused the DOM
  node and mutated its `type` attribute synchronously during the click's
  discrete-event flush — the browser then ran that same click's default
  action, now saw `type="submit"`, and submitted the form. Fix: the visible
  nav button is now always `type="button"` and submits via
  `formRef.requestSubmit()` on the last page; a hidden `type="submit"` button
  rendered only on the last page preserves Enter-to-submit. A button can no
  longer change submit-role on a live node, so advancing pages can never
  trigger a submit.
- **Feature — readable pre-screening on submissions**: `PublicFormView` now
  writes a self-contained `__preScreening` snapshot into the submission
  payload at submit time — each question prompt, every answer choice, and
  which one(s) were selected — alongside the existing `__preScreenAnswers`
  id map (kept for the server's visibility resolution). New shared
  `PreScreeningSubmissionSummary` component renders it (prompt + all options,
  selected ones highlighted), wired into the submission detail page and the
  submission preview modal. `payloadToRows` now skips `__`-prefixed metadata
  keys, and the detail page's B-020 form-answers / account-snapshot split
  excludes them too — so the snapshot no longer leaks into the generic
  payload grids or CSV/PDF exports as a raw blob. The snapshot is stored on
  the submission, so it stays readable even if the template is later edited
  or deleted (submissions carry no version reference).
- **B-031 — form editor UI redesign (tabbed editor)**: the edit-form flow is
  rebuilt as a tabbed editor per `ui-redesign-design.md`. New
  `useFormDefinition` hook lifts the parsed definition + every mutator out of
  `PublicFormBuilder`, so the Setup tab's form-structure toggles and the
  Build tab's builder share one definition. `PublicFormBuilder` is now a
  controlled Build-tab body (form-structure panel, Submission PDF, and the
  Schema-version input removed from it; Header & intro collapsed into a
  `<details>`). `TenantSharingFormEditorPage` rebuilt as: a sticky header
  (back link, inline-editable title, Draft/Published + Active/Inactive
  pills, Preview, Save) · an advisory strip (read-only / inactive-published /
  identity warnings, visible on every tab) · three tabs — **Setup**
  (form-structure toggles + delivery + active), **Build form** (the builder),
  **Advanced** (routing & notifications with the default-vendor explainer
  trimmed to a help icon, embedding, Submission PDF + Preview PDF, version
  history + change note, Raw JSON collapsible, a red Danger zone for Delete).
  Schema-version input removed entirely; the two stacked cards merged into
  the one tabbed page. Save validates everything and switches to the
  offending tab on error. B-032 (Discard for a just-created form) was left
  in `blockers.md` — it needs cross-file nav-state plumbing and was kept out
  to keep this pass focused.
- **B-033 — builder lower-half redesign**: per
  `builder-lower-half-redesign-design.md`, the Build-tab lower half is now one
  cohesive card. `FieldPalette` → a 2-column icon-tile grid (Lucide icon per
  type) instead of a tall list of full-width buttons. `PageManager` → a
  horizontal tab strip (pill tabs, field counts, inline "+ Add page") with
  per-page settings — title / description / hidden / reorder / delete — in an
  outside-click popover; no page UI at all on single-page forms, which also
  kills the confusing one-item "Page" dropdown. `FieldInspector` → renders
  `null` when no field (no empty state), gains an ✕ close button, and its
  page control is renamed "Move to page" and gated on
  `multiPage && pages.length > 1`. `PublicFormBuilder` assembles it all into
  one card: page tabs on top, a palette zone (left, `bg-gray-50/60`), the
  canvas zone (center, primary), and a slide-in inspector zone (right,
  `w-0` ↔ `w-80` width transition) that appears only on selection — clicking
  a selected field again deselects it. Resolves B-033.

- `frontend/src/types/publicFormDefinition.ts` — schema is now the gate for
  pages / pre-screening / field width. Backend still reads `def.fields` flat.

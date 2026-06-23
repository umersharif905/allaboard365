# Form Editor Redesign — design & plan

Design and implementation plan for the form editor redesign on the
`fix/back-office/form-editor` branch.

- **Branch:** `fix/back-office/form-editor`
- **Based on:** `fix/back-office/forms-redesign` (PR #371, still open — this
  branch is stacked; see `implementation-log.md` for PR-base instructions)
- **Date:** 2026-05-14
- **Companion docs:** `blockers.md`, `features.md`, `implementation-log.md`

---

## 1. Goal & scope

Redesign the screen shown when a care-team user clicks **New form** or
**Edit** on a form template. Three problems, plus four inherited cleanup
items from the forms-redesign branch.

Problems being solved:

1. **Crude editor layout (F1)** — the palette / canvas / inspector surface is
   hard to parse. Clean up the hierarchy and styling.
2. **Vertical-only fields (F2)** — fields can only stack. Add the ability to
   place two fields side by side (e.g. First name / Last name) while keeping
   full-width as an option.
3. **Long, intimidating forms (F3 + F4)** — the share-request intake form is
   one endless scroll. Add (a) a **paging** system that groups fields into
   pages (personal info / bank info / doctor info, enrollment-stepper style)
   and (b) **pre-screening A/B questions** shown before the form that tailor
   which pages/fields the recipient sees.

Inherited blockers folded in (see `blockers.md`): **B-006** retire Kind,
**B-007** save confirmation + redirect, **B-008** single save button,
**B-018** anonymous-no-identity soft warning.

Surfaces touched:

| Surface | File(s) |
|---|---|
| Schema | `frontend/src/types/publicFormDefinition.ts` |
| Editor | `frontend/src/pages/tenant-admin/TenantSharingFormEditorPage.tsx`, `frontend/src/components/tenant-admin/public-form-builder/*` |
| Recipient renderer | `frontend/src/components/public/PublicFormView.tsx` |
| Backend (small) | `backend/services/publicFormSubmissionService.js` + a shared effect-resolution helper |

No SQL / DB schema changes. The backend stores `DefinitionJson` as an opaque
blob (`publicFormAdminService.js` only does `JSON.parse()` to validate), so
the schema can grow freely.

---

## 2. Decisions locked (from brainstorming)

- **Conditional model:** both whole pages *and* individual fields can be
  conditional. Effects live on the **pre-screening option**, not as tags
  scattered on each field. Fields meant to be *added* by an answer are
  authored normally but marked `defaultHidden`; an option's `show` effect
  reveals them.
- **Two-column layout:** per-field `width` property (`full` / `half`). Two
  consecutive `half` fields pair into a row. No explicit row-container concept.
- **Pre-screening question shape:** default binary (two options), with an
  "add option" affordance for 3+. Options are large boxes; "Yes/No" vs
  "left path / right path" is purely a matter of the option labels — one
  data model covers both.
- **Capability scope:** general and opt-in per form. Any template can enable
  pages and/or pre-screening; the SR intake form is just the first configured
  this way.
- **Form-type gate:** two form-level toggles (`multiPage`, pre-screening
  on/off) surfaced at the top of the editor shape the authoring workflow.
  Short forms leave both off and get today's simple single-page experience.

---

## 3. Schema extensions

All additive and backward compatible. `def.fields` **stays the flat canonical
array of every field object** — the backend submission and PDF services read
it directly (`publicFormSubmissionService.js:67,92`,
`publicFormSubmissionPdfService.js:38`) and must keep working untouched.

```ts
// publicFormDefinition.ts

export type FieldWidth = 'full' | 'half';

export type FieldDef = {
  // ...all existing keys unchanged...
  /** Layout width. Default 'full'. Two consecutive 'half' fields pair into a row. */
  width?: FieldWidth;
  /** Which page this field belongs to. Missing/null => first page. */
  pageId?: string;
  /** Field starts hidden; revealed only by a pre-screening 'show' effect. */
  defaultHidden?: boolean;
};

export type FormPage = {
  id: string;
  title: string;
  description?: string;
  /** Page starts hidden; revealed only by a pre-screening 'show' effect. */
  defaultHidden?: boolean;
};

export type PreScreenEffect = {
  action: 'show' | 'hide';
  targetType: 'page' | 'field';
  /** page id or field name */
  targetId: string;
};

export type PreScreenOption = {
  id: string;
  /** Box label — "Yes" / "No" / "I have other coverage" / etc. */
  label: string;
  effects: PreScreenEffect[];
};

export type PreScreenQuestion = {
  id: string;
  /** The question prompt shown above the option boxes. */
  prompt: string;
  /** Default 2 options; author can add more. */
  options: PreScreenOption[];
};

export type FormDefinition = {
  // ...existing: version, title, introHtml, headerImage, headerHtml,
  //    fields, submissionPdf...
  /** When true, the form is authored and rendered as ordered pages. */
  multiPage?: boolean;
  /** Ordered page metadata. Absent => single implicit page holding all fields. */
  pages?: FormPage[];
  /** Pre-screening questions shown before the form pages. Absent => none. */
  preScreening?: PreScreenQuestion[];
};
```

### Why flat `fields` + `pageId` pointer (not nested `pages[].fields[]`)

A field points at its page; it cannot be orphaned or duplicated across pages,
so there is no drift to keep in sync. Field order within a page is the order
within the flat `fields` array. Backend consumers of `def.fields` keep working
with zero changes. Nesting fields under pages was considered and rejected — it
breaks the backend and would force a flat mirror anyway.

### Backward compatibility

`parseFormDefinition` / `normalizeField` extend to:

- Preserve the new keys (`width`, `pageId`, `defaultHidden`, `pages`,
  `preScreening`, `multiPage`) through parse/normalize/stringify round-trips.
- Treat a legacy definition (no `pages`) as a **single implicit page**: all
  fields render in one page, `multiPage` false, no pre-screening.
- `width` defaults to `'full'`; unknown values coerce to `'full'`.
- `pageId` that doesn't match any page in `def.pages` falls back to the first
  page (defensive — covers a deleted page leaving stragglers).

---

## 4. Conditional logic resolution

A single pure helper resolves visibility from pre-screening answers. It is the
shared contract between the recipient renderer and the backend.

```
resolveVisibility(def, answers) -> { visiblePageIds: Set, visibleFieldNames: Set }
```

Rules:

1. Start: every page and field is visible **unless** `defaultHidden` is true.
2. For each answered pre-screening question, apply the selected option's
   `effects` in order: `show` adds the target to the visible set, `hide`
   removes it.
3. A field on a hidden page is hidden regardless of its own state.
4. Unanswered pre-screening questions apply no effects (their targets keep
   their default state).

This helper lives in a place importable by both frontend and backend. Put it
in `shared/` (the monorepo already bundles `shared/` into the backend at
deploy time — see `backend/deploy.sh`), e.g.
`shared/public-form-visibility.js`, with a thin typed re-export on the
frontend if needed.

---

## 5. Editor redesign

### 5.1 Form-type gate

At the top of the editor (most prominent on a brand-new blank form): a small
"Form structure" panel with two toggles.

- **Multi-page form** — off => single page, page manager hidden. On => page
  manager appears; existing fields collapse into "Page 1".
- **Pre-screening questions** — off => no pre-screening. On => pre-screening
  manager appears above the pages.

Both default off. Turning `multiPage` off again when pages exist: keep the
fields, flatten `pageId` back to the first page, warn before discarding
extra pages. Turning pre-screening off: keep `defaultHidden` flags but the
questions are dropped (warn first).

### 5.2 Layout overhaul (F1)

Rework `PublicFormBuilder.tsx` from the current 2/7/3 column grid into a
clearer hierarchy. Target structure top-to-bottom:

1. **Form structure** panel (the gate, §5.1).
2. **Form header** (header image + rich HTML) — keep, restyle.
3. **Pre-screening manager** (§5.4) — only when enabled.
4. **Page manager + canvas** (§5.3) — palette, canvas, inspector.
5. **Submission PDF** settings — keep, restyle.
6. **Heading / introduction** fields — keep.

Styling per CLAUDE.md UI rules: Tailwind only, `oe-primary`/`oe-dark` for
primary actions, cards `bg-white rounded-lg border border-gray-200`, `p-6`.
Retire the ad-hoc `formBuilderButtonClasses.ts` colors where they diverge
from the brand palette.

### 5.3 Page manager + canvas

- When `multiPage` is on: a page rail (vertical list or tabs) lets the author
  add / rename / reorder / delete pages and set a page description. Each page
  has a **"Hidden by default"** toggle (for conditional pages).
- The author edits **one page at a time**; the canvas shows that page's
  fields. This mirrors the recipient stepper, so what the author sees maps to
  what the recipient gets.
- Palette adds a field to the **currently active page** (`pageId` set
  accordingly).
- Drag-reorder works within a page. Moving a field across pages: drag onto the
  page rail entry, or a "Move to page" control in the inspector — pick the
  simpler one during implementation.
- When `multiPage` is off: no rail, single canvas, exactly today's behavior.

### 5.4 Two-column layout (F2)

- `FieldInspector` gains a **Width** control: Full / Half.
- `FieldCanvas` renders consecutive `half` fields side by side (a flex/grid
  row holding up to two). A `half` field with no `half` neighbor renders at
  half width on its row (left-aligned) — acceptable; no auto-promotion.
- Drag-reorder stays field-level; pairing is purely a render concern derived
  from `width` + adjacency.

### 5.5 Pre-screening manager

- A section above the pages, visible when pre-screening is enabled.
- Author adds **questions**; each question has a `prompt` and **options**
  (starts with 2; "Add option" for more).
- For each option, an **effect picker**: pick from the existing pages and
  fields (listed by their human label) and mark each as **show** or **hide**.
  This is the "you choose the fields/pages to hide or reveal" model — no
  per-field tagging.
- Validation hints (non-blocking): warn if an option has no effects, or if a
  `show` effect targets something not `defaultHidden` (no-op), or a `hide`
  targets something already `defaultHidden`.

### 5.6 Inherited blockers folded in

- **B-006 — retire Kind.** Remove the Kind `<input>` and the
  `displayFormKindLabel` line from `TenantSharingFormEditorPage.tsx`. Stop
  sending `kindLabel` in `saveMeta`. `FormKind` stays in the DB untouched;
  it's just no longer authored here.
- **B-008 — single save.** Merge "Save settings" and "Save and publish" into
  one primary save action that persists meta (`PATCH /templates/:id`) and the
  definition version (`POST /templates/:id/versions` + publish) together.
  Sequence the two calls; surface one combined result.
- **B-007 — save confirmation + redirect.** On a successful save+publish,
  show a clear confirmation and redirect to the forms list
  (`routeBase?saved=…`, already partly wired at line 281). On draft save
  (VendorAgent / no publish rights), keep the user in the editor with a
  fixed-position success toast.
- **B-018 — anonymous-no-identity warning.** Carry the existing E.1 soft
  warning (currently `TenantSharingFormEditorPage.tsx:514-543`) into the new
  layout. Logic unchanged — it reads `def.fields`, which is still the flat
  list.

---

## 6. Recipient renderer (`PublicFormView.tsx`)

Currently one flat `def.fields.map()`. New flow:

1. **Pre-screening step** — if `def.preScreening` is non-empty, render the
   questions first, one prompt + large option boxes each. A short progress
   indicator (§7) marks position within the pre-screening sequence.
2. **Resolve visibility** — once pre-screening is answered (or immediately if
   none), call `resolveVisibility(def, answers)`.
3. **Paged form** — render visible pages one at a time, enrollment-stepper
   style, with Back / Next; the last visible page submits. A progress bar
   (§7) spans the visible pages.
4. **Two-column render** — within a page, consecutive visible `half` fields
   render side by side.
5. **Validation** — required-field checks run only over **visible** fields on
   the current page (and across visible pages on submit). Hidden fields are
   skipped entirely.
6. **Submission payload** — include the pre-screening answers in the payload
   so the backend can re-resolve visibility (§8) and so the care team can
   later see which path the member took.
7. **Single-page / no-prescreening forms** — behave exactly as today.

Reference for the page-by-page UX: the enrollment flow
(`frontend/src/pages/enrollment/EnrollmentPage.tsx`).

---

## 7. Progress indicators (in scope)

- **Multi-page progress bar** — spans the visible form pages, showing how far
  the recipient has come. Only shown when `multiPage` and >1 visible page.
- **Pre-screening progress indicator** — a separate, short indicator for the
  pre-screening question sequence, treated as its own mini-step run ahead of
  the pages.

These are recipient-renderer UI only. They are also the design groundwork the
future save-and-resume feature (B-029) will reuse — that feature's
persistence layer is out of scope here.

---

## 8. Backend touch

`backend/services/publicFormSubmissionService.js` validates required fields
over `def.fields`. With conditional visibility, a required field that was
hidden by the recipient's pre-screening answers must **not** block the
submission.

Plan:

- The submission payload carries the pre-screening answers (§6.6).
- The backend calls the shared `resolveVisibility(def, answers)` helper
  (`shared/public-form-visibility.js`, §4) and validates required fields only
  over the visible set.
- If answers are absent (legacy / single-page form), every field is visible —
  identical to today's behavior.

Estimated ~30 lines plus the shared helper. No other backend changes; the PDF
service can keep rendering `def.fields` as-is for now (a hidden field simply
has no value — acceptable; revisit only if it looks wrong).

---

## 9. Out of scope

- SQL / DB schema changes — none needed.
- Save-and-resume / member-account form drafts — **B-029**, backlog.
- Submission-viewer display of pre-screening answers and conditional-path
  context — note as a follow-up blocker when the viewer is next touched.
- Reworking the submission PDF to omit conditionally-hidden fields — revisit
  only if it reads wrong.

---

## 10. Implementation sequence

Ordered so each step is independently verifiable in the UI.

1. **Schema** — extend `publicFormDefinition.ts` (types + parse/normalize/
   stringify + legacy single-implicit-page handling). Foundation for
   everything else.
2. **Visibility helper** — `shared/public-form-visibility.js` +
   `resolveVisibility`. Pure function, no UI.
3. **Form-type gate** — the two toggles in the editor; wire to `multiPage` /
   `preScreening` presence. Page manager + pre-screening manager still stubs.
4. **Two-column (F2)** — `width` control in `FieldInspector`, paired render in
   `FieldCanvas`. Small, self-contained, ships value immediately.
5. **Page manager (F4 authoring)** — page rail, add/rename/reorder/delete,
   per-page description + "hidden by default", active-page canvas.
6. **Pre-screening manager (F3 authoring)** — questions, options, effect
   picker.
7. **Editor layout overhaul (F1)** — restructure `PublicFormBuilder` hierarchy
   and restyle to brand palette. Done after the new panels exist so the
   layout accounts for them.
8. **Inherited blockers** — B-006, B-007, B-008, B-018 (B-008 single-save
   pairs naturally with the layout pass).
9. **Recipient renderer** — `PublicFormView` pre-screening step, paged render,
   two-column render, visibility-aware validation, progress indicators (§7).
10. **Backend touch** — `publicFormSubmissionService` uses the shared helper.
11. **End-to-end manual pass** — author a multi-page + pre-screening form,
    submit it down two different pre-screening paths, confirm the right
    fields/pages appear and required-field validation respects visibility.

Log each commit in `implementation-log.md` as it lands.

---

## 11. Open items / risks

- **Cross-page field move UX** — drag-to-rail vs inspector "Move to page".
  Decide during step 5; pick the simpler.
- **`multiPage` / pre-screening toggle-off** — discards pages / questions.
  Needs a clear confirm dialog so authors don't lose work accidentally.
- **Effect picker referential integrity** — deleting a page or field that a
  pre-screening effect targets leaves a dangling `targetId`. The resolver
  treats unknown targets as no-ops (safe); the editor should also surface a
  warning so the author can clean it up.
- **PDF + hidden fields** — left as-is for now (§9); flagged here in case
  manual testing shows it reads wrong.

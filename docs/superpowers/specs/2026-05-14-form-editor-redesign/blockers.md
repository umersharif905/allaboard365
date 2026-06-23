# Form editor redesign — blockers & inherited items

Running list of gaps / open decisions for the `fix/back-office/form-editor`
branch. Same format as the forms-redesign blockers doc.

---

## Inherited from forms-redesign — explicitly deferred *to this spec*

These blockers were logged during the forms-redesign work
(`docs/superpowers/specs/2026-05-13-forms-redesign/blockers.md`) and
deferred to the form-editor redesign on purpose. They should be closed
out as part of this branch's work.

### B-006 (inherited) · Retire the "Kind" field from authoring

The Create-form flow and the editor still surface a `Kind` input (a
transitional shim — the title doubles as the `kindLabel` sent to the
backend). The editor redesign should retire `Kind` from authoring entirely.

### B-008 (inherited) · Consolidate the editor's two save buttons

Today the editor has one save for the top settings panel and a separate
save for the form definition. Care team has to click twice to fully save.
The redesign replaces the whole authoring surface — consolidate to a
single save.

### B-007 (inherited) · Save needs confirmation + redirect

After saving an edit, the editor doesn't redirect back to the forms list
and the only "saved" affordance is a toast at the top of the page. The
redesign should give a clear post-save confirmation and sensible
navigation, for both draft and publish paths.

### B-018 (inherited) · E.1 soft warning on anonymous forms with no identity fields

Creating an anonymous form with no identity fields (Member ID, email,
name, DOB) should surface a soft warning banner in the editor. Planned in
the forms-redesign followup, deferred here. Decide whether to implement as
part of the editor redesign (likely yes — the editor is being rebuilt).

---

## New blockers / open decisions

_Add new `B-NNN` entries here as they surface. Format: id + 1-line title,
**Surfaced** (date + how found), **Where** (file/endpoint), **What the spec
says** vs **what the code does**, **Fix shape**, **Why held back**._

---

## B-029 · Backlog — save-and-resume incomplete forms on the member's account

**Surfaced:** 2026-05-14, scoping conversation for the form-editor redesign.

### The ask (future work — OUT OF SCOPE for this branch)

Today the main forms are essentially external links. Even when a logged-in
member fills one out, a *partially completed* form isn't saved anywhere — if
they don't finish in one sitting, the work is lost. There's no member-account
home for an in-progress form.

Future goal: make the main forms accessible from inside the member's own
account, and let a member **save an incomplete form as a draft** that persists
to their account so they can come back and finish it later.

### Why it's logged here, not built now

Out of scope for the form-editor redesign. But it's directly adjacent —
the multi-page + pre-screening structure this branch introduces is exactly
what a save-and-resume feature would persist (current page, answers so far,
pre-screening selections). Worth a proper backlog item so the data shape
designed now stays compatible.

### Design elements we CAN build now that this future work will reuse

- **Progress bar on multi-page forms** — shows the member how far through a
  long form they are. Useful on its own merit for this branch, and the
  save-and-resume feature will lean on the same page-progress concept.
- **A short, separate progress indicator for the pre-screening questions** —
  treated as its own mini-step sequence ahead of the form pages.

Both are in scope for *this* branch as recipient-renderer UI; the
save-and-resume persistence is the part that's deferred.

### Action

Amar to create a GitHub backlog item for save-and-resume / member-account
form drafts.

---

## B-030 · Editor canvas — true side-by-side rendering of half-width fields ✅ RESOLVED

**Surfaced:** 2026-05-14, during the form-editor redesign build.

### Current state

In the builder canvas (`FieldCanvas.tsx`), half-width fields render as a plain
vertical list with a `½ width` badge — they do **not** sit side by side. True
two-column layout only renders in the recipient view (`PublicFormView.tsx`)
and the Preview dialog. This was a deliberate scope decision: drag-and-drop
(`@hello-pangea/dnd`) with a wrapping/2-column droppable is fiddly and was too
risky to ship without a browser test pass.

### What we want

The editor canvas should render two consecutive half-width fields side by side,
website-builder style, so the author sees the real layout while building — not
just a badge.

### Fix shape

- Either: a flex-wrap / 2-column droppable that `@hello-pangea/dnd` can still
  drag-reorder correctly (needs care — measure positions, handle the wrap).
- Or: keep the vertical Droppable but visually pair adjacent half cards into a
  grid row via a wrapper, verifying dnd still measures/reorders correctly.

Needs a real browser test pass for the drag behavior either way.

### Resolved

2026-05-14 (commit `b8ece3d9`). The `FieldCanvas` droppable is now a
`flex flex-wrap` container; half-width fields get `w-[calc(50%-0.25rem)]` so
two consecutive halves sit side-by-side. Drag-reorder still runs off the flat
index list. The `½ width` badge was removed (now visually obvious). Confirm
the wrap / drag behaviour in a browser.

---

## B-031 · Form editor UI needs a broader visual redesign pass ✅ RESOLVED

**Surfaced:** 2026-05-14, Amar's review of the form-editor redesign.

### Current state

This redesign restructured the editor's information architecture (form-
structure gate, page manager, pre-screening manager, single save bar, etc.)
and brought it onto the brand palette, but it stopped short of a full visual
redesign. Amar's read: "the edit form still needs to be redone in general."
The half-width-not-shown-as-half-width issue (B-030) is one concrete symptom;
the broader point is the authoring surface as a whole still feels rough.

### What we want

A dedicated visual/UX pass over the whole form editor — `PublicFormBuilder`
and its sub-components (`FieldPalette`, `FieldCanvas`, `FieldInspector`,
`PageManager`, `PreScreeningManager`) plus `TenantSharingFormEditorPage` —
treating layout, spacing, density, and the build flow as a cohesive design,
not an incremental restructure.

### Resolved

2026-05-14. The page-level redesign shipped as the tabbed editor (commit
`7ab6c98e`, design `ui-redesign-design.md`): sticky header with inline title +
status pills, Setup / Build form / Advanced tabs, internal-tool controls
removed or demoted. Follow-up polish from Amar's review — header-card
compaction and pre-screening de-nesting — landed in `0144c564` / `890fc949`.
The remaining builder-internals work (the field palette is a long vertical
list; the canvas / inspector lower half wants reordering by importance) spun
out to **B-033**.

---

## B-032 · "Discard" action for a just-created form (quality-of-life) ✅ RESOLVED

**Surfaced:** 2026-05-14, Amar's review.

### The ask

"+ New form" immediately creates a draft template and drops the user in the
editor (B-027). If they clicked it by accident, the only way out is to leave
and then Delete the stray draft from the forms list. There should be a
**Discard** button next to Save in the editor that deletes the draft and
returns to the forms list.

### Constraint

Discard should appear **only the first time** the user lands on a freshly
created form — i.e. when they just clicked "+ New form". It must **not** show
when editing an existing form (discarding a real form there would be
destructive and confusing — that's what Delete is for).

### Fix shape

- The forms list already navigates to `${routeBase}/template/:id` right after
  create. Pass a transient signal that this is a fresh draft — e.g.
  `navigate(..., { state: { justCreated: true } })` or a `?new=1` query param
  that the editor consumes once.
- `TenantSharingFormEditorPage` reads that signal on mount and, when set,
  renders a "Discard" button in the sticky save bar. Discard → confirm →
  `DELETE /templates/:id` → navigate back to the forms list.
- Clear the signal after first read so a refresh / later visit doesn't keep
  showing Discard. Belt-and-suspenders: also gate on the form still being an
  untouched single-version draft (`PublishedVersion == null` and no edits
  made this session).

### Resolved

2026-05-15. Forms list passes `state: { justCreated: true }` when it
navigates to the editor right after a "+ New form" create; the editor
consumes the signal once (clears it from history so a refresh doesn't keep
showing Discard) and renders a "Discard draft" button next to Save in the
sticky header. Discard fires the same `DELETE /templates/:id` as the
danger-zone Delete, with a confirm. The flag flips off on the first
successful save, so Discard is strictly a fresh-create-only bail-out;
permanent removal stays in the Advanced tab's Delete. Auto-create on
"+ New form" remains — that's the crash safety net.

---

## B-033 · Build-tab builder lower half — palette / canvas / inspector redesign ✅ RESOLVED

**Surfaced:** 2026-05-14, Amar's review after the tabbed-editor redesign.

### Current state

The Build tab's lower half is the original three-column grid: a **field
palette** (2 cols), the **canvas** (7 cols), and the **field inspector**
(3 cols). Specific friction Amar called out:

- The **field palette** is a tall vertical list of field types — it scrolls
  long when it doesn't need to. Could be wider / multi-column / more compact.
- The inspector's **"Page" dropdown** is confusing on a single-page form:
  you open it and only "Page 1" is there. There's no add-page affordance in
  context — adding a page means going to the Page manager card above.
- More broadly: the lower-half builder could be reorganized so more is on
  screen at once and it's easier to navigate — ordered by how often each
  part is actually used.

### What we want

A design pass over the builder's lower half (`FieldPalette`, `FieldCanvas`,
`FieldInspector`, and how the `PageManager` relates to them): compact the
palette, make the page controls make sense in the single-page case (e.g. an
inline "add page" affordance, or hide the page selector entirely until there
is more than one page), and order the surface by importance / frequency of
use.

### Resolved

2026-05-14. Brainstormed and shipped per `builder-lower-half-redesign-design.md`:
one builder card with page tabs on top, a compact 2-column icon-tile palette
(left), the canvas as the dominant center surface, and a slide-in inspector
that appears only on selection. The single-page "Page" dropdown confusion is
gone — there's no page UI at all on single-page forms, and the inspector's
"Move to page" control is gated on `multiPage && pages.length > 1`. Touched
`FieldPalette`, `PageManager`, `FieldInspector`, `PublicFormBuilder`. Needs a
browser pass to confirm the page-tabs popover, the slide-in transition, and
drag-reorder inside the new layout.

# Builder Lower-Half Redesign — design & plan

Design and implementation plan for the **B-033** redesign: the lower half of
the Build-form tab — the field palette, canvas, inspector, and page
navigation.

- **Branch:** `fix/back-office/form-editor`
- **Date:** 2026-05-14
- **Companion docs:** `ui-redesign-design.md` (the tabbed editor this builds
  inside), `blockers.md` (B-033), `implementation-log.md`

---

## 1. Goal

After the tabbed-editor redesign the Build tab's lower half is still the
original three-column grid: a tall vertical **palette** of 16 field types, the
**canvas**, and an **inspector** that occupies a fixed column even when nothing
is selected — with the **Page manager** in a separate card above. It's not
laid out by how each part is actually used.

Rework it into one cohesive builder surface: compact the palette, put page
navigation where you build, make the inspector contextual, and order the
surface by importance. No change to form capability or the definition schema.

---

## 2. The redesign

### 2.1 One builder card

The palette, canvas, and inspector stop being three separate bordered boxes.
They become **zones inside a single card**, separated by light dividers —
fewer boxes, a calmer surface (same direction as the pre-screening
de-nesting).

### 2.2 Page tabs (multi-page forms only)

The separate "Page manager" card is removed. A **horizontal tab strip sits at
the top of the builder card**:

- One tab per page — page title + field count; the active tab highlighted.
- An inline **"+ Add page"** at the end of the strip.
- The active tab carries a small gear / ⋯ control that opens a **popover** for
  that page's settings: title, description, "hidden by default", move
  left / right, delete.
- On **single-page forms there is no page UI at all** — which also removes the
  confusing one-item "Page" dropdown the old inspector showed.

`PageManager.tsx` is reworked from a rail + settings panel into this tab strip
+ popover. Its props (`pages`, `activePageId`, `fieldCountByPage`,
`onSelectPage`, `onAddPage`, `onUpdatePage`, `onRemovePage`, `onMovePage`) are
unchanged — only the rendering changes.

### 2.3 Compact tile-grid palette (left zone)

`FieldPalette` becomes a **2-column grid of small icon + label tiles** instead
of 16 stacked full-width buttons. The four group labels (Basic / Content /
Choices / Legal & files) stay as tight headers. Each field type gets a Lucide
icon. It sits in a narrow left zone — far shorter, still one click away.

### 2.4 Canvas (center — the primary surface)

Largely unchanged: it already renders the flex-wrap half-width layout. It just
**gets more room** — full width of the canvas + inspector area whenever
nothing is selected. Clicking an already-selected field **deselects** it.

### 2.5 Slide-in inspector (right zone — on demand)

`FieldInspector` is no longer a permanent column. When a field is selected, a
right panel **slides in** (a width transition); when the field is deselected —
via an **✕ on the panel** or by clicking the field again — it collapses and
the canvas reclaims the width. The old "select a field…" empty state is gone
(the panel simply isn't rendered).

Mechanism: the inspector column is always in the DOM but transitions between a
collapsed (`w-0 overflow-hidden`) and expanded width; `FieldInspector` renders
`null` when no field is passed. This keeps the slide reliable without
mount-animation trickery.

**Single-page dropdown fix:** the inspector's "Page" control is renamed
**"Move to page"** and only renders when `multiPage && pages.length > 1` — it
never shows a pointless one-item dropdown again.

### 2.6 Importance ordering

The surface reads in order of how it's used: **page tabs** on top
(navigation) → **compact palette** on the left (frequent, quick) → **canvas
dominant in the center** (the actual work) → **inspector on the right, only
when needed** (contextual editing).

The Build tab's outer card order — Form header & intro, Pre-screening, then
the builder surface — is unchanged; it mirrors the public form's flow.

---

## 3. Files touched

- `PublicFormBuilder.tsx` — restructure the builder surface into one card:
  page-tabs strip on top, then a flex row of palette zone / canvas zone /
  slide-in inspector zone. Wire deselect-on-reclick and the inspector close.
- `FieldPalette.tsx` — 2-column icon-tile grid, grouped; add Lucide icons per
  field type.
- `PageManager.tsx` — reworked into the tab strip + settings popover + inline
  "+ Add page".
- `FieldInspector.tsx` — render `null` when no field; add an `onClose` prop
  and an ✕; rename the page control to "Move to page" and gate it on
  `multiPage && pages.length > 1`.
- `FieldCanvas.tsx` — minor: support deselect-on-reclick (parent passes a
  toggling `onSelect`).

No `useFormDefinition` changes (it already exposes `selectedName` /
`setSelectedName` and every page mutator). No backend changes.

---

## 4. Implementation sequence

1. `FieldPalette` — tile grid + per-type icons.
2. `FieldInspector` — `null` empty state, `onClose` / ✕, gated "Move to page".
3. `PageManager` → tab strip + settings popover + inline add.
4. `PublicFormBuilder` — assemble the one-card builder surface: page tabs,
   palette zone, canvas zone, slide-in inspector; deselect-on-reclick.
5. Type-check and lint (`tsc --noEmit`, `eslint`) in the container.

Stays within the app's existing Tailwind / `oe-primary` design system, Lucide
icons only — consistent with the rest of the editor.

---

## 5. Out of scope

- No change to form capability, the definition schema, the recipient
  renderer, or the backend.
- The Build tab's other cards (Form header & intro, Pre-screening manager) and
  the Setup / Advanced tabs are not touched.
- Drag-a-field-onto-a-page-tab is not in scope — moving a field across pages
  stays the inspector's "Move to page" control.

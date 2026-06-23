# Form Editor UI Redesign — design & plan

Design and implementation plan for the visual / information-architecture
redesign of the create-new-form and edit-form flow. This is the execution of
**B-031** (logged in `blockers.md`), and it supersedes **B-030** (editor
side-by-side rendering — folded in here).

- **Branch:** `fix/back-office/form-editor`
- **Date:** 2026-05-14
- **Companion docs:** `design.md` (the capability redesign this builds on),
  `blockers.md`, `implementation-log.md`

---

## 1. Goal

The edit-form screen currently reads like an internal tool: two stacked
"forms" (a Settings card and a Form-definition card), each with nested
settings, raw-JSON and schema-version inputs on display, delivery options
buried in a collapsed disclosure, and long explainer paragraphs. The care
team shouldn't have to decode it.

Redesign it into one cohesive, **tabbed** editor where the decisions that
shape the form come first, the build surface is the focus, and rarely-touched
configuration is tucked away — without inventing a new visual language
(it should still look like the rest of the app).

No change to what the form *can do* — this is layout, grouping, and
information architecture only. Every existing capability is preserved; some
controls move, a few internal-only ones are removed from the UI.

---

## 2. Current inventory (what exists today)

| Group | Controls |
|---|---|
| Identity & status | form title; "Active" toggle; status (draft/published, version numbers) |
| Delivery | Anonymous link / Send to member / Authenticated; "Auto-create share request on submit" |
| Routing & notifications | Default vendor (+ 4-line explainer); Notify email addresses |
| Embedding | Allowed embed sites (radio + textarea) |
| The builder | form-structure toggles (multi-page, pre-screening); form header image + rich-HTML header; pre-screening manager; page manager; field palette / canvas / inspector; form heading + introduction text |
| Output | Submission PDF (toggle + letterhead text) |
| Power-user / internal | version history; Raw JSON editor; Schema version (raw number input); change note |
| Actions | Preview form; Preview PDF; Save; Delete |

---

## 3. The redesign

### 3.1 Persistent header bar (above the tabs, always visible)

- **Back** link.
- **Form title** — inline-editable, large; the page's focal point and the
  form's identity.
- **Status pills** — `Draft` / `Published` and `Active` / `Inactive`.
  Display-only; they reflect state set elsewhere.
- **Preview** button — opens the form preview dialog.
- **Save** button — the single save; persists everything regardless of the
  active tab.
- In read-only mode (vendor agents) Save is hidden and the title is not
  editable.

### 3.2 Advisory banner strip (under the header, shown on every tab)

Carries cross-cutting notices so they're never hidden behind a tab:

- The **B-018** warning (anonymous form with no identity fields).
- The **inactive-but-published** notice.
- The read-only-view notice for vendor agents.

### 3.3 Tab 1 — "Setup" (opens here; the decide-first controls)

- **Form structure** — Multi-page toggle, Pre-screening toggle. These shape
  the entire Build tab, so they come first.
- **Delivery** — Anonymous link / Send to member / Authenticated, surfaced in
  plain view (today they're inside a collapsed `<details>`). This is core to
  how the form is used and shouldn't be buried.
- **Auto-create share request on submit.**
- **Active** toggle — the control; the header's Active pill reflects it.

### 3.4 Tab 2 — "Build form" (the construction surface)

- The field palette / canvas / inspector, page manager, and pre-screening
  manager — today's builder body.
- **Header & intro** — header image, rich-HTML header, form heading, and
  introduction text — grouped into a collapsible sub-section so the
  recipient-facing presentation copy doesn't crowd the actual fields.
- The builder reads `def.multiPage` / `def.preScreeningEnabled` to decide
  what to render; the toggles themselves live in Setup (see §5).

### 3.5 Tab 3 — "Advanced" (rarely touched)

- **Default vendor** — explainer trimmed to one line, with a help/info icon
  for the detail.
- **Notify email addresses.**
- **Allowed embed sites.**
- **Submission PDF** — enable toggle + letterhead text + the "Preview PDF"
  button alongside it.
- **Version history** table + the change-note field.
- **Raw JSON editor** — inside its own collapsible, the deepest escape hatch.
- **Danger zone** — Delete form, at the very bottom, visually set apart.

### 3.6 Removed / changed

- **Schema version** input — removed from the UI entirely. `def.version`
  stays in the definition, auto-defaulted; care team never needs to see it.
- The two stacked cards ("Settings" + "Form definition") collapse into the
  single tabbed page — the "merge" the redesign is built around.
- Long explainer paragraphs → one line + a help icon.
- Raw JSON and Version history move from always-visible disclosures on the
  main surface into the Advanced tab.

---

## 4. Behaviors

- **Save** validates everything (settings + definition). On a validation
  error in a tab that isn't active, Save switches to that tab and surfaces
  the message, so the problem is never invisible. Publish-redirect and the
  fixed success/error toast from the prior work are kept.
- **Read-only mode** (vendor agents) — all three tabs stay navigable; Save,
  Delete, and the Discard affordance are hidden; inputs are disabled.
- **B-032** ("Discard" for a just-created form) is a natural fit for the new
  header bar — implement it here if low-cost: a Discard button next to Save,
  shown only on first landing after "+ New form". If it adds risk, it stays
  in `blockers.md` for a follow-up.

---

## 5. Implementation notes

### 5.1 The one real refactor — shared definition state

The form-structure toggles move to the Setup tab, but the builder (Build tab)
still has to react to them. Today `PublicFormBuilder` owns the parsed `def`
state and the toggle handlers (including the toggle-off confirm dialogs and
the page-creation logic).

Lift that into a shared `useFormDefinition(initialJson)` hook that returns
`{ def, ...mutators }` — the mutators being the existing handlers
(`toggleMultiPage`, `togglePreScreening`, page add/update/remove/move,
field add/update/remove/reorder, pre-screening edits, etc.). The editor page
owns the hook; it passes `def` + the relevant mutators to the Setup tab (for
the structure toggles) and to a now-controlled `PublicFormBuilder` (for the
Build tab). `PublicFormBuilder` changes from `initialJson` + `onChange(json)`
to controlled `def` + mutators in; it loses the form-structure panel,
Submission PDF block, and Schema version input.

This is the only structural change; everything else is regrouping controls
that already exist.

### 5.2 Files

- `frontend/src/pages/tenant-admin/TenantSharingFormEditorPage.tsx` —
  rebuilt as the tabbed shell: header bar, advisory banner, tab nav, and the
  three tab panels. Distributes the existing settings controls per §3.
- `frontend/src/components/tenant-admin/public-form-builder/PublicFormBuilder.tsx`
  — becomes the Build-tab body; form-structure toggles, Submission PDF, and
  Schema version removed from it.
- New: `useFormDefinition` hook (location: alongside the builder, e.g.
  `frontend/src/components/tenant-admin/public-form-builder/useFormDefinition.ts`).
- New (optional, for clarity): small tab-panel components for Setup / Build /
  Advanced, and a `FormEditorHeader` — extract where it keeps files focused.
- Sub-components (`PageManager`, `PreScreeningManager`, `FieldCanvas`,
  `FieldInspector`, `FieldPalette`) are reused as-is.

### 5.3 Visual language

Match the established app conventions — `bg-white rounded-lg` cards,
`oe-primary` / `oe-dark` for primary actions, the input and section styling
used by the forms list and the members pages, Lucide icons, Tailwind only.
The frontend-design skill guides the polish pass, kept within those
conventions (no new design system).

### 5.4 Sequence

1. `useFormDefinition` hook — lift `def` state + all mutators out of
   `PublicFormBuilder`.
2. Refactor `PublicFormBuilder` to controlled (`def` + mutators); strip the
   form-structure panel, Submission PDF, Schema version.
3. Rebuild `TenantSharingFormEditorPage`: header bar + advisory banner + tab
   nav + the three tab panels; distribute controls per §3.
4. Save → validate-all + switch-to-offending-tab.
5. Polish pass to the app's visual conventions.
6. Type-check and lint (`tsc --noEmit`, `eslint`) in the container.

---

## 6. Out of scope

- No change to form capability, the definition schema, or any backend.
- No change to the recipient-facing `PublicFormView`.
- The forms-list page (`TenantSharingFormsPage`) is not touched.

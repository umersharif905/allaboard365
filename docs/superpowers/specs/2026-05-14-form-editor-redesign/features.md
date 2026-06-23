# Form editor redesign — feature inventory

High-level scope for the `fix/back-office/form-editor` branch. This is a
**draft seed** captured before the brainstorming/design pass — it will be
restructured and detailed once the design doc is written and approved.

Surface in scope: the screen shown when a care-team user clicks **New form**
or **Edit** on an existing form template
(`frontend/src/pages/tenant-admin/TenantSharingFormEditorPage.tsx` +
`frontend/src/components/tenant-admin/public-form-builder/PublicFormBuilder.tsx`).

---

## F1 · Editor layout / UX overhaul

The current drag-and-drop editor is crude and hard to parse. Clean up the
layout and information hierarchy so the care team can understand what the
editor does and build a form without friction.

## F2 · Two-column field rows

Today fields can only stack vertically. Add the ability to place two fields
side by side in a row (e.g. First name / Last name), with the option to keep
a field full-width. Website-builder style — whatever is most intuitive for
the care-team author.

## F3 · Pre-screening A/B questions + conditional form sections

For long, intimidating forms (esp. the share-request intake form — "unshared
amount sharing request"), add a pre-screening step: a small set of A/B
(yes/no style) questions shown before the form fields. The answers tailor
which fields/questions the recipient then sees, and can change requirements
(e.g. number of files to upload). Goal: keep the form short by only asking
what a given member's situation actually needs.

Working model under discussion: a **base form** (always shown) plus
pre-screening answers that **add or remove** field/question groups — rather
than authoring N separate full forms for every answer combination. Strategy
to be finalized in the design pass.

## F4 · Paging system for long forms

Related to F3 — break long forms (the SR intake form especially) into
multiple pages/steps instead of one endless scroll.

---

_Inherited cleanup items (Kind retirement, save consolidation, save
confirmation/redirect, E.1 anonymous-form warning) are tracked in
`blockers.md` and will be folded into the relevant feature above._

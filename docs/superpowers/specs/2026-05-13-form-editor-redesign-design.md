# Form editor redesign — design

**Date:** 2026-05-13
**Status:** draft — captures user-confirmed vision from the forms-redesign brainstorm. Not yet ready for implementation; depends on Phases 0–4 of the forms redesign landing first.
**Related:** `2026-05-13-forms-redesign/design.md` (Phases 0–4). Items marked there as "Out of scope (future work)" are formalized in this spec.

## Summary

Replace today's flat-fields form template with a **screener-driven branching** model. The recipient answers a small number of A/B pre-form questions; their answers route them to the correct downstream field set. The intake form for ShareRequests consolidates into one template with branching, replacing today's separate `UnsharedAmount` + `PreventiveCare` templates. Editor UI gains a visual screener-tree builder and per-field autofill-source indicators. `AdditionalDocuments` template gets fully retired (its job is now done by Phase 2/4 per-send linkage).

Goal: reduce recipient friction, eliminate fields that don't apply, give care team a clean authoring tool, and remove the legacy `FormKind` magic-slug routing that today the system relies on.

## Why this matters (problems carried forward)

From `2026-05-13-forms-redesign/current-system-problems.md`:

- **#2 — Hard-coded form taxonomy.** Three special `FormKind` slugs (`UnsharedAmount`, `PreventiveCare`, `AdditionalDocuments`) bake intake purpose into the data model. Adding a new intake type today requires code changes.
- **#5 — `AdditionalDocuments` verification flow is clunky and weakly secured.** Recipient enters SR number + lastname + DOB. Replaced in Phase 2 by per-send linkage; legacy template now redundant.

New problems specific to this phase:

- **Two intake templates exist where the user wants one.** `UnsharedAmount` covers Medical / Maternity / MedicalProcedure / Emergency via a `sharingRequestType` dropdown; `PreventiveCare` is a separate template for Wellness. Same conceptual purpose ("file a sharing request") split across two scaffolds.
- **No conditional fields.** Today's form schema is a flat `fields` array with `required` boolean. The renderer can't show/hide fields based on other answers. The editor has no UI for conditions. Result: forms either ask for everything (including things that don't apply) or live as separate templates.
- **Form authoring is field-list editing only.** There's a drag-and-drop builder but no concept of branching, no preview of recipient flow, no awareness of which fields can autofill from the authenticated member's profile.

## The screener-driven branching model

The recipient experience the user described is the TurboTax / FreeTaxUSA pattern: screening questions narrow the form before the recipient sees any irrelevant fields.

### Recipient flow

1. **Screener steps** render first. Each step is a single question with 2–4 button choices ("Maternity / Medical / Wellness / Other"). The recipient never types into a screener; clicking the button advances to the next step or to a leaf.
2. **Each leaf** of the screener tree resolves to a **field set** — a flat fields array of the kind today's templates use.
3. **The recipient fills the field set** and submits as today.

### Authoring vision

The care team designs:

1. A **screener tree** — questions and branches. Each leaf points to a field set.
2. One or more **field sets** — reusable across leaves where appropriate (e.g., a "common contact info" set used by multiple leaves).
3. **Outcome mappings** — for the consolidated SR intake template, each leaf also maps to a `ShareRequest.RequestType` (Medical / Maternity / Wellness / etc.). For non-SR forms (custom/supportive forms), no outcome mapping needed.

### Schema implications

Template definition (`PublicFormTemplateVersions.DefinitionJson`) grows from today's `{ version, title, introHtml, fields }` shape to:

```jsonc
{
  "version": 2,
  "title": "...",
  "introHtml": "...",
  "screener": {
    "steps": [
      {
        "id": "step-1",
        "question": "What type of claim are you making?",
        "choices": [
          { "label": "Medical", "next": "step-2" },
          { "label": "Maternity", "next": "fieldset:maternity" },
          { "label": "Wellness", "next": "fieldset:wellness" }
        ]
      },
      // ...
    ],
    "entryStepId": "step-1"
  },
  "fieldSets": {
    "fieldset:medical-standard": { "fields": [...] },
    "fieldset:maternity": { "fields": [...] },
    "fieldset:wellness": { "fields": [...] }
  },
  "outcomeMappings": {
    "fieldset:medical-standard": { "shareRequestType": "Medical" },
    "fieldset:maternity": { "shareRequestType": "Maternity" },
    "fieldset:wellness": { "shareRequestType": "Wellness" }
  }
}
```

Backward compatibility: existing v1 templates (no `screener`, just `fields`) keep working. The renderer treats v1 as a single implicit field set with no screener. New templates default to v2.

### SR type derivation

For the consolidated SR intake template, the screener answers determine `ShareRequest.RequestType` via `outcomeMappings`. This **eliminates the dual `FormKind` + `payload.sharingRequestType` redundancy** that today's `UnsharedAmount` template has. The submission payload no longer needs a `sharingRequestType` field — the system reads the matched leaf's outcome mapping instead.

## Consolidation of `UnsharedAmount` + `PreventiveCare`

After the editor + renderer support screeners + outcome mappings:

1. **Author** a new single template "Share Request Intake" with:
   - A screener: "What type of claim?" → Medical / Maternity / MedicalProcedure / Emergency / Wellness
   - One field set per leaf (Maternity has its own fields; Wellness has its own; Medical+Procedure+Emergency might share or branch further)
   - Outcome mappings to the appropriate `ShareRequest.RequestType`
2. **Set** `CreatesShareRequestOnSubmit = 1` on the new template.
3. **Deprecate** the two legacy templates: set `IsActive = 0`. Existing submissions remain queryable; no new submissions land against them.
4. **Update** anything that hard-codes `FormKind IN ('UnsharedAmount', 'PreventiveCare')` to also handle the consolidated template.

Phase 2 already did the **cosmetic** consolidation in the care team UI (presenting UA + PC under one "Share Request Intake" section). This phase makes that real.

## `AdditionalDocuments` retirement

Phase 2 introduced **per-send linkage**: the care team chooses to attach a sent form's submission to an open SR (or Case) at send-time. That replaces what `AdditionalDocuments` did clumsily (recipient enters SR number + lastname + DOB).

In this phase:

1. Set `IsActive = 0` on all `AdditionalDocuments` template rows.
2. Keep the verification helper code in `publicFormShareLinkService.js` for historical submissions only — no new flows wire through it.
3. After a deprecation window (TBD with stakeholders), remove the helper code entirely.

## `FormKind` cleanup

After consolidation + retirement, `FormKind` is no longer load-bearing. Today's hardcoded slugs (`UnsharedAmount` / `PreventiveCare` / `AdditionalDocuments`) have specific behavior wired to them in the share-link service and the form-defaults service. Phase 2 already replaced the auto-SR-creation dispatch with a `CreatesShareRequestOnSubmit` template flag; this phase removes the remaining `FormKind`-keyed dispatches.

Options to explore (decision left to implementation):

- **Drop the column** once nothing reads it.
- **Repurpose** it as a free-form category label (no special-case behavior).
- **Keep it** as a system-generated slug (`K_{uuid}`) for legacy compatibility but stop reading it for routing.

The UNIQUE constraint `UQ_PublicFormTemplates_Tenant_Kind` may need to be relaxed depending on the chosen direction.

## Editor UI changes

The existing `TenantSharingFormEditorPage` + `PublicFormBuilder` gain:

- **Screener tree view.** Visual tree showing screener steps as nodes, branches as edges, field sets as leaf nodes. Add/remove/reorder steps. Edit choice labels inline.
- **Field set library.** Reusable field sets shown in a sidebar. Drag-drop fields into a field set just like today. A field set can be referenced by multiple leaves.
- **Outcome-mapping editor.** Per-leaf: optional `shareRequestType` mapping. Only relevant when `CreatesShareRequestOnSubmit = 1`.
- **Autofill-source badge.** Each field's name input has a check: if the name matches a well-known profile field (`firstName`, `lastName`, `email`, `phone`, `memberId`, `dateOfBirth`, address fields), show a "🔁 Member profile autofill available" badge. Phase 3 already plumbs the backend mapping (`publicFormInvitationPrefillService`); this surfaces it in the editor for awareness.
- **Recipient-flow preview.** "Preview" already exists; extend it to run through the screener interactively so the author can verify branching.

Out of scope for this phase: drag-drop reordering of screener nodes (text-based reorder is fine), undo/redo, version-history diffing.

## Schema changes (DDL)

Probably minimal. `DefinitionJson` is `NVARCHAR(MAX)` already, so the v2 schema fits without column changes. Possible additions:

- An optional `DefinitionVersion TINYINT` on `oe.PublicFormTemplateVersions` to mark v1 vs v2 templates without parsing JSON. Default 1; v2 sets to 2.
- An audit column tracking when a template was migrated from v1 to v2 if/when that's offered.

No new tables.

## Migration considerations

- Existing v1 templates render unchanged via the renderer's v1-compat path.
- Tenant admins can opt-in upgrade a v1 template to v2 by adding a screener. Without a screener, the template stays in v1-compat mode (renderer sees `screener: undefined` and renders fields directly).
- The consolidated "Share Request Intake" template is created NEW per tenant. Existing UA + PC submissions stay attached to their original templates.
- Submission payloads continue to be encrypted JSON; the leaf-matched field set's filled values are the payload. The submission record gains a `MatchedFieldSetId` column to record which leaf the recipient landed on (audit + analytics).

## Out of scope for this phase (still later)

- **Cases intake form** — only the care team will be able to create Cases; not customer-fillable. Their own form template arrives with the Cases feature.
- **Multi-language / i18n** for screener questions.
- **A/B testing** of screener wordings.
- **Conditional fields _within_ a field set** (e.g., "show `otherInsuranceName` only if `hasOtherInsurance = yes`"). This phase adds branching at the screener level; intra-field-set conditionals are a further enhancement.
- **Multi-step field sets** (wizard-style page-by-page within a field set).

## Dependencies

- Phases 0–4 of `2026-05-13-forms-redesign/design.md` must land first. Specifically:
  - The `CreatesShareRequestOnSubmit` flag replaces today's `FormKind`-keyed auto-SR dispatch (Phase 1 / spec Section 5).
  - Per-send linkage (Phase 2 / spec Section 6) replaces `AdditionalDocuments`.
  - Authenticated-mode prefill (Phase 3 / spec Section 4) wires the autofill data the editor will surface as badges.

## Open items the user should weigh in on before implementation

These are NOT to be answered now — they're flagged here so they don't get lost when this spec is picked back up:

- Should screener choices be limited to 2 buttons (true A/B)? The user described it as "two boxes on their screen" — this spec allows 2–4 to be flexible, but the user may want a strict 2-only constraint.
- Whether the consolidated SR intake template replaces UA + PC by deactivating them, or by hard-deleting + reseeding (riskier).
- Whether existing custom-kind v1 templates should be offered an automated upgrade-to-v2 path or stay v1 forever.
- Whether `FormKind` should be dropped, repurposed, or kept as legacy. Pick a direction with the DBA and the team.

## Notes on origin

This spec captures only design decisions the user explicitly stated or confirmed in the 2026-05-13 forms-redesign brainstorm. No new design decisions were added. Specifically, the user said:

- "My vision with the editor was to be able to make pre-form questions that determine what form questions are presented. So like the pre-form questions for this consolidated form would be what type of claim are you making? Is it a maternity claim? Is it a preventative? Is it medical? Is it wellness?"
- "And then based on the answers for this, which would be kind of like A B questions… literally two boxes on their screen."
- "Maybe you can think of like free tax USA or like turbotax where they ask you screening questions… Similar to that."
- "Also based on those questions, it determines the type of share request it is."
- "It seems like these categories in general might just be able to be scrapped for a better redesign and to create a better foundation for these forms."
- "The main form is going to be the sharing request form."

All other content in this spec is mechanical extension of those statements into a concrete data model, schema, and UI plan.

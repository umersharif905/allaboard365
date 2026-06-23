# Combining Preventative + SR Forms — Blockers & Open Questions

Branch: `fix/backoffice/combining-preventative-and-SR-forms` (off `staging`, 2026-05-28)

Living list of unresolved items. Tick off (or move to the notes doc) as we close them.

## Decided — no longer blockers

- **Scope:** only Claude's Form (Copy) `c0001a15-26b8-4cd7-8b41-46f1a44b05e5` is touched in this branch; the per-vendor preventative forms (`ARM`, `TallTree`) are deferred. The supporting backend/builder features (conditional pre-screen, auto-create-Case) DO ship globally so other forms can adopt them later.
- **A/B pre-screen style:** Tile pair — "Routine or preventative care" vs "Surgery, ER, or major event" (TurboTax-style).
- **Preventative branch field set:** member name, member ID, date of service, `provider_search` (mode: both), reimbursement-type radio (Copay vs Preventative service), brief reason, required proof-of-service file upload, HIPAA terms + signature. *No* amount field.
- **Preventative-vs-OON-Copay semantics:** ask the member on the form (single radio) — code carries the codes but no embedded definition. Routes the case subcategory to `preventative` or `oon_copay`.

## Open

### 1. Vendor-program rollout (deferred)

The two existing OON preventative forms are vendor-program variants:

| FormTemplateId | Title | KindLabel |
|---|---|---|
| `1680CB61-…` | Out-of-Network Bill (Copay or Preventative) Submission (TallTree) | `BillSubmissionTallTree` |
| `EACE9CE8-…` | Out-of-Network Copay/Preventative Bill (ARM) | `PreventativeGeneral` |

When the combined form ships, each vendor likely wants its own copy with its branding/intro copy. *Not in this branch.* Open: how are vendor copies cloned today? Is there a "duplicate template across tenants" affordance, or is this a manual SQL clone?

### 2. URL preservation for legacy member-document links (deferred)

Today every form lives at `/forms/:formTemplateId` (UUID). Member documents in the wild point to the OON form UUIDs above. Once the combined form replaces them, those UUIDs need to keep resolving. Options:

- **a.** Keep the OON form templates alive but stub them as 301-style redirects to the combined form UUID.
- **b.** Replace the OON forms in-place — update their DefinitionJson to be the combined form (or a thin "this moved" page).
- **c.** Leave both for now, document the dual-URL behavior in a vendor-comms note, and migrate later.

Leaning (a) per Amar's instinct, but defer until the combined form is shipped on at least one vendor.

### 3. Reimbursement Case type code

Working assumption: type `reimbursement` (from `frontend/src/constants/caseTaxonomy.ts`). Verify against the vendor-scoped `oe.CaseTypes` rows for the tenant we'll smoke-test on — taxonomy is vendor-scoped, so the exact stored code may vary. Block before turning auto-create-Case on for any real vendor.

### 4. ✅ Pre-screen → SR category wiring (resolved 2026-05-28)

Confirmed today's code did **not** read the existing "What brings you here?" prescreen when setting SR type. Wired up via the new optional `srTypeHint` on `PreScreenOption`; `resolveRequestTypeIdForPayload` now prefers the prescreen-derived hint over the formKind default. Claude's Form (Copy) v4 carries the hint values: Surgery → `Surgery`, ER → `ER`, Maternity → `Maternity`.

### 5. Conditional pre-screen — order semantics

`PreScreenEffect.targetType = 'preScreenQuestion'` will hide later questions, but the render layer needs an explicit ordering contract. Provisional decision: questions are evaluated in array order, and a hidden question's own effects are ignored. Verify this matches builder author expectations before locking it down (it's load-bearing for the A/B → "what brings you here?" hide).

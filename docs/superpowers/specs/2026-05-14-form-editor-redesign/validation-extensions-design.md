# Form Validation Extensions — design & plan

Three small, related additions to the form definition: a hard-stop on
specific pre-screening answers, a soft submit-time confirm for skipped
optional fields, and a minimum-character constraint on long-text fields.

- **Branch:** `fix/back-office/form-editor`
- **Date:** 2026-05-15

---

## 1. Goal

Configurable, per-form mechanisms for three care-team needs:

1. **Hard-stop** — certain pre-screening answers (e.g. "surgery within
   7–14 days") must immediately interrupt the form with a "call the care
   team" popup so the case is handled manually.
2. **Soft warning** — certain optional fields (e.g. ACH info) slow
   processing if skipped; the recipient should be confirmed-once at
   submit before going through.
3. **Minimum characters** — long-text fields (descriptions) often need
   more than a one-word answer; authors should be able to require a
   minimum length.

All three are author-configured per form, not hard-coded.

---

## 2. Schema additions (additive, backward-compatible)

```ts
// On a pre-screening option — selecting the option blocks the form.
type PreScreenBlock = {
  title?: string;   // optional popup title; defaults to "Please contact us"
  message: string;  // required body
};

// On a field — confirm before submit if left empty.
type SoftWarning = {
  message: string;  // shown in the submit-time confirm dialog
};

PreScreenOption.block?: PreScreenBlock
FieldDef.softWarnIfMissing?: SoftWarning
FieldDef.minLength?: number    // textarea + paragraph only
```

Parse normalizers preserve the new keys; legacy definitions unaffected.

---

## 3. Recipient enforcement (`PublicFormView`)

### 3.1 Hard-stop — immediate, on selection

When the recipient clicks (single-select) or toggles on (multi-select)
a pre-screening option that carries `block`:

- The option **is not selected**.
- A modal appears: `block.title || 'Please contact us'` + `block.message`
  + a single **Close** button.
- Closing returns the recipient to the same question with no answer
  applied; they can pick a different option.

State: `const [blockedOption, setBlockedOption] = useState<{ title?:
string; message: string } | null>(null);`. Modal renders when set.

### 3.2 Soft warning — single submit-time confirm

Inside `onSubmit`, after the existing required-field validation passes:

- Gather every visible field (`visibility.visibleFieldNames`) where
  `softWarnIfMissing` is set AND the stored value is empty.
- If any, show one `window.confirm`-style modal listing them with their
  messages: *"Skipping these will slow processing — [field label]:
  [message]. Submit anyway?"*
- Cancel → abort the submit (recipient stays on the form). Confirm →
  proceed with submission.

A built-in `window.confirm` is fine — it's already used elsewhere for
destructive confirms. Plain dialog, no new component needed.

### 3.3 Minimum characters — textarea + paragraph

Extend `firstValidationError`:

- For a field of type `textarea` or `paragraph` with a positive
  `minLength`, and a non-empty trimmed value with `value.trim().length <
  minLength`, return *"Please enter at least N characters in
  '{label}'."*
- Empty values are skipped (the required check handles emptiness on its
  own — combining `required: true` with `minLength` enforces both).

Runs on Next (current page) and Submit (all visible fields) — same
mechanism as today.

---

## 4. Editor controls

### 4.1 `FieldInspector`

- **Min characters** — number input next to the existing **Rows**
  control, shown **only for `textarea` and `paragraph`**. `0` / blank
  means no minimum.
- **Soft-warn if left empty** — checkbox available on all text-like
  fields. When checked, a message textarea appears inline (placeholder:
  *"e.g. ACH info isn't required, but skipping it slows processing."*).

### 4.2 `PreScreeningManager` → `AnswerCard`

- **Stop the form when this is chosen** — checkbox at the bottom of the
  card. When checked, an optional **Popup title** input and a required
  **Popup message** textarea appear (placeholder: *"e.g. Please call the
  care team — we need to handle this case manually."*).
- A non-blocking hint when the toggle is on but message is empty:
  "Add a message — the popup needs something to say."

---

## 5. Backend (defense in depth)

`publicFormSubmissionService.validatePayloadAgainstDefinition`:

- Add the **minLength** check — same rule as the frontend
  (textarea/paragraph, non-empty after trim, length ≥ minLength).
- The hard-stop and soft-warn are UX concerns; the backend ignores
  them. A user bypassing the JS still submits valid data — that's fine,
  the popup / confirm was advisory.

---

## 6. Files touched

- `frontend/src/types/publicFormDefinition.ts` — types + normalizers.
- `frontend/src/components/tenant-admin/public-form-builder/FieldInspector.tsx`
  — minLength + softWarnIfMissing controls.
- `frontend/src/components/tenant-admin/public-form-builder/PreScreeningManager.tsx`
  — block toggle + title/message on `AnswerCard`.
- `frontend/src/components/public/PublicFormView.tsx` — block modal,
  soft-warn confirm, minLength validation.
- `backend/services/publicFormSubmissionService.js` — minLength check.

No SQL, route, or schema-table changes.

---

## 7. Out of scope

- Per-field-on-blur and per-page-on-Next soft warnings (submit-time
  confirm only).
- `minLength` on single-line text fields, name, member_id, email, tel
  — long-text only.
- `maxLength` — not asked for.
- Backend enforcement of hard-stop / soft-warn (intentionally UX-only).

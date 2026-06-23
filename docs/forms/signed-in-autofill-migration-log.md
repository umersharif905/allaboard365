# Migration Log — Signed-in Form Autofill, Suggested Providers & Drafts

Tracks every SQL/data migration for the work specified in
[`docs/superpowers/specs/2026-05-29-signed-in-form-autofill-and-drafts-design.md`](../superpowers/specs/2026-05-29-signed-in-form-autofill-and-drafts-design.md).

**Purpose:** at PR time, the production migration must mirror exactly what was applied to `allaboard-testing`. Every executed migration is recorded here with date + effect.

**Policy:**
- SQL files live in `sql-changes/allaboard365/`.
- Each migration is authored and logged here **before** execution.
- Migrations run against **testing only**, with explicit per-migration confirmation. **Never run against production from here** — production runs at PR time.
- `allaboard-testing` is shared across devs — do not run migrations without explicit go-ahead.

## Status legend
- `PLANNED` — file written, not yet run anywhere
- `APPLIED-TESTING` — run against `allaboard-testing` (date noted)
- `APPLIED-PROD` — run against production (date noted, at/after PR)

---

## Migrations

| # | File | Phase | What it does | Status | Testing date | Prod date |
|---|------|-------|--------------|--------|--------------|-----------|
| 1 | `ai_scripts/migrations/2026-05-29-rename-aboutyou-keys.cjs` | A | Rename About-You field keys to canonical member-autofill keys on the two `[NEW]` published forms (`oe.PublicFormTemplateVersions.DefinitionJson`): `ay_dob→dateOfBirth`, `ay_addr_street→addressLine1`, `ay_addr_city→addressCity`, `ay_addr_state→addressState`, `ay_addr_zip→addressZip`, `field_mpe6t9kq14t1e73ol→relationToPrimary`, and (SR only) `req_ua_tier→uaTier`. Parse-based, idempotent, dry-run default; `--apply` writes, `--prod` targets prod. | **APPLIED-TESTING** | 2026-05-29 | — |
| 2 | `sql-changes/allaboard365/2026-05-29-public-form-drafts.sql` | C | Create `oe.PublicFormDrafts` (DraftId, TenantId, FormTemplateId, OwnerUserId, ForMemberId, HouseholdId, Payload Encrypted/Iv/AuthTag/KeyId, Created/UpdatedDate; unique index on Owner+Template+ForMember) **and** `oe.PublicFormDraftFiles` (DraftFileId, DraftId FK CASCADE, FieldName, OriginalFileName, ContentType, FileSizeBytes, BlobUrl, BlobPath, CreatedDate). Idempotent; additive only. | **APPLIED-TESTING** | 2026-05-29 | — |

**Prod note for #1:** the `[NEW]` forms are not in production yet. When they are promoted, the renamed definition carries the canonical keys, so no separate prod run is needed. If a form is promoted to prod *before* this rename, run the script with `--apply --prod`.

---

## Execution notes

> `2026-05-29` — ran migration #2 against `allaboard-testing` (via `ai_scripts/migrations/apply-sql.cjs … --apply`). Created `oe.PublicFormDrafts` + `oe.PublicFormDraftFiles`; verified all columns present. Additive DDL, no existing data touched.

> `2026-05-29` — ran migration #1 against `allaboard-testing` with Amar's explicit go-ahead. Dry-run previewed 13 renames across 2 forms (no collisions); applied 7 on `Share Request Form [NEW]` (v2) + 6 on `Out-of-Network Copay & Preventative Care Form [NEW]` (v1). Verified canonical keys present (dateOfBirth, addressLine1/City/State/Zip, relationToPrimary, uaTier) and re-run is a 0-change no-op (idempotent).

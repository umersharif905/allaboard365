# Rename `Cases` → `Support Tickets`

**Date:** 2026-05-19
**Branch:** `fix/backoffice/rename-cases-to-support-tickets` (cut from `origin/staging`)
**Scope:** Back-office only. Share Requests untouched.

## Why

The care team is split on what "Cases" means. To stop the confusion, the existing back-office **Cases** feature (added 2026-05-14, `sql-changes/2026-05-14-cases-tables.sql`) is renamed to **Support Tickets**. Share Requests stay completely separate with their existing workflow — they are not a kind of ticket.

While we're renaming, we're also adding a type/subcategory taxonomy to Support Tickets so the care team can classify a ticket on creation. The five ticket types are: `reimbursement`, `billing`, `encounter_escalation`, `complaint`, `appeals`.

## End state

### Data model

`oe.SupportTickets` (was `oe.Cases`) — the parent table. PK is `SupportTicketId` (was `CaseId`). Number column is `TicketNumber` (was `CaseNumber`).

Three new columns:

| Column | Type | Notes |
|---|---|---|
| `TicketType` | `NVARCHAR(50) NOT NULL` | CHECK in `('reimbursement', 'billing', 'encounter_escalation', 'complaint', 'appeals')`. Backfilled to `'reimbursement'` for existing rows. |
| `TicketSubcategory` | `NVARCHAR(50) NULL` | CHECK against the full subcategory universe (NULL allowed). Type↔subcategory pairing enforced in app, not DB. |
| `SubcategoryDetail` | `NVARCHAR(MAX) NULL` | Free-text from the care team — "rotator cuff repair", "denied claim 2025-04", etc. |

**Subcategory universe (CHECK accepts any of these or NULL):**

| TicketType | Allowed TicketSubcategory values |
|---|---|
| `reimbursement` | `oon_copay`, `preventative`, `other` |
| `billing` | `provider_invoice`, `negotiation`, `recovery`, `claims_cob` |
| `encounter_escalation` | `needs_follow_up`, `issue_raised`, `routed_to_team` |
| `complaint` | `service_quality`, `process_outcome`, `privacy` |
| `appeals` | `denied_share`, `denied_reimbursement`, `amount_dispute`, `second_level` |

### Status set (replaces the old Cases statuses)

New: `Open`, `In Progress`, `Waiting`, `Resolved`, `Closed`. Backfill on existing rows in the same migration:

| Old `Cases.Status` | New `SupportTickets.Status` |
|---|---|
| `New` | `Open` |
| `Claims` | `In Progress` |
| `Billing/Reimbursement` | `In Progress` |
| `Pending` | `Waiting` |
| `High Priority` | `In Progress` |
| `Closed` | `Closed` |

**Known fidelity loss:** "High Priority" folds into "In Progress" — no priority concept survives this rename. Add a separate `IsHighPriority BIT` column in a follow-up if the care team wants it back.

### Ticket numbers

New rows generate `TX-YYYY-NNNN` (was `CASE-YYYY-NNNN`). Existing rows keep their old `CASE-YYYY-NNNN` numbers — no backfill, no link breakage.

### Child tables renamed (1:1, no schema changes inside)

| Old | New |
|---|---|
| `oe.CaseNotes` | `oe.SupportTicketNotes` |
| `oe.CaseProviders` | `oe.SupportTicketProviders` |
| `oe.CaseDocuments` | `oe.SupportTicketDocuments` |

FK column `CaseId` → `SupportTicketId` on each.

### Outside FKs touched

- `oe.Encounters.CaseId` → `oe.Encounters.SupportTicketId` (FK renamed `FK_Encounters_Case` → `FK_Encounters_SupportTicket`).
- `oe.Encounters.ShareRequestId` — unchanged. Share Requests are not Support Tickets.

## Migration file

**Path:** `sql-changes/2026-05-19-rename-cases-to-support-tickets.sql`

Single file. Wrapped in `SET XACT_ABORT ON; BEGIN TRANSACTION ... COMMIT TRANSACTION` so any failure rolls everything back. Header block follows the project's existing pattern (see `2026-05-12-share-request-claim-columns.sql`): `WHAT / WHY / IDEMPOTENCY / ROLLBACK / APPLICATION DEPLOYMENT ORDER / TEST-DB NOTES / PROD READINESS`.

Every step guarded with `IF EXISTS` / `IF NOT EXISTS` — re-running is a no-op.

**Ordered steps:**

1. **Drop the outside FK** that depends on `oe.Cases`: `FK_Encounters_Case` on `oe.Encounters`. (Re-added at step 7 with new name.)
2. **Rename tables** via `sp_rename '<old>', '<new>', 'OBJECT'`:
   - `oe.Cases` → `oe.SupportTickets`
   - `oe.CaseNotes` → `oe.SupportTicketNotes`
   - `oe.CaseProviders` → `oe.SupportTicketProviders`
   - `oe.CaseDocuments` → `oe.SupportTicketDocuments`
3. **Rename PK columns** via `sp_rename '<schema>.<table>.<col>', '<new>', 'COLUMN'`:
   - `oe.SupportTickets.CaseId` → `SupportTicketId`
   - `oe.SupportTicketNotes.CaseId` → `SupportTicketId`
   - `oe.SupportTicketProviders.CaseId` → `SupportTicketId`
   - `oe.SupportTicketDocuments.CaseId` → `SupportTicketId`
4. **Rename FK column** on Encounters: `oe.Encounters.CaseId` → `SupportTicketId`.
5. **Rename CaseNumber column** on parent: `oe.SupportTickets.CaseNumber` → `TicketNumber`.
6. **Rename constraints, indexes, and defaults** on all four renamed tables via `sp_rename '...', '...', 'OBJECT'`:
   - `PK_Cases` → `PK_SupportTickets`, `PK_CaseNotes` → `PK_SupportTicketNotes`, etc.
   - `UQ_Cases_VendorCaseNumber` → `UQ_SupportTickets_VendorTicketNumber`
   - All `IX_Cases_*` → `IX_SupportTickets_*` and child equivalents.
   - All `FK_Cases_*` and child FKs → `FK_SupportTickets_*` / `FK_SupportTicketNotes_*` etc.
   - All `DF_Cases_*` and child defaults → `DF_SupportTickets_*` etc.
7. **Re-add Encounters FK**: `FK_Encounters_SupportTicket FOREIGN KEY (SupportTicketId) REFERENCES oe.SupportTickets (SupportTicketId)`.
8. **Add new columns** on `oe.SupportTickets`:
   - `TicketType NVARCHAR(50) NOT NULL CONSTRAINT DF_SupportTickets_TicketType DEFAULT ('reimbursement')` (default lets the NOT NULL ALTER work on existing rows).
   - `TicketSubcategory NVARCHAR(50) NULL`
   - `SubcategoryDetail NVARCHAR(MAX) NULL`
9. **Add CHECK constraints**:
   - `CK_SupportTickets_TicketType` enforcing `TicketType IN ('reimbursement', 'billing', 'encounter_escalation', 'complaint', 'appeals')`.
   - `CK_SupportTickets_TicketSubcategory` enforcing the full subcategory universe (NULL allowed).
10. **Status backfill**: `UPDATE oe.SupportTickets SET Status = '<new>' WHERE Status = '<old>'` for each row in the mapping table above.
11. **Drop the old `DF_Cases_Status` default** (was `'New'`) and add `DF_SupportTickets_Status` with default `'Open'`.
12. **Index** for rail filtering: `IX_SupportTickets_Vendor_TicketType ON oe.SupportTickets (VendorId, TicketType)`.
13. **Verification SELECT** at the end of the file — lists:
    - the 4 renamed tables exist (and old names do not)
    - the 3 new columns on `oe.SupportTickets` exist
    - the 2 new CHECK constraints exist
    - `FK_Encounters_SupportTicket` exists
    - count of rows per `Status` value (sanity check on backfill)
14. **Rollback block, commented out** — reverses everything in inverse order, including re-creating the old `DF_Cases_Status` default and reverting the Status backfill (best-effort — the backfill is many-to-one for `In Progress` so the reverse loses fidelity; document this in the rollback comment).

## App-layer rename (same branch)

### Backend

Files renamed (table-name + identifier find/replace inside):

| Old | New |
|---|---|
| `backend/services/caseService.js` | `backend/services/supportTicketService.js` |
| `backend/routes/me/vendor/cases.js` | `backend/routes/me/vendor/support-tickets.js` |

Inside `supportTicketService.js`:
- `CaseService` class → `SupportTicketService`
- `oe.Cases` → `oe.SupportTickets`, `oe.Case*` children → `oe.SupportTicket*`
- `CaseId` → `SupportTicketId`, `CaseNumber` → `TicketNumber`
- `generateCaseNumber()` → `generateTicketNumber()`, prefix `CASE-` → `TX-`
- `CASE_STATUSES` → `TICKET_STATUSES` with new values: `['Open', 'In Progress', 'Waiting', 'Resolved', 'Closed']`
- Default status changes from `'New'` to `'Open'` everywhere a default is set in JS
- New: `TICKET_TYPE_SUBCATEGORIES` constant — single source of truth for the type↔subcategory map.
- New: `validateTicketTypeAndSubcategory(type, subcategory)` helper used by create + update.
- `createSupportTicket()` accepts `ticketType`, `ticketSubcategory`, `subcategoryDetail`. `ticketType` is required; defaults to `'reimbursement'` if omitted (matches DB default). Pairing validation runs before INSERT.
- `updateSupportTicket()` allows editing all three new fields with the same validation.
- `getSupportTicketById()` and list queries return the three new fields.
- List endpoint supports `?ticketType=...` and `?ticketSubcategory=...` query filters.
- New endpoint: `GET /api/me/vendor/support-tickets/taxonomy` returning the type→subcategories map so the frontend can render dependent dropdowns without duplicating the constants.

Route mount in `backend/app.js`:
- Remove `/api/me/vendor/cases` mount.
- Add `/api/me/vendor/support-tickets` mount.

Other backend files touched:
- `backend/services/encounterService.js` — JOIN target `oe.Cases` → `oe.SupportTickets`, `e.CaseId` → `e.SupportTicketId`, any returned `caseNumber` field → `ticketNumber`. Update any "case" wording in returned shapes.
- Grep pass: anywhere else in `backend/` that still references `oe.Cases` / `CaseId` (expected: nowhere except Encounters; verify).

### Frontend

Directory rename:
- `frontend/src/components/vendor/cases/` → `frontend/src/components/vendor/support-tickets/`

Files renamed inside that directory:

| Old | New |
|---|---|
| `CaseHeaderCard.tsx` | `SupportTicketHeaderCard.tsx` |
| `CaseListRail.tsx` | `SupportTicketListRail.tsx` |
| `CaseNewModal.tsx` | `SupportTicketNewModal.tsx` |
| `CaseWorkspaceTabs.tsx` | `SupportTicketWorkspaceTabs.tsx` |
| `tabs/CaseDetailsTab.tsx` | `tabs/SupportTicketDetailsTab.tsx` |
| `tabs/CaseNotesTab.tsx` | `tabs/SupportTicketNotesTab.tsx` |
| `tabs/CaseProvidersTab.tsx` | `tabs/SupportTicketProvidersTab.tsx` |
| `tabs/CaseDocumentsTab.tsx` | `tabs/SupportTicketDocumentsTab.tsx` |

Page rename: `frontend/src/pages/vendor/CaseWorkspace.tsx` → `SupportTicketWorkspace.tsx`.

Inside every renamed file: `Case` → `SupportTicket`, API base `/api/me/vendor/cases` → `/api/me/vendor/support-tickets`, displayed strings "Case" → "Support Ticket", "Cases" → "Support Tickets".

`App.tsx`: route paths `/vendor/cases/*` → `/vendor/support-tickets/*`.

`frontend/src/components/vendor/VendorNavigation.tsx`: nav entry path `/vendor/cases` → `/vendor/support-tickets`, label `"Cases"` → `"Support Tickets"`.

New files:
- `frontend/src/types/supportTicket.types.ts` — exports `SupportTicket`, `TicketType` (string literal union), `TicketSubcategory` (string literal union), `TicketStatus` union (`'Open' | 'In Progress' | 'Waiting' | 'Resolved' | 'Closed'`).
- `frontend/src/constants/supportTicketTaxonomy.ts` — display label map for the snake_case codes (`'oon_copay' → 'OON Copay'`, etc.) and the type→subcategories map mirrored from the backend.

`SupportTicketNewModal.tsx` new fields:
- **TicketType** dropdown (5 options, required).
- **TicketSubcategory** dropdown — populated from the taxonomy based on selected type; disabled if no type selected; optional.
- **SubcategoryDetail** free-text textarea — visible once a subcategory is picked; optional.

`SupportTicketHeaderCard.tsx`: render a small chip showing `TicketType` (and subcategory if present) near the ticket number.

`SupportTicketDetailsTab.tsx`: editable rows for the three new fields, with the same validation as the create modal.

### Tests

- Any Cypress specs that hit `/vendor/cases/*` get URL + selector updates.
- New Cypress smoke test: create a `reimbursement` / `oon_copay` ticket end-to-end (rail → new modal → details tab shows type/subcategory/detail).
- New Jest test for `validateTicketTypeAndSubcategory()` covering: valid pair OK, invalid pair rejected, NULL subcategory allowed.

## Out of scope (follow-ups)

- Member-portal exposure of Support Tickets. Mirror current Cases: vendor-only (`VendorAdmin` / `VendorAgent`).
- A separate `IsHighPriority BIT` column to recover the "High Priority" status from the old set.
- Admin UI for editing the type↔subcategory taxonomy without a code change.
- Backfilling existing CASE-YYYY-NNNN numbers to TX-YYYY-NNNN (would break any bookmarks/links).
- A 7-step Share Request workflow — Share Requests are not touched in this branch.

## Deployment order

1. Apply `sql-changes/2026-05-19-rename-cases-to-support-tickets.sql` on dev (`allaboard-testing`). Fill in the `TEST-DB NOTES` section of the migration file.
2. Deploy backend + frontend changes.
3. Smoke-test:
   - Vendor nav shows "Support Tickets" linking to `/vendor/support-tickets`.
   - List rail loads; existing rows show their old `CASE-...` numbers and a `TicketType` chip set to `reimbursement`.
   - Create a new ticket from the modal; number is `TX-2026-NNNN`; type/subcategory/detail persisted.
   - Status filter shows the new five values; old rows are correctly mapped.
   - Encounter linked to a former Case row still resolves to the renamed `oe.SupportTickets` row.
4. Apply same migration on staging/prod after the above passes.

The migration file is the single source of truth. Apply unmodified to prod after dev verification.

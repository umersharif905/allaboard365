# Prospects CRM — Implementation Summary

What was built for the "Prospect feature with reporting" issue: each requirement, where
it lives, which user types use it, and what is **not** done yet.

Migrations (idempotent, run via DB policy — not auto-applied):
- `sql-changes/2026-05-25-add-prospects.sql` — *already applied*
- `sql-changes/2026-05-26-prospects-phases-2-5.sql` — comms linkage, quotes + proposal link, agent API keys
- `sql-changes/2026-05-27-prospects-phase-6.sql` — **NEW.** Group prospects + `oe.Prospects.GroupProspectId`; tags (`oe.ProspectTags` + `oe.ProspectTagAssignments`, agency-shared); follow-up + auto last-contacted (`oe.Prospects.NextFollowUpDate`, `LastContactedDate`)

Pages (same `ProspectsPage` component, mounted per portal):
- Agent / Agency Owner → `/agent/prospects`
- Tenant Admin → `/tenant-admin/prospects`
- SysAdmin → `/admin/prospects`

Nav label is **Prospects** in all three portals. In the Agent and Tenant-Admin portals the
**Prospects** item now sits **directly under Quote** in the side nav (SysAdmin has no Quote item).

---

## Requirement-by-requirement

### 1. Basic CRM features for prospects — ✅ Done
- **Where:** `ProspectsPage.tsx` (list, search, status filter, metrics, pagination), `ProspectDetailModal.tsx` (view/edit), `ProspectCreateModal.tsx`.
- **Backend:** `oe.Prospects` + `oe.ProspectProducts`; `routes/prospects.js` (`GET /`, `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id`); `services/prospect.service.js`.
- **Users:** Agent, Agency Owner/Admin, TenantAdmin, SysAdmin.
- **Notes:** Create, **edit** (name/email/phone/premium/status/referral/notes), and **delete** all supported. Edit/delete added beyond the original ask.

### 2. See past communications (email + SMS), like MemberManagementModal — ✅ Done
- **Where:** **Communications** tab in `ProspectDetailModal` (`ProspectCommunicationsTab.tsx`).
- **Backend:** `GET /api/prospects/:id/communications` — merges `oe.MessageHistory` (sent) + `oe.MessageQueue` (pending), matched by `ProspectId` **or** the prospect's email/phone. `POST /api/prospects/:id/communications` sends a new Email/SMS via the existing `MessageQueueService` (SendGrid/Twilio), then tags it with `ProspectId`.
- **Users:** all of the above (subject to visibility).
- **Notes:** History view **and** send-new, both implemented. Matching by address means pre-existing messages to that email/phone (e.g. enrollment emails) also appear.

### 3. See sent proposals / quotes — ✅ Done
- **Where:** **Proposals & Quotes** tab (`ProspectProposalsTab.tsx`).
- **Backend:** `GET /api/prospects/:id/proposals` returns proposals (from `oe.ProposalSends`, matched by `ProspectId` or email/phone, with PDF links) + quotes (`oe.Quotes`).
- **Users:** all.

### 4. Manually create prospects — ✅ Done
- **Where:** "Add Prospect" button → `ProspectCreateModal`.
- **Backend:** `POST /api/prospects` (find-or-create).
- **Users:** all. Admins may assign to a specific agent.

### 5. Creating Proposals & Quotes triggers prospect creation, no duplicates — ✅ Done
- **Where (backend hooks):**
  - Individual proposals → `routes/proposal-sends.js` (after the send record insert)
  - Business proposals → `routes/business-proposal-sends.js` (inside the per-document loop)
  - Quotes → `routes/quotes.js` `POST /api/quotes`
  - All call `prospectService.recordProposalProspect()` → find-or-create (no dup) + advance status to **Proposal Sent**, then link the row's `ProspectId`.
- **Dedupe rule:** email-primary, phone-fallback (normalized).
- **Notes:** The hook is wrapped in try/catch so a prospect-link failure never breaks a proposal send.
- **Phase 6 update — real quote tools on the prospect page:** the old homegrown lightweight "New quote" form in the **Proposals & Quotes** tab is **replaced** by two buttons — **Quick Quote** and **Individual Proposal** — that open the *real* marketing tools (`QuickQuoteWizardModal` / `SendProposalModal`, mode `individual`) **prefilled** with the prospect's name/email/phone (via new optional `initialProspect` + `onSent` props on those modals). After a send the tab refetches so the new quote/proposal shows immediately.
- **Phase 6 update — Quick Quote creates a prospect:** when a **Quick Quote** is emailed / texted / downloaded from the Quote (Marketing) page, it now best-effort `find-or-create`s a prospect for the recipient email (`ProspectService.create`, deduped). Individual + business proposals already created prospects on their backend routes; this closes the gap for Quick Quote. The create call is swallowed on error so it never blocks the quote.

### 6. API endpoint with an agent-unique API key to ingest leads — ✅ Done
- **Where (backend):** `POST /api/lead-ingest` (auth via `Authorization: Bearer sk_live_…`). `routes/agent-api-keys.js` mints/lists/revokes a key for the calling agent. `middleware/auth.js` `validateApiKey` now resolves an **agent-scoped** key to that agent's real `UserId` + `AgentId` + `Agent` role (backward compatible: tenant-level keys keep working).
- **Where (frontend):** **Lead Ingest API** button on `ProspectsPage` (agent portal only) → `LeadIngestModal.tsx`: generate key (shown once), list/revoke, copy-paste `curl` sample.
- **Schema:** `oe.TenantApiKeys` + `AgentId` + `Scope` ('lead-ingest').
- **Users:** Agent / Agency Owner mint their own key; ingested leads are attributed to that agent and de-duped.

### 7. Prospect status; if member exists → CLOSED + link to member — ✅ Done (suggest-then-confirm)
- **Where:** `ProspectDetailModal` member-match banner; list row shows a check icon.
- **Backend:** `suggestMemberMatch` detects an `oe.Members` row by email (then phone) → stored as `SuggestedMemberId`. `POST /api/prospects/:id/confirm-member-link` sets `MemberId`, flips status to **Closed**, stamps `ClosedDate`.
- **Design decision (your call):** match is **suggested**, and an agent **confirms** before it closes — no silent auto-close. Status set: **New → Contacted → Proposal Sent → Closed → Lost**.

### 8. Report generator (prospect info, referral, premium, products, etc.) — ✅ Done
- **Where:** **Export CSV** button on `ProspectsPage`.
- **Backend:** `GET /api/prospects/report` — CSV honoring the current visibility + filters, toggleable columns via `?fields=`. Columns: first/last name, email, phone, status, referral, premium, products (rolled up), agent, source, enrolled-member flag, created/closed dates. Modeled on the group-member report (manual CSV, `Content-Disposition`).
- **Users:** all (scoped to what they can see).

### 9. Role-based visibility (Tenant, Agency Admin, Upline Agents) — ✅ Done
Mirrors the Members/Groups/Commissions pattern (`useDownlineAgentsForFilter`, `oe.AgentHierarchy`, `oe.AgencyAdmins`). Backend resolves the effective agent-id set in `routes/prospects.js` `resolveVisibility()`.

- **Upline agent (not an agency admin):** sees self + entire downline at once, or filters to a specific downline agent, or "Me". ✅
- **Agency Admin / Owner:** sees the whole agency; filter offers **All Agency Agents**, **Direct downlines**, **All Downline Agents**, **Me**, or a specific agent. ✅
- **TenantAdmin / SysAdmin:** **Agency** dropdown + **Agent** dropdown (agent narrows within the chosen agency); default is the whole tenant. ✅
- **Tenant isolation:** every query is tenant-scoped; cross-tenant data is never visible (SysAdmin excepted). ✅

---

## Phase 6 additions (2026-05-27)

### 10. Group prospects (group/company tracking) — ✅ Done (schema + linkage)
- **Where (backend):** new `oe.GroupProspects` table + `oe.Prospects.GroupProspectId`. `prospect.service.js` adds `findOrCreateGroupProspect()` (dedupe: contact email → normalized company name within tenant+agent) and `linkProspectToGroup()`. `routes/business-proposal-sends.js` now, after recording the per-recipient prospect, find-or-creates one **group prospect** for the company and links the prospect's `GroupProspectId` to it (best-effort, idempotent across the per-document loop).
- **Where (frontend):** `getProspect` detail now returns a light `group` summary (company name, contact email, employees, status) shown on the detail modal when present.
- **Scope note:** schema + auto-linkage only for this release — no dedicated "Groups" list/filter view yet. Employees who receive a proposal can be associated to their company for a future group-rollup view.

### 11. Tags (agency-shared, colored, multi-tag) — ✅ Done
- **Where (backend):** `oe.ProspectTags` (TenantId + nullable AgencyId + Name + Color) and `oe.ProspectTagAssignments` (many-to-many, unique per prospect+tag). `routes/prospect-tags.js` → `GET/POST/DELETE /api/prospect-tags`; tag **assign/unassign** live on the prospects router (`POST /api/prospects/:id/tags`, `DELETE /api/prospects/:id/tags/:tagId`). Service: `listTags / createTag (find-or-create, case-insensitive) / getTag / deleteTag (cascades assignments) / assignTag / unassignTag`.
- **Visibility (agency-shared):** a tag with `AgencyId = NULL` is tenant-wide; otherwise it is shared among agents in that agency. Agents see tenant-wide + their agency's tags and create tags scoped to **their** agency; admins see all tenant tags and create tenant-wide ones. An agent may delete only tags in their own agency (never tenant-wide); admins may delete any.
- **Where (frontend):** colored tag chips on list rows + detail; a tag **filter** (multi-select → `?tags=`) in the toolbar; assign/remove + create-new (name + color) in the detail modal. A prospect may carry **many** tags. CSV report gains a **Tags** column.

### 12. CRM extras — ✅ Done
- **Follow-up date:** `oe.Prospects.NextFollowUpDate`. Editable on the detail modal (`PUT … { nextFollowUpDate }`); list shows a due/overdue indicator; toolbar filter All / Overdue / Upcoming / Has follow-up (`?followUp=overdue|upcoming|any`). Report gains a **Next Follow-up** column.
- **Last-contacted (auto):** `oe.Prospects.LastContactedDate` auto-stamped whenever a prospect communication is sent (`POST /:id/communications`) or a proposal/quote goes out (`recordProposalProspect`). Shown read-only on the detail modal; report gains a **Last Contacted** column.
- **Reassign owning agent:** `POST /api/prospects/:id/reassign { agentId }` — admins to any tenant agent; upline/agency users only to an agent within their allowed set. Surfaced in the detail modal for admins/upline.
- **Sortable list columns:** `GET /api/prospects?sortBy=&sortDir=` with a server-side whitelist (`createdDate|name|status|premium|followUp|lastContacted`); clickable Name/Status/Premium/Created headers toggle asc/desc (default createdDate desc).

---

## Test coverage (all green)

- **Backend Jest — 63 tests, 5 suites** (all green):
  - `services/__tests__/prospect.service.test.js` (19) — normalize/dedupe, member-match, find-or-create, confirm-link, delete transaction, report empty-scope, address candidates, name split.
  - `routes/__tests__/prospects.routes.test.js` (26) — visibility resolution (agent/self/agency/admin), access-control 403/404, create/update/confirm-link, communications send+list, **CSV report (route ordering + comma quoting)**, delete, **+ Phase 6: sort/tag/follow-up params, invalid follow-up date 400, reassign (missing/valid), tag assign/unassign**.
  - `routes/__tests__/prospect-tags.routes.test.js` (9) — **NEW.** Tag list scoping (agent vs admin), create (agency-scoped vs tenant-wide), delete guard (agent can't delete tenant-wide tags; admin can delete any).
  - `routes/__tests__/lead-ingest.test.js` (6) — API-key + agent-scope gating, dedupe passthrough.
  - `routes/__tests__/quotes.routes.test.js` (3) — quote create auto-links a prospect; list.
- **Frontend Vitest — 21 tests** (`src/services/__tests__/prospect.service.test.ts`, was 10) — list/report param building incl. **sortBy/sortDir/tags/followUp**, communications, API keys, status set, **+ tag CRUD methods + reassign**. Full frontend suite **302/302** green.
- **Cypress e2e — 7 tests** (`cypress/e2e/prospects/prospects.cy.ts`, stub-driven): list render + badges, create (find-or-create) + validation, detail tab switching, member-match banner + confirm-link, send communication, Lead Ingest key modal. **Phase 6:** the Proposals & Quotes assertion now expects the real **Quick Quote** / **Individual Proposal** buttons; tag-list endpoint stubbed.

Run:
```
cd backend && npx jest services/__tests__/prospect.service.test.js routes/__tests__/prospects.routes.test.js routes/__tests__/prospect-tags.routes.test.js routes/__tests__/lead-ingest.test.js routes/__tests__/quotes.routes.test.js
cd frontend && npx vitest run src/services/__tests__/prospect.service.test.ts
cd frontend && npx cypress run --spec "cypress/e2e/prospects/prospects.cy.ts"   # needs dev server on :5173
```

## What is NOT done / partial (honest list)

1. **Raw SQL is unit/contract-tested, not executed against a live DB.** Service tests mock the DB, route tests mock the service, and Cypress mocks the API — so the wiring is well covered, but the actual T-SQL (member-match `RIGHT(...)`, comms address-match, report `STRING_AGG`, the delete transaction) has **not run against real data**. Smoke-test these once the migration is applied.
2. **The prospect page now uses the real quote tools.** "New quote" was replaced by the actual Quick Quote / Individual Proposal modals (Phase 6). The legacy lightweight `oe.Quotes` table + `POST /api/quotes` still exist and still auto-link a prospect, but the prospect UI no longer writes to it directly. **Group prospects are schema + linkage only** — no dedicated Groups list/filter view yet.
3. **Report export is CSV only** (matches the group-member report). No XLSX/PDF.
4. **Communications composer is plain text.** Email send is plain text → simple HTML (line breaks). No templates, attachments, or rich editor in the prospect composer (the full Message Center still has those).
5. **Member-match is heuristic.** Email is exact (normalized); phone matches on last-10 digits. Unusual international formats may not match. The match only ever *suggests* — an agent must confirm — so a missed/incorrect suggestion is low-risk.
6. **No bulk actions / CSV import of prospects** (only one-at-a-time create + the API ingest endpoint). Not in the issue, noted for completeness.
7. **Lead-ingest hardening.** Endpoint validates the key + agent scope and de-dupes, but there is **no per-key rate limiting or IP allowlist** yet (the global `/api/` limiter still applies). Consider adding if the endpoint is exposed widely.
8. **Pre-existing repo lint/type noise** in files I touched (e.g. `App.tsx` `localStorage`/`console` warnings, unused imports in nav files) was left as-is — not introduced by this work.

---

## Quick reference — files added/changed

**Backend (new):** `routes/prospects.js`, `routes/quotes.js`, `routes/agent-api-keys.js`, `routes/lead-ingest.js`, `services/prospect.service.js`, `services/__tests__/prospect.service.test.js`, `sql-changes/2026-05-25-add-prospects.sql`, `sql-changes/2026-05-26-prospects-phases-2-5.sql`.
**Backend (changed):** `app.js` (mounts), `middleware/auth.js` (agent-scoped key), `routes/proposal-sends.js` + `routes/business-proposal-sends.js` (prospect hook).
**Frontend (new):** `pages/prospects/ProspectsPage.tsx`, `ProspectDetailModal.tsx`, `ProspectCreateModal.tsx`, `ProspectCommunicationsTab.tsx`, `ProspectProposalsTab.tsx`, `LeadIngestModal.tsx`, `prospectStatus.ts`, `services/prospect.service.ts`, `hooks/useProspects.ts`, `services/__tests__/prospect.service.test.ts`.
**Frontend (changed):** `App.tsx` (routes), `components/agent/AgentNavigation.tsx`, `components/TenantAdminNavigation.tsx`, `components/AdminNavigation.tsx` (nav links).

### Phase 6 — files added/changed (2026-05-27)
**Backend (new):** `sql-changes/2026-05-27-prospects-phase-6.sql`, `routes/prospect-tags.js`, `routes/__tests__/prospect-tags.routes.test.js`.
**Backend (changed):** `app.js` (mount `/api/prospect-tags`), `services/prospect.service.js` (tags, group prospects, follow-up/last-contacted/reassign, sort + tag/follow-up filters, tag-attachment in list/detail/report, delete cascade), `routes/prospects.js` (sort/tag/follow-up params, `nextFollowUpDate`, reassign + tag-assign routes, last-contacted stamp, report columns), `routes/business-proposal-sends.js` (group-prospect create+link), `routes/__tests__/prospects.routes.test.js` (new endpoint tests).
**Frontend (changed):** `components/agent/AgentNavigation.tsx` + `components/TenantAdminNavigation.tsx` (Prospects moved under Quote); `pages/prospects/ProspectProposalsTab.tsx` (real Quick Quote / Individual Proposal buttons); `components/agents/QuickQuoteWizardModal.tsx` + `components/proposals/SendProposalModal.tsx` (`initialProspect` + `onSent` props; Quick Quote prospect create); plus the Prospects-page tags / follow-up / last-contacted / reassign / sortable-columns work in `ProspectsPage.tsx`, `ProspectDetailModal.tsx`, `prospectStatus.ts`, `services/prospect.service.ts`, `hooks/useProspects.ts`.

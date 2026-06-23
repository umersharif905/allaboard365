# Prospects CRM Feature — Implementation Plan

**Status:** Draft for review
**Date:** 2026-05-25
**Source issue:** "Prospect feature with reporting" (@jeremyfrancis)

---

## 1. Scope (from the issue)

Build basic CRM for **prospects** (leads who are not yet enrolled members):

1. Prospect record with status lifecycle. If an `oe.Members` row exists for them → status **CLOSED**, with a link to the member.
2. On a prospect: see past **communications** (email + SMS), like `MemberCommunicationsTab` in `MemberManagementModal`.
3. On a prospect: see **proposals / quotes** sent to them.
4. **Manually create** prospects.
5. Creating **proposals & quotes** auto-creates a prospect (no duplicates).
6. **API endpoint** that agents share with an **agent-unique API key** to ingest leads.
7. **Report generator** — prospect info, referral name, premium amount, products subscribed to, etc. (modeled on the group member report).
8. **Role-based visibility** for Tenant Admin, Agency Admin, and upline agents — view whole agency/downline or a specific agent, mirroring the Members / Groups / Commissions pages.

### Decisions locked with Jeremy (2026-05-25)
- **Deliverable:** full plan first, then build. ← this document.
- **Quotes:** "do all of them" → build a lightweight **Quote** concept **and** hook the existing **Proposals** system; both create/update a prospect. *(See §4.4 — flag for confirmation: the lightweight Quote scope.)*
- **Identity / dedupe:** **email primary, phone fallback** (normalized).
- **Communications:** **view history + send new** from the prospect view; add `ProspectId` to the message tables.
- **Prospect status set:** `New → Contacted → Proposal Sent → Closed → Lost` (confirmed 2026-05-25).
- **Member match:** **suggest, agent confirms** (confirmed 2026-05-25). A detected member match is stored as `SuggestedMemberId` and surfaced as a banner; status flips to `Closed` + `MemberId` set only when the agent confirms. No auto-close.

---

## 2. What already exists (reuse, don't rebuild)

| Capability | Where | Reuse for |
|---|---|---|
| Comms history UI | `frontend/src/pages/members/tabs/MemberCommunicationsTab.tsx` | Prospect comms tab |
| Comms storage | `oe.MessageQueue`, `oe.MessageHistory`, `oe.MessageEvent` (keyed by `RecipientId` **and** `RecipientAddress`) | Match prospect comms by email/phone |
| Send email/SMS | `backend/services/sendGridEmailService.js`, `messageQueue.service.js`, Twilio webhook | Send-new from prospect |
| Proposals | `oe.ProposalDocuments`, `oe.ProposalSends`, `routes/proposal-sends.js`, `routes/business-proposal-sends.js` | Proposal→prospect hook + "proposals sent" list |
| Agent hierarchy | `oe.AgentHierarchy`, `oe.AgencyAdmins`, `backend/utils/agentHierarchy.js` (`getSelfAndDownlineAgentIds`, `getAgentIdsForAgency`, `getDirectDownlineAgentIds`, `isAgencyAdmin`) | Prospect visibility scoping |
| Visibility filter UI | `frontend/src/hooks/useDownlineAgentsForFilter.ts` + `SearchableDropdown` (used in `GroupsPage.tsx`, `AgentCommissions.tsx`) | Prospect agent/agency/self filter |
| Downline endpoint | `GET /api/me/agent/agents/downline-agents?agencyPool=1` (`routes/me/agent/agents.js:758`) | Filter options |
| Report pattern | `routes/groupMembers.js` report endpoint (toggleable columns, manual CSV) | Prospect report |
| API key auth | `oe.TenantApiKeys` + `validateApiKey()` (`middleware/auth.js:12`) — **tenant-scoped, hardcoded `TenantAdmin`, TODO to link to users** | Extend to agent-scoped |
| Tenant isolation | `buildTenantWhereClause()` (`config/database.js:267`) | Every prospect query |
| Migrations | `sql-changes/YYYY-MM-DD-*.sql`, idempotent (`IF NOT EXISTS`), applied manually | New tables/columns |

**Gaps to build:** there is **no** `oe.Prospects` table, **no** Quotes feature, **no** API-key management routes/UI, and API keys are **not** agent-scoped.

---

## 3. Data model

### 3.1 New table: `oe.Prospects`
`sql-changes/2026-05-25-add-prospects.sql` (idempotent).

| Column | Type | Notes |
|---|---|---|
| `ProspectId` | `UNIQUEIDENTIFIER` PK `DEFAULT NEWID()` | |
| `TenantId` | `UNIQUEIDENTIFIER NOT NULL` | tenant isolation (FK `oe.Tenants`) |
| `AgentId` | `UNIQUEIDENTIFIER NULL` | owning agent (FK `oe.Agents`); drives visibility |
| `FirstName` / `LastName` | `NVARCHAR(100)` | |
| `Email` | `NVARCHAR(256) NULL` | stored raw + see `EmailNormalized` |
| `EmailNormalized` | `NVARCHAR(256) NULL` | lower/trim — dedupe key 1 |
| `Phone` | `NVARCHAR(40) NULL` | |
| `PhoneNormalized` | `NVARCHAR(40) NULL` | E.164 — dedupe key 2 |
| `Status` | `NVARCHAR(40) NOT NULL DEFAULT 'New'` | New/Contacted/Proposal Sent/Closed/Lost |
| `ReferralName` | `NVARCHAR(200) NULL` | for report |
| `PremiumAmount` | `DECIMAL(18,2) NULL` | last quoted/estimated premium (report) |
| `Notes` | `NVARCHAR(MAX) NULL` | |
| `Source` | `NVARCHAR(40) NOT NULL DEFAULT 'Manual'` | Manual / Proposal / Quote / ApiIngest |
| `SuggestedMemberId` | `UNIQUEIDENTIFIER NULL` | auto-detected member match, pending agent confirm (FK `oe.Members`) |
| `MemberId` | `UNIQUEIDENTIFIER NULL` | confirmed link; set with `Status='Closed'` on agent confirm (FK `oe.Members`) |
| `ClosedDate` | `DATETIME2 NULL` | |
| `CreatedBy` | `UNIQUEIDENTIFIER NULL` | user/agent who created |
| `CreatedDate` | `DATETIME2 DEFAULT GETUTCDATE()` | |
| `ModifiedDate` | `DATETIME2 DEFAULT GETUTCDATE()` | |

Indexes: `(TenantId, EmailNormalized)`, `(TenantId, PhoneNormalized)`, `(TenantId, AgentId)`, `(TenantId, Status)`.

### 3.2 New table: `oe.ProspectProducts` (products subscribed/interested)
`ProspectProductId` PK, `ProspectId` FK, `ProductId` FK (`oe.Products`), `PremiumAmount DECIMAL(18,2) NULL`, `Source`, `CreatedDate`. Powers the report's "products subscribed to".

### 3.3 New table: `oe.Quotes` (lightweight — confirm scope, §4.4)
`QuoteId` PK, `TenantId`, `AgentId`, `ProspectId NULL`, prospect contact snapshot (name/email/phone), `Status`, `TotalPremium DECIMAL(18,2)`, `CreatedBy`, `CreatedDate`. Plus `oe.QuoteLineItems` (`QuoteId`, `ProductId`, `Premium`, `Tier`). Creating a quote runs the same create-or-find-prospect hook.

### 3.4 Column additions to message tables
`sql-changes/2026-05-25-add-prospectid-to-messages.sql`: add nullable `ProspectId UNIQUEIDENTIFIER` to `oe.MessageQueue` and `oe.MessageHistory` (mirrors the existing `CaseId`/`ShareRequestId` pattern added 2026-05-20). Lets us attach sent comms to a prospect directly, while still surfacing legacy comms by address match.

### 3.5 Agent-scoped API keys
`sql-changes/2026-05-25-prospect-api-keys.sql`: the `oe.TenantApiKeys` table has **no creation migration** in `sql-changes/` today and is **tenant-scoped**. Add (idempotently): `AgentId UNIQUEIDENTIFIER NULL` (FK `oe.Agents`) and `Scope NVARCHAR(40) NULL` (e.g. `'lead-ingest'`). Keys with `AgentId` set authenticate **as that agent** (see §5.4). *(Also create the table definition file for the existing schema so it's captured in source.)*

---

## 4. Backend

### 4.1 Prospect service — `backend/services/prospect.service.js`
- `normalizeEmail(email)`, `normalizePhone(phone)` (reuse the E.164 logic from `messageQueue.service.js`).
- `findOrCreateProspect({ tenantId, agentId, firstName, lastName, email, phone, premium, products, source, createdBy })`:
  1. Match within tenant by `EmailNormalized`; if no email, by `PhoneNormalized`.
  2. If found → update missing fields, append products, return existing (no duplicate).
  3. If not → insert new.
  4. Always run `reconcileMemberLink()`.
- `reconcileMemberLink(prospect)`: look up `oe.Members` joined to `oe.Users` within tenant by normalized email then phone; if match → set `MemberId`, `Status='Closed'`, `ClosedDate`.
- `listProspects({ tenantId, scope, agentId, agencyId, status, search, page, pageSize })` — applies visibility (§4.5).
- `getProspect(id)` — includes products, linked member, proposal/quote sends, comms.

### 4.2 Routes — `backend/routes/prospects.js` (mounted in `app.js`)
| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/api/prospects` | Agent, AgencyOwner, TenantAdmin, SysAdmin | list + filters + visibility scope |
| GET | `/api/prospects/:id` | ↑ (+ownership) | detail (products, member link, proposals, quotes, comms) |
| POST | `/api/prospects` | ↑ | manual create (find-or-create) |
| PUT | `/api/prospects/:id` | ↑ | edit status/fields |
| GET | `/api/prospects/:id/communications` | ↑ | comms history (by `ProspectId` OR address match) |
| POST | `/api/prospects/:id/communications` | ↑ | send new email/SMS (queues with `ProspectId` set) |
| GET | `/api/prospects/report` | ↑ | report (CSV first; see §6) |

All routes go through `authenticate` + `requireTenantAccess`; every query uses `buildTenantWhereClause` and the visibility filter.

### 4.3 Comms integration
- **History:** query `oe.MessageHistory` where `ProspectId = @id` **OR** (`RecipientAddress` matches prospect email/phone within tenant). Reuse the `MemberCommunicationsTab` shape so the frontend tab is near-identical.
- **Send-new:** call existing `queueEmail` / `queueMessage` (`messageQueue.service.js`) with `recipientAddress = prospect email/phone`, `recipientId = NULL`, and the new `ProspectId` set so it threads back.

### 4.4 Proposal / Quote → prospect hook  ⚠️ confirm
- **Proposals (individual):** after the successful `oe.ProposalSends` insert at `routes/proposal-sends.js:~211`, call `findOrCreateProspect` with `prospectInfo.{name,email,phone,address,dateOfBirth}`, `agentId`, `source='Proposal'`, set `Status` to at least `Proposal Sent`, and record products from the proposal document. Wrapped in try/catch so a hook failure never breaks the send.
- **Proposals (business):** same, inside the loop at `routes/business-proposal-sends.js:~400` using `companyName`/`recipientEmail`/`recipientPhone`.
- **Quotes:** the new quote-create endpoint (§3.3) calls the same hook with `source='Quote'`.
- **⚠️ Flag:** issue says "proposals & quotes". Proposals exist; Quotes do not. Plan builds a *lightweight* Quote (product + premium estimate, attachable to a prospect). Confirm that lightweight scope vs. a fuller quoting/pricing engine.

### 4.5 Visibility scoping (mirror Members/Groups/Commissions)
Reuse `backend/utils/agentHierarchy.js`. Resolve the effective `AgentId` set from `(scope, agentId, agencyId)` then filter `oe.Prospects.AgentId IN (...)`:
- **Agent (default):** `getSelfAndDownlineAgentIds` → self + downline. `scope='self'` → just me. Specific `agentId` (must be within their downline) → that agent.
- **AgencyOwner / Agency Admin:** `scope='agency'` → `getAgentIdsForAgency`; `scope='direct'` → `getDirectDownlineAgentIds`; specific agent allowed within agency.
- **TenantAdmin:** all agents in tenant; optional `agencyId` filter (→ `getAgentIdsForAgency`) and/or specific `agentId`.
- **SysAdmin:** unrestricted (still tenant-scoped per request).

Mirror the sentinel-value contract already used by `useDownlineAgentsForFilter` (`__oe_agency_all__`, `__oe_direct_downline__`, `__oe_downline_all__`, `''`=me).

### 4.6 Lead-ingest API + agent-scoped keys
- **Key management routes** (new — none exist today): `POST/GET/DELETE /api/agent-api-keys` for an agent to mint/list/revoke their own `sk_live_...` key (generate, SHA256 hash → `KeyHash`, store `PartialKey`, `AgentId`, `Scope='lead-ingest'`). Show full key once on creation only.
- **`validateApiKey` change** (`middleware/auth.js:65-84`): if the matched key row has `AgentId`, build `req.user` from that agent's real `UserId`/roles (via `oe.Agents`+`oe.UserRoles`) instead of the hardcoded `TenantAdmin`. Backward-compatible: null `AgentId` keeps current behavior.
- **Ingest endpoint:** `POST /api/lead-ingest` (auth via `Authorization: Bearer sk_live_...`). Body: `firstName,lastName,email,phone,referralName,premium,products[],notes`. Resolves tenant + agent from the key, runs `findOrCreateProspect` with `source='ApiIngest'`. Returns `{ success, data: { prospectId, created: bool } }`. Rate-limit + validate.

---

## 5. Frontend

### 5.1 Prospects list page — `frontend/src/pages/prospects/ProspectsPage.tsx`
- Route in `App.tsx` under agent/admin layouts with `ProtectedRoute` for Agent/AgencyOwner/TenantAdmin/SysAdmin.
- Layout cloned from `GroupsPage.tsx`: search, **status filter**, **agent/agency/self filter** via `useDownlineAgentsForFilter({ includeShowAllOption: true, agencyOwnerFilter: true })` + `SearchableDropdown`, list/grid, pagination, metrics cards (total, by status, closed conversion).
- TenantAdmin gets the **agency selector + agent selector** two-level pattern from `AgentManagementModal.tsx:2549`.
- "Add Prospect" button → create modal.
- Sentinel→API param conversion copied from `GroupsPage.tsx:213-228` (`agentIdForApi` + `scope`).

### 5.2 Prospect detail — `ProspectDetailModal.tsx` (or page)
Tabs: **Overview** (contact, status dropdown, referral, premium, products, member link if Closed) · **Communications** (reuse `MemberCommunicationsTab` adapted to `prospectId` + send-new composer) · **Proposals & Quotes** (list of sends) · **Notes**.

### 5.3 Hooks & services
- `frontend/src/hooks/useProspects.ts`, `useProspect.ts`, `useProspectMutations.ts` (TanStack Query, role subdir pattern).
- `frontend/src/services/prospect.service.ts` (Axios via `apiClient`).

### 5.4 Agent API key UI
Add an "API Keys / Lead Ingest" section (agent settings) to create/copy/revoke the agent's key, with a documented sample `curl` for the ingest endpoint.

---

## 6. Reporting
Model on `routes/groupMembers.js` report (toggleable columns, manual CSV via headers + `Content-Disposition`).
`GET /api/prospects/report` honoring the same visibility + filters, with toggle params: prospect name, email/phone, **referral name**, status, **premium amount**, **products subscribed to**, agent, source, created/closed dates, member link.
- **Phase 1:** CSV (matches existing report convention).
- **Optional later:** XLSX/PDF — confirm if needed (the existing group report is CSV-only).

---

## 7. Phasing

- **Phase 1 — Core CRM:** ✅ **Implemented (2026-05-25).** `oe.Prospects` + `oe.ProspectProducts` migration; `prospect.service.js` (find-or-create email/phone dedupe, suggest-member-match, confirm-link, list w/ visibility); `routes/prospects.js` (list/detail/create/update/confirm-member-link) mounted at `/api/prospects`; `ProspectsPage` + create modal + detail modal (status edit, member-match banner) with the agent/agency/self filter; routes + nav for Agent, TenantAdmin, SysAdmin. Tests: 14 backend Jest + 5 Vitest, all green.
  - **Run the migration before use:** `sql-changes/2026-05-25-add-prospects.sql` (idempotent; not executed per DB policy).
  - **Deferred to a Phase 1 follow-up:** the TenantAdmin/SysAdmin **agency + specific-agent selector** in the toolbar. Backend already accepts `agencyId`/`agentId` for admins; the UI currently shows the agent filter only for Agent/AgencyOwner and lists the whole tenant for admins. Wiring the admin agent/agency dropdown (reusing `AgentManagementModal`'s agency selector + an admin agent list) is the remaining piece to fully satisfy "Tenantadmin should be able to view by agency or specific agent."
- **Phase 2 — Communications:** ✅ **Implemented (2026-05-26).** `ProspectId` columns on message tables; `GET/POST /api/prospects/:id/communications` (history by ProspectId OR email/phone address match, merged queue+history; send email/SMS via `MessageQueueService` then tag with ProspectId); Communications tab in the detail modal.
- **Phase 3 — Proposals/Quotes hook:** ✅ **Implemented (2026-05-26).** `oe.Quotes`/`oe.QuoteLineItems`; `oe.ProposalSends.ProspectId`; `recordProposalProspect()` hooked into both `proposal-sends.js` and `business-proposal-sends.js` (find-or-create, no dup, advance to "Proposal Sent"); `routes/quotes.js` (create→auto-create/link prospect, list); `GET /api/prospects/:id/proposals`; "Proposals & Quotes" tab with inline New Quote.
- **Phase 4 — API ingest:** ✅ **Implemented (2026-05-26).** `oe.TenantApiKeys` schema captured + `AgentId`/`Scope` columns; `validateApiKey` resolves agent-scoped keys to the real agent (backward compatible); `routes/agent-api-keys.js` (mint/list/revoke own key) + Lead Ingest modal UI; `POST /api/lead-ingest` (source ApiIngest, de-duped).
- **Phase 5 — Reporting:** ✅ **Implemented (2026-05-26).** `GET /api/prospects/report` CSV honoring visibility + filters with toggleable `?fields=`; Export CSV button on the list page.
- **TenantAdmin/SysAdmin agency+agent filter:** ✅ **Implemented (2026-05-26).** Agency dropdown + agent dropdown on the list page (agent narrows within agency), wired to the backend `agencyId`/`agentId` params.

Migrations (idempotent): `2026-05-25-add-prospects.sql` (already applied) and `2026-05-26-prospects-phases-2-5.sql` (phases 2–5 combined: message ProspectId, quotes + proposal link, agent-scoped API keys).

Each phase: backend Jest + Vitest, plus a Cypress spec for the list/filter and ingest flows (per CLAUDE.md, Cypress for functional features). No DB writes executed without explicit approval; migrations delivered as idempotent `.sql` with SELECT-preview where they touch existing data.

---

## 8. Open questions / confirmations
1. **Quotes scope** (§4.4): lightweight quote (product + premium) vs. a fuller pricing engine? Plan assumes lightweight.
2. **Status set** (§1): confirm `New / Contacted / Proposal Sent / Closed / Lost`.
3. **Member match strength:** email-or-phone match auto-sets Closed. OK to auto-link, or require an agent to confirm the link before flipping to Closed?
4. **Ingest auth model:** one key per agent (rotatable), scope limited to lead ingest — correct? Any per-key rate limit / IP allowlist desired?
5. **Report export:** CSV only (like group report), or also XLSX/PDF?
6. **Prospect ownership on ingest/proposal when a TenantAdmin/SysAdmin acts** — assign to the `agentId` on the request; if none, leave `AgentId` null (tenant-level)?

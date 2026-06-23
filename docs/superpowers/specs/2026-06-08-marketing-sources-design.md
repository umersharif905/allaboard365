# Marketing Sources & Enhanced Insights — Design Spec

**Date:** 2026-06-08
**Branch:** `feat/prospects/marketing-sources` (off `staging`)
**Repos:** AllAboard365 (`allaboard365-wt1`) + MightyWELL Website (`feat/ad-landing-page`)

## Goal

Turn prospect "sources" into a first-class, agent-managed entity. Agents create
named, uniquely-coded sources (website links, landing-page marketing links, or
API feeds), hand each unique link to a different marketing partner, and any lead
arriving through that link is auto-attributed to that source. A new **Sources**
tab in the Prospects page manages these, and the **Insights** tab gains
per-source filtering and custom date ranges so agents can pull reports per source
and per period.

## Context — what exists today (post commit 109da393, now in `staging`)

- **Prospects page** = two tabs: **List** + **Insights**
  (`frontend/src/pages/prospects/ProspectsPage.tsx`,
  `ProspectsInsightsTab.tsx`).
- **`Source` is a free-text column** on `oe.Prospects` (values: `Manual`,
  `ApiIngest`, `MightyWELL Website`, `Proposal`, `Quote`). **No Sources table.**
  `PROSPECT_SOURCES` / `NOTIFY_SOURCES` defined in
  `backend/services/prospect.service.js`.
- **Website-link UI** lives on the **Marketing page**
  (`frontend/src/components/marketing/WebsiteLinkCard.tsx`), backed by
  `GET /api/me/agent/marketing-link` (`backend/routes/me/agent/marketing-link.js`).
  It builds one agent-wide link as `<base>?id=<AgentCode>`.
- **Lead capture (website):** `POST /api/website-form-submissions`
  (`backend/routes/website-form-submissions.js`) — matches an agent by `?id=`
  (AgentCode, exact `LOWER()` match) or `?name=`, audits to
  `oe.WebsiteFormSubmissions`, calls `prospectService.findOrCreateProspect()`
  with `source='MightyWELL Website'`.
- **Lead capture (API):** `POST /api/lead-ingest` (`backend/routes/lead-ingest.js`),
  agent-scoped API keys in `oe.TenantApiKeys` (`AgentId` + `Scope='lead-ingest'`),
  managed by `LeadIngestModal.tsx` + `backend/routes/agent-api-keys.js`. Source
  `'ApiIngest'`.
- **Agent codes:** `oe.Agents.AgentCode` (e.g. `MWA000124`); no underscores in the
  format, so `_` is a safe delimiter.
- **Stats:** `getProspectStats({ tenantId, agentIds, from, to })` in
  `prospect.service.js` already supports date range + agent scope; groups by
  `p.Source`. Endpoint `GET /api/prospects/stats`.
- **Tenant settings:** `AdvancedSettings.marketingLink = { idParam, links[] }`,
  edited in `frontend/src/components/UnifiedTenantSettingsModal.tsx` (Marketing
  Links tab), persisted via `backend/routes/me/tenant-admin/settings.js`.
- **MightyWELL `/get-covered` landing page** is built on branch
  `feat/ad-landing-page` (NOT yet in `main`):
  `src/pages/LandingPage.jsx` + `src/components/landing/LandingQuoteForm.jsx`.
  It reads `?id=`/`?name=`/`?agent=`, stores in sessionStorage, and forwards the
  **whole `id` string untouched** to AA365 via `submitContactForm` →
  `/api/submissions/contact` → AA365 `/website-form-submissions`. It hides the
  advisor UI entirely when an agent comes from the ad link.

## Decisions (confirmed with user)

1. **Link code format:** `<AgentCode>_<suffix>` (e.g. `MWA000124_a1b2c3`).
   Human-debuggable; bare `?id=<AgentCode>` still resolves to the agent with the
   default source. MightyWELL site already forwards the whole string.
2. **Three source types:** `website` (→ tenant's standard website/quote URL),
   `landing` (→ tenant's `/get-covered` landing URL), `api` (mints an API key).
3. **Destination URLs are tenant settings, NOT hardcoded** — extend
   `AdvancedSettings.marketingLink`.
4. **Insights enhanced in place** — add source selector + date-range/month picker
   + per-source summary; keep existing charts.
5. **Consolidate links into Sources tab** — remove `WebsiteLinkCard` from the
   Marketing page and the "Lead Ingest API" button from the prospects header.
6. **Source `Tag`** = free-text on the source (grouping/partner reporting),
   separate from the existing prospect-tag system.
7. **Legacy `Source` text column stays** alongside the new `SourceId` (no breakage,
   old charts keep working).
8. **MightyWELL = merge + deploy** the `/get-covered` page; no new page code
   needed (composite `?id` already forwarded). Verify end-to-end.

## Data model

### New table `oe.ProspectSources`

| Column | Type | Notes |
|---|---|---|
| `SourceId` | uniqueidentifier PK | |
| `TenantId` | uniqueidentifier FK Tenants | tenant isolation |
| `AgentId` | uniqueidentifier FK Agents | owner |
| `Name` | nvarchar(120) NOT NULL | also the per-partner label |
| `Tag` | nvarchar(60) NULL | optional grouping |
| `Type` | nvarchar(20) NOT NULL | `website` \| `landing` \| `api` |
| `DestinationUrl` | nvarchar(500) NULL | snapshot of chosen tenant destination (web types) |
| `LinkCode` | nvarchar(40) NULL | random suffix; public code = `<AgentCode>_<LinkCode>` |
| `ApiKeyId` | uniqueidentifier NULL FK TenantApiKeys | for `api` type |
| `Status` | nvarchar(20) DEFAULT 'active' | active \| archived |
| `CreatedBy` | uniqueidentifier NULL | |
| `CreatedDate` | datetime2 DEFAULT GETUTCDATE() | |
| `ModifiedDate` | datetime2 DEFAULT GETUTCDATE() | |

Indexes: `(TenantId, AgentId)`, unique `(TenantId, AgentId, LinkCode)` where
LinkCode not null.

### Alter `oe.Prospects`

- Add `SourceId uniqueidentifier NULL` (FK ProspectSources). Keep `Source` text
  column. When a lead arrives via a coded link/API, set both `SourceId` and
  `Source = ProspectSources.Name`.

### SQL migration

`sql-changes/2026-06-08-prospect-sources.sql` — **default dry-run / SELECT preview
enabled by default** per DB write policy. User executes the real write.

## Attribution / resolution flow

Shared resolver (new helper in `prospect.service.js`, e.g.
`resolveAgentAndSource(pool, tenantId, rawId)`):

1. `rawId = "MWA000124_a1b2c3"`. If it contains `_`, split into `agentCode` +
   `suffix`.
2. Resolve agent by `AgentCode`. Look up `ProspectSources` by
   `(TenantId, AgentId, LinkCode=suffix, Status='active')`.
3. Match → return `{ agentId, sourceId, sourceName }`. Stamp `SourceId` +
   `Source = sourceName` on the prospect.
4. No source match OR no underscore → existing agent-only behavior; `SourceId`
   null, `Source` = type default (`'MightyWELL Website'`).

Wire this into both `website-form-submissions.js` and `lead-ingest.js`.
`findOrCreateProspect()` gains an optional `sourceId` param and sets it on insert
(and on the `ProspectProducts` rows as today).

For `api` sources: the minted API key row carries the `SourceId` link (via the
new `ProspectSources.ApiKeyId`). `lead-ingest` looks up the source from the
authenticating key and stamps `SourceId` + `Source = sourceName`.

## Tenant settings extension

Extend `AdvancedSettings.marketingLink`:

```json
{
  "idParam": "id",
  "links": [ ... existing, kept for back-compat ... ],
  "destinations": [
    { "type": "website", "label": "MightyWELL Website", "url": "https://mightywellhealth.com/get-a-quote" },
    { "type": "landing",  "label": "Get-Covered Landing", "url": "https://mightywellhealth.com/get-covered" }
  ]
}
```

- `UnifiedTenantSettingsModal` (Marketing Links tab): add an editable list of
  typed destinations (type select + label + url). Persist via the existing
  `settings.js` route (extend its `marketingLink` validation/whitelist).
- New/extended endpoint to expose destinations to agents (extend
  `GET /api/me/agent/marketing-link` to also return `destinations` + `agentCode`).

## Backend API surface (new/changed)

New routes file `backend/routes/prospect-sources.js` mounted at
`/api/prospect-sources`:

- `GET /api/prospect-sources` — list current agent's sources (+ lead counts).
- `POST /api/prospect-sources` — create. Body: `{ name, tag?, type, destinationType? }`.
  - web types: pick a tenant destination by type/label, generate unique
    `LinkCode`, store `DestinationUrl`; return full link `<destUrl>?<idParam>=<AgentCode>_<LinkCode>`.
  - `api` type: mint an agent-scoped API key (reuse key-minting logic), link
    `ApiKeyId`; return the secret once.
- `PATCH /api/prospect-sources/:id` — edit name/tag (and destination for web types).
- `DELETE /api/prospect-sources/:id` — archive (and revoke linked API key for
  `api` type).
- Changed: `getProspectStats` gains `sourceId` filter; `/api/prospects/stats`
  accepts `sourceId`, `from`, `to`. List endpoint (`listProspects`) gains
  `sourceId` filter.

All routes enforce `requireTenantAccess` + agent ownership. Tenant isolation on
every query.

## Frontend

- **`ProspectsPage.tsx`:** add third tab **Sources**. Remove "Lead Ingest API"
  header button (move into Sources create flow).
- **New `ProspectSourcesTab.tsx`:** list of sources (Name, Type badge, Tag, link
  or API info, lead count) with copy/view/edit/archive; **Create Source modal**
  (`SourceCreateModal.tsx`) with Name + Tag + Type selector → website/landing
  (pick tenant destination, shows generated link) or api (shows key once).
- **`ProspectsInsightsTab.tsx`:** add source selector (All / specific) +
  date-range/month picker; per-source summary card; charts re-query selection.
- **`prospect.service.ts`:** add source CRUD + stats params.
- **Marketing page:** remove `WebsiteLinkCard` usage.
- UI per house rules: Tailwind only, Lucide icons, `oe-primary`/`oe-dark` brand
  colors, no toasts (inline/popup confirmations).

## MightyWELL website

- Merge `feat/ad-landing-page` → `main` (adds `/get-covered`). Deploy per
  `mightywell-site/CLAUDE.md` (Vite build → Bluehost, PM2 backend).
- No functional code change: composite `?id=<AgentCode>_<suffix>` is already
  captured and forwarded. Verify the full string reaches AA365 and resolves.

## Testing

- **Backend Jest:** unit tests for `resolveAgentAndSource`, source CRUD route,
  stats `sourceId` filter, lead-ingest + website-form attribution stamping
  `SourceId`.
- **Frontend Vitest:** `ProspectSourcesTab`, `SourceCreateModal`, insights
  source/date filtering.
- **Manual / localhost:** user tests end-to-end before any PR (per user request —
  **do not open a PR**).

## Out of scope / non-goals

- Backfilling `SourceId` for historical prospects (start fresh; legacy `Source`
  text preserved).
- Proposals flow (separate from lead ingestion).
- Changing the existing prospect-tag system.

## Rollout

1. SQL migration (user runs the write after reviewing the SELECT preview).
2. Backend + frontend on `feat/prospects/marketing-sources`.
3. MightyWELL merge + deploy.
4. Local end-to-end test handed to user. **No AA365 PR until user approves.**

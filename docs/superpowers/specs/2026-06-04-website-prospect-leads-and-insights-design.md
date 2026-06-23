# Website Prospect Leads + Centralized Agent Notifications + Source Tracking + Insights + Tenant API Keys

**Date:** 2026-06-04
**Branches:** `feat/prospects/website-leads-and-insights` (AB365), `feat/website-prospects` (MightyWELL site)
**Repos:** `allaboard365-wt1` (AB365) and `MightyWELL Website/mightywell-site`

## Summary

Today the MightyWELL website's quote/contact forms collect an advisor name, call AB365's
`POST /api/website-form-submissions` to look up the matching agent, then the **website itself**
builds and emails that agent the prospect's form info. No prospect record is created, and only
website leads ever notify an agent — leads from the API or manual import are silent.

This work establishes the long-term architecture: **AB365 owns prospect creation and agent
notification for every inbound channel**, the website becomes a thin submitter, lead sources are
tracked and visualized, and tenants self-serve a website API key from settings.

Eight deliverables:

1. **Auto-create a prospect** in AB365 whenever a website submission matches an agent — appears as
   a `New` prospect tagged source `MightyWELL Website`.
2. **Centralize the "new prospect" agent email in AB365** — fired from the single creation hook for
   **inbound** sources only (website + external API ingest), with per-tenant branding and a deep-link
   to the agent's Prospects tab. The website stops sending its own agent email.
3. **Skip notifications for agent-self-created prospects** — Manual create, Proposal, Quote do **not**
   email (the agent already knows). Only inbound channels notify.
4. **Per-agent opt-out** of the new-prospect email.
5. **Tenant-level "Website Integration" API key** — a TenantAdmin settings tab to mint/revoke a single
   key per tenant website (no per-agent keys for shared sites). Routing to the right agent stays
   dynamic (lookup by name/code), as it already works.
6. **Source tracking in the list** — Source column, filter, and sort on the Prospects page.
7. **Insights tab** — recharts dashboard (per-month stacked by source, source breakdown, status funnel).
8. **MightyWELL site** — read `prospectId`, stop sending the matched-agent email (AB365 does it now),
   keep the unmatched→support fallback; mirror changes into `server/deploy/`.

## Why this shape (architecture rationale)

- **A shared public website cannot use per-agent keys** — it would need every agent's secret. The only
  correct model is **one tenant key + dynamic agent lookup**, which `/website-form-submissions` already
  implements. Per-agent `/lead-ingest` keys remain for an *individual* agent's own external lead source.
- **All ingestion paths converge on `findOrCreateProspect()`** (`prospect.service.js:160`). Centralizing
  the notification there (gated by source) means every inbound channel notifies consistently, and we
  never duplicate or miss emails.
- **AB365 already has the full email stack** — SendGrid (`sendGridEmailService.js`), queue
  (`messageQueue.service.js`), templates (`emailTemplates.service.js`), per-tenant from-address/branding
  (`tenantEmailFrom.js`), agent-email resolution (pattern in `belowMinimumCheckService.js`), and portal
  link building (`utils/tenantAppUrl.js` → `buildTenantAppBaseUrl`). We reuse, not rebuild.

## What already exists (no change needed)

- `oe.Prospects.Source` — `NVARCHAR(40) NOT NULL DEFAULT 'Manual'`, **no CHECK constraint** → new value
  needs no DDL.
- `oe.TenantApiKeys` — `AgentId` is **NULLABLE**, `Scope NVARCHAR(40) NULL`, `Status` ∈ {active,revoked}.
  Tenant-level (agent-null) keys are already a supported concept; auth middleware
  (`middleware/auth.js:65-126`) resolves a null-agent key to tenant context; `/website-form-submissions`
  uses **only** `TenantId`. The *only* gap is a route/UI to mint a tenant-level key.
- `findOrCreateProspect()` — dedupe + member suggestion; accepts `source`, `agentId`, `status`.
- `GET /api/prospects` list with filters/sort/pagination + visibility scoping (`listProspects`).
- Prospects page with filters, sortable headers, metrics cards; `recharts@2.15.3` already a dependency.
- TenantAdmin settings modal `UnifiedTenantSettingsModal.tsx` (14 tabs) — natural home for a new tab.

## Decisions (locked)

| Fork | Decision |
|------|----------|
| Prospect creation | **AB365 server-side**, in `/website-form-submissions`, after a `matched` lookup. |
| Source value | Single string **`MightyWELL Website`**. |
| Unmatched submissions | **No prospect** (support-inbox fallback unchanged). |
| Email ownership | **AB365 centralizes**; website stops sending the matched-agent email. |
| Which sources notify | **Inbound only**: `MightyWELL Website`, `ApiIngest`. Manual/Proposal/Quote do **not** notify. |
| Opt-out | **Per-agent** preference (default ON). |
| Tenant website key | **Build the self-serve TenantAdmin settings UI now.** |
| Dashboard | **New "Insights" tab** on the Prospects page. |

## Architecture & components

### AB365 backend

**1. Create prospect on match** — `routes/website-form-submissions.js`
After the existing audit insert, when `matchStatus === 'matched'` && `matchedAgent.agentId`:
call `findOrCreateProspect({ tenantId, agentId, firstName/lastName (split from submitterName),
email, phone, referralName: attemptedAgentName, notes: company/state/formType/subject,
source: 'MightyWELL Website', status: 'New' })`. Return `prospectId` in the JSON.
Wrap in try/catch — a create error must never break the submission. Add `'MightyWELL Website'` to
`PROSPECT_SOURCES` in `prospect.service.js` (else `:225` coerces to `'Manual'`).

**2. Centralized notification** — new `services/prospectNotification.service.js` + hook
- `NOTIFY_SOURCES = ['MightyWELL Website', 'ApiIngest']` (inbound channels).
- Hook in `findOrCreateProspect`: when `created === true` && `agentId` && `NOTIFY_SOURCES.includes(source)`,
  fire `notifyAgentOfNewProspect({ tenantId, agentId, prospect }).catch(log)` — **non-blocking**.
- `notifyAgentOfNewProspect`: resolve agent email/name (Agents⋈Users); check per-agent preference
  (skip if OFF); build deep-link `${buildTenantAppBaseUrl(tenant)}/agent/prospects`; render template;
  `messageQueue.service.queueEmail({ tenantId, to, subject, html })` (per-tenant from/branding handled
  by the queue layer).
- New template `templates/emails/new-prospect-notification.html` + a `generateNewProspectNotification()`
  in `emailTemplates.service.js` (copy the `payment-failure-agent` pattern). Subject:
  `New prospect: <Name>`. Body: headline, prospect details, CTA button → Prospects tab.
- **Defensive:** if the preference column isn't present yet, treat as ON (mirrors auth.js fallback) so
  the flow works pre-migration on any DB.

**3. Per-agent notification preference**
- Migration `sql-changes/2026-06-04-agent-prospect-notify-pref.sql`: add
  `oe.Agents.NotifyNewProspectEmail BIT NULL` (NULL/1 = on, 0 = off). **Dry-run/SELECT-preview default
  per DB policy; not executed by Claude.**
- `GET/PUT /api/me/notification-preferences` (or extend an existing agent-settings route) to read/set it.
- Checked inside `notifyAgentOfNewProspect`.

**4. Tenant-level API key minting** — new `routes/tenant-api-keys.js`
- `POST/GET/DELETE /api/tenant-api-keys`, `authorize(['TenantAdmin','SysAdmin'])`.
- POST mints `sk_live_…` with `AgentId = NULL`, `Scope = 'website-integration'`, `KeyName` from body;
  returns the raw key **once**. GET lists (name, partial, status, lastUsed). DELETE sets `Status='revoked'`.
- Mirrors `agent-api-keys.js` minus the agent requirement. Register in `app.js`.

**5. Source filter/sort + stats** — `prospect.service.js` + `routes/prospects.js`
- `listProspects`: accept `source` filter → `AND Source = @source`; add `'source'` to the `sortBy` map.
- New `GET /api/prospects/stats` (same auth + visibility scoping as the list; optional `from`/`to`,
  default trailing 12 months; same `agentId`/`scope`/`agencyId`). Returns
  `{ bySourceMonth[], bySource[], byStatus[], totals }` via `SELECT … GROUP BY FORMAT(CreatedDate,'yyyy-MM'), Source/Status`.

### AB365 frontend

**6. Source column/filter/sort** — `ProspectsPage.tsx` + `prospect.service.ts` + `useProspects`
Add a Source `<select>` filter, a sortable "Source" column, thread the `source` param through.

**7. Insights tab** — `ProspectsInsightsTab.tsx` + `useProspectStats()`
Local tab switch on the page (List | Insights — no new route). recharts, brand colors via Tailwind vars:
- Per-month **stacked BarChart** by source (12 mo); **source breakdown** Pie/horizontal-bar; **status
  funnel** BarChart in lifecycle order. Reuse the page's agent/agency scope filters. Empty-state card.

**8. TenantAdmin "Website Integration" tab** — `UnifiedTenantSettingsModal.tsx` + service/types
New tab: create/list/revoke the tenant website key (reuse `LeadIngestModal` UI patterns:
generate, copy-once, list, revoke), show the `/api/website-form-submissions` endpoint + a sample
payload. Calls the new `/api/tenant-api-keys` routes.

**9. Agent notification toggle** — agent settings/profile UI
A single checkbox "Email me when I get a new prospect" wired to `/api/me/notification-preferences`.

### MightyWELL site (`mightywell-site`)

**10.** `server/agentLookup.js` `logSubmission()`: thread through `prospectId` (informational).
**11.** `server/emailService.js`: **remove the matched-agent email send** — AB365 now notifies the
agent. Keep the **unmatched → `NOTIFY_EMAIL` support** path. User still sees the on-page confirmation.
**12.** Mirror all server changes into `server/deploy/` (Node 16 / CommonJS).
- The website no longer needs `AGENT_PORTAL_URL` (AB365 builds the link). No new website secrets.

## Data flow (matched website submission)

```
User submits form (advisorName/advisorId)
  → MightyWELL server POST /api/website-form-submissions (tenant website key)
      → AB365 resolveAgent() → matched
      → AB365 insert audit row
      → AB365 findOrCreateProspect(source='MightyWELL Website', agentId, status='New')   [NEW]
            → created && inbound source && agent pref ON
                 → queue "New prospect" email to agent (tenant branding + portal link)   [NEW, centralized]
      → returns { submissionId, matchStatus, agent, prospectId }
  → MightyWELL: NO agent email (AB365 sent it); shows user confirmation                  [website email removed]
  → agent receives email → opens Prospects tab → NEW prospect, Source='MightyWELL Website'
  → agent filters/sorts by Source; views Insights dashboard
```

## Testing

- **AB365 backend (Jest):** submissions route create-on-match (matched→prospect w/ right source/agent;
  unmatched→none; create error→submission still 200). Notification hook fires for inbound sources only,
  skips Manual/Proposal, skips when pref OFF, non-blocking on email failure. `tenant-api-keys` mint/list/
  revoke + role gating + `AgentId=NULL`. `listProspects` source filter/sort. `/prospects/stats`
  aggregation + visibility scoping.
- **AB365 frontend (Vitest):** Source column/filter render; Insights charts from mocked stats +
  empty-state; Website Integration tab create/list/revoke; notification toggle.
- **MightyWELL (unit):** matched path sends no agent email; unmatched still emails support.
- **Manual / local:** AB365 on a free localhost port; MightyWELL `AA365_API_URL` → it; submit a quote
  with a known agent name → prospect appears NEW w/ correct source AND the agent notification email is
  generated with the portal link; flip the agent pref OFF → no email.

## Out of scope (YAGNI)

- Employer submissions → company-level `GroupProspects` (regular prospect + company in notes for now).
- Backfilling historical `WebsiteFormSubmissions` into prospects.
- Additional website source values for other tenants (single `MightyWELL Website` for now).
- Index on `oe.Prospects.Source` (add later only if the stats query is slow in prod — separate dry-run migration).
- Migrating existing agent `/lead-ingest` keys (both key models coexist unchanged).

## Risk / policy notes

- **No DB writes by Claude.** One DDL migration (the agent-preference BIT column) ships as a
  **dry-run/SELECT-preview script**; it is **not executed** without explicit approval. All other writes
  go through the running app's existing service paths. The notify hook is defensive so it works before
  the migration is applied.
- **Tenant API keys** reuse the existing `oe.TenantApiKeys` table — **no DDL** (AgentId already nullable,
  Scope already present).
- **MightyWELL production deploy** (build `dist/` + push `server/deploy/` + PM2 restart) happens only
  after local verification and explicit user go-ahead.
- **Double-email guard:** the website's matched-agent email is removed in the *same* change that adds
  AB365's notification, so there's never a window where both (or neither) send for matched leads.
```

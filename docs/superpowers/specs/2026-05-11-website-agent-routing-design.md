# MightyWELL Website — Agent-Routed Quote Submissions (Phase 1)

## Problem

`mightywellhealth.com` quote submissions go to one fixed support inbox today. We want to route the email to the specific MightyWELL agent referenced in the URL, with the support inbox CC'd as a safety net.

## Solution overview

Two URL params on the website (`?id=<AgentCode>` and/or `?name=<First Last>`) identify the agent. The MightyWELL Express server resolves the param against AllAboard365 via an authenticated server-to-server lookup, then sends the SendGrid email TO the agent, CC `joey@mightywell.us` + existing support. If lookup fails or no agent is named, the email goes only to support (existing behavior), with the attempted value noted in the body.

This touches two repos:

- **AllAboard365** (this repo): one new tenant-scoped read-only endpoint, reusing the existing API-key middleware.
- **MightyWELL website** (`~/Documents/MightyWELL Website/mightywell-site/`): three small changes — form picks up the new params, server resolves them, email recipients adjust.

Phase 2 (link-attribution tracking through to enrollment) is out of scope here, but the data we capture in phase 1 (AgentCode, AgentId returned from lookup) is enough that phase 2 only needs to add storage.

## URL contract

| Param | Meaning | Notes |
|---|---|---|
| `?id=<AgentCode>` | Preferred. Unique. | e.g. `?id=JDESAI` |
| `?name=<First Last>` | Fallback for hand-typed links. | URL-encoded space ok |
| `?agent=<value>` | **Backwards-compat alias for `?name=`.** | Existing links keep working |

Precedence on the backend: `id` first, then `name`. If both are present, both are tried in order; the first one to resolve wins.

## AllAboard365 changes

### New route: `GET /api/agent-lookup`

- **File:** `backend/routes/agent-lookup.js` (new)
- **Auth:** existing `authenticate` middleware from `middleware/auth.js`. The MW server sends `Authorization: Bearer sk_live_...` using a `TenantApiKeys` row provisioned for the MightyWELL tenant. The middleware sets `req.user.TenantId` automatically — no new auth code needed.
- **Query params:** `id` (AgentCode), `name` (full name). At least one required.
- **Tenant scoping:** every SQL query filters `WHERE a.TenantId = @tenantId` using `req.user.TenantId`. No way for the MW key to read another tenant's agents.
- **Match rules:**
  - `id` → case-insensitive exact match on `oe.Agents.AgentCode` where `Status='Active'`.
  - `name` → split on whitespace; case-insensitive match on `Users.FirstName + ' ' + Users.LastName` where `Agents.Status='Active'`. **Multiple matches → return `found:false, reason:'ambiguous_name'`.**
- **Response shape:**
  ```json
  // success
  { "success": true, "found": true, "agent": {
      "agentId": "uuid", "agentCode": "JDESAI",
      "displayName": "Joey Desai", "email": "joey@..."
  }}
  // miss
  { "success": true, "found": false, "reason": "not_found" | "ambiguous_name" }
  ```
- **Mount in `app.js`:** `app.use('/api/agent-lookup', authenticate, require('./routes/agent-lookup'));`

### API key provisioning (manual / one-time)

Generate one API key for the MightyWELL tenant. The hash goes in `oe.TenantApiKeys`; the raw `sk_live_...` value goes into the MW server's env as `AA365_API_KEY`. Done via the existing tenant admin UI or a one-line SQL insert — not part of this codebase change.

## MightyWELL website changes

(Repo: `~/Documents/MightyWELL Website/mightywell-site/`)

### 1. `src/components/quote/QuoteForm.jsx`

Replace the `useEffect` at lines 122–134 (current `?agent=` reader) with:

- Read `?id`, `?name`, and `?agent` (alias for `name`) from the URL.
- If `?name`/`?agent` is set → prefill `advisorName` as today and `hasAdvisor='yes'`.
- If `?id` is set → store it in form state as a hidden field (`advisorId`) and `hasAdvisor='yes'`. No visible UI change.
- Submit both `advisorId` and `advisorName` in the payload.
- SessionStorage: store `mw_agent_id` and `mw_agent_name` separately so attribution survives navigation across both forms.

App-wide attribution in `App.jsx` (if any global handler exists today) gets the same dual-key treatment.

### 2. `server/deploy/index.js`

In the `POST /api/submissions/quote` handler, between Turnstile verification and `submitQuote(data, file)`:

- If `data.hasAdvisor === 'yes'` and (`data.advisorId` || `data.advisorName`), call `lookupAgent({ id, name })`.
- Pass the lookup result (success or miss) as a new arg into `submitQuote(data, file, routing)`.
- On lookup HTTP failure: log, treat as a miss — never fail the submission.

Same pattern for `POST /api/submissions/contact`.

### 3. `server/deploy/agentLookup.js` (new)

Small helper module. Uses `node-fetch` (already a dep). Honors `AA365_API_URL`, `AA365_API_KEY` env vars. Single function:

```js
async function lookupAgent({ id, name }) {
  // Returns { matched: true, agent: {...} }
  //      or { matched: false, reason: 'not_found'|'ambiguous_name'|'unconfigured'|'error', attempted: '...' }
}
```

If env vars are missing, returns `unconfigured` and submission proceeds with the support-only path. This means the website keeps working in any environment that hasn't been wired up yet.

### 4. `server/deploy/emailService.js`

Update `submitQuote(data, file, routing)` (new third arg) and `submitContact(data, routing)`:

- **Matched:** `to = [agent.email]`, `cc = [joey@mightywell.us, ...existing NOTIFY_EMAIL list]`. Add a "Routed to" row in the HTML.
- **Miss/no advisor:** `to = NOTIFY_EMAIL list` (unchanged). If the visitor *attempted* an agent, add a red "Attempted agent: X — NOT FOUND" row so support knows to investigate the link.
- Subject prefix when routed to agent: `[Agent: <displayName>] New ... Quote Request — <Name>`.

Update the SendGrid `sendEmail` helper to accept a `cc` array and add it to `personalizations[0].cc` when provided.

### Env

Add to MW server's PM2 env (`.env` on Bluehost):
- `AA365_API_URL` — `https://api.allaboard365.com/api`
- `AA365_API_KEY` — the `sk_live_...` key generated above

## Failure modes

| Scenario | Behavior |
|---|---|
| No `?id`/`?name`/`?agent` in URL, user doesn't check "yes" to advisor | TO support only (today's behavior) |
| User typed a real advisor name in the form, no URL param | Look up by name; matched → TO agent CC support; unmatched/ambiguous → TO support with "Attempted: X — NOT FOUND" |
| `?id=JUNK` | Lookup returns `not_found` → TO support, body notes "Attempted: JUNK — NOT FOUND" |
| `?name=John Smith` with two active John Smiths | Lookup returns `ambiguous_name` → TO support, body notes "Attempted: John Smith — AMBIGUOUS" |
| AA365 unreachable | MW server logs, sends to support fallback. Submission never fails on the visitor's side |
| `AA365_API_KEY` not set | Same as AA365 unreachable — support fallback |

## Out of scope (Phase 2+)

- Storing quote submissions inside AllAboard365 (lead tracking)
- Linking those leads to the enrollment they eventually became
- Agent-portal UI for "generate my marketing link"
- Marketer / non-agent attribution codes
- A `/landing/:slug` page on the website

These will reuse the same AgentCode-based URL contract.

## Implementation order

1. AA365: add route + register in `app.js`. Test locally with curl.
2. Provision MightyWELL tenant API key. Capture raw key.
3. MW server: add `agentLookup.js`, update `emailService.js` for cc + routing.
4. MW server: wire lookup into `index.js` quote handler.
5. MW frontend: update `QuoteForm.jsx` for `?id`/`?name` and pass through.
6. Test end-to-end in dev (`dev.mightywellhealth.com`) with a real agent's AgentCode.
7. Deploy to prod.

# Columbus for the Agent Portal — Design

**Date:** 2026-05-22
**Status:** Approved design, pending spec review
**Spans two repos:**
- `allaboard365-wt1` (this repo) — the widget UI + product-scope plumbing
- `columbus-api` at `/Users/rova/Documents/Columbus The Navigating Turtle/columbus-api` — the AI "brain" (system prompt, retrieval, stats)

## Goal

Give agents the same bottom-right Columbus chat assistant that members have, with
identical styling, but trained for agents:

- **Answer product questions** about the products the agent has access to and sells —
  both individual and group — including the differences between them.
- **MightyWELL basics** (inherited from the existing base prompt), same as the member portal.
- **Navigation coaching** for the agent portal: how to build/send a quote, where the
  Resource Library is, where each tab lives, and **how to find their commissions**.
- **Hard guardrail (leak prevention):** Columbus must NOT reveal or compute commission
  amounts, downline data, or any member/group data the agent has enrolled. When asked,
  it explains *where to navigate* to find those things — it never surfaces the data
  itself. This prevents accidentally leaking wrong commissions to downlines.

## Non-goals

- Columbus does not pull commissions, payments, member, or group records. It is wired
  only to product knowledge chunks, so it *cannot* leak that data — by construction.
- Columbus does not quote prices (the portal's Quote tool does that). The existing
  "never quote specific monthly prices" guardrail stays.
- No server-side product-scope validation in this phase (see Security tradeoff).

## How the member flow works today (reference)

1. AA365 member widget POSTs `{ message, conversationHistory, clientApp: 'aab-member-portal' }`
   plus the member's Bearer token to Columbus `/api/columbus/chat`.
2. Columbus validates the token against AA365 `/api/me/member/*`, learns the member and
   their enrolled products, retrieves product chunks scoped to those products, assembles a
   system prompt (`prompts/system.txt` + a branch keyed on `user.level` and `clientApp`),
   and streams the answer back over SSE.
3. Stats are tracked per `user.level` (`anonymous` / `authenticated` / `admin`) in
   `data/usage-log.json`. Ratings forward to AA365 `POST /api/ai/chunk-ratings`.

Two facts drive the agent design:
- An agent's token is **not** a member token. Validating it against `/api/me/member/*`
  fails, so without changes an agent falls back to `anonymous`.
- Columbus already accepts an optional `productIds[]` in the `/chat` body. The member
  widget doesn't send it (products come from the member token). **Agents will send it**
  — this is the "frontend passes scope" approach.

## Architecture / data flow (agent)

```
AgentLayout (this repo)
  └─ AgentColumbusChatWidget   (gated to userType === 'Agent')
       ├─ useAgentProducts()  → GET /api/me/agent/products  (individual + group)
       │     → product IDs (scope) + product names (suggested prompts)
       └─ useColumbusChat({ clientApp: 'aab-agent-portal', productIds })
             └─ POST {columbusUrl}/chat
                   { message, conversationHistory, clientApp:'aab-agent-portal', productIds }
                   Authorization: Bearer <agent token>

Columbus /chat
  ├─ auth.js: member-validate fails → agent-validate via GET /api/me/agent/profile
  │             → req.user.level = 'agent' (+ agentId, firstName, tenantId)
  ├─ chat.js: level==='agent' → retrieve chunks for body.productIds (frontend scope)
  │             → system prompt = system.txt + AGENT branch + data/aab-agent-portal.md
  ├─ usage.js: count under 'agent'
  └─ stream answer back (SSE), same as member
```

## Part A — Columbus repo (`columbus-api`)

### A1. Recognize agents — `middleware/auth.js`
After the existing AA365 member-token attempt fails (and before/around the ShareWELL
fallback), try `GET {ALLABOARD_API_URL}/api/me/agent/profile` with the same Bearer token.
On HTTP 200, set:
```js
req.user = {
  level: 'agent',
  platform: 'agent-portal',
  agentId: <from profile>,
  firstName: <from profile>,
  tenantId: <from profile>,
  token,
};
```
This validates the agent is real, so `agent` stats are as trustworthy as `authenticated`,
with **zero new AA365 backend code** (reuses the existing `/api/me/agent/profile`).
Greeting personalization is rendered client-side (the widget already knows the name), so
Columbus does not depend on the profile for the greeting.

### A2. Scope chunks to passed products — `routes/chat.js`
Add an `agent` branch in the chunk-selection logic (near the existing
member/admin/anonymous branches). For `user.level === 'agent'`, retrieve chunks via
`loadChunks(productIds)` using the `productIds` from the request body. No member-enrollment
derivation. If `productIds` is empty/missing, fall back to retrieving no product-specific
chunks (Columbus still answers MightyWELL-basics from the base prompt / website context).

### A3. Agent system-prompt branch — `routes/chat.js`
Add `else if (user.level === 'agent')` to the system-prompt assembly that **reframes**
Columbus from "helping a member" to "helping a MightyWELL sales agent":
- The agent sells MightyWELL products; help them understand the products in their scope
  and the **differences** between them so they can advise clients.
- Inherit MightyWELL basics and the medical/topic guardrails from `system.txt`.
- **Quoting:** explain how to build and send a quote using the Quote tab — do not produce
  prices or a quote yourself.
- **Commissions / member / group data — HARD NO:** never state, compute, estimate, or
  summarize commission amounts, payout figures, downline numbers, or any specific member
  or group the agent has enrolled. If asked, explain *where to navigate* (e.g., the
  Commissions tab) and stop. Phrase as navigation help, never as data.
- Keep the existing "never quote specific monthly prices" rule.
- Inject the agent nav guide (A4) as the navigation reference and adapt the NAV BUTTON
  PROTOCOL paths to agent-portal routes.

### A4. Agent nav guide — `data/aab-agent-portal.md` (new)
Mirror `data/aab-member-portal.md`. Document each agent tab and what lives there, so
Columbus can coach navigation:
- Dashboard `/agent/dashboard`
- Products `/agent/products`
- **Quote** `/agent/marketing` (build and send proposals)
- Resource Library `/agent/resource-library`
- My Groups `/agent/groups`
- My Members `/agent/members`
- Enrollment Links `/agent/enrollment-links`
- Agents `/agent/agents`
- **Commissions** `/agent/commissions` (Payouts / Payments / Awaiting tabs)
- Billing `/agent/billing`
- Training `/agent/training`
- Settings `/agent/settings`

Load it in `routes/chat.js` with the same try/catch pattern as the existing guides and
inject it when `clientApp === 'aab-agent-portal'`.

### A5. Stats — new `agent` user level
- `services/usage.js`: add `agent` to the daily counters alongside
  `anonymous` / `authenticated` / `admin`.
- `middleware/rateLimit.js`: add agent limits (proposed 25/min, 150/hour — between
  authenticated and admin; final numbers confirmed in the plan).
- Ratings already forward `userLevel`; ensure `'agent'` flows through to
  `POST /api/ai/chunk-ratings`.

### A6. Feedback label — `routes/feedback.js`
Add `'aab-agent-portal': 'AllAboard365 agent portal'` to `CLIENT_LABELS` so
"wrong answer" reports are labeled correctly.

## Part B — AA365 repo (this repo) — the widget

Approach: **generalize the shared components** so both portals reuse one widget core and
the same CSS (identical look). Keep the working member widget behavior unchanged.

### B1. Generalize presentational components
- `components/columbus/ColumbusWindow.tsx` and `ColumbusFab.tsx`: drive portal-specific
  copy through props that mostly already exist (greeting text, suggested prompts,
  disclaimer). Replace member-hardcoded greeting copy with a `greeting` prop.
- Reuse `ColumbusWidget.css` verbatim — no style divergence.

### B2. Shared orchestrator core
Extract the shared guts of `ColumbusChatWidget.tsx` (open/close + localStorage, message
state, streaming, rating, report wiring) into a reusable core that takes config:
`{ enabled, clientApp, productIds, greeting, suggestedPrompts, firstName }`. Member and
agent widgets become thin wrappers over this core. Goal: no behavior change for members.

### B3. `useColumbusChat` options
Add two options:
- `clientApp` (string) — defaults to `'aab-member-portal'` to preserve current behavior.
- `productIds` (string[] | undefined) — when present, included in the `/chat` request
  body (Columbus already reads it).

### B4. `AgentColumbusChatWidget` (new)
- Gated to `userType === 'Agent'` (mirror the member role check).
- Fetch the agent's products via the existing `useAgentProducts` hook
  (`/api/me/agent/products`), covering individual + group (`salesType`).
- Pass product IDs as scope; build agent-flavored suggested prompts, e.g.
  "What's the difference between {A} and {B}?", "How do I send a quote?",
  "Where do I find my commissions?", "What products can I sell?".
- `clientApp: 'aab-agent-portal'`; greeting addressed to the agent by first name.

### B5. Mount
Render `<AgentColumbusChatWidget />` in `components/agent/AgentLayout.tsx`, mirroring
`components/member/MemberLayout.tsx:113`.

### B6. Backend
None required for the core flow. Columbus reuses the existing `/api/me/agent/profile`
(identity) and `/api/ai/chunks` (knowledge).

## Security model & tradeoff

- Columbus for agents is wired only to **product knowledge chunks**. It has no path to
  commissions, payments, members, or groups, so it cannot leak them; it can only point
  the agent at the right tab. This directly satisfies the "don't leak commissions to
  downlines" requirement.
- **Accepted tradeoff (decided):** the agent frontend passes the product scope and
  Columbus trusts it. A hand-crafted request could request chunks for products the agent
  doesn't sell. Product chunks are low-sensitivity marketing/FAQ content; the only
  exposure is mild cross-tenant product-FAQ leakage. Optional future hardening: have
  Columbus intersect requested IDs with the agent's allowed products (server-side). Out
  of scope for this phase.

## Testing

- **AA365 (this repo):** Vitest unit test for `AgentColumbusChatWidget` (renders for
  Agent, hidden for non-Agent; sends `clientApp:'aab-agent-portal'` and product IDs).
  Confirm member widget behavior is unchanged after the shared-core refactor (existing
  member Columbus tests, if any, still pass).
- **Columbus:** unit/integration coverage for the agent branch — auth resolves
  `level:'agent'` on a valid agent token; agent chunk-scoping uses body `productIds`;
  agent system-prompt branch + nav guide are injected; usage counts under `agent`.
- Manual: log in as an agent, confirm the bottom-right widget matches the member styling,
  ask a product-difference question (correct answer), ask "what are my commissions" (gets
  navigation help, not figures), ask "how do I quote someone" (Quote-tab walkthrough).

## Open items resolved in brainstorming

- Two repos; we edit both. ✅
- Track agents as a new `agent` user level for stats. ✅
- Frontend passes product scope; trust it for now. ✅
- Generalize shared components rather than duplicate. ✅

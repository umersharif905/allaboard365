# Agent Website Link Generator (Phase 2)

## Goal

In the agent portal's Marketing page (under the existing Quick Quote / Individual Proposal / Business Proposal buttons), add a "Website Link" section that gives the agent a copy-able URL pointing at the tenant's website with their AgentCode pre-attached for attribution.

Tenant-configurable so the same code works for any tenant (not hard-coded to MightyWELL's param names).

## What's already in place

- `oe.Tenants.Website` — base URL (e.g. `https://mightywellhealth.com`). Editable in tenant settings UI today.
- `oe.Tenants.DefaultUrlPath` — path (e.g. `/get-a-quote`). Editable today.
- `oe.Tenants.AdvancedSettings` — JSON column for arbitrary tenant config. `TenantSettings.tsx:636-638` already serializes and saves it.
- `GET /api/me/tenant-admin/settings` (`backend/routes/me/tenant-admin/settings.js`) — accessible to Agents (line ~33 `authorize(['TenantAdmin', 'Admin', 'SysAdmin', 'Agent'])`). Returns website, defaultUrlPath, and parsed AdvancedSettings.

So no schema change, no new endpoint required.

## Design

### Tenant config (new key in `AdvancedSettings` JSON)

```json
{ "marketingLink": { "idParam": "id" } }
```

Default when unset: `idParam = "id"`. That's what MightyWELL's website already accepts (from phase 1).

A tenant that wants `?agentid=` instead would set `idParam: "agentid"`. The website on the receiving end is the tenant's problem to configure separately — we just emit whatever they tell us.

### Link format

```
<Website><DefaultUrlPath>?<idParam>=<AgentCode>
```

If `Website` is unset → show a placeholder card with "Configure the tenant Website in Tenant Settings first." If `AgentCode` is missing on the user → render the card disabled.

### Backend

- **Read path:** `GET /api/me/tenant-admin/settings` — extract `marketingLink.idParam` from `AdvancedSettings` and include it in the response payload as `marketingLinkIdParam` (default `"id"`).
- **Write path:** the existing PUT (whichever route serializes `AdvancedSettings` from `TenantSettings.tsx:638`) — pass through the new `marketingLink.idParam` field, defaulting to `"id"` when unset.

### Frontend

- **New component** `frontend/src/components/marketing/WebsiteLinkCard.tsx`. Inputs: `website`, `urlPath`, `idParam`, `agentCode`. Renders a card matching the existing `bg-white rounded-lg border border-gray-200 p-6` style with:
  - Heading "Your Website Link"
  - Disabled `<input>` showing the full URL
  - "Copy" button that calls `navigator.clipboard.writeText(url)`. On success → swap the button label to "Copied ✓" for ~2 seconds (inline confirmation, no toast).
  - Disabled state with explanatory text when website/agentCode are missing.
- **Mount** in `MarketingPage.tsx` immediately after the buttons card (currently at line 789-823, before line 824 closing `</>`).
- **Data flow:** MarketingPage already has access to the auth context (`useAuth`). Fetch:
  - Tenant settings (website, defaultUrlPath, marketingLinkIdParam) — via existing `GET /api/me/tenant-admin/settings` once on mount. (No existing hook — write a tiny inline React Query hook or just `useEffect`.)
  - AgentCode — check if it's already on `user` from `useAuth`. If not, hit `GET /api/me/agent/profile` or whatever exposes it.
- **Tenant Settings UI** (`TenantSettings.tsx` and its edit modal/section): add a text input "Agent Link ID Parameter" near the existing Website + DefaultUrlPath fields. Default `"id"`. Save to `AdvancedSettings.marketingLink.idParam`.

### Out of scope (Phase 3)

- Tracking which leads / enrollments came in from which agent link (analytics)
- Marketer / non-agent attribution codes
- Custom landing pages per agent
- Link-shortener / branded short URLs

## Implementation order

1. Backend `settings.js`: parse + emit + accept the new `marketingLinkIdParam` field.
2. Frontend `WebsiteLinkCard.tsx`: build the component standalone.
3. Frontend `MarketingPage.tsx`: fetch settings + AgentCode, mount the card.
4. Frontend `TenantSettings.tsx`: add the input field for tenant admins.

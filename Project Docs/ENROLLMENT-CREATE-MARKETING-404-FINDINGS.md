# Create-Marketing 404 – Findings and Fix

## What we confirmed (using backend DB)

Ran `node ai_scripts/check-enrollment-create-marketing.cjs` against the **same DB as the backend** (backend/.env):

1. **oe.EnrollmentLinks.AgentId** – `IS_NULLABLE= YES` ✅ (no schema change needed for agency-only links).
2. **Agency 38AA6EB4-3BC1-450E-87F1-8984A4B916C5** – **exists** in `oe.Agencies`, TenantId = 349AF85B..., Status = Active, OwnerAgentId = NULL.
3. **Template A6942A94-59F2-40B0-89A9-041B1024FE69** – **has AgencyId = 38AA...**, AgentId = NULL.

So the DB is correct: the agency exists, the template is linked to it, and `EnrollmentLinks.AgentId` allows NULL.

## Likely cause of the 404

The backend that was running was probably **old code** (no “resolve from template first” logic) or the handler wasn’t the one actually hit. With the current code, create-marketing:

1. Loads the template (including `AgencyId` / `AgentId`).
2. Uses **template’s AgencyId** to look up the agency (no tenant filter).
3. That lookup should find the Alioup agency.

If the server wasn’t restarted after these changes, it would still run the old path and can return 404.

## Code changes made

1. **Template lookup** – Use `template.AgencyId ?? template.agencyid` (and same for AgentId) so it works whether the driver returns PascalCase or lowercase.
2. **Logging** – At the start of the handler: `CREATE-MARKETING-HANDLER-HIT`. After loading the template: `create-marketing: template loaded` with `templateId`, `templateAgencyId`, `templateAgentId`, and `keys: Object.keys(template)` so you can see exactly what the backend sees.
3. **Diagnostic script** – `ai_scripts/check-enrollment-create-marketing.cjs` uses backend’s .env and checks schema + agency + templates. Run anytime with:
   - `node ai_scripts/check-enrollment-create-marketing.cjs`

## What you need to do

1. **Restart the backend** so it loads the latest code (no cache, no old process).
2. Trigger “Create marketing link” again (e.g. create template + marketing link, or Send Link on an existing template).
3. **Watch the backend console** when you do it. You should see:
   - `CREATE-MARKETING-HANDLER-HIT`
   - `create-marketing: template loaded` with `templateAgencyId: 38AA6EB4-...` and the template’s `keys`.

If you still get 404:

- If you **don’t** see `CREATE-MARKETING-HANDLER-HIT`, the request is not reaching this handler (e.g. wrong URL, different app, or route order).
- If you **do** see it but `templateAgencyId` is null/undefined, the log’s `keys` will show the actual column names from the DB so we can fix the property name.

## Re-running DB checks (optional)

From repo root, same DB as backend:

```bash
node ai_scripts/check-enrollment-create-marketing.cjs
```

With bash (e.g. Git Bash):

```bash
bash ai_scripts/db-query.sh "SELECT AgencyId, TenantId, AgencyName, Status FROM oe.Agencies WHERE AgencyId = '38AA6EB4-3BC1-450E-87F1-8984A4B916C5'"
```

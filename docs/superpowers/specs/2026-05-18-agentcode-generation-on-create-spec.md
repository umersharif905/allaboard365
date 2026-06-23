# AgentCode Generation On Agent Creation — Problem Spec

**Date:** 2026-05-18
**Status:** Ready to implement
**Reporter:** Joey (via investigation with Claude on 2026-05-18)
**Severity:** Production bug — blocks marketing-link feature for any agent created on/after 2026-05-08

## TL;DR

The `marketingLink` feature (PR #374, `feat/website-agent-routing`) requires `oe.Agents.AgentCode` to be non-null in order to render the per-agent URL on the AA365 Marketing page. **None of the standard create-agent code paths populate `AgentCode`** — they all leave it `NULL`. Historically, the column was kept populated by a manual/external backfill, which stopped running on or around **2026-05-08**. Since then, every newly created agent has `AgentCode = NULL` and gets the gray "We couldn't find your Agent Code. Please contact your administrator." message in the Marketing page's `WebsiteLinkCard`.

This affects at least 9 MightyWELL agents in production today, including `joey+agent@mightywell.us` (a downline under `agent@allaboard365.com` / Jeremy Francis), which is what triggered this investigation.

## Symptoms

1. Log in to the AA365 portal (production) as a recently-created agent, e.g. `joey+agent@mightywell.us`.
2. Go to the **Marketing** page (`/marketing` or wherever `MarketingPage.tsx` is mounted).
3. The "Your Website Links" card appears but shows:
   > We couldn't find your Agent Code. Please contact your administrator.
4. The agent's link to the MightyWELL website (`https://mightywellhealth.com/get-a-quote?id=…`) cannot be generated. Quote submissions on that site therefore can't be attributed to this agent, and the "matched agent → TO agent only" routing in the MightyWELL backend never fires for their leads — emails fall back to `NOTIFY_EMAIL` (support).

## Evidence (production DB, queried 2026-05-18)

Query connection: `allboard-prod.database.windows.net` / `allaboard-prod`, user `allaboardadmin` (creds in `ai_scripts/.env` under `DB_USER` / `DB_PASSWORD`; override `DB_NAME=allaboard-prod` to hit prod — note `db-query.sh` sources `.env` so override needs to be done by running `node` directly, see "Re-running the investigation" below).

### joey+agent specifically

```
User row     UserId C8DB0BA1-D855-4410-ABFC-57B1C426845A   Email joey+agent@mightywell.us
Agent row    AgentId 1787BD6E-3CBE-409A-B27B-2F1D50933A36  Status Active, AgentCode = NULL
AgencyId     4532C6DC-1290-4A4A-A1A7-533497694265           (same as upline)
Role         "Agent"                                        (correct)
Hierarchy    HierarchyId exists, ParentId = Jeremy's AgentId, Status Active
Upline       agent@allaboard365.com (Jeremy Francis)        AgentCode = AG18903513
```

Every other gate the marketing-link feature checks passes — the only missing piece is `AgentCode`.

### Scope across MightyWELL in prod

| | Count |
|---|---|
| Total MW agents | 185 |
| AgentCode populated | 176 |
| **AgentCode NULL** | **9** |

All 9 NULL-code agents were created on or after **2026-05-08**:

| Created (UTC) | Name | Email |
|---|---|---|
| 2026-05-18 | Joey Desai | joey+agent@mightywell.us |
| 2026-05-17 | Cody Laabs | laabsagency@gmail.com |
| 2026-05-15 | Bijan Hedayati | bijanins@gmail.com |
| 2026-05-12 | Jose Cuenca | jcuen001@gmail.com |
| 2026-05-11 | Nicolas Perez | nicperez96@yahoo.com |
| 2026-05-09 | Amanda Figueroa | amandafigueroa1224@gmail.com |
| 2026-05-09 | David Mendez | davidmendezsog@gmail.com |
| 2026-05-09 | Christy Burton | mybenefitsmatter@gmail.com |
| 2026-05-08 | Elisabeth Aragon | e.vogels@mac.com |

Other tenants may have the same issue — this spec only audited MightyWELL. Step 0 of the fix should re-query for `WHERE AgentCode IS NULL AND CreatedDate >= '2026-05-01'` across all tenants to see the full backfill scope.

### Why this is happening — root cause

Schema check (prod):

```sql
SELECT COLUMN_NAME, IS_NULLABLE, DATA_TYPE, COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA='oe' AND TABLE_NAME='Agents' AND COLUMN_NAME='AgentCode';
-- nvarchar, nullable, COLUMN_DEFAULT = NULL

SELECT name FROM sys.triggers WHERE parent_id = OBJECT_ID('oe.Agents');
-- 0 rows
```

So **no default, no trigger**. Whatever populated AgentCode historically lived outside SQL.

Code search (`grep -rnE "AgentCode" backend/ --include="*.js"`, excluding node_modules):

| File | Line | Purpose | Sets AgentCode? |
|---|---|---|---|
| `backend/routes/tenant-admin-agents.js` | 1755 (route), 1975 (INSERT) | `POST /api/tenant-admin/agents` — tenant admin / sysadmin creates an agent (the most-used flow, used to create downlines) | **NO** |
| `backend/routes/users.js` | 588 | Inside `POST /api/users` — when creating a user with the Agent role | **NO** |
| `backend/routes/users.js` | 962 | Inside `PUT /api/users/:id` — when adding the Agent role to an existing user | **NO** |
| `backend/services/shared/user-management.service.js` | 1384 | `createAgentRecord` helper used by user-management flows | **NO** |
| `backend/routes/public/onboarding.js` | 915 | Public agent onboarding session completion (`/api/public/onboarding/*`) | **NO** |
| `backend/services/onboardingLinkService.js` | 525 | Agent onboarding via OnboardingLink completion | **NO** |
| `backend/services/agencyAdminProvisioning.service.js` | 225, 433, 863 | Agency-admin duplicate flow — generates a `DUP{base36-timestamp}…` code at line 341 | **Yes — DUP prefix, intentional, do not change** |

All non-DUP paths leave `AgentCode = NULL`. Until ~2026-05-08, an admin (or external script) appears to have backfilled codes regularly — see the gap between the most-recent populated `AG18903688` (created 2026-05-07T15:56Z) and joey+agent created 2026-05-18T13:45Z with NULL. The backfill script is not in this repo (grep across `sql-changes/` and `backend/` returns no AgentCode-generating SQL).

### Existing AgentCode pattern

From `oe.Agents` in prod, scoped to codes that exist today:

- Format: `AG` + 8 decimal digits (e.g., `AG18903688`, `AG18903513`).
- **Globally sequential** across all tenants — the codes are unique across the whole table and increase monotonically with `CreatedDate`, not per-tenant.
  - Confirmed: `MIN AgentCode = AG18903510`, `MAX AgentCode = AG18903688`, `COUNT(*) = 179` (no per-tenant resets visible in the MW sample).
  - 181 distinct codes / 181 total → uniqueness is enforced by data (probably not by constraint; verify with `INFORMATION_SCHEMA.TABLE_CONSTRAINTS` before relying on it).
- A *separate* legacy sequence exists in `allaboard-testing` starting around `AG15089xxx` — that DB has its own counter. The generator should compute MAX from whichever DB it's running against, not be hard-coded.

## What already exists (reuse; do not rewrite)

| Component | Path | Status |
|---|---|---|
| `WebsiteLinkCard` component | `frontend/src/components/marketing/WebsiteLinkCard.tsx` | ✅ Renders correctly when `agentCode` is non-empty. Shows the "couldn't find Agent Code" gray-box when null/empty. No changes needed. |
| Marketing-link backend endpoint | `backend/routes/me/agent/marketing-link.js` | ✅ Returns `agentCode` straight from `oe.Agents.AgentCode`. No changes needed. |
| `MarketingPage.tsx` fetch + render | `frontend/src/pages/marketing/MarketingPage.tsx` (effect at ~L198, render at ~L856) | ✅ No changes needed for this fix. (Side note: render gate `(isAgent || isTenantAdmin)` excludes `SysAdmin`, while the backend allows SysAdmin. Out of scope for this spec — track separately.) |
| Read-only investigation script | `ai_scripts/db-query.sh` | ✅ Defaults to `allaboard-testing`. To query `allaboard-prod`, see "Re-running the investigation". |

## Fix plan

Two parts, both required:

### Part A — Backfill missing AgentCodes in production

One-time UPDATE for the 9 agents listed above (and any others if the broader scan finds more). Goals:

1. Pick the next sequential code: `next_max := CAST(SUBSTRING(MAX(AgentCode), 3, 20) AS BIGINT) + 1`, computed inside a single statement so concurrent updates can't collide.
2. Assign N consecutive codes (`AG{next_max}`, `AG{next_max+1}`, …) to the N agents in `CreatedDate ASC` order so the sequence reflects creation order.
3. Wrap in a transaction; include a sanity assertion that none of the updated rows previously had a non-null AgentCode.
4. Run the same scan + UPDATE against `allaboard-testing` if it shows the same NULL-tail pattern (re-check; the testing DB sequence is independent and its last populated code is `AG15089468` from 2026-04-29).

Skeleton (do not run without final review — confirm row count and code starting point first):

```sql
DECLARE @start BIGINT;
SELECT @start = ISNULL(MAX(CAST(SUBSTRING(AgentCode, 3, 20) AS BIGINT)), 0) + 1
FROM oe.Agents WHERE AgentCode LIKE 'AG%';

;WITH Missing AS (
  SELECT AgentId,
         ROW_NUMBER() OVER (ORDER BY CreatedDate ASC) - 1 AS rn
  FROM oe.Agents
  WHERE AgentCode IS NULL
    AND CreatedDate >= '2026-05-01'   -- narrow to the backfill-gap window; tighten/widen as needed
)
UPDATE a
SET AgentCode = 'AG' + RIGHT('00000000' + CAST(@start + m.rn AS NVARCHAR), 8),
    ModifiedDate = SYSUTCDATETIME()
FROM oe.Agents a
JOIN Missing m ON m.AgentId = a.AgentId;
```

Verify with a `SELECT` of the affected rows before and after. Save the resulting agent → code mapping somewhere durable in case it needs to be re-run or audited.

### Part B — Stop the bleeding: generate AgentCode at agent creation

Add AgentCode generation to every code path that inserts into `oe.Agents` (except the DUP path). Extract one helper so the logic isn't duplicated.

Suggested approach (subject to your judgment; don't take this as the only way):

1. **New helper** — `backend/services/shared/agentCodeService.js` (or co-locate inside the existing `user-management.service.js`), exposing:
   ```js
   /**
    * Generate the next AgentCode inside an existing transaction.
    * Locks the max to prevent concurrent collisions.
    * @param {sql.Transaction} transaction
    * @returns {Promise<string>}  e.g. 'AG18903689'
    */
   async function generateNextAgentCode(transaction) { ... }
   ```
   Implementation should run a single statement that both computes MAX and is safe under concurrency — e.g. `SELECT @next = ISNULL(MAX(CAST(SUBSTRING(AgentCode,3,20) AS BIGINT)),0)+1 FROM oe.Agents WITH (UPDLOCK, HOLDLOCK) WHERE AgentCode LIKE 'AG%';` inside the caller's transaction. (Validate this locking pattern works under SQL Server's default isolation — if not, prefer a dedicated sequence object like `CREATE SEQUENCE oe.AgentCodeSeq …` and update all writers to pull from it.)

2. **Patch all create-agent INSERTs** to call the helper and include `AgentCode` in the column/value lists. Files:
   - `backend/routes/tenant-admin-agents.js:1755` (around L1932 where `insertColumns` is built)
   - `backend/routes/users.js:586-593` and `:961-968`
   - `backend/services/shared/user-management.service.js:1384` (`createAgentRecord`)
   - `backend/routes/public/onboarding.js:915`
   - `backend/services/onboardingLinkService.js:525`

   Do **not** modify `backend/services/agencyAdminProvisioning.service.js` — its `DUP…` code is intentional for duplicated-admin records.

3. **Optionally add a UNIQUE filtered index** to defend against future drift:
   ```sql
   CREATE UNIQUE INDEX UX_Agents_AgentCode
     ON oe.Agents(AgentCode) WHERE AgentCode IS NOT NULL;
   ```
   Only do this after Part A is run, since duplicates today would fail the index creation.

4. **Update unit / integration tests** that exercise these create paths. At minimum, the existing test files for `tenant-admin-agents.js`, `users.js`, `onboardingLinkService.js`, and the public onboarding route should assert that the resulting row has a non-null, `AG`-prefixed AgentCode. Grep for existing test files; if none cover create-agent, write a focused one for the helper + one round-trip integration through `POST /api/tenant-admin/agents`.

5. **Decide what to do with `AdvancedSettings.marketingLink.idParam` for tenants other than MW** (separate concern but worth flagging while in the area) — for MW, `idParam = "id"` is correct because the MightyWELL website reads `?id=…`. Other tenants pointing at sites that read a different query-string key need to set theirs accordingly. Don't change anything here as part of this fix.

## Re-running the investigation

```bash
# From the AA365 repo root
cd ai_scripts
set -a && source .env && set +a
cd ../backend

# Hit prod (the script defaults to allaboard-testing; we override here)
node -e "
const sql = require('mssql');
(async () => {
  await sql.connect({
    server: process.env.DB_SERVER,
    database: 'allaboard-prod',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: { encrypt: true, trustServerCertificate: false }
  });
  const r = await sql.query(\`
    SELECT u.Email, a.AgentCode, a.Status, a.CreatedDate
    FROM oe.Agents a JOIN oe.Users u ON u.UserId = a.UserId
    WHERE a.AgentCode IS NULL AND a.CreatedDate >= '2026-05-01'
    ORDER BY a.CreatedDate DESC;
  \`);
  console.log(JSON.stringify(r.recordset, null, 2));
  await sql.close();
})().catch(e => console.error('ERR', e.message));"
```

`db-query.sh` itself defaults to `allaboard-testing` because it re-sources `.env` at the top — using it for prod requires either editing `.env` or invoking node directly as above. The `--alt` flag of `db-query.sh` points at hard-coded `readonly_user` creds that currently fail login; don't rely on it.

## Acceptance criteria

- [ ] All 9 (or however many) prod agents with `AgentCode IS NULL AND CreatedDate >= '2026-05-01'` have a unique `AG{8 digits}` code matching the global sequence after Part A runs.
- [ ] joey+agent@mightywell.us specifically receives a code and, after a hard refresh / new session, sees a populated "Your Website Links" card on the Marketing page.
- [ ] After Part B ships, creating a brand-new agent through each affected route (at minimum `POST /api/tenant-admin/agents`, `POST /api/users`, public onboarding completion, onboarding-link completion) results in a row with `AgentCode IS NOT NULL` matching pattern `AG{8 digits}` and the new value is `MAX(existing) + 1` (no gaps under non-concurrent load).
- [ ] No regressions to the agency-admin DUP code path (codes still start with `DUP`).
- [ ] If a UNIQUE filtered index is added, it succeeds on a populated DB (i.e., Part A ran first and there are no collisions).

## Risks / gotchas

- **Concurrency**: two simultaneous agent creates could compute the same `MAX+1`. The helper's locking strategy (UPDLOCK/HOLDLOCK, or a SQL Server `SEQUENCE` object) needs to be deliberate. Pick one and document it.
- **Tenant isolation**: do *not* scope the MAX lookup by TenantId — the existing sequence is global. Per-tenant numbering would break uniqueness and confuse downstream consumers that have keyed on the current pattern.
- **The "external backfill" might restart**: if someone re-enables the old script while this code is also generating codes, both would race for the same range. Confirm with Joey that the old backfill is dead before shipping Part B.
- **Codes are user-visible**: agents see and share their AgentCode in URLs. Don't change format (`AG` prefix, 8 digits) without product sign-off.
- **No UNIQUE constraint today**: prod data happens to be unique, but the schema doesn't enforce it. Treat any duplicate detection as a real possibility while writing the helper.

## Out of scope (track separately)

1. The frontend gate `(isAgent || isTenantAdmin)` in `MarketingPage.tsx` excludes `SysAdmin`, even though the backend `authorize(['Agent', 'TenantAdmin', 'SysAdmin'])` allows it. Probably worth aligning, but not part of this fix.
2. The `marketingLink.links` array for MightyWELL's tenant currently includes `http://localhost:5180/get-a-quote` as the "Get a Quote" link — a dev URL that escaped to prod config. Fix via Tenant Admin UI or one-off UPDATE; unrelated to AgentCode.
3. Whether other tenants (besides MW) have the same NULL-AgentCode tail since ~May 8 — run the scan in "Re-running the investigation" without the MW filter to confirm.

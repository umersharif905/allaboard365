# E123 Phase 1.2 — Agent Migration

Phase 1.2 adds a **third Migration Hub workflow** that creates missing AB365 agents (users, hierarchy, bank info) from E123 source data and writes instance-scoped broker pairings into `oe.MigrationAgentMap`.

This is **not** the same as **Agent Mapping** inside the Member Migration wizard (Phase 1), which only pairs E123 broker IDs to **existing** AB365 agents for member assignment.

**Commissions, commission rules, and payout configuration are explicitly out of scope for Phase 1.2.**

---

## Workflows (Migration Hub)

| Workflow | Route | Purpose |
|----------|-------|---------|
| **Member Migration** (Phase 1) | `/admin/migration/import` | Fetch households → select members → tenant → **map existing agents** → map products → preview & apply |
| **Product Migration** (Phase 1.1) | `/admin/migration/products` | Map E123 products → AB365 catalog (instance-scoped, reusable) |
| **Agent Migration** (Phase 1.2) | `/admin/migration/agents` *(planned)* | **Create** missing AB365 agents from E123 + build upline/downline tree + ACH + auto-fill `MigrationAgentMap` |

Recommended order for a greenfield tenant:

1. **Product Migration** — catalog pairings ready
2. **Agent Migration** — agents exist with hierarchy + bank info + broker maps
3. **Member Migration** — agent mapping step mostly confirms auto-matches; import assigns selling broker per household

Agent Migration can also be launched from the Member wizard when brokers are unmapped (“Create missing agents…”).

---

## Problem statement

Member import needs every selling E123 broker (`Agent ID` on household JSON) mapped to an AB365 `AgentId`. Today:

- `MigrationAgentMappingStep` discovers brokers from **selected households** in a batch and pairs them to **existing** tenant agents (email/name match or manual pick).
- Many E123 brokers **do not exist yet** in AB365 — especially downline agents imported under a root broker tree.
- AB365 agent setup requires: `oe.Users`, `oe.Agents`, `oe.AgentHierarchy`, optional `oe.AgentBankInfo` (ACH), `AgentCode`, agency assignment, and correct **parent-before-child** hierarchy inserts.

The hard part is **upline/downline structure** — must be validated visually before apply.

---

## Data sources

| Source | What it provides | Notes |
|--------|------------------|-------|
| **E123 `Agent_Full_*.csv`** (SFTP `/E123/`) | Hierarchy + identity | Processed today by `sharewell-csv-processor/shared_code/e123_agent_processor.py` into ShareWELL `agents_groups`. Key columns: `Parent ID`, `Agent ID`, `Label`, `First Name`, `Last Name`, `Company`, address, `DOB`, phones, `Email`, `Active`, `Group`. **No ACH fields in this file.** |
| **E123 Admin v2 `/v2/agents/{broker_id}`** | Profile, `parent`, tax/contact fields | See `docs/e123/agent-api.md`. `parent` field cross-checks CSV hierarchy. |
| **E123 Admin v2 `/v2/agents/{id}/bankaccounts/{id}`** | Full ACH (and CC) credentials | `ROUTINGNUMBER`, `ACCOUNTNUMBER`, `ACCOUNTTYPE`, `BANKNAME`, `SIGNATURENAME`, etc. Primary source for commission payout bank info. |
| **ShareWELL `agents_groups`** | Cached agent rows + hierarchy | Fallback when CSV/API unavailable; same shape as Agent processor output. |
| **AB365 tenant agents** | Match targets | Email exact → unique name → manual review (same priority as member-wizard agent mapping). |
| **Optional: in-progress member batch** | Scope filter | Limit wizard to brokers appearing in selected households (`IncludedInImport = 1`) plus their upline ancestors (needed for valid tree). |

### ACH / bank info note

E123 member API does **not** expose agent bank accounts. Agent ACH must come from:

1. E123 Admin v2 bank-account endpoints (preferred), or
2. An offline bank export doc (if provided separately — same gap as member bank info in `docs/e123/README.md`).

On create, mirror existing tenant-admin agent flow: insert encrypted routing/account into `oe.AgentBankInfo` (`VerificationStatus = 'Pending'`).

---

## Agent Migration wizard (planned UI)

Route: `/admin/migration/agents` — mirror `E123ProductMigrationWizard.tsx` structure.

### Steps

1. **Instance + tenant** — pick migration instance (E123 creds) and target AB365 tenant.
2. **Import agent roster** — upload `Agent_Full_*.csv`, pull latest from instance SFTP snapshot, or read ShareWELL `agents_groups` / staging table. Optional: “Scope to brokers in batch {id} (+ uplines)”.
3. **Match review** — table of E123 brokers classified as:
   - **Existing** — matched AB365 agent (email or unique name); will write/update `MigrationAgentMap` only
   - **New** — will create User + Agent + hierarchy + bank
   - **Conflict** — email exists but not as agent, duplicate names, inactive in E123, missing parent, etc.
4. **Hierarchy preview (tree UI)** — interactive tree built from `Parent ID` → `Agent ID`:
   - Expand/collapse nodes; show E123 label, email, Active, Group/LB flag
   - Badges: New / Existing / Conflict / Missing parent / Orphan / Cycle detected
   - Highlight selected import root(s) and downline subtree(s)
   - Reuse tree patterns from `AgentsPage.tsx` / `agent-hierarchy.service.js` where possible
5. **ACH & profile review** — per-agent panel: fields pulled from E123 API; flag agents missing bank account; allow skip with warning (payouts blocked until filled manually).
6. **Apply preview** — summary counts: N users created, N agents created, N hierarchy rows, N bank records, N maps written, N welcome emails queued.
7. **Apply + optional welcome email** — transactional create in **topological order** (parents before children).

### Tree preview requirements

- Must show **full path to root** for any scoped downline import (not just flat broker list).
- Detect and block apply on:
  - **Cycles** in parent pointers
  - **Missing parent** when parent broker not in import set (unless explicitly mapped to existing AB365 root agent)
  - **Multiple roots** when a single root was expected (warn, allow override)
- Allow admin to **re-parent** a node in UI before apply (writes override into batch draft, not E123).

---

## Backend apply logic (planned)

Service: `backend/services/migration/agentMigration.service.js` *(new)*

### Create order (per agent, parents first)

1. Resolve or create **Agency** when E123 `Group` / company rules require it *(rules TBD — may default all to tenant default agency initially)*.
2. **User** — `oe.Users` with email, name; random password hash; `Status = 'Active'`.
3. **Agent** — `oe.Agents` with `AgentCode` via `generateAgentCode`, address/NPN/tax fields from E123, default commission tier per tenant policy *(commissions themselves not configured)*.
4. **AgentBankInfo** — from E123 bank-account API when present.
5. **AgentHierarchy** — `ParentId` = mapped AB365 agent for E123 `Parent ID` (existing or just-created).
6. **MigrationAgentMap** — `(InstanceId, E123BrokerId) → AgentId`, `MatchMethod = 'migration_create' | 'migration_match'`.

Idempotency:

- Skip create if `MigrationAgentMap` already has `E123BrokerId` for instance.
- Skip create if AB365 agent email match exists — offer map-only path.
- Store `E123BrokerId` on agent or map table (already on map); optional future `Agents.E123BrokerId` column if needed for ops.

### Welcome email (new agents only)

- Reuse `backend/services/shared/user-management.service.js` password-setup / welcome email queue pattern (same as vendor user invite).
- UI checkbox: **“Send sign-in email to all newly created agents”** (default off).
- Email contains password-setup link; agent must set password on first login — **no shared/temporary password in email body**.

---

## What agents must do manually (expected minimum)

| Item | Auto from E123? | Manual? |
|------|-----------------|---------|
| Account password | — | **Yes** — via welcome email setup link (one-time) |
| Profile / contact | Mostly yes | Fix in portal if E123 data stale |
| ACH bank info | Yes if E123 bank API returns account | Enter manually if missing from E123 |
| Bank verification | Created as `Pending` | May require admin verification depending on payout rules |
| Commission tier / rules | Default tier only (tenant policy) | **Yes later** — commissions out of scope |
| Licenses / appointments | API available (`/licenses`, `/appointments`) | Optional Phase 1.2b; not required for member import assignment |
| Marketing / agent website links | `AgentCode` generated on create | None if code generation succeeds |

**Bottom line:** If E123 bank-account API returns full ACH for an agent, we likely have enough to stand them up without agent action beyond **setting their password** via the welcome email. Missing ACH or commission config are the main follow-ups.

---

## Relationship to Member Migration agent mapping

| Concern | Agent Migration (1.2) | Agent Mapping (member wizard) |
|---------|----------------------|------------------------------|
| Creates AB365 agents | **Yes** | No |
| Writes `MigrationAgentMap` | **Yes** | Yes (manual pairings) |
| Scoped to selected households | Optional filter | **Yes** (brokers from `IncludedInImport = 1`) |
| Needs batch | Optional (for scoping) | **Yes** |
| Tree preview | **Yes** | No (flat broker list) |

After Agent Migration runs, Member wizard step “Agent Mapping” should show most brokers as pre-mapped via saved instance maps.

---

## API (planned)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/admin/migration/agents/parse` | Upload CSV or `{ source: 'sftp' \| 'sharewell' }` → normalized roster + hierarchy |
| GET | `/api/admin/migration/agents/workspace` | `?instanceId=&tenantId=&batchId=` match classification + tree DTO |
| POST | `/api/admin/migration/agents/preview` | Dry-run counts + validation errors |
| POST | `/api/admin/migration/agents/apply` | Create agents + maps; `{ sendWelcomeEmail: boolean }` |
| GET | `/api/admin/migration/agents/bank-accounts/:e123BrokerId` | Proxy E123 v2 bank account fetch for ACH panel |

---

## UI (planned)

- **Migration Hub** — third card: **Agent Migration** (`/admin/migration/agents`)
- **Agent Migration wizard** — steps above; shared components where possible:
  - Tree: adapt tenant-admin hierarchy tree (`AgentsPage` / lazy agency subtree)
  - Match table: similar row UX to `MigrationAgentMappingStep`
- **Member wizard link** — from Agent Mapping step: “Open Agent Migration to create missing agents”

---

## Out of scope (Phase 1.2)

- Commission rules, overrides, advances, NACHA payout configuration
- Member bank / payment method import
- License and appointment bulk import *(optional later)*
- Bi-directional sync back to E123
- Agent portal feature configuration beyond account creation

---

## SQL / schema prerequisites

Existing tables used as-is:

- `oe.MigrationAgentMap` — broker → agent pairings (`sql-changes/2026-05-20-migration-agent-map.sql`)
- `oe.AgentHierarchy`, `oe.Agents`, `oe.Users`, `oe.AgentBankInfo`

Possible additions *(design TBD at implementation)*:

- `oe.MigrationAgentImportBatch` — CSV upload metadata, preview JSON, apply status (mirror product import batch pattern)
- `oe.Agents.E123BrokerId` — optional denormalized lookup (maps table may suffice)

---

## Implementation phases (when approved)

### Phase 1.2a — Discovery + tree preview (read-only)

- CSV parse + hierarchy builder + validation
- Workspace API + tree UI
- E123 bank-account fetch for display (no writes)

### Phase 1.2b — Apply path

- Topological create (user → agent → bank → hierarchy → map)
- Welcome email batch option
- Hub card + wizard route

### Phase 1.2c — Polish

- Scope-to-member-batch filter (+ auto-include uplines)
- License/appointment import (if needed)
- Link from member wizard agent mapping step

---

## References

- `sharewell-csv-processor/shared_code/e123_agent_processor.py` — `Agent_Full` column map
- `docs/e123/agent-api.md` — E123 agent + bank account API
- `backend/services/migration/migrationAgentMapping.service.js` — member-wizard broker pairing
- `backend/routes/tenant-admin-agents.js` — canonical agent + bank + hierarchy create
- `docs/e123/phase-1.1-product-migration.md` — parallel standalone migration workflow

# E123 Phase 1.1 — Product Migration

Phase 1.1 splits the migration hub into two workflows that share tenant-scoped product maps in `oe.MigrationProductMap`.

## Workflows

### Member Migration (Phase 1)
Route: `/admin/migration/import`

1. Select members (households) from E123 fetch
2. Select target tenant
3. Agent mapping — pair E123 selling brokers to **existing** AB365 agents (scoped to selected households)
4. Product mapping (optional inline — can use Product Migration instead)
5. Preview & apply

For brokers that do not exist in AB365 yet, use **Agent Migration** (Phase 1.2) first — see `phase-1.2-agent-migration.md`.

### Product Migration (Phase 1.1)
Route: `/admin/migration/products`

1. Select target tenant
2. Map E123 products → AB365 products + pricing tiers (or ignore non-plan items)

Product maps are **tenant-scoped**, not batch-scoped. Once saved, they apply to all future imports for that tenant.

## Data sources

| Source | Purpose |
|--------|---------|
| `oe.MigrationImportBatchHousehold` | Discover E123 products from imported household JSON |
| `oe.MigrationProductMap` | Persist pairings (`ProductId`, `ProductPricingId`, `IgnoreImport`) |
| ShareWELL catalog (`SHAREWELL_DB_*`) | Tier, UA, benefit name hints for auto-suggest |
| E123 `productfee.amount` | Member premium (MSRP) for closest-$ pricing match — **no fee split from E123** |
| `pricing-and-fees.md` | What E123 does/doesn't expose for net/override/commission/fees |
| E123 member product dates | `dtcreated`, `dteffective`, `dtbilling`, `dtcancelled`, `bhold` per enrollment |
| E123 Admin v2 `/products/{brokerId}` | Whether a `pdid` is still in the agent catalog (`ACTIVE`) vs legacy |

## Auto-suggest logic

Tier/pricing suggestions use graduated scoring in `e123TierInference.js`:

1. Saved map (previously paired)
2. Tier code (EE/ES/EC/EF) from household composition or catalog
3. Unshared amount (UA) from catalog or fee hints
4. Age band overlap
5. Benefit key / label match
6. **Premium amount** — exact, then 2%, 5%, 10% tolerance
7. **Tobacco status** — E123 member `tobacco` field aggregated per tier; matches AB365 `TobaccoStatus` (dropdown shows `Tobacco: Yes` for surcharge tiers)
8. **Closest premium fallback** — if no score ≥ 40, pick nearest $ within 25% (tobacco-aware tie-break)

Close is good; exact match is not required.

## Member import lifecycle

Imported members and enrollments are flagged `IsPendingMigration = 1` until finalized elsewhere in the product.

| Action | When |
|--------|------|
| **create** | HouseholdMemberID not in OpenEnroll |
| **update** | Primary member is pending migration with no finalized enrollments — demographics refreshed, pending enrollments deleted and rebuilt from current product maps |
| **locked** | Member has any enrollment with `IsPendingMigration = 0`, or primary member is no longer pending — never modified |

Re-run the wizard after fixing product mappings: pending households stay selectable and apply as **update pending**.

Non-enrollable E123 lines (Chargeback Fee, admin fees) can be:

- Auto-excluded by label patterns in `householdNormalizer.js`
- Manually ignored in the mapping UI (`IgnoreImport = 1`, `ProductId` null)

Ignored products produce no enrollments during member import.

## API

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/admin/migration/batches/:batchId/products/mapping` | Batch-scoped workspace |
| GET | `/api/admin/migration/tenants/:tenantId/products/mapping-workspace` | All batches for tenant; optional `?batchId=` |
| GET | `/api/admin/migration/tenants/:tenantId/products/map-summary` | Saved pairing summary |
| POST | `/api/admin/migration/products/maps/bulk` | Save mappings |
| POST | `/api/admin/migration/products/stub` | Create hidden stub product (single tier today) |

## UI

- **Migration Hub** — two entry cards: Member Migration, Product Migration
- **Product Migration wizard** — tenant picker + shared `MigrationProductMappingStep` (no `batchId`)
- **Member wizard step 3** — same mapping step; link to Product Migration for standalone setup
- **Pairing display** — mapped groups show AB365 product name; hub summary lists E123 → AB365 pairs

## Future (Phase 1.2+)

- **Agent Migration wizard** — create missing agents, hierarchy tree preview, ACH from E123 bank API, welcome emails (`phase-1.2-agent-migration.md`)
- Multi-tier stub product creation from E123 benefit groups (EE/ES/EC/EF in one action)
- Auto-subscribe stub products to tenant (`TenantProductSubscriptions`)
- Unhide stub products or prompt vendor selection before save
- Remove embedded product/agent steps from member wizard when tenant prep is complete

## SQL prerequisites

Run before using ignore / nullable product maps:

- `sql-changes/2026-05-20-e123-phase1-migration-schema.sql`
- `sql-changes/2026-05-20-e123-migration-product-ignore.sql`

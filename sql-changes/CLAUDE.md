# sql-changes — CLAUDE.md

Database migration scripts for Azure SQL (`oe.` schema). The root `../CLAUDE.md` Database Write
Policy is canonical and **hard**.

## Write policy (HARD RULES)

- **Never execute `INSERT`/`UPDATE`/`DELETE`/DDL against the database** unless the user explicitly
  requests it in that message. Writing a `.sql` file here is fine; *running* it is not — wait for
  explicit approval and confirm the exact operation + affected rows first.
- **Every data-modifying script ships with a dry-run / `SELECT` preview enabled by default.** It
  must show which rows would be affected before any write. Real writes run only when a flag is
  explicitly flipped (e.g. `@DryRun = 0`).
- Read-only queries (`SELECT`, `sp_help`, schema inspection) run freely via
  `db-query.sh --prod-readonly`.

## Conventions

- File naming: `YYYY-MM-DD-<description>.sql`.
- Schema prefix `oe.`; tables/columns `snake_case`.
- **Every table includes `TenantId`** — new tables must add it; writes must scope by it.
- Apply with `node ../backend/scripts/migrate.js`.

## Script template (data-modifying)

```sql
DECLARE @DryRun BIT = 1;   -- 1 = preview only (default), 0 = execute writes

-- 1. Preview the affected rows
SELECT * FROM oe.<table> WHERE <condition> AND TenantId = @TenantId;

-- 2. Execute only when explicitly enabled
IF @DryRun = 0
BEGIN
    -- INSERT / UPDATE / DELETE here, scoped by TenantId
END
```

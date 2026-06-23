# Backend — CLAUDE.md

Express.js REST API (Node 22, Azure SQL via `mssql`). This file scopes guidance for `backend/`;
the root `../CLAUDE.md` is canonical — read it for anything not covered here.

## Commands (run from `backend/`)

- Dev server: `node app.js` (no hot-reload — restart after changes)
- Tests: `npx jest` · single: `npx jest <test-file-path>`
- Lint: `npx eslint .`
- Migration: `node scripts/migrate.js`

## Non-negotiable rules

- **Tenant isolation:** every DB query MUST filter by `TenantId`. Use `buildTenantWhereClause()`.
  **Never bypass `middleware/requireTenantAccess.js`** — no exceptions for "admin"/"internal" routes.
  A query without a tenant filter is a security bug.
- **Auth:** JWTs validated in `middleware/auth.js`. Enforce access with `userType` checks
  (`SysAdmin > TenantAdmin > Agent > GroupAdmin > Member`, plus `VendorAdmin`). Derive `TenantId`/role
  from the token, never from the request body.
- **DB writes:** never run `INSERT`/`UPDATE`/`DELETE`/DDL without explicit user approval (see
  `../sql-changes/CLAUDE.md`).
- **Parameterized queries only** (`request.input(...)`) — never concatenate user input into SQL.

## Conventions

- Response shape: `{ success: boolean, data?: any, message?: string }`. Always.
- Routes (`routes/`, kebab-case) stay thin: validate → call service → format response.
  Business logic and SQL live in services (`services/`).
- Reuse the connection pool from `config/database.js`; don't open new connections.
- `../shared/` utilities are bundled in at deploy time via `deploy.sh`.

## Tests

- Live in `routes/__tests__/` and `services/__tests__/`; DB and axios are mocked.
- Add/extend tests when changing route or service logic.

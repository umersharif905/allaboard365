# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Database Write Policy (Hard Rules)

- **Never execute INSERT, UPDATE, DELETE, or DDL against the database** unless Jeremy explicitly requests it in that message.
- Before any write execution: confirm the exact operation and affected rows with the user. Wait for explicit approval.
- When writing SQL scripts that modify data: **always include a dry-run / SELECT preview mode enabled by default**. The script must show what rows would be affected before any write happens. Real writes only run when a flag or variable is explicitly set (e.g., `@DryRun = 0`).
- Read-only queries (`SELECT`, `EXEC sp_help`, schema inspection) can run freely via `db-query.sh --prod-readonly` without confirmation.

## Project Overview

Open-Enroll (AllAboard365) is a **multi-tenant healthcare enrollment platform** with role-based access for SysAdmin, TenantAdmin, Agent, GroupAdmin, and Member users. Production URLs: frontend at `allaboard365.com`, API (including OAuth/auth routes) at `api.allaboard365.com`. OAuth base URL is configured per environment (`OAUTH_URL` / `VITE_OAUTH_URL` / `/config.json`), defaulting to the same host as the API.

## Commands

### Backend (run from `/backend`)
- **Start dev server**: `node app.js`
- **Run tests**: `npx jest`
- **Run single test**: `npx jest <test-file-path>`
- **Lint**: `npx eslint .`
- **DB migration**: `node scripts/migrate.js`

### Frontend (run from `/frontend`)
- **Start dev server**: `npm run dev` (Vite on port 5173)
- **Build**: `npm run build`
- **Production build**: `npm run build:prod`
- **Run unit tests**: `npx vitest run`
- **Run single test**: `npx vitest run <test-file>`
- **Lint**: `npx eslint .`
- **Type check**: `npx tsc --noEmit`

### E2E Tests (Cypress, from `/frontend`)
- **Open Cypress UI**: `npx cypress open`
- **Run headless**: `npx cypress run`
- **Run single spec**: `npx cypress run --spec "cypress/e2e/<spec-file>"`

### Enrollment test suite
Multi-layer suite covering `/enroll-now/:shortCode` → `/enroll/:linkToken` →
`complete-enrollment` → password setup. Full detail in
[`docs/enrollments/testing.md`](docs/enrollments/testing.md).

- **Backend Jest** (140 tests, ~0.7s, DB + axios mocked):
  ```
  cd backend
  npx jest services/__tests__/short-code.service.test.js \
          routes/__tests__/enroll-now.shortcode.test.js \
          routes/__tests__/enrollment-links.send-verification-code.test.js \
          services/__tests__/dimeService.decline.test.js \
          services/__tests__/dimeService.ach.test.js \
          services/__tests__/dimeService.matrix.test.js \
          services/__tests__/paymentAttempt.service.test.js \
          services/__tests__/enrollmentPaymentHoldService.test.js
  ```
- **Vitest units** (27 tests, jsdom):
  ```
  cd frontend
  npx vitest run src/services/__tests__/enrollment.service.test.ts \
                 src/components/__tests__/ShortCodeResolver.test.tsx \
                 src/pages/enrollment/__tests__/EnrollmentPage.test.tsx
  ```
- **Cypress enrollment specs** (20 live + scaffolded; stub-driven — no DB):
  ```
  cd frontend
  npx cypress run --spec "cypress/e2e/enrollment/**/*.cy.ts"
  ```
- **DIME sandbox fixtures** — canonical data in
  `backend/test-fixtures/dime-test-cards.js` (6 cards + 27 VISA amount
  triggers + 4 MC extras + ACH creds) mirrored in
  `frontend/cypress/fixtures/enrollment/dime-test-data.json`. Source:
  `docs/dime-credit-cards/*.xlsx`.

## Architecture

### Monorepo Structure (no workspace tooling)
```
backend/          # Express.js REST API (Node 22, MSSQL)
frontend/         # React 18 + Vite 6 SPA (TypeScript)
enrollment-nightly-job/      # Azure Functions – enrollment nightly (termination + PaymentHold cleanup)
billing-nightly-job/         # Azure Functions – billing nightly (+ optional below-minimum)
integration-error-digest-job/ # Azure Functions – integration-error-digest timer
vendor-jobs/      # Azure Functions – vendor data export
product-api-jobs/ # Azure Functions – product sync
shared/           # Shared utilities (payment-status, snapshots)
sql-changes/      # Database migration scripts
```

Each app manages its own `package.json` and `node_modules`. The `shared/` directory is bundled into backend at deploy time via `backend/deploy.sh`.

### Backend (`/backend`)
- **Entry point**: `app.js` — Express app with all route registration
- **Database**: Azure SQL Server via `mssql` package. Connection pool in `config/database.js`
- **Routes**: 80+ files in `routes/` — RESTful endpoints under `/api/*`
- **Services**: 100+ files in `services/` — business logic layer (commissions, NACHA, enrollment, payments)
- **Auth middleware**: `middleware/auth.js` — JWT validation, API key auth, role extraction
- **Tenant isolation**: `middleware/requireTenantAccess.js` — enforces TenantId filtering on all queries. **Never bypass this.**
- **API response format**: `{ success: boolean, data?: any, message?: string }`

### Frontend (`/frontend/src`)
- **Routing**: `App.tsx` defines 100+ routes with role-based layout selection and `ProtectedRoute` guards
- **State**: `AuthContext` (user/roles/tenant), `BrandingContext` (multi-tenant theming), `TenantContext`
- **Data fetching**: TanStack React Query hooks in `hooks/` (73+ custom hooks organized by role subdirectories)
- **API services**: `services/` (60+ files) — `apiClient.ts` is the Axios instance, `config/api.ts` handles runtime config from `/config.json`
- **Runtime config**: Frontend loads `/config.json` at startup for Azure environment variables; build-time `.env` is the fallback

### Database
- Azure SQL with `oe.` schema prefix (e.g., `oe.Members`, `oe.Enrollments`)
- Table naming: `snake_case`
- All tables include `TenantId` for row-level tenant isolation
- `buildTenantWhereClause()` used for query filtering

### Authentication Flow
- OAuth service issues JWT tokens (with refresh token rotation)
- Backend validates JWTs via `middleware/auth.js`
- Frontend stores tokens via `services/tokenManager.ts`
- 9+ roles with hierarchy: SysAdmin > TenantAdmin > Agent > GroupAdmin > Member, plus VendorAdmin and others

## UI Rules (Strictly Enforced)

- **Tailwind CSS for all new/modified UI** — no CSS-in-JS, no custom CSS, no inline styles
- **Lucide React icons** for new code — no other icon libraries
- **Native HTML elements** styled with Tailwind classes
- **No new Material-UI.** MUI (`@mui/*`, including `x-data-grid` and `x-date-pickers`) survives in ~38 legacy files (mainly `components/commissions`, `pages/tenant-admin`, `pages/groups`, `components/ai`). Leave those working — migrate a file to Tailwind only when you're already editing it. **Do not do drive-by rewrites of working MUI screens**, and do not add MUI to any new component.
- Standard patterns: cards use `bg-white rounded-lg border border-gray-200`, consistent `p-6` padding
- **Brand colors (use these, NOT Tailwind defaults like `blue-600`):**
  - Primary buttons: `bg-oe-primary hover:bg-oe-dark` (sky blue #1f8dbf / dark #125e82)
  - Light accent/backgrounds: `bg-oe-light` (#d6eef8)
  - Success: `text-oe-success` (#4caf50)
  - Secondary/outline buttons: `border border-gray-300 text-gray-700 bg-white hover:bg-gray-50`
  - Danger: `text-red-600 hover:bg-red-50`
  - All brand colors are CSS variables defined in `tailwind.config.js` and support dynamic tenant theming via `BrandingContext`
  - **Never use raw Tailwind blues** (`blue-600`, `blue-700`) for buttons or interactive elements — always use `oe-primary`/`oe-dark`
- Reference components for style consistency: `AgentMemberManagement.tsx`, `TenantMembers.tsx`, `AgentGroups.tsx`

## Naming Conventions

- **Components/pages**: PascalCase files (e.g., `CommissionDashboard.tsx`)
- **API route files**: kebab-case with RESTful endpoints
- **TypeScript types**: PascalCase for interfaces, camelCase for properties
- **Folders**: kebab-case or camelCase

## Key Constraints

- Every database query MUST filter by TenantId — tenant isolation is a hard security requirement
- Never bypass `requireTenantAccess` middleware on any route
- Role-based access must be enforced using `userType` checks
- Cypress tests should be written for functionality features (not purely visual changes)
- Azure-first infrastructure: SQL, Blob Storage, App Service, Functions

## Software Factory

This project uses a structured agent pipeline instead of ad-hoc "vibe coding." The factory lives in `.claude/`:

### Skills (`.claude/skills/`)
Repeatable workflows triggered by description matching:
- **`feature-factory`** — full 7-agent pipeline for new features
- **`build-with-tests`** — quick build when spec is already known
- **`run-tests`** — smart test runner (detects changes, runs right suites)
- **`db-change`** — safe DB migration with mandatory @DryRun
- **`add-api-endpoint`** — scaffold backend route + service + test
- **`add-page`** — scaffold frontend page + hook + service + route
- **`deploy`** — deployment workflow with pre-deploy checks

### Agents
Focused workers (source: `.claude/agents/`, Cursor runtime: `.cursor/agents/`):
1. **`codebase-researcher`** — maps code before building (read-only)
2. **`story-writer`** — user story + acceptance criteria (read-only)
3. **`spec-writer`** — technical specification (read-only)
4. **`backend-builder`** — routes, services, Jest tests (`backend/` + `sql-changes/` only)
5. **`frontend-builder`** — pages, hooks, Vitest tests (`frontend/` only)
6. **`test-verifier`** — acceptance tests (test files only)
7. **`implementation-validator`** — validation checklist (read-only)

### Cursor usage
- **Skills:** `.claude/skills/` — auto-discovered; say `Run feature-factory for: …` or `build-with-tests: …`
- **Subagents:** `.cursor/agents/` — delegate with `Use the <name> subagent to …`
- **Rule:** `.cursor/rules/software-factory.mdc` — pipeline summary when building features
- **Hooks:** `.cursor/hooks.json` — blocks forbidden UI/SQL; warns on routes and brand colors
- **Quick commands:**

| Goal | Chat phrase |
|------|-------------|
| Full new feature | `Run feature-factory for: [description]` |
| Known scope + tests | `build-with-tests: [requirements]` |
| SQL migration | `db change: [description]` |
| New API | `add-api-endpoint: [description]` |
| New page | `add-page: [description]` |
| Tests | `run tests` |
| Deploy | `deploy backend` / `deploy frontend` |

Keep `.claude/agents/` and `.cursor/agents/` in sync when editing agent prompts.

### Platform scope (feature-factory)
Features are tagged before research:

| Scope | Build target |
|-------|----------------|
| **admin-web** | Admin/agent UI + `/api/*` routes |
| **member-web** | `frontend/src/pages/member/` + `/api/me/member/*` |
| **member-mobile-api** | Member API + `docs/mobile/` (native app is a separate client) |
| **cross-platform** | Combination of the above |

Mobile references: [`docs/mobile/mobile-app-api-integration.md`](docs/mobile/mobile-app-api-integration.md), [`docs/auth/MOBILE_APP_SESSION_AND_KEEP_ME_SIGNED_IN.md`](docs/auth/MOBILE_APP_SESSION_AND_KEEP_ME_SIGNED_IN.md). Member routes use `attachMemberHouseholdContext`, not `requireTenantAccess`.

### Verification (factory “done” bar)

[`docs/factory/verification-checklist.md`](docs/factory/verification-checklist.md) — every factory run must prove **expected outcomes**, not only green tests.

- Spec includes **Verification plan** (user-visible results + every code path).
- `./ai_scripts/factory-verify-changed.sh` before merge (wrong `sql` import, `Agencies.Name`, bare `Enrollments.TenantId`, missing tests).
- test-verifier: criterion → test → PASS; preview-only is insufficient if execute exists.
- implementation-validator: **outcome matrix** — achievable from code, not checkbox theater.

Prod gotchas: `database.sql` = SqlTypes only (`require('mssql')` for `Transaction`); `Agencies.AgencyName`; `Enrollments` often has no `TenantId`.

### Workflow
```
feature-factory: [scope] → researcher → story → [APPROVE] → spec → [APPROVE] → backend-build → frontend-build (if web) → test → validate → [APPROVE PR]
```

### Hooks
Automatic enforcement — cannot be argued with:
- **Claude Code:** `.claude/settings.json`
- **Cursor:** `.cursor/hooks.json` + `.cursor/hooks/*.sh`

Both block Material-UI / non-Lucide icon imports and SQL writes without `@DryRun`. Both warn on missing `requireTenantAccess` in routes and raw Tailwind `blue-*` colors (use `oe-primary`).

## Additional Context

- `ai-context/` contains project-specific docs: API routes, component map, dev roadmap, known issues
- `memory-bank/` has project state tracking (activeContext.md, progress.md)
- `.cursorrules` has the full UI consistency ruleset
- Deploy scripts: `backend/deploy.sh` and `frontend/deploy.sh` deploy to Azure App Service

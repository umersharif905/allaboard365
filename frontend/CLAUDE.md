# Frontend — CLAUDE.md

React 18 + Vite 6 SPA (TypeScript). This file scopes guidance for `frontend/`; the root
`../CLAUDE.md` is the canonical source — read it for anything not covered here.

## Commands (run from `frontend/`)

- Dev server: `npm run dev` (Vite, port 5173)
- Build: `npm run build` · prod build: `npm run build:prod`
- Unit tests: `npx vitest run` · single: `npx vitest run <test-file>`
- Lint: `npx eslint .` · type check: `npx tsc --noEmit`
- E2E: `npx cypress run` · single spec: `npx cypress run --spec "cypress/e2e/<spec-file>"`

## UI rules (strictly enforced)

- **Tailwind CSS for all new/modified UI** — no CSS-in-JS, no custom CSS files, no inline `style={{}}`.
- **Lucide React icons** for new code. Native HTML elements styled with Tailwind.
- **No new Material-UI.** MUI (`@mui/*`, incl. `x-data-grid`/`x-date-pickers`) remains in ~38 legacy files
  (mostly `components/commissions`, `pages/tenant-admin`, `pages/groups`, `components/ai`). Leave them
  working; convert to Tailwind only when you're already editing that file. No drive-by rewrites, no new MUI.
- **Brand colors, never raw Tailwind blues.** Use `bg-oe-primary hover:bg-oe-dark text-white`
  for primary/interactive elements and `focus:ring-oe-primary` for focus rings. Hardcoding
  `blue-600`/`blue-700`/`ring-blue-500` breaks per-tenant theming via `BrandingContext`.
  Other tokens: `bg-oe-light`, `text-oe-success`, `text-oe-error`. Defined in `tailwind.config.js`.
- Card pattern: `bg-white rounded-lg border border-gray-200`, padding `p-6`.
- Copy patterns from `src/pages/agent/AgentMemberManagement.tsx`, `src/pages/tenant-admin/TenantMembers.tsx`,
  `src/pages/agent/AgentGroups.tsx`.

## Structure

- Routing: `src/App.tsx` (100+ routes, role-based layouts + `ProtectedRoute` guards).
- State: `AuthContext` (user/roles/tenant), `BrandingContext` (theming), `TenantContext`.
- Data fetching: TanStack React Query hooks in `src/hooks/` (organized by role).
- API: `src/services/apiClient.ts` (Axios), `src/config/api.ts` (runtime `/config.json`, `.env` fallback).
- Backend responses are `{ success, data?, message? }` — unwrap accordingly.

## Tests

- Cypress for functionality features (user flows, data ops) — **not** for purely visual changes.
- Vitest for services/utilities and components with logic.
- Component/page files: PascalCase (e.g. `CommissionDashboard.tsx`). TS interfaces PascalCase, props camelCase.

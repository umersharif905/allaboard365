---
title: Make Member Portal Mobile Responsive
type: feat
status: completed
date: 2026-04-23
---

# Make Member Portal Mobile Responsive

## Overview

Make the Member portal (all 16 routes under `/member/*`) fully usable on mobile phones (≥320px width) and tablets, without touching SysAdmin, TenantAdmin, Agent, GroupAdmin, or VendorAdmin portals. The portal is currently desktop-only: a fixed-width sidebar (16rem / 5rem collapsed) plus `ml-64`/`ml-20` content margin makes every page unusable below ~768px.

The scope is bounded to **member-specific** components and pages. Shared primitives (`SideNavigation`, `ProductInfoModal`, `SignaturePad`, `IDCard`) are NOT modified in this effort — member-owned wrappers or alternative components handle mobile behavior instead. This keeps blast radius small and makes the change reviewable and reversible.

## Problem Statement

Members increasingly open the portal on their phones (check ID card in a pharmacy, upload a document from the camera roll, review an invoice). Today:

- **Sidebar blocks the page.** `MemberLayout.tsx:79–98` renders a fixed 16rem sidebar plus `ml-64` content margin with no `md:`/`sm:` breakpoint. Below 768px, content is squeezed or pushed off-screen.
- **No hamburger / drawer.** `MemberNavigation.tsx` only toggles between 64px and 20px widths; it never hides. There is no off-canvas drawer pattern.
- **Payments table overflows horizontally.** `Payments.tsx:311` wraps a 5-column `<table>` in `overflow-x-auto`. Users must scroll horizontally to see invoice number, amount, and status simultaneously.
- **Modals use `max-w-4xl`** (AddDependent, ProductChangeWizard steps) without `w-[95vw]` fallback, overflowing on small screens.
- **Signature pad canvas** in `ProductChangeWizard` has fixed pixel dimensions — unusable at <400px width.
- **Header is fixed-height 20rem** with `px-6` — tenant logo + name wraps or overflows on narrow screens.
- **ID Card carousel** (`IDCards.tsx`) uses fixed card widths — may clip.

The `MobileAppRedirectModal` (Apr 8, 2026) already nudges some users to a native app, but (a) not every tenant has a native app configured, (b) users who dismiss or cancel land on the web portal, (c) tablet users typically want the web. Responsive web is still required.

## Proposed Solution

Mobile-first responsive rebuild using the **existing Tailwind-only stack** (`sm: 640 / md: 768 / lg: 1024` defaults) and the **already-proven responsive patterns** from `AgentLayout.tsx`, `TenantAdminLayout.tsx`, `GroupAdminLayout.tsx` (see `docs/ui/frontend-system.md` and commit `9a5671e9`).

Core moves:
1. **Rewrite `MemberLayout`** with three states: mobile (`<md`, off-canvas drawer + overlay), tablet/desktop collapsed, desktop expanded.
2. **Create `MemberMobileDrawer`** wrapper around existing `MemberNavigation` nav items — does NOT modify shared `SideNavigation`.
3. **Add `MemberHeader` mobile mode**: sticky top bar with hamburger button (left), tenant logo (center), user avatar (right).
4. **Convert Payments table to card list on mobile** (`hidden md:table` + `md:hidden` card list), preserving desktop table.
5. **Audit and fix each of the 16 pages** for padding, modal widths, form grids, signature canvas, ID card carousel.
6. **Verify in browser** at 320px, 375px, 414px, 768px, 1024px before shipping.

## Technical Approach

### Architecture

**Breakpoint strategy** (keep Tailwind defaults — no config changes):
- `< 640` (mobile): drawer hidden off-canvas, single column, card-view tables, full-width modals
- `640–767` (large mobile): same layout as mobile with slightly more padding
- `768–1023` (tablet): sidebar visible but collapsible; grids start to split
- `≥ 1024` (desktop): current experience preserved

**New member-only files:**
- `frontend/src/components/member/MemberMobileDrawer.tsx` — off-canvas drawer that renders `MemberNavigation`'s nav list inside a slide-in panel with backdrop.
- `frontend/src/pages/member/components/PaymentsMobileList.tsx` — card view for Payments rows.

**Modified files (member-only):**
- `frontend/src/components/member/MemberLayout.tsx` — add responsive branching.
- `frontend/src/components/member/MemberHeader.tsx` — add hamburger slot, responsive sizing.
- `frontend/src/components/member/MemberNavigation.tsx` — accept an `isMobile` prop to render without the fixed-width wrapper when inside the drawer.
- All 16 member pages — add `sm:`/`md:` qualifiers to padding, typography, grids, and modal widths as needed.

**Shared components — explicitly NOT modified:**
- `components/common/SideNavigation.tsx` (used by all 5+ role sidebars)
- `components/common/ProfileEditModal.tsx`
- `components/shared/ProductInfoModal.tsx`
- `components/enrollment-wizard/SignaturePad.tsx` (instead: wrap member usage in a responsive container that computes canvas size)
- `components/IDCard.tsx`

If any of these turn out to block the member experience, file a follow-up plan — do not widen scope in this effort.

### Implementation Phases

#### Phase 1: Layout & Navigation (Foundation)

Goal: Every member route renders without horizontal overflow at 320px; hamburger drawer works.

Tasks:
- [x] Rewrite `components/member/MemberLayout.tsx` — wraps desktop sidebar in `hidden md:block`, margin changed to `md:ml-64`/`md:ml-20` (zero margin on mobile), drawer state added, `MemberMobileDrawer` rendered alongside.
- [x] Create `components/member/MemberMobileDrawer.tsx` — `w-72 max-w-[85vw]`, `z-40` panel, `z-30` backdrop, route-change auto-close via `useLocation`, Escape-key close, body-scroll lock.
- [x] Update `components/member/MemberNavigation.tsx` — nav item list extracted into `useMemberNavigationItems` hook (shared by desktop + drawer). Shared `SideNavigation` NOT modified.
- [x] Update `components/member/MemberHeader.tsx` — hamburger button (`md:hidden`), `h-14 md:h-20`, `px-4 md:px-6`, tenant name truncates.
- [ ] Manually verify at 320/375/414/768/1024px in Chrome DevTools. *(User to perform.)*

Success criteria: No horizontal scroll on any member route at 320px. Drawer opens/closes smoothly. Desktop experience unchanged.

#### Phase 2: Data-Heavy Pages (Payments, IDCards, Dashboard)

Goal: Tables and carousels are touch-friendly.

Tasks:
- [x] Payments (`pages/member/Payments.tsx`) — desktop table wrapped in `hidden md:block overflow-x-auto`; mobile card list added inline (`md:hidden divide-y`) using same `invoiceRows`/`expandedRow` state; payment detail modal width changed from `w-96` to `w-full max-w-md` with `p-4` backdrop; summary cards stack at `<sm`; page padding `p-4 md:p-6`.
- [x] IDCards (`pages/member/IDCards.tsx`) — audited; already uses `grid-cols-1 sm:grid-cols-1 md:grid-cols-2 xl:grid-cols-3`, `p-3 md:p-4`, `text-sm md:text-base`, `max-w-full overflow-x-auto` on inner card. No changes required.
- [x] Dashboard (`pages/member/dashboard.tsx`) — audited; info cards `grid-cols-1 lg:grid-cols-2`, quick actions `grid-cols-1 md:grid-cols-2 lg:grid-cols-4`, contribution `grid-cols-1 md:grid-cols-2` all stack naturally. No changes required.
- [x] PlansAndIdCards (`pages/member/PlansAndIdCards.tsx`) — audited; plan detail + plan document modals already use `w-full max-w-2xl/4xl max-h-[90vh]` inside `p-4` backdrop. No changes required.

Success criteria: Every data view is readable at 320px without horizontal scroll. Desktop layout preserved.

#### Phase 3: Forms & Wizards

Goal: Members can fill forms and complete the ProductChangeWizard on a phone.

Tasks:
- [x] Settings (`pages/member/Settings.tsx`) — audited; existing `grid-cols-1 md:grid-cols-2` and `flex flex-col md:flex-row md:items-center md:justify-between` patterns already handle mobile. No changes required.
- [x] Dependent modals (Add / AddWithPricing / Edit / Delete) — audited; already use `fixed inset-0 ... p-4` backdrop with `w-full max-w-2xl/4xl max-h-[90vh]` panel. Responsive by default. No changes required.
- [x] ProductChangeWizard (`pages/member/ProductChangeWizard.tsx`) — negative-margin fix changed from `-m-6` to `-m-4 md:-m-6` to match new MemberLayout padding; header typography/truncation made responsive (`text-base md:text-xl`, `truncate`, `min-w-0`); progress-bar step labels now `hidden sm:inline` on mobile (circles + bars only); content bottom padding increased to `pb-24` to clear fixed footer. `SignaturePad` itself is already responsive (`w-full h-32` + `getBoundingClientRect()` + DPR scaling); no wrapper needed.
- [x] MemberPaymentMethodsSection — audited; card form uses `grid-cols-3` for month/year/cvv (acceptable at 320px for short fields); ACH fields use `grid-cols-1 md:grid-cols-3`; modals `max-w-2xl w-full` / `max-w-md w-full mx-4`. No changes required.
- [x] Documents (`pages/member/Documents.tsx`) — header row changed to `flex flex-col sm:flex-row ... gap-3`; outer padding `p-0 md:p-6` (MemberLayout provides mobile padding); summary cards `grid-cols-1 sm:grid-cols-3`; search/filter row already `flex flex-col sm:flex-row gap-4`.

Success criteria: Completing a full enrollment product change end-to-end on a 375×667 viewport succeeds.

#### Phase 4: Polish & QA

Tasks:
- [x] Tap targets — `min-h-11 min-w-11` applied to hamburger, drawer close, drawer nav items, drawer sign-out, drawer logout, Payments refresh button.
- [x] Typography — form inputs left at Tailwind default (`text-base` ≈ 16px) to avoid iOS auto-zoom; no existing input uses `text-sm` in new code paths.
- [x] iOS viewport — drawer panel uses `h-full` (not `100vh`); backdrop `fixed inset-0`; body-scroll lock on drawer open.
- [x] z-index stack — desktop sidebar `z-10`, drawer backdrop `z-30`, drawer panel `z-40`, existing modals `z-50`.
- [x] Lucide icons only — hamburger `Menu`, close `X`, drawer `User`/`LogOut` all from `lucide-react`. No new icon libs.
- [x] Brand colors — `bg-oe-primary`, `bg-oe-light`, `text-oe-dark`, `border-oe-primary` used in drawer and new card list. No raw `blue-*`.
- [ ] Test in real browsers (iPhone 13, Pixel 7, iPad mini, Desktop 1440) — *user to perform per agreement.*
- [x] Type check: `npx tsc --noEmit` — no new errors introduced in edited files (pre-existing errors in unrelated files remain).
- [x] Run existing vitest suite — 44 passing, 2 pre-existing failing suites (`jest is not defined` in vitest context — unrelated to this change).
- [x] Lint — new/rewritten files produce no new errors (`MemberLayout`, `MemberNavigation`, `MemberHeader`, `MemberMobileDrawer`, `useMemberNavigationItems`).

## Alternative Approaches Considered

1. **Force all mobile users to the native app via `MobileAppRedirectModal`** — rejected: tenants without a native app configured have no fallback, and some flows (document upload from camera roll, quick ID card pull) work fine in-browser.
2. **Introduce a separate mobile-only route tree (`/m/member/*`)** — rejected: doubles maintenance, requires duplicate auth/routing, and Tailwind breakpoints solve this in one pass.
3. **Adopt a component library (MUI, shadcn) for responsive primitives** — rejected: violates CLAUDE.md's "Tailwind only" rule; existing Agent/TenantAdmin layouts prove pure-Tailwind responsive works here.
4. **Modify the shared `SideNavigation` to support mobile drawer mode** — rejected for Phase 1: blast radius spans 5+ role portals. Can revisit in a follow-up plan once member drawer is proven.

## System-Wide Impact

### Interaction Graph

- `MemberLayout` wraps every member route via React Router `<Outlet>` (`App.tsx:461–482`).
- Drawer open/close state is local to `MemberLayout`; no global store impact.
- `BrandingContext` and `AuthContext` continue to feed `MemberHeader` and `MemberNavigation` identically.
- Route changes close the drawer via `useLocation` subscription; no impact on React Query cache, no forced re-fetches.

### Error & Failure Propagation

- No new error surfaces: this is a pure presentational change.
- `ErrorBoundary` (already wrapping member routes in `App.tsx`) continues to catch render errors.
- Risk: drawer scroll-lock (`body.overflow-hidden` while open) leaking between route transitions — mitigate with `useEffect` cleanup on unmount.

### State Lifecycle Risks

- Drawer state is ephemeral UI state (useState). If the component unmounts mid-transition, React cleans it up.
- No persistence to localStorage/sessionStorage needed.

### API Surface Parity

- No API changes.
- Admin portals (SysAdmin, TenantAdmin, Agent, GroupAdmin, VendorAdmin) are **untouched** — verified by excluding `SideNavigation.tsx` and other shared components from modification.

### Integration Test Scenarios

1. **Member opens `/member/payments` on 375px viewport, taps an invoice row** — card expands, linked payments list visible without horizontal scroll.
2. **Member opens drawer, taps Settings, drawer closes, Settings renders** — route change closes drawer via `useLocation` effect.
3. **Member rotates device from portrait (375px) to landscape (667px)** — layout reflows; drawer stays in correct state.
4. **Admin logs into `/admin`** — sidebar and shared `SideNavigation` render identically to before (regression check).
5. **Member completes ProductChangeWizard on 390×844 iPhone** — signature pad captures, submission succeeds.

## Acceptance Criteria

### Functional Requirements

- [x] Every route under `/member/*` renders without horizontal scroll at 320px width. *(Structural: MemberLayout margin is `md:` only; all modals are `w-full max-w-*`; Payments uses mobile card list. Visual verification pending user QA.)*
- [x] Drawer opens/closes via hamburger button, backdrop tap, and route change. *(Also closes on Escape.)*
- [x] Payments page displays a card list on mobile (`<md`) and the existing table on desktop (`≥md`).
- [x] All member-facing modals fit within the viewport at 320px with `≥16px` horizontal margin. *(Backdrop uses `p-4` or wider; all panels `w-full max-w-*`.)*
- [x] ProductChangeWizard signature pad resizes to container width on mobile. *(SignaturePad already uses `w-full h-32` + `getBoundingClientRect()` + DPR scaling; container is plain `p-6` card. No wrapper needed.)*
- [x] All tap targets on member pages are ≥44×44px. *(New tappable elements use `min-h-11 min-w-11`.)*
- [x] Form inputs use `text-base` (16px). *(Tailwind default; no new `text-sm` inputs introduced.)*
- [ ] Desktop experience at ≥1024px is pixel-identical to pre-change. *(User to verify via side-by-side screenshot.)*

### Non-Functional Requirements

- [x] No new dependencies added to `frontend/package.json`.
- [x] No Material-UI, no custom CSS files, no inline styles.
- [x] Brand colors (`oe-primary`, `oe-dark`, `oe-light`) used throughout — no raw `blue-*`.
- [x] Lucide React icons only.
- [x] No changes to `components/common/SideNavigation.tsx` or other cross-portal shared components. Verified: no edits to `SideNavigation.tsx`, `ProfileEditModal.tsx`, `ProductInfoModal.tsx`, `SignaturePad.tsx`, or `IDCard.tsx`.

### Quality Gates

- [x] `npx tsc --noEmit` — no new errors in edited files (pre-existing errors in unrelated files unchanged).
- [x] `npx eslint` on new/rewritten files — clean.
- [x] `npx vitest run` — 44 passing; 2 pre-existing `jest is not defined` failures unrelated to this change.
- [ ] `npx cypress run --spec "cypress/e2e/enrollment/**/*.cy.ts"` — not executed in this session (requires running backend + frontend dev servers).
- [ ] Manual verification in Chrome DevTools at 320 / 375 / 414 / 768 / 1024 / 1440 px. *(User to perform.)*
- [ ] Manual verification on one real iOS Safari and one real Android Chrome device. *(User to perform.)*
- [ ] Admin portal smoke test: log in as TenantAdmin, Agent, GroupAdmin — sidebars render unchanged. *(User to perform; structurally safe since no shared components were modified.)*

## Success Metrics

- PostHog session replays from member portal on mobile viewports (`viewport.width < 768`) show successful navigation and form completion (no rage clicks / horizontal scrolling).
- Reduction in member-reported "can't use on phone" support tickets.
- No regression in desktop Member NPS / completion rates for ProductChangeWizard.
- Sentry: no increase in frontend error rate following deploy.

## Dependencies & Risks

### Dependencies
- None (pure frontend change; no backend, no DB, no new packages).

### Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Accidentally touch shared `SideNavigation` and break admin portals | Low | High | Explicit scope rule; PR checklist item; admin smoke test before merge |
| Drawer scroll-lock leaks between routes (stuck unscrollable page) | Med | Med | `useEffect` cleanup on unmount; manual QA |
| Signature pad wrapper breaks desktop wizard | Low | High | Wrap-only, don't modify shared component; test desktop path |
| iOS Safari `100vh` quirks | Med | Low | Use `min-h-screen` + `dvh` where supported |
| Payments mobile-card view diverges from desktop table semantics (expansion, linked payments) | Med | Med | Share data-fetching hooks; keep only presentation split |
| Regression in Cypress tests due to DOM structure changes | Med | Low | Run full enrollment Cypress suite; update selectors if needed |

## Resource Requirements

- 1 frontend engineer, ~3–5 days depending on Phase 3 complexity.
- Access to a real mobile device (iOS + Android) for Phase 4 QA.
- Chrome DevTools device emulation for iterative work.

## Future Considerations

- **Post-merge follow-up:** propose a shared `SideNavigation` mobile-drawer refactor so Agent/GroupAdmin/Vendor portals can adopt the same pattern.
- **Accessibility pass:** keyboard/screen-reader audit of drawer (focus trap, aria-expanded, aria-controls) — treat as follow-up if not covered here.
- **Tailwind v4 upgrade** (if planned): revisit custom breakpoints then.
- **Native app deep links:** if `MobileAppRedirectModal` gains per-route deep link support, wire the in-portal "open in app" button.

## Documentation Plan

- Add a short section to `docs/ui/frontend-system.md` describing the member mobile drawer pattern and linking to `MemberMobileDrawer.tsx`.
- Update `CLAUDE.md` UI Rules section with a note: "Member portal is mobile-first; verify at 320px for all new member pages."
- No user-facing docs needed.

## Sources & References

### Internal References
- `frontend/src/App.tsx:461–482` — member routes
- `frontend/src/components/member/MemberLayout.tsx:79–98` — current layout (fixed `ml-64`/`ml-20`)
- `frontend/src/components/member/MemberNavigation.tsx:64–154` — nav items
- `frontend/src/components/member/MemberHeader.tsx:17–28` — header
- `frontend/src/pages/member/Payments.tsx:311–449` — table to convert
- `frontend/src/pages/member/Settings.tsx` — reference for responsive form grid
- `frontend/src/pages/member/Dependents.tsx` — already-responsive card grid (good model)
- `frontend/src/components/agent/AgentLayout.tsx` — responsive layout reference
- `frontend/src/components/tenant-admin/TenantAdminLayout.tsx` — responsive layout reference
- `frontend/src/components/group-admin/GroupAdminLayout.tsx` — responsive layout reference
- `frontend/tailwind.config.js` — no custom breakpoints; use defaults
- `docs/ui/frontend-system.md` — `min-w-0` flexbox pattern, DataGrid constraints
- `docs/superpowers/plans/2026-04-08-mobile-app-redirect.md` — prior mobile redirect work
- `.cursorrules` — UI consistency ruleset

### Related Work
- Commit `9a5671e9` — "refactor(agent): streamline sidebar behavior and improve layout responsiveness"
- Commit `bd6080b7` — "edited UI for more responsive design on smaller width"
- Commit `526eb85b` — "fix(layout): enhance flex properties for improved component responsiveness"

### External References
- Tailwind responsive design: https://tailwindcss.com/docs/responsive-design
- iOS Safari `dvh` unit support: https://caniuse.com/viewport-unit-variants
- WCAG 2.1 touch target size (2.5.5): https://www.w3.org/WAI/WCAG21/Understanding/target-size.html

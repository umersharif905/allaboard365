# Forms Redesign

Spec for the back-office forms system overhaul. Adds per-form delivery-mode policy, a "send to member" flow with signed links, authenticated member submissions with profile prefill, per-send linkage to ShareRequests (and later Cases), and a universal home for submissions on member profile Documents tab.

## Files in this directory

- **`design.md`** — full architecture and design sections.
- **`current-system-problems.md`** — concrete problems with today's forms system that this redesign fixes. Source material for the PR description.
- **`features/_inventory.md`** — running index of every DB column, route, service, and frontend component this redesign adds. One row per feature with status; one detail file per feature.
- **`features/_template.md`** — copy this when adding a new feature file.
- **`features/feature-NNN-*.md`** — per-feature detail files.

## Scope of this spec

Covers Phases 1–4 from the original brainstorm:
- Form delivery mode policy (anonymous / targeted / authenticated)
- "Send to member" targeted-link flow
- Authenticated submission with profile prefill
- Member profile Documents tab + SR-detail forms section

**Out of scope** (separate later spec):
- Form editor redesign with screener-driven branching
- Consolidation of `UnsharedAmount` + `PreventiveCare` into one intake form
- Cases feature itself (this spec schema-prepares for it)

**Phase 0** (separate small PR, shipped before this spec lands): vendor agent backend access fix — see Section 8 of `design.md`.

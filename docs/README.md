# OpenEnroll docs

Pointers to documented areas under `docs/`. Prefer adding new guides under an existing topical folder rather than leaving files at repo root under `docs/`.

| Area | Folder |
|------|--------|
| Billing, DIME, NACHA, plan-change rules | [`billing/`](billing/) |
| Deployments, env, QE / multi-tenant setup | [`deployment/`](deployment/) |
| Pricing authority phases and test matrices | [`pricing-authority/`](pricing-authority/) |
| Enrollment flows, fees, product rules | [`enrollments/`](enrollments/) |
| Commission system | [`commissions/`](commissions/) |
| DIME webhook processor (Azure Functions) | [`oe_payment_manager/`](oe_payment_manager/) |
| Group billing / locations | [`group-payments/`](group-payments/) |
| Auth, sessions | [`auth/`](auth/) |
| UI / frontend | [`ui/`](ui/) |
| Email (SendGrid, deliverability) | [`email/`](email/), [`microsoft/`](microsoft/) |
| Mobile integration | [`mobile/`](mobile/) |
| Migration / bacpac | [`migration/`](migration/) |
| Product & proposal pricing cheatsheets | [`product-pricing/`](product-pricing/), [`proposals/`](proposals/) |
| Scratch plans & specs | [`plans/`](plans/), [`superpowers/`](superpowers/) |
| System reference dumps | [`reference/`](reference/) |
| Marketing / campaigns | [`marketing/`](marketing/) |

Other top-level repos (e.g. `Project Docs/`, `backend/README.md`) are outside this folder.

## File naming

- New Markdown files here should use **`kebab-case`** (lowercase words separated by hyphens), matching existing areas like [`enrollments/`](enrollments/) and [`issues/`](issues/).
- Older guides may still use `SCREAMING_SNAKE` or CamelCase filenames; converge to kebab-case when you touch those files.


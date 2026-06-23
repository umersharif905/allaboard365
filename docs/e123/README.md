# E123 / Enrollment123 / Administration123 — API Reference

Source platform for the **~2,500 households** being migrated to AllAboard365.
E123 is actually a small family of separate APIs running on two hostnames.
The vendor doesn't expose them as a single, coherent product, so they're
broken out here by purpose.

## Files in this folder

| File | What it is | Source |
|---|---|---|
| `member-search-api.yaml` | OpenAPI 3.0 spec for `user.getall` (read members + dependents + products + transactions) | vendor YAML, canonical |
| `member-crud-api.md` | Member POST/PUT (write members, dependents, products, payment, beneficiary) + Member Notes CRUD | extracted from `RESTful-API.pdf` |
| `checkout-connect-api.json` | OpenAPI 3.0 spec for the hosted checkout/cart→URL flow (JWT auth) | vendor JSON, canonical |
| `agent-api.md` | Administration123 v2: agents, products, licenses, appointments, agent bank accounts | extracted from `API-Agent.pdf` |
| `rate-api.md` | `GetRateDefinition` + `GetRates` quoting service | extracted from `API-Rates.doc` |
| `pricing-and-fees.md` | **Migration learnings:** what E123 does/doesn't expose for net/override/commission/fees | live-data analysis, May 2026 |
| `phase-1.1-product-migration.md` | Phase 1.1 product wizard, mapping, allocation | internal |
| `phase-1.2-agent-migration.md` | Phase 1.2 agent creation wizard, hierarchy tree, ACH, welcome email *(planned)* | internal |

> The vendor's `e123_All_APIs_Combined.json` is **not** kept here — it's just a
> wrapper bundling `member-search-api.yaml` + `checkout-connect-api.json`
> verbatim, so it'd be redundant.

---

## Hosts and auth at a glance

| API | Host | Auth | Format | Canonical doc |
|---|---|---|---|---|
| Member Search (`user.getall`) | `https://www.enrollment123.com/api/user.getall/` | Form fields `CORPID` + `USERNAME` + `PASSWORD` | XML response | `member-search-api.yaml` |
| Member CRUD                   | `https://api.1administration.com/v1/{brokerID}/member/...` | HTTP Basic (URL-embedded) | JSON | `member-crud-api.md` |
| Member Notes                  | `https://api.1administration.com/v1/{brokerID}/member/notes/{memberID}` | HTTP Basic | JSON | `member-crud-api.md` |
| Checkout Connect              | `https://enrollment123.com/order/checkout/connect/` | JWT bearer (`/auth/` issues, basic auth to mint) | JSON | `checkout-connect-api.json` |
| Administration123 v2 (agents) | `https://api.1administration.com/v2/...` | HTTP Basic | JSON | `agent-api.md` |
| Rate                          | `https://www.1administration.com/api/rate/index.cfc` (SOAP envelope, JSON payload) | `Corpid` + `Username` + `Password` in args | JSON | `rate-api.md` |

`brokerID` may be the agent's NPN (`CODE 1`) or CRM agent ID. `CORPID` is the
top-level entity number. Member Search caps results at **1,000 per request**
and uses `NEXT_USER` for cursor pagination. Member CRUD enforces a hard
**30 simultaneous requests** rate limit.

---

## Quick answer to "what can the API do?"

> **Yes — the API can do a lot more than just look up members.** The
> Enrollment123 / Administration123 surface area covers reads, writes,
> notes, agents, licensing, bank accounts, hosted checkout, and quoting.
> The **one notable hole** for our purposes is the **product catalog
> itself**: you can read a list of an agent's products and pull rates,
> but the structural definition of products / benefit levels / pricing
> matrices isn't exposed as a CRUD API. Those have to be created in
> AllAboard365 manually before the migration.

### What we can read
- **Members** — full demographics, custom questions, status, lead/CRM fields,
  refund history, hold history. (`user.getall`)
- **Dependents** — full demographics, relationship, UUID. (`user.getall` with `RETURN_DEPENDENTS=1`)
- **Beneficiaries** — basic identity. (`RETURN_BENEFICIARIES=1`)
- **Member products** — `pdid`, `policynumber`, `bpaid`/`bhold`/`battended` flags,
  effective/billing/recurring/cancel/fulfillment/transfer/renewal dates,
  hold reason/type, cancel reason, shipping info, attached **product fees**
  (the actual price record per benefit/period). (`RETURN_PRODUCTS=1`)
- **Transactions** — full transaction header, gateway response, settle/refund/
  chargeback flags, plus nested `transactiondetails` (the products charged on
  that transaction with paid-through dates) and `transactionpayments` (the
  CC or ACH instrument used). (`RETURN_TRANSACTIONS=1`)
- **Agents, licenses, appointments, agent bank accounts** — via the v2
  Admin API. Including agent-product list with category/underwriter/no-sale-states.
- **Rates** — calculated rate per benefit + period for a given product
  and member shape. (`GetRates`)
- **Member Notes** — paginated, date-filterable.

### What we can write
- **Members + nested dependents + products + payment + beneficiary**, all in a
  single POST. PUT updates an existing member. Member can be created with our
  own `UNIQUEID` (good for migration idempotency).
- **Payment methods** as part of a member POST: `CC`, `ACH`, `LB` (list bill),
  `Other`, or **tokenized** (token + last4 — useful if their gateway tokens
  can be re-vaulted on our side).
- **Product fees** can override the agent's Price Matrix per benefit/period
  on the member's policy.
- **Member Notes** — full CRUD (soft delete only).
- **Agent records, licenses, appointments, agent bank accounts** — full CRUD via v2.
- **Hosted checkout cart → URL** for collecting payment from a member through
  the e123-branded checkout page (Checkout Connect).

### What the API does NOT do
- **No product / benefit / period CRUD.** You can't define a new product or
  pricing matrix via API — must be configured in the e123 UI.
- **No transaction creation or refund** beyond what naturally happens during
  a member POST with `PAYMENTPROCESS=Y`. There's no `POST /transaction` or
  `POST /refund` surface.
- **No invoice / list-bill management** beyond reading transactions.
- **No commission API** — commission records aren't exposed. **`productfee.amount`
  is a single premium total** — no per-product split of net / override /
  commission / system fees. See `pricing-and-fees.md`.
- **No webhook surface documented.** Migration is pull-only; we have to poll
  `user.getall` (it does support `USER_CHANGED_FROM` for incremental sync).
- **No bulk member endpoint.** Writes are one member at a time.
- **No bank account read for members.** You can write a payment method on a
  member POST, but `user.getall` only exposes payment instruments inside
  `transactions[].transactionpayments` (i.e. as historical evidence on a charge,
  not as the member's saved-on-file profile). Routing/account numbers in that
  block are typically masked.
- **No file/document download** of policy PDFs, ID cards, or attachments.
- **No telemedicine / vendor / lab integration data.**
- **No Member Search by Bank** (no payment-method search by routing/account
  beyond ACH/CC last4 and CC type/exp).

---

## Migration relevance — what each API gets us

| Migration target on AllAboard365 | E123 source | Notes |
|---|---|---|
| Households (primary member) | `user.getall` (search) | Use `USER_CHANGED_FROM` for incremental delta sync; paginate via `NEXT_USER`. |
| Dependents | `user.getall` with `RETURN_DEPENDENTS=1` | UUID is the stable key for re-runs. |
| Plans / member products | `user.getall` with `RETURN_PRODUCTS=1` | Carries effective/billing/recurring/cancel dates, policy number, hold/suspend state, **and the per-member `productfees`** (true price). Use `pdid`+`benefitid`+`periodid` to map onto our plan catalog. **`productfee.amount` = MSRP only** — fee component split requires AB365 inference (`pricing-and-fees.md`). |
| CC processing surcharge | `user.getall` with `RETURN_TRANSACTIONS=1` | Separate **`Processor Fee`** line (~3%) on some CC `transactiondetails` — not on enrollment `productfees`. Do not merge into tier MSRP. |
| Plan catalog (the product structures themselves) | **Not in API.** Use `/v2/products/{agent_id}` for the list of products + `GetRateDefinition` / `GetRates` to recover pricing structure. | Have to build/import these into AllAboard365 manually before household migration. |
| Bank info | **Use the separate "bank info" doc you mentioned.** API only surfaces masked payment data inside historical transactions; full ACH/CC details aren't readable. | Routing/account fields exist on the *write* side (`PAYMENT.ACHROUTING/ACHACCOUNT`), so if we ever import bank info into e123 we have it, but pulling it back out isn't supported. |
| Transaction history (for ledger reconciliation) | `user.getall` with `RETURN_TRANSACTIONS=1` | Each transaction has `transactiondetails` (per-product paid-through windows) and `transactionpayments` (instrument used, masked). |
| Agents & their licenses | `/v2/agents`, `/v2/products`, `/v2/agents/{id}/licenses`, `/appointments` | If we want to lift agents over with appointment history. |
| Member notes / activity history | `GET /v1/{brokerID}/member/notes/{memberID}` | Paginated, soft-deleted notes excluded. |

---

## Practical sync pattern

Recommended discovery flow for the 2,500 household migration:

1. **Catalog products first** — call `/v2/products/{agent_id}` to enumerate
   product `pdid`s, then `GetRateDefinition` + `GetRates` per product to
   recover the benefit/period/price grid. Map each `pdid+benefitid+periodid`
   to a target AllAboard365 plan tier.
2. **Page through members** — `POST /api/user.getall/` with
   `RETURN_DEPENDENTS=1`, `RETURN_PRODUCTS=1`, `RETURN_TRANSACTIONS=1`,
   `RETURN_BENEFICIARIES=1`, `RETURN_USERCUSTOMQUESTIONS=1`,
   `RETURN_USERPRODUCTCUSTOMQUESTIONS=1`. Use `NEXT_USER=<last userid>` until
   `<users total="0"/>`.
3. **Backfill notes** per member with `GET /v1/{brokerID}/member/notes/{memberID}`.
4. **Pull bank info** from the offline doc (not via API).
5. **Cutover sync** — re-run step 2 with `USER_CHANGED_FROM=<last cutover ts>`
   to catch deltas without a full re-pull.

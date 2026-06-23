# E123 Pricing & Fee Structure — Migration Notes

> Live-data findings from ShareWELL migration batch + `user.getall` pulls (May 2026).
> Use this when mapping E123 premiums onto AB365 `ProductPricing` fields
> (`NetRate`, `OverrideRate`, `VendorCommission`, `SystemFees`, `MSRPRate`).

---

## Can we split net / override / commission / fees from E123?

**No** — not as separate labeled fields per product.

**Yes** — for **one** number: `productfee.amount` is the member **MSRP / total product premium**
for that tier. That is the only pricing value reliably present on enrollment.

What you **cannot** read from E123 per tier:

| AB365 field | E123 equivalent |
|---|---|
| `MSRPRate` | ✅ `productfee.amount` |
| `NetRate` | ❌ not exposed |
| `OverrideRate` | ❌ not exposed |
| `VendorCommission` | ❌ not exposed ( `commissionableamount` is a partial/unreliable hint ) |
| System / processing fees | ❌ not on enrollment; CC **`Processor Fee`** is billing-only, separate line |

E123 does **not** expose a per-product breakdown of vendor net, misc override,
agent commission, and platform/processing fees. You get at most:

| E123 field | Where | What it actually is |
|---|---|---|
| `productfee.amount` | Enrollment (`RETURN_PRODUCTS=1`) | Member **product premium** — treat as MSRP for migration |
| `productfee.commissionableamount` | Enrollment | Partial hint for agent commission base — often **blank** on MEC; when present may equal `amount` or be less (e.g. BCS ~5.7% gap). **Not** AB365 `VendorCommission` |
| `productfee.type` | Enrollment | Almost always `Product`; rarely `Tobacco Surcharge` |
| `GetRates` → `RATE` | Quote API | Single total per benefit/period — no component split |
| `Processor Fee` | Billing only (`RETURN_TRANSACTIONS=1`) | CC payment surcharge — **separate line**, not on enrollment |

There is **no commission API** and **no System Fee** label in E123 data.

AB365-side allocation (template match, commissionable gap, tier defaults) is
**inference**, not a read of E123's internal ledger.

### E123 member import — processing fee storage

When a mapped product has `IncludeProcessingFee` on AB365 catalog:

- Product enrollment: `PremiumAmount` = base MSRP; `IncludedPaymentProcessingFeeAmount` = catalog stored fee
- `PaymentProcessingFee` enrollment row (if any): **non-included remainder only** — omitted when all imported products include their processing fee
- Premium compare (`compareHouseholdPremiums`) uses member retail total — `MSRPRate` when it already includes the stored fee, otherwise base + `IncludedProcessingFee` for legacy rows

---

## Fee type labels seen in production data

Across member search + migration batch (ShareWELL corp):

| `type` value | Scope | Notes |
|---|---|---|
| `Product` | Enrollment `productfees` + transaction details | Tier premium (Member Only, Family, etc.) |
| `Tobacco Surcharge` | Enrollment `productfees` | ShareWELL products only |
| `Processor Fee` | Transaction details only | CC charges — see below |

Documented in OpenAPI / GetRates but **not observed** on enrolled MEC copay
lines: `Enrollment`, `Association`, `Tax`.

---

## Enrollment `productfees` (what migration imports)

Typical MEC copay (`pdid` 45173 — eBenefits Copay MEC):

- **One line per active enrollment** — `type: "Product"`, tier in `benefitlabel`
- `commissionableamount` is an **empty string** (not `0`)
- `amount` is the stored member premium; commonly **flat/round** by design
  (e.g. `$180`, `$403`, `$289`) with occasional cent amounts (`$180.08`,
  `$296.77`, `$413.47`) from rate-era or CC-inclusive rounding

**No second fee line** on enrollment for processing or system fees.

---

## `Processor Fee` (billing transactions only)

When present, appears inside `transactions[].transactiondetails[]` as a
**sibling** fee row next to the `Product` row — not inside `productfees`.

Example (eBenefits Copay EF, CC charge):

```
Product:        $403.00
Processor Fee:  $ 12.09   (3% of product line)
Total charged:  $415.09
```

Observed patterns (ShareWELL broker tree sample, ~1,388 processor lines):

- **~96%** are exactly **3.0%** of the product line amount
- Remaining spread (~2.97–3.8%) from rounding
- **CC only** in samples — not on enrollment `productfee.amount`
- Label is exactly **`Processor Fee`** in the `<type>` element

Business intent (per tenant ops): flat tier rates often **include** processing
(~3.5% then round up). E123 still stores that as a single `Product` amount on
enrollment; the separate `Processor Fee` line is an **additional CC surcharge**
on some billing runs, not a labeled split of the tier itself.

`45173` had hundreds of CC transaction details with `Processor Fee`; migration
batch stores **product line only** (no transactions unless
`RETURN_TRANSACTIONS=1` on import).

### XML parsing note

Transaction fee rows use nested `<transactionfees>` elements (wrapper + one
element per fee line). Do **not** parse with a naive single-level regex — inner
fee blocks start with `<transactionfees><currency>`.

---

## GetRates quote API

`GetRates` returns one `RATE` per benefit row. Row `TYPE` may be `Product`,
`Enrollment`, `Association`, or `Tax`, but each row is still a **single total** —
no net/override/commission fields.

Some products (e.g. copay MEC) return `BERR` for GetRates in certain corps;
rely on enrolled `productfees` + AB365 catalog for those.

---

## Mapping implications for AB365

| AB365 field | E123 source? | Migration approach |
|---|---|---|
| `MSRPRate` | `productfee.amount` | Direct — this is the member premium tier |
| `NetRate` | ❌ | Infer from AB365 template / reference product |
| `OverrideRate` | ❌ | Infer (commissionable gap when `commissionableamount` present; else template) |
| `VendorCommission` | ❌ | Infer from template or tier defaults |
| `SystemFees` | ❌ | AB365 tenant config only — no E123 equivalent |
| Payment processing fee | `Processor Fee` on CC txs only | **Do not** fold into `ProductPricing` — payment-layer, optional, CC-only |

E123 `amount` vs AB365 MSRP for the same copay tier can differ by **~4–5%**
across rate eras — that gap is **not** explained by stripping a visible E123
fee line; use catalog/template matching, not fee arithmetic.

---

## Related docs

- `member-search-api.yaml` — `productfee` and `transactionfee` schemas
- `rate-api.md` — GetRates row shape
- `phase-1.1-product-migration.md` — wizard mapping + allocation services
- `backend/services/migration/e123PricingAllocation.service.js` — inference priority chain

# E123 Rate API

> Source: `API-Rates.doc`
> SOAP/JSON webservice that returns rate quotes for an agent's product without
> creating any records. Useful for quoting / calculator UIs.

---

## Service location

```
WSDL: https://www.1administration.com/api/rate/index.cfc?wsdl
```

Two functions are exposed: `GetRateDefinition` and `GetRates`.

Both accept the same auth params:

| Param | Required | Description |
|---|---|---|
| `Corpid`   | Yes | Entity ID of the product |
| `Username` | Yes | Username within entity |
| `Password` | Yes | Password within entity |
| `payload`  | Yes | JSON string |

---

## `GetRateDefinition`

Returns the rating field definitions (what `PRIMARY` / `SPOUSE` / `CHILDREN`
inputs the product needs).

**Payload**
```json
{ "PRODUCT": { "PRODUCTID": 1234, "AGENTID": 567890 } }
```

**Response (no error)**
```json
{
  "PRODUCT": { "PRODUCTID": 1234, "AGENTID": 567890 },
  "VERSION": 0,
  "PRIMARY": {},
  "SPOUSE":  {}
}
```

Optional `DISPLAYSTART` / `DISPLAYSTOP` (mm/dd/yyyy) on `PRODUCT` filter results.

**Error response**
```json
{ "BERR": 1, "ERRORMESSAGE": ["..."] }
```

---

## `GetRates`

Returns calculated rates for the supplied member shape.

**Payload (4 required structures)**
- `PRODUCT`  — `PRODUCTID`, `AGENTID`, plus any product-level questions
  (e.g. effective date, custom questions). Optional `DISPLAYSTART`/`DISPLAYSTOP`.
- `PRIMARY`  — values for the primary member.
- `SPOUSE`   — only `AGE`, `DOB`, `GENDER`, `BSMOKER`.
- `CHILDREN` — array of objects with the same fields as spouse.

Extra fields are ignored, missing required fields produce errors. Use
`GetRateDefinition` to discover the expected shape per product.

**Response**
```json
{
  "ERRORMESSAGE": [],
  "BERR": 0,
  "ID":   1234,
  "LABEL": "Basic ",
  "RATES": [
    { "BENEFITID": 16, "BENEFITLABEL": "Single", "RATE": 20.00,
      "PERIODID": 1, "PERIODLABEL": "per Month", "TYPE": "Product",
      "DISPLAYSTART": "01/01/2024", "DISPLAYSTOP": "01/01/2025" },
    { "BENEFITID": 21, "BENEFITLABEL": "Family", "RATE": 50.00,
      "PERIODID": 1, "PERIODLABEL": "per Month", "TYPE": "Product",
      "DISPLAYSTART": "01/01/2024", "DISPLAYSTOP": "01/01/2025" },
    { "BENEFITID": "",  "BENEFITLABEL": "",      "RATE": 50.00,
      "PERIODID": 7, "PERIODLABEL": "one-time", "TYPE": "Enrollment",
      "DISPLAYSTART": "01/01/2024", "DISPLAYSTOP": "01/01/2025" }
  ]
}
```

### Rate row fields
`BENEFITID`, `BENEFITLABEL`, `RATE` (USD), `PERIODID`, `PERIODLABEL`, `TYPE`
(e.g. `Product`, `Enrollment`, `Association`, `Tax`), `DISPLAYSTART`, `DISPLAYSTOP`.

Each row is a **single total** — no net/override/commission breakdown. For what
E123 does expose on enrolled members vs billing transactions, see
`pricing-and-fees.md`.

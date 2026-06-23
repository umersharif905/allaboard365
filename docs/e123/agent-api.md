# E123 Administration123 v2 API (Agents, Licenses, Appointments, Bank Accounts)

> Source: `API-Agent.pdf`
> This is the **agent-side** REST API: maintain agent records, their licenses,
> appointments, products, and bank/payment instruments.

---

## Base

```
Endpoint: https://api.1administration.com/v2
Auth:     HTTP Basic (username + password) — or `Authorization: Bearer base64(user:pass)`
Format:   JSON over HTTPS only
Errors:   Conventional HTTP codes; 402 = valid request that failed to complete
```

Error payload shape:
```json
{ "type": "invalid_request_error", "message": "...", "param": "fieldname" }
```
`type` ∈ `api_connection_error | api_error | authentication_error | invalid_request_error | rate_limit_error`.

---

## Settings (lookup lists)

| Method | Path | Returns |
|---|---|---|
| GET | `/v2/settings/vendors`       | `[ { "id": 123, "label": "..." } ]` |
| GET | `/v2/settings/taxidtypes`    | `["Tax Type 1", "Tax Type 2"]` |
| GET | `/v2/settings/licensetypes`  | `["License Type 1", ...]` |
| GET | `/v2/settings/underwriters`  | `["Underwriter 1", ...]` |

---

## Agents

### Object
`id`, `label`, `active`, `parent`, `companyname`, `firstname`, `lastname`, `email`, `email2`,
`address1`, `address2`, `city`, `state`, `zipcode`, `phone1`, `phone2`, `fax`,
`taxid`, `taxidtype`, `code`, `code2`, `brokerSource`, `brokerFlag`,
`brokerType`, `brokerType2`, `brokerType3`, `brokerStatus`,
`dtActive`, `dtInactive`, `bGroup` (0/1), `bGroupListBill` (0/1), `bWebsiteActive` (0/1),
`ReferredBy`, `Region`, `Department`, `Division`,
`licenses` (list), `products` (hash with count + URL).

### Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET  | `/v2/agents/{agent_id}`              | Retrieve agent |
| POST | `/v2/agents/{agent_id}`              | Create child agent under this one |
| POST | `/v2/agents/login`                   | Validate `username` + `password`, returns `{ id, url }` |

Required on create: `label`, `companyname`. Most other fields optional.

---

## Products (agent-scoped, read-only)

### Object
`id`, `label`, `active`, `category`, `underwriter`, `noSaleStates`, `defaultNoSaleStates`.

### Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET | `/v2/products/{agent_id}`               | List all products for agent (sorted by label) |
| GET | `/v2/products/{agent_id}/{product_id}`  | Retrieve single product |

---

## Licenses

### Object
`id`, `url`, `state`, `number`, `suspended_reason`, `issued_date`, `expiration_date`,
`suspended_date`, `types` (list), `appointments` (list).

### Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET    | `/v2/agents/{agent_id}/licenses/{license_id}` | Retrieve |
| POST   | `/v2/agents/{agent_id}/licenses`              | Create |
| PUT    | `/v2/agents/{agent_id}/licenses/{license_id}` | Update (unspecified fields preserved) |
| DELETE | `/v2/agents/{agent_id}/licenses/{license_id}` | Delete (also removes child appointments) |

Create/update fields: `licstate`, `issued_date`, `expiration_date`, `suspended_date`,
`licnumber`, `state_no_resident`, `description`, `perpetual` (bool), `resident_state`,
`lictype` (CSV of values from `/settings/licensetypes`).

---

## Appointments (per license)

### Object
`id`, `url`, `broker` (`{ id, label }`), `appointment_code`, `effective_date`,
`expires_date`, `training_date`, `underwriters` (list).

### Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET    | `/v2/agents/{agent_id}/licenses/{license_id}/appointments/{appointment_id}` | Retrieve |
| POST   | `/v2/agents/{agent_id}/licenses/{license_id}/appointments`                  | Create |
| PUT    | `/v2/agents/{agent_id}/licenses/{license_id}/appointments/{appointment_id}` | Update |
| DELETE | `/v2/agents/{agent_id}/licenses/{license_id}/appointments/{appointment_id}` | Delete |

Fields: `appointment_code`, `effective_date`, `expires_date`, `training_date`,
`underwriters` (CSV of values from `/settings/underwriters`).

---

## Bank Accounts (agent payment instruments)

### Object
`ID`, `ACTIVE` (1/0), name + address fields, `TELEPHONE`, `EMAIL`,
`PAYTYPE` (`CC` | `ACH`).

CC fields: `CARDTYPE` (Visa/Mastercard/Discover/American Express), `CARDNUMBER`, `CARDNUMBERLAST4`, `CARDEXPDATE`, `CARDEXPMONTH`, `CARDEXPYEAR`.

ACH fields: `BANKNAME`, `ROUTINGNUMBER`, `ACCOUNTNUMBER`, `ACCOUNTNUMBERLAST4`,
`ACCOUNTTYPE` (`C`/`S`), `CHECKTYPE` (`B`/`I`), `CHECKNUMBER`, `MEMO`, `SIGNATURENAME`.

Bookkeeping fields: `ACCOUNTLABEL`, `LEDGERACCOUNT`, `COMMISSIONPAYABLES` (0/1),
`INVOICEPAYMENTS` (0/1), `URL`, `BOTHERPAYOR` (0/1), `RELATIONSHIP`
(required when `BOTHERPAYOR=1`).

### Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET    | `/v2/agents/{agent_id}/bankaccounts/{bankaccount_id}` | Retrieve |
| POST   | `/v2/agents/{agent_id}/bankaccounts/{bankaccount_id}` | Create |
| PUT    | `/v2/agents/{agent_id}/bankaccounts/{bankaccount_id}` | Update |
| DELETE | `/v2/agents/{agent_id}/bankaccounts/{bankaccount_id}` | Delete |

Required on create/update: `active`, name + address + telephone + email,
`paytype`, plus the `CC`- or `ACH`-specific block.

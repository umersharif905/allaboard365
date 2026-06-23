# E123 Member CRUD + Notes API (RESTful)

> Source: `RESTful-API.pdf` (Enrollment123.com, revised Nov 6, 2025).
> This is the **write** API for members — used to create or update a household,
> their dependents, products, beneficiary, and payment method. Read/lookup is
> covered by the separate Member Search API (`user.getall`).

---

## Base

```
Host:   https://api.1administration.com
Auth:   HTTP Basic — username:password embedded in URL or Authorization header
Format: JSON
```

`brokerID` may be either the agent's NPN number (`CODE 1`) or the agent's CRM ID.

---

## Member Add / Update

```
POST  /v1/{brokerID}/member/0.json                 # Add (or update if matched)
PUT   /v1/{brokerID}/member/{memberID}.json        # Update existing only
```

- **POST**: send the JSON string as form field `member`.
- **PUT**: send the JSON string as the raw request body.

### Required fields on member root
| Field | Notes |
|---|---|
| `CORPID` | Numeric, assigned entity code |
| `AGENT` | Assigned agent ID |
| `LASTNAME` | Required string |

### Member structure (selected fields)
`UNIQUEID`, `USEINTERNALIDASMEMBERID` (Y/N), `FIRSTNAME`, `MIDDLENAME`, `LASTNAME`,
`DOB` (mm/dd/yyyy), `GENDER` (M/F), `RELATIONSHIP`, `ADDRESS1`, `ADDRESS2`, `CITY`,
`STATE` (2 char), `ZIPCODE` (5), secondary address fields (`OTHER_*`), `EMAIL`,
`EMAIL2`, `PHONE1-3`, `FAX`, `DLNUMBER`, `SSN`, `LEAD` (Y/N), `TOBACCO`, `HEIGHT`,
`WEIGHT`, `CREATEDDATE`, `SOURCE`, `SOURCEDETAIL`, `TPVDATETIME`, `TPVCODE`,
`USERNAME`, `PASSWORD`, `PAYMENTPROCESS` (Y triggers gateway charge), and CRM fields
(`COMPANY`, `DEPARTMENT`, `DIVISION`, `OCCUPATION`, `LEADNEXTSTEP`, `dtLeadNextStep`).

To explicitly null a field, send the literal string `"[null]"`.

### Sub-structures

**`PAYMENT`** (single object, optional). `PaymentType` is required if present:
- `CC` → requires `CCNUMBER`, `CCEXPMONTH` (mm), `CCEXPYEAR` (yyyy); optional `CCTYPE`, `CCSECURITYCODE`.
- `ACH` → requires `ACHROUTING` (9 digit), `ACHACCOUNT`; optional `ACHTYPE` (`C`/`S`), `ACHBANK`.
- `LB` (list bill) or `Other` → no extra required fields.
- `Token` flow → send `Token` + `Last4` (last 4 of original method).

Billing identity fields: `Firstname`, `Lastname`, `Address`, `City`, `State`, `Zipcode`.

**`BENEFICIARY`** (single object). `name` required if sent. Plus address, relationship, phone, dob.

**`DEPENDENTS`** (array). `firstname` + `lastname` required. `uuid` required for updates.
Each dependent may carry a nested `PRODUCTS` array (same shape as primary, `pdid` must match a primary product).

**`PRODUCTS`** (array). `pdid` required.
Other fields: `benefitid`, `periodid`, `dtEffective`, `bPaid`, `dtBilling`, `dtRecurring`,
`dtCreated`, `dtFulfillment`, `dtCancelled`, `dtTransfer`, `policynumber`, shipping fields,
`product_agentID`, `enrollerID`, `productcode2`, `productSource`, `productNextStep`, status/stage tracking.

**Product `FEES`** array (current method) — overrides Price Matrix entries:
```json
{ "type": "PRODUCT", "amount": "22.22", "benefitID": 9525, "periodID": 1, "commissionableAmount": "10.22" }
```
Each fee requires `type`, `amount`, `benefitID`, `periodID`. Deprecated alternative is a flat object `{ "Product": "1.11", "Enrollment": "2.22", "Tax": "9.99" }`.

**`CUSTOMFIELDS`** — keyed by the field's configured `code`, on member or per-product.

### Successful response
```json
{
  "success": true,
  "member":   { "id": "MEMBERID", "name": "FULLNAME" },
  "product":  [ { "pdid": 12345, "effective": "01/01/2018", "billing": "12/20/2017", "recurring": "01/20/2018", "paid": true, "policynumber": "1010101" } ],
  "dependents": [ { "uuid": "...", "firstname": "...", "products": [...] } ],
  "transaction": { "success": true, "authcode": "abc123", "transactionID": "...", "response": "Gateway Approved", "amount": 133.84 }
}
```

### Failure response
```json
{ "success": false, "message": [ "error string", ... ] }
```

### Common error messages
- Auth: `Please provide a valid username and password.`, `Found multiple authentication accounts.`, `You are not authorized to add a member to this broker.`, `Agent is Inactive.`
- Validation: `When adding dependents, the First and Last Name are required.`, `When adding products, the PDID required.`, `Invalid PRODUCT ID.`, `Invalid PRODUCT FEE.`, `Invalid ENROLLMENT FEE.`, `Product <id> not available, no pricing information for product, benefit and period specified`.
- Payment: `A CC Number is required when submitting CC payment information.`, `Routing and Account Numbers are required when submitting ACH payment information.`, `The last 4 digits of the original payment method are required when submitting Tokens`, `<Member ID>|Transaction Failed: <Gateway Response>`, `Error processing transaction: Check your <transaction type> settings.`
- Username/uniqueness: `Username is already in use. Could not complete the update.`
- Throttle: `You have exceeded your rate limit.` (limit: 30 simultaneous requests).

---

## Member Notes CRUD

```
GET    /v1/{brokerID}/member/notes/{memberID}                     # list
POST   /v1/{brokerID}/member/notes/{memberID}                     # create
PUT    /v1/{brokerID}/member/notes/{memberID}?unid={noteID}       # update
DELETE /v1/{brokerID}/member/notes/{memberID}?unid={noteID}       # soft delete (sets bDelete=1)
```

`memberID` accepts the Member ID, SSN, or Internal ID.

### GET query params
| Name | Type | Notes |
|---|---|---|
| `limit`     | int  | Default 10, max 100 |
| `offset`    | int  | Default 0 |
| `startDate` | date | `yyyy-mm-dd`, filters `dtCreated >=` |
| `endDate`   | date | `yyyy-mm-dd`, filters `dtCreated <=` |

### GET response
```json
{
  "success": true,
  "memberid": "MBR123456",
  "notes": [
    {
      "unid": "9876543210",
      "user_id": 123456,
      "username": "john.doe",
      "dtCreated": "2026-03-15 14:30:45",
      "note": "Customer called regarding policy details.",
      "dtUpdated": "2026-03-16 10:20:15",
      "userUpdated": "jane.smith"
    }
  ],
  "pagination": { "limit": 20, "offset": 0, "total": 45, "hasMore": true }
}
```

### POST / PUT body
```json
{ "note": "Customer called to update contact information." }
```

### Behavior notes
- Only non-deleted (`bDelete=0`) and non-system (`bSystem=0`) notes are returned.
- System-generated notes cannot be modified or deleted via the API.
- All operations are logged to the member's activity history.
- Soft delete only — record is retained.

### Error envelope
```json
{ "success": false, "errors": ["Invalid or missing Member ID."] }
```

HTTP status codes: `400`, `401`, `404`, `405`, `500`.

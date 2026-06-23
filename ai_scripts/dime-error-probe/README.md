# DIME error probe

Hits the **DIME demo sandbox** with the scenarios in `scenarios.json` and dumps the raw HTTP response shape for each. The point is to validate — and extend — the known-failure catalog that drives classification in `backend/services/dimeService.js` (`isUserActionable`, the decline regex, etc.) without guessing.

## What it does

1. Loads the testing DB's `PaymentProcessorSettings` for a tenant (default: `MightyWell Health`).
2. Decrypts the DIME `apiToken` using the backend's `encryptionService` with `ENCRYPTION_KEY` from `backend/.env`.
3. **Refuses to run if the tenant's DIME `environment` is anything other than `demo`.** Sandbox-only, always.
4. For each scenario: creates a throwaway DIME customer, then posts the card/ACH payload to `/api/payment-method/create`.
5. Writes raw responses to `results/<timestamp>.json` and a human-readable summary to `results/<timestamp>.md`.

## Prereqs

- `ai_scripts/.env` — same file `db-query.sh` uses (DB_SERVER / DB_NAME / DB_USER / DB_PASSWORD pointed at `allaboard-testing`).
- `backend/.env` with the same `ENCRYPTION_KEY` used to encrypt the stored `apiTokenEncrypted`.
- `backend/node_modules` installed (`cd backend && npm install`) — the probe re-uses `mssql`, `axios`, and `encryptionService` from there.

## Run

```bash
# All scenarios, MightyWell Health tenant (testing DB):
node ai_scripts/dime-error-probe/probe.cjs

# Different tenant:
node ai_scripts/dime-error-probe/probe.cjs --tenant "AllAboard365 Test"

# One scenario:
node ai_scripts/dime-error-probe/probe.cjs --scenario cc.decline.insufficient-funds

# Only credit cards (skip ACH):
node ai_scripts/dime-error-probe/probe.cjs --skip-ach

# Only ACH (skip credit cards):
node ai_scripts/dime-error-probe/probe.cjs --skip-cc
```

## Reading results

- `results/<ts>.md` gives you the quick table: scenario → HTTP status → classification bucket → message.
- `results/<ts>.json` has the full raw response body per scenario — useful when DIME returns a new message shape that the classifier isn't recognizing.

### Classification buckets

| bucket             | meaning                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `success`          | HTTP 2xx — card/ACH vaulted                                                     |
| `validation`       | HTTP 4xx with a non-empty `errors` object (field-level DIME validation)         |
| `known_decline`    | HTTP 4xx whose message matches the decline regex in `dimeService.js`            |
| `unclassified_4xx` | HTTP 4xx we couldn't bucket — add these to the regex or the catalog            |
| `server_error`     | HTTP 5xx — treated as transient (`processor_unavailable` in the backend)        |
| `auth_error`       | HTTP 401/403 — check credentials; shouldn't happen in a healthy sandbox         |

## Extending the catalog

If a scenario lands in `unclassified_4xx`, copy the returned message into `looksLikeDecline` in `backend/services/dimeService.js` (both the card and ACH branches), then re-run the probe to confirm it now bubbles up as `known_decline` → the user gets a real reason instead of the generic "Payment method rejected for unknown reason" copy.

## Safety

- Sandbox only. The env check aborts before any request if the tenant isn't on `environment=demo`.
- Test card numbers are from the DP test CSVs and HPS test values — no real cardholder data.
- The throwaway customers created during a run stay in the demo tenant's DIME account; they do not touch production.

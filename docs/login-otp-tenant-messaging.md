# Login OTP — tenant messaging credentials

## Resolution order (OpenEnroll members)

For each `oe.Users.TenantId`, OTP uses `tenant-messaging-credentials.service.js`:

1. **Tenant** `AdvancedSettings.messaging` (optional API keys)
2. **Tenant** `sms.customFromPhone` / `email.customFromAddress` (from addresses)
3. **MightyWELL Health** tenant (same fields) — platform default tenant
4. **App settings** `TWILIO_*`, `SENDGRID_API_KEY`, `DEFAULT_FROM_EMAIL`

Set `PLATFORM_DEFAULT_TENANT_ID` or `MIGHTYWELL_TENANT_ID` to override MightyWELL lookup by name.

## Optional tenant JSON (`AdvancedSettings.messaging`)

```json
{
  "messaging": {
    "twilioAccountSid": "AC...",
    "twilioAuthToken": "...",
    "twilioPhoneNumber": "+1...",
    "sendgridApiKey": "SG....",
    "defaultFromEmail": "noreply@example.com"
  },
  "sms": { "customFromPhone": "+1..." },
  "email": {
    "customFromAddress": "noreply@tenant.com",
    "dkimEnabled": true
  }
}
```

If `messaging` keys are omitted, MightyWELL + env defaults are used. From-address fields still apply per tenant.

## Household spouse contact (login lookup)

- **Mobile / portal (OpenEnroll):** OTP lookup accepts the primary member’s phone/email or a **spouse** (`RelationshipType = S`) user’s phone/email in the same `HouseholdId`. Mobile prefers the **primary** login when both match. Codes are sent to the phone or email entered.
- **OG (ShareWell SQL):** Same idea via `account_id` — spouse `members.email`, `phone1`, or `phone2` can be used; login still resolves to the primary `users` row.

## OG (ShareWell SQL)

Legacy members use **mobile-app-api** app settings only (synced from AllAboard365-Backend). No per-partner JSON in ShareWELL DB today.

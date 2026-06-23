# Back Office Email — Admin Setup (hand-off)

Concrete, copy-pasteable steps to light up the Back Office inbox. Companion to
[`blockers.md`](./blockers.md). Known values are filled in.

| Value | |
|---|---|
| Shared mailbox (B-005) | `membersuccess@sharewellpartners.com` |
| App registration **Client ID** | `67d927e8-a1c7-49ae-95f0-452e0b66a992` |
| Directory (**tenant**) ID | `dab84bb8-e15a-46f8-a85a-e5f1a95d0200` (same tenant as existing `AZURE_TENANT_ID`) |
| Client secret | **value not stored here** (in DB config only); secret ID `0bdfbf82-15a5-49de-83f1-eb246711e467`, **expires ~2026-12-02** |
| Sharewell vendor row | `oe.Vendors` `VendorId = D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6` |
| Webhook URL | `https://api.allaboard365.com/api/webhooks/graph-email` |

---

## 1. Grant admin consent (B-001) — *Global Admin*
Microsoft Entra admin center → **App registrations** → the app → **API permissions** →
**"Grant admin consent for <Org>"** → **Yes**. Confirm these three **Application**
(not Delegated) Microsoft Graph permissions flip to green **Granted**:
`Mail.Read`, `Mail.ReadWrite`, `Mail.Send`.

## 2. Scope the app to ONE mailbox (B-002) — *Exchange Online Admin, PowerShell*
Without this the app can read **every** mailbox in the org. Run in Exchange Online PowerShell:

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser   # once, if needed
Connect-ExchangeOnline

# Mail-enabled security group containing ONLY the shared mailbox
New-DistributionGroup -Name "BackOfficeMailScope" -Type Security `
  -Members membersuccess@sharewellpartners.com

# Restrict the app to that group
New-ApplicationAccessPolicy `
  -AppId 67d927e8-a1c7-49ae-95f0-452e0b66a992 `
  -PolicyScopeGroupId BackOfficeMailScope `
  -AccessRight RestrictAccess `
  -Description "Restrict Back Office email app to the shared mailbox"

# Verify (bypasses cache)
Test-ApplicationAccessPolicy -Identity membersuccess@sharewellpartners.com `
  -AppId 67d927e8-a1c7-49ae-95f0-452e0b66a992
# → AccessCheckResult : Granted   (test another mailbox → Denied)
```
Policy propagation can take up to ~1–2 hours; the `Test-` cmdlet checks live.

## 3. Create a client secret (B-007) — *on the app registration*
App registration → **Certificates & secrets** → **New client secret** → copy the
**Value** immediately (shown once). This is the password the backend uses.

## 4. Wire the vendor config (us)
Populate the Sharewell vendor row so `graphClient` can authenticate. **Keep the secret
out of source control** — set it via **Vendor Settings → Email** in the app, or a manual
one-off UPDATE (not committed). Columns on `oe.Vendors` (`VendorId D2A84803-…`):

| Column | Value |
|---|---|
| `Office365TenantId` | `dab84bb8-e15a-46f8-a85a-e5f1a95d0200` |
| `Office365ClientId` | `67d927e8-a1c7-49ae-95f0-452e0b66a992` |
| `Office365ClientSecret` | _the secret value — **never commit it**; set via Vendor Settings or a manual UPDATE_ |
| `Office365SharedMailbox` | `membersuccess@sharewellpartners.com` |

## 5. Backend env (B-003 webhook)
Set on the API App Service (and locally for dev):
```
PUBLIC_API_BASE_URL=https://api.allaboard365.com
GRAPH_WEBHOOK_SECRET=<random long string>      # signs the subscription clientState
# optional: GRAPH_SUBSCRIPTION_MINUTES=4230    # ~70h, default
```
Confirm `https://api.allaboard365.com/api/webhooks/graph-email` is publicly reachable
and not blocked by WAF/auth for an unauthenticated POST (Graph validation handshake).

## 6. Turn it on (us)
Once 1–5 are done: call `emailSubscriptionService.ensureSubscription(vendorId)` for the
Sharewell vendor (creates the Graph subscription + seeds the inbox via delta). Then the
renewal + reconcile jobs (B-004) keep it alive.

## 7. Secret rotation (expires ~2026-12-02)
The client secret expires in 6 months, so build the habit now. `graphClient` reads the
secret fresh from `oe.Vendors` on each token refresh (≤50-min cache), so rotation takes
effect within the hour **with no redeploy**.

**Zero-downtime rotation:**
1. App registration → **Certificates & secrets** → **New client secret** (add the new one
   *before* the old expires — both are valid during the overlap).
2. Update `Office365ClientSecret` for the Sharewell vendor (Vendor Settings → Email, or a
   one-off UPDATE). **Never put the value in git.**
3. Confirm the inbox still syncs, then **delete the old secret** in Entra (old secret ID on
   file: `0bdfbf82-15a5-49de-83f1-eb246711e467`).

**Hardening (later, B-007):** store the secret in Azure Key Vault / App Service config
rather than a plaintext DB column, and/or encrypt the column at rest (an `ENCRYPTION_KEY`
already exists in the backend env). Set a calendar reminder ~2 weeks before each expiry.

---

### Status checklist
- [ ] 1. Admin consent granted (B-001) — **pending admin**
- [ ] 2. Application Access Policy created + tested (B-002) — **pending admin**
- [x] 3. Client secret created + recorded (B-007) — secret ID `0bdfbf82-…`, expires ~2026-12-02
- [x] 4. `oe.Vendors` Office365 config set for ShareWELL **(testing)** — 2026-06-02; **prod row still needs it at go-live**. Credentials validated: token acquired ✅, mailbox read returns 403 (expected) until steps 1–2.
- [ ] 5. `PUBLIC_API_BASE_URL` + `GRAPH_WEBHOOK_SECRET` set; webhook reachable (B-003)
- [ ] 6. Subscription created + inbox seeded

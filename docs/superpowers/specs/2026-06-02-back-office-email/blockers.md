# Back Office Email — Blockers & Prerequisites

Companion to [`design.md`](./design.md). Concrete, copy-pasteable steps with known values filled in are in **[`admin-setup.md`](./admin-setup.md)**. These are external/access/infra items that must be resolved (mostly by an M365 / Azure admin) for Phase 1 to function. Code can be built and unit-tested against mocks without them, but **inbound webhooks and scoped sending cannot go live** until B-001…B-003 are done.

| ID | Blocker | Owner | Needed for | Status |
|----|---------|-------|------------|--------|
| **B-001** | **Microsoft Entra ID app registration** (formerly "Azure AD") **with the right *application* permissions** — `Mail.Read`, `Mail.ReadWrite`, `Mail.Send` — **with tenant admin consent**. The existing `graphEmailService` already uses client-credentials (`AZURE_CLIENT_ID/SECRET/TENANT` + per-vendor `oe.Vendors` Office365 config); confirm/extend its granted permissions. Subscriptions and `createReply` specifically need application `Mail.Read` + `Mail.ReadWrite` (delegated `*.Shared` cannot subscribe). | M365 tenant admin | Inbound webhooks, two-step reply | ☐ |
| **B-002** | **Scope the app to the single shared mailbox.** Application Mail permissions grant tenant-wide mailbox access by default. Apply **RBAC for Applications** (preferred) or `ApplicationAccessPolicy`, scoped to the Sharewell shared mailbox, **and remove any org-wide Entra grant** (otherwise the effective access is the union = unscoped). Verify with `Test-ServicePrincipalAuthorization`. **✅ RESOLVED 2026-06-03 via RBAC for Applications (runbook below). `Test-ApplicationAccessPolicy` returned Granted (no AAP), confirming the block was the newer RBAC enforcement; `New-ServicePrincipal` + `New-ManagementRoleAssignment` (Mail.ReadWrite + Mail.Send) scoped to `membersuccess@` restored access. Verified: 403s stopped, delta OK, 4 missed inbound emails backfilled at 21:19 UTC.** | Exchange Online admin | Security (hard requirement) | ✅ |
| **B-003** | **Public HTTPS webhook endpoint** reachable by Microsoft Graph for `notificationUrl` (and `lifecycleNotificationUrl`). Must answer the validation handshake within 10s and ack notifications with `202` within 3s. Confirm `api.allaboard365.com` route is publicly reachable and not blocked by WAF/auth for the validation `POST`. | Infra/DevOps | Inbound webhooks | ☐ |
| **B-004** | **Subscription renewal + reconcile jobs hosting.** Graph subscriptions expire ≤7 days and must be renewed; delta reconcile needs a timer. Decide which Azure Functions app hosts these (existing job pattern, e.g. alongside `billing-nightly-job` / `integration-error-digest-job`). | Infra/DevOps | Reliable inbound | ☐ |
| **B-005** | **Shared mailbox confirmed:** `membersuccess@sharewellpartners.com`. (App registration Client ID: `67d927e8-a1c7-49ae-95f0-452e0b66a992`.) | Sharewell / product | Correct mailbox wiring | ✅ |
| **B-006** | **Footer copy + sender display-name convention.** The friendly outbound footer ("— Jane from the Sharewell Care Team … handled by a real person") and how the sender's name is shown. | Sharewell / product | Outbound polish | ☐ |
| **B-007** | **Secret storage & rotation.** Office365 client secret currently in env / `oe.Vendors`. Confirm encryption at rest and a rotation plan; subscription `clientState` secret management. | Security | Ongoing security | ☐ |
| **B-008** | **PHI / HIPAA review of storing email bodies + attachments** in our DB/Blob. Confirm retention, encryption, and access-logging meet the same bar as existing documents/encounters. | Compliance | Go-live | ☐ |
| **B-009** | **`PUBLIC_API_BASE_URL` must be set to the public HTTPS API host** (prod: `https://api.allaboard365.com`). Signature-card footer images are embedded as `<img src>` in sent emails via this base; if unset the src is a **relative path** that mail clients can't resolve → broken footer images. ⚠️ In local dev this can't be validated against Gmail (a `localhost` URL is unreachable by Google's image proxy) — validate via the in-app preview, real images land in deployed envs. Code fix already in: `routes/public/email-assets.js` overrides helmet's `Cross-Origin-Resource-Policy: same-origin` → `cross-origin` so the browser/Gmail proxy will render the images. | Infra/DevOps | Footer images in sent mail | ☐ |

## Notes / decisions that *avoid* blockers

- **Lean change notifications** (no `resourceData`): we receive only "something changed," then fetch the message by id. This **avoids** needing an `encryptionCertificate` and its lifecycle — one fewer blocker. Revisit only if notification volume makes per-message fetches too chatty against the 4-concurrent throttle.
- **No delegated/per-user OAuth**: sending is *as the shared mailbox* via application permissions, so there's no per-care-member Microsoft sign-in to manage. Attribution is internal (`SentByUserId`), not via individual Microsoft identities.

---

## Runbook — B-002 mailbox access 403 (RAOP), incident 2026-06-03

**Symptom.** Inbound stopped (last message ~11:52); Outlook still shows new mail. Backend log on every sync:

```
Graph GET .../membersuccess@sharewellpartners.com/mailFolders('inbox')/messages/delta
failed (403): Access to OData is disabled: [RAOP] : Blocked by tenant configured
AppOnly AccessPolicy settings.
```

**Cause.** Exchange Online now blocks the app's *app-only* access to the mailbox. App (application) permissions are tenant-wide by default; once the tenant enforces scoping (an admin-added policy, or Microsoft's "RAOP" rollout), access is denied until the app+mailbox pairing is explicitly allowed. The token is fine — only *mailbox access* is denied. Code change is **not** the fix; this is tenant-side Exchange config.

**Known values.**
- App registration **Application (client) ID**: `67d927e8-a1c7-49ae-95f0-452e0b66a992`
- Enterprise Application (**service principal**) **Object ID**: `eeb96d60-fa87-468f-9ee0-36316f524686`
- Shared mailbox: `membersuccess@sharewellpartners.com`

**Decision: which mechanism is blocking?** Run first:
```powershell
Connect-ExchangeOnline
Test-ApplicationAccessPolicy -AppId 67d927e8-a1c7-49ae-95f0-452e0b66a992 `
  -Identity membersuccess@sharewellpartners.com
```
- `Denied` → an **Application Access Policy** is blocking (it takes precedence even over RBAC). Use **Fix A**, or remove that policy.
- `Granted` / no policy but Graph still 403s → it's the newer **RBAC for Applications** enforcement. Use **Fix B** (preferred).

### Fix B — RBAC for Applications (preferred, least-privilege)
No new app/secret; reuses the existing Entra identity. Portal: only need the Enterprise App Object ID above.
```powershell
Connect-ExchangeOnline   # Exchange or Global admin

# 1. One-time: register the existing app's service principal in Exchange Online.
New-ServicePrincipal `
  -AppId    67d927e8-a1c7-49ae-95f0-452e0b66a992 `
  -ObjectId eeb96d60-fa87-468f-9ee0-36316f524686 `
  -DisplayName "Back Office Email (AllAboard365)"

# 2. Scope to ONLY the shared mailbox.
New-ManagementScope -Name "BackOffice Shared Mailbox" `
  -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'membersuccess@sharewellpartners.com'"

# 3. Grant the two roles the app uses, scoped to that mailbox.
New-ManagementRoleAssignment -App 67d927e8-a1c7-49ae-95f0-452e0b66a992 `
  -Role "Application Mail.ReadWrite" -CustomResourceScope "BackOffice Shared Mailbox"
New-ManagementRoleAssignment -App 67d927e8-a1c7-49ae-95f0-452e0b66a992 `
  -Role "Application Mail.Send" -CustomResourceScope "BackOffice Shared Mailbox"
```
Verify:
```powershell
Get-ServicePrincipal -Identity 67d927e8-a1c7-49ae-95f0-452e0b66a992
Get-ManagementRoleAssignment -App 67d927e8-a1c7-49ae-95f0-452e0b66a992 |
  Format-Table Name, Role, CustomResourceScope
Get-ManagementScope "BackOffice Shared Mailbox"
```
Role mapping: `Mail.ReadWrite` = read/delta + reply drafts + mark-read + attachments + create the change-notification subscription; `Mail.Send` = sending.

### Fix A — Application Access Policy (fallback / if Test = Denied)
```powershell
New-DistributionGroup -Name "BackOffice App Mailboxes" -Type Security `
  -PrimarySmtpAddress backoffice-app-mailboxes@sharewellpartners.com
Add-DistributionGroupMember -Identity backoffice-app-mailboxes@sharewellpartners.com `
  -Member membersuccess@sharewellpartners.com
New-ApplicationAccessPolicy -AppId 67d927e8-a1c7-49ae-95f0-452e0b66a992 `
  -PolicyScopeGroupId backoffice-app-mailboxes@sharewellpartners.com `
  -AccessRight RestrictAccess -Description "Back Office email app -> only this mailbox"
```

**After either fix.**
- Propagation up to ~30 min; retries may still 403 until then.
- No backend action needed — same client ID/secret, no redeploy. The persisted Graph `deltaLink` backfills mail missed during the outage on the next reconcile poll.

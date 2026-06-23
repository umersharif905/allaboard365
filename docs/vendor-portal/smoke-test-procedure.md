# Vendor Message Center — Manual Smoke Test Procedure

Use this checklist after the SQL migration `sql-changes/2026-05-11-vendor-messaging-scope.sql` has been applied to `allaboard-testing` (or any target environment).

## Prerequisites

Before running these tests, confirm BOTH migrations have been applied in order:

- [ ] Migration `2026-05-11-vendor-messaging-scope.sql` (adds `VendorId` columns, drops legacy `oe.VendorEmailTemplates`).
- [ ] Migration `2026-05-12-no-global-templates.sql` (backfills NULL-tenant templates to MightyWELL Health, makes `TenantId` NOT NULL).

Verify with:
```sql
-- VendorId columns added
SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA='oe' AND TABLE_NAME='MessageTemplates' AND COLUMN_NAME='VendorId';
-- expect: 1

-- Legacy table dropped
SELECT OBJECT_ID('oe.VendorEmailTemplates','U');  -- expect: NULL

-- TenantId is now NOT NULL on MessageTemplates
SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA='oe' AND TABLE_NAME='MessageTemplates' AND COLUMN_NAME='TenantId';
-- expect: NO

-- No NULL-tenant rows remain
SELECT COUNT(*) FROM oe.MessageTemplates WHERE TenantId IS NULL;  -- expect: 0
```

- [ ] Backend (and frontend) have been deployed with the code from this branch.
- [ ] You have credentials for three test users: a `VendorAdmin`, a `TenantAdmin`, and a `SysAdmin`. (Default Cypress vendor account: `test@sharewellpartners.com` / `testpass`.)
- [ ] Do not send any blast/template/campaign that would reach real customers — use only the test contact addresses listed below.

## Safe test inputs

Use ONLY these for any recipient/email fields:
- **Email recipient:** your own work email or `admin@rovaweb.com`
- **SMS recipient:** your own phone or a clearly-test number
- **Test subject lines:** prefix with `[SMOKE]`
- **Test body content:** "Vendor Message Center smoke test"

Never type a real member's email, phone, or contact info into any form. Never click "Send" with a customer recipient.

---

## Part A — Vendor portal (as VendorAdmin)

Log in as the VendorAdmin test user. The sidebar should show a **Message Center** entry (icon: speech bubble) in the vendor nav.

### A1. The old Email Templates slot is gone
- [ ] `Email Templates` entry is no longer in the sidebar.
- [ ] Direct-navigating to `/vendor/email-templates` shows the 404/fallback route.

### A2. Message Center landing → Templates tab
- [ ] Click **Message Center** in the sidebar.
- [ ] URL redirects to `/vendor/messaging/templates`.
- [ ] Three tabs render: **Templates**, **Message Blast**, **Campaigns**.
- [ ] Templates list initially shows 0 rows (or only previously-created vendor templates from this VendorId).

### A3. Templates CRUD (vendor-scoped)
- [ ] Click "Create template" (or equivalent button).
- [ ] Create a template named `[SMOKE] Vendor Template A`, message type `Email`, subject `[SMOKE] Vendor`, body `Vendor template content`.
- [ ] Save. Confirm it appears in the list.
- [ ] Edit the template — change subject to `[SMOKE] Vendor (edited)`. Confirm the edit persists.
- [ ] Open the browser dev-tools Network tab. Confirm `GET /api/message-center/templates` returns the template you just created.
- [ ] Delete the template. Confirm it disappears from the list. (Or keep it for the isolation test in Part B.)

### A4. Campaigns CRUD (vendor-scoped, KEPT INACTIVE)
- [ ] Click the **Campaigns** tab.
- [ ] Create a new campaign named `[SMOKE] Vendor Campaign A`, trigger type `EnrollmentCompletion`. **Do NOT toggle "Active" on.**
- [ ] Open the campaign. Add two steps:
  - Step 1: Day 0, email template = (pick any vendor template you created — should be the only ones visible)
  - Step 2: Day 7, no template
- [ ] Confirm both steps save and reorder correctly.
- [ ] Confirm the email-template picker in the step editor shows ONLY vendor-owned templates (no tenant or global templates).
- [ ] **Leave IsActive OFF.** An active vendor campaign would cause the `CampaignTriggerService` to enroll real members on the next eligible event.
- [ ] Delete the campaign after the check (or keep for isolation test in Part B).

### A5. Message Blast composer (DO NOT SEND TO REAL RECIPIENTS)
- [ ] Click the **Message Blast** tab.
- [ ] Confirm the recipient picker loads a list of agents (this comes from `GET /api/me/tenant-admin/message-blast/agents` — the shared endpoint).
- [ ] Compose a blast: subject `[SMOKE] Vendor Blast`, body `Vendor blast test content`.
- [ ] Select ONLY yourself (or `admin@rovaweb.com`) as the recipient — never a real customer.
- [ ] Click "Estimate" if available — verify cost estimate renders.
- [ ] **DO NOT CLICK "Send"** unless you've confirmed the recipient is safe. If you do send, expect a real email/SMS to your test address.

---

## Part B — Tenant portal (as TenantAdmin)

Log in as the TenantAdmin test user on the same tenant.

### B1. Tenant Message Center untouched
- [ ] Tenant sidebar shows its normal Message Center entry (8 tabs unchanged: Message Blast, Templates, Campaigns, Proposals, Scheduled, Queue, History, Analytics).
- [ ] Navigate to **Templates**. Confirm the existing tenant templates render (whatever was there before this branch).

### B2. Cross-portal isolation
- [ ] Open the Templates list as TenantAdmin. **Vendor templates from A3 are NOT visible.**
- [ ] Open the Campaigns list. **Vendor campaigns from A4 are NOT visible.**
- [ ] (If you have a SysAdmin login) Toggle `allTenants` or `globalOnly`. Vendor rows still NOT visible (global views also filter `VendorId IS NULL`).

### B3. Scope pill visible (no globals concept)
- [ ] On TenantAdmin's Templates list, every row has a small **Tenant** pill (gray) next to it. None have a Vendor pill (TenantAdmin doesn't see vendor templates).
- [ ] On TenantAdmin's Campaigns list, every row has a **Tenant** pill.
- [ ] Switch to VendorAdmin: every row has a **Vendor** pill (oe-light/oe-dark).

### B4. Tenant CRUD still works (regression check)
- [ ] Create a tenant template `[SMOKE] Tenant Template A`. Save. Verify it persists.
- [ ] Edit it. Verify edit persists.
- [ ] Log back in as VendorAdmin and confirm the tenant template does **not** appear in their Templates list (vendor-side isolation).
- [ ] As TenantAdmin, delete the tenant template.

### B5. Tenant Message Blast (regression — DO NOT SEND)
- [ ] Open tenant Message Blast composer.
- [ ] Verify the recipient picker still loads agents correctly.
- [ ] **DO NOT click Send unless using a safe test recipient.**

---

## Part SA — SysAdmin portal (new behaviors)

Log in as a SysAdmin user. Navigate to the Message Center.

### SA1. SysAdmin sees everything
- [ ] Templates list shows rows from MULTIPLE tenants (and vendors) all mixed together — NOT filtered to "globals."
- [ ] Each row has a `Tenant` or `Vendor` pill. The mix should include both kinds (assuming both exist in the DB).
- [ ] Campaigns list: same behavior.

### SA2. Scope filter dropdown (SysAdmin-only UI)
- [ ] Above the Templates list, a dropdown labeled "Scope" (or similar) with options `All` / `Tenant` / `Vendor`. This dropdown is NOT visible to TenantAdmin or VendorAdmin (verify by logging in as those).
- [ ] Set the dropdown to `Tenant`. List re-filters: only rows with `Tenant` pill visible.
- [ ] Set to `Vendor`. List shows only `Vendor` pill rows.
- [ ] Set to `All`. Mixed list returns.
- [ ] Same dropdown is on the Campaigns list.

### SA3. SysAdmin "Create for" field
- [ ] Click "Create template". The modal shows a NEW field at the top: "Create for" (segmented control or radio: Tenant / Vendor).
- [ ] Select `Tenant`. A Tenant dropdown appears. Pick `MightyWELL Health`. Fill in `[SMOKE] Sysadmin Tenant Template`. Save.
- [ ] In the Templates list, find your new row. The pill says `Tenant`. The template belongs to MightyWELL Health (verify via the existing tenant column if visible, or via SQL in Part C).
- [ ] Create another template. Select `Vendor`. Pick MightyWELL Health from the tenant cascade. Pick `ShareWELL Partners` (or any vendor) from the vendor dropdown. Fill in `[SMOKE] Sysadmin Vendor Template`. Save.
- [ ] In the list, the new row has a `Vendor` pill.
- [ ] Same flow on Campaigns: create a Tenant campaign and a Vendor campaign as SysAdmin. **Leave IsActive OFF on both.**

### SA4. Duplicate preserves scope
- [ ] Find a Vendor template (e.g., the one A3 vendor created, or SA3 above). Click "Duplicate" as SysAdmin.
- [ ] The duplicate appears in the list with the `Vendor` pill — same VendorId as the source.
- [ ] Duplicate a Tenant template as SysAdmin. The copy is a Tenant template, same TenantId.
- [ ] Confirm: no way to "convert" tenant → vendor (or vice versa) via duplicate.

### SA5. SysAdmin cannot edit/delete a vendor template as if it's a tenant template
- [ ] Edit a Vendor template as SysAdmin. The edit form should make clear it belongs to the vendor (the pill stays Vendor through the edit flow).
- [ ] Cleanup: delete the SMOKE templates and campaigns SysAdmin created.

---

## Part C — Network/data sanity (optional but recommended)

Use browser dev-tools or a SQL client:

### C1. Verify SQL scoping (SQL client)
After creating one vendor template (A3) and one tenant template (B3):

```sql
SELECT TemplateId, TemplateName, TenantId, VendorId
  FROM oe.MessageTemplates
 WHERE TemplateName LIKE '[SMOKE]%';
```
- [ ] Vendor template row has `VendorId = <vendor-uuid>` (NOT NULL).
- [ ] Tenant template row has `VendorId IS NULL`.

### C2. Verify legacy table is gone
```sql
SELECT OBJECT_ID('oe.VendorEmailTemplates','U') AS still_there;
-- expect: NULL
```

### C2a. Verify no NULL-tenant templates (no globals)
```sql
SELECT COUNT(*) FROM oe.MessageTemplates WHERE TenantId IS NULL;  -- expect: 0
```

### C3. Verify deprecated route is gone
- [ ] In the browser dev-tools console: `fetch('/api/me/vendor/email-templates').then(r => r.status)` → expect 401 (auth fired) or 404 (no mount). NOT 200.
- [ ] Share Request email composer (vendor portal → Share Requests → some request → Email Log tab): confirm the page loads without console errors. The template dropdown has been removed; subject + body editor still works.

---

## Cleanup

- [ ] Delete any `[SMOKE]` templates and campaigns created during testing.
- [ ] Confirm no campaigns were left with `IsActive = 1` — the trigger engine would otherwise enroll real members on the next eligible event.

## What's NOT covered by this procedure

- The `POST /api/me/tenant-admin/message-blast/send` endpoint is intentionally not exercised end-to-end. Vendor + tenant blast paths share that same handler; auth was expanded to include vendor roles. Validation of the actual SendGrid/Twilio code path is out of scope for smoke testing.
- The `CampaignTriggerService.fireTrigger` engine is not exercised. Activating any campaign would enroll members and queue real messages. If you need to verify engine fires for vendor campaigns: create a vendor campaign with a step pointing to a vendor template addressed only to your own test email/phone, activate it, trigger the event (e.g., enroll a test member who matches the trigger), wait for delivery, then deactivate immediately.
- Subject lines longer than 200 characters are not tested (column limit on `oe.MessageTemplates.Subject`).

# Notification / Communication Preferences — Testing Guide

This covers the **member** marketing email/SMS preferences (continued from Ryan/Stephen's
PR, with Joey's quick-send bugs fixed) **and** the new **agent** notification
preferences.

---

## 0. One-time setup — run the migrations

Two tables back this feature. Apply both before testing (they are idempotent /
safe to re-run):

| Migration | Table(s) |
|-----------|----------|
| `sql-changes/2026-04-09-member-communication-preferences.sql` | `oe.MemberCommunicationPreferences`, `oe.MemberConsentLog`, `oe.MessageTemplates.MessageCategory` |
| `sql-changes/2026-06-04-agent-communication-preferences.sql` | `oe.AgentCommunicationPreferences` |

The repo runs GO-batched migrations with:

```bash
cd backend
node scripts/apply-sql-file.js ../sql-changes/2026-06-04-agent-communication-preferences.sql
```

> ⚠️ Per the repo DB policy, do **not** auto-run writes against prod. Apply these
> against your test DB only, and confirm before any prod run.

Restart the backend after pulling (`node app.js` has **no hot reload**).

---

## 1. Member marketing preferences

### Where / who
- **Role:** `Member` (log in as a member).
- **Page:** Member portal → **Email & SMS preferences**
  (`/member/communication-preferences`, linked from the member nav).

### What to test
1. **Preference center loads** with two toggles: *Receive marketing email* and
   *Receive marketing SMS*. (SMS toggle is disabled unless the member has SMS
   consent on file.)
2. **Save** turning marketing email **off** → success toast. Re-open the page;
   the toggle stays off. (Row written to `oe.MemberCommunicationPreferences`,
   `EmailMarketingOptOut = 1`, and a `oe.MemberConsentLog` `OptOut` row.)

### Public unsubscribe (no login)
- Open the **Unsubscribe** link from any marketing email footer
  (`/unsubscribe?token=…`) → confirms opt-out. The token is per-member/tenant
  and signed server-side.

---

## 2. Marketing email footer + opt-out (Joey's two bugs) — the important part

These are tested from the **Message Center → Email Templates** page.

### Where / who
- **Roles:** `TenantAdmin`, `SysAdmin`, `VendorAdmin`, or `VendorAgent`.
- **Page:** Message Center → **Email Templates** (`MessageTemplatesPage`).

### Setup
1. Create (or edit) an **Email** template and set **Class = `Marketing`**.
   Create a second one with **Class = `System`** for contrast.

### Bug #1 — footer shows up on Quick Send + in preview
1. Click the **eye / Preview** icon on the Marketing template. The body preview
   now shows the **unsubscribe footer** appended at the bottom, plus a note:
   *"This is a Marketing template — recipients automatically get an unsubscribe
   footer…"*. The **System** template shows **no** footer.
2. Click the **Send (Quick Send)** icon on the Marketing template. The preview
   iframe in the modal also shows the footer, with a one-line marketing notice.
3. Quick-send the Marketing template to a real test inbox you control. The
   **received email** contains the unsubscribe footer, and the mail has a
   `List-Unsubscribe` header (one-click unsubscribe in Gmail/Outlook).
   - Quick-send the **System** template → **no** footer, **no** header. ✅

### Bug #2 — Quick Send respects member opt-out
1. As a Member (section 1), turn **marketing email OFF** for `test-member@…`.
2. As the admin, **Quick Send** the **Marketing** template to that member's
   email. Expected: success toast reads **"… ; 1 skipped (unsubscribed from
   marketing)."** No email is delivered, and no `oe.MessageQueue` /
   `oe.MessageHistory` row is created for that recipient.
3. Quick Send a **System** template to the same opted-out member → it **still
   sends** (transactional messages ignore marketing opt-out). ✅
4. Send a Marketing template to a **mix** of opted-in and opted-out members →
   only opted-in addresses are queued; the toast reports the skipped count.

> Note: opt-out + footer only apply when the recipient resolves to a **member**.
> A raw email with no member record is sent as-is (there's no member preference
> to honor and no per-member unsubscribe token to mint).

### Regression sanity (already worked before, should still work)
- Campaign Day-0 trigger and the nightly **ScheduledProcessor** still skip
  opted-out members and append the footer for Marketing steps.
- Replying **STOP** to a marketing SMS sets `SmsMarketingOptOut` (Twilio webhook).

---

## 3. Agent notification preferences (new)

### Where / who
- **Role:** `Agent` (log in as an agent).
- **Page:** Agent portal → **Settings** (`AgentSettings`). Scroll to the
  **Notification Preferences** card (`#settings-notifications`).

### What to test
1. The card shows three toggles, all **on** by default for a brand-new agent
   (no row yet = subscribed to everything):
   - **Enrollment notifications** — wired now; the *sending* hooks land with the
     separate enrollment-notifications task.
   - **Payment & billing alerts** — gates the "member/group payment declined"
     agent email that exists today.
   - **Marketing & product updates** — placeholder for future agent marketing.
2. Toggle **Payment & billing alerts OFF**, click **Save preferences** → success
   toast. Reload Settings → the toggle stays off. (Row in
   `oe.AgentCommunicationPreferences`, `PaymentAlertsOptOut = 1`.)
3. **Partial save** is preserved: flip only one toggle and save; the other two
   keep their prior values.

### Verify payment-alert opt-out is enforced
The agent payment-declined copy is sent by
`POST /api/internal/payment-failure-notifications` →
`MessageQueueService.queuePaymentFailureNotifications`.

- With the agent **opted out** of payment alerts, trigger a payment-failure
  notification whose `agentUserId` (or `agentId`) maps to that agent. Expected:
  the **member** copy still queues, but the **agent** copy is **skipped**. The
  service result returns `agentQueued: false`, `agentOptedOut: true`,
  `skippedReason: 'agent_opted_out_payment_alerts'`.
- Re-enable the toggle → the agent copy queues again.

---

## 4. Automated tests

```bash
# Backend — agent preference logic (opt-out, upsert, partial update, user→agent map)
cd backend
npx jest services/__tests__/agentCommunicationPreferences.service.test.js
```

API surface added:
- `GET /api/me/agent/notification-preferences`
- `PUT /api/me/agent/notification-preferences`
  body: `{ enrollmentNotificationsEnabled?, paymentAlertsEnabled?, marketingEnabled? }`

(Existing member endpoints unchanged:
`GET|PUT /api/me/member/communication-preferences`.)

---

## 5. Quick reference — files

**Backend**
- `services/agentCommunicationPreferences.service.js` — agent opt-out logic (new)
- `routes/me/agent/notification-preferences.js` — agent prefs API (new)
- `routes/me/agent/index.js` — mounts the route
- `routes/messageCenter.js` — `/quick-send` now resolves template `MessageCategory`,
  skips opted-out members, and passes `marketingCompliance` (footer + List-Unsubscribe)
- `services/messageQueue.service.js` — `queuePaymentFailureNotifications` respects
  the agent's payment-alert preference
- `sql-changes/2026-06-04-agent-communication-preferences.sql` — agent table (new)

**Frontend**
- `hooks/agent/useAgentNotificationPreferences.ts` (new)
- `components/agent/AgentNotificationPreferencesCard.tsx` (new)
- `pages/agent/AgentSettings.tsx` — renders the card
- `utils/marketingFooterPreview.ts` — footer preview HTML (new)
- `pages/message-center/MessageTemplatesPage.tsx` — footer preview in template
  Preview + Quick Send, and skipped-count in the send toast

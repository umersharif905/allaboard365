# Message Blast — Filtered Group Audiences

**Status:** shipped on branch `automated-emails`
**Date:** 2026-06-10

## What this adds

The Message Blast page previously only let an admin send to **specific people**
(pick agents from a checklist, or paste in email addresses / phone numbers).

It now also supports sending to a **filtered group** — a dynamic audience
resolved from the database at send time:

| Audience | Who it resolves to |
| --- | --- |
| **All active members** | Members with an active, non-terminated enrollment in the current tenant |
| **Active members in a product / bundle** | The above, narrowed to one or more selected products/bundles |
| **All active agents** | Active agents in the current tenant |
| **Agents in an agency** | Active agents in one or more selected agencies |

"Active enrollment" = `oe.Enrollments.Status = 'Active'` **and**
(`TerminationDate IS NULL` or in the future) **and** not pending migration —
the same definition used elsewhere in the codebase.

### Key behaviors

- **Recipients are resolved server-side.** For group sends the client never
  sends a recipient list — it sends the *filter*, and the backend resolves the
  actual emails/phones. (Prevents tampering and keeps the preview count honest.)
- **Marketing opt-outs are excluded.**
  - Members: `MemberCommunicationPreferences.EmailMarketingOptOut` blocks email;
    `SmsMarketingOptOut` **or** missing `Members.SmsConsent` blocks SMS.
  - Agents: `AgentCommunicationPreferences.MarketingOptOut` blocks both channels.
  - The UI shows how many were excluded ("Excluded due to marketing opt-out: N email, M SMS").
- **Live recipient count.** As you change filters, the page shows the resolved
  email/SMS recipient counts and (for SMS) the estimated cost.
- **Recipient cap.** A send is blocked above `BLAST_MAX_RECIPIENTS` per channel
  (default **5,000**). Override via the backend env var.
- **De-dup & normalization.** Emails are lowercased+de-duped; phones are
  normalized to E.164 and de-duped.
- The actual fan-out reuses the existing bulk-blast queue path
  (`MessageQueueService.queueBulkBatchMessage` → `oe.MessageQueue` →
  bulk processor → SendGrid/Twilio), so delivery, history, and cost tracking
  are unchanged.

## Scoping per portal

The same `MessageBlastPage` and the same backend route serve all three portals.
Everything resolves within the **active tenant** (`req.tenantId`) — for SysAdmin
that's whichever tenant they've switched into.

- **SysAdmin** — `/admin/message-center/blast`
- **TenantAdmin** — `/tenant-admin/message-center/blast`
- **Vendor** (VendorAdmin / VendorAgent) — `/vendor/messaging/blast`
  (only visible when the vendor has `ShareRequestEnabled`). For vendor users the
  **product / bundle** picker is restricted to the vendor's own `VendorId`.
  Agencies are tenant-level, so the agency list is the active tenant's agencies.

## Files changed

**Backend**
- `backend/services/blastAudience.service.js` *(new)* — single source of truth
  for audience resolution (count + send). Builds tenant-scoped, opt-out-aware,
  de-duped recipient lists. Exposes `getAudienceOptions`, `resolveAudience`,
  `BLAST_MAX_RECIPIENTS`, `AudienceError`.
- `backend/routes/me/tenant-admin/message-blast.js`
  - `GET  /audience-options` — products/bundles (with active enrollments) +
    agencies for the pickers; vendor-scoped products.
  - `POST /audience-count` — `{ audienceType, productIds?, agencyIds? }` →
    `{ emailRecipients, smsRecipients, emailOptedOut, smsOptedOut, maxRecipients }`.
  - `POST /send` — now accepts an optional `audience` object; resolves recipients
    server-side and enforces the cap.

**Frontend**
- `frontend/src/pages/tenant-admin/MessageBlastPage.tsx` — adds the
  Specific people / Filtered group toggle, audience type + product/bundle +
  agency selectors, live count, opt-out note, and cap warning. New UI uses the
  `oe-primary` brand color.

**Tests**
- `backend/services/__tests__/blastAudience.service.test.js` (16 tests)
- `backend/routes/__tests__/message-blast.audience.test.js` (5 tests)
- `frontend/src/pages/tenant-admin/__tests__/MessageBlastPage.audience.test.tsx` (3 tests)

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `BLAST_MAX_RECIPIENTS` | `5000` | Max recipients per channel per single blast |
| `SMS_COST_PER_SEGMENT` | `0.0079` | (existing) used for the SMS cost estimate |

## How to test (manual)

### Automated
```bash
# backend
cd backend
npx jest services/__tests__/blastAudience.service.test.js \
        routes/__tests__/message-blast.audience.test.js

# frontend
cd frontend
npx vitest run src/pages/tenant-admin/__tests__/MessageBlastPage.audience.test.tsx
```

### Manual — TenantAdmin
1. Log in as a **TenantAdmin**. Go to **Message Center → Message Blast**
   (`/tenant-admin/message-center/blast`).
2. Under **Recipients**, choose **Filtered group**.
3. **All active members**: the count box shows the number of active members
   (and how many were excluded for opt-out). Leave **Email** checked, type a
   subject + body, click **Send blast**. Confirm the success banner reports the
   queued email count, and that the messages show up under **Message History**.
4. **Active members in a product / bundle**: pick one or more products (bundles
   are tagged `(bundle)`). The count updates. Send and verify.
5. **All active agents** / **Agents in an agency**: switch the audience, (select
   agencies if applicable), verify the count and send.
6. **Opt-out check**: opt a member out of marketing (Member portal →
   Communication Preferences, or set `MemberCommunicationPreferences`), reload,
   and confirm the count drops and the "Excluded due to marketing opt-out" note
   reflects it.
7. **Cap check** (optional): temporarily set `BLAST_MAX_RECIPIENTS=1` on the
   backend, pick an audience with >1 recipient — the send is blocked with a
   clear message and the count box shows the cap warning.

### Manual — SysAdmin
1. Log in as **SysAdmin**, switch into a tenant, go to
   **Message Center → Message Blast** (`/admin/message-center/blast`).
2. Repeat the TenantAdmin steps — audiences resolve within the switched-into tenant.

### Manual — Vendor
1. Log in as a **VendorAdmin** (vendor must have `ShareRequestEnabled`). Go to
   **Message Center → Message Blast** (`/vendor/messaging/blast`).
2. Choose **Filtered group → Active members in a product / bundle**: confirm the
   product list only contains the vendor's own products.
3. Verify counts and send.

## Out of scope (future)

- Agent portal sending to prospect groups / downlines / agency downlines.
- Saved/reusable audience segments.
- Scheduling a group blast for later (the existing Scheduled Messages feature is
  template-based and separate).

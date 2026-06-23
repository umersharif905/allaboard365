# Issue: Email & SMS Compliance + Member Notification Preference Center

## Overview

We need to ensure our email and SMS messaging is legally compliant with US regulations (CAN-SPAM for email, TCPA for SMS) and give members control over their marketing communication preferences.

## Background

### What Laws Apply

**CAN-SPAM Act (Email):**
- Every marketing email MUST have a working unsubscribe link
- Every marketing email MUST include a physical mailing address
- Unsubscribe requests must be honored within 10 business days
- Transactional emails (password resets, billing, enrollment confirmations) are exempt from unsubscribe requirements
- Penalties: up to ~$51,744 per email violation

**TCPA (SMS):**
- Marketing SMS requires prior express written consent
- Must support STOP keyword to opt out on all messages
- Must include "Msg & data rates may apply" and frequency disclosure
- Penalties: $500-$1,500 per text, uncapped class actions

**Key distinction:**
- "System" messages (password resets, billing, enrollment confirmations) — members cannot unsubscribe
- "Marketing" messages (campaigns, newsletters, promotions) — members MUST be able to unsubscribe

### What We Have Today

- **SMS STOP handling**: Exists for share request SMS only (`backend/routes/webhooks/twilio-sms.js`). Handles STOP/START keywords, updates `oe.ShareRequestMembers.OptedOutOfSms`.
- **SMS consent**: `oe.Members.SmsConsent` column exists, captured during enrollment. No timestamp or source tracking.
- **Email unsubscribe**: Does NOT exist anywhere. No `List-Unsubscribe` header. No unsubscribe link in any email template.
- **Physical address in emails**: Does NOT exist in any email template.
- **Member preference center**: Does NOT exist. Members have no way to manage their communication preferences.
- **Privacy policy**: Promises unsubscribe via link and STOP keyword (`frontend/src/pages/PrivacyPolicyPage.tsx:85`) but the email unsubscribe link doesn't actually exist.

## Tasks

### Phase 1: Research (2-3 hours)

- [ ] Read the CAN-SPAM Act requirements: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
- [ ] Read TCPA SMS requirements and CTIA guidelines
- [ ] Read through our existing privacy policy at `frontend/src/pages/PrivacyPolicyPage.tsx` and terms at `frontend/src/pages/TermsPage.tsx` — understand what we're already promising users
- [ ] Review the existing SMS STOP handling at `backend/routes/webhooks/twilio-sms.js` (lines 173-424)
- [ ] Review the existing SMS consent field on `oe.Members.SmsConsent`
- [ ] Document your findings — what we're compliant on, what we're missing

### Phase 2: Database Schema

Add a `MessageCategory` column to `oe.MessageTemplates`:
```sql
ALTER TABLE oe.MessageTemplates ADD MessageCategory NVARCHAR(20) NOT NULL DEFAULT 'Marketing';
-- CHECK constraint: 'System' or 'Marketing'
-- Default to Marketing (safer — forces conscious decision to mark as System)
```

Create a member communication preferences table:
```sql
CREATE TABLE oe.MemberCommunicationPreferences (
  PreferenceId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID(),
  MemberId UNIQUEIDENTIFIER NOT NULL,
  TenantId UNIQUEIDENTIFIER NOT NULL,
  EmailMarketingOptOut BIT NOT NULL DEFAULT 0,
  SmsMarketingOptOut BIT NOT NULL DEFAULT 0,
  OptOutDate DATETIME2 NULL,
  OptOutSource NVARCHAR(50) NULL, -- 'UnsubscribeLink', 'PreferenceCenter', 'STOP', 'Manual'
  CreatedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  ModifiedDate DATETIME2 NULL,
  CONSTRAINT PK_MemberCommunicationPreferences PRIMARY KEY (PreferenceId)
);
```

Create a consent audit log table:
```sql
CREATE TABLE oe.MemberConsentLog (
  LogId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID(),
  MemberId UNIQUEIDENTIFIER NOT NULL,
  TenantId UNIQUEIDENTIFIER NOT NULL,
  ConsentType NVARCHAR(50) NOT NULL, -- 'SmsMarketing', 'EmailMarketing'
  Action NVARCHAR(20) NOT NULL, -- 'OptIn', 'OptOut'
  Source NVARCHAR(100) NOT NULL, -- 'EnrollmentForm', 'PreferenceCenter', 'UnsubscribeLink', 'STOP_keyword'
  IpAddress NVARCHAR(50) NULL,
  UserAgent NVARCHAR(500) NULL,
  CreatedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_MemberConsentLog PRIMARY KEY (LogId)
);
```

### Phase 3: Unsubscribe Endpoint + Landing Page

**Backend:**
- Create `POST /api/public/unsubscribe` endpoint (no auth required — accessed from email link)
- Accepts a JWT token that encodes: `{ memberId, tenantId }`
- On POST: sets `EmailMarketingOptOut = 1` in `MemberCommunicationPreferences`, logs to `MemberConsentLog`
- Token generation: create a utility that signs `{ memberId, tenantId }` with a 30-day expiry

**Frontend:**
- Create a public page at `/unsubscribe?token=xxx`
- Shows: "You've been unsubscribed from marketing emails from [tenantName]"
- Link to preference center for more granular control (if logged in)
- Must work without login (member clicks from email)

### Phase 4: Email Unsubscribe Link in Templates

**For all marketing email templates:**
- Add an unsubscribe link in the footer: `<a href="{unsubscribeUrl}">Unsubscribe</a>`
- Add `List-Unsubscribe` and `List-Unsubscribe-Post` headers (RFC 8058 — required by Gmail/Yahoo since Feb 2024)

**Where to add this:**
- `backend/services/sendGridEmailService.js` — when sending marketing emails, include the headers
- `backend/services/messageQueue.service.js` — when queuing marketing emails, generate the unsubscribe URL and append footer HTML
- The unsubscribe URL should be: `{FRONTEND_URL}/unsubscribe?token={jwt}`

**System emails (password reset, verification, billing) should NOT get the unsubscribe link.**

Use the `MessageCategory` field on the template to determine whether to include it. If `MessageCategory = 'Marketing'`, include unsubscribe. If `MessageCategory = 'System'`, skip it.

### Phase 5: Member Preference Center Page

**Frontend page at `/account/communication-preferences`** (requires login):
- Two toggle switches:
  - Marketing emails: On/Off
  - Marketing SMS: On/Off
- Note below: "System messages (account alerts, billing, security) cannot be disabled."
- Save button → calls `PUT /api/me/member/communication-preferences`
- Logs changes to `MemberConsentLog`

**Backend:**
- `GET /api/me/member/communication-preferences` — returns current preferences
- `PUT /api/me/member/communication-preferences` — updates preferences, logs to consent audit

**Add a link to this page:**
- In the member Settings page (`frontend/src/pages/member/Settings.tsx`) — add a new "Notifications" tab
- In the unsubscribe landing page — "Manage your preferences" link

### Phase 6: Campaign System Integration

In the campaign trigger service (`backend/services/campaignTrigger.service.js`), before queuing a message:
- Check `MemberCommunicationPreferences` for the member
- If `EmailMarketingOptOut = 1`, skip the email (log as 'Skipped' in `CampaignMessageLog`)
- If `SmsMarketingOptOut = 1`, skip the SMS
- Campaigns are always Marketing — system messages don't go through campaigns

### Phase 7: Extend SMS STOP Handler

The existing STOP handler at `backend/routes/webhooks/twilio-sms.js` only updates `oe.ShareRequestMembers`. Extend it to also:
- Look up the member by phone number in `oe.Members`
- Set `SmsMarketingOptOut = 1` in `MemberCommunicationPreferences`
- Log to `MemberConsentLog` with source = `'STOP_keyword'`

## Key Files to Study

| File | What It Does |
|------|-------------|
| `backend/routes/webhooks/twilio-sms.js` | Existing SMS STOP/START handling (lines 173-424) |
| `backend/services/sendGridEmailService.js` | Email sending via SendGrid — add List-Unsubscribe headers here |
| `backend/services/messageQueue.service.js` | Message queue service — add unsubscribe footer injection here |
| `backend/services/campaignTrigger.service.js` | Campaign trigger — add opt-out check before sending |
| `frontend/src/pages/member/Settings.tsx` | Member settings page — add Notifications tab |
| `frontend/src/pages/PrivacyPolicyPage.tsx` | Privacy policy — references unsubscribe (line 85) |
| `frontend/src/pages/TermsPage.tsx` | Terms — references SMS opt-out (lines 49-57) |
| `frontend/src/pages/message-center/MessageTemplatesPage.tsx` | Template editor — add MessageCategory dropdown |
| `docs/marketing/campaigns-developer-guide.md` | How the campaign system works |
| `docs/superpowers/specs/2026-04-07-messaging-compliance-design.md` | Full compliance design spec (if it exists) |

## Acceptance Criteria

- [ ] Every marketing email includes an unsubscribe link in the footer
- [ ] Every marketing email includes `List-Unsubscribe` header
- [ ] Clicking unsubscribe link shows a confirmation page and opts member out
- [ ] Members can manage email/SMS marketing preferences from their account settings
- [ ] Campaign messages check opt-out status before sending (skip if opted out)
- [ ] SMS STOP keyword updates the member's global SMS marketing preference (not just share requests)
- [ ] All opt-in/opt-out actions are logged to `MemberConsentLog` with timestamp and source
- [ ] Templates have a `MessageCategory` field (`System` or `Marketing`)
- [ ] System emails (password reset, billing, verification) do NOT include unsubscribe link

## Notes

- Default `MessageCategory` to `'Marketing'` — safer to require explicitly marking something as System
- The unsubscribe landing page must work WITHOUT login (member clicks link in email)
- The preference center page REQUIRES login (member manages from account)
- Study the compliance design spec for more details on legal requirements

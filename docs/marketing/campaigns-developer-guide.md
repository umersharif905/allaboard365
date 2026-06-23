# Messaging Campaigns — Developer Guide

## Overview

The campaign system sends automated email and SMS sequences to members when enrollment events occur. A campaign has a trigger (what starts it) and one or more steps (messages sent on a schedule).

Example: A "Welcome" campaign fires when someone completes enrollment. Step 1 sends a welcome email immediately (Day 0). Step 2 sends a follow-up email 7 days later. Step 3 sends a check-in 30 days later.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        BACKEND (Express)                         │
│                                                                  │
│  Enrollment Completion                                           │
│       │                                                          │
│       ▼                                                          │
│  CampaignTriggerService.fireTrigger('EnrollmentCompletion')     │
│       │                                                          │
│       ├── Finds active campaigns for this trigger + tenant       │
│       ├── Creates CampaignEnrollment row (tracks member progress)│
│       ├── Checks if member is terminated (TerminationDate)       │
│       ├── Processes Day 0 steps immediately                      │
│       │      ├── Loads email/SMS template                        │
│       │      ├── Substitutes variables ({[member.FirstName]})    │
│       │      └── Inserts into oe.MessageQueue                    │
│       └── Logs to CampaignMessageLog                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                    oe.MessageQueue
                           │
┌──────────────────────────┴──────────────────────────────────────┐
│              AZURE FUNCTIONS (messageCenter/)                     │
│                                                                  │
│  MessageProcessor (every ~1 minute)                              │
│       │                                                          │
│       ├── Claims pending messages from oe.MessageQueue            │
│       ├── Sends email via SendGrid                               │
│       ├── Sends SMS via Twilio                                   │
│       └── Records delivery in oe.MessageHistory                  │
│                                                                  │
│  ScheduledProcessor (daily at 10 AM)                             │
│       │                                                          │
│       └── processCampaignSteps()                                 │
│              ├── Finds active CampaignEnrollments with due steps │
│              ├── Checks termination before sending               │
│              ├── Queues due messages to oe.MessageQueue           │
│              ├── Updates CampaignEnrollment progress              │
│              └── Marks campaigns as Completed when done          │
└──────────────────────────────────────────────────────────────────┘
```

---

## Triggers

### What is a Trigger?

A trigger is an event that starts a campaign for a member. When the trigger fires, the system:
1. Looks up all active campaigns for that trigger type and tenant
2. Creates a `CampaignEnrollment` row to track the member's progress
3. Immediately processes any Day 0 steps (sends messages right away)
4. Delayed steps (Day 7, Day 30, etc.) are picked up by the ScheduledProcessor the next day at 10 AM

### Current Triggers

| Trigger | When It Fires | Where in Code |
|---------|--------------|---------------|
| `EnrollmentCompletion` | Member completes enrollment | `backend/routes/enrollment-links.js` (~line 7865) |

### How the Trigger Fires

In `enrollment-links.js`, after a successful enrollment:

```javascript
const CampaignTriggerService = require('../services/campaignTrigger.service');
const triggerResult = await CampaignTriggerService.fireTrigger(pool, 'EnrollmentCompletion', {
  memberId: finalMemberId,
  tenantId: enrollmentLink.TenantId,
  groupId: enrollmentLink.GroupId || member.GroupId || null,
  agentId: enrollmentLink.AgentId || null
});
```

### Data Available to Triggers

The trigger receives a `context` object:

| Field | Type | Description |
|-------|------|-------------|
| `memberId` | UUID | The member who triggered the event |
| `tenantId` | UUID | The tenant the member belongs to |
| `groupId` | UUID (optional) | The group, if applicable |
| `agentId` | UUID (optional) | The agent, if applicable |

The trigger service then loads additional data for variable substitution by joining:
- `oe.Members` → `oe.Users` (member name, email, phone)
- `oe.Tenants` (tenant name, contact info)
- `oe.Groups` (group name)
- `oe.Agents` → `oe.Users` (agent name, email, phone)

### Adding a New Trigger

To add a new trigger type (e.g., `FirstDayOfCoverage`):

1. **Update the CHECK constraint** on `oe.Campaigns.TriggerType` to include the new value
2. **Add the trigger type** to the frontend dropdown in `CampaignEditorModal.tsx` (`TRIGGER_OPTIONS` array)
3. **Fire the trigger** from the appropriate code path by calling:
   ```javascript
   CampaignTriggerService.fireTrigger(pool, 'NewTriggerType', { memberId, tenantId });
   ```
4. If the trigger should be detected daily (not real-time), add the detection query to `processCampaignSteps()` in `messageCenter/ScheduledProcessor/index.js`

---

## Campaign Trigger Service

**File:** `backend/services/campaignTrigger.service.js`

### Methods

#### `fireTrigger(pool, triggerType, context)`
Main entry point. Called when a trigger event occurs.

**What it does:**
1. Queries `oe.Campaigns` for active campaigns matching the trigger type and tenant
2. For each matching campaign:
   - Checks if the member is already enrolled (prevents duplicates)
   - Creates a `CampaignEnrollment` row
   - Checks if the member is terminated (`oe.Enrollments.TerminationDate IS NOT NULL`)
   - If terminated: sets enrollment status to `Cancelled`, stops
   - If active: processes Day 0 steps, queues messages

**Returns:** `{ campaignsTriggered: number, messagesQueued: number }`

#### `processSteps(pool, enrollmentId, campaignId, memberId, tenantId, steps)`
Processes a set of campaign steps — loads templates, substitutes variables, queues messages.

#### `checkMemberTerminated(pool, memberId)`
Checks if ANY enrollment for this member has a `TerminationDate` set.

**Important:** Uses the `TerminationDate` column, NOT the `Status` field. This is a business rule — if `TerminationDate IS NOT NULL`, the member is considered terminated.

---

## Database Tables

### oe.Campaigns

Stores campaign definitions. One row per campaign.

| Column | Type | Description |
|--------|------|-------------|
| CampaignId | uniqueidentifier PK | Auto-generated |
| TenantId | uniqueidentifier | Which tenant owns this campaign |
| CampaignName | nvarchar(200) | Display name (e.g., "Welcome Campaign") |
| TriggerType | nvarchar(50) | What event starts this campaign. CHECK constraint: `'EnrollmentCompletion'` |
| IsActive | bit | Whether the campaign is active. Default: 0 (inactive) |
| CreatedDate | datetime2 | |
| CreatedBy | uniqueidentifier | |
| ModifiedDate | datetime2 | |
| ModifiedBy | uniqueidentifier | |

### oe.CampaignSteps

The timed steps within a campaign. One row per step.

| Column | Type | Description |
|--------|------|-------------|
| StepId | uniqueidentifier PK | Auto-generated |
| CampaignId | uniqueidentifier FK | References Campaigns (CASCADE DELETE) |
| StepOrder | int | Display order in the flowchart (1, 2, 3...) |
| DelayDays | int | Days after trigger to send. 0 = send immediately |
| EmailTemplateId | uniqueidentifier FK (nullable) | References MessageTemplates. NULL = no email |
| SmsTemplateId | uniqueidentifier FK (nullable) | References MessageTemplates. NULL = no SMS |
| IsActive | bit | Can disable individual steps without deleting |
| CreatedDate | datetime2 | |
| ModifiedDate | datetime2 | |

**A step can have an email, an SMS, or both.** If both are set, both are sent at the same time.

### oe.CampaignEnrollments

Tracks which members are progressing through a campaign. Created when a trigger fires.

| Column | Type | Description |
|--------|------|-------------|
| CampaignEnrollmentId | uniqueidentifier PK | Auto-generated |
| CampaignId | uniqueidentifier FK | Which campaign |
| MemberId | uniqueidentifier | Which member |
| TenantId | uniqueidentifier | Denormalized for query efficiency |
| TriggerDate | date | When the trigger event occurred. All step delays are calculated from this date |
| CurrentStepOrder | int | Last completed step. Steps with StepOrder > this are pending |
| Status | nvarchar(20) | `'Active'`, `'Completed'`, or `'Cancelled'`. CHECK constraint enforced |
| CreatedDate | datetime2 | |
| CompletedDate | datetime2 | When the campaign finished or was cancelled |

**Status flow:**
- `Active` → member is progressing through the campaign
- `Completed` → all steps have been sent
- `Cancelled` → member was terminated (TerminationDate set on their enrollment)

### oe.CampaignMessageLog

Audit trail of every message sent (or skipped) for campaign enrollments.

| Column | Type | Description |
|--------|------|-------------|
| LogId | uniqueidentifier PK | |
| CampaignEnrollmentId | uniqueidentifier FK | Which enrollment |
| StepId | uniqueidentifier FK | Which step |
| MessageType | nvarchar(50) | `'Email'` or `'SMS'` |
| MessageId | uniqueidentifier (nullable) | References the MessageQueue entry |
| SentDate | datetime2 | |
| Status | nvarchar(20) | `'Pending'`, `'Sent'`, or `'Skipped'` |

### oe.MessageQueue (existing table — not new)

Where messages wait to be delivered. The MessageProcessor Azure Function picks these up.

| Column | Type | Description |
|--------|------|-------------|
| MessageId | uniqueidentifier PK | |
| TenantId | uniqueidentifier | |
| RecipientId | uniqueidentifier | The member's UserId |
| MessageType | nvarchar(50) | `'Email'`, `'SMS'`, `'Push'`, or `'BulkBatch'` |
| RecipientAddress | nvarchar(500) | Email address or phone number |
| Subject | nvarchar(200) | Email subject (null for SMS) |
| Body | nvarchar(MAX) | Message content |
| Status | nvarchar(20) | `'Pending'` → `'Processing'` → `'Sent'` |
| QueuePriority | int | 0 = high (transactional), 10 = low (bulk) |

### oe.MessageHistory (existing table — not new)

Where delivered/failed messages are recorded after the MessageProcessor sends them.

---

## How Messages Get Sent

### Day 0 (Immediate) Flow

```
1. Member completes enrollment
2. enrollment-links.js calls CampaignTriggerService.fireTrigger()
3. Trigger service finds active campaigns for 'EnrollmentCompletion'
4. Creates CampaignEnrollment row (Status = 'Active')
5. Finds Day 0 steps (DelayDays = 0)
6. For each step:
   a. Loads the email/SMS template from oe.MessageTemplates
   b. Substitutes variables: {[member.FirstName]} → "John"
   c. Inserts into oe.MessageQueue (Status = 'Pending')
   d. Logs to oe.CampaignMessageLog
7. Updates CampaignEnrollment.CurrentStepOrder
8. MessageProcessor Azure Function picks up the message within ~1 minute
9. Sends via SendGrid (email) or Twilio (SMS)
10. Records in oe.MessageHistory
```

### Delayed Steps (Day 7+) Flow

```
1. ScheduledProcessor runs at 10 AM daily
2. Queries: active CampaignEnrollments where next step is due
   (TriggerDate + DelayDays <= today AND StepOrder > CurrentStepOrder)
3. For each due step:
   a. Checks if member is terminated → if yes, cancels enrollment
   b. Loads member context (name, email, phone, agent, tenant, group)
   c. Loads template, substitutes variables
   d. Inserts into oe.MessageQueue
   e. Logs to CampaignMessageLog
4. Updates CurrentStepOrder
5. If all steps done → sets Status = 'Completed'
6. MessageProcessor sends the queued messages within ~1 minute
```

---

## Variable Substitution

Templates can include variables that get replaced with member-specific data:

| Variable | Replaced With |
|----------|--------------|
| `{[member.FirstName]}` | Member's first name |
| `{[member.LastName]}` | Member's last name |
| `{[member.Email]}` | Member's email |
| `{[member.Phone]}` | Member's phone number |
| `{[member.FullName]}` | First + Last name |
| `{[agent.FirstName]}` | Agent's first name |
| `{[agent.LastName]}` | Agent's last name |
| `{[agent.Name]}` | Agent's full name |
| `{[agent.Email]}` | Agent's email |
| `{[agent.Phone]}` | Agent's phone |
| `{[tenant.Name]}` | Tenant/company name |
| `{[tenant.Email]}` | Tenant contact email |
| `{[tenant.Phone]}` | Tenant contact phone |
| `{[group.Name]}` | Group name |
| `{[system.CurrentDate]}` | Today's date |
| `{[system.CurrentYear]}` | Current year |
| `{[system.CurrentMonth]}` | Current month name |
| `{[system.LoginUrl]}` | Login URL |

---

## API Endpoints

All under `/api/message-center/campaigns`. Require authentication (TenantAdmin or SysAdmin).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/campaigns` | List campaigns with step counts and active enrollment counts |
| GET | `/campaigns/:id` | Get campaign with all steps (includes template names) |
| POST | `/campaigns` | Create campaign |
| PUT | `/campaigns/:id` | Update campaign (name, triggerType, isActive) |
| DELETE | `/campaigns/:id` | Delete campaign (cancels active enrollments, cascades to steps) |
| POST | `/campaigns/:id/duplicate` | Duplicate campaign with all steps (new one is inactive) |
| POST | `/campaigns/:id/steps` | Add step to campaign |
| PUT | `/campaigns/:id/steps/:stepId` | Update step |
| DELETE | `/campaigns/:id/steps/:stepId` | Delete step |
| PUT | `/campaigns/:id/steps/reorder` | Reorder steps |
| GET | `/campaigns/:id/enrollments` | List members currently in this campaign |
| GET | `/campaigns/templates/:templateId/usage` | Check which campaigns use a given template |

---

## File Map

| File | Purpose |
|------|---------|
| `backend/services/campaignTrigger.service.js` | Fires triggers, processes Day 0 steps |
| `backend/routes/campaigns.js` | Campaign CRUD API endpoints |
| `messageCenter/ScheduledProcessor/index.js` | Daily processing of delayed campaign steps |
| `messageCenter/MessageProcessor/index.js` | Sends queued messages via SendGrid/Twilio (unchanged) |
| `frontend/src/services/messageCenter.service.ts` | Frontend API service (Campaign types + methods) |
| `frontend/src/pages/message-center/CampaignsPage.tsx` | Campaign list page with tile grid |
| `frontend/src/pages/message-center/CampaignEditorModal.tsx` | Campaign editor with flowchart builder |
| `sql-changes/2026-04-07-campaigns-schema.sql` | Database migration for campaign tables |
| `sql-changes/2026-04-07-migrate-welcome-email-to-campaign.sql` | Migrates existing welcome email template to a campaign |
| `docs/issues/messaging-compliance-and-preference-center.md` | Future work: email/SMS compliance and member preference center |

---

## Deployment Notes

- The **ScheduledProcessor** Azure Function has been deployed to `allaboard-messagecenter` with campaign processing. It previously contained unused birthday/age-band code which was removed — it now only processes campaign steps.
- The **MessageProcessor** Azure Function was not modified — it continues to send queued messages via SendGrid/Twilio.
- The campaign schema migration (`2026-04-07-campaigns-schema.sql`) must be run on any database before the campaign system will work. If the testing DB is reset from prod, re-run both migration scripts.
- The welcome email was migrated from the old `welcomeEmail.service.js` system to the campaign system. The old service file still exists but is no longer called from enrollment.

---

## Termination Check

**Business rule:** Before sending any campaign message, check if the member has been terminated by querying:

```sql
SELECT TOP 1 TerminationDate FROM oe.Enrollments
WHERE MemberId = @memberId AND TerminationDate IS NOT NULL
```

If any row is returned, the member is terminated. Set the CampaignEnrollment status to `'Cancelled'` and skip all remaining messages.

**Important:** Use the `TerminationDate` column, not the `Status` field.

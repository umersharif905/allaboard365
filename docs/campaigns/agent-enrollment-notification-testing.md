# Testing: Agent Enrollment Notification

How to test the "notify the agent when a client enrolls under them" feature. It's
a normal **Enrollment Completion** campaign with **Send To = The Member's Agent**.

## Prerequisite (once)

Apply the migration that adds `oe.Campaigns.RecipientType`:

```
cd backend && node scripts/migrate.js
# or apply sql-changes/2026-06-04-campaign-recipient-type.sql
```

## Who sets it up — TenantAdmin (or SysAdmin / VendorAdmin)

Campaign management lives in the **Message Center** and is available to the
messaging roles (`SysAdmin`, `TenantAdmin`, `VendorAdmin`). Use the role that
owns the campaigns you want to fire:

| Role         | Scope of the campaign it creates                          |
|--------------|-----------------------------------------------------------|
| TenantAdmin  | Fires for enrollments in that admin's tenant              |
| VendorAdmin  | Fires in every tenant the vendor serves                   |
| SysAdmin     | Pick the owner via the "Owned by / Create for" picker     |

### Steps (as TenantAdmin)

1. Log in as a **TenantAdmin**.
2. Go to **Message Center → Templates** and create an **Email** template, e.g.
   - Subject: `New enrollment: {[member.FullName]}`
   - Body: `Hi {[agent.FirstName]}, {[member.FullName]} just enrolled. Email: {[member.Email]}`
   - Agent variables available: `agent.FirstName`, `agent.LastName`, `agent.Name`, `agent.Email`.
3. Go to **Message Center → Campaigns → New Campaign**.
4. Set:
   - **Trigger** = `Enrollment Completion`
   - **Send To** = `The Member's Agent`
   - Add a step with **Delay = 0 days (Day 0)** and select the email template above.
   - Toggle the campaign **Active**.
5. Save.

## Who triggers it — Agent / GroupAdmin / public enrollee

The campaign fires automatically when an **enrollment completes** for a member
who has an **assigned agent**. Trigger it any normal way:

- An **Agent** enrolls a member assigned to themselves, or
- A member completes the **public enrollment** flow via an agent's enrollment
  link (`/enroll-now/:shortCode` → … → complete enrollment), or
- A **GroupAdmin/TenantAdmin** completes an enrollment for an agent-assigned member.

The notification email goes to the **assigned agent's** email address — not the
member's.

## How to verify

After completing one enrollment:

1. **Message Queue / History** (Message Center) — a new message addressed to the
   **agent's email** appears (Pending → Sent once the queue processor runs).
2. **DB spot check** (read-only):

   ```sql
   -- The campaign enrollment row (one per enrolling member)
   SELECT TOP 5 * FROM oe.CampaignEnrollments ORDER BY CreatedDate DESC;

   -- The queued message — RecipientAddress should be the AGENT's email
   SELECT TOP 5 RecipientAddress, Subject, Status, CreatedDate
   FROM oe.MessageQueue ORDER BY CreatedDate DESC;
   ```

   Run via `db-query.sh --prod-readonly` (or your local DB).

## Edge cases to check

- **Member has no assigned agent** → nothing is sent (no error). Confirm no
  message is queued.
- **Member is terminated at enrollment time** → enrollment is recorded as
  `Cancelled` and no notification is sent (same guard as member campaigns).
- **Re-running** an already-processed enrollment does not double-send (dedup on
  active campaign enrollment per member).
- **Send To = The Member** (default) still emails the member — confirm existing
  member campaigns are unaffected.

## Automated tests

```
cd backend
npx jest services/__tests__/campaignTrigger.recipient.test.js   # agent vs member routing
npx jest routes/__tests__/campaigns.scope.test.js               # CRUD scope still green
```

# Enrollment Links for Agency-Only Tenants (No Agent)

## Problem

- Some tenants (e.g. Alioup) have an **agency but no agent** (agency has `OwnerAgentId = NULL`).
- The UI allows creating enrollment link **templates** with only an agency assigned.
- When creating the actual **marketing/static link** (row in `oe.EnrollmentLinks`), the backend was failing because:
  1. Agency lookup required an owner (fixed in code with LEFT JOIN).
  2. **`oe.EnrollmentLinks.AgentId` may be NOT NULL** in your database, so inserting a link with `AgentId = NULL` fails.

Result: templates are created but no link row is inserted → no badges, "Send Link" opens Quick Send instead of the copy-link modal.

## Is AgentId required for links to work?

**No.** The enroll-now flow resolves links by **ShortCode** only. It does not use `AgentId`. So links with `AgentId = NULL` work correctly for enrollment. `AgentId` is used for attribution/reporting, not for resolving the link.

## Fix (one-time database change)

Run this migration so that links can be stored with `AgentId = NULL` for agency-only tenants:

**File:** `sql-changes/enrollment-links-agent-id-nullable.sql`

```sql
ALTER TABLE oe.EnrollmentLinks
ALTER COLUMN AgentId UNIQUEIDENTIFIER NULL;
```

Run it against your database (e.g. open-enroll-dev). Then:

1. Restart the backend.
2. Create the marketing or static link again for the agency-only tenant (e.g. "Create Marketing Link" with the agency selected). The insert will succeed and the row will be created with `AgentId = NULL`.
3. Refresh the Enrollment Links list → badges will show, and "Send Link" will open the correct copy-link modal.

## Summary

| Question | Answer |
|----------|--------|
| Is AgentId required for the link to work? | No. Enroll-now uses ShortCode only. |
| Can we support agency-only (no agent)? | Yes. Allow `AgentId` NULL and insert links with `AgentId = NULL`. |
| Why don’t badges show? | No row exists in `oe.EnrollmentLinks` because the INSERT failed when `AgentId` was NOT NULL. |
| What to do? | Run the migration above, restart backend, create the link again. |

# Vendor Minimums & List-Bill — Manual Test Walkthrough

**Branch:** `feat/vendor-minimums-list-fill`
**Local servers (wt2):**
- Backend → http://localhost:3002 (health: `/health`)
- Frontend → http://localhost:5176 (5174/5175 are taken by another worktree)

**Related docs:**
- Ops guide: [`docs/enrollments/vendor-minimums-and-list-bill.md`](./vendor-minimums-and-list-bill.md)
- Spec: `docs/superpowers/specs/2026-04-23-vendor-minimums-and-list-bill-groups-design.md`

---

## How emails are delivered

Every email this feature queues lands in `oe.MessageQueue` first, then is picked up by the SendGrid worker. To inspect what was queued (without actually sending), query:

```sql
SELECT TOP 50
  MessageId, MessageType, Status, ToEmail, Subject,
  CreatedDate, SentDate, ErrorMessage
FROM oe.MessageQueue
WHERE Subject LIKE '%group%' OR Subject LIKE '%minimum%' OR Subject LIKE '%List Bill%'
ORDER BY CreatedDate DESC;
```

You can also run the SendGrid worker manually if you have it stopped — pending rows show `Status='Pending'` until processed.

### Recipients

Approve / deny / auto-approve emails go to **the group's assigned agent and only the agent** (no group admin ever, no carbon-copies). The "submitted" email is the one exception — it goes to **every TenantAdmin user for the tenant + every address in `AdvancedSettings.enrollment.belowMinimumAlertRecipients`**, deduped case-insensitively. The agent is never on the submitted email (they made the request). Backend tests in `backend/services/__tests__/groupTypeChangeRequestService.test.js` lock these recipient rules in.

All sign-offs render the tenant name (e.g. `— MightyWELL Health`), not `— Open-Enroll`. Wizard / "open group" links use the tenant's CustomDomain (or `app.allaboard365.com` fallback) — never the marketing site `allaboard365.com`.

The five emails this feature can send:

| # | Trigger | Template | Recipients |
|---|---|---|---|
| 1 | T-10 days before effective date, group below vendor minimum | `group-below-minimum-warning.html` | Agent + tenant config recipients |
| 2 | T-5 to T-1 days before effective date, group still below minimum | `group-below-minimum-lock.html` | Agent + tenant config recipients |
| 3 | Type-change request **submitted** (Pending path only — auto-approve skips this) | `group-type-change-submitted.html` | All `TenantAdmin` users + `belowMinimumAlertRecipients` |
| 4 | Type-change request approved (manual or auto) | `group-type-change-approved.html` | Agent only |
| 5 | Type-change request denied | `group-type-change-denied.html` | Agent only |

---

## Pre-flight setup (do this once)

1. **Pick a tenant + agent** for testing. Note the agent's user account and email.
2. **Make sure the agent is assigned to a group** you can experiment with. Use a non-production group; the conversion wizard mutates enrollments.
3. **Run the new SQL migration** if your dev DB still has the old `'ListFill'` enum value:
   ```
   sql-changes/2026-04-27-rename-listfill-to-listbill.sql
   ```
   It drops the old check constraints, updates data, and re-adds the constraints with `'ListBill'`. Idempotent; safe to re-run.
4. **Confirm tenant settings are reachable**: TenantAdmin → Settings → Enrollment section should show:
   - "Auto-approve group type changes" toggle (default off)
   - "Below-minimum alert recipients" textarea (extra emails for T-10/T-5)
5. Open `oe.MessageQueue` in your DB client so you can watch new rows appear during the tests.

---

## Section A — Vendor minimum setting (SysAdmin)

Goal: confirm the minimum-employees field on Vendors saves and round-trips.

| # | Step | Expected |
|---|---|---|
| A1 | Login as SysAdmin → Vendors → open a vendor | Detail panel renders |
| A2 | Find the **Minimum employees per group** field; enter `5`; save | Save succeeds |
| A3 | Reload | Field still shows `5` |
| A4 | Enter `-1` and save | 400: *"Minimum employees per group must be a non-negative integer or null."* |
| A5 | Enter `1.5` and save | Same validation error |
| A6 | Clear the field, save | Persists as `null` (no minimum) |

Roll-back: leave the field blank if you don't want this vendor to gate enrollments during the rest of testing.

---

## Section B — Create a group, choose List-Bill (Agent)

Goal: confirm the radio + reactive product picker + new copy.

| # | Step | Expected |
|---|---|---|
| B1 | Login as Agent → Groups → **Add Group** | Modal opens. **Standard Group** radio is selected by default. |
| B2 | Click **List Bill** radio | Description below reads: *"For groups that cannot meet a vendor minimum. Each member enrolls in individual products, but everyone is consolidated onto one shared bill with a single payment method."* List-Bill badge appears next to the label. |
| B3 | Open the **Products** tab → click **Add products** | Picker opens. Only products with `SalesType IN ('Individual', 'Both')` are listed. (Group-only products are hidden.) |
| B4 | Pick at least one Individual/Both product | Product appears in the selected list |
| B5 | Switch the radio back to **Standard Group** | Selected products are cleared. Disclaimer changes back. |
| B6 | Open the picker again → only Group/Both products are listed | ✅ |
| B7 | Switch back to List Bill, pick products, fill the rest of the form, submit | Group is created; appears in the groups list with a **List Bill** badge next to its name. |
| B8 | Open the new group's detail page | Header shows the List Bill badge. |
| B9 | (Negative path) Use the API to POST a Standard group with an Individual-only product (or via the form before B5 was wired) | Backend rejects with `400` — *"Selected products are not compatible with a Standard group: …"* |

---

## Section C — Group list filtering by type

Goal: confirm `?groupType=ListBill` query param filters the list views.

| # | Step | Expected |
|---|---|---|
| C1 | TenantAdmin → Groups list | All groups show (Standard + List-Bill mixed). Each row's name has the List Bill badge if applicable. |
| C2 | Append `?groupType=ListBill` to the URL | Only List-Bill groups |
| C3 | Append `?groupType=Standard` | Only Standard groups |
| C4 | Repeat as SysAdmin | Same behaviour, scoped across all tenants |

---

## Section D — Type-change request, manual approval (Agent → TenantAdmin)

Goal: end-to-end with TenantAdmin reviewing. Watch `oe.MessageQueue` to verify exactly one email per agent.

| # | Step | Expected |
|---|---|---|
| D1 | TenantAdmin → Settings → make sure **Auto-approve group type changes** is **OFF** | ✅ |
| D2 | Agent → open a Standard group → **Settings** tab → click **Request type change** | Modal: current=Standard, requested=List Bill |
| D3 | Try to submit with `< 5 chars` reason | Submit is disabled |
| D4 | Enter ≥5-char reason, click **Submit Request** | Modal switches to "Pending approval" |
| D5 | Look at `oe.MessageQueue` (or `oe.MessageHistory`) | **One row per TenantAdmin user + per `belowMinimumAlertRecipients` address**, subject *"New request: <Group> group type change"*. Agent is NOT on this list. |
| D6 | Login as TenantAdmin → **Group Type Change Requests** | Pending row visible: group name, agent name, reason |
| D7 | Click **Deny** without notes | Inline error: notes required |
| D8 | Add notes (e.g. *"Group is large enough — push for more enrollment"*) → **Deny** | Row leaves Pending, shows under Denied tab |
| D9 | `oe.MessageQueue` SQL query above | **One** new row, `ToEmail = <agent's email>`, subject begins *"Denied: …"* |
| D10 | Repeat D2–D6 for a fresh request, then **Approve** | Row leaves Pending; the group's GroupType is **NOT yet flipped** (intentional — see Section F). |
| D11 | `oe.MessageQueue` | **One** new row, `ToEmail = <agent's email>`, subject begins *"Approved: …"* |

> **What to verify in `oe.MessageQueue`:** `ToEmail` is the agent's address — never a group admin's. Only one row per request. No `cc` / `bcc` columns populated.

---

## Section E — Auto-approve flow

Goal: with auto-approve on, agent's request is approved instantly and the email goes straight to the agent.

| # | Step | Expected |
|---|---|---|
| E1 | TenantAdmin → Settings → toggle **Auto-approve group type changes** ON, save | ✅ |
| E2 | Agent → request a type change on another Standard group | Modal switches directly to "Approved" with a "Continue to wizard" CTA. **No row appears in TenantAdmin Pending queue.** |
| E3 | TenantAdmin → Group Type Change Requests → Approved tab | Row present with `ReviewNotes = 'Auto-approved per tenant setting'`, `ReviewedBy = system user` |
| E4 | `oe.MessageQueue` | **One** new email, agent only |

---

## Section F — Conversion wizard (the heart of the feature)

Goal: walk through all 5 steps. Every test should focus on whether enrollments transfer cleanly.

> **Setup for this section:** the group should have at least 4 active members:
> - **Member α** — has an Active enrollment on a Group product whose vendor offers an Individual equivalent (same vendor + same `ProductType`, `SalesType IN ('Individual','Both')`). Effective date in the past.
> - **Member β** — has an Active enrollment on a Group product whose vendor has NO matching Individual product. Effective date in the past.
> - **Member γ** — has a Pending enrollment with a future effective date, on a Group product whose vendor has NO matching Individual.
> - **Member δ** — has a Pending enrollment with a future effective date, on a Group product that has a matching Individual.

| # | Step | Expected |
|---|---|---|
| F1 | From the agent approval email, or via Settings → "Continue to wizard" CTA, open the wizard | URL: `/groups/:id/type-change/wizard`. Step 1 of 5 visible. |
| F2 | **Step 1 — Review** | 3 collapsible sections: **Preserve** (α, δ — both have a matching Individual), **Re-enroll** (γ — future effective, no match), **Let finish, then cancel** (β — past effective, active, no match). |
| F3 | Click **Next** | Step 2 |
| F4 | **Step 2 — Products** | Only `SalesType IN ('Individual','Both')` listed, grouped by vendor. The Individual products that match Preserve members are pre-selected. Pick any additional individual products you need. |
| F5 | Click **Next** | Step 3 |
| F6 | **Step 3 — Confirm** | Counters visible: *Products to activate*, *Enrollments to repoint (preserve)*, *Active enrollments to terminate at month end*, *HouseholdMemberIds to clear*. Yellow callout summarising what happens. |
| F7 | Try clicking **Apply conversion** without ticking the checkbox | Disabled |
| F8 | Tick the checkbox → **Apply conversion** | Button shows "Applying…" then advances to Step 4. **Backend response includes:** `productsHidden`, `productsAdded`, `preservedEnrollmentsRepointed`, `enrollmentsTerminationScheduled`, `householdIdsCleared`, `enrollmentsCancelled`, `groupType: 'ListBill'`. |
| F9 | **DB check (critical) — Preserve members:** | `SELECT EnrollmentId, ProductId, Status FROM oe.Enrollments WHERE MemberId IN (α, δ);` — `ProductId` should now point at the **new individual product** (not the old group product). Status unchanged. |
| F10 | **DB check — Re-enroll members:** | `SELECT MemberId, EnrollmentId, Status FROM oe.Enrollments WHERE MemberId IN (γ);` — future Pending enrollment is `Status='Cancelled'`. `oe.Members.HouseholdMemberId` is `NULL` for γ. |
| F11 | **DB check — Let-finish members:** | `SELECT EnrollmentId, Status, TerminationDate FROM oe.Enrollments WHERE MemberId IN (β);` — Active enrollment now has a `TerminationDate` set to **the day before next month's first** (e.g. `2026-04-30` if today is in April). `oe.Members.HouseholdMemberId` is `NULL` for β. |
| F12 | **DB check — GroupType:** | `SELECT GroupType FROM oe.Groups WHERE GroupId = …` returns `'ListBill'`. |
| F13 | **DB check — Old group products:** | `SELECT ProductId, IsHidden, IsActive FROM oe.GroupProducts WHERE GroupId = …` — old Group-SKU rows are `IsHidden = 1`. New Individual rows are `IsHidden = 0, IsActive = 1`. |
| F14 | **Step 4 — Send links** | Member list now shows **β + γ** (both let-finish AND re-enroll buckets) with labels *"After current term ends"* (β) and *"Re-enroll now"* (γ). Preserve members (α, δ) are NOT in this list. |
| F15 | Pick a Group-type enrollment template, click **Send links** | Each member in the list gets one email row in `oe.MessageQueue`. Subject = template subject. `ToEmail = <member's email>`. |
| F16 | **Step 5 — Done** | Summary table: *Enrollments preserved (repointed)*, *Active enrollments scheduled to terminate*, *Pending enrollments cancelled*, *HouseholdMemberIds cleared*, *New enrollment links sent*. Numbers should match what F9-F11 confirmed. |
| F17 | Click **Back to group** | Lands on group detail. Badge now reads **List Bill**. |

### F-edge — half-state guard (regression test)

Old behaviour was to flip GroupType at approval, leaving the group "ListBill" with Standard products until wizard completion. Verify that's gone:

| # | Step | Expected |
|---|---|---|
| F18 | Approve a fresh request but **don't** open the wizard yet | `SELECT GroupType FROM oe.Groups WHERE …` still shows `'Standard'`. |
| F19 | Run the wizard apply | GroupType flips to `'ListBill'` only after apply commits. |

---

## Section G — T-5 enrollment lock (live UX)

Goal: the friendly "Enrollment temporarily paused" screen replaces the wizard for new members when the group is below minimum and inside T-5.

> **Test prep:** pick or create a Standard group on `vendor-with-minimum=5`. Have only 2 enrolled. Stage the test by adjusting effective date or system clock so we're inside the T-5 window, OR override `_now` via a unit test (see `enrollment-links.lock.test.js`).

| # | Step | Expected |
|---|---|---|
| G1 | Open `/enroll/<linkToken>` for a brand-new member on the locked group | UI: *"Enrollment temporarily paused — This group has not yet reached the minimum required enrollees. Please contact your agent to continue."* |
| G2 | Open the same link as a member who already has a Pending enrollment | Wizard renders normally (mid-flow exception) |
| G3 | Convert the same group to ListBill **OR** raise the count to ≥5 | Re-open the link as a fresh member → wizard renders normally; lock auto-released. |
| G4 | Open the same link for a List-Bill group | Wizard renders normally regardless of count. |

---

## Section H — Nightly job + email timeline (T-10 / T-5)

Goal: prove the alerts fire at exactly the right intervals and dedupe correctly.

The nightly job is `POST /api/scheduled-jobs/below-minimum-check` (gated by `SCHEDULED_JOB_API_KEY` if you set that env var). The job uses the system clock to derive `nextEffectiveDate = first of next month` and computes `daysRemaining`. It only sends:
- a **Warning** email when `daysRemaining === 10`
- a **Lock** email when `daysRemaining ≤ 5`

Dedup is via `oe.GroupMinimumAlerts` (UNIQUE on `GroupId, EffectiveDate, AlertType`).

### H-1 Smoke test — outside the windows
| # | Step | Expected |
|---|---|---|
| H1.1 | Today is, say, the 3rd of the month. `daysRemaining` ≈ 27. | `curl -X POST http://localhost:3002/api/scheduled-jobs/below-minimum-check` returns `{ success: true, data: { processed: 0 } }`. No new rows in `oe.MessageQueue` or `oe.GroupMinimumAlerts`. |

### H-2 T-10 fire (force the date)
There are two ways to test the T-10 path:

**Option A — temporarily change system date.** Set the OS clock so that today is exactly 10 days before the 1st (e.g. `Apr 21` for May effective). Run:
```
curl -X POST http://localhost:3002/api/scheduled-jobs/below-minimum-check
```
**Option B — call the service directly with `now` injected.** Open `node` REPL in `backend/`:
```js
const svc = require('./services/belowMinimumCheckService');
// 10 days before May 1, 2026:
svc.run({ now: new Date('2026-04-21T00:00:00Z') }).then(console.log);
```
| # | Step | Expected |
|---|---|---|
| H2.1 | Run the job with `now` 10 days before next effective date | Response: `{ processed: <N> }` where N = number of qualifying groups. |
| H2.2 | Inspect `oe.GroupMinimumAlerts` | One row per qualifying group with `AlertType='Warning'`, `EffectiveDate=2026-05-01`. |
| H2.3 | Inspect `oe.MessageQueue` | One email per qualifying group's agent (+ tenant-config recipients), template: `group-below-minimum-warning`, subject: *"Action needed: <Group> is below the minimum enrollment count"*. **No group admin recipients.** |
| H2.4 | Run the job again with the same `now` | Response: still `processed: N` BUT no duplicate emails — dedup check skips groups already alerted. (`oe.MessageQueue` count unchanged.) |

### H-3 T-5 lock fire (force the date)
| # | Step | Expected |
|---|---|---|
| H3.1 | Run the job with `now` set to T-5 days before next effective | One Lock alert per group (template: `group-below-minimum-lock`, subject: *"Enrollments paused: …"*). New row in `GroupMinimumAlerts` with `AlertType='Lock'`. |
| H3.2 | Run again at T-3 days | No new alerts (dedup). |
| H3.3 | Run at T+1 days (after effective date passed) | `processed: 0`. |

### H-4 Recipient verification
For both H2 and H3:
- Confirm agent's email appears as `ToEmail`.
- Confirm any addresses listed in **TenantAdmin → Settings → Below-minimum alert recipients** also got an email.
- Confirm **no** group admin user got the email (compare against `oe.GroupAdmins` for that group).

---

## Section I — ASA / New-Group-Form gating

Goal: List-Bill groups never trigger ASA flows.

| # | Step | Expected |
|---|---|---|
| I1 | Open a List-Bill group → **Setup** tab | ASA section is missing or marked as not applicable. The setup completion percentage doesn't dock points for missing ASA. |
| I2 | `curl http://localhost:3002/api/groups/:listBillGroupId/asa-status` | Response: `{ success: true, data: { notApplicable: true, products: [], summary: { productsRequiringASA: 0, asaCompletionPercentage: 100 } } }` |
| I3 | `curl -X POST .../asa-sign` for a List-Bill group | 400 with `{ code: 'ASA_NOT_APPLICABLE_LISTBILL' }`. |
| I4 | Run the New-Group-Form scheduled job for a vendor whose List-Bill group has enrollments | The job's `findCandidateGroups` excludes List-Bill, so the group does NOT appear in the export list. (Look at the response payload `groupsProcessed` and the email contents.) |
| I5 | Same vendor, but run for a Standard group | Group included as before — no regression. |

---

## Section J — End-to-end smoke (full happy path)

If you only have time for one test, do this one:

1. Login as **Agent**, create a List-Bill group with one Individual product.
2. Login as **TenantAdmin**, confirm the group appears in the queue list with the badge.
3. Send an enrollment link to a new member; complete enrollment as that member.
4. Login as **Agent**, request a Standard → List-Bill conversion on a different (Standard) group with ≥3 mixed members. Approve as TenantAdmin.
5. Run the wizard end-to-end (Section F).
6. Confirm the resulting `oe.MessageQueue` rows after each user action go to expected recipients (agent for type-change emails; members for re-enrollment links). No group admin appears anywhere.

---

## Quick log spots while testing

```bash
# Backend live tail (where the queueEmail logs end up):
tail -f /tmp/wt2-backend.log

# Frontend (Vite):
tail -f /tmp/wt2-frontend.log
```

Look for `[groupTypeChangeRequestService]` warnings — those mean an email failed silently; tests should be marked as informational rather than failures.

---

## What I (Claude) am testing in parallel

While you go through this manually, I can:
- Re-run the full backend/frontend test suite on demand.
- Watch the dev-server logs and report on any 500s or unhandled rejections.
- Hit the API endpoints directly via `curl` to verify response shapes match the test plan.
- Spin up a tiny Cypress run for one of the happy paths.

Let me know what you'd like me to focus on while you click through.

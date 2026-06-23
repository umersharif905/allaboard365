# Prospects CRM — Manual Test Guide (all phases)

## 0. Prerequisites (do this first)

1. **Run the migrations** (per DB policy, none are auto-applied):
   - `sql-changes/2026-05-25-add-prospects.sql` (prospects + products) — *already applied*
   - `sql-changes/2026-05-26-prospects-phases-2-5.sql` (comms linkage, quotes + proposal link, agent-scoped API keys)
   - `sql-changes/2026-05-27-prospects-phase-6.sql` (**NEW** — group prospects + `GroupProspectId`; tags + tag assignments; `NextFollowUpDate` + `LastContactedDate`)
   All are idempotent.
2. **Restart the backend** (`node app.js`) — no hot-reload. Startup log should show the
   mounts for `/api/prospects`, `/api/quotes`, `/api/prospect-tags`, `/api/agent-api-keys`, `/api/lead-ingest`.
3. **Start the frontend** (`npm run dev`).

## 1. Where to go, and as whom

| User type | Log in as | URL | Sees |
|---|---|---|---|
| **Agent** (no downline) | a plain agent | `/agent/prospects` | Only their own prospects |
| **Upline Agent** | an agent who is a parent in `oe.AgentHierarchy` | `/agent/prospects` | Self + downline; filter to a specific downline agent or "Me" |
| **Agency Admin / Agency Owner** | an agent in `oe.AgencyAdmins` (or `AgencyOwner` role) | `/agent/prospects` | Whole agency; filter: All Agency Agents / Direct downlines / All Downline / Me / specific agent |
| **Tenant Admin** | a TenantAdmin | `/tenant-admin/prospects` | Whole tenant; **Agency** dropdown + **Agent** dropdown to narrow |
| **SysAdmin** | a SysAdmin | `/admin/prospects` | All tenants; same agency/agent dropdowns |

---

## 2. Test cases

### A. Manual create + dedupe
1. **Add Prospect** with everything blank → inline error "Enter at least a name, email, or phone."
2. Create with name + email + phone + referral + premium → row appears, status **New**, you are the owning agent.
3. **Add Prospect** again with the **same email** → updates the existing prospect, **no duplicate** (count unchanged).
4. Same but match on **phone only** → still de-duped.
5. Brand-new email/phone → new row.

### B. Edit + status
1. Open a row → **First/Last/Email/Phone/Estimated premium** are editable, plus **Status / Referral / Notes**.
2. Edit name + email, change status, Save → reopen and confirm it persisted (list row updates too).
3. **Save changes** disabled until something changes. Status options: New, Contacted, Proposal Sent, Closed, Lost.

### B2. Delete
1. Open a prospect → **Delete** (bottom-left) → inline confirm → **Confirm delete** → row disappears.
2. **Cancel** leaves it intact.

### C. Member match (suggest → confirm, no auto-close)
1. Create a prospect whose **email matches an enrolled member** → blue "Possible member match" banner; row shows a check icon; status stays **New**.
2. **Confirm link** → status flips to **Closed**, green "Linked to member…" line.
3. **Phone-only** match also triggers the banner. No match → no banner.

### D. Communications tab (Phase 2)
1. Open a prospect → **Communications** tab. Composer toggles **Email / SMS** (disabled if that contact field is empty).
2. Send an email (subject + body) → it appears in **History** (status Queued/Sent). Send an SMS likewise.
3. If the prospect's email/phone already received messages (e.g. an enrollment email), those show in History too (matched by address).

### E. Proposals & Quotes tab (Phase 3, updated Phase 6)
1. **Real tools on the prospect (Phase 6):** Open a prospect → **Proposals & Quotes** tab. There are now two buttons, **Quick Quote** and **Individual Proposal** (the old lightweight product+premium form is gone).
   - **Quick Quote** opens the real Quick Quote wizard, **prefilled** with this prospect's name/email/phone. Complete + email/download it → the tab refetches and the quote shows; the prospect advances to **Proposal Sent**.
   - **Individual Proposal** opens the real Send Proposal modal (individual mode), **prefilled** the same way. Send it → it appears under "Proposals sent" with a PDF link.
2. **Auto-create from a proposal:** from the existing proposal flow (Marketing/Quote → send a proposal to a NEW email), then go to Prospects → a prospect was created (source Proposal, status Proposal Sent) with no duplicate. Open it → the proposal shows under "Proposals sent" with a PDF link.
3. Send another proposal to that **same** email → still one prospect (no dup); a second proposal row appears.

### F. Lead-ingest API key (Phase 4) — agent portal
1. As an **Agent**, click **Lead Ingest API** (top right) → **Generate new key** → the full `sk_live_…` key is shown once; copy it.
2. Run the sample `curl` (shown in the modal) with the key:
   ```
   curl -X POST https://api.allaboard365.com/api/lead-ingest \
     -H "Authorization: Bearer sk_live_..." -H "Content-Type: application/json" \
     -d '{"firstName":"Lead","lastName":"One","email":"lead1@example.com","referralName":"Website","premiumAmount":200}'
   ```
   → `{ success: true, data: { prospectId, created: true } }`. The lead appears in **that agent's** Prospects (source ApiIngest).
3. POST the **same email** again → `created: false`, no duplicate.
4. **Revoke** the key in the modal → the same curl now returns **401/invalid key**.

### G. Report export (Phase 5)
1. **Export CSV** (top right) downloads `prospects-report-<date>.csv` honoring the **current filters** (status, search, agent/agency scope).
2. Columns include name, email, phone, status, referral, premium, products, agent, source, enrolled-member flag, created date.

### H. Visibility / role scoping (core)
Use an **upline**, a **downline** of that upline, and an unrelated agent.
1. Downline agent creates prospect "D".
2. Upline agent: default view includes "D"; **Me** hides it; selecting the **downline agent** shows only theirs.
3. Unrelated agent: must **NOT** see "D".
4. Agency Admin: **All Agency Agents** shows everyone in the agency; **Direct downlines** shows direct children + you.
5. **TenantAdmin** (`/tenant-admin/prospects`): use the **Agency** dropdown to filter to one agency, and the **Agent** dropdown to filter to one agent (agent narrows within the chosen agency). "All agencies / All agents" shows the whole tenant.
6. **Cross-tenant isolation:** a TenantAdmin of tenant A never sees tenant B's prospects.

### I. Authorization / negative checks (via API)
1. `GET /api/prospects/:id` for a prospect outside your downline → **403**.
2. `POST /api/prospects/:id/confirm-member-link` with a member from another tenant → **400**.
3. `PUT /api/prospects/:id` with `status:"Bogus"` → **400**.
4. `DELETE /api/prospects/:id` outside your scope → **403**; another tenant → **404**.
5. `POST /api/lead-ingest` with a **tenant-level** (non-agent) key → **403** ("not agent-scoped").

---

## Phase 6 test cases (2026-05-27)

### J. Quick Quote on the Quote page creates a prospect
1. Go to **Quote** (Marketing) → **Quick Quote** → run the wizard for a **brand-new email** and **email** (or download) it.
2. Go to **Prospects** → a prospect now exists for that email (find-or-create, no duplicate). Re-running Quick Quote for the **same** email does **not** create a second prospect.
3. A Quick Quote failure to create the prospect must **never** block the quote itself (best-effort).

### K. Nav placement
1. Agent portal side nav: **Prospects** appears **directly under Quote**.
2. Tenant-Admin side nav: **Prospects** appears **directly under Quote** (after Enrollment Links → Quote → Prospects). SysAdmin has no Quote item; Prospects unchanged there.

### L. Tags (agency-shared, colored, multi-tag)
1. Open a prospect → **Tags** section → **add a new tag** (name + pick a color) → it appears as a colored chip on the prospect. Add a **second** tag → both chips show (multiple tags allowed).
2. Remove a tag via its **×** → chip disappears; reopen to confirm it persisted.
3. On the list, the prospect's tags render as colored chips by the name.
4. Toolbar **tag filter**: select one or more tags → list narrows to prospects carrying any selected tag (page resets to 1). Clear → full list.
5. **Agency sharing:** a tag a colleague in your **same agency** created is selectable for you; a different agency's tag is not (admins see all). 
6. **Delete guard:** as a plain agent, deleting a **tenant-wide** tag (admin-created) is refused with a friendly error; deleting your **own agency** tag works. Admins can delete any tenant tag.
7. **CSV:** Export CSV → a **Tags** column is present.

### M. Follow-up date + due filter
1. Detail modal → set **Next follow-up** to a **past** date → Save. List row shows an **Overdue** (red) indicator. Set a **future** date → indicator is normal.
2. Clear the follow-up date → Save → indicator gone.
3. Toolbar **follow-up filter**: **Overdue** shows only past-due; **Upcoming** shows today/future; **Has follow-up** shows any set; **All** clears it.

### N. Last-contacted (auto)
1. Detail modal shows **Last contacted: …** (read-only). For a brand-new prospect with no outreach → "Never".
2. Send an email/SMS from the **Communications** tab → reopen → **Last contacted** updates to today.
3. Send a proposal/quote to the prospect → **Last contacted** also updates.

### O. Reassign owning agent
1. As **TenantAdmin/SysAdmin** (or an **upline/agency** user): detail modal shows a **Reassign agent** control. Pick another (allowed) agent → the prospect's owning agent changes; it now appears under that agent's scope.
2. A plain agent with no downline does **not** see the control.
3. (API) `POST /api/prospects/:id/reassign` to an agent **outside** your allowed set → **403**; to an agent in **another tenant** → **400**.

### P. Sortable columns
1. On the list, click the **Name**, **Status**, **Premium**, and **Created** headers → rows sort; clicking again toggles asc/desc; the active column shows a chevron. Default is **Created, newest first**.

### Q. Group prospects (schema + linkage)
1. From **Quote** → send a **Business proposal** for a company to a new recipient email.
2. (DB smoke, read-only) `SELECT * FROM oe.GroupProspects WHERE CompanyName = '<company>'` → one row exists; the created prospect's `GroupProspectId` points to it. Sending another business proposal for the **same company/email** does not create a duplicate group row.

---

## 3. Smoke test
- Startup logs show all five mounts (`/api/prospects`, `/api/quotes`, `/api/prospect-tags`, `/api/agent-api-keys`, `/api/lead-ingest`).
- Opening the page calls `GET /api/prospects?...` returning `{ success, data: { prospects, total, page, pageSize } }`; rows include `Tags`, `NextFollowUpDate`, `LastContactedDate`.
- `GET /api/prospect-tags` returns the caller's visible tags.

# Submissions Pages Redesign — design & plan

Design and implementation plan for cleaning up the submissions UX — both the
list and the individual submission detail page — so they read as care-team
tools rather than an ops/debugging console.

- **Branch:** `fix/back-office/form-editor`
- **Date:** 2026-05-14
- **Companion docs:** `ui-redesign-design.md`,
  `builder-lower-half-redesign-design.md`, `implementation-log.md`

---

## 1. Goal

Today both pages expose internal triage and ops machinery prominently —
manual-member-assignment UUIDs, link-open timing deltas, an inline Resend on
every list row, and a detail page titled just "Submission" with the actual
content buried under ~6 panels. The care team should see the *submitted
content* first, with triage tools brought forward only when a submission
genuinely needs human attention.

---

## 2. Shared rule

**Unresolved / unmatched submissions surface the triage tools; resolved
submissions tuck them away.** Triage is only relevant when a recipient typed a
member ID that didn't match the database — that's the moment the care team
acts. Everywhere else the content leads.

---

## 3. Current inventory (recap)

**Submissions list:** header + Export CSV; filter bar (dates, form, status,
source, name search, keyword); 10-column table — Submitted · Form · Source ·
Member · Resolution · Linked-to · Member ID (form) · Link view Δ · Email
queue + Resend · Open; pagination.

**Submission detail:** title "Submission"; panels — Tracking · Membership /
Member · Linkage (+ change / remove) · Resolve / Retry buttons · Manual
member assignment (paste UUID) · Payload (pre-screening, Form answers,
Account snapshot, Raw JSON, Files) · Export & share (PDF / CSV exports,
send-summary-email, queue routing-notification emails).

---

## 4. Submissions list redesign

A trimmed, more legible table — same filter bar and pagination; the rework
is the row shape.

### 4.1 Columns

| Column | Treatment |
|---|---|
| **Submitted** | Date + time; "Latest" pill on grouped rows. Unchanged. |
| **Form** | Form name as **plain text** (not a link — today's link surface is the source of the "I thought this opened the submission" confusion). A small **chevron icon** in the corner of the cell links to the form template itself. |
| **Source** | Keep (anonymous / targeted / authenticated pill). |
| **Member** | Resolved name; falls back to typed name; em-dash otherwise. Unchanged. |
| **Resolution** | A compact **status icon** — ✓ for resolved (any flavour) / ⚠ for needs-attention — with the exact label (e.g. "resolved · linked", "ambiguous", "unresolved") on hover. Replaces today's coloured pill. |
| **Linked to** | RequestNumber as a **clickable link** to the share request; "—" if none. |
| **Member ID** | **✓ / ✗** — whether the recipient provided a member ID; the typed value on hover. Replaces today's raw text. |
| **Open** | A **prominent button** (not the muted text link). |
| ~~Link view Δ~~ | **Dropped** — ops/audit metric, lives on the detail page's Tracking panel. |
| ~~Email queue + Resend~~ | **Dropped** — Resend moves to the submission detail page. |

### 4.2 Unresolved rows

Unresolved rows get a subtle **left accent** (`border-l-2 border-amber-400`)
so they stand out without shouting. The default filter is already
`status=unresolved`, so this reinforces — not duplicates — the existing UX.

### 4.3 Filter bar & pagination

Unchanged functionally. Light visual tidy only — same dates, form, status,
source, name search, keyword search, reset, page size — these are the
care team's actual search controls and they work.

---

## 5. Submission detail redesign

Top-down, content-first; triage conditional on resolution.

### 5.1 Summary header (always)

- Back link.
- **Form name** as the page heading (replaces today's "Submission").
- Sub-line: *"submitted by **{member name}** · {when}"* (falls back to
  "Unmatched recipient" + when, for unresolved submissions).
- **Status pills**: resolution (`Resolved · linked` / `Needs attention` /
  etc.), source (anonymous / targeted / authenticated), linked-to
  (RequestNumber, clickable) when present.
- Top-right: **Export** menu (PDF, Complete PDF, CSV) and a **Manage**
  button (opens the "Manage member & linkage" section below).

### 5.2 Needs-attention block — unresolved only

An amber block directly under the header. Reads as the single thing to fix.
Carries:

- A one-line explanation (e.g. "This submission's member ID didn't match a
  record. Resolve it below.").
- The **member ID the recipient typed** (or "no member ID provided").
- **Resolve** and **Retry** buttons (today's existing actions).
- **Manual member assignment** — the UUID-paste form, in context with a
  clear "I already know which member this is" framing.

Not shown for resolved submissions.

### 5.3 Submitted answers — the content

Pre-screening summary · Form answers grid · Account snapshot grid · Files ·
Raw JSON (collapsed). The B-020 split and the `__preScreening` summary stay
exactly as they are — already in good shape; the move is purely promotion
in the page order.

### 5.4 Manage member & linkage — resolved-only collapsible

A `<details>` that opens from the header's **Manage** button. Contains the
triage tools that the unresolved case surfaces inline: change / remove
linkage, re-resolve, manual member assignment. Collapsed by default for
resolved submissions so a clean review screen doesn't carry the machinery.

### 5.5 Tracking & notifications — demoted

A collapsed (or quietly-styled) bottom section grouping:

- **Tracking** — submitted time, "submission link first opened", time
  delta. Audit/ops detail; useful occasionally.
- **Send summary email** — the recipient input + send button.
- **Routing notifications** — the existing recipients textarea + queue
  button. This is where the list's old Resend moves to.

---

## 6. Files touched

- `frontend/src/pages/tenant-admin/TenantSharingSubmissionsPage.tsx` —
  list redesign: column trimming, the new Member-ID and Resolution status
  icons, plain-text form name with chevron-to-form, prominent Open button,
  unresolved-row accent.
- `frontend/src/pages/tenant-admin/TenantSharingSubmissionDetailPage.tsx` —
  detail-page restructure: summary header, conditional needs-attention
  block, content-first order, Manage collapsible, demoted tracking &
  notifications.
- New shared helper, e.g.
  `frontend/src/components/tenant-admin/public-form-builder/submissionStatus.ts`
  (or sibling) — `resolutionIcon(submission)` returning
  `{ icon, label, tone }` so the list and detail render the same status
  vocabulary.
- No backend changes; no schema changes.

---

## 7. Implementation sequence

1. Small shared helper — `resolutionIcon` / `resolutionStatus` returning the
   icon + label + tone for a submission, plus a `hasMemberId(s)` helper used
   by the new ✓/✗ Member ID column.
2. Submissions list — column trim + new treatments + unresolved row accent.
3. Submission detail — summary header + needs-attention block + content
   promotion + Manage collapsible + demoted tracking & notifications.
4. Type-check and lint (`tsc --noEmit`, `eslint`) in the container.

Stays within the app's existing Tailwind / `oe-primary` design system and
Lucide icons — same visual language as the form editor.

---

## 8. Out of scope

- `SubmissionPreviewModal` (the SR-tab peek modal) — already clean enough;
  not touched unless its row dump is also affected, in which case it
  benefits implicitly from the shared helpers.
- Filter bar redesign — the controls are already functional and used; only
  a light visual tidy if anything.
- Any backend / schema changes.

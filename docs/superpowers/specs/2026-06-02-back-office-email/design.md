# Back Office Email System — Design Spec

- **Date:** 2026-06-02
- **Branch:** `feat/backoffice/email`
- **Status:** Approved foundation design (Phase 1). AI assist (Phase 2) sketched.
- **Companion files:** [`features.md`](./features.md) · [`blockers.md`](./blockers.md) · [`haiku-assist-mockup.html`](./haiku-assist-mockup.html)

---

## 1. Problem

The care team (VendorAdmin / VendorAgent) currently handles customer email in a **shared Outlook inbox**, outside the back office. That means:

- Email lives in a separate app from the share requests and cases it relates to.
- There is no record of which care-team member sent what.
- Email is not captured as **encounters**, so the case/share-request **History** timeline is blind to it (unlike phone, which Zoom auto-captures).
- A half-built per-share-request email feature exists in code but was never wired into the UI and holds no data (see §3).

**Goal:** bring email fully into the back office — an in-app inbox the care team works from without opening Outlook — and make every inbound/outbound message a first-class, linkable, attributed event that feeds the same History timeline as calls. This is also the data foundation for a future AI (Phase 2) that reads a share request end-to-end and suggests the next step / a draft reply.

## 2. Goals & Non-Goals

### Phase 1 goals (this branch)
1. **Inbox** in the back office: read mail arriving in the vendor's shared mailbox, grouped into threads.
2. **Threaded reader**: full conversation view, read/unread, attachments.
3. **Send & reply** from the back office, sent *as* the shared mailbox, **attributed to the internal user**, with a friendly personal footer and a customer-visible case/SR reference.
4. **Link** a thread to a Share Request or Case (auto-suggested, care-team-confirmed). Linking creates **one encounter per message**, so email flows into the existing History timeline.
5. **Status pills** (Needs reply / Awaiting customer / Linked / Unread), all derived.
6. **Real-time inbound** via Graph change-notification webhooks **plus** delta-poll reconciliation.
7. Vendor-scoped, **Sharewell first**, reusing the per-vendor Office365 config already in `oe.Vendors`.

### Phase 2 (fast-follow, sketched here, not built)
- Haiku-powered **suggested next step** + **suggested draft reply**, surfaced in the thread reader. **Never auto-sends** — always care-team approval. Placement shown in `haiku-assist-mockup.html`.

### Non-goals (Phase 1)
- AI generation/sending. Folders/labels, full-text search, saved replies, SLA timers, bulk actions, per-user signatures — all Phase 3+ (see `features.md`).
- Multi-mailbox-per-vendor. Migrating historical Outlook mail (we start capturing from go-live; backfill is optional later).

## 3. Existing state (audit findings)

| Thing | Reality |
|---|---|
| Back office | The **Vendor Portal** (`/vendor/*`). Care team = `VendorAdmin` + `VendorAgent`. |
| Encounters | `oe.Encounters` already models any communication: `Channel` (`phone\|email\|in_person\|sms\|video\|other`), `Direction`, `Source` (`manual\|zoom_phone\|imported`), nullable `MemberId`/`CaseId`/`ShareRequestId`, `ExternalRef` (dedup). Zoom calls auto-create encounters via `createFromCallLog()`. Renders in the History timeline. |
| Graph email | `backend/services/graphEmailService.js` already sends from a shared mailbox (`/users/{sharedMailbox}/sendMail`, client-credentials) and polls replies by `SR-YYYY-XXXX` subject match. Per-vendor config in `oe.Vendors` (`Office365TenantId/ClientId/ClientSecret/SharedMailbox`). |
| SR email UI | `frontend/.../share-requests/tabs/EmailLogTab.tsx` exists but is **orphaned** — never imported/mounted. Care team cannot use it. |
| SR email endpoints | `backend/routes/me/vendor/share-requests.js` has live `/:id/emails`, `/emails/send`, `/emails/check-replies`, `/emails/preview`, `/emails/template-data`. |
| `oe.ShareRequestEmails` | **Exists in `allaboard-testing`, 0 rows.** No data. |
| History | `historyTimelineService.collectShareRequestEmails()` reads `oe.ShareRequestEmails` into the SR timeline. |

**Decision:** the SR email flow was built and abandoned with no data behind it. Phase 1 **supersedes** it: build a unified store, retire `EmailLogTab` and the per-SR `/emails/*` endpoints, re-point `historyTimelineService` to the new store, and **drop** the empty `oe.ShareRequestEmails` table (see `sql-changes/2026-06-02-drop-sharerequest-emails.sql`). Zero migration, zero live-feature risk.

## 4. Architecture overview

```
                 Microsoft Graph (shared mailbox per vendor)
                   │  ▲                         ▲
   change notif.   │  │ delta query / fetch     │ sendMail / createReply
   (webhook)       ▼  │                         │
        ┌──────────────────────────┐   ┌────────────────────────┐
        │ emailSyncService         │   │ emailSendService       │
        │  - webhook handler       │   │  - createReply→draft   │
        │  - delta reconcile       │   │  - footer + x-aab-ref  │
        │  - upsert threads/msgs   │   │  - attribute sender    │
        └────────────┬─────────────┘   └───────────┬────────────┘
                     │                              │
            ┌────────▼──────────────────────────────▼─────────┐
            │  oe.EmailThreads / oe.EmailMessages /            │
            │  oe.EmailAttachments  (+ oe.EmailMailboxSync)    │
            └────────┬─────────────────────────────┬──────────┘
                     │ on link / on new msg in linked thread
                     ▼                              ▼
            oe.Encounters (1 per message)   historyTimelineService
                     │                              │
                     └──────────► Case / SR History timeline ◄──┘

  Frontend: /vendor/inbox  →  ThreadListRail · ThreadReader · ComposeReply
                               · LinkToCaseSR · [Phase 2] EmailAiAssistPanel
```

Two background jobs (Azure Functions, existing pattern): **subscription renewal** (Graph subscriptions expire ≤7 days) and **delta reconcile** (gap recovery + initial seed).

## 5. Data model

All tables carry `VendorId` and are filtered through the standard tenant/vendor scoping. New tables:

### `oe.EmailThreads` — one row per Graph conversation per vendor
| Column | Type | Notes |
|---|---|---|
| `ThreadId` | UNIQUEIDENTIFIER PK | our id |
| `VendorId` | UNIQUEIDENTIFIER | scope |
| `ConversationId` | NVARCHAR(512) | Graph `conversationId`; unique per vendor |
| `Subject` | NVARCHAR(998) | latest/normalized subject |
| `MemberId` | UNIQUEIDENTIFIER NULL | resolved/linked member |
| `CaseId` | UNIQUEIDENTIFIER NULL | linked case |
| `ShareRequestId` | UNIQUEIDENTIFIER NULL | linked share request |
| `Participants` | NVARCHAR(MAX) | JSON array of {name,address} |
| `FirstMessageAt` | DATETIME2 | |
| `LastMessageAt` | DATETIME2 | drives sort |
| `LastDirection` | NVARCHAR(10) | `inbound`/`outbound` → pill derivation |
| `MessageCount` | INT | cached |
| `UnreadCount` | INT | cached |
| `NeedsReply` | BIT | cached: last message inbound & unanswered |
| `AssignedToUserId` | UNIQUEIDENTIFIER NULL | optional thread owner (mirrors encounters) |
| `IsArchived` | BIT | soft hide |
| audit | `CreatedDate/By`, `ModifiedDate/By` | |

Indexes: `(VendorId, LastMessageAt DESC)`, `(VendorId, NeedsReply) WHERE NeedsReply=1`, `(ShareRequestId) WHERE ShareRequestId IS NOT NULL`, `(CaseId) WHERE CaseId IS NOT NULL`, unique `(VendorId, ConversationId)`.

### `oe.EmailMessages` — one row per Graph message
| Column | Type | Notes |
|---|---|---|
| `EmailMessageId` | UNIQUEIDENTIFIER PK | our id |
| `ThreadId` | UNIQUEIDENTIFIER FK | → EmailThreads |
| `VendorId` | UNIQUEIDENTIFIER | scope |
| `GraphMessageId` | NVARCHAR(512) | **immutable id** (`Prefer: IdType="ImmutableId"`), unique |
| `GraphConversationId` | NVARCHAR(512) | |
| `InternetMessageId` | NVARCHAR(998) | RFC 2822 Message-ID |
| `Direction` | NVARCHAR(10) | `inbound`/`outbound` |
| `FromAddress` / `FromName` | NVARCHAR | |
| `ToAddresses` / `CcAddresses` | NVARCHAR(MAX) | JSON |
| `Subject` | NVARCHAR(998) | |
| `BodyHtml` | NVARCHAR(MAX) | sanitized on render |
| `BodyPreview` | NVARCHAR(512) | list snippet |
| `ReceivedAt` / `SentAt` | DATETIME2 | |
| `IsRead` | BIT | mirrors Graph `isRead` |
| `HasAttachments` | BIT | |
| `SentByUserId` | UNIQUEIDENTIFIER NULL | internal sender (outbound) — **attribution** |
| `RefStamp` | NVARCHAR(50) NULL | value of `x-aab-ref` (e.g. `SR-2026-0123`) |
| `SendStatus` | NVARCHAR(20) NULL | outbound: `queued\|sent\|failed` |
| `SendError` | NVARCHAR(MAX) NULL | |
| audit | | |

Indexes: `(ThreadId, COALESCE(SentAt,ReceivedAt))`, unique `(VendorId, GraphMessageId)`.

### `oe.EmailAttachments`
`AttachmentId` PK, `EmailMessageId` FK (ON DELETE CASCADE), `FileName`, `MimeType`, `FileSize`, `BlobUrl`, `BlobPath`, `GraphAttachmentId`, `IsInline` BIT, `ContentId`, audit. Mirrors `oe.EncounterAttachments` / `oe.CaseDocuments` (Azure Blob).

### `oe.EmailMailboxSync` — Graph sync state per vendor
`VendorId` PK, `SubscriptionId`, `SubscriptionExpiresAt`, `DeltaLink` NVARCHAR(MAX), `LastWebhookAt`, `LastPollAt`, `SyncStatus`, `LastError`. Keeps Graph plumbing out of `oe.Vendors`.

### `oe.Encounters` — additions
- `'email'` joins the `Source` set (`manual\|zoom_phone\|zoom_meeting\|imported\|email`). `Source` has **no DB CHECK constraint** (app-enforced), so this needs no DDL.
- Add nullable `EmailMessageId` (FK → `oe.EmailMessages`, indexed). **This is the single canonical encounter↔message link** — there is deliberately no reverse `EncounterId` column on `oe.EmailMessages` (that would be a circular FK). To find a message's encounter, query `oe.Encounters WHERE EmailMessageId = …`.
- For dedup/consistency with the Zoom pattern, email encounters also set `Channel='email'`, `Source='email'`, and `ExternalRef = GraphMessageId` (reuses the existing `IX_Encounters_Source_ExternalRef` index for idempotency checks).

## 6. Microsoft Graph integration

Authoritative API notes captured during research; constraints that shape the build:

- **Access model:** application permissions + client-credentials (already used by `graphEmailService`). Address the mailbox as `/users/{sharedMailbox}/...`.
- **Single-mailbox scoping (security, blocker B-002):** application `Mail.Read`/`Mail.Send`/`Mail.ReadWrite` grant tenant-wide mailbox access by default. Must scope to the one shared mailbox via **RBAC for Applications** (preferred) or `ApplicationAccessPolicy`. Remove any org-wide Entra grant or the union stays unscoped.
- **Inbound — webhooks:** `POST /subscriptions` on `users/{mailbox}/mailFolders('inbox')/messages`, `changeType=created`. Subscriptions on shared folders require **application** `Mail.Read` (delegated `Mail.Read.Shared` cannot subscribe). Max life ~7 days → renewal job. **Lean notifications** (no `resourceData`) to avoid managing an encryption cert; on notify we fetch the message by id. Webhook endpoint must answer the validation handshake in ≤10s and ack notifications with `202` in ≤3s (queue then process).
- **Inbound — delta:** `…/messages/delta` persisted `@odata.deltaLink` seeds initial state and recovers `missed`/`subscriptionRemoved` gaps.
- **Threads:** group by `conversationId` (spans Inbox + Sent). Fetch a thread via `$filter=conversationId eq '…'`, order client-side if needed.
- **Send / reply:** `createReply`/`createReplyAll` → returns a draft inheriting `conversationId` → `PATCH` body (inject footer) → `POST /send`. Requires `Mail.ReadWrite`. Brand-new threads use `sendMail`.
- **Case/SR ref header:** custom `x-` headers (e.g. `x-aab-ref: SR-2026-0123`) can be set **only at creation**, are immutable after send, and are **not** auto-copied onto replies — so we stamp them on every outbound message ourselves. We also surface a human-visible `Ref: SR-2026-0123` in the subject/footer, and rely on `conversationId` as the durable correlation key.
- **Read/unread & tags:** `PATCH isRead`; Outlook `categories` can back our tags later (master list per mailbox).
- **Immutable IDs:** request `Prefer: IdType="ImmutableId"` so stored ids survive folder moves.
- **Throttling:** 4 concurrent ops / 10k per 10 min **per app+mailbox**. Coalesce reads (`$select`, delta), queue writes, one fetch per notification.

A thin `graphClient` wraps token acquisition, immutable-id preference, throttle/`Retry-After` handling, and request batching.

## 7. Sync engine

- `routes/webhooks/graph-email.js`: validation handshake; verify `clientState`; enqueue `{vendorId, messageId}`; return `202` immediately. Lifecycle events (`reauthorizationRequired`, `subscriptionRemoved`, `missed`) handled per Graph guidance (reauthorize/renew or trigger delta resync).
- `emailSyncService.ingestMessage()`: fetch by immutable id → upsert `EmailMessages` (idempotent on `GraphMessageId`) → upsert/refresh `EmailThreads` (recompute `LastMessageAt/Direction`, counts, `NeedsReply`) → if thread is linked, **create the encounter for this message** (idempotent on `ExternalRef`).
- `emailSubscriptionService`: create on vendor enable; **renewal job** (Azure Function timer) renews before expiry and writes `oe.EmailMailboxSync`.
- `emailReconcileService`: periodic delta sweep per vendor; seeds new mailboxes; closes webhook gaps.

## 8. Encounter linking semantics

- **Link unit = the thread.** Care-team links a thread to one Member + (Case and/or Share Request).
- **Auto-suggest** linking targets: match `FromAddress` → member → that member's open SRs/cases; plus any `SR-/CASE-` ref already in the subject. Suggestions are presented; **the care team confirms** — never automatic.
- On link (and for every subsequent message on a linked thread), create **one encounter per message**: `Channel='email'`, `Source='email'`, `Direction` from the message, `ExternalRef=GraphMessageId`, `EmailMessageId` set, `MemberId/CaseId/ShareRequestId` from the thread link, `Summary` = subject + preview, `OccurredAt` = sent/received time, `CreatedBy` = sender (outbound) or system (inbound). Idempotent.
- **History timeline:** because each message is an encounter, email appears in the existing chronological History interleaved with payments, forms, status changes, etc. The UI **groups consecutive same-thread email events**, but any non-email event between two emails breaks the group so true chronology is preserved (your requirement). Implemented in the timeline renderer, not the data model.
- Unlink removes the thread link and archives the auto-created encounters (soft).

## 9. Frontend (Phase 1)

New route `/vendor/inbox` (VendorAdmin/VendorAgent), added to `VendorNavigation.tsx`. Three-pane, Tailwind + Lucide, brand colors (`oe-primary`/`oe-dark`), matching `ShareRequestWorkspace`/`CaseWorkspace`.

- **`ThreadListRail`** — filterable list (All / Needs reply / Mine / Unlinked / Unread; search). Each row: from, subject, preview, time, pills.
- **`ThreadReader`** — message stack (collapsible quotes), attachments, read state, the **Ref** chip, link state, and the linking control.
- **`LinkToCaseSR`** — shows auto-suggested member/SR/case matches with confirm; manual search fallback.
- **`ComposeReply`** — reply/reply-all/new; reuses the existing `EmailEditor` block model where useful; shows the personal footer preview and the `Ref:` line before send; attachment upload (small inline; large via upload session).
- **Pills** (`EmailStatusPill`): Needs reply (amber), Awaiting customer (gray), Linked → SR-/CASE- chip (oe-light), Unread (dot).
- **`EmailAiAssistPanel`** — **Phase 2**, behind a feature flag; stubbed placeholder in Phase 1 so the slot exists. Placement in `haiku-assist-mockup.html`.

Services/hooks: `services/inbox.service.ts`, `hooks/vendor/useThreads.ts`, `useThread.ts`, `useSendReply.ts`, `useLinkThread.ts` (TanStack Query, per existing conventions).

## 10. Sending identity & footer

- Send **as the shared mailbox** (keeps threading and customer-facing identity consistent).
- Record `SentByUserId` on the message + encounter for "who sent what."
- **Footer** appended to outbound body, e.g.:
  > *— Jane from the Sharewell Care Team. Your request **SR-2026-0123** is being handled by a real person; just reply to this email and it comes straight to me.*
- **Ref**: `x-aab-ref` header on every outbound message + a visible `Ref: SR-2026-0123` so inbound replies are easy to correlate even if headers are stripped.
- Footer copy + sender display name are care-team decisions (blocker B-006).

## 11. Phase 2 — Haiku AI assist (sketch only)

When a thread is open, an **AI Assist** panel (right side of the thread reader, collapsible, feature-flagged) shows:
1. **Next-step tip** — e.g. *"Customer is asking for an itemized bill. To move SR-2026-0123 forward you still need the provider's itemized statement — request it or mark Awaiting Member Info."*
2. **Suggested reply** — a Haiku-drafted response grounded in the share request + thread, with **Insert into reply / Edit / Dismiss**. **Never auto-sends.**

Inputs: the thread, the linked SR/case (status, determination, bills, balance, outstanding requirements), and a process primer (what SR/case stages mean, what each waits on). Model: `claude-haiku-4-5`. Output is advisory; a care-team member always edits/approves and clicks send. Full design deferred; placement locked via the mockup to cut Phase-2 iterations.

## 12. Security & compliance

- Every query filters by `VendorId`; reuse standard vendor scoping. No cross-vendor mailbox access.
- Graph app scoped to the single shared mailbox (B-002) — non-negotiable.
- Email bodies/attachments are **PHI**: blob storage encrypted, SAS URLs short-lived (mirror encounter attachments), access limited to the owning vendor's care team.
- `clientState` secret on subscriptions; webhook validates it. Secrets stay in env/`oe.Vendors` (encrypted), rotated per B-007.

## 13. Testing

- **Backend (Jest):** sync upsert idempotency (duplicate `GraphMessageId`), thread aggregation/`NeedsReply` derivation, encounter-per-message creation + idempotency, send-reply footer/ref injection, webhook validation + `clientState` rejection, lifecycle → delta resync. Graph mocked.
- **Frontend (Vitest):** pill derivation, list filters, link auto-suggest selection, compose footer/ref preview.
- **Cypress:** inbox list → open thread → reply (stubbed Graph via `cy.intercept`, **no real sends**) → link to SR → encounter appears in History. Per project rules, never hit real send endpoints.

## 14. Phasing

- **Phase 1 (this branch):** §5–§10, §12–§13. Ship to Sharewell.
- **Phase 2:** §11 AI assist.
- **Phase 3+:** see `features.md`.

## 15. Open questions

1. Footer wording + sender display-name convention (B-006).
2. Confirm the production shared mailbox address(es) for Sharewell (B-005).
3. Whether to also auto-create an *unlinked* encounter for inbound mail before linking, or only after linking (current design: only after linking; unlinked mail lives in the inbox until triaged).
4. Thread assignment (owning care member) in Phase 1 vs Phase 3 (table supports it; UI optional now).

# Back Office Email — Feature Backlog

Companion to [`design.md`](./design.md). Phase 1 is the committed scope; later phases are a prioritized vision, not commitments.

## Phase 1 — Foundation (this branch)

- [ ] New unified store: `oe.EmailThreads`, `oe.EmailMessages`, `oe.EmailAttachments`, `oe.EmailMailboxSync`.
- [ ] Drop empty `oe.ShareRequestEmails`; retire orphaned `EmailLogTab` + per-SR `/emails/*` endpoints; re-point `historyTimelineService`.
- [ ] `oe.Encounters`: add `Source='email'` + nullable `EmailMessageId`.
- [ ] `graphClient` (token, immutable-id, throttle/Retry-After, batching).
- [ ] Inbound webhooks: subscription create + validation handshake + `clientState` + lifecycle handling.
- [ ] Inbound delta reconcile (seed + gap recovery).
- [ ] Subscription renewal job (Azure Function timer).
- [ ] `emailSyncService.ingestMessage` — idempotent thread/message upsert + derived counts/`NeedsReply`.
- [ ] `emailSendService` — `createReply`→draft→send as shared mailbox, footer, `x-aab-ref`, sender attribution.
- [ ] Encounter-per-message on linked threads (idempotent).
- [ ] `/vendor/inbox` 3-pane UI: ThreadListRail, ThreadReader, ComposeReply.
- [ ] Link-to-SR/Case with **auto-suggested** member/SR/case match + manual fallback.
- [ ] Derived pills: Needs reply / Awaiting customer / Linked (SR-/CASE- chip) / Unread.
- [ ] History timeline shows email events chronologically, grouping consecutive same-thread emails.
- [ ] Attachments: read + send (small inline; large via upload session); Azure Blob + short SAS.
- [ ] Mark read/unread.
- [x] **Compose new email from scratch** — shared `ComposeNewModal` (member picker + editable address, optional SR/Case link). Entry points: Inbox rail "New", Share Request detail "Email member", Case detail "Email member". Backend `POST /inbox/compose` (create draft → send → record thread + outbound message + link + encounter) and `GET /inbox/member-link-options`.
- [ ] Tests: Jest (sync/send/webhook), Vitest (pills/link), Cypress (inbox→reply→link→history, stubbed).

## Phase 2 — Haiku AI assist (fast-follow)

- [ ] AI Assist panel slot in ThreadReader (feature-flagged) — placement locked in `haiku-assist-mockup.html`.
- [ ] **Next-step tip**: read linked SR/case + thread → what the case is waiting on, what the care team should do next.
- [ ] **Suggested reply**: Haiku draft grounded in SR/case + thread; Insert / Edit / Dismiss; **never auto-send**.
- [ ] Process primer / grounding: SR & case stage definitions, what each status waits on.
- [ ] Model `claude-haiku-4-5`; prompt-cache the process primer.
- [ ] Guardrails: every send is human-edited/approved; log AI suggestions vs. what was actually sent (training signal).

## Phase 3+ — Email-client depth (prioritized vision)

- [ ] Thread assignment to a care member (table already supports `AssignedToUserId`); "assigned to me" filter.
- [ ] Internal-only notes on a thread (not emailed).
- [ ] Saved replies / canned responses (reuse `oe.MessageTemplates` + merge tokens) inside compose.
- [ ] Per-user signatures layered above the team footer.
- [ ] Full-text search across threads/messages.
- [ ] Folders / labels backed by Outlook `categories` as tags.
- [ ] Bulk actions (mark read, link, archive).
- [ ] SLA / response timers ("oldest unanswered", overdue badges) — feeds dashboard.
- [ ] "Convert email to Case" (mirror encounter `convert-to-case`).
- [ ] Spam/junk handling; out-of-office detection.
- [ ] Read/open tracking where available.
- [ ] Merge/split threads (mis-thread correction).
- [ ] Multiple shared mailboxes per vendor.
- [ ] Historical Outlook backfill (optional one-time import).

## AI long-game (beyond Phase 2, captured for direction)

The end state is an AI with a complete, structured picture of every share request and case — what happened, what it is waiting on (customer approval, back-office action, a specific document), and the ability to resolve routine cases under supervision. Phase 1 exists largely to **capture that data cleanly**: every communication as an attributed, linked encounter. Each later capability (next-step tips → suggested replies → triage classification → supervised resolution) should add structured signal, not just UI.

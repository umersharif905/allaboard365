# Back Office Email — Migration Tracker

**Purpose:** every migration applied to `allaboard-testing` for this feature must also be applied to **production** when this branch merges. This list gets copied to the **top of the PR comment** as the prod migration checklist.

Legend: ☐ not written · ✍️ written · 🧪 applied to testing · 🚀 applied to prod

| Order | File (`sql-changes/…`) | What it does | Testing | Prod |
|------:|------------------------|--------------|:------:|:----:|
| 1 | `2026-06-02-email-store.sql` | Create `oe.EmailThreads`, `oe.EmailMessages`, `oe.EmailAttachments`, `oe.EmailMailboxSync` | 🧪 2026-06-02 | 🚀 2026-06-04 |
| 2 | `2026-06-02-encounters-email-source.sql` | Add nullable `oe.Encounters.EmailMessageId` FK → `oe.EmailMessages` + index (`'email'` Source value needs no DDL — no CHECK constraint) | 🧪 2026-06-02 | 🚀 2026-06-04 |
| 3 | `2026-06-02-drop-sharerequest-emails.sql` | Drop empty `oe.ShareRequestEmails` (dry-run default). **Run LAST**, after code stops reading it and row count re-confirmed 0. | 🧪 2026-06-02 | ⏸️ DEFERRED — run only **after this branch deploys to prod** (old prod code may still read the table; it's empty so no rush) |
| 4 | `2026-06-03-email-thread-suggestion-dismissed.sql` | Add `oe.EmailThreads.MatchSuggestionDismissed BIT` (persists a "Deny" on a suggested member match) | 🧪 2026-06-03 | 🚀 2026-06-04 |
| 5 | `2026-06-03-email-thread-presence.sql` | Create `oe.EmailThreadPresence` (per-user viewing/replying presence); drops the superseded `ReplyingBy*` columns | 🧪 2026-06-03 | 🚀 2026-06-04 |
| 6 | `2026-06-03-users-email-signature.sql` | Add `oe.Users.EmailSignature NVARCHAR(MAX)` (per-user Back Office email footer) | 🧪 2026-06-03 | 🚀 2026-06-04 |
| 7 | `2026-06-03-users-email-card.sql` | Add `oe.Users.EmailCard NVARCHAR(MAX)` (JSON ShareWELL signature-card config) | 🧪 2026-06-03 | 🚀 2026-06-04 |

> Notes:
> - **2026-06-04:** the 6 additive migrations (1, 2, 4, 5, 6, 7) were applied to **`allaboard-prod`** via `run-sql-file.cjs` — each verified (tables created / `ColumnExists = 1`). The email tables sit unused on prod until this branch deploys.
> - **#3 (drop `ShareRequestEmails`) is intentionally NOT YET applied to prod.** It's the "contract" step: run it only after this branch is live on prod so the old code can't reference the dropped table. Confirmed empty (0 rows) on prod 2026-06-04.
> - **Thread ownership** (`oe.EmailThreads.AssignedToUserId`) needs **no** migration — the column shipped in migration #1 (`email-store.sql`).
> - Migrations applied via `ai_scripts/run-sql-file.cjs` inside the backend container (splits on `GO`).

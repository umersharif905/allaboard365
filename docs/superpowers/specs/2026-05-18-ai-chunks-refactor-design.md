# AI Chunks Refactor — Design Spec

**Date:** 2026-05-18
**Branch:** `feat/website-agent-routing` (working branch; final implementation will branch off `staging`)
**Author:** Joey Desai (via Claude brainstorming session)
**Companion spec:** [2026-05-18-member-portal-columbus-widget-design.md](2026-05-18-member-portal-columbus-widget-design.md)

## Summary

Replace the current "humans paste text blobs into the product wizard" approach to AI chunks with an **automated extraction pipeline** driven by uploaded plan documents. Add **first-class FAQ chunks** (question + answer pairs) and a clear **manual-overrides-AI** training loop so support staff can correct bad answers and have Columbus prefer their wording going forward.

Columbus itself barely changes — its system prompt is updated to honor the new chunk metadata, but the `/api/columbus/chat` endpoint, the auth model, and the existing per-member plan scoping all remain as-is.

---

## Goals

1. **Auto-generate chunks from uploaded product documents** so platforming a new plan doesn't require an admin hand-authoring chunks.
2. **Surface member-shaped FAQs** (question/answer pairs) instead of only free-form prose, because that's the dominant shape of real member queries.
3. **Make extraction member-question-driven**, not document-summary-driven — the LLM walks a canonical checklist of "what an active member needs to know" and answers each from the document text.
4. **Preserve a human training loop**: when Columbus gives a bad answer, support writes a manual FAQ chunk and Columbus prefers it from then on.
5. **No regressions** for existing chunks: every chunk authored today continues to behave identically after the migration.

## Non-Goals

- Embedding-based retrieval / vector search. Columbus today sends all chunks for the member's enrolled products into Claude Haiku 4.5's 1M-token context. We keep that pattern.
- Topic-tag-based "hiding" of AI chunks when a manual chunk overlaps. Override is enforced by **system-prompt instructions to the LLM**, not by retrieval-time filtering. (See "Override semantics" below.)
- Member portal chat widget. See companion spec.
- Mobile app Columbus migration. Separate future project.
- Multi-document deduplication (same fact mentioned in two PDFs). Acceptable to have near-duplicates; manual cleanup if it becomes a problem.
- Versioning / history of extraction runs. Each document has one current state.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  PRODUCT WIZARD (frontend) — Step 9                                  │
│  [AI Knowledge] [FAQs] [Manual Notes]                                │
│  uploads docs → reads chunks → shows extraction status               │
└────────┬─────────────────────────────────┬───────────────────────────┘
         │ uploads PDF/DOCX/TXT             │ reads chunks
         ▼                                  │
┌──────────────────────┐                   │
│  Azure Blob Storage  │                   │
│  oe.ProductDocuments │                   │
└──────┬───────────────┘                   │
       │ doc upload route enqueues msg     │
       ▼                                   │
┌──────────────────────────────────────┐   │
│  Service Bus queue: ai-extract-queue │   │
│  msg: { productDocumentId, productId,│   │
│        tenantId, blobUrl }            │   │
└──────┬───────────────────────────────┘   │
       │ queue trigger                     │
       ▼                                   │
┌──────────────────────────────────────┐   │
│  ai-extraction-jobs (new Func app)    │   │
│  1. SET status='running'              │   │
│  2. Download blob → extract text      │   │
│     (pdf-parse / mammoth / fs.read)   │   │
│  3. Call Claude Haiku 4.5 with        │   │
│     member-question-driven prompt     │   │
│     → { prose[], faqs[] }             │   │
│  4. INSERT chunks with Source='ai',   │   │
│     SourceDocumentId=<doc>             │   │
│  5. SET status='completed'             │   │
└──────┬───────────────────────────────┘   │
       │ writes                             │
       ▼                                    │
┌──────────────────────────────────────────┴────────────────────────────┐
│  oe.AIChunks (extended)                                                │
│  + ChunkType (prose|faq), Source (ai|manual),                          │
│    SourceDocumentId, Question, Title                                    │
└────────┬────────────────────────────────────────────────────────────────┘
         │ pulled by Columbus per request via /api/ai/chunks
         ▼
┌──────────────────────────────────────────┐
│  Columbus API (existing service)         │
│  System prompt updated: manual chunks    │
│  marked AUTHORITATIVE, FAQs rendered as  │
│  Q/A pairs, AI prose as REFERENCE.        │
└──────────────────────────────────────────┘
```

---

## Data Model

### `oe.AIChunks` — extended

| Column | Type | Status | Purpose |
|---|---|---|---|
| AIChunkId | uniqueidentifier PK | existing | unchanged |
| ProductId | uniqueidentifier | existing | unchanged |
| TenantId | uniqueidentifier | existing | unchanged |
| SystemArea | nvarchar | existing | unchanged |
| `ChunkText` | nvarchar(max) | **renamed from `ChunkData`** | prose body, or FAQ answer |
| `ChunkType` | nvarchar(16) NOT NULL | **NEW** | `'prose'` \| `'faq'` |
| `Source` | nvarchar(8) NOT NULL | **NEW** | `'ai'` \| `'manual'` |
| `SourceDocumentId` | uniqueidentifier NULL | **NEW** | FK to `oe.ProductDocuments.ProductDocumentId`; null for manual |
| `Question` | nvarchar(1000) NULL | **NEW** | set only when `ChunkType='faq'` |
| `Title` | nvarchar(200) NULL | **NEW** | short label for the AI Knowledge tab list |
| IsActive | bit | existing | unchanged |
| Status | nvarchar | existing | unchanged |
| CreatedDate, CreatedBy | datetime2/uniqueidentifier | existing | unchanged |
| ModifiedDate, ModifiedBy | datetime2/uniqueidentifier | existing | unchanged |
| AgentId, MemberId | uniqueidentifier NULL | existing | unchanged |

Index: `IX_AIChunks_ProductId_Source_ChunkType` covering `(ProductId, Source, ChunkType)` to support per-product retrieval grouped by source.

### `oe.ProductDocuments` — extended (extraction state lives here, not a new table)

| Column | Type | Status | Purpose |
|---|---|---|---|
| ExtractionStatus | nvarchar(16) NULL | **NEW** | `'queued'` \| `'running'` \| `'completed'` \| `'failed'`; null = never extracted |
| ExtractionStartedAt | datetime2 NULL | **NEW** | when the Function picked up the message |
| ExtractionCompletedAt | datetime2 NULL | **NEW** | success or failure timestamp |
| ExtractionError | nvarchar(max) NULL | **NEW** | populated only on `'failed'` |
| ExtractionChunkCount | int NULL | **NEW** | total chunks produced by the last successful run |

### Migration SQL

```sql
-- 1. Add columns to oe.AIChunks
ALTER TABLE oe.AIChunks
  ADD ChunkType nvarchar(16) NULL,
      Source nvarchar(8) NULL,
      SourceDocumentId uniqueidentifier NULL,
      Question nvarchar(1000) NULL,
      Title nvarchar(200) NULL;

-- 2. Rename ChunkData -> ChunkText
EXEC sp_rename 'oe.AIChunks.ChunkData', 'ChunkText', 'COLUMN';

-- 3. Backfill all existing rows as manual prose
UPDATE oe.AIChunks SET ChunkType = 'prose', Source = 'manual' WHERE ChunkType IS NULL;

-- 4. Tighten constraints
ALTER TABLE oe.AIChunks ALTER COLUMN ChunkType nvarchar(16) NOT NULL;
ALTER TABLE oe.AIChunks ALTER COLUMN Source nvarchar(8) NOT NULL;
ALTER TABLE oe.AIChunks
  ADD CONSTRAINT FK_AIChunks_SourceDocument
      FOREIGN KEY (SourceDocumentId)
      REFERENCES oe.ProductDocuments(ProductDocumentId);

CREATE INDEX IX_AIChunks_ProductId_Source_ChunkType
  ON oe.AIChunks(ProductId, Source, ChunkType);

-- 5. Add columns to oe.ProductDocuments
ALTER TABLE oe.ProductDocuments
  ADD ExtractionStatus nvarchar(16) NULL,
      ExtractionStartedAt datetime2 NULL,
      ExtractionCompletedAt datetime2 NULL,
      ExtractionError nvarchar(max) NULL,
      ExtractionChunkCount int NULL;
```

Backwards compatibility: any code reading `ChunkData` must be updated to read `ChunkText`. Grep results (see /backend/routes/ai-chunks.js, /backend/routes/products.js, frontend types) identify ~6 touch points.

---

## Document Extraction Pipeline

### New Azure Function app: `ai-extraction-jobs/`

Sibling to `enrollment-jobs/`, `vendor-jobs/`, `product-api-jobs/`. Owns:
- one queue-triggered function `extractProductDocument`
- `package.json` with `pdf-parse`, `mammoth`, `@anthropic-ai/sdk`, `mssql`
- `host.json`, `local.settings.json.example`, deploy script following the existing pattern

### Trigger: Service Bus queue `ai-extract-queue`

The backend route that uploads a document (existing route under `/backend/routes/products.js` or its successor) is updated to enqueue a message **after** the doc row + blob are committed:

```js
await serviceBus.send('ai-extract-queue', {
  productDocumentId,
  productId,
  tenantId,
  blobUrl,
  fileName,
  contentType,
});
await db.query(`UPDATE oe.ProductDocuments
                SET ExtractionStatus='queued'
                WHERE ProductDocumentId=@id`, { id: productDocumentId });
```

### Function logic (sketch)

```js
module.exports = async function (context, message) {
  const { productDocumentId, productId, tenantId, blobUrl, contentType } = message;

  // Idempotency guard
  const doc = await db.query(`SELECT ExtractionStatus FROM oe.ProductDocuments
                              WHERE ProductDocumentId=@id`, { id: productDocumentId });
  if (!doc || doc.ExtractionStatus === 'running' || doc.ExtractionStatus === 'completed') return;

  await db.query(`UPDATE oe.ProductDocuments
                  SET ExtractionStatus='running', ExtractionStartedAt=GETUTCDATE()
                  WHERE ProductDocumentId=@id`, { id: productDocumentId });

  try {
    const buf = await downloadBlob(blobUrl);
    const text = await extractText(buf, contentType);   // pdf-parse / mammoth / utf-8
    const { prose, faqs } = await callClaudeForChunks(text);

    await db.transaction(async (tx) => {
      // Delete any previous AI chunks for this doc (idempotent regenerate)
      await tx.query(`DELETE FROM oe.AIChunks
                      WHERE SourceDocumentId=@id AND Source='ai'`,
                      { id: productDocumentId });

      for (const p of prose) {
        await tx.query(`INSERT INTO oe.AIChunks
                          (AIChunkId, ProductId, TenantId, SystemArea,
                           ChunkText, ChunkType, Source, SourceDocumentId,
                           Title, IsActive, Status, CreatedDate)
                        VALUES (NEWID(), @productId, @tenantId, 'Product',
                                @text, 'prose', 'ai', @docId,
                                @title, 1, 'Active', GETUTCDATE())`,
                       { productId, tenantId, text: p.text, title: p.title, docId: productDocumentId });
      }
      for (const f of faqs) {
        await tx.query(`INSERT INTO oe.AIChunks
                          (AIChunkId, ProductId, TenantId, SystemArea,
                           ChunkText, ChunkType, Source, SourceDocumentId,
                           Question, IsActive, Status, CreatedDate)
                        VALUES (NEWID(), @productId, @tenantId, 'Product',
                                @answer, 'faq', 'ai', @docId,
                                @question, 1, 'Active', GETUTCDATE())`,
                       { productId, tenantId, answer: f.answer, question: f.question, docId: productDocumentId });
      }

      await tx.query(`UPDATE oe.ProductDocuments
                      SET ExtractionStatus='completed',
                          ExtractionCompletedAt=GETUTCDATE(),
                          ExtractionChunkCount=@count,
                          ExtractionError=NULL
                      WHERE ProductDocumentId=@id`,
                     { id: productDocumentId, count: prose.length + faqs.length });
    });
  } catch (err) {
    await db.query(`UPDATE oe.ProductDocuments
                    SET ExtractionStatus='failed',
                        ExtractionCompletedAt=GETUTCDATE(),
                        ExtractionError=@err
                    WHERE ProductDocumentId=@id`,
                   { id: productDocumentId, err: String(err).slice(0, 2000) });
    throw err;   // surface to queue for retry / DLQ
  }
};
```

Service Bus retry policy: 3 attempts with exponential backoff, then DLQ. The `'failed'` status surfaces in the wizard with a Retry button that re-enqueues.

### Extraction prompt

The Function calls Claude Haiku 4.5 with `response_format: { type: "json_object" }` and the following prompt (the actual `instructions.md` will live in `ai-extraction-jobs/prompts/extraction.md`, version-controlled):

```
You are building a knowledge base so an AI assistant can answer questions
from an ACTIVE plan member. The member already has the plan — they're not
shopping. Generate chunks that answer the questions they will actually
have, day to day.

Canonical member questions to answer (if the document covers them):

  Getting started
  - How do I access my plan / log in / use the app?
  - Where is my ID card and how do I show it?
  - Who do I contact for help, and how (phone, portal, email)?

  Using care
  - What do I do when I go to the doctor / urgent care / ER?
  - What's my copay or unshared amount for each visit type?
  - What's my deductible / out-of-pocket maximum?
  - Can I see my own doctor / a specialist / out of network?
  - How do prescriptions work? Pharmacy network? Mail order?
  - What about telehealth?

  Money & claims
  - How do I submit a bill or claim?
  - How long do reimbursements take?
  - What's covered vs. what isn't?
  - How do pre-existing conditions work on this plan?

  Life events
  - How do I add a spouse, child, or dependent?
  - What if I move?
  - When does coverage start / end?

  Care scenarios
  - What if I need surgery?
  - What if I'm pregnant?
  - What if I have a chronic condition?

Plus any additional questions the document strongly implies a member
would ask, and any other important information from the document worth
knowing even if a member wouldn't directly ask about it.

Produce JSON:
{
  "faqs": [
    { "question": "<the member's question in plain language>",
      "answer":   "<direct answer drawn from the document, 30–200 words,
                   include specific dollar amounts, percentages, phone
                   numbers, URLs from the doc when present>" }
  ],
  "prose": [
    { "title": "<short topic label, 5-8 words>",
      "text":  "<self-contained 80–300 word explanation; use for important
                content a member should know but wouldn't phrase as a
                question (coverage tiers, glossary terms, plan structure)>" }
  ]
}

Rules:
- Answer ONLY from the document content. If the document doesn't cover a
  canonical question, omit it. Do not guess, do not invent numbers.
- Quote specific values (copays, deductibles, phone numbers, URLs) exactly
  as they appear in the document.
- Member is reading the answer — write in second person ("you"),
  conversational, not formal.
- Aim for 10–25 FAQs and 3–10 prose chunks per document.
```

### Cost & timing

- Haiku 4.5: input $0.80/M tokens, output $4/M tokens.
- Typical 20-page plan brochure: ~15K tokens in, ~3K tokens out = **~$0.025 per document**.
- End-to-end latency target: <60 seconds for typical docs; queue-driven so user never waits.

### Document support matrix

| Type | MIME | Extractor | First release |
|---|---|---|---|
| PDF | `application/pdf` | `pdf-parse` | ✓ |
| DOCX | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `mammoth` | ✓ |
| TXT | `text/plain` | `fs.readFile` (utf-8) | ✓ |
| XLSX, images, etc. | — | — | rejected with `ExtractionError='Unsupported file type'` |

---

## Override Semantics

When Columbus assembles its context for a chat request:

1. Pull all chunks for the member's enrolled products via existing `POST /api/ai/chunks` (now returns the new fields).
2. Group by `Source`:
   - **Manual chunks** (`Source='manual'`) → render first, under a heading `=== AUTHORITATIVE KNOWLEDGE (use this verbatim when it answers the question) ===`
     - FAQ rows render as `Q: <Question>\nA: <ChunkText>`
     - Prose rows render as `<Title>\n<ChunkText>`
   - **AI chunks** (`Source='ai'`) → render second, under `=== REFERENCE MATERIAL (use for context; defer to authoritative knowledge above) ===`
3. System prompt addition (appended to Columbus's existing prompt in `columbus-api/services/chat.js`):

```
Some knowledge in your context is marked AUTHORITATIVE — it was written
by human support staff specifically to answer member questions. When the
member's question matches authoritative content, use that answer; do not
contradict it with reference material. Reference material is for filling
in supporting detail only.
```

This avoids needing an embedding store, topic tags, or retrieval-time filtering. The LLM does the matching at inference time, which Haiku 4.5 handles reliably for context this small.

---

## Wizard UX

### Step 9 component tree

```
Step9AIChunks.tsx                  — orchestrator, tab state, document polling
├── ExtractionStatusBanner.tsx     — per-document badges (queued/running/completed/failed + retry)
├── AIKnowledgeTab.tsx             — list of AI prose chunks grouped by source doc
│   └── EditChunkModal.tsx         — pencil → edit → on save, promote to manual
├── FAQsTab.tsx                    — collapsible Q/A cards (AI + manual mixed, manual sorts first)
│   └── EditFAQModal.tsx           — pencil → edit → on save, promote to manual if was AI
└── ManualNotesTab.tsx             — textareas, today's experience minus AI clutter
```

### Tab contents

**AI Knowledge tab**
- Group chunks by `SourceDocumentId`, show each group under a header `📄 <doc filename> — <ExtractionChunkCount> chunks · ✓ extracted <relative time>`
- Each chunk row: `▸ <Title>` (collapsible to show `ChunkText` preview) + pencil icon
- Per-doc actions: **Regenerate** (deletes that doc's AI chunks, re-enqueues), **Retry** (only when status=`failed`)
- Empty state: "Upload a product document on the Documents step to auto-generate AI knowledge."

**FAQs tab**
- All `ChunkType='faq'` chunks for the product (AI + manual mixed)
- Manual FAQs sort to the top within each grouping
- Each card: `Q: <Question>` (collapses to show answer) + `[AI]` or `[Manual]` badge + pencil
- **+ Add FAQ** button → modal with Question + Answer fields → creates `Source='manual'` row

**Manual Notes tab**
- `ChunkType='prose' AND Source='manual'` chunks
- Closest to today's Step9 UX: list + textarea editor
- **+ Add Note** → creates `Source='manual', ChunkType='prose'` row

### Cross-cutting

- Tab counts in headers: `AI Knowledge (18)`, `FAQs (12)`, `Manual Notes (3)`
- Top-level action: **Regenerate all from documents** — confirm dialog → DELETE every `Source='ai'` chunk for this product → re-enqueue every document → status banners light up
- Editing any AI chunk (Tab 1 or Tab 2 row with `[AI]` badge) → save creates new `Source='manual'` row with edited content, deletes the original AI row → confirmation popup: "This chunk is now a manual chunk and will be preserved across regenerations."
- Polling: `useProductDocuments(productId)` React Query hook with `refetchInterval: 3000` while any doc has status in `('queued', 'running')`; stops once all settle

### Migration of existing wizards

`Step9AIChunks.tsx` is replaced. The old single-textarea UX is gone. Existing products with manual chunks display them in the Manual Notes tab — same as today, just relocated.

---

## Backend API Changes

### `POST /api/ai/chunks` — response shape extended

Existing endpoint at `backend/routes/ai-chunks.js`. Response gains the new fields:

```json
{
  "chunks": [
    {
      "AIChunkId": "...",
      "ProductId": "...",
      "ChunkType": "prose" | "faq",
      "Source": "ai" | "manual",
      "Title": "Deductible explanation" | null,
      "Question": "How do I file a claim?" | null,
      "ChunkText": "...",
      "SourceDocumentId": "..." | null,
      "SystemArea": "Product",
      "CreatedDate": "2026-05-18T..."
    }
  ]
}
```

Columbus's chunk fetcher already POSTs to this endpoint — it picks up the new fields without code changes; only its prompt builder changes.

### `POST /api/products/:productId/documents/:documentId/regenerate-chunks` — NEW

Auth: SysAdmin or TenantAdmin (existing role middleware). Deletes `Source='ai'` chunks for that doc, sets status to `queued`, enqueues a new extraction message. Returns updated document record.

### `POST /api/products/:productId/chunks/regenerate-all` — NEW

Wipes all `Source='ai'` chunks for the product (manual untouched), re-queues every document for extraction.

### `GET /api/products/:id/documents` — extended

Existing endpoint adds the five new `Extraction*` columns to its response so the wizard banner can render without an extra fetch.

### `POST /api/products/:id/chunks` and `PUT /api/products/:id/chunks/:chunkId` — NEW / updated

CRUD for manual chunks and FAQ chunks from the new wizard tabs. These bypass the all-or-nothing wipe-and-reinsert pattern in current `PUT /api/products/:id`. Existing wizard save flows continue to work; the new tabs use these targeted endpoints for live editing without re-saving the whole product.

### Document upload route — UPDATED

After the existing INSERT into `oe.ProductDocuments` + blob commit, enqueue an extraction message and set `ExtractionStatus='queued'`. If Service Bus send fails, mark `'failed'` immediately with the error.

---

## Columbus Integration Changes

In `/Users/rova/Documents/Columbus The Navigating Turtle/columbus-api`:

1. **`services/chat.js`** — context-block builder updated to split chunks by `Source` and `ChunkType`, render manual first under AUTHORITATIVE heading, AI second under REFERENCE heading, FAQ rows formatted as `Q:/A:` pairs.
2. **System prompt** — append the "Some knowledge in your context is marked AUTHORITATIVE…" paragraph above.
3. No auth, endpoint, or chunk-fetch changes. The existing `/api/ai/chunks` call continues to return all chunks for the member's products; Columbus filters/groups them locally.
4. No model change. Claude Haiku 4.5 with prompt caching unchanged.

---

## Failure Modes & Edge Cases

| Scenario | Behavior |
|---|---|
| PDF parse fails | `ExtractionStatus='failed'`, error captured, wizard shows red badge + Retry |
| Claude API rate limited | Service Bus retry 3x w/ backoff; if exhausted → DLQ + `'failed'` |
| Claude returns invalid JSON | Caught, `'failed'` with error text; retry will hit a fresh LLM call (often resolves) |
| Document deleted before extraction runs | Function detects missing row at idempotency check, drops message |
| User clicks Regenerate while job in flight | Idempotency check: status='running' → drop the new message |
| Document is encrypted PDF / scanned image with no OCR text | `pdf-parse` returns empty string; Function marks `'failed'` with "No extractable text" |
| Two users hit Regenerate simultaneously | Second request's delete completes after first's INSERT — second wins; chunks ultimately reflect latest enqueue's run |
| Unsupported MIME type | Function fails fast with `ExtractionError='Unsupported file type: X'`; no LLM call attempted |
| Existing chunks from before migration | Marked `Source='manual'`, `ChunkType='prose'`, no `SourceDocumentId` — display in Manual Notes tab, work identically in Columbus |

---

## Testing Strategy

### Backend (Jest)

- `services/__tests__/extractionEnqueue.test.js` — doc upload route writes the queue message + sets `queued` status, and rolls back on Service Bus failure
- `routes/__tests__/ai-chunks.response.test.js` — `POST /api/ai/chunks` includes new fields for new-shaped rows and degrades cleanly for legacy rows
- `routes/__tests__/chunks-crud.test.js` — new manual chunk CRUD endpoints (auth, tenant isolation, validation)
- `routes/__tests__/regenerate-chunks.test.js` — regenerate-all and regenerate-doc endpoints delete only `Source='ai'`, re-enqueue, return updated docs

### `ai-extraction-jobs` (Jest)

- `__tests__/extractText.test.js` — `pdf-parse`, `mammoth`, and txt extraction with fixtures (small sample of each in `test-fixtures/`)
- `__tests__/extractionFunction.test.js` — mock Anthropic SDK + mssql, verify: status transitions, idempotency guard, transactional insert, error capture path
- `__tests__/claudePrompt.snapshot.test.js` — snapshot the prompt construction so accidental drift is caught in PRs

### Frontend (Vitest)

- `components/forms/steps/__tests__/Step9AIChunks.test.tsx` — tab navigation, badge counts
- `components/forms/steps/__tests__/AIKnowledgeTab.test.tsx` — edit-promotes-to-manual flow, regenerate confirmation, status banner rendering
- `components/forms/steps/__tests__/FAQsTab.test.tsx` — manual sorts first, add/edit flows
- `hooks/__tests__/useProductDocuments.test.ts` — polling enables while any doc is in-flight, stops when all settle

### Cypress

- `cypress/e2e/product-wizard/ai-chunks-extraction.cy.ts` — happy path: upload PDF → wait for status=completed (stub the Function via fixture) → see chunks in AI Knowledge tab → edit one → confirm promotion to Manual tab
- `cypress/e2e/product-wizard/ai-chunks-regenerate.cy.ts` — Regenerate all → existing AI chunks disappear → after stubbed completion, fresh chunks appear → manual chunks unchanged
- `cypress/e2e/product-wizard/ai-chunks-failure.cy.ts` — failed extraction → red badge → Retry → success

### Columbus integration

- Manual smoke test via the admin console at `/api/columbus/admin/`:
  1. Create a test product with a known plan PDF, wait for extraction
  2. Open admin console, switch to Authenticated mode with that product
  3. Ask a question matching a canonical FAQ → verify answer comes from the AI FAQ
  4. Write a manual FAQ chunk for that question with a different answer
  5. Ask again → verify the manual answer is returned (authoritative override works)

---

## Migration Plan

**Phase 1 — Schema (zero downtime)**
1. Run migration SQL in `sql-changes/` against staging then production. All adds are non-destructive, the `ChunkData → ChunkText` rename is the only breaking change for callers.
2. Deploy backend with both column names supported during transition? **No** — the rename is atomic; deploy a single backend that reads `ChunkText`, and update Columbus's `/api/ai/chunks` consumer to match in the same release.

**Phase 2 — Backend API extensions**
3. Ship `/api/ai/chunks` response shape additions (new fields, gracefully null for legacy rows).
4. Ship new chunk-CRUD and regenerate endpoints behind feature flag `aiChunksV2` (default off).

**Phase 3 — Extraction Function**
5. Deploy `ai-extraction-jobs/` Azure Function app. No traffic yet (no queue messages).
6. Wire the document-upload route to enqueue messages (behind same flag).

**Phase 4 — Wizard UX**
7. Ship new `Step9AIChunks.tsx` tabs behind `aiChunksV2`.
8. Internal QA: enable flag for our tenant, platform a test product with a real document end-to-end.

**Phase 5 — Columbus prompt update**
9. Update Columbus's system prompt + context builder.
10. Verify via admin console (manual smoke test above).

**Phase 6 — Rollout**
11. Enable `aiChunksV2` for all tenants.
12. Monitor extraction job success rate, LLM cost, and Columbus answer quality for a week.
13. Remove the feature flag once stable.

**No backfill of existing products** — they keep working with their current manual-marked chunks. Tenants can opt into AI extraction per product by uploading documents and clicking Regenerate.

---

## Open Items / Future Work

- **Vector retrieval** — if products grow to thousands of chunks, Claude's context may overflow. At that point, add an embedding index keyed on `AIChunkId` and switch Columbus to top-K retrieval. Out of scope here.
- **Multi-document dedup** — same fact present in two PDFs will produce two near-identical chunks. Acceptable today; revisit if it hurts answer quality.
- **Member-portal chat widget** — companion spec.
- **Mobile app Columbus migration** — separate future project (rip-and-replace OpenAI in `MightyWELL_Mobile/app/newPlatform/ai.tsx`).
- **Tenant-controlled extraction prompt** — different tenants may want different canonical questions. Defer; the universal prompt above is broad enough to start.

# Member Portal Columbus Chat Widget — Design Spec

**Date:** 2026-05-18
**Branch:** `feat/website-agent-routing` (working branch; final implementation will branch off `staging`)
**Author:** Joey Desai (via Claude brainstorming session)
**Companion spec:** [2026-05-18-ai-chunks-refactor-design.md](2026-05-18-ai-chunks-refactor-design.md)

## Summary

Add an authenticated, plan-aware Columbus chat widget to the AllAboard365 member portal. A member clicks a floating turtle button anywhere in the portal, gets a chat window, and asks questions that Columbus already knows how to answer in a plan-scoped way (because it pulls the member's enrolled products from `/api/me/member/enrollments` server-side).

This is **almost pure integration work** — Columbus's auth, plan-scoping, and chat endpoint already exist and are exercised by the MightyWELL marketing site today. We're lifting that widget pattern, swapping anonymous → authenticated, and dropping it into the member portal layout.

## Goals

1. Members can ask Columbus questions from inside the portal without leaving the app.
2. Answers are **automatically scoped to the member's enrolled plans** — no plan picker required.
3. Streaming responses (SSE) so answers appear word-by-word, matching the marketing site experience.
4. The two existing legacy chat widgets in the codebase (`ColumbusAIHelper.tsx`, `ChatWidget.tsx`) are removed — they call deprecated Azure endpoints and confuse the codebase.

## Non-Goals

- Chunks system changes. Covered in companion spec; quality of answers depends on that spec landing first.
- Mobile app Columbus migration. Future project.
- Multi-turn conversation persistence across sessions. Each chat opens fresh; conversation history exists only in component state, capped at the last 10 messages (matches marketing site).
- Admin / agent / tenant-admin chat experiences. The widget is members-only in this phase; existing tools they use (training UI, etc.) keep their current chat affordances or none, and any rollout to other roles is a follow-up.
- Reporting / flagging bad answers. Could add later; not in v1.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  AllAboard365 Member Portal (React SPA)                        │
│                                                                 │
│  Layout (MemberLayout.tsx)                                      │
│  └── <ColumbusChatWidget />        ← always mounted, FAB at BR │
│       ├── ColumbusFab.tsx          ← button + pulse ring        │
│       ├── ColumbusWindow.tsx       ← chat panel                 │
│       │    ├── ColumbusMessageList.tsx                          │
│       │    ├── ColumbusInput.tsx                                │
│       │    └── useColumbusChat(authToken) ← hook owns streaming │
│       └── styles in Tailwind (matches portal brand)             │
└──────────────────────────────┬─────────────────────────────────┘
                               │  POST /api/columbus/chat
                               │  Authorization: Bearer <member JWT>
                               │  body: { message, conversationHistory }
                               │  response: SSE stream of { token }
                               ▼
┌────────────────────────────────────────────────────────────────┐
│  Columbus API (existing, no changes)                            │
│   - validates JWT against /api/me/member/* on AllAboard365      │
│   - fetches enrolledProductIds                                   │
│   - filters chunks via /api/ai/chunks                            │
│   - streams Claude Haiku 4.5 response                            │
└────────────────────────────────────────────────────────────────┘
```

---

## Component Design

### `ColumbusChatWidget.tsx` (orchestrator)

Always mounted on the member layout. Owns:
- open/closed state (persisted to `localStorage` key `columbus.open`)
- one-time dismiss for the "Have questions?" tooltip (persisted to `localStorage` key `columbus.tooltipDismissed`)
- pulls the auth token from `AuthContext` and passes it to the chat hook

### `ColumbusFab.tsx`

Floating action button, fixed `bottom-6 right-6`, 64px circle, brand turtle avatar. Pulse ring animation on idle. On hover: small tooltip "Ask Columbus". On click: open `ColumbusWindow`.

Styled with Tailwind using brand colors per CLAUDE.md (`bg-oe-primary hover:bg-oe-dark`, no raw blues). Lucide `MessageCircle` or a custom turtle SVG asset for the icon.

### `ColumbusWindow.tsx`

420×600px panel, fixed `bottom-24 right-6` on desktop. Full-screen overlay on mobile (`<md:`). Header shows the turtle avatar + "Columbus" + status dot (online/offline based on health check). Close button.

Body: `ColumbusMessageList`. Footer: `ColumbusInput` with multiline textarea and send button.

Greeting message rendered as the first bubble when the window opens with no history:
> "Hi {firstName}! I'm Columbus. Ask me anything about your **{planName}** plan — coverage, copays, claims, anything."

(Plan name pulled from the member's enrollments via the existing `useMemberEnrollments` hook. Falls back to "your plan(s)" if more than one.)

### `useColumbusChat(authToken)` hook

The single point of contact with the Columbus API. Exposes:

```ts
interface UseColumbusChat {
  messages: Message[];
  isStreaming: boolean;
  isOnline: boolean;       // updated by health-check on mount
  sendMessage: (text: string) => Promise<void>;
  resetConversation: () => void;
}
interface Message { role: 'user' | 'assistant'; content: string; streaming?: boolean }
```

Implementation lifts the SSE parsing pattern from `mightywell-site/src/components/columbus/ColumbusWidget.jsx` (lines 215-291): `fetch` with stream body, manual `ReadableStream` reader, decode + buffer + split on `data: ` lines, parse JSON token per line, append to message content, mark `streaming: false` on `[DONE]`.

```ts
// Request
const res = await fetch(`${COLUMBUS_URL}/chat`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
  },
  body: JSON.stringify({
    message: text,
    conversationHistory: messages.slice(-10).map(m => ({ role: m.role, content: m.content })),
  }),
});
```

Conversation history cap: last 10 messages, matching the marketing site.

### Suggested prompts

Static three-prompt grid shown when the chat is empty (member hasn't typed anything yet):

- "What's my copay for a doctor visit?"
- "How do I submit a claim?"
- "What's covered if I need to see a specialist?"

Click a prompt → populates the input and sends.

(Marketing-site prompts are plan-shopping-oriented; these are member-oriented.)

---

## Configuration

### Frontend `config.json`

Add a new key `columbusUrl`. The AllAboard365 frontend already loads `/config.json` at startup via `services/config/api.ts` for runtime env vars. The widget reads `columbusUrl` (e.g. `https://mightywellhealth.com/api/columbus`) and never hard-codes the URL.

Build-time fallback: `import.meta.env.VITE_COLUMBUS_URL`. Default for local dev: same as production for now (no local Columbus instance).

### Health check

On widget mount, `GET ${columbusUrl}/health` (no auth required) to set `isOnline`. If offline, the FAB renders with a muted color and the window header shows "Offline — Columbus is unavailable". The input remains disabled.

---

## Authentication

The member portal already has an `AuthContext` exposing the access token used for AllAboard365 API calls. That same JWT validates against Columbus, because Columbus's auth middleware (in `columbus-api/middleware/auth.js`) calls back to AllAboard365's `/api/me/member/profile` + `/api/me/member/enrollments` to verify the token.

Token refresh on 401: if Columbus returns 401 mid-stream or on initial POST, the widget re-uses the existing token-refresh hook from `services/tokenManager.ts` (whatever the rest of the portal does), retries once, and surfaces an error message if the retry also fails.

CORS: Columbus already configures CORS for `mightywellhealth.com`. The deployment task includes adding `allaboard365.com` (and any test/staging origins) to Columbus's allowed origins list in `columbus-api/app.js`.

---

## Placement in Layout

The widget mounts in `MemberLayout.tsx` so it's available across every member-facing route (`/dashboard`, `/enrollments/*`, `/profile`, etc.). It is **not** rendered on:

- `/login`, `/signup`, `/forgot-password`, `/complete-enrollment`, `/enroll/*`, `/enroll-now/*` (pre-auth or one-shot flows)
- Any sysadmin / tenant-admin / agent / group-admin / vendor routes (these get separate consideration in a future spec)

Detection: the widget renders only when `AuthContext.user.userType === 'Member'` and the user has at least one active enrollment. Otherwise, the FAB is hidden.

---

## Removing Legacy Widgets

These two components currently exist in the frontend and must be deleted:

1. `frontend/src/components/ai/ColumbusAIHelper.tsx` — hits `https://ai-helper-func-app.azurewebsites.net/api/askai` with hardcoded product IDs `['45042', '45172', '45256']`. Used inside training flows (search for imports and replace with the new widget OR remove entirely depending on training UX decisions).
2. `frontend/src/components/ai/ChatWidget.tsx` — hits `https://oe-ai-helper-dth9buefenare8a9.eastus2-01.azurewebsites.net/api/ai/chat`. Used in various role layouts.

Step-by-step removal:
- Identify imports of each in the frontend (`grep "ColumbusAIHelper\|ChatWidget" frontend/src`).
- For Member-role usages: replace with `<ColumbusChatWidget />`.
- For Agent / TenantAdmin / SysAdmin / GroupAdmin / VendorAdmin usages: verify whether the legacy Azure endpoints (`ai-helper-func-app.azurewebsites.net/api/askai`, `oe-ai-helper-dth9buefenare8a9.eastus2-01.azurewebsites.net/api/ai/chat`) still respond successfully. If they're dead, the widgets are non-functional today — remove the imports as part of this cleanup. If they still respond, leave the imports in place; non-member chat experiences are out of scope for v1 and will get their own design once we decide Columbus's plan-scoping story for those roles (an agent might want chat scoped to their assigned members' plans, etc.).
- Delete the legacy component files only after confirming no remaining imports.
- The `ColumbusTrainingCallout.tsx` (separate file, used as a mascot in training UI) stays — it's not a chat client, just an animation.

---

## Backend Touch Points

Almost none — this is a frontend-only project. Specifically:

- **No changes to `/api/ai/chunks`** beyond what the companion chunks spec already covers.
- **No changes to AllAboard365 auth.** Columbus already validates against the existing `/api/me/member/*` endpoints.
- **CORS update on Columbus** (in the `columbus-api` repo, not AllAboard365): add `allaboard365.com` and staging origins to allowed-origins.

---

## Testing Strategy

### Vitest

- `components/columbus/__tests__/ColumbusFab.test.tsx` — renders, opens window on click, hidden when user not a member, hidden when no enrollments
- `components/columbus/__tests__/ColumbusWindow.test.tsx` — greeting includes first name + plan name, offline state disables input
- `components/columbus/__tests__/useColumbusChat.test.ts` — mocks `fetch` to return an SSE-shaped stream, asserts incremental message updates, `[DONE]` marker handling, error path on non-200, retry on 401

### Cypress

- `cypress/e2e/member-portal/columbus-widget.cy.ts`
  - Log in as a member with one enrollment → FAB visible → click → window opens → greeting names the plan
  - Type a question → stub `POST /api/columbus/chat` returning a fixed SSE stream → verify tokens render incrementally
  - Click suggested prompt → input populated + sent
  - Log out → FAB gone

### Manual smoke

- Real end-to-end on staging once the chunks pipeline (companion spec) has populated a real plan: ask "What's my copay for a doctor visit?" and verify the answer references the actual product the member is enrolled in.

---

## Failure Modes

| Scenario | Behavior |
|---|---|
| Columbus offline (health check fails) | FAB muted, window shows "Offline — try again later", input disabled |
| 401 from Columbus mid-conversation | One automatic token refresh + retry; if still 401, show "Session expired" inline and direct to re-login |
| Rate limited (429) | Inline message in chat: "Columbus is busy — try again in a moment" |
| Stream interruption mid-response | Mark message as incomplete with a small "…disconnected" note, keep what was received, allow user to send again |
| Member has zero active enrollments | Widget hidden entirely (Columbus's plan-scoping requires at least one) |
| Browser doesn't support `ReadableStream` (very old) | Detect on mount, fall back to non-streaming POST? **No** — IE/old-browser support is out of scope; AllAboard365 already targets evergreen browsers per Vite defaults |

---

## Rollout

**Phase 1 — Build behind flag**
1. Implement widget + hook + tests in a feature flag `memberColumbusWidget` (default off).
2. Add `columbusUrl` to `frontend/public/config.json` and per-environment overrides.

**Phase 2 — Columbus CORS**
3. Update `columbus-api` allowed origins; deploy.

**Phase 3 — Internal QA**
4. Enable flag for our tenant on staging. Test end-to-end with a real member account that has at least one enrolled product whose AI chunks have been generated (via the companion spec).

**Phase 4 — Remove legacy widgets**
5. Replace member-role usages of `ColumbusAIHelper` / `ChatWidget` with the new widget.
6. Delete the two legacy component files and any unreachable imports.

**Phase 5 — Production**
7. Enable flag for all tenants.
8. Monitor Columbus admin console usage stats for member traffic. Check for repeated bad-answer reports (manually for now; reporting feature is a follow-up).

Companion spec dependency: this widget will work without the chunks refactor — Columbus answers from whatever's in `oe.AIChunks` today. Quality will improve materially once the chunks refactor ships, but the widget can land independently if desired.

---

## Open Items / Future Work

- **Bad-answer reporting** — port the report-content modal from `MightyWELL_Mobile/app/newPlatform/ai.tsx` for support to triage poor answers.
- **Roles other than Member** — eventually agents, tenant admins, etc. may want Columbus access. Each requires its own scoping (an agent should see chunks across all their members? Their tenant's products?). Separate design.
- **Persisted conversation history** — store chats in a `oe.MemberChatSessions` table for support to review. Out of scope here.
- **Plan picker** — when a member has multiple enrollments, give them an optional dropdown to scope the next question to one plan. Columbus already supports `productIds` in the request body; the UI just isn't built yet.
- **Branding/personality** — current widget uses turtle mascot, lime/navy gradient on the marketing site. The portal version uses brand `oe-primary` to feel native. May want a custom turtle illustration commissioned for the portal context.

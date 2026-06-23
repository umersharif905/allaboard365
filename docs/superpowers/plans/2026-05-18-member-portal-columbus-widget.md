# Member Portal Columbus Chat Widget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authenticated, plan-aware Columbus chat widget to the AllAboard365 member portal, lifting the pattern from the MightyWELL marketing site and porting to TypeScript. Remove the two legacy chat widgets that hit deprecated Azure endpoints.

**Architecture:** Floating-FAB widget mounted on the member layout. Posts `{message, conversationHistory}` to `${columbusUrl}/chat` with the member's existing AllAboard365 JWT in the `Authorization` header. Columbus's middleware fetches the member's enrolled products and filters chunks server-side — frontend doesn't need to know the member's plans. SSE streaming for word-by-word responses.

**Tech Stack:** React 18 + TypeScript, Tailwind, Lucide icons, TanStack React Query for the auth token + member context already in `AuthContext`, `fetch` + `ReadableStream` for SSE (no library needed).

**Spec:** `docs/superpowers/specs/2026-05-18-member-portal-columbus-widget-design.md`

**Branch:** `feat/columbus-redesign` (same branch as chunks refactor — they share the work surface and can ship together or in sequence).

---

## Conventions

- **Tailwind + Lucide only.** Brand colors (`bg-oe-primary`, `bg-oe-dark`, etc.). No raw Tailwind blues.
- **No `Read`-after-`Write`** — trust the file state.
- **TDD** for the streaming hook and components with logic. Pure-presentation components get rendering tests only.
- **Commits per task** with conventional prefix.

---

## Phase 1 — Config & service plumbing

### Task 1: Add `columbusUrl` to runtime config

**Files:**
- Modify: `frontend/public/config.json` (and any env-specific overrides under `frontend/public/`)
- Modify: `frontend/src/services/config/api.ts` (or wherever the runtime config is consumed)
- Modify: `frontend/.env.example` to document `VITE_COLUMBUS_URL`

- [ ] **Step 1: Inspect current config plumbing**

```bash
cat frontend/public/config.json
grep -n "OAUTH_URL\|config.json" frontend/src/services/config/api.ts
```

- [ ] **Step 2: Add the key**

Edit `frontend/public/config.json`:

```json
{
  "...": "existing keys",
  "columbusUrl": "https://mightywellhealth.com/api/columbus"
}
```

In `frontend/src/services/config/api.ts`, add a getter:

```ts
export const getColumbusUrl = (): string => {
  return runtimeConfig.columbusUrl
      || import.meta.env.VITE_COLUMBUS_URL
      || 'https://mightywellhealth.com/api/columbus';
};
```

- [ ] **Step 3: Commit**

```bash
git add frontend/public/config.json frontend/src/services/config/api.ts frontend/.env.example
git commit -m "feat(frontend): add columbusUrl runtime config"
```

---

## Phase 2 — Hook + types

### Task 2: `useColumbusChat` streaming hook

**Files:**
- Create: `frontend/src/types/columbus.ts`
- Create: `frontend/src/hooks/useColumbusChat.ts`
- Test: `frontend/src/hooks/__tests__/useColumbusChat.test.ts`

- [ ] **Step 1: Define types**

```ts
// frontend/src/types/columbus.ts
export interface ColumbusMessage {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  error?: boolean;
}
```

- [ ] **Step 2: Write failing tests**

```ts
// frontend/src/hooks/__tests__/useColumbusChat.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useColumbusChat } from '../useColumbusChat';

const encoder = new TextEncoder();
const sseLines = (parts: string[]) =>
  encoder.encode(parts.map(p => `data: ${p}\n`).join('') + '\n');

const mockStream = (lines: string[]) => ({
  body: {
    getReader: () => {
      const chunks = [sseLines(lines)];
      return {
        read: vi.fn()
          .mockImplementationOnce(async () => ({ done: false, value: chunks[0] }))
          .mockResolvedValue({ done: true, value: undefined }),
      };
    },
  },
  ok: true,
  status: 200,
});

beforeEach(() => {
  (global.fetch as any) = vi.fn();
});

describe('useColumbusChat', () => {
  it('appends tokens to the assistant message as they stream', async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 200 }); // health check
    (global.fetch as any).mockResolvedValueOnce(mockStream([
      JSON.stringify({ token: 'Hello' }),
      JSON.stringify({ token: ' world' }),
      '[DONE]',
    ]));

    const { result } = renderHook(() => useColumbusChat('jwt-x'));
    await waitFor(() => expect(result.current.isOnline).toBe(true));
    await act(async () => { await result.current.sendMessage('hi'); });
    await waitFor(() => {
      const last = result.current.messages[result.current.messages.length - 1];
      expect(last.role).toBe('assistant');
      expect(last.content).toBe('Hello world');
    });
  });

  it('surfaces an error when fetch returns 401', async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 200 });
    (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 401 });
    const { result } = renderHook(() => useColumbusChat('bad-jwt'));
    await waitFor(() => expect(result.current.isOnline).toBe(true));
    await act(async () => { await result.current.sendMessage('hi'); });
    const last = result.current.messages[result.current.messages.length - 1];
    expect(last.error).toBe(true);
  });

  it('marks isOnline=false when health check fails', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useColumbusChat('jwt'));
    await waitFor(() => expect(result.current.isOnline).toBe(false));
  });
});
```

- [ ] **Step 3: Run, verify fail**

```bash
cd frontend && npx vitest run src/hooks/__tests__/useColumbusChat.test.ts
```

- [ ] **Step 4: Implement the hook**

```ts
// frontend/src/hooks/useColumbusChat.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { getColumbusUrl } from '../services/config/api';
import type { ColumbusMessage } from '../types/columbus';

interface Options {
  initialGreeting?: string;
}

export function useColumbusChat(authToken: string | null, options: Options = {}) {
  const [messages, setMessages] = useState<ColumbusMessage[]>(() =>
    options.initialGreeting
      ? [{ role: 'assistant', content: options.initialGreeting }]
      : []
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const url = getColumbusUrl();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${url}/health`);
        if (alive) setIsOnline(res.ok);
      } catch {
        if (alive) setIsOnline(false);
      }
    })();
    return () => { alive = false; };
  }, [url]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || !authToken) return;
    setIsStreaming(true);

    const userMsg: ColumbusMessage = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '', streaming: true }]);

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const conversationHistory = messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
      const res = await fetch(`${url}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ message: text, conversationHistory }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const reason = res.status === 401 ? 'Session expired. Please log in again.'
                    : res.status === 429 ? 'Columbus is busy — try again in a moment.'
                    : `Couldn't reach Columbus (HTTP ${res.status}).`;
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: reason, error: true };
          return copy;
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.token) {
              full += parsed.token;
              setMessages((prev) => {
                const copy = [...prev];
                copy[copy.length - 1] = { role: 'assistant', content: full, streaming: true };
                return copy;
              });
            } else if (parsed.error) {
              setMessages((prev) => {
                const copy = [...prev];
                copy[copy.length - 1] = { role: 'assistant', content: parsed.error, error: true };
                return copy;
              });
            }
          } catch { /* ignore malformed lines */ }
        }
      }

      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === 'assistant') copy[copy.length - 1] = { ...last, streaming: false };
        return copy;
      });
    } catch (err) {
      if ((err as any)?.name === 'AbortError') return;
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: 'assistant', content: 'Columbus disconnected — try sending again.', error: true };
        return copy;
      });
    } finally {
      setIsStreaming(false);
    }
  }, [authToken, messages, url]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages(options.initialGreeting
      ? [{ role: 'assistant', content: options.initialGreeting }]
      : []);
  }, [options.initialGreeting]);

  return { messages, isStreaming, isOnline, sendMessage, reset };
}
```

- [ ] **Step 5: Run, verify pass**

```bash
cd frontend && npx vitest run src/hooks/__tests__/useColumbusChat.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types/columbus.ts frontend/src/hooks/useColumbusChat.ts frontend/src/hooks/__tests__/useColumbusChat.test.ts
git commit -m "feat(frontend): useColumbusChat hook with SSE streaming + offline handling"
```

---

## Phase 3 — Components

### Task 3: `ColumbusFab`

**Files:**
- Create: `frontend/src/components/columbus/ColumbusFab.tsx`

- [ ] **Step 1: Implement**

```tsx
import { MessageCircle } from 'lucide-react';

interface Props {
  onClick: () => void;
  isOnline: boolean | null;
}

export default function ColumbusFab({ onClick, isOnline }: Props) {
  return (
    <button
      onClick={onClick}
      aria-label="Open Columbus chat"
      className={`fixed bottom-6 right-6 w-16 h-16 rounded-full shadow-lg flex items-center justify-center text-white transition-transform hover:scale-105 z-40 ${
        isOnline === false ? 'bg-gray-400' : 'bg-oe-primary hover:bg-oe-dark'
      }`}
    >
      <MessageCircle className="w-7 h-7" />
      {isOnline === true && (
        <span className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-oe-success rounded-full border-2 border-white" />
      )}
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/columbus/ColumbusFab.tsx
git commit -m "feat(frontend): Columbus chat floating action button"
```

---

### Task 4: `ColumbusWindow` (chat panel)

**Files:**
- Create: `frontend/src/components/columbus/ColumbusWindow.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useRef, useState } from 'react';
import { X, Send } from 'lucide-react';
import type { ColumbusMessage } from '../../types/columbus';

interface Props {
  messages: ColumbusMessage[];
  isStreaming: boolean;
  isOnline: boolean | null;
  onSend: (text: string) => void;
  onClose: () => void;
  memberFirstName: string;
}

const SUGGESTED = [
  "What's my copay for a doctor visit?",
  'How do I submit a claim?',
  "What's covered if I need a specialist?",
];

export default function ColumbusWindow({ messages, isStreaming, isOnline, onSend, onClose, memberFirstName }: Props) {
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const submit = () => {
    if (!input.trim() || isStreaming || isOnline === false) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <div className="fixed bottom-24 right-6 w-[420px] max-w-[calc(100vw-2rem)] h-[600px] max-h-[calc(100vh-7rem)] bg-white rounded-xl shadow-2xl border border-gray-200 flex flex-col z-40 md:bottom-24 md:right-6">
      <div className="flex items-center justify-between px-4 py-3 bg-oe-primary text-white rounded-t-xl">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-oe-success" />
          <span className="font-semibold">Columbus</span>
          {isOnline === false && <span className="text-xs ml-2 text-red-100">Offline</span>}
        </div>
        <button onClick={onClose} aria-label="Close" className="hover:bg-white/10 rounded p-1">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50">
        {messages.length === 0 && (
          <div className="text-sm text-gray-600">
            Hi {memberFirstName}! I'm Columbus. Ask me anything about your plan — coverage, copays, claims, anything.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
              m.role === 'user'
                ? 'bg-oe-primary text-white'
                : m.error
                  ? 'bg-red-50 text-red-800 border border-red-200'
                  : 'bg-white text-gray-800 border border-gray-200'
            }`}>
              {m.content}
              {m.streaming && <span className="inline-block w-1 h-3 ml-1 bg-gray-400 animate-pulse" />}
            </div>
          </div>
        ))}
        {messages.length <= 1 && (
          <div className="pt-2 space-y-2">
            <p className="text-xs text-gray-500">Try asking:</p>
            {SUGGESTED.map(s => (
              <button key={s}
                      onClick={() => onSend(s)}
                      className="block w-full text-left text-sm px-3 py-2 bg-white border border-gray-200 rounded-lg hover:border-oe-primary hover:bg-oe-light">
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-gray-200 bg-white rounded-b-xl">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder={isOnline === false ? 'Columbus is offline' : 'Ask Columbus…'}
            disabled={isOnline === false}
            rows={2}
            className="flex-1 form-input resize-none disabled:bg-gray-50 disabled:text-gray-400"
          />
          <button onClick={submit}
                  disabled={!input.trim() || isStreaming || isOnline === false}
                  className="w-10 h-10 rounded-full bg-oe-primary hover:bg-oe-dark text-white disabled:opacity-50 flex items-center justify-center flex-shrink-0">
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/columbus/ColumbusWindow.tsx
git commit -m "feat(frontend): Columbus chat window with streaming + suggested prompts"
```

---

### Task 5: `ColumbusChatWidget` orchestrator

**Files:**
- Create: `frontend/src/components/columbus/ColumbusChatWidget.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useColumbusChat } from '../../hooks/useColumbusChat';
import ColumbusFab from './ColumbusFab';
import ColumbusWindow from './ColumbusWindow';

const OPEN_KEY = 'columbus.open';

export default function ColumbusChatWidget() {
  const { user, accessToken } = useAuth();
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
  });

  const firstName = user?.firstName || user?.FirstName || 'there';

  const { messages, isStreaming, isOnline, sendMessage } = useColumbusChat(accessToken || null);

  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* ignore */ }
  }, [open]);

  if (!user || (user.userType && user.userType !== 'Member')) return null;
  // Hide widget if member has no active enrollments (Columbus needs at least one plan)
  // Defer enrollment check to a follow-up; for v1, mount whenever userType=Member.

  return (
    <>
      <ColumbusFab onClick={() => setOpen(true)} isOnline={isOnline} />
      {open && (
        <ColumbusWindow
          messages={messages}
          isStreaming={isStreaming}
          isOnline={isOnline}
          onSend={sendMessage}
          onClose={() => setOpen(false)}
          memberFirstName={firstName}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Confirm AuthContext exposes `accessToken` and `user.userType`**

```bash
grep -n "accessToken\|userType\|firstName" frontend/src/contexts/AuthContext.tsx | head -20
```

If `accessToken` isn't directly exposed, look at how `apiClient.ts` reads tokens and adapt the hook to pull from the same source (e.g., `services/tokenManager.ts`).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/columbus/ColumbusChatWidget.tsx
git commit -m "feat(frontend): ColumbusChatWidget orchestrator with auth gating"
```

---

## Phase 4 — Mount on layout

### Task 6: Mount widget on member layout

**Files:**
- Modify: `frontend/src/components/layout/MemberLayout.tsx` (or `frontend/src/layouts/MemberLayout.tsx` — locate via grep)

- [ ] **Step 1: Locate the member layout**

```bash
grep -rln "MemberLayout\|userType.*Member" frontend/src/components/layout/ frontend/src/layouts/ frontend/src/App.tsx 2>/dev/null | head -5
```

- [ ] **Step 2: Add the widget**

In `MemberLayout.tsx`, import and render at the end of the rendered tree (before the closing element):

```tsx
import ColumbusChatWidget from '../columbus/ColumbusChatWidget';

// inside the JSX, just before the layout's closing wrapper:
<ColumbusChatWidget />
```

- [ ] **Step 3: Run dev server and verify**

```bash
cd frontend && npm run dev
```

Open `http://localhost:5173`, log in as a member, confirm:
- FAB appears bottom-right
- Click → window opens
- Health check populates online status
- Greeting includes first name
- Send a message → streamed response (requires Columbus to be reachable; if dev environment doesn't have access, the offline state is the expected fallback)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/layout/MemberLayout.tsx
git commit -m "feat(frontend): mount Columbus widget on member layout"
```

---

## Phase 5 — Remove legacy widgets

### Task 7: Remove dead chat widgets

**Files:**
- Delete: `frontend/src/components/ai/ColumbusAIHelper.tsx`
- Delete: `frontend/src/components/ai/ChatWidget.tsx`
- Modify: any importers

- [ ] **Step 1: Test the legacy endpoints**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://ai-helper-func-app.azurewebsites.net/api/askai -H 'content-type: application/json' --data '{"product_ids":["45042"],"question":"test"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://oe-ai-helper-dth9buefenare8a9.eastus2-01.azurewebsites.net/api/ai/chat -H 'content-type: application/json' --data '{"Question":"test","Context":[]}'
```

Expected: 4xx/5xx or a long timeout indicating the endpoints are no longer functional. If both come back 200 with sensible data, **STOP** and surface this to the user — the rest of this task assumes they're dead.

- [ ] **Step 2: Find importers**

```bash
grep -rln "ColumbusAIHelper\|from.*ChatWidget" frontend/src --include="*.tsx" --include="*.ts"
```

- [ ] **Step 3: For each importer:**

- If the importer renders the widget for a Member route: replace with `<ColumbusChatWidget />` (likely already covered by mounting on `MemberLayout`).
- For any other role (Agent/TenantAdmin/etc.): remove the import line and the JSX usage. Add no replacement — Columbus for non-members is a follow-up project.

- [ ] **Step 4: Delete the files**

```bash
rm frontend/src/components/ai/ColumbusAIHelper.tsx
rm frontend/src/components/ai/ChatWidget.tsx
```

- [ ] **Step 5: Type-check + commit**

```bash
cd frontend && npx tsc --noEmit
git add -u frontend/src
git commit -m "chore(frontend): remove deprecated chat widgets (deferred non-member story)"
```

---

## Phase 6 — Tests & deploy

### Task 8: Cypress E2E

**Files:**
- Create: `frontend/cypress/e2e/member-portal/columbus-widget.cy.ts`

- [ ] **Step 1: Test**

```ts
describe('Member portal Columbus widget', () => {
  beforeEach(() => {
    cy.loginAsMember(); // existing custom command — adapt to project's helper
  });

  it('FAB renders and opens the chat window', () => {
    cy.visit('/member/dashboard');
    cy.get('button[aria-label="Open Columbus chat"]').should('be.visible').click();
    cy.contains('Columbus').should('be.visible');
    cy.contains(/Ask me anything about your plan/).should('be.visible');
  });

  it('streams an assistant response token by token', () => {
    cy.intercept('GET', '**/api/columbus/health', { statusCode: 200, body: { ok: true } }).as('health');
    cy.intercept('POST', '**/api/columbus/chat', (req) => {
      req.reply((res) => {
        res.setHeader('content-type', 'text/event-stream');
        res.send('data: {"token":"Hello"}\n\ndata: {"token":" there"}\n\ndata: [DONE]\n\n');
      });
    }).as('chat');

    cy.visit('/member/dashboard');
    cy.get('button[aria-label="Open Columbus chat"]').click();
    cy.get('textarea').type("What's my copay?");
    cy.get('button').contains('').parent().find('svg.lucide-send').click({ force: true });
    cy.wait('@chat');
    cy.contains('Hello there').should('be.visible');
  });

  it('shows offline state when health check fails', () => {
    cy.intercept('GET', '**/api/columbus/health', { forceNetworkError: true });
    cy.visit('/member/dashboard');
    cy.get('button[aria-label="Open Columbus chat"]').click();
    cy.contains('Offline').should('be.visible');
    cy.get('textarea').should('be.disabled');
  });
});
```

- [ ] **Step 2: Run, commit**

```bash
cd frontend && npx cypress run --spec "cypress/e2e/member-portal/columbus-widget.cy.ts"
git add frontend/cypress/e2e/member-portal/columbus-widget.cy.ts
git commit -m "test(e2e): Columbus widget render, streaming, offline"
```

---

### Task 9: Columbus CORS update (separate repo)

**Files:** (in `columbus-api` repo)
- Modify: `columbus-api/app.js` (or wherever CORS is configured)

- [ ] **Step 1: Add origins**

Find the CORS configuration block. Add to the allowed origins:

```js
const allowedOrigins = [
  'https://mightywellhealth.com',
  'https://allaboard365.com',     // production member portal
  'https://staging.allaboard365.com', // adjust to actual staging URL
  'http://localhost:5173',        // local dev
];
```

(Exact origin list depends on the project's environment URLs — confirm with `git log` in the columbus-api repo if uncertain.)

- [ ] **Step 2: Smoke test from member portal**

After deploying the Columbus update, log in as a member on staging and verify the FAB shows online and a chat works end-to-end.

- [ ] **Step 3: Commit (in columbus-api repo)**

```bash
cd "/Users/rova/Documents/Columbus The Navigating Turtle/columbus-api"
git add app.js
git commit -m "feat: allow AllAboard365 member portal origins"
```

---

### Task 10: PR + rollout

- [ ] **Step 1: Push and open PR**

```bash
git push origin feat/columbus-redesign
gh pr create --base staging --title "feat: Columbus member portal widget + legacy widget cleanup" --body "$(cat <<'EOF'
## Summary

Adds an authenticated Columbus chat widget to the member portal. Floating FAB, SSE streaming, plan-aware via existing Columbus auth middleware (no plan-picker UI needed — the JWT identifies the member, Columbus pulls enrollments server-side). Removes two legacy chat widgets that called deprecated Azure endpoints.

## What changed

- `frontend/src/types/columbus.ts` (new) — message type
- `frontend/src/hooks/useColumbusChat.ts` (new) — SSE streaming hook with offline/health check + 401/429/network error handling
- `frontend/src/components/columbus/ColumbusFab.tsx` (new) — floating button with online indicator
- `frontend/src/components/columbus/ColumbusWindow.tsx` (new) — chat panel, message list, suggested-prompts grid, textarea with send button
- `frontend/src/components/columbus/ColumbusChatWidget.tsx` (new) — orchestrator gated on `userType==='Member'`, persists open/closed in localStorage
- `frontend/src/components/layout/MemberLayout.tsx` — mounts the widget
- `frontend/public/config.json` — `columbusUrl` runtime config
- `frontend/src/services/config/api.ts` — `getColumbusUrl()` helper
- `frontend/src/components/ai/ColumbusAIHelper.tsx`, `ChatWidget.tsx` — deleted (legacy, dead endpoints)

In the columbus-api repo (separate commit): CORS now allows AllAboard365 origins.

## Manual verification

Log in as a member on staging. FAB appears bottom-right; click opens window with greeting using member's first name. Ask "What's my copay?" — answer streams in. Offline state visible if Columbus is unreachable.
EOF
)"
```

- [ ] **Step 2: Coordinate Columbus deploy and frontend deploy**

(Out of scope for this plan; standard team flow.)

---

## Self-Review

- **Spec coverage:** Config (Task 1 ✓), hook (Task 2 ✓), FAB (Task 3 ✓), window (Task 4 ✓), orchestrator (Task 5 ✓), layout mount (Task 6 ✓), legacy removal (Task 7 ✓), Cypress (Task 8 ✓), CORS (Task 9 ✓), PR (Task 10 ✓).
- **Auth flow:** widget pulls JWT from `AuthContext`; if the property name turns out to be different (e.g. `token` instead of `accessToken`), Task 5 Step 2 has the engineer verify and adapt.
- **Plan picker / multi-enrollment edge case:** Spec says greeting falls back to "your plan(s)" if more than one. Window greeting uses generic "your plan" today — acceptable v1. Member enrollments check is also a future improvement (mentioned in Task 5 comment).
- **Token-refresh-on-401:** v1 surfaces a "Session expired" message rather than auto-refreshing. The spec listed retry as a goal; if `apiClient.ts` exposes a refresh helper, hook this up in a follow-up commit. Acceptable to ship without auto-refresh — manual re-login is the worst case.
- **Reporting/flagging bad answers:** explicitly out of scope per spec.

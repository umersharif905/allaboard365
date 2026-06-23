import { useCallback, useEffect, useRef, useState } from 'react';
import { getColumbusUrl } from '../config/api';
import type { ColumbusAction, ColumbusMessage } from '../types/columbus';

function parseActions(text: string): { displayText: string; actions: ColumbusAction[] } {
  const match = text.match(/\n?\[ACTIONS\]([\s\S]*?)\[\/ACTIONS\]/);
  if (!match) return { displayText: text.trim(), actions: [] };
  const actions: ColumbusAction[] = [];
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj.label === 'string' && typeof obj.target === 'string') {
        actions.push({ label: obj.label, target: obj.target });
      }
    } catch { /* skip malformed lines */ }
  }
  const displayText = text.replace(/\n?\[ACTIONS\][\s\S]*?\[\/ACTIONS\]/, '').trim();
  return { displayText, actions };
}

interface Options {
  initialGreeting?: string;
  /** Identifies the calling portal to Columbus. Defaults to the member portal so
   *  existing member callers are unchanged. */
  clientApp?: string;
  /** When present and non-empty, sent in the /chat body so Columbus scopes
   *  product chunks to these IDs (used by the agent portal). */
  productIds?: string[];
}

export function useColumbusChat(authToken: string | null, options: Options = {}) {
  const clientApp = options.clientApp ?? 'aab-member-portal';
  const productIds = options.productIds;
  const [messages, setMessages] = useState<ColumbusMessage[]>(() =>
    options.initialGreeting
      ? [{ role: 'assistant', content: options.initialGreeting }]
      : []
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Server-assigned id for this chat session. Captured from the first response
  // and resent on every turn so the stored transcript threads into ONE
  // conversation instead of one row per exchange. Cleared by reset().
  const conversationIdRef = useRef<string | null>(null);

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
      const body: Record<string, unknown> = { message: text, conversationHistory, clientApp };
      if (productIds && productIds.length > 0) body.productIds = productIds;
      if (conversationIdRef.current) body.conversationId = conversationIdRef.current;
      const res = await fetch(`${url}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(body),
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
            // Columbus emits { messageId, conversationId } once, up front.
            // Capture the conversation id so the NEXT turn threads onto it.
            if (parsed.conversationId) conversationIdRef.current = parsed.conversationId as string;
            if (parsed.messageId) {
              // Columbus emits the answer id once, up front. Stamp it on the
              // in-progress assistant message so a later rating can attribute
              // back to the chunks that fed this answer.
              const id = parsed.messageId as string;
              setMessages((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last?.role === 'assistant') copy[copy.length - 1] = { ...last, messageId: id };
                return copy;
              });
            } else if (parsed.token) {
              full += parsed.token;
              // Strip any partial or complete [ACTIONS] block while streaming
              const visible = full.replace(/\n?\[ACTIONS\][\s\S]*$/, '');
              setMessages((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                copy[copy.length - 1] = { role: 'assistant', content: visible, streaming: true, messageId: last?.messageId };
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
        if (last?.role === 'assistant') {
          const { displayText, actions } = parseActions(full);
          copy[copy.length - 1] = { ...last, content: displayText, actions, streaming: false };
        }
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
  }, [authToken, messages, url, clientApp, productIds]);

  // Report a wrong/bad answer. Emails the transcript + the member's note to the
  // MightyWELL inbox via the Columbus API. Returns true on success.
  const submitReport = useCallback(async (note: string): Promise<boolean> => {
    try {
      const transcript = messages
        .filter((m) => m.content && !m.streaming)
        .map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch(`${url}/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ note, transcript, clientApp }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }, [authToken, messages, url, clientApp]);

  // Submit a 1-5 rating for an answer. messageId attributes it to the chunks
  // that fed that answer; omit it for an overall rating. Fire-and-forget.
  const submitRating = useCallback(async (rating: number, messageId?: string): Promise<boolean> => {
    try {
      const res = await fetch(`${url}/rate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ rating, messageId, clientApp }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }, [authToken, url, clientApp]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    conversationIdRef.current = null; // start a fresh stored conversation
    setMessages(options.initialGreeting
      ? [{ role: 'assistant', content: options.initialGreeting }]
      : []);
  }, [options.initialGreeting]);

  return { messages, isStreaming, isOnline, sendMessage, submitReport, submitRating, reset };
}

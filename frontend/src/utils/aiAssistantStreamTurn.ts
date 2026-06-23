import { API_CONFIG } from '../config/api';
import { authService } from '../services/auth.service';
import { getAuthHeadersWithTenant } from '../services/api.service';

export type AiAssistantStreamComplete = {
  success: boolean;
  reply?: unknown;
  message?: string;
  sessionDocExtract?: string;
  sessionGridExtract?: string;
  attachmentSummaries?: unknown;
};

function parseStreamCompleteEvent(
  event: { type: string; success?: boolean; reply?: unknown; message?: string; sessionDocExtract?: string; sessionGridExtract?: string; attachmentSummaries?: unknown }
): AiAssistantStreamComplete | null {
  if (event.type !== 'complete' || typeof event.success !== 'boolean') return null;
  return {
    success: event.success,
    reply: event.reply,
    message: event.message,
    sessionDocExtract: event.sessionDocExtract,
    sessionGridExtract: event.sessionGridExtract,
    attachmentSummaries: event.attachmentSummaries,
  };
}

function parseSseLines(
  chunk: string,
  onEvent: (event: { type: string; text?: string; message?: string; success?: boolean; [key: string]: unknown }) => void
) {
  const lines = chunk.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
    if (!jsonStr) continue;
    try {
      onEvent(JSON.parse(jsonStr));
    } catch {
      // ignore malformed SSE lines
    }
  }
}

/**
 * POST multipart turn with SSE streaming (?stream=1). Falls back to caller on non-OK HTTP before stream.
 */
export async function postAiAssistantTurnStream(
  path: string,
  formData: FormData,
  options: {
    timeoutMs?: number;
    onDelta?: (text: string) => void;
  } = {}
): Promise<AiAssistantStreamComplete> {
  const token = await authService.getAccessToken();
  const base = (API_CONFIG.BASE_URL || '').replace(/\/$/, '');
  const url = `${base}${path}${path.includes('?') ? '&' : '?'}stream=1`;

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 180000;
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...getAuthHeadersWithTenant(token),
        Accept: 'text/event-stream',
      },
      body: formData,
      signal: controller.signal,
    });

    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const errJson = (await res.json()) as { message?: string };
        if (errJson.message) message = errJson.message;
      } catch {
        // non-JSON error body
      }
      throw new Error(message);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error('Streaming not supported in this browser');
    }

    const decoder = new TextDecoder();
    let lineBuffer = '';
    let complete: AiAssistantStreamComplete | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const parts = lineBuffer.split('\n\n');
      lineBuffer = parts.pop() || '';
      for (const block of parts) {
        parseSseLines(block, (event) => {
          if (event.type === 'delta' && typeof event.text === 'string') {
            options.onDelta?.(event.text);
          } else if (event.type === 'complete') {
            const parsed = parseStreamCompleteEvent(event);
            if (parsed) complete = parsed;
          } else if (event.type === 'error') {
            throw new Error(
              typeof event.message === 'string' ? event.message : 'Assistant stream failed'
            );
          }
        });
      }
    }

    if (lineBuffer.trim()) {
      parseSseLines(lineBuffer, (event) => {
        if (event.type === 'delta' && typeof event.text === 'string') {
          options.onDelta?.(event.text);
        } else if (event.type === 'complete') {
          const parsed = parseStreamCompleteEvent(event);
          if (parsed) complete = parsed;
        } else if (event.type === 'error') {
          throw new Error(
            typeof event.message === 'string' ? event.message : 'Assistant stream failed'
          );
        }
      });
    }

    if (!complete?.success) {
      throw new Error(
        (complete as { message?: string } | null)?.message || 'Assistant returned no reply'
      );
    }

    return complete;
  } finally {
    window.clearTimeout(timeout);
  }
}

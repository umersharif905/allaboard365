import type {
  EligibilityFormatAiSessionPayload,
  EligibilityFormatChatMessage,
} from '../types/ai/eligibilityFormatAssistant.types';

const MAX_STORED_MESSAGES = 24;
const MAX_DOC_EXTRACT_CHARS = 22000;

export function eligibilityAiChatStorageKey(vendorId: string): string {
  return `eligibility-ai-chat:vendor:${vendorId}`;
}

function trimPayload(payload: EligibilityFormatAiSessionPayload): EligibilityFormatAiSessionPayload {
  const messages = payload.messages.slice(-MAX_STORED_MESSAGES);
  let sessionDocExtract = payload.sessionDocExtract;
  if (sessionDocExtract && sessionDocExtract.length > MAX_DOC_EXTRACT_CHARS) {
    sessionDocExtract = sessionDocExtract.slice(0, MAX_DOC_EXTRACT_CHARS);
  }
  return {
    ...payload,
    messages,
    sessionDocExtract,
    updatedAt: Date.now(),
  };
}

export function loadEligibilityAiChatSession(
  storageKey: string
): EligibilityFormatAiSessionPayload | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EligibilityFormatAiSessionPayload;
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveEligibilityAiChatSession(
  storageKey: string,
  payload: EligibilityFormatAiSessionPayload
): { ok: boolean; quotaWarning?: boolean } {
  const trimmed = trimPayload(payload);

  const trySave = (data: EligibilityFormatAiSessionPayload): boolean => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(data));
      return true;
    } catch (e: unknown) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'QuotaExceededError') return false;
      return false;
    }
  };

  if (trySave(trimmed)) return { ok: true };

  const reduced: EligibilityFormatAiSessionPayload = {
    ...trimmed,
    messages: trimmed.messages.slice(-12),
    sessionDocExtract: trimmed.sessionDocExtract
      ? trimmed.sessionDocExtract.slice(0, 12000)
      : undefined,
  };
  if (trySave(reduced)) {
    return { ok: true, quotaWarning: true };
  }

  const minimal: EligibilityFormatAiSessionPayload = {
    messages: trimmed.messages.slice(-6) as EligibilityFormatChatMessage[],
    updatedAt: Date.now(),
  };
  if (trySave(minimal)) {
    return { ok: true, quotaWarning: true };
  }

  return { ok: false, quotaWarning: true };
}

export function clearEligibilityAiChatSession(storageKey: string): void {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // ignore
  }
}

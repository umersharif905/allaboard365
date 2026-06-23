import type { ProductWizardAiSessionPayload, ProductWizardChatMessage } from '../types/ai/productWizardAssistant.types';

const MAX_STORED_MESSAGES = 24;
const MAX_DOC_EXTRACT_CHARS = 22000;

export function productAiChatStorageKey(opts: {
  editingProductId?: string | null;
  draftSessionId: string;
}): string {
  if (opts.editingProductId) {
    return `product-ai-chat:edit:${opts.editingProductId}`;
  }
  return `product-ai-chat:draft:${opts.draftSessionId}`;
}

export function createDraftSessionId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function trimPayload(payload: ProductWizardAiSessionPayload): ProductWizardAiSessionPayload {
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

export function loadProductAiChatSession(
  storageKey: string
): ProductWizardAiSessionPayload | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProductWizardAiSessionPayload;
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveProductAiChatSession(
  storageKey: string,
  payload: ProductWizardAiSessionPayload
): { ok: boolean; quotaWarning?: boolean } {
  const trimmed = trimPayload(payload);

  const trySave = (data: ProductWizardAiSessionPayload): boolean => {
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

  const reduced: ProductWizardAiSessionPayload = {
    ...trimmed,
    messages: trimmed.messages.slice(-12),
    sessionDocExtract: trimmed.sessionDocExtract
      ? trimmed.sessionDocExtract.slice(0, 12000)
      : undefined,
  };
  if (trySave(reduced)) {
    return { ok: true, quotaWarning: true };
  }

  const minimal: ProductWizardAiSessionPayload = {
    messages: trimmed.messages.slice(-6) as ProductWizardChatMessage[],
    draftSessionId: trimmed.draftSessionId,
    updatedAt: Date.now(),
  };
  if (trySave(minimal)) {
    return { ok: true, quotaWarning: true };
  }

  return { ok: false, quotaWarning: true };
}

export function clearProductAiChatSession(storageKey: string): void {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // ignore
  }
}

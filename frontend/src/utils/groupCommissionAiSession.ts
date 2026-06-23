import type { AIProposalPatch } from '../components/commissions/ai/CommissionRuleAIAssistant';

export type AIGroupProposalRuleEntry = {
  ruleId: string;
  summary?: string;
  patch: AIProposalPatch;
};

const MAX_STORED_MESSAGES = 24;
const MAX_GRID_EXTRACT_CHARS = 22000;

export type GroupCommissionAiChatMessage =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; kind: 'question'; text: string }
  | {
      id: string;
      role: 'assistant';
      kind: 'groupProposal';
      reply: {
        kind: 'proposal';
        summary: string;
        rules: AIGroupProposalRuleEntry[];
        warnings?: string[];
      };
    }
  | { id: string; role: 'assistant'; kind: 'error'; text: string };

export type GroupCommissionAiSessionPayload = {
  messages: GroupCommissionAiChatMessage[];
  sessionGridExtract?: string;
  updatedAt: number;
};

export function groupCommissionAiChatStorageKey(commissionGroupId: string): string {
  return `group-commission-ai-chat:${commissionGroupId}`;
}

function trimPayload(payload: GroupCommissionAiSessionPayload): GroupCommissionAiSessionPayload {
  const messages = payload.messages.slice(-MAX_STORED_MESSAGES);
  let sessionGridExtract = payload.sessionGridExtract;
  if (sessionGridExtract && sessionGridExtract.length > MAX_GRID_EXTRACT_CHARS) {
    sessionGridExtract = sessionGridExtract.slice(0, MAX_GRID_EXTRACT_CHARS);
  }
  return { messages, sessionGridExtract, updatedAt: Date.now() };
}

export function loadGroupCommissionAiChatSession(
  storageKey: string
): GroupCommissionAiSessionPayload | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GroupCommissionAiSessionPayload;
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveGroupCommissionAiChatSession(
  storageKey: string,
  payload: GroupCommissionAiSessionPayload
): { ok: boolean; quotaWarning?: boolean } {
  const trimmed = trimPayload(payload);

  const trySave = (data: GroupCommissionAiSessionPayload): boolean => {
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

  const reduced: GroupCommissionAiSessionPayload = {
    ...trimmed,
    messages: trimmed.messages.slice(-12),
    sessionGridExtract: trimmed.sessionGridExtract
      ? trimmed.sessionGridExtract.slice(0, 12000)
      : undefined,
  };
  if (trySave(reduced)) return { ok: true, quotaWarning: true };

  const minimal: GroupCommissionAiSessionPayload = {
    messages: trimmed.messages.slice(-6),
    updatedAt: Date.now(),
  };
  if (trySave(minimal)) return { ok: true, quotaWarning: true };

  return { ok: false, quotaWarning: true };
}

export function clearGroupCommissionAiChatSession(storageKey: string): void {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // ignore
  }
}

/** Hide duplicate locked-rule warnings when the top banner covers them. */
export function isLockedRuleWarning(text: string): boolean {
  return /modifying locked rule/i.test(text);
}

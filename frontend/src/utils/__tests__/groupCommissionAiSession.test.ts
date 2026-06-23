import { describe, expect, it } from 'vitest';
import {
  clearGroupCommissionAiChatSession,
  groupCommissionAiChatStorageKey,
  isLockedRuleWarning,
  loadGroupCommissionAiChatSession,
  saveGroupCommissionAiChatSession,
} from '../groupCommissionAiSession';

describe('groupCommissionAiSession', () => {
  const key = groupCommissionAiChatStorageKey('group-abc');

  it('round-trips messages and grid extract', () => {
    const payload = {
      messages: [
        { id: '1', role: 'user' as const, content: 'hello' },
        {
          id: '2',
          role: 'assistant' as const,
          kind: 'question' as const,
          text: 'hi',
        },
      ],
      sessionGridExtract: 'grid data',
      updatedAt: Date.now(),
    };
    expect(saveGroupCommissionAiChatSession(key, payload).ok).toBe(true);
    const loaded = loadGroupCommissionAiChatSession(key);
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.sessionGridExtract).toBe('grid data');
    clearGroupCommissionAiChatSession(key);
    expect(loadGroupCommissionAiChatSession(key)).toBeNull();
  });

  it('detects locked-rule warnings', () => {
    expect(isLockedRuleWarning('Modifying locked rule — Foo')).toBe(true);
    expect(isLockedRuleWarning('Vendor cap exceeded')).toBe(false);
  });
});

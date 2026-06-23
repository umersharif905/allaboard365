import { describe, expect, it } from 'vitest';

/** Mirror SSE line parsing used by postAiAssistantTurnStream. */
function parseSseBlock(block: string) {
  const events: Array<{ type: string; text?: string }> = [];
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
    events.push(JSON.parse(jsonStr));
  }
  return events;
}

describe('aiAssistantStreamTurn SSE parsing', () => {
  it('parses delta and complete events', () => {
    const block =
      'data: {"type":"delta","text":"Hello"}\n\ndata: {"type":"complete","success":true,"reply":{"kind":"question","text":"Hello"}}';
    const events = parseSseBlock(block);
    expect(events[0]).toEqual({ type: 'delta', text: 'Hello' });
    expect(events[1].type).toBe('complete');
    expect((events[1] as { success?: boolean }).success).toBe(true);
  });
});

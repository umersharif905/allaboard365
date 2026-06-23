/**
 * aiCallSummaryService — transcript → summary helper.
 *
 * Pure-logic + mocked-LLM coverage (no network):
 *   - returns null when there's nothing worth summarizing
 *   - clamps over-long transcripts while keeping the start and end
 *   - parses Zoom JSON transcripts into plain text
 *   - returns { summary, model } and trims whitespace when the LLM responds
 *
 * Run: npx jest aiCallSummaryService
 */

const svc = require('../aiCallSummaryService');

describe('aiCallSummaryService', () => {
  afterEach(() => {
    svc._client = null;
  });

  test('returns null for empty / too-short / non-string transcripts', async () => {
    expect(await svc.summarizeTranscript('')).toBeNull();
    expect(await svc.summarizeTranscript('too short')).toBeNull();
    expect(await svc.summarizeTranscript(null)).toBeNull();
    expect(await svc.summarizeTranscript(undefined)).toBeNull();
  });

  test('clamps very long transcripts but preserves head and tail', () => {
    const long = 'A'.repeat(60000) + 'ZZZEND';
    const clamped = svc._clampTranscript(long);
    expect(clamped.length).toBeLessThan(long.length);
    expect(clamped).toContain('truncated');
    expect(clamped.startsWith('A')).toBe(true);
    expect(clamped).toContain('ZZZEND');
  });

  test('_toPlainTranscript formats Zoom timeline JSON', () => {
    const json = JSON.stringify({
      timeline: [
        { ts: '00:00:01.500', username: 'Agent', text: 'Hello' },
        { ts: '00:00:05.000', username: 'Caller', text: 'Hi there' },
      ],
    });
    const plain = svc._toPlainTranscript(json);
    expect(plain).toContain('[00:00:01] Agent: Hello');
    expect(plain).toContain('[00:00:05] Caller: Hi there');
  });

  test('returns summary + model when the LLM responds', async () => {
    const create = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: '  A clear, factual summary.  ' }],
    });
    svc._client = { messages: { create } };

    const transcript =
      'Agent: Hello, how can I help you today? Caller: I have a question about my recent bill and a pending share request.';
    const res = await svc.summarizeTranscript(transcript, { direction: 'Inbound', durationSeconds: 125 });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      max_tokens: 600,
      system: expect.stringContaining('call center'),
    });
    expect(res).not.toBeNull();
    expect(res.summary).toBe('A clear, factual summary.');
    expect(typeof res.model).toBe('string');
  });

  test('returns null when the LLM returns no content', async () => {
    svc._client = {
      messages: {
        create: jest.fn().mockResolvedValue({ content: [] }),
      },
    };
    const transcript = 'Agent: Hello. Caller: Hi there, I need help with something important today.';
    expect(await svc.summarizeTranscript(transcript)).toBeNull();
  });
});

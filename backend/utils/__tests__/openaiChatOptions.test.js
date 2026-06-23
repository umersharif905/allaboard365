const {
  buildChatCompletionOptions,
  parseJsonFromModelOutput,
  extractMessageContent,
} = require('../openaiChatOptions');

describe('openaiChatOptions', () => {
  test('buildChatCompletionOptions omits temperature for gpt-5', () => {
    const opts = buildChatCompletionOptions('gpt-5', { tokenLimit: 8000, jsonMode: true, temperature: 0.2 });
    expect(opts.temperature).toBeUndefined();
    expect(opts.max_completion_tokens).toBe(16000);
  });

  test('buildChatCompletionOptions passes temperature for gpt-4o', () => {
    const opts = buildChatCompletionOptions('gpt-4o', { tokenLimit: 8000, temperature: 0.2 });
    expect(opts.temperature).toBe(0.2);
  });

  test('buildChatCompletionOptions uses max_completion_tokens for gpt-5', () => {
    const opts = buildChatCompletionOptions('gpt-5', { tokenLimit: 8000, jsonMode: true });
    expect(opts.max_completion_tokens).toBe(16000);
    expect(opts.max_tokens).toBeUndefined();
    expect(opts.response_format).toEqual({ type: 'json_object' });
    expect(opts.reasoning_effort).toBe('none');
  });

  test('buildChatCompletionOptions uses max_tokens for gpt-4o', () => {
    const opts = buildChatCompletionOptions('gpt-4o', { tokenLimit: 8000, jsonMode: true });
    expect(opts.max_tokens).toBe(8000);
    expect(opts.max_completion_tokens).toBeUndefined();
    expect(opts.reasoning_effort).toBeUndefined();
  });

  test('parseJsonFromModelOutput handles fenced JSON', () => {
    const parsed = parseJsonFromModelOutput('```json\n{"kind":"question","text":"Hi"}\n```');
    expect(parsed).toEqual({ kind: 'question', text: 'Hi' });
  });

  test('extractMessageContent handles array content parts', () => {
    const text = extractMessageContent({
      content: [{ type: 'text', text: 'Hello' }],
    });
    expect(text).toBe('Hello');
  });
});

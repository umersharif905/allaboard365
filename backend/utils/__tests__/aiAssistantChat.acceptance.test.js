'use strict';

const {
  wantsAiAssistantStream,
  createAiAssistantSseWriter,
} = require('../aiAssistantSse');
const { extractDisplayTextFromPartialJson } = require('../openaiJsonStreamDisplay');

describe('AI assistant chat acceptance (backend)', () => {
  describe('AC4/AC5 streaming — safe display text only', () => {
    it('extracts question text from partial JSON without structural noise', () => {
      const partial = '{"kind":"question","text":"Line one\\nLine **two**';
      const display = extractDisplayTextFromPartialJson(partial);
      expect(display).toContain('Line one');
      expect(display).toContain('**two**');
      expect(display).not.toMatch(/"kind"/);
      expect(display).not.toMatch(/"patch"/);
    });

    it('extracts proposal summary only while patch is incomplete', () => {
      const partial = '{"kind":"proposal","summary":"Update tier 1","patch":{"mode":';
      const display = extractDisplayTextFromPartialJson(partial);
      expect(display).toBe('Update tier 1');
      expect(display).not.toContain('mode');
    });

    it('returns empty for bare structural JSON (no text/summary yet)', () => {
      expect(extractDisplayTextFromPartialJson('{"kind":"proposal","patch":{')).toBe('');
    });
  });

  describe('AC8 SSE contract', () => {
    it('wantsAiAssistantStream when query stream=1 or Accept header', () => {
      expect(wantsAiAssistantStream({ query: { stream: '1' }, headers: {} })).toBe(true);
      expect(
        wantsAiAssistantStream({ query: {}, headers: { accept: 'text/event-stream' } })
      ).toBe(true);
      expect(wantsAiAssistantStream({ query: {}, headers: { accept: 'application/json' } })).toBe(
        false
      );
    });

    it('createAiAssistantSseWriter emits delta, complete, and error events', () => {
      const chunks = [];
      const res = {
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
        write: jest.fn((line) => chunks.push(line)),
        end: jest.fn(),
        flush: jest.fn(),
      };

      const sse = createAiAssistantSseWriter(res);
      sse.delta('Hello');
      sse.complete({ success: true, reply: { kind: 'question', text: 'Hello' } });

      expect(chunks[0]).toContain('"type":"delta"');
      expect(chunks[0]).toContain('Hello');
      expect(chunks[1]).toContain('"type":"complete"');
      expect(res.end).toHaveBeenCalled();

      const errChunks = [];
      const res2 = {
        setHeader: jest.fn(),
        write: jest.fn((line) => errChunks.push(line)),
        end: jest.fn(),
      };
      createAiAssistantSseWriter(res2).error('failed');
      expect(errChunks[0]).toContain('"type":"error"');
    });
  });
});

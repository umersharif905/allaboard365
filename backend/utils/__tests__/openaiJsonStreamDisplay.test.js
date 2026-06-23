'use strict';

const {
  extractDisplayTextFromPartialJson,
  unescapeJsonStringFragment,
} = require('../openaiJsonStreamDisplay');

describe('openaiJsonStreamDisplay', () => {
  it('unescapes newlines in JSON string fragments', () => {
    expect(unescapeJsonStringFragment('line1\\nline2')).toBe('line1\nline2');
  });

  it('extracts partial text field', () => {
    const partial = '{"kind":"question","text":"Hello **world';
    expect(extractDisplayTextFromPartialJson(partial)).toBe('Hello **world');
  });

  it('extracts summary for proposals', () => {
    const partial = '{"kind":"proposal","summary":"Update tier 1';
    expect(extractDisplayTextFromPartialJson(partial)).toBe('Update tier 1');
  });

  it('returns empty when only structural JSON is present', () => {
    expect(extractDisplayTextFromPartialJson('{"kind":"proposal","patch":{')).toBe('');
  });
});

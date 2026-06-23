'use strict';

const { normalizeSmsUrl, buildSmsBodyWithLinks } = require('../smsBody');

describe('smsBody', () => {
  it('normalizeSmsUrl adds https when missing', () => {
    expect(normalizeSmsUrl('example.com/doc')).toBe('https://example.com/doc');
  });

  it('buildSmsBodyWithLinks puts URL on its own line after label', () => {
    const body = buildSmsBodyWithLinks('Hi Jane', 'https://x.blob/proposals/a.pdf?sv=1&sig=ab', {
      linkLabel: 'View quote:',
    });
    expect(body).toBe('Hi Jane\n\nView quote:\nhttps://x.blob/proposals/a.pdf?sv=1&sig=ab');
  });

  it('does not place label and URL on the same line', () => {
    const body = buildSmsBodyWithLinks('Hello', 'https://example.com/p.pdf?a=1&b=2', {
      linkLabel: 'View your proposal here:',
    });
    const lines = body.split('\n');
    expect(lines[lines.length - 1]).toMatch(/^https:\/\//);
    expect(lines[lines.length - 2]).toBe('View your proposal here:');
  });
});

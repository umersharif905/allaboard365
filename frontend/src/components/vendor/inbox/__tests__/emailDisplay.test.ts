import { describe, it, expect } from 'vitest';
import { trimEmailHtml } from '../emailDisplay';

describe('trimEmailHtml', () => {
  it('extracts our marked outbound message, dropping signature + quote', () => {
    const html =
      '<table><tr><td><div data-aab-msg="1"><p>Hi Jordan, all set.</p></div>' +
      '<div>SIGNATURE CARD</div></td></tr></table>' +
      '<blockquote>old quoted thread</blockquote>';
    const out = trimEmailHtml(html, 'outbound');
    expect(out.html).toContain('Hi Jordan, all set.');
    expect(out.html).not.toContain('SIGNATURE CARD');
    expect(out.html).not.toContain('old quoted thread');
    expect(out.truncated).toBe(true);
  });

  it('trims an inbound Apple/Gmail blockquote and keeps the new reply', () => {
    const html =
      '<div>Thanks, that works for me!</div>' +
      '<div>On Jun 3, 2026, Care Team wrote:</div>' +
      '<blockquote type="cite">Does Tuesday work?</blockquote>';
    const out = trimEmailHtml(html, 'inbound');
    expect(out.html).toContain('Thanks, that works for me!');
    expect(out.html).not.toContain('Does Tuesday work?');
    expect(out.html).not.toContain('On Jun 3, 2026');
    expect(out.truncated).toBe(true);
  });

  it('keeps content that shares a parent with the quote', () => {
    const html = '<div><p>New reply here.</p><blockquote>quoted</blockquote></div>';
    const out = trimEmailHtml(html, 'inbound');
    expect(out.html).toContain('New reply here.');
    expect(out.html).not.toContain('quoted');
  });

  it('leaves a clean message untouched (no false truncation)', () => {
    const html = '<p>Just a simple note, no quote.</p>';
    const out = trimEmailHtml(html, 'inbound');
    expect(out.html).toContain('Just a simple note');
    expect(out.truncated).toBe(false);
  });

  it('is null-safe', () => {
    expect(trimEmailHtml(null, 'inbound')).toEqual({ html: '', truncated: false });
  });
});

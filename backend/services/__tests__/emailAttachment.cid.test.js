// Unit tests for inline-image cid: rewriting (Back Office inbox).
// Inbound HTML embeds inline pictures as <img src="cid:CONTENTID">, which browsers
// can't resolve — rewriteCidReferences swaps them for the stored attachment's URL.
const { rewriteCidReferences, bodyHasInlineCids } = require('../emailAttachmentService');

describe('bodyHasInlineCids', () => {
    test('true when body has a cid: image (inline-only messages need ingest)', () => {
        expect(bodyHasInlineCids('<img src="cid:abc">')).toBe(true);
        expect(bodyHasInlineCids("<p>hi</p><img src='cid:x'>")).toBe(true);
        expect(bodyHasInlineCids('<img src=cid:x>')).toBe(true);
    });
    test('false for bodies with no cid: images', () => {
        expect(bodyHasInlineCids('<img src="https://x/a.png">')).toBe(false);
        expect(bodyHasInlineCids('<p>just text</p>')).toBe(false);
        expect(bodyHasInlineCids(null)).toBe(false);
        expect(bodyHasInlineCids('')).toBe(false);
    });
});

describe('rewriteCidReferences', () => {
    const url = 'https://acct.blob.core.windows.net/members/_email/x.png?sig=abc&se=1';
    const map = new Map([['abc123', url]]);

    test('replaces a double-quoted cid src', () => {
        expect(rewriteCidReferences('<img src="cid:abc123">', map)).toBe(`<img src="${url}">`);
    });

    test('replaces a single-quoted cid src', () => {
        expect(rewriteCidReferences("<img src='cid:abc123'>", map)).toBe(`<img src='${url}'>`);
    });

    test('replaces an unquoted cid src and forces quotes', () => {
        expect(rewriteCidReferences('<img src=cid:abc123 width=10>', map)).toBe(`<img src="${url}" width=10>`);
    });

    test('matches ContentId regardless of case or surrounding <>', () => {
        const m = new Map([['abc123', url]]);
        expect(rewriteCidReferences('<img src="cid:ABC123">', m)).toBe(`<img src="${url}">`);
    });

    test('leaves an unknown cid untouched', () => {
        expect(rewriteCidReferences('<img src="cid:nope">', map)).toBe('<img src="cid:nope">');
    });

    test('rewrites multiple references in one body', () => {
        const m = new Map([['a', 'URLA'], ['b', 'URLB']]);
        expect(rewriteCidReferences('<img src="cid:a"><img src="cid:b">', m)).toBe('<img src="URLA"><img src="URLB">');
    });

    test('no-ops on empty html or empty map', () => {
        expect(rewriteCidReferences('', map)).toBe('');
        expect(rewriteCidReferences('<img src="cid:abc123">', new Map())).toBe('<img src="cid:abc123">');
        expect(rewriteCidReferences(null, map)).toBe(null);
    });

    test('does not touch non-cid image srcs', () => {
        const html = '<img src="https://example.com/a.png">';
        expect(rewriteCidReferences(html, map)).toBe(html);
    });
});

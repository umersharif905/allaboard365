/**
 * Back Office email — unit tests for the pure/orchestration logic.
 * Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md
 *
 * Run: npx jest services/__tests__/email.unit.test.js
 */

// Hoisted automocks for the ingest orchestration test. The pure-helper tests
// below don't touch these, so the mocks are harmless there.
jest.mock('../graphClient');
jest.mock('../emailThreadService');

const send = require('../emailSendService');
const sync = require('../emailSyncService');
const graph = require('../graphClient');
const threads = require('../emailThreadService');

describe('emailSendService pure helpers', () => {
    test('buildFooterHtml names the sender, vendor team, and ref', () => {
        const html = send.buildFooterHtml({ senderName: 'Jane', vendorName: 'Sharewell', ref: 'SR-2026-0123' });
        expect(html).toContain('Jane');
        expect(html).toContain('Sharewell Care Team');
        expect(html).toContain('SR-2026-0123');
        expect(html).toContain('real person');
    });

    test('buildFooterHtml degrades gracefully with no ref / no sender', () => {
        const html = send.buildFooterHtml({});
        expect(html).toContain('Your care team');
        expect(html).toContain('the Care Team');
        expect(html).not.toContain('Your request');
    });

    test('buildFooterHtml escapes HTML in names/ref', () => {
        const html = send.buildFooterHtml({ senderName: '<script>', vendorName: 'A&B', ref: '<x>' });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('A&amp;B');
    });

    test('buildFooterHtml renders the card with inline cid: image refs (not hosted URLs)', () => {
        const card = { enabled: true, compositePath: '_email-signature/u/card-left.png', title: 'Member Success' };
        const html = send.buildFooterHtml({ senderName: 'Jane', vendorName: 'Sharewell', ref: 'SR-1', card });
        expect(html).toContain('cid:aab-card');   // composite left block
        expect(html).toContain('cid:aab-logo');   // shared logo
        expect(html).not.toContain('/api/public/'); // no hosted-URL dependency
        expect(html).toContain('SR-1');
    });

    test('composeBody keeps order: reply, footer, quoted history', () => {
        const out = send.composeBody({ bodyHtml: 'REPLY', footerHtml: 'FOOT', quotedHtml: 'QUOTE' });
        expect(out.indexOf('REPLY')).toBeLessThan(out.indexOf('FOOT'));
        expect(out.indexOf('FOOT')).toBeLessThan(out.indexOf('QUOTE'));
    });

    test('composeBody marks the new message so the inbox can trim quote + signature', () => {
        const out = send.composeBody({ bodyHtml: '<p>REPLY</p>', footerHtml: 'FOOT', quotedHtml: 'QUOTE' });
        expect(out).toContain('data-aab-msg');
        // the marker wraps only the new message, before the footer/quote
        expect(out.indexOf('data-aab-msg')).toBeLessThan(out.indexOf('FOOT'));
    });

    test('refHeaders stamps x-aab-ref only when a ref exists', () => {
        expect(send.refHeaders('SR-2026-0123')).toEqual([{ name: 'x-aab-ref', value: 'SR-2026-0123' }]);
        expect(send.refHeaders(null)).toEqual([]);
        expect(send.refHeaders(undefined)).toEqual([]);
    });
});

describe('emailSyncService.parseGraphMessage', () => {
    test('maps a Graph message into the store shape', () => {
        const parsed = sync.parseGraphMessage({
            id: 'AAA-immutable',
            conversationId: 'conv-1',
            internetMessageId: '<abc@mail>',
            subject: 'MRI bill',
            bodyPreview: 'Hi, I owe...',
            body: { contentType: 'HTML', content: '<p>Hi</p>' },
            from: { emailAddress: { address: 'maria@x.com', name: 'Maria' } },
            toRecipients: [{ emailAddress: { address: 'inbox@vendor.com' } }],
            ccRecipients: [{ emailAddress: { address: 'cc@x.com' } }],
            receivedDateTime: '2026-06-02T09:42:00Z',
            isRead: false,
            hasAttachments: true,
        });
        expect(parsed).toMatchObject({
            graphMessageId: 'AAA-immutable',
            conversationId: 'conv-1',
            internetMessageId: '<abc@mail>',
            subject: 'MRI bill',
            bodyHtml: '<p>Hi</p>',
            fromAddress: 'maria@x.com',
            fromName: 'Maria',
            toAddresses: ['inbox@vendor.com'],
            ccAddresses: ['cc@x.com'],
            isRead: false,
            hasAttachments: true,
        });
    });

    test('tolerates missing optional fields', () => {
        const parsed = sync.parseGraphMessage({ id: 'x', conversationId: 'c' });
        expect(parsed.toAddresses).toEqual([]);
        expect(parsed.ccAddresses).toEqual([]);
        expect(parsed.fromAddress).toBeNull();
        expect(parsed.isRead).toBe(false);
    });
});

describe('emailSyncService.ingestMessage', () => {
    beforeEach(() => jest.clearAllMocks());

    test('fetches by id and records inbound', async () => {
        graph.getMessage.mockResolvedValue({ id: 'm1', conversationId: 'c1', subject: 'Hi', from: { emailAddress: { address: 'a@b.com' } } });
        threads.recordInboundMessage.mockResolvedValue({ emailMessageId: 'e1', isNew: true, threadId: 't1' });

        const res = await sync.ingestMessage('vendor-1', 'm1');

        expect(graph.getMessage).toHaveBeenCalledWith('vendor-1', 'm1');
        expect(threads.recordInboundMessage).toHaveBeenCalledWith('vendor-1', expect.objectContaining({
            graphMessageId: 'm1', conversationId: 'c1',
        }));
        expect(res).toMatchObject({ isNew: true });
    });

    test('skips messages with no conversationId (vanished/sparse)', async () => {
        graph.getMessage.mockResolvedValue(null);
        const res = await sync.ingestMessage('vendor-1', 'gone');
        expect(res).toBeNull();
        expect(threads.recordInboundMessage).not.toHaveBeenCalled();
    });
});

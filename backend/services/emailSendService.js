// services/emailSendService.js
// Outbound mail for the Back Office inbox. Sends *as* the shared mailbox,
// attributes the internal user, appends a friendly footer, and stamps the
// case/share-request reference (visible footer + x-aab-ref header).
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md

const { getPool, sql } = require('../config/database');
const graph = require('./graphClient');
const emailThreadService = require('./emailThreadService');
const emailAttachmentService = require('./emailAttachmentService');
const cardSvc = require('./emailSignatureCardService');

/** The sender's signature config (free text + ShareWELL card), from oe.Users. */
async function getSenderSignatureData(userId) {
    if (!userId) return { customSignature: null, card: null };
    const pool = await getPool();
    const r = await pool.request().input('id', sql.UniqueIdentifier, userId)
        .query('SELECT EmailSignature, EmailCard FROM oe.Users WHERE UserId = @id');
    const row = r.recordset[0] || {};
    const customSignature = row.EmailSignature && row.EmailSignature.trim() ? row.EmailSignature : null;
    let card = null;
    try { card = row.EmailCard ? JSON.parse(row.EmailCard) : null; } catch (e) { card = null; }
    return { customSignature, card };
}

/** Map a multer file → a Graph (small, single-request) fileAttachment. */
const toGraphAttachment = (f) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: f.originalname,
    contentType: f.mimetype,
    contentBytes: f.buffer.toString('base64'),
});

/** Attach user files to a draft, routing files >3MB through a Graph upload session. */
async function attachFiles(vendorId, messageId, files = []) {
    for (const f of files) {
        if (f.buffer.length > graph.SIMPLE_ATTACHMENT_MAX) {
            await graph.uploadLargeAttachment(vendorId, messageId, { name: f.originalname, contentType: f.mimetype, buffer: f.buffer });
        } else {
            await graph.addAttachment(vendorId, messageId, toGraphAttachment(f));
        }
    }
}

/** Persist sent files to our Blob + DB (retention), linked to the recorded message. */
async function persistOutboundFiles(vendorId, emailMessageId, files = [], ctx = {}) {
    for (const f of files) {
        try { await emailAttachmentService.storeOutboundFile(vendorId, emailMessageId, f, ctx); }
        catch (e) { console.warn('email outbound attachment persist failed:', e.message); }
    }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The default footer when the sender hasn't set a custom signature. */
function defaultSignature({ senderName, vendorName }) {
    const who = esc(senderName) || 'Your care team';
    const team = vendorName ? `the ${esc(vendorName)} Care Team` : 'the Care Team';
    return `— ${who} from ${team}. This is being handled by a real person — just reply to this email and it comes straight to me.`;
}

/**
 * Friendly footer. Renders the sender's ShareWELL card if enabled, plus an
 * optional free-text signature, plus the auto "Ref: …" line. Falls back to the
 * default text sign-off when neither a card nor custom text is set.
 */
function buildFooterHtml({ senderName, vendorName, ref, card, customSignature }) {
    const useCard = !!(card && card.enabled && card.compositePath);
    // Images are embedded inline (CID attachments) so they render everywhere —
    // no public host / PUBLIC_API_BASE_URL / remote-image-loading needed. The
    // matching attachments are added by buildInlineSignatureAttachments() at send.
    const cardHtml = useCard ? cardSvc.renderCardHtml({
        name: senderName,
        title: card.title || '',
        directPhone: card.directPhone,
        email: card.email,
        website: card.website,
        leftBlockUrl: `cid:${cardSvc.CARD_CID}`,
        logoUrl: `cid:${cardSvc.LOGO_CID}`,
    }) : '';

    const sigText = customSignature && customSignature.trim()
        ? esc(customSignature).replace(/\r?\n/g, '<br/>')
        : (useCard ? '' : defaultSignature({ senderName, vendorName }));
    const refLine = ref ? `<div style="color:#9ca3af;font-size:11px;margin-top:6px;">Ref: ${esc(ref)}</div>` : '';
    const textBlock = (sigText || refLine)
        ? `<div style="color:#6b7280;font-size:12px;${useCard ? 'margin-top:10px;' : 'border-top:1px solid #e5e7eb;margin-top:16px;padding-top:8px;'}">${sigText}${refLine}</div>`
        : '';

    return useCard ? `<div style="margin-top:16px;">${cardHtml}${textBlock}</div>` : textBlock;
}

/**
 * Assemble the final outbound HTML. Our new content (the agent's message + the
 * signature) is wrapped in a light "shell": a centered 600px column with a
 * consistent font stack, comfortable line-height, and a clear gap before the
 * signature — structure and legibility without a heavy branded template (which
 * would undercut the "real person" feel and make threaded back-and-forths messy).
 *
 * The quoted history is appended in its NATIVE form, untouched, below the shell —
 * so mail clients still recognize and collapse it into the "…" toggle and header-
 * based threading (In-Reply-To/References) stays intact.
 */
function composeBody({ bodyHtml, footerHtml, quotedHtml }) {
    const spacer = '<div style="font-size:0;line-height:28px;height:28px;">&nbsp;</div>';
    // Wrap just the agent's new message in an invisible marker so our chat-style
    // inbox can reliably show only this message in the bubble (dropping the
    // signature + quoted history, which the thread view already represents).
    const msg = `<div data-aab-msg="1">${bodyHtml || ''}</div>`;
    const inner = `${msg}${footerHtml ? spacer + footerHtml : ''}`;
    const shell = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
  <tr><td align="center" style="padding:8px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;border-collapse:collapse;">
      <tr><td align="left" style="text-align:left;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;">${inner}</td></tr>
    </table>
  </td></tr>
</table>`;
    return shell + (quotedHtml || '');
}

/** internetMessageHeaders array for a ref (empty if no ref). Custom headers must start with x-. */
function refHeaders(ref) {
    return ref ? [{ name: 'x-aab-ref', value: String(ref) }] : [];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Reply (or reply-all) to a thread, sending as the shared mailbox.
 *
 * @param {string} vendorId
 * @param {object} args
 * @param {string} args.threadId        our oe.EmailThreads id
 * @param {string} args.bodyHtml        the agent's message (HTML)
 * @param {boolean} [args.replyAll]
 * @param {object} args.ctx             { userId, userName }
 * @returns {Promise<object>} the recorded outbound oe.EmailMessages row
 */
async function sendReply(vendorId, { threadId, bodyHtml, replyAll = false, files = [], ctx = {} }) {
    const { thread, lastMessage, counterpartyAddress, counterpartyName, ref, vendorName } =
        await emailThreadService.getThreadSendContext(vendorId, threadId);
    if (!thread) { const e = new Error('Thread not found'); e.statusCode = 404; throw e; }
    if (!lastMessage) { const e = new Error('No message in thread to reply to'); e.statusCode = 409; throw e; }

    // 1. Create the reply draft off the latest message — this inherits the
    //    conversationId + In-Reply-To/References headers so the message threads
    //    correctly in the customer's mail client.
    const draft = await graph.createReplyDraft(vendorId, lastMessage.GraphMessageId, { replyAll });

    // 2. Compose body: our text + footer + the draft's quoted history.
    const { customSignature, card } = await getSenderSignatureData(ctx.userId);
    const footerHtml = buildFooterHtml({ senderName: ctx.userName, vendorName, ref, card, customSignature });
    const finalBody = composeBody({ bodyHtml, footerHtml, quotedHtml: draft.body?.content || '' });

    // 3. Patch body AND force the recipient to the CUSTOMER (counterparty).
    //    createReply auto-addresses the reply to the sender of the message we
    //    replied to — which, when our own outbound is the latest message (the
    //    customer hasn't written back yet), is the shared mailbox itself. Left as-is
    //    the "reply" loops back into our own inbox instead of reaching the customer.
    //    So we always send to the counterparty and don't CC anyone (1:1 support
    //    threads; multi-party reply-all isn't preserved yet).
    //    NOTE: we also deliberately do NOT set internetMessageHeaders — a reply draft
    //    inherits the original's custom headers and Graph caps custom headers at 5,
    //    so adding x-aab-ref here 400s. The footer "Ref:" + conversationId correlate.
    const toRecipients = counterpartyAddress
        ? [{ emailAddress: { address: counterpartyAddress, name: counterpartyName || counterpartyAddress } }]
        : (draft.toRecipients || []);
    // Reply-all: CC everyone else who's been on the thread (minus us + the primary
    // recipient) so added participants stay in the loop. Their replies thread back
    // into this same conversation (keyed on conversationId), so no new thread spawns.
    let ccRecipients = [];
    if (replyAll && counterpartyAddress) {
        const [participants, gctx] = await Promise.all([
            emailThreadService.getThreadParticipants(vendorId, threadId),
            graph.resolveContext(vendorId),
        ]);
        const mailbox = (gctx.mailbox || '').toLowerCase();
        const cp = counterpartyAddress.toLowerCase();
        ccRecipients = participants
            .filter((a) => a && a !== mailbox && a !== cp)
            .map((a) => ({ emailAddress: { address: a } }));
    }
    await graph.updateMessage(vendorId, draft.id, {
        toRecipients,
        ccRecipients,
        body: { contentType: 'HTML', content: finalBody },
    });

    // 4. Attach inline signature images (CID, small) + user files (large→upload session), then send.
    const signatureAttachments = await cardSvc.buildInlineSignatureAttachments(card);
    for (const att of signatureAttachments) await graph.addAttachment(vendorId, draft.id, att);
    await attachFiles(vendorId, draft.id, files);
    await graph.sendDraft(vendorId, draft.id);

    // 5. Record the outbound message (+ encounter if the thread is linked), then
    //    persist the sent files to our Blob for retention.
    const recorded = await emailThreadService.recordOutboundMessage(vendorId, {
        threadId: thread.ThreadId,
        graphMessageId: draft.id,
        internetMessageId: draft.internetMessageId || null, // lets the Sent Items sync dedupe this same message
        conversationId: thread.ConversationId,
        toAddresses: toRecipients.map((r) => r.emailAddress?.address).filter(Boolean),
        ccAddresses: ccRecipients.map((r) => r.emailAddress?.address).filter(Boolean),
        subject: draft.subject || thread.Subject,
        bodyHtml: finalBody,
        bodyPreview: (bodyHtml || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 500),
        refStamp: ref || null,
        hasAttachments: files.length > 0,
        sentByUserId: ctx.userId || null,
    }, ctx);
    if (files.length && recorded) await persistOutboundFiles(vendorId, recorded.EmailMessageId, files, ctx);
    return recorded;
}

/**
 * Compose and send a brand-new email (starts a new thread). Sends as the shared
 * mailbox; auto-links to a member/case/SR if provided (which logs an encounter).
 *
 * @param {string} vendorId
 * @param {object} args { to, toName?, subject, bodyHtml, memberId?, caseId?, shareRequestId?, ctx }
 * @returns {Promise<object>} the new thread (with messages)
 */
async function sendNew(vendorId, { to, toName, subject, bodyHtml, memberId, caseId, shareRequestId, files = [], ctx = {} }) {
    if (!to || !String(to).trim()) { const e = new Error('A recipient (to) is required'); e.statusCode = 400; throw e; }
    if (!bodyHtml || !String(bodyHtml).trim()) { const e = new Error('Message body is required'); e.statusCode = 400; throw e; }

    const { ref, vendorName } = await emailThreadService.getComposeContext(vendorId, { caseId, shareRequestId });
    const { customSignature, card } = await getSenderSignatureData(ctx.userId);
    const footerHtml = buildFooterHtml({ senderName: ctx.userName, vendorName, ref, card, customSignature });
    const finalBody = composeBody({ bodyHtml, footerHtml, quotedHtml: '' });

    // Inline signature images (CID, small) go on the draft at creation; user files
    // are added after (so large ones can use an upload session).
    const signatureAttachments = await cardSvc.buildInlineSignatureAttachments(card);

    const message = {
        subject: subject && subject.trim() ? subject.trim() : '(no subject)',
        body: { contentType: 'HTML', content: finalBody },
        toRecipients: [{ emailAddress: { address: to, name: toName || to } }],
        // NOTE: we deliberately do NOT set internetMessageHeaders. Graph 400s
        // ("Maximum number of headers in one message should be <= 5") when posting
        // a message with a custom x- header to this shared mailbox — same quirk that
        // affects reply drafts. The visible "Ref:" footer line + the conversationId
        // handle correlation instead, so the custom header isn't needed.
        ...(signatureAttachments.length ? { attachments: signatureAttachments } : {}),
    };

    // Create the draft so we capture id + conversationId, attach files, then send.
    const draft = await graph.createDraftMessage(vendorId, message);
    await attachFiles(vendorId, draft.id, files);
    await graph.sendDraft(vendorId, draft.id);

    // Record: thread → link (so the message's encounter gets the right entity) → message.
    const threadId = await emailThreadService.upsertThread(vendorId, {
        conversationId: draft.conversationId, subject: message.subject,
    });
    if (memberId || caseId || shareRequestId) {
        await emailThreadService.linkThread(vendorId, threadId, { memberId, caseId, shareRequestId }, ctx);
    }
    const recorded = await emailThreadService.recordOutboundMessage(vendorId, {
        threadId,
        graphMessageId: draft.id,
        internetMessageId: draft.internetMessageId || null, // lets the Sent Items sync dedupe this same message
        conversationId: draft.conversationId,
        toAddresses: [to],
        ccAddresses: [],
        subject: message.subject,
        bodyHtml: finalBody,
        bodyPreview: (bodyHtml || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 500),
        refStamp: ref || null,
        hasAttachments: files.length > 0,
        sentByUserId: ctx.userId || null,
    }, ctx);
    if (files.length && recorded) await persistOutboundFiles(vendorId, recorded.EmailMessageId, files, ctx);

    return emailThreadService.getThread(vendorId, threadId);
}

module.exports = {
    sendReply,
    sendNew,
    // pure helpers exported for tests
    buildFooterHtml,
    composeBody,
    refHeaders,
};

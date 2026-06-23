// routes/public/email-assets.js
// Public (no-auth) image hosting for email signatures — referenced by <img> in
// sent emails, so URLs must be stable and publicly reachable.
//   GET /api/public/email-assets/:file            → shared brand assets (logo, ornament)
//   GET /api/public/email-signature/:userId/card.png → a member's composite left-block
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md

const express = require('express');
const path = require('path');
const router = express.Router();
const emailSignatureCardService = require('../../services/emailSignatureCardService');

const ASSET_DIR = path.join(__dirname, '..', '..', 'assets', 'email-signature');
const ALLOWED_ASSETS = new Set(['sharewell-logo.png', 'left-ornament.png']);
const GUID_RE = /^[0-9a-fA-F-]{36}$/;

// These images are embedded via <img> in sent emails and in the cross-origin
// in-app preview, so they MUST be loadable cross-origin. Helmet's global default
// stamps `Cross-Origin-Resource-Policy: same-origin`, which makes browsers and
// Gmail's image proxy refuse to render them (request 200s, but the image is
// blocked). Override to cross-origin for every response from this router.
router.use((req, res, next) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Access-Control-Allow-Origin', '*');
    next();
});

// Shared brand assets
router.get('/email-assets/:file', (req, res) => {
    const file = req.params.file;
    if (!ALLOWED_ASSETS.has(file)) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(ASSET_DIR, file));
});

// Per-member composite (ornament + oval photo)
router.get('/email-signature/:userId/card.png', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!GUID_RE.test(userId)) return res.status(400).end();
        const buf = await emailSignatureCardService.downloadBlob(`_email-signature/${userId}/card-left.png`);
        if (!buf) return res.status(404).end();
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=300'); // short cache so a re-uploaded photo shows
        res.send(buf);
    } catch (err) {
        console.error('❌ email-signature image:', err.message);
        res.status(500).end();
    }
});

module.exports = router;

// routes/me/email-signature.js
// Upload a care member's headshot for their ShareWELL email-signature card.
// Stored + composited server-side; the card image is served publicly for emails.
// Mounted at /api/me/email-signature. Spec:
// docs/superpowers/specs/2026-06-02-back-office-email/design.md

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authenticate } = require('../../middleware/auth');
const { getPool, sql } = require('../../config/database');
const emailSignatureCardService = require('../../services/emailSignatureCardService');

router.use(authenticate);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) =>
        /^image\/(jpe?g|png|webp|heic|heif)$/i.test(file.mimetype) ? cb(null, true) : cb(new Error('Image files only')),
});

async function mergeEmailCard(userId, patch) {
    const pool = await getPool();
    const cur = await pool.request().input('id', sql.UniqueIdentifier, userId)
        .query('SELECT EmailCard FROM oe.Users WHERE UserId=@id');
    let card = {};
    try { card = cur.recordset[0]?.EmailCard ? JSON.parse(cur.recordset[0].EmailCard) : {}; } catch { card = {}; }
    const next = { ...card, ...patch };
    await pool.request()
        .input('id', sql.UniqueIdentifier, userId)
        .input('card', sql.NVarChar(sql.MAX), JSON.stringify(next))
        .query('UPDATE oe.Users SET EmailCard=@card, ModifiedDate=GETDATE(), ModifiedBy=@id WHERE UserId=@id');
    return next;
}

// POST /api/me/email-signature/photo  (multipart, field "photo")
router.post('/photo', upload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No image uploaded' });
        const userId = req.user.UserId;
        const { compositePath, rawPath } = await emailSignatureCardService.storePhotoAndComposite(userId, req.file.buffer);
        await mergeEmailCard(userId, { photoPath: rawPath, compositePath });
        // Relative path; the frontend prepends its API base (and a cache-buster).
        res.json({ success: true, data: { cardImagePath: `/api/public/email-signature/${userId}/card.png` } });
    } catch (err) {
        console.error('❌ email-signature photo upload:', err);
        res.status(500).json({ success: false, message: 'Failed to process photo', error: err.message });
    }
});

module.exports = router;

// services/emailSignatureCardService.js
// ShareWELL "business card" email signature: composites the ornament + an
// oval-cropped member photo into ONE image (so nothing stretches and it nests +
// renders identically in Outlook), and renders the email-safe card HTML around
// it (name/title/logo/clickable contacts).
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md

const path = require('path');
const sharp = require('sharp');
const { BlobServiceClient } = require('@azure/storage-blob');

const ASSET_DIR = path.join(__dirname, '..', 'assets', 'email-signature');
const ORNAMENT_PATH = path.join(ASSET_DIR, 'left-ornament.png');
const LOGO_PATH = path.join(ASSET_DIR, 'sharewell-logo.png');
const CONTAINER = 'members';

// content-id values used to embed the signature images inline in sent mail.
// The footer HTML references these as `cid:aab-logo` / `cid:aab-card`.
const LOGO_CID = 'aab-logo';
const CARD_CID = 'aab-card';

let _blob;
function blobClient() {
    if (_blob !== undefined) return _blob;
    const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
    _blob = cs ? BlobServiceClient.fromConnectionString(cs) : null;
    return _blob;
}

// Layout (matches the approved preview).
const BAND = 156;   // green band / left-block height
const LEFT = 300;   // left-block width (ornament + photo + green)
const RIGHT = 297;  // right half (contacts)
const PW = 92, PH = 120; // oval photo box (vertical oval)
const PHOTO_OVERLAP = 30; // px the photo pulls onto the ornament's curve

const GREEN = '#18502f';
const CREAM = '#f4f2e8';
const WHITE_TEXT = '#f6f4ea';
const LABEL = '#bcd0c2';

const MAIN_PHONE = process.env.SHAREWELL_MAIN_PHONE || '800.269.1451';
const DEFAULT_WEBSITE = 'www.sharewellhealth.org';

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tel = (s) => 'tel:+1' + String(s || '').replace(/\D/g, '');

/**
 * Composite ornament + oval member photo into a single LEFT×BAND PNG (green bg).
 * The photo is cover-cropped (never stretched) and ellipse-masked.
 */
async function buildLeftBlock(photoBuffer) {
    const ornament = await sharp(ORNAMENT_PATH).resize({ height: BAND }).png().toBuffer();
    const ornW = (await sharp(ornament).metadata()).width;
    const photoX = Math.max(0, ornW - PHOTO_OVERLAP);
    const photoY = Math.round((BAND - PH) / 2);

    const ellipseMask = Buffer.from(
        `<svg width="${PW}" height="${PH}"><ellipse cx="${PW / 2}" cy="${PH / 2}" rx="${PW / 2}" ry="${PH / 2}" fill="#fff"/></svg>`
    );
    const photoOval = await sharp(photoBuffer)
        .resize(PW, PH, { fit: 'cover', position: 'centre' })
        .composite([{ input: ellipseMask, blend: 'dest-in' }])
        .png().toBuffer();

    const BW = PW + 6, BH = PH + 6;
    const borderEllipse = Buffer.from(
        `<svg width="${BW}" height="${BH}"><ellipse cx="${BW / 2}" cy="${BH / 2}" rx="${BW / 2}" ry="${BH / 2}" fill="${CREAM}"/></svg>`
    );

    return sharp({ create: { width: LEFT, height: BAND, channels: 4, background: GREEN } })
        .composite([
            { input: ornament, left: 0, top: 0 },
            { input: borderEllipse, left: photoX - 3, top: photoY - 3 },
            { input: photoOval, left: photoX, top: photoY },
        ])
        .png().toBuffer();
}

const contactRow = (label, href, text) =>
    `<div style="margin:3px 0;white-space:nowrap;"><span style="color:${LABEL};">${label}</span> ` +
    `<a href="${href}" style="color:${WHITE_TEXT};text-decoration:none;">${esc(text)}</a></div>`;

/**
 * Email-safe card HTML. `leftBlockUrl` is the hosted composite image; `logoUrl`
 * the hosted ShareWELL logo. Contacts are clickable.
 */
function renderCardHtml({ name, title, directPhone, email, website, leftBlockUrl, logoUrl }) {
    const site = (website || DEFAULT_WEBSITE).replace(/^https?:\/\//, '');
    const contacts =
        contactRow('m.', tel(MAIN_PHONE), MAIN_PHONE) +
        (directPhone ? contactRow('d.', tel(directPhone), directPhone) : '') +
        (email ? contactRow('e.', `mailto:${esc(email)}`, email) : '') +
        contactRow('w.', `https://${esc(site)}`, site);

    return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;border-collapse:collapse;background:${CREAM};border:1px solid ${GREEN};">
  <tr>
    <td width="${LEFT}" style="width:${LEFT}px;padding:16px 22px;border-bottom:2px solid ${GREEN};vertical-align:middle;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:27px;font-weight:700;color:${GREEN};letter-spacing:-1px;line-height:1;">${esc(name)}</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:${GREEN};letter-spacing:1.5px;text-transform:uppercase;margin-top:6px;">${esc(title)}</div>
    </td>
    <td width="3" style="width:3px;background:${GREEN};border-bottom:2px solid ${GREEN};font-size:0;line-height:0;">&nbsp;</td>
    <td width="${RIGHT}" style="width:${RIGHT}px;padding:6px 22px;border-bottom:2px solid ${GREEN};text-align:center;vertical-align:middle;">
      <img src="${logoUrl}" alt="ShareWELL Partners" height="68" style="height:68px;width:auto;display:inline-block;" />
    </td>
  </tr>
  <tr>
    <td width="${LEFT}" style="width:${LEFT}px;background:${GREEN};padding:0;line-height:0;font-size:0;">
      <img src="${leftBlockUrl}" alt="" width="${LEFT}" height="${BAND}" style="width:${LEFT}px;height:${BAND}px;display:block;" />
    </td>
    <td width="3" style="width:3px;background:${CREAM};font-size:0;line-height:0;">&nbsp;</td>
    <td width="${RIGHT}" style="width:${RIGHT}px;background:${GREEN};vertical-align:middle;text-align:left;padding:0 0 0 28px;font-family:Arial,Helvetica,sans-serif;color:${WHITE_TEXT};font-size:14px;line-height:1.6;">
      ${contacts}
    </td>
  </tr>
</table>`;
}

/** Normalize + store the raw photo and its composite left-block in Blob. */
async function storePhotoAndComposite(userId, photoBuffer) {
    const client = blobClient();
    if (!client) throw new Error('Storage service unavailable');
    const container = client.getContainerClient(CONTAINER);
    await container.createIfNotExists();

    const rawPng = await sharp(photoBuffer).rotate().png().toBuffer(); // rotate() respects EXIF orientation
    const composite = await buildLeftBlock(rawPng);

    const rawPath = `_email-signature/${userId}/photo-raw.png`;
    const compositePath = `_email-signature/${userId}/card-left.png`;
    await container.getBlockBlobClient(rawPath).uploadData(rawPng, { blobHTTPHeaders: { blobContentType: 'image/png' } });
    await container.getBlockBlobClient(compositePath).uploadData(composite, { blobHTTPHeaders: { blobContentType: 'image/png' } });
    return { rawPath, compositePath };
}

// ---------------------------------------------------------------------------
// Inline (CID) email embedding
// ---------------------------------------------------------------------------

let _logoCache; // compressed logo is identical for everyone — cache it.

/** The ShareWELL logo, palette-compressed for email (keeps transparency, ~small). */
async function getInlineLogoBuffer() {
    if (_logoCache) return _logoCache;
    _logoCache = await sharp(LOGO_PATH)
        .png({ palette: true, compressionLevel: 9, quality: 90 })
        .toBuffer();
    return _logoCache;
}

/** Recompress the composite card block for email (palette PNG, no transparency needed). */
async function compressForEmail(buf) {
    try {
        return await sharp(buf).png({ palette: true, compressionLevel: 9, quality: 82 }).toBuffer();
    } catch {
        return buf; // if recompress fails, send the original
    }
}

const inlineAttachment = (name, cid, buf) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name,
    contentType: 'image/png',
    isInline: true,
    contentId: cid,
    contentBytes: buf.toString('base64'),
});

/**
 * Build the inline (CID) image attachments for a sender's signature card — the
 * shared logo + their composited left block — both compressed. Returns [] when
 * the card isn't enabled/built (so callers can spread it unconditionally).
 * The footer HTML must reference `cid:aab-logo` and `cid:aab-card`.
 */
async function buildInlineSignatureAttachments(card) {
    if (!(card && card.enabled && card.compositePath)) return [];
    const atts = [];
    try {
        atts.push(inlineAttachment('sharewell-logo.png', LOGO_CID, await getInlineLogoBuffer()));
        const comp = await downloadBlob(card.compositePath);
        if (comp) atts.push(inlineAttachment('signature.png', CARD_CID, await compressForEmail(comp)));
    } catch (e) {
        console.warn('email signature inline attachments failed:', e.message);
    }
    return atts;
}

/** Download a stored signature blob (composite/raw) as a Buffer, or null. */
async function downloadBlob(blobPath) {
    const client = blobClient();
    if (!client || !blobPath) return null;
    try {
        return await client.getContainerClient(CONTAINER).getBlockBlobClient(blobPath).downloadToBuffer();
    } catch {
        return null;
    }
}

module.exports = {
    buildLeftBlock,
    renderCardHtml,
    storePhotoAndComposite,
    downloadBlob,
    buildInlineSignatureAttachments,
    getInlineLogoBuffer,
    MAIN_PHONE,
    DEFAULT_WEBSITE,
    LOGO_CID,
    CARD_CID,
    LEFT,
    BAND,
};

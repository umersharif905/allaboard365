'use strict';

const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const { downloadBlobImageBufferForPdf } = require('../routes/uploads');
const { definitionWithAuthenticatedHeaderImage } = require('./publicFormDefinitionSas');

/** ~3" at 72 pt/in — readable logo strip without dominating the page */
const HEADER_IMAGE_MAX_WIDTH_PT = 72 * 3;

/**
 * Download header image and normalize to PNG (or JPEG) so PDFKit can embed WebP/SVG/etc.
 * @param {string} url
 * @returns {Promise<Buffer|null>}
 */
async function prepareHeaderImageBufferForPdf(url) {
    const raw = await downloadBlobImageBufferForPdf(url);
    if (!raw || raw.length === 0) {
        return null;
    }
    try {
        return await sharp(raw).rotate().png({ compressionLevel: 6 }).toBuffer();
    } catch (e) {
        try {
            return await sharp(raw).rotate().jpeg({ quality: 85, mozjpeg: true }).toBuffer();
        } catch (e2) {
            return raw;
        }
    }
}

/**
 * @param {object} def
 * @returns {unknown[]}
 */
function definitionFieldsArray(def) {
    if (!def || typeof def !== 'object') return [];
    if (Array.isArray(def.fields)) return def.fields;
    if (Array.isArray(def.Fields)) return def.Fields;
    return [];
}

/**
 * @param {string} html
 */
function stripHtml(html) {
    if (!html || typeof html !== 'string') return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Rich text → plain for PDF: preserve paragraph breaks (terms / legal copy).
 * @param {string} html
 * @returns {string}
 */
function htmlToPlainTextForPdf(html) {
    if (!html || typeof html !== 'string') return '';
    let s = html
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\r\n/g, '\n');
    s = s
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .join('\n');
    return s.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Render a provider_search field value (registry or manual) as one line.
 * @param {{ source?: string, name?: string, npi?: string, address1?: string, city?: string, state?: string, zip?: string }} v
 */
function formatProviderValue(v) {
  const segments = [String(v.name || '').trim()];
  if (v.source === 'registry' && v.npi) segments.push(`NPI ${v.npi}`);
  const addr = [v.address1, [v.city, v.state].filter(Boolean).join(', '), v.zip]
    .filter(Boolean)
    .join(' ');
  if (addr) segments.push(addr);
  segments.push(v.source === 'registry' ? '(registry-verified)' : '(manually entered)');
  return segments.filter(Boolean).join(' — ');
}

/**
 * @param {unknown} v
 */
function formatPayloadValue(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
    if (typeof v === 'object') {
        if (typeof v.imageDataUrl === 'string') return '[Signature on file]';
        if (typeof v.name === 'string' && (v.source === 'registry' || v.source === 'manual')) {
            return formatProviderValue(v);
        }
        return JSON.stringify(v);
    }
    return String(v);
}

/**
 * Signature pad data URLs may be PNG, JPEG, or WebP; PDFKit only embeds PNG/JPEG reliably — normalize via sharp.
 * @param {string} dataUrl
 * @returns {Promise<Buffer|null>}
 */
async function signatureDataUrlToPngBuffer(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    const compact = dataUrl.replace(/\s/g, '');
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(compact);
    if (!m) return null;
    try {
        const raw = Buffer.from(m[2], 'base64');
        if (!raw.length) return null;
        try {
            return await sharp(raw).rotate().png({ compressionLevel: 6 }).toBuffer();
        } catch {
            try {
                return await sharp(raw).rotate().jpeg({ quality: 88, mozjpeg: true }).toBuffer();
            } catch {
                return raw;
            }
        }
    } catch {
        return null;
    }
}

/**
 * @param {unknown[]} fieldsList
 * @param {Record<string, unknown>} payload
 * @returns {Promise<Record<string, Buffer>>}
 */
async function preloadSignatureImageBuffers(fieldsList, payload) {
    /** @type {Record<string, Buffer>} */
    const out = {};
    for (const f of fieldsList) {
        if (!f || typeof f !== 'object' || f.type !== 'signature') continue;
        const name = f.name;
        if (!name) continue;
        const raw = payload[name];
        const url = raw && typeof raw === 'object' && typeof raw.imageDataUrl === 'string' ? raw.imageDataUrl : '';
        if (!url || url.length < 24) continue;
        const buf = await signatureDataUrlToPngBuffer(url);
        if (buf) out[name] = buf;
    }
    return out;
}

/**
 * Match frontend coerceIncludeInPdf — DefinitionJson may carry string/number from tools or DB.
 * @param {unknown} v
 * @returns {boolean|undefined}
 */
function coerceIncludeInPdf(v) {
    if (v === null || v === undefined) return undefined;
    if (v === false || v === 0) return false;
    if (v === true || v === 1) return true;
    if (typeof v === 'string') {
        const t = v.trim().toLowerCase();
        if (t === 'false' || t === '0') return false;
        if (t === 'true' || t === '1') return true;
    }
    return undefined;
}

/**
 * Read includeInPdf from field objects as stored in DefinitionJson (camelCase, PascalCase, or legacy keys).
 * @param {object} field
 * @returns {boolean|undefined}
 */
function readIncludeInPdfRaw(field) {
    if (!field || typeof field !== 'object') return undefined;
    const v = field.includeInPdf ?? field.IncludeInPdf ?? field.include_in_pdf;
    return coerceIncludeInPdf(v);
}

/**
 * Whether this field should appear in the submission PDF.
 * Honors includeInPdf / IncludeInPdf; optional exclude* aliases; default is include when unset (legacy).
 * @param {object} field
 */
function includeFieldInPdf(field) {
    if (!field || typeof field !== 'object') return false;
    if (field.excludeFromPdf === true || field.ExcludeFromPdf === true) return false;
    if (field.excludeFromSubmissionPdf === true) return false;
    return readIncludeInPdfRaw(field) !== false;
}

/**
 * @param {object} def
 * @returns {string}
 */
function getCompanyLetterheadPlain(def) {
    if (!def || typeof def !== 'object') return '';
    const sp = def.submissionPdf ?? def.SubmissionPdf;
    if (!sp || typeof sp !== 'object') return '';
    const raw = sp.companyLetterhead ?? sp.CompanyLetterhead;
    if (typeof raw !== 'string') return '';
    const t = raw.trim();
    if (!t) return '';
    if (/<[a-z][\s\S]*>/i.test(t)) {
        return htmlToPlainTextForPdf(t);
    }
    return t.replace(/\r\n/g, '\n');
}

/**
 * @param {object} def
 * @param {Record<string, unknown>} payload
 * @param {{ title?: string, includeAllFields?: boolean }} _meta
 * @returns {Promise<Buffer>}
 */
async function buildSubmissionPdfBuffer(def, payload, _meta = {}) {
    const defForHeader = await definitionWithAuthenticatedHeaderImage(def);
    const headerUrl =
        defForHeader.headerImage && typeof defForHeader.headerImage.url === 'string'
            ? defForHeader.headerImage.url.trim()
            : '';
    const headerImageBuffer = headerUrl ? await prepareHeaderImageBufferForPdf(headerUrl) : null;
    if (def.headerImage && typeof def.headerImage.url === 'string' && def.headerImage.url.trim() && !headerImageBuffer) {
        console.warn('publicFormSubmissionPdfService: header image could not be loaded for PDF (check blob URL / network)');
    }
    const companyLetterhead = getCompanyLetterheadPlain(defForHeader);
    const fieldsList = definitionFieldsArray(def);
    const signatureBuffers = await preloadSignatureImageBuffers(fieldsList, payload);

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const pageInnerW = 500;
        const pageW = doc.page.width;
        let y = doc.page.margins.top;

        if (headerImageBuffer) {
            try {
                const img = doc.openImage(headerImageBuffer);
                const targetW = Math.min(pageInnerW, HEADER_IMAGE_MAX_WIDTH_PT);
                const scaledH = (img.height / img.width) * targetW;
                const imgX = Math.max(0, (pageW - targetW) / 2);
                doc.image(headerImageBuffer, imgX, y, { width: targetW });
                y += scaledH + 10;
            } catch {
                doc.fontSize(9).fillColor('#666666').text('(Header image could not be embedded.)', {
                    width: pageInnerW
                });
                doc.fillColor('#000000');
                y = doc.y + 8;
            }
        } else if (headerUrl) {
            doc.fontSize(9).fillColor('#666666').text('(Header image could not be loaded.)', {
                width: pageInnerW
            });
            doc.fillColor('#000000');
            y = doc.y + 8;
        }

        if (companyLetterhead) {
            doc.x = doc.page.margins.left;
            doc.y = y;
            doc.fontSize(10).font('Helvetica').fillColor('#000000').text(companyLetterhead, {
                width: pageInnerW,
                lineGap: 2
            });
            y = doc.y + 10;
        }

        doc.x = doc.page.margins.left;
        doc.y = y;

        const forceAll = !!_meta.includeAllFields;
        for (const field of fieldsList) {
            if (!forceAll && !includeFieldInPdf(field)) continue;

            if (field.type === 'static_html') {
                const blockLabel = String(field.label || '').trim();
                if (blockLabel) {
                    doc.fontSize(11).font('Helvetica-Bold').text(blockLabel, { continued: false });
                    doc.font('Helvetica');
                }
                const text = htmlToPlainTextForPdf(field.contentHtml || '');
                doc.fontSize(10).font('Helvetica').text(text || '—', { width: pageInnerW, lineGap: 2 });
                doc.moveDown();
                continue;
            }

            if (field.type === 'terms') {
                const label = field.label || field.name;
                const plain = htmlToPlainTextForPdf(field.termsHtml || '');
                const pad = 10;
                const innerW = pageInnerW - pad * 2;
                const innerX = doc.page.margins.left + pad;
                const yStart = doc.y;
                doc.fontSize(9).font('Helvetica').lineGap(2);

                if (plain) {
                    const h = doc.heightOfString(plain, { width: innerW });
                    const boxH = h + pad * 2;
                    const pageBottomY = doc.page.height - doc.page.margins.bottom;
                    const maxBox = pageBottomY - yStart - 8;

                    if (boxH <= maxBox && h > 0) {
                        doc.save();
                        doc.roundedRect(doc.page.margins.left, yStart, pageInnerW, boxH, 4).fill('#f3f4f6');
                        doc.restore();
                        doc.fillColor('#000000');
                        doc.text(plain, innerX, yStart + pad, { width: innerW, lineGap: 2 });
                    } else {
                        doc.fillColor('#000000');
                        doc.text(plain, doc.page.margins.left, yStart, { width: pageInnerW, lineGap: 2 });
                    }
                }

                doc.moveDown(0.6);
                doc.save();
                doc.strokeColor('#e5e7eb').lineWidth(0.75);
                const ruleY = doc.y;
                doc
                    .moveTo(doc.page.margins.left, ruleY)
                    .lineTo(doc.page.margins.left + pageInnerW, ruleY)
                    .stroke();
                doc.restore();
                doc.strokeColor('#000000');
                doc.moveDown(0.45);

                doc.fontSize(11).font('Helvetica-Bold').text(label, { width: pageInnerW });
                doc.font('Helvetica');
                doc.moveDown(0.25);
                const v = payload[field.name];
                doc.fontSize(10).fillColor('#444444').text(`Accepted: ${formatPayloadValue(v)}`, { width: pageInnerW });
                doc.fillColor('#000000');
                doc.moveDown(0.75);
                continue;
            }

            const label = field.label || field.name;
            doc.fontSize(11).font('Helvetica-Bold').text(`${label}`, { continued: false });
            doc.font('Helvetica');

            if (field.type === 'signature') {
                const raw = payload[field.name];
                const sig = raw && typeof raw === 'object' ? raw : null;
                const imgBuf = signatureBuffers[field.name] || null;
                doc.moveDown(0.25);
                if (imgBuf) {
                    try {
                        doc.image(imgBuf, { width: 220 });
                    } catch (e) {
                        doc.fontSize(10).text('(Signature image could not be embedded.)');
                    }
                } else {
                    const yBox = doc.y;
                    const boxW = 220;
                    const boxH = 72;
                    doc.save();
                    doc.strokeColor('#d1d5db').lineWidth(1);
                    doc.rect(doc.page.margins.left, yBox, boxW, boxH).stroke();
                    doc.restore();
                    doc.fontSize(9).fillColor('#666666');
                    const hasUrl = sig && typeof sig.imageDataUrl === 'string' && sig.imageDataUrl.length > 0;
                    doc.text(
                        hasUrl
                            ? '(Signature image could not be decoded for PDF — see audit below if present.)'
                            : '(No signature image in submission.)',
                        doc.page.margins.left + 6,
                        yBox + 28,
                        { width: boxW - 12, align: 'center' }
                    );
                    doc.fillColor('#000000');
                    doc.y = yBox + boxH + 4;
                }
                const audit = sig && sig.audit && typeof sig.audit === 'object' ? sig.audit : null;
                if (audit) {
                    doc.moveDown(0.35);
                    doc.fontSize(8).fillColor('#333333');
                    const lines = [];
                    if (audit.signedAtUtc) lines.push(`Signed (UTC): ${audit.signedAtUtc}`);
                    if (audit.signerIpHashSha256) {
                        lines.push(`Signer IP hash (SHA-256): ${audit.signerIpHashSha256}`);
                    }
                    if (audit.userAgent) lines.push(`User-Agent: ${String(audit.userAgent).slice(0, 280)}`);
                    if (audit.acceptLanguage) lines.push(`Accept-Language: ${audit.acceptLanguage}`);
                    if (audit.cfCountry) lines.push(`Edge country (if available): ${audit.cfCountry}`);
                    doc.text(lines.join('\n'), { width: 500 });
                    doc.fillColor('#000000');
                }
                doc.moveDown();
                continue;
            }

            if (field.type === 'file') {
                doc.fontSize(10).text('Files may be attached separately with this submission.', { width: 500 });
                doc.moveDown();
                continue;
            }

            const v = payload[field.name];
            const text = formatPayloadValue(v);
            doc.fontSize(10).text(text, { width: 500 });
            doc.moveDown(0.55);
        }

        doc.end();
    });
}

module.exports = {
    buildSubmissionPdfBuffer,
    includeFieldInPdf,
    stripHtml,
    htmlToPlainTextForPdf,
    formatProviderValue
};

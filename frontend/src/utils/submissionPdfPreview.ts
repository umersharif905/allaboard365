import { jsPDF } from 'jspdf';
import { shouldIncludeFieldInPdf, type FormDefinition, type FieldDef } from '../types/publicFormDefinition';

/** Match backend htmlToPlainTextForPdf — preserve paragraph breaks for legal/terms copy. */
function htmlToPlainTextForPdf(html: string): string {
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

function formatPayloadValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  if (typeof v === 'object') {
    if (v && typeof (v as { imageDataUrl?: string }).imageDataUrl === 'string') {
      return '[Signature on file]';
    }
    return JSON.stringify(v);
  }
  return String(v);
}

function buildMockPayload(def: FormDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const previewIso = new Date().toISOString();
  for (const f of def.fields || []) {
    if (f.type === 'static_html') continue;
    switch (f.type) {
      case 'signature':
        out[f.name] = {
          imageDataUrl: '',
          audit: {
            signedAtUtc: previewIso,
            signerIpHashSha256: '(sample — SHA-256 hash of IP on submit)',
            userAgent: 'Mozilla/5.0 (preview)',
            acceptLanguage: 'en-US',
            cfCountry: 'US'
          }
        };
        break;
      case 'checkbox_group':
        out[f.name] = [f.options?.[0]?.value || 'sample'];
        break;
      case 'checkbox':
      case 'terms':
        out[f.name] = true;
        break;
      case 'file':
        out[f.name] = '';
        break;
      default:
        out[f.name] = `Sample: ${f.label || f.name}`;
    }
  }
  return out;
}

async function loadHeaderImageForPreview(
  url: string
): Promise<{ dataUrl: string; w: number; h: number } | null> {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const r = await fetch(trimmed);
    if (!r.ok) return null;
    const blob = await r.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('read'));
      reader.readAsDataURL(blob);
    });
    const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('img'));
      img.src = dataUrl;
    });
    return { dataUrl, ...dims };
  } catch {
    return null;
  }
}

const LINE_H = 12;
const GAP = 8;
/** Match backend HEADER_IMAGE_MAX_WIDTH_PT — ~3" on letter paper */
const HEADER_IMAGE_MAX_WIDTH_PT = 72 * 3;
const TERMS_BODY_PT = 9;
/** ~PDFKit lineGap 2pt on 9pt body (jsPDF uses a line-height multiplier, not points). */
const TERMS_LINE_HEIGHT_FACTOR = 1.22;

/**
 * Builds a sample submission PDF for the form builder preview (mirrors server PDF structure).
 */
export async function buildSubmissionPdfPreviewBlob(
  def: FormDefinition,
  _meta: { templateTitle?: string }
): Promise<Blob> {
  const payload = buildMockPayload(def);
  const letterheadRaw =
    typeof def.submissionPdf?.companyLetterhead === 'string'
      ? def.submissionPdf.companyLetterhead.trim()
      : '';
  const companyLetterhead =
    letterheadRaw && /<[a-z][\s\S]*>/i.test(letterheadRaw)
      ? htmlToPlainTextForPdf(letterheadRaw)
      : letterheadRaw.replace(/\r\n/g, '\n');

  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const margin = 50;
  const maxW = 512;
  let y = margin;

  const pageBottom = () => doc.internal.pageSize.getHeight() - margin;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageBottom()) {
      doc.addPage();
      y = margin;
    }
  };

  if (!def.submissionPdf?.enabled) {
    doc.setFontSize(9);
    doc.setTextColor(120, 120, 120);
    const note = doc.splitTextToSize(
      'Note: Submission PDF is not enabled for this form. This preview shows sample data and layout only.',
      maxW
    );
    ensureSpace(note.length * LINE_H + GAP);
    doc.text(note, margin, y);
    y += note.length * LINE_H + GAP;
    doc.setTextColor(0, 0, 0);
  }

  const headerUrl = def.headerImage?.url?.trim();
  if (headerUrl) {
    const loaded = await loadHeaderImageForPreview(headerUrl);
    if (loaded) {
      const pageW = doc.internal.pageSize.getWidth();
      const wPt = Math.min(maxW, HEADER_IMAGE_MAX_WIDTH_PT);
      const hPt = loaded.h * (wPt / loaded.w);
      const imgX = Math.max(0, (pageW - wPt) / 2);
      const fmt = /data:image\/jpe?g/i.test(loaded.dataUrl) ? 'JPEG' : 'PNG';
      ensureSpace(hPt + GAP);
      doc.addImage(loaded.dataUrl, fmt, imgX, y, wPt, hPt);
      y += hPt + 10;
    }
  }

  if (companyLetterhead) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(companyLetterhead, maxW);
    ensureSpace(lines.length * LINE_H + GAP);
    doc.text(lines, margin, y);
    y += lines.length * LINE_H + GAP;
  }

  const legacyFields = (def as unknown as { Fields?: FieldDef[] }).Fields;
  const fieldsList = Array.isArray(def.fields)
    ? def.fields
    : Array.isArray(legacyFields)
      ? legacyFields
      : [];
  for (const field of fieldsList) {
    if (!shouldIncludeFieldInPdf(field)) continue;

    const label = field.label || field.name;
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    ensureSpace(40);

    if (field.type === 'static_html') {
      const blockLabel = String(field.label || '').trim();
      if (blockLabel) {
        doc.text(blockLabel, margin, y);
        y += 16;
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      const text = htmlToPlainTextForPdf(field.contentHtml || '');
      const lines = doc.splitTextToSize(text || '—', maxW);
      ensureSpace(lines.length * LINE_H + GAP);
      doc.text(lines, margin, y);
      y += lines.length * LINE_H + GAP;
      continue;
    }

    if (field.type === 'terms') {
      const plain = htmlToPlainTextForPdf(field.termsHtml || '');
      const pad = 10;
      const innerW = maxW - pad * 2;
      const xIn = margin + pad;

      if (plain) {
        doc.setFontSize(TERMS_BODY_PT);
        doc.setFont('helvetica', 'normal');
        const termLines = doc.splitTextToSize(plain, innerW);
        const lineStep = TERMS_BODY_PT * TERMS_LINE_HEIGHT_FACTOR;
        const boxH = termLines.length * lineStep + pad * 2;
        const room = pageBottom() - y - 8;
        ensureSpace(Math.min(boxH, room) + 48);

        if (boxH <= room && termLines.length > 0) {
          doc.setFillColor(243, 244, 246);
          doc.roundedRect(margin, y, maxW, boxH, 4, 4, 'F');
          doc.setTextColor(0, 0, 0);
          doc.text(termLines, xIn, y + pad, {
            maxWidth: innerW,
            lineHeightFactor: TERMS_LINE_HEIGHT_FACTOR
          });
          y += boxH + GAP;
        } else {
          doc.setTextColor(0, 0, 0);
          ensureSpace(termLines.length * lineStep + GAP);
          doc.text(termLines, margin, y, {
            maxWidth: maxW,
            lineHeightFactor: TERMS_LINE_HEIGHT_FACTOR
          });
          y += termLines.length * lineStep + GAP;
        }
      }

      ensureSpace(28);
      doc.setDrawColor(229, 231, 235);
      doc.setLineWidth(0.75);
      doc.line(margin, y, margin + maxW, y);
      doc.setDrawColor(0, 0, 0);
      y += 10;

      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      const labelLines = doc.splitTextToSize(label, maxW);
      ensureSpace(labelLines.length * LINE_H + GAP);
      doc.text(labelLines, margin, y);
      y += labelLines.length * LINE_H + 4;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(68, 68, 68);
      const v = payload[field.name];
      const accLines = doc.splitTextToSize(`Accepted: ${formatPayloadValue(v)}`, maxW);
      ensureSpace(accLines.length * LINE_H + GAP);
      doc.text(accLines, margin, y);
      y += accLines.length * LINE_H + GAP;
      doc.setTextColor(0, 0, 0);
      continue;
    }

    doc.text(label, margin, y);
    y += 16;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);

    if (field.type === 'signature') {
      const raw = payload[field.name];
      const sig = raw && typeof raw === 'object' ? (raw as { audit?: Record<string, unknown> }) : null;
      ensureSpace(36);
      doc.text('(Sample signature — respondent will sign here)', margin, y);
      y += LINE_H + 4;
      const audit = sig?.audit;
      if (audit && typeof audit === 'object') {
        doc.setFontSize(8);
        doc.setTextColor(51, 51, 51);
        const auditText: string[] = [];
        if (audit.signedAtUtc) auditText.push(`Signed (UTC): ${String(audit.signedAtUtc)}`);
        if (audit.signerIpHashSha256) {
          auditText.push(`Signer IP hash (SHA-256): ${String(audit.signerIpHashSha256)}`);
        }
        if (audit.userAgent) auditText.push(`User-Agent: ${String(audit.userAgent).slice(0, 280)}`);
        if (audit.acceptLanguage) auditText.push(`Accept-Language: ${String(audit.acceptLanguage)}`);
        if (audit.cfCountry) auditText.push(`Edge country (if available): ${String(audit.cfCountry)}`);
        const auditLines = doc.splitTextToSize(auditText.join('\n'), maxW);
        ensureSpace(auditLines.length * 10 + GAP);
        doc.text(auditLines, margin, y);
        y += auditLines.length * 10 + GAP;
        doc.setTextColor(0, 0, 0);
        doc.setFontSize(10);
      }
      continue;
    }

    if (field.type === 'file') {
      const lines = doc.splitTextToSize('Files may be attached separately with this submission.', maxW);
      ensureSpace(lines.length * LINE_H + GAP);
      doc.text(lines, margin, y);
      y += lines.length * LINE_H + GAP;
      continue;
    }

    const v = payload[field.name];
    const text = formatPayloadValue(v);
    const lines = doc.splitTextToSize(text, maxW);
    ensureSpace(lines.length * LINE_H + GAP);
    doc.text(lines, margin, y);
    y += lines.length * LINE_H + GAP;
  }

  return doc.output('blob');
}

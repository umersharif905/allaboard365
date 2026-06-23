import { jsPDF } from 'jspdf';

export function formatDurationSeconds(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return '—';
  if (totalSeconds < 60) return `${totalSeconds} sec`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m < 60) return s ? `${m} min ${s} sec` : `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} hr ${rm} min` : `${h} hr`;
}

export function payloadToRows(payload: Record<string, unknown> | null | undefined): { key: string; value: string }[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return Object.entries(payload)
    // Skip internal metadata keys (e.g. __preScreening / __preScreenAnswers) —
    // they have dedicated rendering in the submission viewers.
    .filter(([key]) => !key.startsWith('__'))
    .map(([key, v]) => ({
      key,
      value: formatCell(v)
    }));
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(formatCell).join(', ');
  if (typeof v === 'object') {
    // Anatomy-selector value: { region, procedureName, cptCodes[] }
    const o = v as Record<string, unknown>;
    if (typeof o.procedureName === 'string' && Array.isArray(o.cptCodes)) {
      const name = o.procedureName.trim();
      const region = typeof o.region === 'string' && o.region.trim() ? o.region.trim() : '';
      return region ? `${name} (${region})` : name || '—';
    }
    return JSON.stringify(v);
  }
  return String(v);
}

export function safeFilenamePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'submission';
}

function readPayloadStringField(payload: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(payload, k)) continue;
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Sanitized "First-Last" segment from payload (firstName / lastName keys).
 */
export function submitterFilenameSegmentFromPayload(
  payload: Record<string, unknown> | null | undefined
): string {
  if (!payload || typeof payload !== 'object') return '';
  const first = readPayloadStringField(payload, ['firstName', 'FirstName', 'first_name']);
  const last = readPayloadStringField(payload, ['lastName', 'LastName', 'last_name']);
  const a = safeFilenamePart(first);
  const b = safeFilenamePart(last);
  if (a && b) return `${a}-${b}`;
  if (a) return a;
  if (b) return b;
  return '';
}

/**
 * Basename without extension — matches backend `submissionDownloadFilename.js`.
 * Example: `Jane-Doe-UnsharedAmount-submission`
 */
export function buildSubmissionDownloadBasename(
  formKind: string,
  payload: Record<string, unknown> | null | undefined,
  variant: string
): string {
  const kind = safeFilenamePart(String(formKind || 'submission')) || 'submission';
  const name = submitterFilenameSegmentFromPayload(payload);
  const v = safeFilenamePart(String(variant || 'submission')) || 'submission';
  let base = name ? `${name}-${kind}-${v}` : `${kind}-${v}`;
  if (base.length > 120) base = base.slice(0, 120).replace(/-+$/g, '');
  return base || 'submission';
}

/** Server-generated submission PDF (PublicFormSubmissionFiles.FilePurpose = submission_pdf). */
export function getSubmissionRecordPdfBlobUrl(files: unknown): string | null {
  if (!Array.isArray(files)) return null;
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const purpose = o.FilePurpose ?? o.filePurpose;
    if (purpose === 'submission_pdf') {
      const url = o.BlobUrl ?? o.blobUrl;
      if (typeof url === 'string' && url.trim()) return url.trim();
    }
  }
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const name = String(o.originalFileName ?? o.OriginalFileName ?? '').toLowerCase();
    if (name === 'submission-record.pdf') {
      const url = o.BlobUrl ?? o.blobUrl;
      if (typeof url === 'string' && url.trim()) return url.trim();
    }
  }
  return null;
}

/**
 * Download the stored submission-record PDF from blob SAS URL.
 * Falls back to opening the URL in a new tab if fetch/CORS fails.
 */
export async function downloadSubmissionRecordPdfFromUrl(blobUrl: string, downloadFilename: string): Promise<void> {
  try {
    const r = await globalThis.fetch(blobUrl, { mode: 'cors' });
    if (r.ok) {
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = downloadFilename;
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
  } catch {
    /* fall through to open tab */
  }
  window.open(blobUrl, '_blank', 'noopener,noreferrer');
}

export function downloadSubmissionCsv(opts: {
  title: string;
  formKind: string;
  createdDateLabel: string;
  requestNumber?: string | null;
  rows: { key: string; value: string }[];
  /** Used for download filename (firstName / lastName in payload). */
  payload?: Record<string, unknown> | null;
}): void {
  const lines: string[][] = [
    ['Field', 'Value'],
    ['Form kind', opts.formKind],
    ['Submitted', opts.createdDateLabel],
    ...(opts.requestNumber ? [['Request #', opts.requestNumber]] : []),
    ...opts.rows.map((r) => [r.key, r.value])
  ];
  const esc = (cell: string) => {
    const t = String(cell ?? '');
    if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  };
  const csv = lines.map((row) => row.map(esc).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const base = buildSubmissionDownloadBasename(opts.formKind, opts.payload ?? null, 'submission');
  a.download = `${base}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function downloadSubmissionPdf(opts: {
  title: string;
  formKind: string;
  createdDateLabel: string;
  requestNumber?: string | null;
  rows: { key: string; value: string }[];
  /** Used for download filename (firstName / lastName in payload). */
  payload?: Record<string, unknown> | null;
}): void {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const margin = 48;
  const pageW = doc.internal.pageSize.getWidth();
  const maxTextW = pageW - margin * 2;
  let y = 48;
  const lineH = 13;

  const addPageIfNeeded = (needed: number) => {
    const h = doc.internal.pageSize.getHeight();
    if (y + needed > h - margin) {
      doc.addPage();
      y = margin;
    }
  };

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  const titleLines = doc.splitTextToSize(opts.title || 'Submission', maxTextW);
  addPageIfNeeded(titleLines.length * lineH + 8);
  doc.text(titleLines, margin, y);
  y += titleLines.length * lineH + 8;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  const meta = [
    `Form kind: ${opts.formKind}`,
    `Submitted: ${opts.createdDateLabel}`,
    ...(opts.requestNumber ? [`Request #: ${opts.requestNumber}`] : [])
  ];
  for (const m of meta) {
    addPageIfNeeded(lineH);
    doc.text(m, margin, y);
    y += lineH + 2;
  }
  y += 8;

  doc.setFontSize(11);
  for (const r of opts.rows) {
    doc.setFont('helvetica', 'bold');
    const kLines = doc.splitTextToSize(r.key, 200);
    addPageIfNeeded(kLines.length * lineH + lineH * 3);
    doc.text(kLines, margin, y);
    y += kLines.length * lineH * 0.95;

    doc.setFont('helvetica', 'normal');
    const vLines = doc.splitTextToSize(r.value || '—', maxTextW);
    addPageIfNeeded(vLines.length * lineH + 8);
    doc.text(vLines, margin, y);
    y += vLines.length * lineH * 0.95 + 10;
  }

  const base = buildSubmissionDownloadBasename(opts.formKind, opts.payload ?? null, 'submission');
  doc.save(`${base}.pdf`);
}

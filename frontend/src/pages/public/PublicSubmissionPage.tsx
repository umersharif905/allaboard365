import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiService } from '../../services/api.service';
import {
  downloadSubmissionCsv,
  downloadSubmissionPdf,
  downloadSubmissionRecordPdfFromUrl,
  formatDurationSeconds,
  getSubmissionRecordPdfBlobUrl,
  payloadToRows,
  buildSubmissionDownloadBasename
} from '../../utils/submissionExport';

type SubmissionFile = {
  fileId: string;
  originalFileName: string;
  contentType?: string;
  fileSizeBytes?: number;
  blobUrl?: string;
  filePurpose?: string | null;
};

type SubmissionField = {
  name: string;
  label?: string | null;
  type?: string | null;
};

type SubmissionData = {
  submissionId: string;
  formKind: string;
  title?: string | null;
  createdDate: string;
  memberMatchStatus: string;
  requestNumber?: string | null;
  anonymousLinkFirstViewedAt?: string | null;
  secondsFromSubmitToFirstView?: number | null;
  payload: Record<string, unknown>;
  fields?: SubmissionField[];
  files: SubmissionFile[];
};

function formatDate(input: string): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return input;
  return d.toLocaleString();
}

function formatBytes(size?: number | string | null): string {
  // mssql/tedious returns BIGINT as a string (or BigInt in some configs) to
  // avoid precision loss. Coerce to a plain Number so .toFixed() works.
  const n =
    typeof size === 'number'
      ? size
      : size == null
        ? 0
        : Number(size as unknown as string);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function isSignatureObj(v: unknown): v is { imageDataUrl: string; audit?: Record<string, unknown> } {
  return !!v && typeof v === 'object' && typeof (v as { imageDataUrl?: unknown }).imageDataUrl === 'string';
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(renderValue).join(', ');
  if (isSignatureObj(v)) return '[Signature on file]';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function PublicSubmissionPage() {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SubmissionData | null>(null);
  const [pdfDownloading, setPdfDownloading] = useState(false);
  const [completePdfDownloading, setCompletePdfDownloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) return;
      setLoading(true);
      setError(null);
      try {
        const res = await apiService.get<{ success: boolean; data?: SubmissionData; message?: string }>(
          `/api/public/forms/submissions/${token}`
        );
        if (cancelled) return;
        if (!res.success || !res.data) {
          setError(res.message || 'Submission link is invalid or expired');
          return;
        }
        setData(res.data);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load submission');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <p className="text-slate-600">Loading submission…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
        <div className="max-w-lg bg-white border border-slate-200 rounded-lg shadow p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900 mb-2">Unable to open link</h1>
          <p className="text-sm text-red-700">{error || 'Submission not found.'}</p>
        </div>
      </div>
    );
  }

  const createdLabel = formatDate(data.createdDate);
  const titleDisplay = data.title?.trim() || 'Public form submission';
  const exportRows = payloadToRows(data.payload);
  const payloadForName =
    data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload)
      ? (data.payload as Record<string, unknown>)
      : null;

  // Build a label map from the form definition, then order the rows in
  // definition order first (so the viewer reads like the original form),
  // falling back to payload-only keys at the end.
  const fieldList = Array.isArray(data.fields) ? data.fields : [];
  const labelByKey = new Map<string, string>();
  for (const f of fieldList) {
    if (f?.name && f.label) labelByKey.set(f.name, f.label);
  }
  const payloadMap = new Map<string, unknown>(Object.entries(data.payload || {}));
  const orderedKeys: string[] = [];
  const seen = new Set<string>();
  for (const f of fieldList) {
    if (!f?.name || seen.has(f.name)) continue;
    if (payloadMap.has(f.name)) {
      orderedKeys.push(f.name);
      seen.add(f.name);
    }
  }
  for (const k of payloadMap.keys()) {
    if (!seen.has(k)) orderedKeys.push(k);
  }
  const payloadEntries: Array<[string, unknown]> = orderedKeys.map((k) => [k, payloadMap.get(k)]);

  const runPdf = async () => {
    if (!token) return;
    setPdfDownloading(true);
    try {
      await apiService.downloadFile(
        `/api/public/forms/submissions/${token}/submission-pdf`,
        `${buildSubmissionDownloadBasename(data.formKind, payloadForName, 'submission')}.pdf`
      );
    } catch {
      const recordUrl = getSubmissionRecordPdfBlobUrl(data.files);
      if (recordUrl) {
        try {
          await downloadSubmissionRecordPdfFromUrl(
            recordUrl,
            `${buildSubmissionDownloadBasename(data.formKind, payloadForName, 'submission-record')}.pdf`
          );
          return;
        } catch {
          /* fall through */
        }
      }
      downloadSubmissionPdf({
        title: titleDisplay,
        formKind: data.formKind,
        createdDateLabel: createdLabel,
        requestNumber: data.requestNumber,
        rows: exportRows,
        payload: payloadForName
      });
    } finally {
      setPdfDownloading(false);
    }
  };

  const runCompletePdf = async () => {
    if (!token) return;
    setCompletePdfDownloading(true);
    try {
      await apiService.downloadFile(
        `/api/public/forms/submissions/${token}/submission-pdf-complete`,
        `${buildSubmissionDownloadBasename(data.formKind, payloadForName, 'submission-complete')}.pdf`
      );
    } catch {
      downloadSubmissionPdf({
        title: titleDisplay,
        formKind: data.formKind,
        createdDateLabel: createdLabel,
        requestNumber: data.requestNumber,
        rows: exportRows,
        payload: payloadForName
      });
    } finally {
      setCompletePdfDownloading(false);
    }
  };

  const runCsv = () =>
    downloadSubmissionCsv({
      title: titleDisplay,
      formKind: data.formKind,
      createdDateLabel: createdLabel,
      requestNumber: data.requestNumber,
      rows: exportRows,
      payload: payloadForName
    });

  return (
    <div className="min-h-screen bg-slate-100 py-10 px-4">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
        }
      `}</style>
      <div className="max-w-3xl mx-auto bg-white border border-slate-200 rounded-lg shadow p-6 md:p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{titleDisplay}</h1>
          <p className="text-sm text-slate-500 mt-1">Submitted {createdLabel}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <div className="rounded border border-slate-200 p-3">
            <p className="text-slate-500">Form kind</p>
            <p className="font-medium text-slate-900">{data.formKind}</p>
          </div>
          <div className="rounded border border-slate-200 p-3">
            <p className="text-slate-500">Match status</p>
            <p className="font-medium text-slate-900">{data.memberMatchStatus}</p>
          </div>
          <div className="rounded border border-slate-200 p-3">
            <p className="text-slate-500">Request #</p>
            <p className="font-medium text-slate-900">{data.requestNumber || '—'}</p>
          </div>
        </div>

        <div className="rounded-lg border border-indigo-100 bg-indigo-50/80 p-4 space-y-2">
          <h2 className="text-sm font-semibold text-indigo-950">Tracking</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-slate-600">This link first opened</p>
              <p className="font-medium text-slate-900">
                {data.anonymousLinkFirstViewedAt
                  ? formatDate(data.anonymousLinkFirstViewedAt)
                  : '—'}
              </p>
            </div>
            <div>
              <p className="text-slate-600">Time from submit to first open</p>
              <p className="font-medium text-slate-900">
                {formatDurationSeconds(
                  data.secondsFromSubmitToFirstView != null ? data.secondsFromSubmitToFirstView : null
                )}
              </p>
            </div>
          </div>
          <p className="text-xs text-slate-500 no-print">
            The timer starts when the form was submitted. The “first opened” time is recorded the first time someone
            loads this page using your secure link.
          </p>
        </div>

        <section>
          <h2 className="text-lg font-semibold text-slate-900 mb-3">Submitted data</h2>
          <div className="rounded border border-slate-200 overflow-hidden">
            {payloadEntries.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">No data fields were submitted.</p>
            ) : (
              <table className="w-full text-sm table-fixed">
                <colgroup>
                  <col className="w-1/3" />
                  <col className="w-2/3" />
                </colgroup>
                <tbody>
                  {payloadEntries.map(([k, v], idx) => {
                    const label = labelByKey.get(k);
                    return (
                    <tr key={k} className={idx % 2 ? 'bg-slate-50' : 'bg-white'}>
                      <td className="p-3 align-top break-words">
                        <div className="text-slate-900 font-semibold leading-snug">
                          {label || k}
                        </div>
                        {label ? (
                          <div className="text-[11px] text-slate-400 font-mono mt-0.5 break-all">
                            {k}
                          </div>
                        ) : null}
                      </td>
                      <td className="p-3 align-top text-slate-900 break-words">
                        {isSignatureObj(v) ? (
                          <div>
                            {(v as { imageDataUrl: string }).imageDataUrl ? (
                              <img
                                src={(v as { imageDataUrl: string }).imageDataUrl}
                                alt="Signature"
                                className="max-w-[240px] h-auto border border-slate-200 rounded bg-white"
                              />
                            ) : (
                              <span className="text-slate-500 italic">No signature drawn</span>
                            )}
                            {(v as { audit?: Record<string, unknown> }).audit && (
                              <p className="text-xs text-slate-500 mt-1">
                                Signed: {String((v as { audit: Record<string, unknown> }).audit.signedAtUtc || '—')}
                              </p>
                            )}
                          </div>
                        ) : (
                          renderValue(v)
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-900 mb-3">Attachments</h2>
          <div className="rounded border border-slate-200 divide-y divide-slate-200">
            {(data.files || []).length === 0 ? (
              <p className="p-4 text-sm text-slate-500">No files attached.</p>
            ) : (
              data.files.map((f) => (
                <div key={f.fileId} className="p-4 flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-900">{f.originalFileName}</p>
                    <p className="text-xs text-slate-500">
                      {f.contentType || 'Unknown type'} · {formatBytes(f.fileSizeBytes)}
                    </p>
                  </div>
                  {f.blobUrl ? (
                    <a
                      href={f.blobUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-blue-700 hover:underline whitespace-nowrap no-print"
                    >
                      Open file
                    </a>
                  ) : (
                    <span className="text-xs text-slate-400">Unavailable</span>
                  )}
                </div>
              ))
            )}
          </div>
        </section>

        <div className="no-print flex flex-wrap gap-2 pt-4 border-t border-slate-200">
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50"
          >
            Print
          </button>
          <button
            type="button"
            disabled={pdfDownloading}
            onClick={() => void runPdf()}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50 disabled:opacity-60"
          >
            {pdfDownloading ? 'Preparing…' : 'Custom PDF'}
          </button>
          <button
            type="button"
            disabled={completePdfDownloading}
            onClick={() => void runCompletePdf()}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50 disabled:opacity-60"
          >
            {completePdfDownloading ? 'Preparing…' : 'Complete PDF'}
          </button>
          <button
            type="button"
            onClick={runCsv}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50"
          >
            Download CSV
          </button>
        </div>
      </div>
    </div>
  );
}

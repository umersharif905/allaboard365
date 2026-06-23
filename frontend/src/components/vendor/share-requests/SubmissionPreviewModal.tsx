import { useEffect, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiService } from '../../../services/api.service';
import { payloadToRows } from '../../../utils/submissionExport';
import { formatSubmissionDateTime } from '../../../utils/formSubmissionGrouping';
import {
  PreScreeningSubmissionSummary,
  readPreScreeningSnapshot
} from '../../PreScreeningSubmissionSummary';

type SubmissionDetail = {
  SubmissionId: string;
  FormTitle?: string | null;
  FormKind?: string | null;
  CreatedDate?: string | null;
  AuthMode?: string | null;
  MemberId?: string | null;
  MemberFirstName?: string | null;
  MemberLastName?: string | null;
  MemberEmail?: string | null;
  RequestNumber?: string | null;
  payload?: Record<string, unknown> | null;
};

interface SubmissionPreviewModalProps {
  /** Submission UUID. Modal fetches detail on mount; null/empty closes. */
  submissionId: string | null;
  /** Where the "Open full submission" link goes — e.g. /vendor/sharing-forms/submissions */
  detailRouteBase: string;
  /** Where to fetch from — e.g. /api/me/vendor/public-forms */
  apiBase: string;
  onClose: () => void;
}

/**
 * Preview modal for a form submission. Shown from contexts that link out
 * to a submission (SR Documents-and-Forms tab, etc.) so the care team can
 * peek at the answers without leaving the page. "Open full submission"
 * takes them to the detail page when they need more.
 */
export function SubmissionPreviewModal({
  submissionId,
  detailRouteBase,
  apiBase,
  onClose,
}: SubmissionPreviewModalProps) {
  const [data, setData] = useState<SubmissionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!submissionId) {
      setData(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setData(null);
      try {
        const res = await apiService.get<{
          success: boolean;
          data?: SubmissionDetail;
          message?: string;
        }>(`${apiBase}/submissions/${submissionId}`);
        if (cancelled) return;
        if (res.success && res.data) setData(res.data);
        else setError(res.message || 'Failed to load submission');
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load submission');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [submissionId, apiBase]);

  if (!submissionId) return null;

  const memberName =
    data && [data.MemberFirstName, data.MemberLastName].filter(Boolean).join(' ').trim();
  const rows = data?.payload ? payloadToRows(data.payload) : [];
  const preScreening = readPreScreeningSnapshot(data?.payload);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl bg-white rounded-lg shadow-xl max-h-[90vh] overflow-hidden flex flex-col">
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900 truncate">
            {data?.FormTitle || data?.FormKind || 'Form submission'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
          {loading && <p className="text-gray-500">Loading submission…</p>}
          {error && (
            <div className="rounded border border-red-200 bg-red-50 text-red-800 px-3 py-2">
              {error}
            </div>
          )}
          {!loading && !error && data && (
            <>
              <div className="text-xs text-gray-600 flex flex-wrap items-center gap-2">
                <span>Submitted {formatSubmissionDateTime(data.CreatedDate)}</span>
                {data.AuthMode && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border bg-gray-100 text-gray-700 border-gray-200">
                    {data.AuthMode}
                  </span>
                )}
                {data.RequestNumber && <span>· linked to {data.RequestNumber}</span>}
              </div>
              {(memberName || data.MemberEmail) && (
                <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs space-y-0.5">
                  {memberName && (
                    <p className="text-gray-900 font-medium">{memberName}</p>
                  )}
                  {data.MemberEmail && (
                    <p className="text-gray-600">{data.MemberEmail}</p>
                  )}
                </div>
              )}
              <PreScreeningSubmissionSummary questions={preScreening} compact />
              {rows.length === 0 ? (
                preScreening.length === 0 ? (
                  <p className="text-gray-500">No answers in this submission.</p>
                ) : null
              ) : (
                <div className="rounded border border-gray-200 overflow-hidden">
                  <table className="w-full text-xs">
                    <tbody className="divide-y divide-gray-100">
                      {rows.map(({ key, value }, idx) => (
                        <tr key={`${key}-${idx}`} className={idx % 2 ? 'bg-gray-50' : 'bg-white'}>
                          <td className="px-3 py-2 align-top text-gray-700 font-medium w-1/3 break-words">
                            {key}
                          </td>
                          <td className="px-3 py-2 align-top text-gray-900 break-words">{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            className="border border-gray-300 text-gray-700 px-3 py-1.5 rounded text-sm hover:bg-gray-50"
          >
            Close
          </button>
          <Link
            to={`${detailRouteBase}/submissions/${submissionId}`}
            className="inline-flex items-center gap-1.5 bg-oe-primary hover:bg-oe-dark text-white px-3 py-1.5 rounded text-sm font-medium"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open full submission
          </Link>
        </footer>
      </div>
    </div>
  );
}

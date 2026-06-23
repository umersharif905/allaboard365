import { useState } from 'react';
import { ChevronDown, ChevronUp, FileText, Download } from 'lucide-react';
import ShareRequestProgressBar from './ShareRequestProgressBar';
import { useMemberShareRequestDocuments } from '../../hooks/member/useMemberShareRequestDocuments';
import { mapShareRequestStatusToStep } from '../../types/shareRequest.types';
import type { MemberShareRequest } from '../../hooks/member/useMemberSharingRequests';

interface ShareRequestCardProps {
  sr: MemberShareRequest;
}

function formatDate(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

function formatUSD(value?: number | string | null): string | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'string' ? Number(value) : value;
  if (Number.isNaN(num)) return null;
  return num.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// The plan UA comes from a config field whose value may be a bare number
// ("1500"), a pre-formatted string ("$1,500"), or non-numeric text. Format
// numeric values as currency; pass anything else through unchanged.
function formatPlanUA(value?: number | string | null): string | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  const cleaned = raw.replace(/[$,\s]/g, '');
  const num = Number(cleaned);
  if (cleaned !== '' && !Number.isNaN(num)) {
    return num.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }
  return raw;
}

export default function ShareRequestCard({ sr }: ShareRequestCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { data: documents, isLoading: docsLoading } = useMemberShareRequestDocuments(
    sr.ShareRequestId,
    expanded
  );

  const { stepIndex, terminalVariant } = mapShareRequestStatusToStep(sr.Status);
  const isTerminal = stepIndex === 3;

  const typeLabel = [sr.RequestTypeName, sr.SubType].filter(Boolean).join(' · ');
  const submittedFor = [sr.MemberFirstName, sr.MemberLastName].filter(Boolean).join(' ');

  // Total billed = live sum of the request's bills (server-computed). Only shown
  // once there are bills (no bills yet → nothing billed to display).
  const billed = sr.ComputedTotalBilled && sr.ComputedTotalBilled > 0
    ? formatUSD(sr.ComputedTotalBilled)
    : null;
  // "Your plan's unshared amount" = the member's plan UA (same value the care
  // team sees), not a per-request total.
  const planUa = formatPlanUA(sr.PlanUAValue);

  // Outcome copy for terminal states: prefer the care team's member-facing note,
  // otherwise a generic default per outcome.
  const genericOutcome =
    terminalVariant === 'denied'
      ? 'Your share request was denied.'
      : terminalVariant === 'withdrawn'
        ? 'Your share request was withdrawn.'
        : 'Your share request is complete.';
  const outcomeText = isTerminal
    ? (sr.MemberOutcomeNote && sr.MemberOutcomeNote.trim()) || genericOutcome
    : null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-900">{sr.RequestNumber}</span>
            {typeLabel && (
              <span className="text-sm text-gray-500">{typeLabel}</span>
            )}
          </div>
          <div className="text-sm text-gray-500 mt-0.5">
            Submitted {formatDate(sr.SubmittedDate)}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide details' : 'Show details'}
          className="shrink-0 p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-50"
        >
          {expanded ? (
            <ChevronUp className="w-5 h-5" />
          ) : (
            <ChevronDown className="w-5 h-5" />
          )}
        </button>
      </div>

      <div className="mt-5">
        <ShareRequestProgressBar status={sr.Status} />
      </div>

      {expanded && (
        <div className="mt-5 pt-5 border-t border-gray-100 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            {submittedFor && (
              <div>
                <div className="text-gray-500">Submitted for</div>
                <div className="text-gray-900">{submittedFor}</div>
              </div>
            )}
            <div>
              <div className="text-gray-500">Submitted date</div>
              <div className="text-gray-900">{formatDate(sr.SubmittedDate)}</div>
            </div>
            {billed && (
              <div>
                <div className="text-gray-500">Total billed</div>
                <div className="text-gray-900">{billed}</div>
              </div>
            )}
            {planUa && (
              <div>
                <div className="text-gray-500">Your plan's unshared amount (UA)</div>
                <div className="text-gray-900">{planUa}</div>
              </div>
            )}
          </div>

          {outcomeText && (
            <div
              className={`rounded-md p-3 text-sm ${
                terminalVariant === 'denied'
                  ? 'bg-red-50 text-red-800'
                  : terminalVariant === 'withdrawn'
                    ? 'bg-gray-50 text-gray-700'
                    : 'bg-oe-light text-oe-dark'
              }`}
            >
              <div className="font-medium mb-1">Outcome</div>
              <div className="whitespace-pre-line">{outcomeText}</div>
            </div>
          )}

          <div>
            <div className="text-sm font-medium text-gray-700 mb-2">Documents</div>
            {docsLoading ? (
              <div className="text-sm text-gray-400">Loading documents…</div>
            ) : documents && documents.length > 0 ? (
              <ul className="space-y-1.5">
                {documents.map((doc) => {
                  const href = doc.AuthenticatedUrl || doc.BlobUrl || undefined;
                  const name = doc.DocumentName || doc.FileName || 'Document';
                  return (
                    <li key={doc.DocumentId}>
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-sm text-oe-primary hover:text-oe-dark"
                      >
                        <FileText className="w-4 h-4 shrink-0" />
                        <span className="truncate">{name}</span>
                        <Download className="w-4 h-4 shrink-0" />
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="text-sm text-gray-400">No documents available.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

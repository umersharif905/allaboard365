import { useEffect, useState } from 'react';
import type { AxiosRequestConfig } from 'axios';
import { Check } from 'lucide-react';
import { apiService } from '../../../services/api.service';

export type OpenShareRequest = {
  ShareRequestId: string;
  RequestNumber: string;
  RequestType: string | null;
  Status: string;
  SubmittedDate: string | null;
};

export type LinkagePickerProps = {
  /** Member whose open SRs are listed. When null, picker shows an explainer. */
  memberId: string | null;
  /** Base for member-scoped lookups. Vendor: /api/me/vendor/members; tenant: /api/me/tenant-admin/members. */
  membersApiBase: string;
  /** Tenant-scope axios config passed through to api calls. */
  tenantReq: AxiosRequestConfig;
  /** Currently selected SR id (null for none). */
  selectedShareRequestId: string | null;
  /** Currently selected Case id (null for none — Cases not shippable yet). */
  selectedCaseId: string | null;
  /** Fires whenever the selection changes. Toggling an SR off passes both null. */
  onChange: (shareRequestId: string | null, caseId: string | null) => void;
  /** Optional sync of the fetched SRs so parents can render the selected one's
   * request number elsewhere without a second fetch. */
  onShareRequestsLoaded?: (rows: OpenShareRequest[]) => void;
};

/**
 * Two-column linkage picker shared between SendToMemberModal step 3
 * (per-send linkage) and the submission-detail Linkage panel
 * (retroactive linkage, Slice D). Open SRs on the left, Cases on the
 * right; Cases column is a placeholder until the Cases feature ships.
 */
export function LinkagePicker({
  memberId,
  membersApiBase,
  tenantReq,
  selectedShareRequestId,
  selectedCaseId: _selectedCaseId,
  onChange,
  onShareRequestsLoaded,
}: LinkagePickerProps) {
  const [openSrs, setOpenSrs] = useState<OpenShareRequest[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!memberId) {
      setOpenSrs([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await apiService.get<{ success: boolean; data: OpenShareRequest[] }>(
          `${membersApiBase}/${memberId}/open-share-requests`,
          tenantReq
        );
        if (!cancelled && res.success) {
          const rows = res.data || [];
          setOpenSrs(rows);
          onShareRequestsLoaded?.(rows);
        }
      } catch {
        if (!cancelled) {
          setOpenSrs([]);
          onShareRequestsLoaded?.([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [memberId, membersApiBase, tenantReq, onShareRequestsLoaded]);

  if (!memberId) {
    return (
      <p className="text-xs text-gray-500">
        Linkage requires a resolved member. Resolve the submission to a member first.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <p className="text-xs font-medium text-gray-600">Open share requests</p>
        <div className="rounded border border-gray-200">
          {loading ? (
            <p className="px-2 py-2 text-xs text-gray-500">Loading…</p>
          ) : openSrs.length === 0 ? (
            <p className="px-2 py-2 text-xs text-gray-500">No open share requests.</p>
          ) : (
            <ul className="divide-y divide-gray-100 max-h-48 overflow-y-auto">
              {openSrs.map((sr) => {
                const selected = selectedShareRequestId === sr.ShareRequestId;
                const openedLabel = sr.SubmittedDate
                  ? new Date(sr.SubmittedDate).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })
                  : '';
                return (
                  <li key={sr.ShareRequestId}>
                    <button
                      type="button"
                      onClick={() => onChange(selected ? null : sr.ShareRequestId, null)}
                      className={`block w-full px-2 py-1.5 text-left text-xs ${
                        selected ? 'bg-oe-light' : 'hover:bg-gray-50'
                      }`}
                    >
                      <span className="font-medium text-gray-800">{sr.RequestNumber}</span>{' '}
                      <span className="text-gray-500">
                        · {sr.RequestType || '—'} · {sr.Status}
                        {openedLabel && ` · opened ${openedLabel}`}
                      </span>
                      {selected && (
                        <Check className="ml-1 inline-block h-3 w-3 text-oe-primary" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-xs font-medium text-gray-600">Open cases</p>
        <div className="rounded border border-dashed border-gray-200 px-2 py-3">
          <p className="text-xs text-gray-500">
            Cases feature not yet available. This column will activate when Cases ship.
          </p>
        </div>
      </div>
    </div>
  );
}

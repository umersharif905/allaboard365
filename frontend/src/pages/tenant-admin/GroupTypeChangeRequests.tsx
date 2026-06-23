// frontend/src/pages/tenant-admin/GroupTypeChangeRequests.tsx
import { AlertCircle, CheckCircle, Clock, XCircle } from 'lucide-react';
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GroupBadge } from '../../components/groups/GroupBadge';
import {
  approve,
  deny,
  GroupTypeChangeRequest,
  listRequests,
} from '../../services/groupTypeChangeRequests.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TabStatus = 'Pending' | 'Approved' | 'Denied';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Approve Confirm Modal
// ---------------------------------------------------------------------------

interface ApproveModalProps {
  request: GroupTypeChangeRequest;
  onConfirm: (notes: string) => void;
  onCancel: () => void;
  isPending: boolean;
  overlayZIndexClass?: string;
}

function ApproveModal({
  request,
  onConfirm,
  onCancel,
  isPending,
  overlayZIndexClass = 'z-50',
}: ApproveModalProps) {
  const [notes, setNotes] = useState('');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="approve-modal-title"
      className={`fixed inset-0 ${overlayZIndexClass} flex items-center justify-center bg-black/40`}
    >
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-md p-6">
        <div className="flex items-center gap-3 mb-4">
          <CheckCircle size={20} className="text-oe-success shrink-0" />
          <h2 id="approve-modal-title" className="text-lg font-semibold text-gray-900">
            Confirm Approval
          </h2>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          You are approving the request to convert{' '}
          <strong>{(request as any).GroupName ?? request.GroupId}</strong> from{' '}
          <strong>{request.CurrentType}</strong> to <strong>{request.RequestedType}</strong>.
        </p>

        <div className="mb-5">
          <label
            htmlFor="approve-notes"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Notes <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <textarea
            id="approve-notes"
            rows={3}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-oe-primary"
            placeholder="Add optional notes for the agent…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(notes)}
            disabled={isPending}
            className="px-4 py-2 rounded-md text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark disabled:opacity-50"
          >
            {isPending ? 'Approving…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deny Modal
// ---------------------------------------------------------------------------

interface DenyModalProps {
  request: GroupTypeChangeRequest;
  onConfirm: (notes: string) => void;
  onCancel: () => void;
  isPending: boolean;
  overlayZIndexClass?: string;
}

function DenyModal({
  request,
  onConfirm,
  onCancel,
  isPending,
  overlayZIndexClass = 'z-50',
}: DenyModalProps) {
  const [notes, setNotes] = useState('');
  const isValid = notes.trim().length >= 5;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="deny-modal-title"
      className={`fixed inset-0 ${overlayZIndexClass} flex items-center justify-center bg-black/40`}
    >
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-md p-6">
        <div className="flex items-center gap-3 mb-4">
          <XCircle size={20} className="text-red-600 shrink-0" />
          <h2 id="deny-modal-title" className="text-lg font-semibold text-gray-900">
            Deny Request
          </h2>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          You are denying the request to convert{' '}
          <strong>{(request as any).GroupName ?? request.GroupId}</strong> from{' '}
          <strong>{request.CurrentType}</strong> to <strong>{request.RequestedType}</strong>.
        </p>

        <div className="mb-5">
          <label
            htmlFor="deny-notes"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Reason for denial <span className="text-red-500">*</span>
          </label>
          <textarea
            id="deny-notes"
            rows={4}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-oe-primary"
            placeholder="Explain why this request is being denied (minimum 5 characters)…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          {notes.length > 0 && notes.trim().length < 5 && (
            <p className="mt-1 text-xs text-red-600">Please enter at least 5 characters.</p>
          )}
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(notes.trim())}
            disabled={!isValid || isPending}
            className="px-4 py-2 rounded-md text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
          >
            {isPending ? 'Denying…' : 'Confirm Denial'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Request row
// ---------------------------------------------------------------------------

interface RequestRowProps {
  request: GroupTypeChangeRequest;
  tab: TabStatus;
  crossTenant: boolean;
  onApprove: (r: GroupTypeChangeRequest) => void;
  onDeny: (r: GroupTypeChangeRequest) => void;
}

function RequestRow({ request, tab, crossTenant, onApprove, onDeny }: RequestRowProps) {
  return (
    <tr className="border-t border-gray-100 hover:bg-gray-50">
      {crossTenant && (
        <td className="px-4 py-3 text-sm text-gray-600">
          {request.TenantName ?? request.TenantId}
        </td>
      )}
      <td className="px-4 py-3 text-sm text-gray-900 font-medium">
        {request.GroupName ?? request.GroupId}
      </td>
      <td className="px-4 py-3 text-sm text-gray-600">
        <span className="inline-flex items-center gap-1.5">
          <span>{request.CurrentType}</span>
          <span className="text-gray-400">→</span>
          <span>{request.RequestedType}</span>
          {request.RequestedType === 'ListBill' && (
            <GroupBadge type="ListBill" />
          )}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-gray-600">
        {request.RequestedByName ?? '—'}
      </td>
      <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate">
        {request.Reason ?? '—'}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">
        {formatDate(request.CreatedDate)}
      </td>
      {tab === 'Pending' && (
        <td className="px-4 py-3 text-sm whitespace-nowrap">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onApprove(request)}
              className="px-3 py-1 rounded text-xs font-medium text-white bg-oe-primary hover:bg-oe-dark"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => onDeny(request)}
              className="px-3 py-1 rounded text-xs font-medium text-red-600 border border-red-300 hover:bg-red-50"
            >
              Deny
            </button>
          </div>
        </td>
      )}
      {tab !== 'Pending' && (
        <td className="px-4 py-3 text-sm text-gray-500">
          {request.ReviewNotes ?? '—'}
        </td>
      )}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const TABS: TabStatus[] = ['Pending', 'Approved', 'Denied'];

const TAB_ICONS: Record<TabStatus, React.ReactNode> = {
  Pending: <Clock size={14} />,
  Approved: <CheckCircle size={14} />,
  Denied: <XCircle size={14} />,
};

interface GroupTypeChangeRequestsProps {
  /** When true: show a Tenant column and fetch with no tenant scope (SysAdmin view). */
  crossTenant?: boolean;
  /** Full page (default) vs content-only for embedding in a parent modal. */
  layout?: 'page' | 'embedded';
  /** z-index for approve/deny overlays; raise when this UI is inside another modal (e.g. `z-[110]`). */
  approveDenyOverlayZClass?: string;
}

const GroupTypeChangeRequests: React.FC<GroupTypeChangeRequestsProps> = ({
  crossTenant = false,
  layout = 'page',
  approveDenyOverlayZClass = 'z-50',
}) => {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabStatus>('Pending');
  const [approvingRequest, setApprovingRequest] = useState<GroupTypeChangeRequest | null>(null);
  const [denyingRequest, setDenyingRequest] = useState<GroupTypeChangeRequest | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // ── Data ──────────────────────────────────────────────────────────────────

  const queryKey = ['group-type-change-requests', activeTab, crossTenant];

  const { data: requests = [], isLoading, error } = useQuery({
    queryKey,
    queryFn: () => listRequests({ status: activeTab }),
  });

  // ── Mutations ─────────────────────────────────────────────────────────────

  const approveMutation = useMutation({
    mutationFn: ({ id, notes }: { id: string; notes: string }) => approve(id, notes || undefined),
    onSuccess: () => {
      setApprovingRequest(null);
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ['group-type-change-requests'] });
    },
    onError: (err: any) => {
      setActionError(err?.message ?? 'Failed to approve request. Please try again.');
    },
  });

  const denyMutation = useMutation({
    mutationFn: ({ id, notes }: { id: string; notes: string }) => deny(id, notes),
    onSuccess: () => {
      setDenyingRequest(null);
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ['group-type-change-requests'] });
    },
    onError: (err: any) => {
      setActionError(err?.message ?? 'Failed to deny request. Please try again.');
    },
  });

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleApproveConfirm(notes: string) {
    if (!approvingRequest) return;
    setActionError(null);
    approveMutation.mutate({ id: approvingRequest.RequestId, notes });
  }

  function handleDenyConfirm(notes: string) {
    if (!denyingRequest) return;
    setActionError(null);
    denyMutation.mutate({ id: denyingRequest.RequestId, notes });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const rootClass =
    layout === 'embedded'
      ? 'flex flex-col min-h-0 flex-1'
      : 'p-6';

  return (
    <div className={rootClass}>
      {/* Page header */}
      {layout === 'page' && (
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-gray-900">Group Type Change Requests</h1>
          <p className="mt-1 text-sm text-gray-500">
            Review and act on agent requests to convert groups between Standard and List Bill.
          </p>
        </div>
      )}

      {/* Inline action error */}
      {actionError && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-4" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => {
              setActiveTab(tab);
              setActionError(null);
            }}
            className={[
              'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              activeTab === tab
                ? 'border-oe-primary text-oe-primary'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300',
            ].join(' ')}
          >
            {TAB_ICONS[tab]}
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-gray-400 text-sm">
          Loading…
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle size={16} className="shrink-0" />
          <span>Failed to load requests. Please refresh and try again.</span>
        </div>
      ) : requests.length === 0 ? (
        <div className="py-16 text-center text-gray-400 text-sm">
          No {activeTab.toLowerCase()} requests.
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-left">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {crossTenant && (
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Tenant
                  </th>
                )}
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Group
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Type Change
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Agent
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Reason
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Requested
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {activeTab === 'Pending' ? 'Actions' : 'Notes'}
                </th>
              </tr>
            </thead>
            <tbody>
              {requests.map((req) => (
                <RequestRow
                  key={req.RequestId}
                  request={req}
                  tab={activeTab}
                  crossTenant={crossTenant}
                  onApprove={setApprovingRequest}
                  onDeny={setDenyingRequest}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Approve modal */}
      {approvingRequest && (
        <ApproveModal
          request={approvingRequest}
          onConfirm={handleApproveConfirm}
          onCancel={() => {
            setApprovingRequest(null);
            setActionError(null);
          }}
          isPending={approveMutation.isPending}
          overlayZIndexClass={approveDenyOverlayZClass}
        />
      )}

      {/* Deny modal */}
      {denyingRequest && (
        <DenyModal
          request={denyingRequest}
          onConfirm={handleDenyConfirm}
          onCancel={() => {
            setDenyingRequest(null);
            setActionError(null);
          }}
          isPending={denyMutation.isPending}
          overlayZIndexClass={approveDenyOverlayZClass}
        />
      )}
    </div>
  );
};

export default GroupTypeChangeRequests;

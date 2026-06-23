import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CalendarClock, Copy, Check, Send, Trash2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { apiService, withTenantScope } from '../../services/api.service';
import { usePublicFormsContext } from '../../hooks/usePublicFormsContext';
import { copyToClipboard } from '../../utils/clipboard';

type Invitation = {
  InvitationId: string;
  FormTemplateId: string;
  MemberId: string;
  Mode: string;
  LinkedShareRequestId: string | null;
  LinkedCaseId: string | null;
  ExpiresAt: string | null;
  FirstUsedAt: string | null;
  DeliveryMethod: string;
  RevokedAt: string | null;
  SentByUserId: string | null;
  SentToEmail: string | null;
  CreatedDate: string;
  SentByName: string | null;
  MemberName: string | null;
  SubmissionCount: number;
};

type Template = {
  FormTemplateId: string;
  Title: string;
  IsPublished: boolean;
};

type InvitationStatus = 'active' | 'used' | 'revoked' | 'expired';

function deriveStatus(i: Invitation): InvitationStatus {
  if (i.RevokedAt) return 'revoked';
  if (i.ExpiresAt && new Date(i.ExpiresAt).getTime() <= Date.now()) return 'expired';
  if (i.SubmissionCount > 0) return 'used';
  return 'active';
}

function formatDateTime(raw: string | null | undefined): string {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const STATUS_STYLES: Record<InvitationStatus, string> = {
  active: 'bg-green-50 text-green-800 border-green-200',
  used: 'bg-gray-100 text-gray-700 border-gray-200',
  revoked: 'bg-red-50 text-red-800 border-red-200',
  expired: 'bg-amber-50 text-amber-800 border-amber-200',
};

export default function TenantTemplateInvitationsPage() {
  const { formTemplateId } = useParams<{ formTemplateId: string }>();
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  const tenantReq = useMemo(() => withTenantScope(activeTenantId), [activeTenantId]);
  const { apiBase, routeBase } = usePublicFormsContext();

  const [template, setTemplate] = useState<Template | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [extendingId, setExtendingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const base =
    (typeof window !== 'undefined' && `${window.location.protocol}//${window.location.host}`) || '';

  const load = useCallback(async () => {
    if (!formTemplateId) return;
    setErr(null);
    try {
      const [tplRes, listRes] = await Promise.all([
        apiService.get<{ success: boolean; data: { template: Template } }>(
          `${apiBase}/templates/${formTemplateId}`,
          tenantReq
        ),
        apiService.get<{ success: boolean; data: Invitation[] }>(
          `${apiBase}/templates/${formTemplateId}/invitations`,
          tenantReq
        ),
      ]);
      if (tplRes.success) setTemplate(tplRes.data.template);
      if (listRes.success) setInvitations(listRes.data || []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to load invitations');
    }
  }, [apiBase, formTemplateId, tenantReq]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await load();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const handleExtend = async (i: Invitation) => {
    // Quick-set: push the expiry 7 days from now. A future iteration may
    // add a date picker; for now this matches the default-issue cadence.
    const next = new Date(Date.now() + 7 * 86400000).toISOString();
    setExtendingId(i.InvitationId);
    try {
      const res = await apiService.patch<{ success: boolean; data?: { expiresAt: string }; message?: string }>(
        `${apiBase}/invitations/${i.InvitationId}`,
        { expiresAt: next },
        tenantReq
      );
      if (!res.success || !res.data?.expiresAt) {
        window.alert(res.message || 'Failed to extend invitation.');
        return;
      }
      const newExp = res.data.expiresAt;
      setInvitations((prev) =>
        prev.map((row) =>
          row.InvitationId === i.InvitationId ? { ...row, ExpiresAt: newExp } : row
        )
      );
    } catch (e: unknown) {
      window.alert(e instanceof Error ? e.message : 'Failed to extend invitation.');
    } finally {
      setExtendingId(null);
    }
  };

  const handleRevoke = async (i: Invitation) => {
    if (
      !window.confirm(
        "Revoke this invitation? The recipient won't be able to open the form. Existing submissions are kept."
      )
    ) {
      return;
    }
    setRevokingId(i.InvitationId);
    try {
      await apiService.delete(`${apiBase}/invitations/${i.InvitationId}`, tenantReq);
      setInvitations((prev) =>
        prev.map((row) =>
          row.InvitationId === i.InvitationId
            ? { ...row, RevokedAt: new Date().toISOString() }
            : row
        )
      );
    } catch (e: unknown) {
      window.alert(e instanceof Error ? e.message : 'Failed to revoke invitation.');
    } finally {
      setRevokingId(null);
    }
  };

  const copyInvitationLink = async (i: Invitation) => {
    // Targeted/authenticated invitation URLs live under /forms/i/<token> on
    // the recipient side — but the token is never stored, so we can't show
    // a copy-link from the audit view. Fall back to copying the template's
    // public anonymous link if that mode is enabled; otherwise no-op.
    if (!formTemplateId) return;
    const ok = await copyToClipboard(`${base}/forms/${formTemplateId}`);
    if (ok) {
      setCopiedId(i.InvitationId);
      setTimeout(() => setCopiedId((id) => (id === i.InvitationId ? null : id)), 1500);
    }
  };

  if (loading) {
    return <div className="p-6 text-gray-600">Loading invitations…</div>;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Link
          to={routeBase}
          className="inline-flex items-center gap-1.5 text-sm text-oe-primary hover:text-oe-dark"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to forms
        </Link>
      </div>

      <div>
        <h1 className="text-xl font-semibold text-gray-900">
          Invitations — {template?.Title || 'Untitled form'}
        </h1>
        <p className="text-sm text-gray-500">
          Every invitation ever sent against this template. Newest first.
        </p>
      </div>

      {err && (
        <div className="rounded border border-red-200 bg-red-50 text-red-800 px-3 py-2 text-sm">
          {err}
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        {invitations.length === 0 ? (
          <div className="px-4 py-8 text-sm text-gray-500 text-center">
            No invitations have been sent for this template yet.
          </div>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-700">
              <tr>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">
                  Recipient
                </th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Mode</th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Sent</th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">
                  Status
                </th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">
                  Linked
                </th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">
                  Submissions
                </th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {invitations.map((i) => {
                const status = deriveStatus(i);
                const isActive = status === 'active';
                const recipient =
                  i.MemberName?.trim() ||
                  i.SentToEmail?.trim() ||
                  '—';
                return (
                  <tr key={i.InvitationId} className="hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900 truncate">{recipient}</div>
                      {i.MemberName && i.SentToEmail && (
                        <div className="text-xs text-gray-500 truncate">{i.SentToEmail}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-700">{i.Mode}</td>
                    <td className="px-3 py-2 text-gray-700">{formatDateTime(i.CreatedDate)}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${STATUS_STYLES[status]}`}
                      >
                        {status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-700">
                      {i.LinkedShareRequestId ? 'Share request' : '—'}
                    </td>
                    <td className="px-3 py-2 text-gray-700">{i.SubmissionCount}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-right">
                      {isActive && i.Mode === 'targeted' && (
                        <button
                          type="button"
                          onClick={() => copyInvitationLink(i)}
                          className="inline-flex items-center gap-1 text-xs text-oe-primary hover:text-oe-dark mr-2"
                        >
                          {copiedId === i.InvitationId ? (
                            <>
                              <Check className="h-3.5 w-3.5" /> Copied
                            </>
                          ) : (
                            <>
                              <Copy className="h-3.5 w-3.5" /> Copy
                            </>
                          )}
                        </button>
                      )}
                      {isActive && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleExtend(i)}
                            disabled={extendingId === i.InvitationId}
                            className="inline-flex items-center gap-1 text-xs text-oe-primary hover:bg-oe-light px-2 py-1 rounded disabled:opacity-50 mr-1"
                            title="Push the expiry out by 7 days"
                          >
                            <CalendarClock className="h-3.5 w-3.5" />
                            {extendingId === i.InvitationId ? 'Extending…' : 'Extend'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRevoke(i)}
                            disabled={revokingId === i.InvitationId}
                            className="inline-flex items-center gap-1 text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded disabled:opacity-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {revokingId === i.InvitationId ? 'Revoking…' : 'Revoke'}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {template && !template.IsPublished && (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 inline-flex items-center gap-1.5">
          <Send className="h-4 w-4" /> This template is not published yet, so new invitations
          targeting it will be rejected by the recipient flow.
        </p>
      )}
    </div>
  );
}

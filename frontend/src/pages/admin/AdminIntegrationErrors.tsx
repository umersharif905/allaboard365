import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ChevronLeft, Check, RotateCcw, Settings, X, Mail } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiService } from '../../services/api.service';

interface IntegrationErrorRow {
  integrationErrorId: string;
  category: string;
  source: string;
  severity: string;
  priority: 'normal' | 'high' | 'critical' | string;
  tenantId: string | null;
  message: string;
  detailJson: string | null;
  createdDate: string;
  notificationSentAt: string | null;
  resolved: boolean;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
}

interface ListResponse {
  success: boolean;
  data?: {
    rows: IntegrationErrorRow[];
    total: number;
    page: number;
    limit: number;
    migrationRequired?: boolean;
  };
  message?: string;
}

interface ResolveResponse {
  success: boolean;
  data?: {
    updated: boolean;
    resolved: boolean;
    resolvedAt: string | null;
    resolvedByUserId: string | null;
  };
  message?: string;
}

interface NotificationSettingsResponse {
  success: boolean;
  data?: {
    recipients: string;
    validEmails: string[];
    invalidEmails: string[];
  };
  message?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmailsInput(raw: string): { valid: string[]; invalid: string[] } {
  const parts = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (EMAIL_RE.test(p)) valid.push(p);
    else invalid.push(p);
  }
  return { valid, invalid };
}

// Priority → Tailwind badge. `normal` intentionally renders nothing so the common case stays
// visually quiet and the high/critical rows pop.
function priorityBadge(priority: string) {
  const p = (priority || 'normal').toLowerCase();
  if (p === 'critical') {
    return (
      <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-red-100 text-red-800">
        Critical
      </span>
    );
  }
  if (p === 'high') {
    return (
      <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-oe-light text-oe-dark">
        High
      </span>
    );
  }
  return null;
}

const AdminIntegrationErrors: React.FC = () => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<IntegrationErrorRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [migrationRequired, setMigrationRequired] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [includeResolved, setIncludeResolved] = useState(false);
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  const [notifModalOpen, setNotifModalOpen] = useState(false);
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifRecipients, setNotifRecipients] = useState('');
  const [notifError, setNotifError] = useState<string | null>(null);
  const [notifBanner, setNotifBanner] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (categoryFilter.trim()) q.set('category', categoryFilter.trim());
    if (includeResolved) q.set('includeResolved', 'true');
    apiService
      .get<ListResponse>(`/api/me/sysadmin/integration-errors?${q.toString()}`)
      .then((res) => {
        if (res.success && res.data) {
          setRows(res.data.rows || []);
          setTotal(res.data.total ?? 0);
          setMigrationRequired(res.data.migrationRequired === true);
        } else {
          setRows([]);
          setTotal(0);
          setError(res.message || 'Failed to load');
        }
      })
      .catch((e) => {
        setError(e?.message || 'Failed to load');
        setRows([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [page, limit, categoryFilter, includeResolved]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  // Optimistic: flip the row locally before the server round-trips so the list doesn't jump around
  // while the user is clicking through a bunch of rows. On error we reload to snap back to truth.
  const setResolved = useCallback(async (row: IntegrationErrorRow, resolved: boolean) => {
    setResolvingIds((prev) => {
      const next = new Set(prev);
      next.add(row.integrationErrorId);
      return next;
    });
    setRows((prev) =>
      prev.map((r) =>
        r.integrationErrorId === row.integrationErrorId
          ? { ...r, resolved, resolvedAt: resolved ? new Date().toISOString() : null }
          : r
      )
    );
    try {
      const path = resolved ? 'resolve' : 'unresolve';
      const res = await apiService.post<ResolveResponse>(
        `/api/me/sysadmin/integration-errors/${row.integrationErrorId}/${path}`,
        {}
      );
      if (!res?.success) {
        throw new Error(res?.message || 'Update failed');
      }
      // If hiding resolved and we just resolved, drop the row from the list so ops sees the change.
      if (resolved && !includeResolved) {
        setRows((prev) => prev.filter((r) => r.integrationErrorId !== row.integrationErrorId));
        setTotal((t) => Math.max(0, t - 1));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update resolution');
      load();
    } finally {
      setResolvingIds((prev) => {
        const next = new Set(prev);
        next.delete(row.integrationErrorId);
        return next;
      });
    }
  }, [includeResolved, load]);

  // Open modal: fetch current recipients so the textarea is pre-filled with the saved value.
  // Failures surface as a banner inside the modal so the user can still retry without losing context.
  const openNotificationModal = useCallback(async () => {
    setNotifModalOpen(true);
    setNotifError(null);
    setNotifBanner(null);
    setNotifLoading(true);
    try {
      const res = await apiService.get<NotificationSettingsResponse>(
        '/api/me/sysadmin/integration-errors/notification-settings'
      );
      if (res.success && res.data) {
        setNotifRecipients(res.data.recipients || '');
      } else {
        setNotifError(res.message || 'Failed to load recipients');
      }
    } catch (e) {
      setNotifError(e instanceof Error ? e.message : 'Failed to load recipients');
    } finally {
      setNotifLoading(false);
    }
  }, []);

  const saveNotificationRecipients = useCallback(async () => {
    const { invalid } = validateEmailsInput(notifRecipients);
    if (invalid.length > 0) {
      setNotifError(`Invalid email${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}`);
      return;
    }
    setNotifSaving(true);
    setNotifError(null);
    try {
      const res = await apiService.put<NotificationSettingsResponse>(
        '/api/me/sysadmin/integration-errors/notification-settings',
        { recipients: notifRecipients }
      );
      if (res.success && res.data) {
        const count = res.data.validEmails.length;
        setNotifRecipients(res.data.recipients);
        setNotifBanner(
          count === 0
            ? 'Digest disabled — no recipients configured.'
            : `Saved. ${count} recipient${count === 1 ? '' : 's'} will receive the next digest.`
        );
      } else {
        setNotifError(res.message || 'Failed to save recipients');
      }
    } catch (e) {
      setNotifError(e instanceof Error ? e.message : 'Failed to save recipients');
    } finally {
      setNotifSaving(false);
    }
  }, [notifRecipients]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <button
        type="button"
        onClick={() => navigate('/admin/dashboard')}
        className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900 mb-4"
      >
        <ChevronLeft className="h-4 w-4 mr-1" />
        Back to dashboard
      </button>
      <div className="flex items-start justify-between gap-4 mb-2">
        <h1 className="text-2xl font-semibold text-gray-900">Integration errors</h1>
        <button
          type="button"
          onClick={openNotificationModal}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 text-gray-700 bg-white rounded-lg hover:bg-gray-50"
          title="Configure who receives the every-15-minute digest email"
        >
          <Settings className="h-4 w-4" />
          Notification emails
        </button>
      </div>
      <p className="text-gray-600 mb-6">
        Payment webhooks and other integration failures recorded for review. Category{' '}
        <code className="text-sm bg-gray-100 px-1 rounded">payment_webhook</code> includes DIME webhook
        processing errors. High and critical rows fire an email digest every 15 minutes — use the{' '}
        <button
          type="button"
          onClick={openNotificationModal}
          className="text-oe-primary hover:text-oe-dark underline inline-flex items-center gap-1"
        >
          <Settings className="h-3.5 w-3.5" />
          Notification emails
        </button>{' '}
        button above to configure recipients.
      </p>

      {migrationRequired && (
        <div className="rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-900 p-4 mb-4 flex gap-2">
          <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Database migration required</p>
            <p className="text-sm mt-1">
              Run{' '}
              <code className="text-xs bg-yellow-100 px-1 rounded">
                sql-changes/2026-03-28-system-integration-errors.sql
              </code>{' '}
              to create{' '}
              <code className="text-xs bg-yellow-100 px-1 rounded">oe.SystemIntegrationErrors</code>.
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <label className="text-sm font-medium text-gray-700">
          Category filter
          <input
            type="text"
            value={categoryFilter}
            onChange={(e) => {
              setPage(1);
              setCategoryFilter(e.target.value);
            }}
            placeholder="e.g. payment_webhook"
            className="ml-2 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary text-sm min-w-[200px]"
          />
        </label>
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(e) => {
              setPage(1);
              setIncludeResolved(e.target.checked);
            }}
            className="rounded border-gray-300"
          />
          Show resolved
        </label>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50 text-sm"
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-4 mb-4 flex items-center gap-2">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Created</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Priority</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Category</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Source</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Tenant</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Message</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Detail</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Status</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    Loading...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    No errors recorded.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const busy = resolvingIds.has(r.integrationErrorId);
                  return (
                    <tr key={r.integrationErrorId} className={r.resolved ? 'bg-gray-50' : ''}>
                      <td className="px-4 py-2 text-sm text-gray-700 whitespace-nowrap">
                        {r.createdDate ? new Date(r.createdDate).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">{priorityBadge(r.priority)}</td>
                      <td className="px-4 py-2 text-sm text-gray-900">{r.category}</td>
                      <td className="px-4 py-2 text-sm text-gray-700">{r.source}</td>
                      <td className="px-4 py-2 text-xs font-mono text-gray-600">{r.tenantId ?? '—'}</td>
                      <td className="px-4 py-2 text-sm text-gray-900 max-w-md">{r.message}</td>
                      <td className="px-4 py-2 text-xs text-gray-600 max-w-lg break-words">
                        {r.detailJson ? (
                          <pre className="whitespace-pre-wrap font-mono text-[11px] max-h-40 overflow-y-auto">
                            {r.detailJson}
                          </pre>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {r.resolved ? (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                              <Check className="h-3 w-3" /> Resolved
                            </span>
                            <button
                              type="button"
                              onClick={() => setResolved(r, false)}
                              disabled={busy}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 text-gray-700 bg-white rounded-lg hover:bg-gray-50 disabled:opacity-50"
                              title="Mark as unresolved"
                            >
                              <RotateCcw className="h-3 w-3" />
                              Reopen
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setResolved(r, true)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50"
                          >
                            <Check className="h-3 w-3" />
                            {busy ? 'Saving…' : 'Resolve'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {total > limit && (
          <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between text-sm text-gray-600">
            <span>
              Page {page} of {totalPages} ({total} total)
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {notifModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="notif-modal-title"
          onClick={() => {
            if (!notifSaving) setNotifModalOpen(false);
          }}
        >
          <div
            className="bg-white rounded-lg border border-gray-200 w-full max-w-xl shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 id="notif-modal-title" className="text-lg font-medium text-gray-900 flex items-center gap-2">
                <Mail className="h-5 w-5 text-oe-primary" />
                Integration error digest recipients
              </h2>
              <button
                type="button"
                onClick={() => setNotifModalOpen(false)}
                disabled={notifSaving}
                className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-gray-600">
                Comma-separated list of email addresses that receive the every-15-minute digest for
                high and critical <code className="text-xs bg-gray-100 px-1 rounded">SystemIntegrationErrors</code>{' '}
                (DIME vault failures, webhook failures, etc.). Known user-resolvable errors like bank
                declines are not included. Leave blank to disable the digest.
              </p>
              <label className="block text-sm font-medium text-gray-700">
                Recipients
                <textarea
                  value={notifRecipients}
                  onChange={(e) => {
                    setNotifRecipients(e.target.value);
                    setNotifError(null);
                    setNotifBanner(null);
                  }}
                  disabled={notifLoading || notifSaving}
                  rows={3}
                  placeholder="improve@allaboard365.com, ops@allaboard365.com"
                  className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary text-sm font-mono disabled:bg-gray-50"
                />
              </label>
              {notifLoading && (
                <p className="text-sm text-gray-500">Loading current recipients…</p>
              )}
              {notifError && (
                <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-3 text-sm flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>{notifError}</span>
                </div>
              )}
              {notifBanner && !notifError && (
                <div className="rounded-lg bg-green-50 border border-green-200 text-green-800 p-3 text-sm flex items-start gap-2">
                  <Check className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>{notifBanner}</span>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 p-6 border-t border-gray-200">
              <button
                type="button"
                onClick={() => setNotifModalOpen(false)}
                disabled={notifSaving}
                className="px-4 py-2 text-sm border border-gray-300 text-gray-700 bg-white rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                Close
              </button>
              <button
                type="button"
                onClick={saveNotificationRecipients}
                disabled={notifLoading || notifSaving}
                className="px-4 py-2 text-sm bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50"
              >
                {notifSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminIntegrationErrors;

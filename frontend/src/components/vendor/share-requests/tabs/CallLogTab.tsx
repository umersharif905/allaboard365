import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert, Phone, PhoneIncoming, PhoneOutgoing, Plus, Trash2, X } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import Skeleton from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';

interface CallLogTabProps {
  shareRequestId: string;
}

interface CallLog {
  CallLogId: string;
  ShareRequestId?: string;
  Direction: 'Inbound' | 'Outbound';
  FromNumber?: string;
  ToNumber?: string;
  CallStartTime: string;
  CallEndTime?: string;
  Duration?: number;
  CallType: string;
  CallStatus?: string;
  CallNotes?: string;
  CallSummary?: string;
  CreatedDate: string;
  AgentFirstName?: string;
  AgentLastName?: string;
  CreatedByFirstName?: string;
  CreatedByLastName?: string;
}

interface CallLogsResponse {
  success: boolean;
  data: CallLog[];
}

const CALL_TYPES = ['General Inquiry', 'Status Update', 'Provider Coordination', 'Member Outreach', 'Other'];

const fmtDateTime = (v?: string) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const fmtDuration = (seconds?: number) => {
  if (!seconds) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
};

const emptyForm = {
  direction: 'Outbound' as 'Inbound' | 'Outbound',
  callType: 'General Inquiry',
  callStartTime: '',
  callEndTime: '',
  callerNumber: '',
  calleeNumber: '',
  callNotes: '',
  callSummary: '',
};

const CallLogTab = ({ shareRequestId }: CallLogTabProps) => {
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await apiService.get<CallLogsResponse>(
          `/api/me/vendor/share-requests/${shareRequestId}/call-logs`,
          signal ? { signal } : undefined
        );
        if (signal?.aborted) return;
        if (response.success) {
          const sorted = [...response.data].sort(
            (a, b) => new Date(b.CallStartTime).getTime() - new Date(a.CallStartTime).getTime()
          );
          setLogs(sorted);
        } else {
          setError('Failed to load call logs');
        }
      } catch (err) {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load call logs');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [shareRequestId]
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const handleSave = async () => {
    if (!form.callStartTime) {
      window.alert('Call start time is required');
      return;
    }
    const srId = shareRequestId;
    setSaving(true);
    try {
      const response = await apiService.post<{ success: boolean }>(
        `/api/me/vendor/share-requests/${srId}/call-logs`,
        {
          callType: form.callType,
          direction: form.direction,
          callStartTime: form.callStartTime,
          callEndTime: form.callEndTime || null,
          callerNumber: form.direction === 'Inbound' ? form.callerNumber : null,
          calleeNumber: form.direction === 'Outbound' ? form.calleeNumber : null,
          callNotes: form.callNotes,
          callSummary: form.callSummary,
        }
      );
      if (response.success) {
        setForm(emptyForm);
        setShowAdd(false);
        await load();
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to save call log');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (callLogId: string) => {
    if (!window.confirm('Delete this call log entry?')) return;
    const srId = shareRequestId;
    try {
      await apiService.delete(`/api/me/vendor/share-requests/${srId}/call-logs/${callLogId}`);
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to delete call log');
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Call Log</h2>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add call
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-red-600 text-sm">
          <CircleAlert className="h-4 w-4" />
          <span>{error}</span>
        </div>
      ) : logs.length === 0 ? (
        <EmptyState icon={Phone} title="No calls" description="Log the first call for this share request." tone="subtle" />
      ) : (
        <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <Th>Direction</Th>
                <Th>Number</Th>
                <Th>Start</Th>
                <Th>Duration</Th>
                <Th>Type</Th>
                <Th>Notes</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {logs.map((log) => {
                const number = log.Direction === 'Inbound' ? log.FromNumber : log.ToNumber;
                return (
                  <tr key={log.CallLogId}>
                    <Td>
                      <span className="inline-flex items-center gap-1.5">
                        {log.Direction === 'Inbound' ? (
                          <PhoneIncoming className="h-3.5 w-3.5 text-oe-primary" />
                        ) : (
                          <PhoneOutgoing className="h-3.5 w-3.5 text-gray-500" />
                        )}
                        {log.Direction}
                      </span>
                    </Td>
                    <Td className="font-mono text-[12px]">{number ?? '—'}</Td>
                    <Td>{fmtDateTime(log.CallStartTime)}</Td>
                    <Td>{fmtDuration(log.Duration)}</Td>
                    <Td>{log.CallType}</Td>
                    <Td className="max-w-[260px] truncate">{log.CallNotes ?? '—'}</Td>
                    <Td>
                      <button
                        type="button"
                        onClick={() => handleDelete(log.CallLogId)}
                        className="p-1 text-gray-400 hover:text-red-600 rounded"
                        aria-label="Delete call"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-call-title"
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowAdd(false);
          }}
        >
          <div className="w-full max-w-lg bg-white rounded-lg shadow-xl p-4 space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 id="add-call-title" className="text-base font-semibold text-gray-900">
                Log call
              </h3>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="p-1 text-gray-400 hover:text-gray-600 rounded"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Direction">
                <select
                  value={form.direction}
                  onChange={(e) =>
                    setForm({ ...form, direction: e.target.value as 'Inbound' | 'Outbound' })
                  }
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                >
                  <option value="Outbound">Outbound</option>
                  <option value="Inbound">Inbound</option>
                </select>
              </Field>
              <Field label="Type">
                <select
                  value={form.callType}
                  onChange={(e) => setForm({ ...form, callType: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                >
                  {CALL_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Start time">
                <input
                  type="datetime-local"
                  value={form.callStartTime}
                  onChange={(e) => setForm({ ...form, callStartTime: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
              <Field label="End time">
                <input
                  type="datetime-local"
                  value={form.callEndTime}
                  onChange={(e) => setForm({ ...form, callEndTime: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
              <Field
                label={form.direction === 'Inbound' ? 'Caller number' : 'Callee number'}
                className="col-span-2"
              >
                <input
                  type="tel"
                  value={form.direction === 'Inbound' ? form.callerNumber : form.calleeNumber}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      ...(form.direction === 'Inbound'
                        ? { callerNumber: e.target.value }
                        : { calleeNumber: e.target.value }),
                    })
                  }
                  placeholder="(555) 555-5555"
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded font-mono"
                />
              </Field>
              <Field label="Notes" className="col-span-2">
                <textarea
                  value={form.callNotes}
                  onChange={(e) => setForm({ ...form, callNotes: e.target.value })}
                  rows={3}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </Field>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const Th = ({ children }: { children?: ReactNode }) => (
  <th className="px-4 py-2 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wider">
    {children}
  </th>
);

const Td = ({ children, className = '' }: { children?: ReactNode; className?: string }) => (
  <td className={`px-4 py-2 text-gray-700 ${className}`}>{children}</td>
);

const Field = ({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) => (
  <div className={className}>
    <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
    {children}
  </div>
);

export default CallLogTab;

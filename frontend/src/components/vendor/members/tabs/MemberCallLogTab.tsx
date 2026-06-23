import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Phone, X } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import Skeleton from '../../ui/Skeleton';
import Spinner from '../../ui/Spinner';
import EmptyState from '../../ui/EmptyState';

interface CallLog {
  CallLogId: string;
  Direction: string;
  CallStatus?: string;
  CallerNumber?: string;
  CalleeNumber?: string;
  CallStartTime?: string;
  CallEndTime?: string;
  CallDurationSeconds?: number;
  CallNotes?: string;
  Source?: string;
  CreatedDate?: string;
  CreatedByName?: string;
}

interface MemberCallLogTabProps {
  memberId: string;
}

const formatDateTime = (raw?: string) => {
  if (!raw) return '';
  try {
    return new Date(raw).toLocaleString('en-US', {
      month: 'numeric',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return raw;
  }
};

const toLocalInput = (raw?: string) => {
  if (!raw) return '';
  const d = new Date(raw);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

interface CallFormState {
  direction: 'Inbound' | 'Outbound';
  phoneNumber: string;
  startTime: string;
  endTime: string;
  notes: string;
}

const blankForm = (): CallFormState => ({
  direction: 'Inbound',
  phoneNumber: '',
  startTime: toLocalInput(new Date().toISOString()),
  endTime: toLocalInput(new Date().toISOString()),
  notes: '',
});

const MemberCallLogTab = ({ memberId }: MemberCallLogTabProps) => {
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<'add' | 'edit' | null>(null);
  const [form, setForm] = useState<CallFormState>(blankForm());
  const [saving, setSaving] = useState(false);

  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await apiService.get<{ success: boolean; data: CallLog[] }>(
        `/api/me/vendor/members/${memberId}/call-logs`,
        signal ? { signal } : undefined
      );
      if (signal?.aborted) return;
      if (response.success) setCalls(response.data ?? []);
    } catch (err) {
      if (signal?.aborted) return;
      console.error('Error loading call logs:', err);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [memberId]);

  const openAdd = () => {
    setForm(blankForm());
    setModalMode('add');
  };

  const openEdit = () => {
    const call = calls.find((c) => c.CallLogId === selectedId);
    if (!call) return;
    setForm({
      direction: call.Direction === 'Outbound' ? 'Outbound' : 'Inbound',
      phoneNumber:
        (call.Direction === 'Outbound' ? call.CalleeNumber : call.CallerNumber) || '',
      startTime: toLocalInput(call.CallStartTime),
      endTime: toLocalInput(call.CallEndTime),
      notes: call.CallNotes ?? '',
    });
    setModalMode('edit');
  };

  const closeModal = () => {
    if (saving) return;
    setModalMode(null);
  };

  const submitForm = async () => {
    setSaving(true);
    try {
      const payload = {
        direction: form.direction,
        phoneNumber: form.phoneNumber,
        startTime: form.startTime ? new Date(form.startTime).toISOString() : undefined,
        endTime: form.endTime ? new Date(form.endTime).toISOString() : undefined,
        notes: form.notes,
      };
      if (modalMode === 'add') {
        await apiService.post(`/api/me/vendor/members/${memberId}/call-logs`, payload);
      } else if (modalMode === 'edit' && selectedId) {
        await apiService.put(
          `/api/me/vendor/members/${memberId}/call-logs/${selectedId}`,
          payload
        );
      }
      setModalMode(null);
      await load();
    } catch (err) {
      console.error('Error saving call log:', err);
      alert('Failed to save call log');
    } finally {
      setSaving(false);
    }
  };

  const deleteSelected = async () => {
    if (!selectedId) return;
    if (!confirm('Delete this call log entry?')) return;
    try {
      await apiService.delete(`/api/me/vendor/members/${memberId}/call-logs/${selectedId}`);
      setSelectedId(null);
      await load();
    } catch (err) {
      console.error('Error deleting call log:', err);
      alert('Failed to delete call log');
    }
  };

  return (
    <div className="p-6 flex flex-col h-full min-h-0 animate-fade-up">
      <div className="bg-white border border-gray-200 rounded-lg flex-1 min-h-0 overflow-auto shadow-soft">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                Phone Number
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                Direction
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                Start
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                End
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                Notes
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-100">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 5 }).map((_, j) => (
                    <td key={j} className="px-4 py-3">
                      <Skeleton className="h-4 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            ) : calls.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-0">
                  <EmptyState
                    icon={Phone}
                    title="No calls logged"
                    description="Use Add Call to record a manual call entry."
                  />
                </td>
              </tr>
            ) : (
              calls.map((c) => {
                const phone =
                  c.Direction === 'Outbound' ? c.CalleeNumber : c.CallerNumber;
                const isSelected = selectedId === c.CallLogId;
                const DirectionIcon = c.Direction === 'Outbound' ? ArrowUpRight : ArrowDownLeft;
                return (
                  <tr
                    key={c.CallLogId}
                    onClick={() => setSelectedId(c.CallLogId)}
                    className={`cursor-pointer text-sm transition-colors ${
                      isSelected
                        ? 'bg-oe-light/50'
                        : 'hover:bg-gray-50 active:bg-gray-100'
                    }`}
                  >
                    <td className="px-4 py-2.5 text-gray-900 font-medium">{phone || '-'}</td>
                    <td className="px-4 py-2.5 text-gray-700">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${
                          c.Direction === 'Outbound'
                            ? 'bg-blue-50 text-blue-700'
                            : 'bg-emerald-50 text-emerald-700'
                        }`}
                      >
                        <DirectionIcon className="h-3 w-3" />
                        {c.Direction}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">
                      {formatDateTime(c.CallStartTime)}
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">
                      {formatDateTime(c.CallEndTime)}
                    </td>
                    <td
                      className="px-4 py-2.5 text-gray-700 max-w-xs truncate"
                      title={c.CallNotes || ''}
                    >
                      {c.CallNotes || ''}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <p className="text-xs text-gray-500">Rows: {calls.length}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={openAdd}
            className="px-4 py-2 bg-oe-primary text-white text-sm font-medium rounded-md shadow-soft hover:bg-oe-dark hover:shadow-medium active:scale-[0.98] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-oe-primary focus-visible:ring-offset-2"
          >
            Add Call
          </button>
          <button
            type="button"
            onClick={openEdit}
            disabled={!selectedId}
            className="px-4 py-2 bg-oe-primary text-white text-sm font-medium rounded-md shadow-soft hover:bg-oe-dark hover:shadow-medium active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 disabled:hover:shadow-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-oe-primary focus-visible:ring-offset-2"
          >
            Edit Call
          </button>
          <button
            type="button"
            onClick={deleteSelected}
            disabled={!selectedId}
            className="px-4 py-2 bg-white border border-gray-300 text-red-600 text-sm font-medium rounded-md hover:bg-red-50 hover:border-red-200 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
          >
            Delete Call
          </button>
        </div>
      </div>

      {modalMode && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4 animate-backdrop-fade"
          onClick={closeModal}
        >
          <div
            className="bg-white rounded-lg shadow-large w-full max-w-md animate-modal-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">
                {modalMode === 'add' ? 'Add Call' : 'Edit Call'}
              </h3>
              <button
                type="button"
                onClick={closeModal}
                className="text-gray-400 hover:text-gray-600"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="block text-sm text-gray-700 mb-1">Direction</label>
                <select
                  value={form.direction}
                  onChange={(e) =>
                    setForm({ ...form, direction: e.target.value as 'Inbound' | 'Outbound' })
                  }
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="Inbound">Inbound</option>
                  <option value="Outbound">Outbound</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">Phone Number</label>
                <input
                  type="text"
                  value={form.phoneNumber}
                  onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="(555) 555-5555"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700 mb-1">Start</label>
                  <input
                    type="datetime-local"
                    value={form.startTime}
                    onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">End</label>
                  <input
                    type="datetime-local"
                    value={form.endTime}
                    onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={4}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50">
              <button
                type="button"
                onClick={closeModal}
                disabled={saving}
                className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-md bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitForm}
                disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 bg-oe-primary text-white text-sm font-medium rounded-md shadow-soft hover:bg-oe-dark hover:shadow-medium active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {saving && <Spinner size="xs" className="text-white" />}
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MemberCallLogTab;

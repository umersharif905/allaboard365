import { MessageSquare } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { messageHistoryService, type MessageHistory } from '../../../services/messageCenter.service';

/**
 * Agent variant of MemberCommunicationsTab. Same shape, swaps the recipient
 * source from `member.UserId` to a generic `userId` prop so an agent's
 * comms history can be surfaced in AgentManagementModal.
 */
interface Props {
  /** UserId for the agent (oe.Users.UserId). Same column oe.MessageHistory.RecipientId joins. */
  userId: string | null | undefined;
}

const STATUS_CLASSES: Record<string, string> = {
  Sent: 'bg-green-100 text-green-800',
  Delivered: 'bg-green-100 text-green-800',
  Opened: 'bg-green-100 text-green-800',
  Clicked: 'bg-green-100 text-green-800',
  Failed: 'bg-red-100 text-red-800',
  Bounced: 'bg-red-100 text-red-800',
  Sending: 'bg-yellow-100 text-yellow-700',
  Deferred: 'bg-yellow-100 text-yellow-700',
};

const AgentCommunicationsTab: React.FC<Props> = ({ userId }) => {
  const [items, setItems] = useState<MessageHistory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [viewingId, setViewingId] = useState<string | null>(null);

  const LIMIT = 20;

  const fetchHistory = useCallback(async (p: number, cancelled: { value: boolean }) => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await messageHistoryService.getHistory({
        recipientId: userId,
        page: p,
        limit: LIMIT,
      });
      if (cancelled.value) return;
      if (res.success && res.data) {
        const payload = res.data as unknown as {
          data: MessageHistory[];
          total?: number;
          totalPages?: number;
          pagination?: { totalPages: number; totalItems: number };
        };
        setItems(payload.data || []);
        setTotalPages(payload.totalPages ?? payload.pagination?.totalPages ?? 1);
        setTotalItems(payload.total ?? payload.pagination?.totalItems ?? 0);
      } else {
        setItems([]);
        setError(res.message || 'Could not load communications');
      }
    } catch (e) {
      if (!cancelled.value) {
        setItems([]);
        setError(e instanceof Error ? e.message : 'Could not load communications');
      }
    } finally {
      if (!cancelled.value) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    const cancelled = { value: false };
    fetchHistory(page, cancelled);
    return () => { cancelled.value = true; };
  }, [fetchHistory, page]);

  const handleView = async (item: MessageHistory) => {
    setViewingId(item.historyId);
    try {
      const res = await messageHistoryService.getDeliveryDetails(item.historyId);
      const body = (res.data as (typeof res.data) & { body?: string })?.body;
      if (!body) return;
      const win = window.open('', '_blank');
      if (!win) return;
      if (item.messageType === 'Email') {
        win.document.write(body);
      } else {
        win.document.write(`<pre style="font-family:sans-serif;padding:20px;white-space:pre-wrap">${body}</pre>`);
      }
      win.document.close();
    } finally {
      setViewingId(null);
    }
  };

  if (!userId) {
    return (
      <div className="p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="flex-shrink-0 h-10 w-10 rounded-lg bg-gray-100 flex items-center justify-center">
            <MessageSquare className="h-5 w-5 text-gray-600" />
          </div>
          <div>
            <h3 className="text-lg font-medium text-gray-900">Communications</h3>
            <p className="text-sm text-gray-600 mt-0.5">Emails and texts sent to this agent.</p>
          </div>
        </div>
        <p className="text-sm text-gray-500">Agent has no login account — no communications on record.</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-start gap-3 mb-4">
        <div className="flex-shrink-0 h-10 w-10 rounded-lg bg-gray-100 flex items-center justify-center">
          <MessageSquare className="h-5 w-5 text-gray-600" />
        </div>
        <div>
          <h3 className="text-lg font-medium text-gray-900">Communications</h3>
          <p className="text-sm text-gray-600 mt-0.5">Emails and texts sent to this agent.</p>
        </div>
      </div>

      {loading ? (
        <div className="animate-pulse space-y-2">
          <div className="h-10 bg-gray-100 rounded-lg" />
          <div className="h-10 bg-gray-100 rounded-lg" />
          <div className="h-10 bg-gray-100 rounded-lg" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500">No communications on record for this agent.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Sent At</th>
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Subject / Preview</th>
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Template</th>
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th scope="col" className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">View</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {items.map((item) => (
                  <tr key={item.historyId}>
                    <td className="px-4 py-2 text-sm text-gray-900 whitespace-nowrap">
                      {item.sentDate ? new Date(item.sentDate).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-700">{item.messageType}</td>
                    <td className="px-4 py-2 text-sm text-gray-800 max-w-[280px] truncate" title={item.subject || undefined}>
                      {item.subject || <span className="text-gray-400 italic">No subject</span>}
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-600 max-w-[160px] truncate" title={item.templateName || undefined}>
                      {item.templateName || '—'}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASSES[item.status] ?? 'bg-gray-100 text-gray-700'}`}>
                        {item.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => handleView(item)}
                        disabled={viewingId === item.historyId}
                        className="text-sm font-medium text-oe-primary hover:text-oe-dark disabled:opacity-50"
                      >
                        {viewingId === item.historyId ? (
                          <span className="h-4 w-4 inline-block animate-spin rounded-full border-2 border-gray-300 border-t-oe-primary" />
                        ) : (
                          'View'
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm text-gray-600">
              <span>{totalItems} total</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 border border-gray-300 rounded-md bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span>Page {page} of {totalPages}</span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="px-3 py-1.5 border border-gray-300 rounded-md bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AgentCommunicationsTab;

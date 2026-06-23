// File: MessageHistoryPage.tsx
// Path: frontend/src/pages/message-center/MessageHistoryPage.tsx

import { CheckCircle, ChevronLeft, ChevronRight, Clock, Download, Eye, History, Layers, Mail, MessageSquare, RefreshCw, Search, XCircle } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useTenants } from '../../hooks/useTenants';
import {
  messageHistoryService,
  messageQueueService,
  type MessageSendBatchRow,
} from '../../services/messageCenter.service';

// Types
interface MessageHistoryItem {
  historyId: string;
  messageId: string;
  tenantId: string;
  recipientId: string;
  recipientName: string;
  recipientAddress: string;
  messageType: 'Email' | 'SMS';
  subject?: string;
  status: 'Sent' | 'Sending' | 'Deferred' | 'Delivered' | 'Opened' | 'Failed' | string;
  providerMessageId?: string;
  errorMessage?: string;
  sentDate: string;
  templateName?: string;
  scheduleName?: string;
  batchId?: string | null;
  // Added in Stage 6: body preview + provider-event-derived status
  body?: string | null;
  fromAddress?: string | null;
  effectiveStatus?: string;
}

interface DeliveryEvent {
  event: string;
  timestamp: string;
  details?: string;
  provider?: string;
  mxServer?: string;
  eventType?: string;
}

function timelineDotClass(details?: string) {
  const d = (details || '').toLowerCase();
  if (d.includes('sendgrid bounce') || d.includes('sendgrid dropped') || d.includes('bounce_classification')) {
    return 'bg-red-500';
  }
  if (d.includes('sendgrid delivered')) {
    return 'bg-green-500';
  }
  if (d.includes('sendgrid deferred') || d.includes('sendgrid processed')) {
    return 'bg-amber-400';
  }
  if (d.includes('failed')) {
    return 'bg-red-500';
  }
  return 'bg-oe-primary';
}

const MessageHistoryPage: React.FC = () => {
  const [historyItems, setHistoryItems] = useState<MessageHistoryItem[]>([]);
  const [filteredItems, setFilteredItems] = useState<MessageHistoryItem[]>([]);
  const [selectedMessage, setSelectedMessage] = useState<MessageHistoryItem | null>(null);
  const [deliveryEvents, setDeliveryEvents] = useState<DeliveryEvent[]>([]);
  const [isDetailsModalOpen, setIsDetailsModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('All');
  const [filterType, setFilterType] = useState<'All' | 'Email' | 'SMS'>('All');
  const [filterTenant, setFilterTenant] = useState<string>('');
  const [dateRange, setDateRange] = useState({
    startDate: '',
    endDate: ''
  });
  const [isLoading, setIsLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(10);
  const [totalItems, setTotalItems] = useState(0);
  const [batches, setBatches] = useState<MessageSendBatchRow[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(false);
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  const currentRole = user?.currentRole || localStorage.getItem('currentRole');
  const isSysAdmin = currentRole === 'SysAdmin';
  const { data: tenants = [] } = useTenants(isSysAdmin);

  useEffect(() => {
    if (isSysAdmin && activeTenantId) {
      setFilterTenant(activeTenantId);
    }
  }, [isSysAdmin, activeTenantId]);

  // Stats
  const isDeliveredOk = (s: string) => s === 'Sent' || s === 'Delivered' || s === 'Opened';
  const stats = {
    total: historyItems.length,
    sent: historyItems.filter(m => isDeliveredOk(m.status)).length,
    failed: historyItems.filter(m => m.status === 'Failed').length,
    successRate: historyItems.length > 0
      ? Math.round((historyItems.filter(m => isDeliveredOk(m.status)).length / historyItems.length) * 100)
      : 0
  };

  const formatBatchProgress = (b: MessageSendBatchRow) => {
    const parts: string[] = [];
    if (b.smsTotal > 0) {
      const smsFailed = (b.smsQueueFailed || 0) + (b.smsHistoryFailed || 0);
      parts.push(
        `SMS ${b.smsSent}/${b.smsTotal} sent` +
          (smsFailed ? ` (${smsFailed} failed)` : '') +
          ((b.smsPending || 0) > 0 ? ` · ${b.smsPending} queued` : '')
      );
    }
    if (b.emailTotal > 0) {
      const emailFailed = (b.emailQueueFailed || 0) + (b.emailHistoryFailed || 0);
      parts.push(
        `Email ${b.emailSent}/${b.emailTotal} sent` +
          (emailFailed ? ` (${emailFailed} failed)` : '') +
          ((b.emailPending || 0) > 0 ? ` · ${b.emailPending} queued` : '')
      );
    }
    return parts.join(' · ') || '—';
  };

  const loadBatches = async () => {
    setLoadingBatches(true);
    try {
      const params: Record<string, string | number> = { page: 1, limit: 30 };
      if (filterTenant) params.tenantId = filterTenant;
      if (dateRange.startDate) params.startDate = dateRange.startDate;
      if (dateRange.endDate) params.endDate = dateRange.endDate;
      const res = await messageQueueService.getBatches(params);
      const payload = res.data as { data?: MessageSendBatchRow[] } | undefined;
      if (res.success && payload?.data && Array.isArray(payload.data)) {
        setBatches(payload.data);
      } else {
        setBatches([]);
      }
    } catch {
      setBatches([]);
    } finally {
      setLoadingBatches(false);
    }
  };

  const loadHistory = async () => {
    setIsLoading(true);
    try {
      const params: any = { page: currentPage, limit: itemsPerPage };
      if (filterStatus !== 'All') params.status = filterStatus;
      if (filterType !== 'All') params.messageType = filterType;
      if (filterTenant) params.tenantId = filterTenant;
      if (dateRange.startDate) params.startDate = dateRange.startDate;
      if (dateRange.endDate) params.endDate = dateRange.endDate;
      
      const res = await messageHistoryService.getHistory(params);
      if (res.success) {
        const payload = res.data;
        const rows = payload.data ?? [];
        const data: MessageHistoryItem[] = rows.map((m) => ({
          ...m,
          recipientName: m.recipientName ?? '',
        }));
        setHistoryItems(data);
        const t = payload.pagination?.totalItems;
        setTotalItems(typeof t === 'number' ? t : data.length);
      } else {
        setHistoryItems([]);
        setTotalItems(0);
      }
    } catch (e) {
      console.error('Failed to load history', e);
      setHistoryItems([]);
      setTotalItems(0);
    } finally {
      setIsLoading(false);
    }
  };

  // Set default date range to last 7 days
  useEffect(() => {
    if (!dateRange.startDate && !dateRange.endDate) {
      const today = new Date();
      const lastWeek = new Date();
      lastWeek.setDate(lastWeek.getDate() - 7);
      setDateRange({
        startDate: lastWeek.toISOString().split('T')[0],
        endDate: today.toISOString().split('T')[0]
      });
    }
  }, []);

  useEffect(() => { loadHistory(); }, [currentPage, filterStatus, filterType, filterTenant, dateRange]);

  useEffect(() => {
    loadBatches();
  }, [filterTenant, dateRange.startDate, dateRange.endDate]);

  // Reset to first page when filters change
  useEffect(() => {
    if (currentPage !== 1) {
      setCurrentPage(1);
    }
  }, [filterStatus, filterType, filterTenant, dateRange]);

  // Client-side search filter only (applied to current page data)
  useEffect(() => {
    let filtered = historyItems;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      filtered = filtered.filter(item =>
        (item.recipientName || '').toLowerCase().includes(q) ||
        item.recipientAddress.toLowerCase().includes(q) ||
        (item.subject && item.subject.toLowerCase().includes(q)) ||
        (item.errorMessage && item.errorMessage.toLowerCase().includes(q))
      );
    }
    setFilteredItems(filtered);
  }, [historyItems, searchTerm]);

  const handleViewDetails = async (item: MessageHistoryItem) => {
    setSelectedMessage(item);

    try {
      // Try to get detailed delivery events from API
      const detailsRes = await messageHistoryService.getDeliveryDetails(item.historyId);
      if (detailsRes.success && detailsRes.data) {
        const data = detailsRes.data as typeof detailsRes.data & {
          body?: string | null;
          fromAddress?: string | null;
          effectiveStatus?: string;
        };
        // Merge extra fields (body, fromAddress, effectiveStatus) into selectedMessage
        setSelectedMessage({
          ...item,
          body: data.body ?? null,
          fromAddress: data.fromAddress ?? null,
          effectiveStatus: data.effectiveStatus,
        });
        if (data.events) {
          setDeliveryEvents(data.events);
        } else {
          setDeliveryEvents([
            { event: 'Sent', timestamp: item.sentDate, details: `Sent via ${item.messageType}` },
            ...(item.status === 'Failed'
              ? [{ event: 'Failed', timestamp: item.sentDate, details: item.errorMessage || 'Message delivery failed' }]
              : []),
          ]);
        }
      } else {
        setDeliveryEvents([
          { event: 'Queued', timestamp: item.sentDate, details: `Submitted via ${item.messageType}` },
          ...(item.status === 'Failed'
            ? [{ event: 'Failed', timestamp: item.sentDate, details: item.errorMessage || 'Message delivery failed' }]
            : []),
        ]);
      }
    } catch (e) {
      // Fallback events if API call fails
      setDeliveryEvents([
        { event: 'Queued', timestamp: item.sentDate, details: `Submitted via ${item.messageType}` }
      ]);
    }

    setIsDetailsModalOpen(true);
  };

  const handleExport = async (format: 'csv' | 'excel') => {
    try {
      const params = {
        format,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        status: filterStatus !== 'All' ? filterStatus : undefined
      };
      const blob = await messageHistoryService.exportHistory(params);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `message-history-${new Date().toISOString().split('T')[0]}.${format === 'excel' ? 'xlsx' : 'csv'}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (e) {
      console.error('Export failed', e);
      alert('Export failed. Please try again.');
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Sent':
        return <Mail className="h-4 w-4 text-gray-500" />;
      case 'Delivered':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'Opened':
        return <Eye className="h-4 w-4 text-blue-500" />;
      case 'Deferred':
        return <Clock className="h-4 w-4 text-amber-500" />;
      case 'Sending':
        return <Clock className="h-4 w-4 text-amber-500" />;
      case 'Failed':
        return <XCircle className="h-4 w-4 text-red-500" />;
      default:
        return null;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Sent':
        return 'bg-gray-100 text-gray-800';
      case 'Delivered':
        return 'bg-green-100 text-green-800';
      case 'Opened':
        return 'bg-blue-100 text-blue-800';
      case 'Deferred':
        return 'bg-amber-100 text-amber-900';
      case 'Sending':
        return 'bg-amber-100 text-amber-900';
      case 'Failed':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Message History</h1>
          <p className="text-gray-600 mt-1">Track delivery status and engagement metrics</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => handleExport('csv')}
            className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-2"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
          <button
            onClick={() => handleExport('excel')}
            className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-2"
          >
            <Download className="h-4 w-4" />
            Export Excel
          </button>
        </div>
      </div>

      {/* Send batches — same progress view as Message Queue (large blasts = one row) */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm mb-6 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-medium text-gray-900">Send batches</h2>
          </div>
          <button
            type="button"
            onClick={() => loadBatches()}
            disabled={loadingBatches}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 flex items-center gap-1 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loadingBatches ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
        {loadingBatches && batches.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">Loading batches…</div>
        ) : batches.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">No send batches in this date range.</div>
        ) : (
          <ul className="divide-y divide-gray-200">
            {batches.map((b) => (
              <li key={b.batchId} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-gray-900">
                    {b.label || 'Send batch'}{' '}
                    {isSysAdmin && b.tenantName ? (
                      <span className="text-gray-500 font-normal">· {b.tenantName}</span>
                    ) : null}
                  </div>
                  <div className="text-sm text-gray-700 mt-0.5">{formatBatchProgress(b)}</div>
                  <div className="text-xs text-gray-400 mt-1">
                    {new Date(b.createdDate).toLocaleString()} · <span className="font-mono">{b.batchId.slice(0, 8)}…</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => loadBatches()}
                  className="self-start sm:self-center px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 flex items-center gap-1"
                >
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Sent</p>
              <p className="text-2xl font-semibold">{stats.total}</p>
            </div>
            <History className="h-8 w-8 text-gray-400" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Delivered</p>
              <p className="text-2xl font-semibold text-green-600">{stats.sent}</p>
            </div>
            <CheckCircle className="h-8 w-8 text-green-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Failed</p>
              <p className="text-2xl font-semibold text-red-600">{stats.failed}</p>
            </div>
            <XCircle className="h-8 w-8 text-red-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Success Rate</p>
              <p className="text-2xl font-semibold text-oe-primary">{stats.successRate}%</p>
            </div>
            <Eye className="h-8 w-8 text-blue-500" />
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <div className="flex-1 min-w-64">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search by recipient, subject, or template..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
              />
            </div>
          </div>
          
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
          >
            <option value="All">All Status</option>
            <option value="Sending">Sending</option>
            <option value="Sent">Sent</option>
            <option value="Deferred">Deferred</option>
            <option value="Delivered">Delivered</option>
            <option value="Opened">Opened</option>
            <option value="Failed">Failed</option>
          </select>
          
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as any)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
          >
            <option value="All">All Types</option>
            <option value="Email">Email</option>
            <option value="SMS">SMS</option>
          </select>

          {isSysAdmin && (
            <select
              value={filterTenant}
              onChange={(e) => setFilterTenant(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
            >
              <option value="">Current tenant</option>
              {tenants.map(tenant => (
                <option key={tenant.TenantId} value={tenant.TenantId}>
                  {tenant.Name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">From</label>
            <input
              type="date"
              value={dateRange.startDate}
              onChange={(e) => setDateRange({ ...dateRange, startDate: e.target.value })}
              className="w-full px-2 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">To</label>
            <input
              type="date"
              value={dateRange.endDate}
              onChange={(e) => setDateRange({ ...dateRange, endDate: e.target.value })}
              className="w-full px-2 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
            />
          </div>
        </div>
      </div>

      {/* History Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-gray-500">Loading...</div>
        ) : (
        <>
          <div className="overflow-auto" style={{ maxHeight: '600px' }}>
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Recipient
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Message
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Sent Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {filteredItems.map((item) => (
              <tr key={item.historyId} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div>
                    <div className="text-sm font-medium text-gray-900">{item.recipientName}</div>
                    <div className="text-sm text-gray-500 flex items-center">
                      {item.messageType === 'Email' ? (
                        <Mail className="h-3 w-3 mr-1" />
                      ) : (
                        <MessageSquare className="h-3 w-3 mr-1" />
                      )}
                      {item.recipientAddress}
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div>
                    {item.subject && (
                      <div className="text-sm font-medium text-gray-900 truncate max-w-xs">
                        {item.subject}
                      </div>
                    )}
                    <div className="text-sm text-gray-500">{item.templateName}</div>
                    {item.scheduleName && (
                      <div className="text-xs text-gray-400">via {item.scheduleName}</div>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {formatDate(item.sentDate)}
                </td>
                <td className="px-6 py-4">
                  <div className="flex flex-col gap-1 max-w-xs">
                    <div className="flex items-center whitespace-nowrap">
                      {getStatusIcon(item.status)}
                      <span className={`ml-2 px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(item.status)}`}>
                        {item.status}
                      </span>
                    </div>
                    {item.errorMessage ? (
                      <p className="text-xs text-gray-500 line-clamp-2" title={item.errorMessage}>
                        {item.errorMessage}
                      </p>
                    ) : null}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                  <button
                    onClick={() => handleViewDetails(item)}
                    className="text-oe-primary hover:text-blue-900 flex items-center gap-1"
                  >
                    <Eye className="h-4 w-4" />
                    Details
                  </button>
                </td>
              </tr>
            ))}
              </tbody>
            </table>
          </div>
          
          {/* Pagination Controls */}
          <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
            <div className="text-sm text-gray-700">
              Showing {Math.min((currentPage - 1) * itemsPerPage + 1, totalItems)} to {Math.min(currentPage * itemsPerPage, totalItems)} of {totalItems} results
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                disabled={currentPage === 1}
                className={`px-3 py-1 rounded-md text-sm ${
                  currentPage === 1 
                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed' 
                    : 'bg-white text-gray-700 hover:bg-gray-50 border border-gray-300'
                }`}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm text-gray-700">
                Page {currentPage} of {Math.ceil(totalItems / itemsPerPage)}
              </span>
              <button
                onClick={() => setCurrentPage(prev => Math.min(prev + 1, Math.ceil(totalItems / itemsPerPage)))}
                disabled={currentPage >= Math.ceil(totalItems / itemsPerPage)}
                className={`px-3 py-1 rounded-md text-sm ${
                  currentPage >= Math.ceil(totalItems / itemsPerPage)
                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed' 
                    : 'bg-white text-gray-700 hover:bg-gray-50 border border-gray-300'
                }`}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </>
        )}
      </div>

      {/* Details Modal */}
      {isDetailsModalOpen && selectedMessage && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-xl font-semibold">Message Delivery Details</h2>
            </div>
            
            <div className="p-6 space-y-6">
              {selectedMessage.status === 'Failed' && (() => {
                const failureEvent = [...deliveryEvents]
                  .reverse()
                  .find(e => {
                    const t = String(e.eventType || e.event || '').toLowerCase();
                    return t === 'bounce' || t === 'dropped' || t === 'blocked' || t === 'failed';
                  });
                const reason = failureEvent?.details || selectedMessage.errorMessage || 'No reason available from provider yet.';
                return (
                  <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4">
                    <div className="flex items-start gap-2">
                      <XCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-red-900">Delivery failed</p>
                        <p className="text-sm text-red-800 mt-1 break-words">{reason}</p>
                        {failureEvent?.eventType && failureEvent.eventType !== 'failed' && (
                          <p className="text-xs text-red-600 mt-1">SendGrid event: {failureEvent.eventType}</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
              {/* Message Info */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-gray-700">Message ID</label>
                  <p className="text-sm text-gray-900">{selectedMessage.messageId}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Provider ID</label>
                  <p className="text-sm text-gray-900">{selectedMessage.providerMessageId || 'N/A'}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Type</label>
                  <p className="text-sm text-gray-900">{selectedMessage.messageType}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Status</label>
                  <div className="flex items-center mt-1">
                    {getStatusIcon(selectedMessage.status)}
                    <span className={`ml-2 px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(selectedMessage.status)}`}>
                      {selectedMessage.status}
                    </span>
                  </div>
                </div>
              </div>
              
              <div>
                <label className="text-sm font-medium text-gray-700">Recipient</label>
                <p className="text-sm text-gray-900">{selectedMessage.recipientName}</p>
                <p className="text-sm text-gray-500">{selectedMessage.recipientAddress}</p>
              </div>
              
              {selectedMessage.subject && (
                <div>
                  <label className="text-sm font-medium text-gray-700">Subject</label>
                  <p className="text-sm text-gray-900">{selectedMessage.subject}</p>
                </div>
              )}
              
              {/* Delivery Timeline */}
              <div>
                <label className="text-sm font-medium text-gray-700 mb-2 block">Delivery Timeline</label>
                <div className="space-y-3">
                  {deliveryEvents.map((event, index) => (
                    <div key={index} className="flex items-start gap-3">
                      <div className={`w-2 h-2 rounded-full mt-1.5 ${
                        event.event === 'Failed' || event.event === 'Bounced'
                          ? 'bg-red-500'
                          : timelineDotClass(event.details)
                      }`} />
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-gray-900">{event.event}</span>
                          <span className="text-sm text-gray-500">{formatDate(event.timestamp)}</span>
                        </div>
                        {event.details && (
                          <p className="text-sm text-gray-600 mt-1">{event.details}</p>
                        )}
                        {(event.provider || event.mxServer) && (
                          <p className="text-xs text-gray-400 mt-0.5">
                            {event.provider ? `provider: ${event.provider}` : ''}
                            {event.provider && event.mxServer ? ' · ' : ''}
                            {event.mxServer ? `mx: ${event.mxServer}` : ''}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Body preview (sandboxed for Email, plain for SMS) */}
              {selectedMessage.messageType === 'Email' && selectedMessage.body && (
                <div>
                  <label className="text-sm font-medium text-gray-700 mb-2 block">Email Preview</label>
                  {selectedMessage.fromAddress && (
                    <p className="text-xs text-gray-500 mb-1">From: {selectedMessage.fromAddress}</p>
                  )}
                  {/*
                    CRITICAL: sandbox="" (empty attribute value) disables ALL iframe permissions
                    including script execution. Stored email bodies may contain untrusted HTML/JS
                    from template authors or third-party content — this is our XSS guard.
                  */}
                  <iframe
                    title="Email body preview"
                    sandbox=""
                    srcDoc={selectedMessage.body}
                    className="w-full border border-gray-300 rounded bg-gray-50"
                    style={{ height: 400 }}
                  />
                </div>
              )}
              {selectedMessage.messageType === 'SMS' && selectedMessage.body && (
                <div>
                  <label className="text-sm font-medium text-gray-700 mb-2 block">Message Text</label>
                  {selectedMessage.fromAddress && (
                    <p className="text-xs text-gray-500 mb-1">From: {selectedMessage.fromAddress}</p>
                  )}
                  <pre className="bg-gray-50 border border-gray-300 rounded p-3 text-sm whitespace-pre-wrap font-sans">{selectedMessage.body}</pre>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(selectedMessage.body || '')}
                    className="mt-2 px-3 py-1 border border-gray-300 rounded text-sm hover:bg-gray-50"
                  >
                    Copy text
                  </button>
                </div>
              )}
              {!selectedMessage.body && (
                <p className="text-sm text-gray-500 italic">Body not captured for this message.</p>
              )}

              {selectedMessage.errorMessage && (
                <div>
                  <label className="text-sm font-medium text-gray-700">
                    {selectedMessage.status === 'Failed' ? 'Error / provider details' : 'SendGrid / provider log'}
                  </label>
                  <pre
                    className={`text-sm p-3 rounded-lg mt-1 whitespace-pre-wrap font-sans border ${
                      selectedMessage.status === 'Failed'
                        ? 'text-red-800 bg-red-50 border-red-200'
                        : 'text-gray-800 bg-gray-50 border-gray-200'
                    }`}
                  >
                    {selectedMessage.errorMessage}
                  </pre>
                </div>
              )}
            </div>
            
            <div className="p-6 border-t border-gray-200 flex justify-end">
              <button
                onClick={() => setIsDetailsModalOpen(false)}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MessageHistoryPage;
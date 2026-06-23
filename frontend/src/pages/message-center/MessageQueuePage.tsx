// File: MessageQueuePage.tsx
// Path: frontend/src/pages/message-center/MessageQueuePage.tsx

import { AlertCircle, CheckCircle, ChevronLeft, ChevronRight, Clock, Eye, Layers, Mail, MessageSquare, RefreshCw, Search, Send, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useTenants } from '../../hooks/useTenants';
import { messageQueueService, type MessageSendBatchRow } from '../../services/messageCenter.service';

// Types
interface MessageQueueItem {
  messageId: string;
  tenantId: string;
  recipientId: string;
  recipientName: string;
  recipientAddress: string;
  messageType: 'Email' | 'SMS';
  subject?: string;
  body: string;
  status: 'Pending' | 'Processing' | 'Sent' | 'Failed';
  retryCount: number;
  errorMessage?: string;
  createdDate: string;
  processedDate?: string;
  scheduleName?: string;
  batchId?: string | null;
}

const MessageQueuePage: React.FC = () => {
  const [queueItems, setQueueItems] = useState<MessageQueueItem[]>([]);
  const [filteredItems, setFilteredItems] = useState<MessageQueueItem[]>([]);
  const [selectedMessage, setSelectedMessage] = useState<MessageQueueItem | null>(null);
  const [isDetailsModalOpen, setIsDetailsModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('All');
  const [filterType, setFilterType] = useState<'All' | 'Email' | 'SMS'>('All');
  const [isLoading, setIsLoading] = useState(false);
  const [filterTenant, setFilterTenant] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
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

  // Queue stats
  const stats = {
    total: queueItems.length,
    pending: queueItems.filter(m => m.status === 'Pending').length,
    processing: queueItems.filter(m => m.status === 'Processing').length,
    sent: queueItems.filter(m => m.status === 'Sent').length,
    failed: queueItems.filter(m => m.status === 'Failed').length
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
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
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

  const loadQueue = async () => {
    setIsLoading(true);
    try {
      const params: any = { page: currentPage, limit: itemsPerPage };
      if (filterStatus !== 'All') params.status = filterStatus;
      if (filterType !== 'All') params.messageType = filterType;
      if (filterTenant) params.tenantId = filterTenant;
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      const res = await messageQueueService.getQueueItems(params);
      if (res.success) {
        const data = res.data.data as any[];
        setQueueItems(data as MessageQueueItem[]);
        setTotalItems(res.data.pagination?.totalItems || data.length);
      } else {
        setQueueItems([]);
        setTotalItems(0);
      }
    } catch (e) {
      console.error('Failed to load queue', e);
      setQueueItems([]);
      setTotalItems(0);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadQueue(); }, [currentPage, filterStatus, filterType, filterTenant, startDate, endDate]);

  useEffect(() => {
    loadBatches();
  }, [filterTenant, startDate, endDate]);

  // Reset to first page when filters change
  useEffect(() => {
    if (currentPage !== 1) {
      setCurrentPage(1);
    }
  }, [filterStatus, filterType, filterTenant, startDate, endDate]);

  // Client-side search filter only (applied to current page data)
  useEffect(() => {
    let filtered = queueItems;
    if (searchTerm) {
      filtered = filtered.filter(item => 
        (item.recipientName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.recipientAddress.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (item.subject && item.subject.toLowerCase().includes(searchTerm.toLowerCase()))
      );
    }
    setFilteredItems(filtered);
  }, [queueItems, searchTerm]);

  const handleRetry = async (messageId: string) => {
    try {
      // Endpoint may not be implemented yet; try and fallback
      await (messageQueueService as any).retryMessage(messageId);
      await loadQueue();
    } catch (e) {
      alert('Retry not available yet.');
    }
  };

  const handleCancel = async (messageId: string) => {
    if (!window.confirm('Are you sure you want to cancel this message?')) return;
    try {
      await (messageQueueService as any).cancelMessage(messageId);
      await loadQueue();
    } catch (e) {
      alert('Cancel not available yet.');
    }
  };


  const handleRefresh = () => {
    loadQueue();
    loadBatches();
  };

  // Set default date range to 1 day ago
  useEffect(() => {
    if (!startDate && !endDate) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const today = new Date();
      setStartDate(yesterday.toISOString().split('T')[0]);
      setEndDate(today.toISOString().split('T')[0]);
    }
  }, []);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Pending':
        return <Clock className="h-4 w-4 text-yellow-500" />;
      case 'Processing':
        return <RefreshCw className="h-4 w-4 text-blue-500 animate-spin" />;
      case 'Sent':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'Failed':
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      default:
        return null;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'Processing':
        return 'bg-blue-100 text-blue-800';
      case 'Sent':
        return 'bg-green-100 text-green-800';
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
          <h1 className="text-2xl font-bold text-gray-900">Message Queue</h1>
          <p className="text-gray-600 mt-1">Monitor and manage pending messages</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isLoading}
          className={`px-4 py-2 rounded-lg flex items-center gap-2 ${
            isLoading ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-oe-primary text-white hover:bg-oe-primary-dark'
          }`}
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Send batches (e.g. message blast) — one row per batch with progress */}
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
          <div className="p-6 text-sm text-gray-500">No send batches in this date range (large blasts appear here as one row).</div>
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
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Messages</p>
              <p className="text-2xl font-semibold">{stats.total}</p>
            </div>
            <Send className="h-8 w-8 text-gray-400" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Pending</p>
              <p className="text-2xl font-semibold text-yellow-600">{stats.pending}</p>
            </div>
            <Clock className="h-8 w-8 text-yellow-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Processing</p>
              <p className="text-2xl font-semibold text-oe-primary">{stats.processing}</p>
            </div>
            <RefreshCw className="h-8 w-8 text-blue-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Sent</p>
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
            <AlertCircle className="h-8 w-8 text-red-500" />
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
                placeholder="Search messages..."
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
            <option value="Pending">Pending</option>
            <option value="Processing">Processing</option>
            <option value="Sent">Sent</option>
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
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full px-2 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">To</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full px-2 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
            />
          </div>
        </div>
      </div>

      {/* Queue Table */}
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
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Recipient
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Message
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Retries
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {filteredItems.map((item) => (
              <tr key={item.messageId} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center">
                    {getStatusIcon(item.status)}
                    <span className={`ml-2 px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(item.status)}`}>
                      {item.status}
                    </span>
                  </div>
                </td>
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
                  <div className="max-w-xs">
                    {item.subject && (
                      <div className="text-sm font-medium text-gray-900 truncate">{item.subject}</div>
                    )}
                    <div className="text-sm text-gray-500 truncate">{item.body}</div>
                    {item.scheduleName && (
                      <div className="text-xs text-gray-400 mt-1">From: {item.scheduleName}</div>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {formatDate(item.createdDate)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {item.retryCount}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setSelectedMessage(item);
                        setIsDetailsModalOpen(true);
                      }}
                      className="text-gray-600 hover:text-gray-900"
                      title="View Details"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                    {item.status === 'Failed' && (
                      <button
                        onClick={() => handleRetry(item.messageId)}
                        className="text-oe-primary hover:text-blue-900"
                        title="Retry"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                    )}
                    {(item.status === 'Pending' || item.status === 'Processing') && (
                      <button
                        onClick={() => handleCancel(item.messageId)}
                        className="text-red-600 hover:text-red-900"
                        title="Cancel"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
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
          <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200 flex justify-between items-center">
              <h2 className="text-xl font-semibold">Message Details</h2>
              <button
                onClick={() => setIsDetailsModalOpen(false)}
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-gray-700">Message ID</label>
                  <p className="text-sm text-gray-900">{selectedMessage.messageId}</p>
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
                <div>
                  <label className="text-sm font-medium text-gray-700">Type</label>
                  <p className="text-sm text-gray-900">{selectedMessage.messageType}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Retry Count</label>
                  <p className="text-sm text-gray-900">{selectedMessage.retryCount}</p>
                </div>
              </div>
              
              <div>
                <label className="text-sm font-medium text-gray-700">Recipient</label>
                <p className="text-sm text-gray-900">{selectedMessage.recipientName}</p>
                <p className="text-sm text-gray-500">{selectedMessage.recipientAddress}</p>
              </div>
              
              <div>
                <label className="text-sm font-medium text-gray-700">Created</label>
                <p className="text-sm text-gray-900">{new Date(selectedMessage.createdDate).toLocaleString()}</p>
              </div>
              
              {selectedMessage.processedDate && (
                <div>
                  <label className="text-sm font-medium text-gray-700">Processed</label>
                  <p className="text-sm text-gray-900">{new Date(selectedMessage.processedDate).toLocaleString()}</p>
                </div>
              )}
              
              {selectedMessage.errorMessage && (
                <div>
                  <label className="text-sm font-medium text-gray-700">Error Message</label>
                  <p className="text-sm text-red-600 bg-red-50 p-2 rounded">{selectedMessage.errorMessage}</p>
                </div>
              )}
              
              {selectedMessage.subject && (
                <div>
                  <label className="text-sm font-medium text-gray-700">Subject</label>
                  <p className="text-sm text-gray-900">{selectedMessage.subject}</p>
                </div>
              )}
              
              <div>
                <label className="text-sm font-medium text-gray-700">Message Body</label>
                <div className="text-sm text-gray-900 bg-gray-50 p-3 rounded whitespace-pre-wrap mt-1">
                  {selectedMessage.body}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MessageQueuePage;
// frontend/src/components/accounting/NACHAList.tsx
import { CheckCircle, Clock, Download, Eye, FileSpreadsheet, Info, Loader2, MoreVertical, RefreshCcw, Send, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NACHAValidationResponse, NACHAGeneration, nachaService } from '../../services/nachaService';
import { apiService } from '../../services/api.service';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
import { useAuth } from '../../contexts/AuthContext';
import SearchableDropdown from '../common/SearchableDropdown';
import NACHADetailsModal from './NACHADetailsModal';
import ExportVendorPayablesModal from './ExportVendorPayablesModal';
import RetryBouncesModal from './RetryBouncesModal';
import SendNACHAModal from './SendNACHAModal';

// Map raw payout types to compact column labels.
const formatPayoutTypeLabel = (payoutType?: string | null): string => {
  switch (payoutType) {
    case 'Agent Commission Payouts':
      return 'Commission';
    case 'Vendor Payouts':
      return 'Vendor';
    case 'Product Owner Payouts':
      return 'Product Owner';
    default:
      return payoutType?.replace(' Payouts', '') || 'N/A';
  }
};

interface NACHAListProps {
  refreshTrigger?: number;
  autoOpenNachaId?: string;
}

const NACHAList: React.FC<NACHAListProps> = ({ refreshTrigger = 0, autoOpenNachaId }) => {
  const { user } = useAuth();
  const isSysAdmin = user?.currentRole === 'SysAdmin';
  const activeTenantId = user?.currentTenantId || user?.tenantId;
  const [nachas, setNachas] = useState<NACHAGeneration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNacha, setSelectedNacha] = useState<NACHAGeneration | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [showLedgerValidation, setShowLedgerValidation] = useState(false);
  const [ledgerValidationLoading, setLedgerValidationLoading] = useState(false);
  const [ledgerValidationError, setLedgerValidationError] = useState<string | null>(null);
  const [ledgerValidationResult, setLedgerValidationResult] = useState<NACHAValidationResponse | null>(null);
  const [ledgerValidationTarget, setLedgerValidationTarget] = useState<{ nachaId: string; fileName: string } | null>(null);
  const [sendModalNacha, setSendModalNacha] = useState<NACHAGeneration | null>(null);
  const [retryModalNacha, setRetryModalNacha] = useState<NACHAGeneration | null>(null);
  const [exportPayablesNachaId, setExportPayablesNachaId] = useState<string | null>(null);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0
  });
  const [filters, setFilters] = useState({
    status: '',
    payoutType: '',
    startDate: '',
    endDate: '',
    vendorId: '',
    agentId: ''
  });
  const [vendorOptions, setVendorOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [agentOptions, setAgentOptions] = useState<
    Array<{ id: string; label: string; value: string; email?: string; sublabel?: string }>
  >([]);
  const [agentSelectionLabel, setAgentSelectionLabel] = useState<string>('');
  const [agentLoading, setAgentLoading] = useState(false);
  /** Only the latest agent search may update options (avoids stale results while typing). */
  const agentSearchSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<{
          success?: boolean;
          data?: Array<{ Id?: string; VendorName?: string }>;
        }>('/api/vendors?limit=500&page=1&sortBy=VendorName&sortOrder=ASC');
        const rows = Array.isArray(res?.data) ? res.data : [];
        if (!cancelled) {
          setVendorOptions(
            rows
              .map((r) => ({
                id: String(r.Id || '').trim(),
                name: String(r.VendorName || '').trim() || 'Vendor'
              }))
              .filter((r) => r.id)
          );
        }
      } catch {
        if (!cancelled) setVendorOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const bumpFilters = (patch: Partial<typeof filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPagination((p) => ({ ...p, page: 1 }));
  };

  const fetchAgents = useCallback(
    async (searchQuery: string) => {
      const requestId = ++agentSearchSeqRef.current;
      try {
        setAgentLoading(true);
        const response = await TenantAdminService.getTenantAgents({
          status: 'Active',
          search: searchQuery,
          limit: 50,
          ...(isSysAdmin && activeTenantId ? { tenantId: activeTenantId } : {})
        });

        if (requestId !== agentSearchSeqRef.current) return;

        if (response.success && response.data) {
          const uniqueRows = Array.from(
            new Map(response.data.map((row: any) => [row.Id, row])).values()
          );
          const opts = uniqueRows.map((row: any) => {
            const agency = (row.AgencyName || '').trim();
            return {
              id: row.Id,
              label: row.Name || 'Agent',
              value: row.Id,
              email: row.Email || '',
              sublabel: agency || undefined
            };
          });

          // Keep currently-selected agent visible even if it falls outside the search results.
          if (filters.agentId && !opts.find((o) => o.value === filters.agentId)) {
            opts.unshift({
              id: filters.agentId,
              label: agentSelectionLabel || 'Selected agent',
              value: filters.agentId,
              email: '',
              sublabel: undefined
            });
          }

          setAgentOptions(opts);
        }
      } catch (err) {
        console.error('Error fetching agents for NACHA filter:', err);
      } finally {
        if (requestId === agentSearchSeqRef.current) {
          setAgentLoading(false);
        }
      }
    },
    [isSysAdmin, activeTenantId, filters.agentId, agentSelectionLabel]
  );

  useEffect(() => {
    fetchNachas();
  }, [pagination.page, filters, refreshTrigger]);

  // Close menu when clicking outside and update position if window resizes
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!openMenuId) return;
      
      const target = event.target as HTMLElement;
      const isClickInMenu = target.closest('[data-nacha-menu]');
      const isClickInButton = menuButtonRefs.current[openMenuId]?.contains(target);
      
      if (!isClickInMenu && !isClickInButton) {
        setOpenMenuId(null);
        setMenuPosition(null);
      }
    };
    const handleResize = () => {
      if (openMenuId) {
        const button = menuButtonRefs.current[openMenuId];
        if (button) {
          const rect = button.getBoundingClientRect();
          setMenuPosition({ x: rect.right - 192, y: rect.bottom + 4 });
        }
      }
    };
    document.addEventListener('click', handleClickOutside);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize);
    return () => {
      document.removeEventListener('click', handleClickOutside);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize);
    };
  }, [openMenuId]);

  const fetchNachas = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await nachaService.listNACHAs({
        page: pagination.page,
        limit: pagination.limit,
        status: filters.status || undefined,
        payoutType: filters.payoutType || undefined,
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
        vendorId: filters.vendorId || undefined,
        agentId: filters.agentId || undefined
      });
      setNachas(response.nachas);
      setPagination(prev => ({
        ...prev,
        total: response.pagination.total,
        totalPages: response.pagination.totalPages
      }));
    } catch (err: any) {
      setError(err.message || 'Failed to fetch NACHA files');
    } finally {
      setLoading(false);
    }
  };

  // Auto-open details modal for newly generated NACHA
  useEffect(() => {
    if (autoOpenNachaId && nachas.length > 0) {
      const nachaToOpen = nachas.find(n => n.nachaId === autoOpenNachaId);
      if (nachaToOpen) {
        setSelectedNacha(nachaToOpen);
        setShowDetails(true);
      }
    }
  }, [autoOpenNachaId, nachas]);

  const handleDownload = async (nacha: NACHAGeneration) => {
    try {
      await nachaService.downloadNACHA(nacha.nachaId, nacha.fileName);
    } catch (err: any) {
      alert(err.message || 'Failed to download NACHA file');
    }
  };

  const handleDelete = async (nacha: NACHAGeneration) => {
    if (nacha.status !== 'Pending') {
      alert('Only pending NACHA files can be deleted');
      return;
    }

    if (!confirm(`Are you sure you want to delete ${nacha.fileName}?`)) {
      return;
    }

    try {
      await nachaService.deleteNACHA(nacha.nachaId);
      fetchNachas();
    } catch (err: any) {
      alert(err.message || 'Failed to delete NACHA file');
    }
  };

  const handleMarkAsSent = async (nacha: NACHAGeneration) => {
    if (!confirm(`Mark ${nacha.fileName} as paid? This action cannot be undone and will update payment records.`)) {
      return;
    }

    try {
      await nachaService.markNACHAasSent(nacha.nachaId);
      fetchNachas();
    } catch (err: any) {
      alert(err.message || 'Failed to mark NACHA as paid');
    }
  };

  const handleMarkAsNotSent = async (nacha: NACHAGeneration) => {
    if (!confirm(`Mark ${nacha.fileName} as NOT sent? This will revert it to Pending and remove payment records.`)) {
      return;
    }

    try {
      await nachaService.markNACHAasNotSent(nacha.nachaId);
      fetchNachas();
    } catch (err: any) {
      alert(err.message || 'Failed to mark NACHA as not sent');
    }
  };

  const handleValidateNacha = async (nacha: NACHAGeneration) => {
    setLedgerValidationLoading(true);
    setLedgerValidationError(null);
    setLedgerValidationResult(null);
    setLedgerValidationTarget({ nachaId: nacha.nachaId, fileName: nacha.fileName });
    setShowLedgerValidation(true);
    try {
      const result = await nachaService.validateLedger({
        nachaId: nacha.nachaId,
        status: nacha.status
      });
      setLedgerValidationResult(result);
    } catch (e: any) {
      setLedgerValidationError(e?.message || 'Failed to validate NACHA ledger');
    } finally {
      setLedgerValidationLoading(false);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  };

  // Import formatDate from helpers - calendar dates need special handling
  const formatDate = (dateString: string, isTimestamp: boolean = false) => {
    if (!dateString) return '';
    
    try {
      if (isTimestamp) {
        // Timestamps (generatedDate) - use timezone conversion
        return new Date(dateString).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        });
      } else {
        // Calendar dates (startDate, endDate) - parse date parts to avoid timezone issues
        // Server returns UTC dates like "2025-11-05T00:00:00Z"
        const [datePart] = dateString.split('T');
        const [year, month, day] = datePart.split('-');
        const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        return date.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        });
      }
    } catch (error) {
      console.error('Error formatting date:', error);
      return dateString;
    }
  };

  const getStatusBadge = (status: string) => {
    if (status === 'Sent') {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-800">
          <CheckCircle size={12} className="mr-1" />
          Sent
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
        <Clock size={12} className="mr-1" />
        Pending
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select
              value={filters.status}
              onChange={(e) => bumpFilters({ status: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
            >
              <option value="">All Statuses</option>
              <option value="Pending">Pending</option>
              <option value="Sent">Sent</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Payout Type</label>
            <select
              value={filters.payoutType}
              onChange={(e) => bumpFilters({ payoutType: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
            >
              <option value="">All Types</option>
              <option value="Agent Commission Payouts">Agent Commissions</option>
              <option value="Vendor Payouts">Vendor Payouts</option>
              <option value="Product Owner Payouts">Product Override Distributions</option>
            </select>
          </div>
          <div className="lg:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Agent in file</label>
            <SearchableDropdown
              options={agentOptions}
              value={filters.agentId}
              onChange={(value, label) => {
                setAgentSelectionLabel(label || '');
                bumpFilters({ agentId: value });
              }}
              placeholder="All agents"
              searchPlaceholder="Search agents..."
              loading={agentLoading}
              showEmail
              showSublabel
              useBackendSearch
              onSearch={fetchAgents}
            />
            <p className="text-xs text-gray-500 mt-1">
              NACHA files that include a payout line to this agent or agency.
            </p>
          </div>
          <div className="lg:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Vendor in file</label>
            <select
              value={filters.vendorId}
              onChange={(e) => bumpFilters({ vendorId: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
            >
              <option value="">All vendors</option>
              {vendorOptions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              NACHA files that include a payout line to this vendor.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
            <input
              type="date"
              value={filters.startDate}
              onChange={(e) => bumpFilters({ startDate: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
            <input
              type="date"
              value={filters.endDate}
              onChange={(e) => bumpFilters({ endDate: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={() => {
                setFilters({ status: '', payoutType: '', startDate: '', endDate: '', vendorId: '', agentId: '' });
                setAgentSelectionLabel('');
                setPagination((p) => ({ ...p, page: 1 }));
              }}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Clear Filters
            </button>
          </div>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* NACHA Files Table */}
      {loading ? (
        <div className="text-center py-12">
          <RefreshCcw className="animate-spin h-8 w-8 text-oe-primary mx-auto mb-4" />
          <p className="text-gray-600">Loading NACHA files...</p>
        </div>
      ) : nachas.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <p className="text-gray-600">No NACHA files found</p>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    File Name
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Date Range
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Payouts
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Amount
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Generated
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {nachas.map((nacha) => (
                  <tr key={nacha.nachaId} className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-sm font-medium text-gray-900 max-w-md">
                      <div className="truncate" title={nacha.fileName}>
                        {nacha.fileName}
                      </div>
                      {nacha.reissueOfNachaId ? (() => {
                        const originalFileName = nachas.find(n => n.nachaId === nacha.reissueOfNachaId)?.fileName;
                        const shortId = (nacha.reissueOfNachaId || '').slice(0, 8).toUpperCase();
                        const badgeLabel = originalFileName
                          ? `Retry of ${originalFileName}`
                          : `Retry of NACHA-${shortId}`;
                        return (
                          <div className="mt-1">
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-800"
                              title={badgeLabel}
                            >
                              <RefreshCcw size={10} />
                              {badgeLabel}
                            </span>
                          </div>
                        );
                      })() : null}
                      {nacha.vendorNames && nacha.vendorNames.length > 0 ? (
                        <div
                          className="text-xs font-normal text-gray-500 mt-0.5 line-clamp-2"
                          title={nacha.vendorNames.join(', ')}
                        >
                          Vendors: {nacha.vendorNames.join(', ')}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatPayoutTypeLabel(nacha.payoutType)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {nacha.startDate && nacha.endDate
                        ? `${formatDate(nacha.startDate)} - ${formatDate(nacha.endDate)}`
                        : 'N/A'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {nacha.totalPayouts}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {formatCurrency(nacha.totalAmount)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {getStatusBadge(nacha.status)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatDate(nacha.generatedDate, true)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center justify-end">
                        <div className="relative inline-block">
                          <button
                            ref={(el) => { menuButtonRefs.current[nacha.nachaId] = el; }}
                            onClick={() => {
                              const newOpenId = nacha.nachaId === openMenuId ? null : nacha.nachaId;
                              setOpenMenuId(newOpenId);
                              if (newOpenId) {
                                const button = menuButtonRefs.current[newOpenId];
                                if (button) {
                                  const rect = button.getBoundingClientRect();
                                  setMenuPosition({ x: rect.right - 192, y: rect.bottom + 4 });
                                }
                              } else {
                                setMenuPosition(null);
                              }
                            }}
                            className="text-gray-600 hover:text-gray-900 p-1"
                            title="Actions"
                          >
                            <MoreVertical size={16} />
                          </button>
                          {openMenuId === nacha.nachaId && menuPosition && createPortal(
                            <div 
                              data-nacha-menu
                              className="fixed w-48 bg-white rounded-lg shadow-lg border border-gray-200 z-50"
                              style={{ top: menuPosition.y, left: menuPosition.x }}
                            >
                              <div className="py-1">
                                <button
                                  onClick={() => {
                                    console.log('👁️ View Details clicked, nacha:', nacha);
                                    const nachaId = (nacha as any).nachaId || (nacha as any).NACHAId;
                                    if (!nacha || !nachaId) {
                                      console.error('❌ NACHA object missing nachaId:', nacha);
                                      alert('NACHA ID is missing');
                                      return;
                                    }
                                    setSelectedNacha(nacha);
                                    setShowDetails(true);
                                    setOpenMenuId(null);
                                    setMenuPosition(null);
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                                >
                                  <Eye size={16} />
                                  View Details
                                </button>
                                <button
                                  onClick={() => {
                                    handleDownload(nacha);
                                    setOpenMenuId(null);
                                    setMenuPosition(null);
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                                >
                                  <Download size={16} />
                                  Download
                                </button>
                                {nacha.payoutType === 'Vendor Payouts' && (
                                  <button
                                    onClick={() => {
                                      const nachaId = nacha.nachaId || (nacha as any).NACHAId;
                                      if (!nachaId) {
                                        alert('NACHA ID is missing');
                                        return;
                                      }
                                      setExportPayablesNachaId(nachaId);
                                      setOpenMenuId(null);
                                      setMenuPosition(null);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm text-blue-700 hover:bg-blue-50 flex items-center gap-2"
                                  >
                                    <FileSpreadsheet size={16} />
                                    Export Payables
                                  </button>
                                )}
                                {nacha.status === 'Pending' && (
                                  <>
                                    <button
                                      onClick={() => {
                                        setSendModalNacha(nacha);
                                        setOpenMenuId(null);
                                        setMenuPosition(null);
                                      }}
                                      className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                                    >
                                      <Send size={16} />
                                      Send
                                    </button>
                                    <button
                                      onClick={() => {
                                        handleMarkAsSent(nacha);
                                        setOpenMenuId(null);
                                        setMenuPosition(null);
                                      }}
                                      className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                                    >
                                      <CheckCircle size={16} />
                                      Mark as paid
                                    </button>
                                    <button
                                      onClick={() => {
                                        handleDelete(nacha);
                                        setOpenMenuId(null);
                                        setMenuPosition(null);
                                      }}
                                      className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                                    >
                                      <Trash2 size={16} />
                                      Delete
                                    </button>
                                  </>
                                )}
                                {nacha.status === 'Sent' && (
                                  <>
                                    <button
                                      onClick={() => {
                                        setRetryModalNacha(nacha);
                                        setOpenMenuId(null);
                                        setMenuPosition(null);
                                      }}
                                      className="w-full px-4 py-2 text-left text-sm text-purple-700 hover:bg-purple-50 flex items-center gap-2"
                                      title="Generate a new NACHA file paying selected recipients again, using their current banking info"
                                    >
                                      <RefreshCcw size={16} />
                                      Retry Bounces
                                    </button>
                                    <button
                                      onClick={() => {
                                        handleMarkAsNotSent(nacha);
                                        setOpenMenuId(null);
                                        setMenuPosition(null);
                                      }}
                                      className="w-full px-4 py-2 text-left text-sm text-yellow-600 hover:bg-yellow-50 flex items-center gap-2"
                                    >
                                      <RefreshCcw size={16} />
                                      Mark as Not Sent
                                    </button>
                                  </>
                                )}
                                <button
                                  onClick={() => {
                                    handleValidateNacha(nacha);
                                    setOpenMenuId(null);
                                    setMenuPosition(null);
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                                >
                                  <Info size={16} />
                                  Check for issues
                                </button>
                              </div>
                            </div>,
                            document.body
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-600">
                Showing {((pagination.page - 1) * pagination.limit) + 1} to{' '}
                {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} files
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPagination({ ...pagination, page: pagination.page - 1 })}
                  disabled={pagination.page === 1}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span className="px-4 py-2 text-sm text-gray-700">
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <button
                  onClick={() => setPagination({ ...pagination, page: pagination.page + 1 })}
                  disabled={pagination.page >= pagination.totalPages}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {exportPayablesNachaId && (
        <ExportVendorPayablesModal
          nachaId={exportPayablesNachaId}
          isOpen={!!exportPayablesNachaId}
          onClose={() => setExportPayablesNachaId(null)}
        />
      )}

      {/* Details Modal */}
      {showDetails && selectedNacha && (
        <NACHADetailsModal
          nacha={selectedNacha}
          isOpen={showDetails}
          onClose={() => {
            setShowDetails(false);
            setSelectedNacha(null);
          }}
          onStatusChange={fetchNachas}
        />
      )}

      {/* Send NACHA Modal */}
      {sendModalNacha && (
        <SendNACHAModal
          nacha={sendModalNacha}
          isOpen={!!sendModalNacha}
          onClose={() => setSendModalNacha(null)}
          onSuccess={fetchNachas}
        />
      )}

      {/* Retry Bounces Modal */}
      {retryModalNacha && (
        <RetryBouncesModal
          nacha={retryModalNacha}
          isOpen={!!retryModalNacha}
          onClose={() => setRetryModalNacha(null)}
          onSuccess={async (newNachaId) => {
            setRetryModalNacha(null);
            // Refresh list, then auto-open the newly generated retry NACHA in details modal
            await fetchNachas();
            try {
              const fresh = await nachaService.getNACHADetails(newNachaId);
              setSelectedNacha(fresh);
              setShowDetails(true);
            } catch {
              // Refresh already happened; user can click the new row manually if details fetch fails
            }
          }}
        />
      )}

      {/* Ledger Validation Modal (per generated NACHA) */}
      {showLedgerValidation && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[90]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl mx-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">NACHA Check for Issues</h3>
                <p className="text-sm text-gray-600 mt-1">
                  {ledgerValidationTarget ? (
                    <>
                      File: <span className="font-medium text-gray-900">{ledgerValidationTarget.fileName}</span>
                    </>
                  ) : (
                    'Validating selected NACHA file'
                  )}
                </p>
              </div>
              <button
                onClick={() => {
                  setShowLedgerValidation(false);
                  setLedgerValidationError(null);
                  setLedgerValidationResult(null);
                  setLedgerValidationTarget(null);
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto">
              {ledgerValidationError && (
                <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
                  <p className="text-sm text-red-700 whitespace-pre-wrap">{ledgerValidationError}</p>
                </div>
              )}

              {ledgerValidationLoading && (
                <div className="bg-blue-50 border border-blue-200 rounded-md p-4 mb-4 flex items-center">
                  <Loader2 size={16} className="mr-2 animate-spin text-blue-600" />
                  <p className="text-sm text-blue-800">Running validation…</p>
                </div>
              )}

              {ledgerValidationResult && ledgerValidationResult.success && (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                      <div className="text-sm text-gray-600">Files checked</div>
                      <div className="text-2xl font-bold text-gray-900">
                        {ledgerValidationResult.summary.checkedGenerations}
                      </div>
                    </div>
                    <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                      <div className="text-sm text-red-700">Errors</div>
                      <div className="text-2xl font-bold text-red-800">
                        {ledgerValidationResult.summary.errorCount}
                      </div>
                    </div>
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                      <div className="text-sm text-yellow-700">Warnings</div>
                      <div className="text-2xl font-bold text-yellow-800">
                        {ledgerValidationResult.summary.warningCount}
                      </div>
                    </div>
                  </div>

                  <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                    <div className="p-4 border-b border-gray-200">
                      <h4 className="text-sm font-semibold text-gray-900">Issues</h4>
                      <p className="text-xs text-gray-600 mt-1">
                        Errors indicate potential mismatch/overpay conditions. Warnings are informational and may require review.
                      </p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Severity</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Code</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Message</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Context</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {ledgerValidationResult.issues.length === 0 ? (
                            <tr>
                              <td className="px-4 py-4 text-sm text-gray-600" colSpan={4}>
                                No issues found.
                              </td>
                            </tr>
                          ) : (
                            ledgerValidationResult.issues.map((issue, idx) => (
                              <tr key={idx} className="hover:bg-gray-50">
                                <td className="px-4 py-3 text-sm">
                                  <span
                                    className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                      issue.severity === 'error'
                                        ? 'bg-red-100 text-red-800'
                                        : 'bg-yellow-100 text-yellow-800'
                                    }`}
                                  >
                                    {issue.severity}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-900 font-mono">{issue.code}</td>
                                <td className="px-4 py-3 text-sm text-gray-900 whitespace-pre-wrap">{issue.message}</td>
                                <td className="px-4 py-3 text-xs text-gray-600 font-mono whitespace-pre-wrap">
                                  {[
                                    issue.nachaId ? `nachaId=${issue.nachaId}` : null,
                                    issue.payoutType ? `payoutType=${issue.payoutType}` : null,
                                    issue.paymentId ? `paymentId=${issue.paymentId}` : null,
                                    issue.recipientEntityType ? `type=${issue.recipientEntityType}` : null,
                                    issue.recipientEntityId ? `id=${issue.recipientEntityId}` : null
                                  ].filter(Boolean).join('\n')}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="border-t border-gray-200 p-4 bg-gray-50 flex justify-end">
              <button
                onClick={() => {
                  setShowLedgerValidation(false);
                  setLedgerValidationError(null);
                  setLedgerValidationResult(null);
                  setLedgerValidationTarget(null);
                }}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
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

export default NACHAList;


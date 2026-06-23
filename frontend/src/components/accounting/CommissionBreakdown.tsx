import { Calendar, ChevronLeft, ChevronRight, Download, Loader, RefreshCcw, Search, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { TenantAdminAgentsService } from '../../services/tenant-admin/agents.service';
import AgentManagementModal from '../../pages/tenant-admin/AgentManagementModal';
import {
    CommissionHoldSettings,
    CommissionBreakdownRow,
    getCommissionBreakdown,
    getCommissionBreakdownExportDetails,
    getCommissionBreakdownFilterOptions,
    getCommissionBreakdownPayments,
    CommissionBreakdownPaymentRow,
} from '../../services/accounting/commissionBreakdown.service';
import { generateAgentStatement } from '../../utils/excelGenerator';
import SearchableDropdown from '../common/SearchableDropdown';
import { useNavigate } from 'react-router-dom';
import PaymentCommissionBreakdownModal from './PaymentCommissionBreakdownModal';
import ClawbackDetailsModal from './ClawbackDetailsModal';
import { useMemberModalLauncher } from '../../hooks/useMemberModalLauncher';
import { useAuth } from '../../contexts/AuthContext';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount || 0);
}

function toYmd(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function startOfLastMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() - 1, 1);
}

interface CommissionBreakdownProps {
  holdSettings?: CommissionHoldSettings | null;
  /** When provided, date range is controlled by parent (e.g. TenantAccounting for shared use with Generate commissions) */
  startDate?: string;
  endDate?: string;
  onStartDateChange?: (v: string) => void;
  onEndDateChange?: (v: string) => void;
  headerActions?: React.ReactNode;
  onRefresh?: () => void;
  showMainTableFilter?: boolean;
  advancedPanelOpen?: boolean;
}

const CommissionBreakdown: React.FC<CommissionBreakdownProps> = ({
  holdSettings = null,
  startDate: controlledStartDate,
  endDate: controlledEndDate,
  onStartDateChange,
  onEndDateChange,
  headerActions,
  onRefresh,
  showMainTableFilter = true,
  advancedPanelOpen = false,
}) => {
  const today = useMemo(() => new Date(), []);
  const [internalStartDate, setInternalStartDate] = useState(toYmd(startOfLastMonth(today)));
  const [internalEndDate, setInternalEndDate] = useState(holdSettings?.safeEndDate || toYmd(today));
  const isControlled = controlledStartDate !== undefined && controlledEndDate !== undefined;
  const startDate = isControlled ? controlledStartDate : internalStartDate;
  const endDate = isControlled ? controlledEndDate : internalEndDate;
  const setStartDate = isControlled && onStartDateChange ? onStartDateChange : setInternalStartDate;
  const setEndDate = isControlled && onEndDateChange ? onEndDateChange : setInternalEndDate;
  const [rows, setRows] = useState<CommissionBreakdownRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBreakdownModal, setShowBreakdownModal] = useState(false);
  const [selectedEntity, setSelectedEntity] = useState<{
    entityType: string;
    entityId: string;
    entityName: string;
  } | null>(null);
  const [breakdownPayments, setBreakdownPayments] = useState<CommissionBreakdownPaymentRow[]>([]);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [breakdownError, setBreakdownError] = useState<string | null>(null);
  const [filterOptions, setFilterOptions] = useState<any[]>([]);
  const [selectedFilter, setSelectedFilter] = useState<string>('all');
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(false);
  const [mainTableFilter, setMainTableFilter] = useState<string>('all');
  const [mainTableFilterOptions, setMainTableFilterOptions] = useState<any[]>([]);
  const [mainTableFilterLoading, setMainTableFilterLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [selectedPaymentForDetails, setSelectedPaymentForDetails] = useState<CommissionBreakdownPaymentRow | null>(null);
  const SETTLED_ROWS_PAGE_SIZE = 25;
  const [settledRowsPage, setSettledRowsPage] = useState(1);
  const [agentSearch, setAgentSearch] = useState('');
  const [debouncedAgentSearch, setDebouncedAgentSearch] = useState('');
  const [agencyFilter, setAgencyFilter] = useState<string>('all');
  const [agencyOptions, setAgencyOptions] = useState<{ id: string; value: string; label: string }[]>([]);
  const [selectedAgentForModal, setSelectedAgentForModal] = useState<string | null>(null);
  const [clawbackEntity, setClawbackEntity] = useState<{
    entityType: 'Agent' | 'Agency';
    entityId: string;
    entityName: string;
  } | null>(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { openMember, MemberModalElement } = useMemberModalLauncher();
  const navigateToGroup = (groupId: string) => {
    const role = user?.currentRole || 'TenantAdmin';
    setClawbackEntity(null);
    if (role === 'Agent') navigate(`/agent/groups/${groupId}`);
    else if (role === 'TenantAdmin') navigate(`/tenant-admin/groups/${groupId}`);
    else navigate(`/admin/groups/${groupId}`);
  };

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [filterType, filterId] = mainTableFilter === 'all' ? ['all', null] : mainTableFilter.split('_');
      const params: { startDate: string; endDate: string; groupId?: string; individuals?: string; agentSearch?: string; agencyId?: string } = {
        startDate,
        endDate,
      };
      if (filterType === 'group') params.groupId = filterId ?? undefined;
      else if (filterType === 'individuals') params.individuals = 'true';
      if (debouncedAgentSearch.trim()) params.agentSearch = debouncedAgentSearch.trim();
      if (agencyFilter !== 'all') params.agencyId = agencyFilter;

      const res = await getCommissionBreakdown(params);
      if (res?.success) {
        setRows(res.data || []);
      } else {
        setRows([]);
        setError('Failed to load commission breakdown');
      }
    } catch (e: any) {
      setRows([]);
      setError(e?.message || 'Failed to load commission breakdown');
    } finally {
      setLoading(false);
    }
  };

  const fetchMainTableFilterOptions = async () => {
    setMainTableFilterLoading(true);
    try {
      const res = await getCommissionBreakdownFilterOptions({ startDate, endDate });
      if (res?.success) {
        setMainTableFilterOptions(res.data || []);
      }
    } catch (e: any) {
      console.error('Failed to load filter options:', e);
    } finally {
      setMainTableFilterLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => setDebouncedAgentSearch(agentSearch), 300);
    return () => clearTimeout(t);
  }, [agentSearch]);

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate, mainTableFilter, debouncedAgentSearch, agencyFilter]);

  useEffect(() => {
    fetchMainTableFilterOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate]);

  useEffect(() => {
    TenantAdminAgentsService.getAgentsAndAgencies({ status: 'Active', page: 1, limit: 500 }).then((res) => {
      if (res.success && Array.isArray(res.data)) {
        const agencies = (res.data as any[])
          .filter((a: any) => a.Type === 'Agency')
          .map((a: any) => { const v = a.Id || a.AgencyId; return { id: v, value: v, label: a.Name || a.AgencyName || 'Unknown Agency' }; });
        setAgencyOptions(agencies);
      }
    }).catch(() => {});
  }, []);


  useEffect(() => {
    if (holdSettings?.safeEndDate) {
      if (isControlled && onEndDateChange) {
        onEndDateChange(holdSettings.safeEndDate);
      } else {
        setInternalEndDate(holdSettings.safeEndDate);
      }
    }
  }, [holdSettings?.safeEndDate, isControlled, onEndDateChange]);

  const openBreakdownModal = async (r: CommissionBreakdownRow) => {
    setSelectedEntity({
      entityType: r.entityType,
      entityId: r.entityId,
      entityName: r.entityName,
    });
    setShowBreakdownModal(true);
    setSelectedFilter('all');
    setBreakdownLoading(true);
    setBreakdownError(null);
    setBreakdownPayments([]);
    setFilterOptionsLoading(true);

    try {
      const filterRes = await getCommissionBreakdownFilterOptions({
        startDate,
        endDate,
        entityId: r.entityId,
        entityType: r.entityType,
      });
      if (filterRes?.success) {
        setFilterOptions(filterRes.data || []);
      }

      const res = await getCommissionBreakdownPayments({
        entityType: r.entityType,
        entityId: r.entityId,
        startDate,
        endDate,
      });
      if (res?.success) {
        setBreakdownPayments(res.data || []);
      } else {
        setBreakdownError('Failed to load breakdown');
      }
    } catch (e: any) {
      setBreakdownError(e?.message || 'Failed to load breakdown');
    } finally {
      setBreakdownLoading(false);
      setFilterOptionsLoading(false);
    }
  };

  const handleFilterChange = async (value: string, _label?: string) => {
    setSelectedFilter(value);
    if (!selectedEntity) return;

    setBreakdownLoading(true);
    setBreakdownError(null);

    try {
      const [filterType, filterId] = value === 'all' ? ['all', null] : value.split('_');
      const params: any = {
        entityType: selectedEntity.entityType,
        entityId: selectedEntity.entityId,
        startDate,
        endDate,
      };
      if (filterType === 'group') params.groupId = filterId;
      else if (filterType === 'individuals') params.individuals = 'true';
      else if (filterType === 'member') params.householdId = filterId;

      const res = await getCommissionBreakdownPayments(params);
      if (res?.success) {
        setBreakdownPayments(res.data || []);
      } else {
        setBreakdownError('Failed to load breakdown');
      }
    } catch (e: any) {
      setBreakdownError(e?.message || 'Failed to load breakdown');
    } finally {
      setBreakdownLoading(false);
    }
  };

  const handleExportXlsx = async () => {
    if (!selectedEntity) return;
    setExportLoading(true);
    try {
      const [filterType, filterId] = selectedFilter === 'all' ? ['all', null] : selectedFilter.split('_');
      const params: any = {
        entityType: selectedEntity.entityType,
        entityId: selectedEntity.entityId,
        startDate,
        endDate,
      };
      if (filterType === 'group') params.groupId = filterId ?? undefined;
      if (filterType === 'individuals') params.individuals = 'true';
      if (filterType === 'member') params.householdId = filterId ?? undefined;

      const res = await getCommissionBreakdownExportDetails(params);
      if (res?.success && res.summary !== undefined) {
        const period = `${(() => {
          const [y1, m1, d1] = startDate.split('-').map(Number);
          const [y2, m2, d2] = endDate.split('-').map(Number);
          const start = new Date(y1, m1 - 1, d1);
          const end = new Date(y2, m2 - 1, d2);
          return `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
        })()}`;
        generateAgentStatement({
          agentName: selectedEntity.entityName,
          period,
          entityType: selectedEntity.entityType,
          summary: res.summary,
          payments: res.payments || [],
          groups: res.groups || [],
          individuals: res.individuals || [],
          products: res.products || [],
        });
      } else {
        throw new Error('Export failed');
      }
    } catch (e: any) {
      alert(e?.message || 'Failed to export XLSX');
    } finally {
      setExportLoading(false);
    }
  };

  const handleRefresh = () => {
    fetchData();
    onRefresh?.();
  };

  const unpaidRows = useMemo(
    () =>
      rows
        .filter(
          (r) =>
            Number(r.pendingPayoutAmount || 0) > 0 ||
            Number(r.pendingClawbackAmount || 0) > 0
        )
        .sort((a, b) => {
          const byAmount = Number(b.pendingPayoutAmount || 0) - Number(a.pendingPayoutAmount || 0);
          if (byAmount !== 0) return byAmount;
          return (a.entityName || '').localeCompare(b.entityName || '');
        }),
    [rows]
  );
  const totalUnpaidAmount = useMemo(
    () => unpaidRows.reduce((sum, r) => sum + Number(r.pendingPayoutAmount || 0), 0),
    [unpaidRows]
  );
  const totalPaidInRangeAmount = useMemo(
    () => rows.reduce((sum, r) => sum + Number(r.paidInRangeAmount || 0), 0),
    [rows]
  );
  const totalPendingClawbackAmount = useMemo(
    () => rows.reduce((sum, r) => sum + Number(r.pendingClawbackAmount || 0), 0),
    [rows]
  );
  const settledRows = useMemo(
    () =>
      rows
        .filter(
          (r) =>
            Number(r.pendingPayoutAmount || 0) <= 0 &&
            Number(r.pendingClawbackAmount || 0) <= 0
        )
        .sort((a, b) => (a.entityName || '').localeCompare(b.entityName || '')),
    [rows]
  );
  const settledTotalPages = Math.max(1, Math.ceil(settledRows.length / SETTLED_ROWS_PAGE_SIZE));
  const settledPageRows = useMemo(
    () => settledRows.slice((settledRowsPage - 1) * SETTLED_ROWS_PAGE_SIZE, settledRowsPage * SETTLED_ROWS_PAGE_SIZE),
    [settledRows, settledRowsPage]
  );
  const displayedRows = useMemo(
    () => unpaidRows.concat(settledPageRows),
    [unpaidRows, settledPageRows]
  );

  useEffect(() => {
    setSettledRowsPage(1);
  }, [rows]);

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center justify-between gap-4">
          <div
            className={
              advancedPanelOpen
                ? 'border border-blue-200 bg-blue-50/50 rounded-md p-3'
                : undefined
            }
          >
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-[280px] flex-1">{headerActions}</div>
              {showMainTableFilter && mainTableFilterOptions.length > 0 && (
                <div className="w-64 min-w-[240px]">
                  <SearchableDropdown
                    options={mainTableFilterOptions}
                    value={mainTableFilter}
                    onChange={(value) => setMainTableFilter(value)}
                    placeholder="Filter by group or individual"
                    loading={mainTableFilterLoading}
                  />
                </div>
              )}
              {/* Agent name search */}
              <div className="relative w-52">
                <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                  placeholder="Search agent..."
                  className="pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm w-full focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              {/* Agency filter */}
              {agencyOptions.length > 0 && (
                <div className="w-52">
                  <SearchableDropdown
                    options={[{ id: 'all', value: 'all', label: 'All Agencies' }, ...agencyOptions]}
                    value={agencyFilter}
                    onChange={(v) => setAgencyFilter(v)}
                    placeholder="Filter by agency"
                  />
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <div className="flex items-center gap-2">
              <div className="relative">
                <Calendar className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="date"
                  className="pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <span className="text-sm text-gray-500">to</span>
              <div className="relative">
                <Calendar className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="date"
                  className="pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>

            <button
              onClick={handleRefresh}
              disabled={loading}
              className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 flex items-center justify-center"
            >
              {loading ? <Loader className="h-4 w-4 animate-spin mr-2" /> : <RefreshCcw className="h-4 w-4 mr-2" />}
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="p-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-lg mb-4">{error}</div>
        )}

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Agent / Agency
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Paid
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Unpaid
                </th>
                <th
                  className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
                  title="Pending refund clawbacks. Will be deducted from this recipient's next NACHA payout."
                >
                  Pending Clawback
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Total
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-10 text-center text-gray-500">
                    <Loader className="h-5 w-5 animate-spin inline-block mr-2" />
                    Loading...
                  </td>
                </tr>
              ) : displayedRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-10 text-center text-gray-500">
                    No agents or agencies with commissions found for this date range.
                  </td>
                </tr>
              ) : (
                displayedRows.map((r) => (
                  <tr key={`${r.entityType}_${r.entityId}`} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      <span className="inline-flex items-center gap-1.5">
                        {r.entityType === 'Agent' ? (
                          <button
                            type="button"
                            onClick={() => setSelectedAgentForModal(r.entityId)}
                            className="text-oe-primary hover:text-oe-dark hover:underline focus:outline-none text-left"
                          >
                            {r.entityName}
                          </button>
                        ) : (
                          r.entityName
                        )}
                        {r.entityType === 'Agency' && (
                          <span className="text-xs text-gray-500">(Agency)</span>
                        )}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                      <span
                        className={r.paidInRangeAmount > 0 ? 'font-medium' : 'text-gray-500'}
                        style={r.paidInRangeAmount > 0 ? { color: 'var(--oe-success, #4caf50)' } : undefined}
                      >
                        {formatCurrency(r.paidInRangeAmount)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                      <span
                        className={r.pendingPayoutAmount > 0 ? 'font-medium' : 'text-gray-500'}
                        style={
                          r.pendingPayoutAmount > 0 ? { color: 'var(--oe-error, #e53935)' } : undefined
                        }
                      >
                        {formatCurrency(r.pendingPayoutAmount)}
                      </span>
                    </td>
                    <td
                      className="px-6 py-4 whitespace-nowrap text-sm text-right"
                      title={
                        Number(r.pendingClawbackAmount || 0) > 0
                          ? `${r.pendingClawbackCount || 1} pending refund clawback${
                              (r.pendingClawbackCount || 1) === 1 ? '' : 's'
                            } will be deducted on next NACHA cycle`
                          : 'No pending clawbacks'
                      }
                    >
                      {Number(r.pendingClawbackAmount || 0) > 0 ? (
                        <button
                          type="button"
                          onClick={() =>
                            setClawbackEntity({
                              entityType: r.entityType as 'Agent' | 'Agency',
                              entityId: r.entityId,
                              entityName: r.entityName,
                            })
                          }
                          className="font-medium hover:underline focus:outline-none focus:underline"
                          style={{ color: 'var(--oe-warning, #ed6c02)' }}
                          title="View refunds behind this clawback"
                        >
                          −{formatCurrency(r.pendingClawbackAmount || 0)}
                        </button>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                      <button
                        onClick={() => openBreakdownModal(r)}
                        className="text-blue-600 hover:underline font-medium"
                        title="View breakdown by product and tier"
                      >
                        {formatCurrency(r.expectedAmount)}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {!loading && rows.length > 0 && (
          <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex flex-col gap-0.5">
              <p className="text-xs text-gray-500">
                {unpaidRows.length} unpaid · {settledRows.length} settled
                {settledTotalPages > 1 ? ` (page ${settledRowsPage}/${settledTotalPages})` : ''}
              </p>
              <p className="text-sm font-semibold text-gray-900 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span>
                  Total paid (in range):{' '}
                  <span
                    className={totalPaidInRangeAmount > 0 ? 'font-semibold' : 'text-gray-500 font-normal'}
                    style={totalPaidInRangeAmount > 0 ? { color: 'var(--oe-success, #4caf50)' } : undefined}
                  >
                    {formatCurrency(totalPaidInRangeAmount)}
                  </span>
                </span>
                <span className="text-gray-300 hidden sm:inline">|</span>
                <span>
                  Total unpaid:{' '}
                  <span className="text-red-700">{formatCurrency(totalUnpaidAmount)}</span>
                </span>
                {totalPendingClawbackAmount > 0 && (
                  <span className="text-sm font-medium text-orange-700">
                    Pending clawback: −{formatCurrency(totalPendingClawbackAmount)}
                  </span>
                )}
              </p>
            </div>
            {settledTotalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setSettledRowsPage((p) => Math.max(1, p - 1))}
                  disabled={settledRowsPage === 1}
                  className="p-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-sm text-gray-600 px-1">{settledRowsPage} / {settledTotalPages}</span>
                <button
                  type="button"
                  onClick={() => setSettledRowsPage((p) => Math.min(settledTotalPages, p + 1))}
                  disabled={settledRowsPage === settledTotalPages}
                  className="p-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {showBreakdownModal && selectedEntity && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70] p-4">
          <div className="bg-white rounded-lg border border-gray-200 w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="text-lg font-medium text-gray-900">Commission Breakdown</h3>
                <p className="text-gray-600 mt-1">{selectedEntity.entityName}</p>
                <p className="text-sm text-gray-500 mt-1">
                  Date Range:{' '}
                  {(() => {
                    const [y1, m1, d1] = startDate.split('-').map(Number);
                    const [y2, m2, d2] = endDate.split('-').map(Number);
                    const start = new Date(y1, m1 - 1, d1);
                    const end = new Date(y2, m2 - 1, d2);
                    return `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
                  })()}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleExportXlsx}
                  disabled={exportLoading}
                  className="px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                  title="Export statement (XLSX) – same breakdown as NACHA export"
                >
                  {exportLoading ? (
                    <Loader className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  Download XLSX
                </button>
                <button
                  onClick={() => {
                    setShowBreakdownModal(false);
                    setSelectedEntity(null);
                    setBreakdownPayments([]);
                    setBreakdownError(null);
                    setSelectedFilter('all');
                    setFilterOptions([]);
                    setSelectedPaymentForDetails(null);
                  }}
                  className="p-2 rounded-lg hover:bg-gray-50"
                >
                  <X className="h-5 w-5 text-gray-500" />
                </button>
              </div>
            </div>

            <div className="p-6 border-b border-gray-200 flex-shrink-0">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Filter by Group or Member
              </label>
              <SearchableDropdown
                options={filterOptions}
                value={selectedFilter}
                onChange={handleFilterChange}
                placeholder="Select a filter..."
                loading={filterOptionsLoading}
                className="w-full"
              />
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {breakdownLoading ? (
                <div className="text-center text-gray-500 py-10">
                  <Loader className="h-5 w-5 animate-spin inline-block mr-2" />
                  Loading breakdown...
                </div>
              ) : breakdownError ? (
                <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-lg">
                  {breakdownError}
                </div>
              ) : !breakdownPayments || breakdownPayments.length === 0 ? (
                <div className="text-center text-gray-500 py-10">
                  No payment breakdown data available for this agent or agency.
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="overflow-x-auto border border-gray-200 rounded-lg">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Payment Date
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Client
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Agent
                          </th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Payment
                          </th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Commission
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {breakdownPayments.map((p) => (
                          <tr key={p.paymentId} className="hover:bg-gray-50">
                            <td className="px-4 py-3 text-sm text-gray-700">
                              {new Date(p.paymentDate).toLocaleDateString()}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-900">{p.clientName}</td>
                            <td className="px-4 py-3 text-sm text-gray-700">{p.agentName}</td>
                            <td className="px-4 py-3 text-sm text-right text-gray-900">
                              {formatCurrency(p.paymentAmount)}
                            </td>
                            <td className="px-4 py-3 text-sm text-right">
                              <button
                                type="button"
                                className="text-blue-600 hover:underline font-medium"
                                onClick={() => setSelectedPaymentForDetails(p)}
                                title="Open per-product payout details for this payment"
                              >
                                {formatCurrency(p.commissionAmount)}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-end pt-2 border-t border-gray-200">
                    <div className="text-right">
                      <div className="text-sm text-gray-500">Grand Total</div>
                      <div className="text-lg font-semibold text-gray-900">
                        {formatCurrency(
                          breakdownPayments.reduce((sum, p) => sum + (p.commissionAmount || 0), 0)
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {selectedPaymentForDetails && (
        <PaymentCommissionBreakdownModal
          isOpen={!!selectedPaymentForDetails}
          onClose={() => setSelectedPaymentForDetails(null)}
          paymentId={selectedPaymentForDetails.paymentId}
          paymentDate={selectedPaymentForDetails.paymentDate}
          amount={selectedPaymentForDetails.paymentAmount}
          agentName={selectedPaymentForDetails.agentName}
          clientName={selectedPaymentForDetails.clientName}
          breakdownSource="accounting"
        />
      )}
      <ClawbackDetailsModal
        isOpen={!!clawbackEntity}
        onClose={() => setClawbackEntity(null)}
        recipientLabel={clawbackEntity?.entityName || ''}
        source={
          clawbackEntity
            ? {
                kind: 'commission',
                entityType: clawbackEntity.entityType,
                entityId: clawbackEntity.entityId,
              }
            : null
        }
        onOpenMember={(memberId) => {
          setClawbackEntity(null);
          openMember(memberId);
        }}
        onOpenGroup={(groupId) => navigateToGroup(groupId)}
      />
      {MemberModalElement}

      {selectedAgentForModal && (
        <AgentManagementModal
          agentId={selectedAgentForModal}
          isOpen={true}
          onClose={() => setSelectedAgentForModal(null)}
          onUpdate={fetchData}
          initialTab="commissions"
          currentRole={user?.currentRole}
        />
      )}
    </div>
  );
};

export default CommissionBreakdown;

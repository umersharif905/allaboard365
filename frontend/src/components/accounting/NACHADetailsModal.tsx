// frontend/src/components/accounting/NACHADetailsModal.tsx
import { Download, Loader2, X, RefreshCw, FileSpreadsheet } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { NACHAGeneration, NACHALineItem, nachaService } from '../../services/nachaService';
import AgentDetailsModal from './AgentDetailsModal';
import AgencyDetailsModal from './AgencyDetailsModal';
import CommissionRuleDetailsModal from './CommissionRuleDetailsModal';
import ExportVendorPayablesModal from './ExportVendorPayablesModal';
import PaymentDetailsModal from './PaymentDetailsModal';
import NACHAPayoutSummaryTable, { SummaryRowData } from './NACHAPayoutSummaryTable';
import { formatDate as formatDateHelper } from '../../utils/helpers';
import { generateAgentStatement } from '../../utils/excelGenerator';

interface NACHADetailsModalProps {
  nacha: NACHAGeneration;
  isOpen: boolean;
  onClose: () => void;
  onStatusChange?: () => void;
}

const formatRecipientDisplayName = (name: string, bank?: string | null) => {
  if (!bank) return name;
  const suffix = ` (${bank})`;
  if (name.includes(suffix)) return name;
  return `${name}${suffix}`;
};

const NACHADetailsModal: React.FC<NACHADetailsModalProps> = ({ nacha, isOpen, onClose, onStatusChange }) => {
  const [lineItems, setLineItems] = useState<NACHALineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPaymentDetails, setShowPaymentDetails] = useState(false);
  const [selectedRecipient, setSelectedRecipient] = useState<{
    name: string;
    type: string;
    entityId: string;
    entityType: string;
  } | null>(null);
  const [showRuleDetails, setShowRuleDetails] = useState(false);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [showAgentDetails, setShowAgentDetails] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
  const [showAgencyDetails, setShowAgencyDetails] = useState(false);
  const [selectedAgencyId, setSelectedAgencyId] = useState<string | null>(null);
  const [selectedAgencyName, setSelectedAgencyName] = useState<string | null>(null);
  const [showExportPayablesModal, setShowExportPayablesModal] = useState(false);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0
  });

  useEffect(() => {
    if (isOpen) {
      console.log('📋 NACHADetailsModal opened with nacha:', nacha);
      if (!nacha || (!nacha.nachaId && !(nacha as any).NACHAId)) {
        console.error('❌ NACHA ID is missing:', nacha);
      }
      fetchLineItems();
    }
  }, [isOpen, pagination.page, nacha]);

  const handleViewDetails = (item: NACHALineItem) => {
    const nachaId = nacha.nachaId || (nacha as any).NACHAId;
    setSelectedRecipient({
      name: formatRecipientDisplayName(item.recipientName, item.achBankName),
      type: item.recipientEntityType,
      entityId: item.recipientEntityId,
      entityType: item.recipientEntityType
    });
    setShowPaymentDetails(true);
  };

  const fetchLineItems = async () => {
    // Handle both camelCase and PascalCase from backend
    const nachaId = nacha.nachaId || (nacha as any).NACHAId;
    
    if (!nacha || !nachaId) {
      setError('NACHA ID is missing');
      setLoading(false);
      return;
    }
    
    setLoading(true);
    setError(null);
    try {
      const response = await nachaService.getNACHALineItems(
        nachaId,
        pagination.page,
        pagination.limit
      );
      setLineItems(response.lineItems);
      setPagination(prev => ({
        ...prev,
        total: response.pagination.total,
        totalPages: response.pagination.totalPages
      }));
    } catch (err: any) {
      setError(err.message || 'Failed to fetch line items');
    } finally {
      setLoading(false);
    }
  };

  const handleMarkAsNotSent = async () => {
    const nachaId = nacha.nachaId || (nacha as any).NACHAId;
    if (!nachaId) return;

    if (!window.confirm('Are you sure you want to mark this NACHA file as Not Sent?\n\nThis will revert the status to Pending, clear the Sent Date, and revert any associated commissions to unpaid status.\n\nThis action cannot be undone automatically (you would need to mark it as Sent again).')) {
      return;
    }

    setActionLoading(true);
    try {
      await nachaService.markNACHAasNotSent(nachaId);
      // Close modal and refresh parent
      onClose();
      if (onStatusChange) {
        onStatusChange();
      }
    } catch (err: any) {
      alert(err.message || 'Failed to mark NACHA as Not Sent');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDownload = async () => {
    try {
      await nachaService.downloadNACHA(nacha.nachaId, nacha.fileName);
    } catch (err: any) {
      alert(err.message || 'Failed to download NACHA file');
    }
  };

  const handleExport = async (entityType: string, entityId: string, entityName: string) => {
    try {
      const nachaId = nacha.nachaId || (nacha as any).NACHAId;
      if (!nachaId) return;

      const response = await nachaService.getExportDetails(
        entityType,
        entityId,
        undefined,
        undefined,
        nachaId
      );

      if (response.success) {
        // Generate Excel Statement
        generateAgentStatement({
          agentName: entityName,
          period: `${nacha.startDate ? new Date(nacha.startDate).toLocaleDateString() : 'N/A'} - ${nacha.endDate ? new Date(nacha.endDate).toLocaleDateString() : 'N/A'}`,
          entityType: entityType,
          summary: response.summary,
          payments: response.payments,
          groups: response.groups,
          individuals: response.individuals,
          products: response.products
        });
      }
    } catch (err: any) {
      console.error('Export failed:', err);
      alert('Failed to export statement: ' + (err.message || 'Unknown error'));
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  };

  // Handler for viewing entity details (agent/agency)
  const handleViewEntityDetails = (entityType: string, entityId: string, entityName: string) => {
    if (entityType === 'Agent') {
      setSelectedAgentId(entityId);
      setSelectedAgentName(entityName);
      setShowAgentDetails(true);
    } else if (entityType === 'Agency') {
      setSelectedAgencyId(entityId);
      setSelectedAgencyName(entityName);
      setShowAgencyDetails(true);
    }
  };

  // Map line items to summary table format
  const summaryRows: SummaryRowData[] = lineItems.map(item => {
    const displayName = formatRecipientDisplayName(item.recipientName, item.achBankName);

    const clawbackTotal = Number(item.clawbackTotal) || 0;
    const grossCredits =
      item.grossCredits != null && item.grossCredits > 0
        ? item.grossCredits
        : item.amount > 0
          ? item.amount
          : 0;

    return {
      entityType: item.recipientEntityType,
      entityId: item.recipientEntityId,
      name: displayName,
      count:
        item.invoiceCount != null && item.invoiceCount > 0
          ? item.invoiceCount
          : item.paymentCount || 1,
      countUnit: 'invoice',
      credits: grossCredits,
      debits: item.amount < 0 ? item.amount : 0,
      clawbackTotal,
      netTotal: item.amount,
      onViewDetails: () => handleViewDetails(item),
      onExport:
        item.recipientEntityType === 'Agent' || item.recipientEntityType === 'Agency'
          ? () => handleExport(item.recipientEntityType, item.recipientEntityId, displayName)
          : undefined,
      onViewEntityDetails: (item.recipientEntityType === 'Agent' || item.recipientEntityType === 'Agency')
        ? () => handleViewEntityDetails(item.recipientEntityType, item.recipientEntityId, displayName)
        : undefined
    };
  });

  // Format dates - calendar dates parse date parts, timestamps use timezone conversion
  const formatDate = (dateString: string, isTimestamp: boolean = false) => {
    return formatDateHelper(dateString, isTimestamp);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-2xl font-semibold text-gray-900">{nacha.fileName}</h2>
            <p className="text-sm text-gray-600 mt-1">
              {nacha.payoutType} • Generated {formatDate(nacha.generatedDate, true)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {nacha.status === 'Sent' && (
              <button
                onClick={handleMarkAsNotSent}
                disabled={actionLoading}
                className="flex items-center px-4 py-2 border border-yellow-300 text-yellow-700 bg-yellow-50 rounded-lg hover:bg-yellow-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionLoading ? (
                  <Loader2 size={16} className="mr-2 animate-spin" />
                ) : (
                  <RefreshCw size={16} className="mr-2" />
                )}
                Mark as Not Sent
              </button>
            )}
            {nacha.payoutType === 'Vendor Payouts' && (
              <button
                onClick={() => setShowExportPayablesModal(true)}
                className="flex items-center px-4 py-2 border border-blue-600 text-blue-600 rounded-lg hover:bg-blue-50 transition-colors"
              >
                <FileSpreadsheet size={16} className="mr-2" />
                Export Payables
              </button>
            )}
            <button
              onClick={handleDownload}
              className="flex items-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
            >
              <Download size={16} className="mr-2" />
              Download
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X size={24} />
            </button>
          </div>
        </div>

        {/* Summary */}
        <div className="p-6 bg-gray-50 border-b border-gray-200">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-gray-600">Total Payouts</p>
              <p className="text-xl font-bold text-gray-900">{nacha.totalPayouts}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Total Amount</p>
              <p className="text-xl font-bold text-gray-900">{formatCurrency(nacha.totalAmount)}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Status</p>
              <p className={`text-xl font-bold ${nacha.status === 'Sent' ? 'text-green-600' : 'text-yellow-600'}`}>
                {nacha.status}
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-6">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          <h3 className="text-lg font-semibold text-gray-900 mb-4">Line Items</h3>

          {loading ? (
            <div className="text-center py-12">
              <Loader2 className="animate-spin h-8 w-8 text-oe-primary mx-auto mb-4" />
              <p className="text-gray-600">Loading line items...</p>
            </div>
          ) : lineItems.length === 0 ? (
            <div className="text-center py-12 text-gray-600">
              No line items found
            </div>
          ) : (
            <>
              <NACHAPayoutSummaryTable rows={summaryRows} loading={loading} />

              {/* Pagination */}
              {pagination.totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <div className="text-sm text-gray-600">
                    Showing {((pagination.page - 1) * pagination.limit) + 1} to{' '}
                    {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} items
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
        </div>
      </div>

      {/* Payment Details Modal */}
      {selectedRecipient && (
        <PaymentDetailsModal
          isOpen={showPaymentDetails}
          onClose={() => {
            setShowPaymentDetails(false);
            setSelectedRecipient(null);
          }}
          nachaId={nacha.nachaId || (nacha as any).NACHAId}
          recipientName={selectedRecipient.name}
          recipientType={selectedRecipient.type}
          entityId={selectedRecipient.entityId}
          entityType={selectedRecipient.entityType}
        />
      )}
      
      {/* Commission Rule Details Modal */}
      <CommissionRuleDetailsModal
        ruleId={selectedRuleId}
        isOpen={showRuleDetails}
        onClose={() => {
          setShowRuleDetails(false);
          setSelectedRuleId(null);
        }}
      />
      
      {/* Agent Details Modal */}
      <AgentDetailsModal
        agentId={selectedAgentId || ''}
        agentName={selectedAgentName || undefined}
        isOpen={showAgentDetails}
        onClose={() => {
          setShowAgentDetails(false);
          setSelectedAgentId(null);
          setSelectedAgentName(null);
        }}
      />
      
      {/* Agency Details Modal */}
      <AgencyDetailsModal
        agencyId={selectedAgencyId || ''}
        agencyName={selectedAgencyName || undefined}
        isOpen={showAgencyDetails}
        onClose={() => {
          setShowAgencyDetails(false);
          setSelectedAgencyId(null);
          setSelectedAgencyName(null);
        }}
      />

      {/* Export Vendor Payables Modal */}
      <ExportVendorPayablesModal
        nachaId={nacha.nachaId || (nacha as any).NACHAId}
        isOpen={showExportPayablesModal}
        onClose={() => setShowExportPayablesModal(false)}
      />
    </div>
  );
};

export default NACHADetailsModal;


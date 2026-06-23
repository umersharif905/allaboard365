// frontend/src/components/accounting/NACHAWizard.tsx
import { AlertCircle, Calendar, HelpCircle, Loader2, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import { CommissionHoldSettings, NACHAPreview, nachaService, StalePayablesSummaryData } from '../../services/nachaService';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
import SearchableDropdown from '../common/SearchableDropdown';
import NACHAOverviewModal from './NACHAOverviewModal';

interface NACHAWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (generatedNACHA?: any) => void;
}

type WizardStep = 'config' | 'preview' | 'generating';

const NACHAWizard: React.FC<NACHAWizardProps> = ({ isOpen, onClose, onSuccess }) => {
  const { user } = useAuth();
  const isSysAdmin = user?.currentRole === 'SysAdmin';
  const isTenantAdmin = user?.currentRole === 'TenantAdmin';
  
  const [currentStep, setCurrentStep] = useState<WizardStep>('config');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Helper function to get previous month date range
  const getDefaultDates = () => {
    const now = new Date();
    const todayYmd = now.toISOString().split('T')[0];
    const firstDayOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return {
      startDate: firstDayOfLastMonth.toISOString().split('T')[0],
      endDate: todayYmd,
      maxDate: todayYmd
    };
  };

  // Step 1: Configuration
  const [payoutTypes, setPayoutTypes] = useState<string[]>(['Agent Commission Payouts']);
  const defaultDates = getDefaultDates();
  const [startDate, setStartDate] = useState<string>(defaultDates.startDate);
  const [endDate, setEndDate] = useState<string>(defaultDates.endDate);
  const [maxDate] = useState<string>(defaultDates.maxDate);
  const [tenantId, setTenantId] = useState<string>('');
  const [tenants, setTenants] = useState<Array<{ TenantId: string; Name: string }>>([]);
  const [loadingTenants, setLoadingTenants] = useState(false);
  const [holdSettings, setHoldSettings] = useState<CommissionHoldSettings | null>(null);

  const [stalePayablesSummary, setStalePayablesSummary] = useState<StalePayablesSummaryData | null>(null);
  const [multiplePreviews, setMultiplePreviews] = useState<Map<string, NACHAPreview>>(new Map());
  const [showOverviewModal, setShowOverviewModal] = useState(false);
  // NOTE: Legacy single-preview state removed; we always use multi-preview + overview modal.
  
  // Payment details modal for preview
  const [showPaymentDetails, setShowPaymentDetails] = useState(false);
  const [selectedRecipient, setSelectedRecipient] = useState<{
    entityType: string;
    entityId: string;
    entityName: string;
  } | null>(null);
  const [paymentDetails, setPaymentDetails] = useState<Array<{
    // For vendor splits
    distributionPercentage?: number;
    bankName?: string | null;
    accountType?: string;
    accountNumberLast4?: string | null;
    // For regular payment details
    paymentId: string;
    paymentAmount: number;
    paymentDate: string;
    commissionPool?: number;
    commissionAmount?: number;
    memberName: string;
    memberId?: string;
    sellingAgentName?: string | null;
    ruleId?: string | null;
    ruleName?: string | null;
    commissionType?: string | null;
    tierLevel?: number | null;
    // For ACH splits (netRate is the split amount)
    netRate?: number;
    overrideRate?: number;
    overflow?: number;
  }>>([]);
  const [loadingPayments] = useState(false);

  // Fetch tenants for SysAdmin dropdown
  useEffect(() => {
    const fetchTenants = async () => {
      if (!isSysAdmin) return;
      
      setLoadingTenants(true);
      try {
        const response = await apiService.get<{ success: boolean; data: Array<{ TenantId: string; Name: string; Status: string }> }>('/api/tenants?lightweight=true');
        if (response.success && response.data) {
          // Remove duplicates by TenantId
          const uniqueTenants = Array.from(
            new Map(response.data.map(t => [t.TenantId, t])).values()
          );
          setTenants(uniqueTenants);
        }
      } catch (error) {
        console.error('Failed to fetch tenants:', error);
      } finally {
        setLoadingTenants(false);
      }
    };
    
    if (isOpen && isSysAdmin) {
      fetchTenants();
    }
  }, [isOpen, isSysAdmin]);

  // Fetch tenantId for TenantAdmin
  useEffect(() => {
    const fetchTenantAdminTenantId = async () => {
      if (!isTenantAdmin || !isOpen) return;
      
      try {
        const response = await TenantAdminService.getTenantSettings();
        if (response.success && response.data?.tenantId) {
          setTenantId(response.data.tenantId);
        }
      } catch (error) {
        console.error('Failed to fetch tenant admin tenant ID:', error);
        setError('Failed to load tenant information');
      }
    };
    
    fetchTenantAdminTenantId();
  }, [isOpen, isTenantAdmin]);

  // Load commission hold settings and default end date to hold-safe date.
  useEffect(() => {
    const loadHoldSettings = async () => {
      if (!isOpen) return;

      const effectiveTenantId = tenantId || (!isSysAdmin ? user?.tenantId || '' : '');
      if (!effectiveTenantId) {
        setHoldSettings(null);
        return;
      }

      try {
        const response = await nachaService.getCommissionHoldSettings(effectiveTenantId);
        if (response?.success && response.data) {
          setHoldSettings(response.data);
          setEndDate(response.data.safeEndDate);
        }
      } catch (err) {
        setHoldSettings(null);
      }
    };

    loadHoldSettings();
  }, [isOpen, tenantId, isSysAdmin, user?.tenantId]);

  // Reset dates to previous month when wizard opens
  useEffect(() => {
    if (isOpen) {
      const dates = getDefaultDates();
      setStartDate(dates.startDate);
      setEndDate(dates.endDate);
      setCurrentStep('config');
      setError(null);
      setTenantId('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isBeyondHoldSafeDate = !!(holdSettings && endDate > holdSettings.safeEndDate);

  // Map UI label to backend value
  const mapPayoutTypeToBackend = (uiType: string): string => {
    if (uiType === 'Product Override Distributions') {
      return 'Product Owner Payouts';
    }
    return uiType;
  };

  const handlePreview = async () => {
    if (!startDate || !endDate) {
      setError('Please select both start and end dates');
      return;
    }

    // Do not allow future dates (today at the latest)
    if (startDate > maxDate || endDate > maxDate) {
      setError('Dates cannot be in the future. Please select today or earlier.');
      return;
    }

    if (payoutTypes.length === 0) {
      setError('Please select at least one payout type');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const effTenantId = tenantId || (!isSysAdmin ? (user as { tenantId?: string })?.tenantId || '' : '');
      let staleSummary: typeof stalePayablesSummary = null;
      if (effTenantId) {
        try {
          const sr = await nachaService.getStalePayablesSummary({
            startDate,
            endDate,
            tenantId: isSysAdmin ? effTenantId : undefined,
            includeVendor: payoutTypes.includes('Vendor Payouts'),
            includeOverrides: payoutTypes.includes('Product Override Distributions'),
            includeCommissions: payoutTypes.includes('Agent Commission Payouts'),
          });
          if (sr.success && sr.data) staleSummary = sr.data;
        } catch (e) {
          console.warn('stale-payables-summary', e);
        }
      }
      setStalePayablesSummary(staleSummary);

      // Always use overview modal for both single and multiple selections
      const previewPromises = payoutTypes.map(payoutType =>
        nachaService.previewPayouts({
          payoutType: mapPayoutTypeToBackend(payoutType),
        startDate,
        endDate,
        tenantId: tenantId || undefined,
          page: 1,
          limit: 50
        })
      );

      const results = await Promise.allSettled(previewPromises);
      const previewsMap = new Map<string, NACHAPreview>();
      
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          previewsMap.set(payoutTypes[index], result.value);
        } else {
          console.error(`Failed to fetch preview for ${payoutTypes[index]}:`, result.reason);
        }
      });

      if (previewsMap.size === 0) {
        setError('Failed to load previews for all selected payout types');
        return;
      }

      setMultiplePreviews(previewsMap);
      setShowOverviewModal(true);
    } catch (err: any) {
      setError(err.message || 'Failed to preview payouts');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateMultiple = async (
    payoutTypesList: string[],
    startDateParam: string,
    endDateParam: string,
    tenantIdParam?: string,
    filters?: { vendorIds?: string[]; agentIds?: string[]; agencyIds?: string[]; fundingAchAccountIdByPayoutType?: Record<string, string>; companyIdentificationByPayoutType?: Record<string, string>; excludedPaymentIds?: string[]; excludedInvoiceIds?: string[] }
  ) => {
    setLoading(true);
    setError(null);
    setCurrentStep('generating');

    try {
      // Generate NACHA for each payout type
      const generatedNACHAs = [];
      const errors = [];
      
      for (const payoutTypeItem of payoutTypesList) {
        try {
          const vendorIds = payoutTypeItem === 'Vendor Payouts' ? filters?.vendorIds : undefined;
          const agentIds = payoutTypeItem === 'Agent Commission Payouts' ? filters?.agentIds : undefined;
          const agencyIds = payoutTypeItem === 'Agent Commission Payouts' ? filters?.agencyIds : undefined;
          const fundingAchAccountId = filters?.fundingAchAccountIdByPayoutType?.[payoutTypeItem];
          const companyIdentification = filters?.companyIdentificationByPayoutType?.[payoutTypeItem];

          const generatedNACHA = await nachaService.generateNACHA({
            payoutType: mapPayoutTypeToBackend(payoutTypeItem),
            startDate: startDateParam,
            endDate: endDateParam,
            tenantId: tenantIdParam || undefined,
            vendorIds: vendorIds || undefined,
            agentIds: agentIds || undefined,
            agencyIds: agencyIds || undefined,
            fundingAchAccountId: fundingAchAccountId || undefined,
            companyIdentification: companyIdentification || '',
            excludedPaymentIds: filters?.excludedPaymentIds && filters.excludedPaymentIds.length > 0 ? filters.excludedPaymentIds : undefined,
            excludedInvoiceIds: filters?.excludedInvoiceIds && filters.excludedInvoiceIds.length > 0 ? filters.excludedInvoiceIds : undefined
          });
          generatedNACHAs.push({ payoutType: payoutTypeItem, nacha: generatedNACHA });
        } catch (err: any) {
          errors.push({ payoutType: payoutTypeItem, error: err.message || 'Failed to generate NACHA file' });
        }
      }
      
      if (generatedNACHAs.length === 0) {
        const errorMessage = `Failed to generate NACHA files: ${errors.map(e => `${e.payoutType}: ${e.error}`).join(', ')}`;
        setError(errorMessage);
        setCurrentStep('preview');
        // Throw error so it can be caught by the overview modal
        throw new Error(errorMessage);
      }
      
      // Show summary
      let message = `Successfully generated ${generatedNACHAs.length} NACHA file(s):\n\n`;
      for (const { payoutType: pt, nacha } of generatedNACHAs) {
        message += `${pt}:\n`;
        message += `  Included: ${nacha.includedPayouts || nacha.totalPayouts} payouts (${formatCurrency(nacha.includedAmount || nacha.totalAmount)})\n`;
        if (nacha.excludedPayouts && nacha.excludedPayouts > 0) {
          message += `  Excluded: ${nacha.excludedPayouts} payouts (${formatCurrency(nacha.excludedAmount || 0)})\n`;
        }
        if ((nacha as any).warnings && Array.isArray((nacha as any).warnings) && (nacha as any).warnings.length > 0) {
          message += `  Warnings:\n`;
          for (const w of (nacha as any).warnings) {
            message += `    - ${w.message || w.code || 'Warning'}\n`;
          }
        }
        message += '\n';
      }
      if (errors.length > 0) {
        message += `Errors:\n`;
        for (const { payoutType: pt, error } of errors) {
          message += `  ${pt}: ${error}\n`;
        }
      }
      alert(message);
      
      onSuccess(generatedNACHAs[generatedNACHAs.length - 1].nacha); // Return last one for compatibility
      setShowOverviewModal(false);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to generate NACHA files');
      setCurrentStep('preview');
      // Re-throw error so it can be caught by the overview modal
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // NOTE: Legacy direct generate handler removed; generation happens via overview modal (multi-preview) so we can apply recipient filters.

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-semibold text-gray-900">New NACHA Payout</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            disabled={loading}
          >
            <X size={24} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-6">
              <div className="flex">
                <AlertCircle className="h-5 w-5 text-red-400" />
                <div className="ml-3">
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              </div>
            </div>
          )}

          {/* Step 1: Configuration */}
          {currentStep === 'config' && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Payout Types
                </label>
                <div className="space-y-2">
                  {['Agent Commission Payouts', 'Vendor Payouts', 'Product Override Distributions'].map((type) => {
                    const tooltipText = type === 'Vendor Payouts'
                      ? 'Vendors are paid based on when enrolled members\' coverage is effective, not when payment is collected.'
                      : type === 'Agent Commission Payouts'
                      ? 'Agent commissions use each invoice\'s due date in the NACHA range and require the invoice to be fully paid; this is not the same as vendor “payment received” timing.'
                      : 'Override distributions follow tenant payout basis (coverage effective vs payment received / fulfillment).';
                    return (
                      <label key={type} className="flex items-center space-x-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={payoutTypes.includes(type)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setPayoutTypes([...payoutTypes, type]);
                            } else {
                              setPayoutTypes(payoutTypes.filter(t => t !== type));
                            }
                          }}
                          className="w-4 h-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                        />
                        <span className="text-sm text-gray-700">{type}</span>
                        <span className="relative group/tip inline-flex items-center">
                          <HelpCircle className="h-3.5 w-3.5 text-gray-400 cursor-help" />
                          <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover/tip:opacity-100 pointer-events-none transition-opacity z-50 w-64 text-left leading-relaxed">
                            {tooltipText}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {isSysAdmin && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Tenant
                  </label>
                  <SearchableDropdown
                    options={tenants.map(t => ({
                      id: t.TenantId,
                      label: t.Name,
                      value: t.TenantId
                    }))}
                    value={tenantId}
                    onChange={(value) => setTenantId(value)}
                    placeholder="Select a tenant"
                    searchPlaceholder="Search tenants..."
                    loading={loadingTenants}
                    disabled={loading}
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    <Calendar className="inline h-4 w-4 mr-1" />
                    Start Date
                  </label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    max={maxDate}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    <Calendar className="inline h-4 w-4 mr-1" />
                    End Date
                  </label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    max={maxDate}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                  />
                </div>
              </div>

              {isBeyondHoldSafeDate && holdSettings && (
                <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-sm">
                  Selected end date is beyond the commission hold-safe date ({holdSettings.safeEndDate}).
                  This tenant uses a {holdSettings.holdDays}-day commission hold
                  {holdSettings.holdDaysCountFrom === 'nextDay' ? ' (counted from next day)' : ''},
                  so newer payments may still be in hold.
                </div>
              )}

              <div className="flex justify-end gap-4 pt-4">
                <button
                  onClick={onClose}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  disabled={loading}
                >
                  Cancel
                </button>
                <button
                  onClick={handlePreview}
                  disabled={loading || !startDate || !endDate}
                  className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                >
                  {loading ? (
                    <>
                      <Loader2 size={16} className="mr-2 animate-spin" />
                      Calculating...
                    </>
                  ) : (
                    'Calculate Payouts'
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Preview - Removed, now using overview modal for all cases */}
          {/* Old preview UI removed - all previews now use NACHAOverviewModal */}
          {/* Step 3: Generating */}
          {currentStep === 'generating' && (
            <div className="text-center py-12">
              <Loader2 className="animate-spin h-12 w-12 text-oe-primary mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Generating NACHA File...</h3>
              <p className="text-gray-600">Please wait while we create your NACHA file.</p>
            </div>
          )}
        </div>
      </div>

      {/* Payment Details Modal for Preview */}
      {showPaymentDetails && selectedRecipient && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-2xl font-semibold text-gray-900">
                Payment Details: {selectedRecipient.entityName}
              </h2>
              <button
                onClick={() => {
                  setShowPaymentDetails(false);
                  setSelectedRecipient(null);
                  setPaymentDetails([]);
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            <div className="p-6">
              {loadingPayments ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                  <span className="ml-3 text-gray-600">Loading payment details...</span>
                </div>
              ) : paymentDetails.length === 0 ? (
                <p className="text-gray-500">No payment details found</p>
              ) : (
                <>
                  {/* Check if this is vendor splits (has distributionPercentage) */}
                  {selectedRecipient?.entityType === 'Vendor' && paymentDetails.length > 0 && paymentDetails[0].distributionPercentage !== undefined ? (
                    // Vendor ACH Split View
                    <>
                      <div className="mb-4">
                        <h3 className="text-lg font-semibold text-gray-900 mb-2">ACH Account Splits</h3>
                        <p className="text-sm text-gray-600 mb-4">
                          This vendor payout is split across multiple ACH accounts based on distribution percentages.
                        </p>
                      </div>
                      <div className="overflow-x-auto border border-gray-200 rounded-lg">
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Account Holder</th>
                              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Bank</th>
                              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Account Type</th>
                              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Account Number</th>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Distribution %</th>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Split Amount</th>
                            </tr>
                          </thead>
                          <tbody className="bg-white divide-y divide-gray-200">
                            {paymentDetails.map((split, idx) => (
                              <tr key={idx} className="hover:bg-gray-50">
                                <td className="px-4 py-3 text-sm text-gray-900">
                                  {split.memberName}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-600">
                                  {split.bankName || '-'}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-600">
                                  {split.accountType || '-'}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-600">
                                  {split.accountNumberLast4 ? `****${split.accountNumberLast4}` : '-'}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-600 text-right">
                                  {split.distributionPercentage?.toFixed(2)}%
                                </td>
                                <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">
                                  {formatCurrency(split.netRate || 0)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot className="bg-gray-50">
                            <tr>
                              <td colSpan={5} className="px-4 py-3 text-sm font-semibold text-gray-900 text-right">
                                Total Payout:
                              </td>
                              <td className="px-4 py-3 text-sm font-bold text-gray-900 text-right">
                                {formatCurrency(paymentDetails.reduce((sum, s) => sum + (s.netRate || 0), 0))}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </>
                  ) : (
                    // Regular Payment Details View
                    <>
                      <div className={`mb-4 grid gap-4 ${selectedRecipient?.entityType === 'Agent' ? 'grid-cols-3' : selectedRecipient?.entityType === 'Vendor' ? 'grid-cols-2' : 'grid-cols-4'}`}>
                    <div className="bg-gray-50 p-4 rounded-lg">
                      <div className="text-sm text-gray-600">Total Revenue</div>
                      <div className="text-2xl font-bold text-gray-900">
                        {formatCurrency(paymentDetails.reduce((sum, p) => sum + (p.paymentAmount || 0), 0))}
                      </div>
                    </div>
                    {selectedRecipient?.entityType === 'Agent' && (
                      <>
                        <div className="bg-gray-50 p-4 rounded-lg">
                          <div className="text-sm text-gray-600">Total Commission</div>
                          <div className="text-2xl font-bold text-gray-900">
                            {formatCurrency(paymentDetails.reduce((sum, p) => sum + (p.commissionPool || 0), 0))}
                          </div>
                        </div>
                        <div className="bg-gray-50 p-4 rounded-lg">
                          <div className="text-sm text-gray-600">Total Payout</div>
                          <div className="text-2xl font-bold text-gray-900">
                            {formatCurrency(paymentDetails.reduce((sum, p) => sum + (p.commissionAmount || 0), 0))}
                          </div>
                        </div>
                      </>
                    )}
                    {selectedRecipient?.entityType === 'Vendor' && (
                      <div className="bg-gray-50 p-4 rounded-lg">
                        <div className="text-sm text-gray-600">Total Vendor Payout (NetRate)</div>
                        <div className="text-2xl font-bold text-gray-900">
                          {formatCurrency(paymentDetails.reduce((sum, p) => sum + ((p as any).vendorPayout || 0), 0))}
                        </div>
                      </div>
                    )}
                    {selectedRecipient?.entityType === 'Tenant' && (
                        <div className="bg-gray-50 p-4 rounded-lg">
                        <div className="text-sm text-gray-600">Total Payout (OverrideRate)</div>
                          <div className="text-2xl font-bold text-gray-900">
                            {formatCurrency(paymentDetails.reduce((sum, p) => sum + ((p as any).overridePayout || 0), 0))}
                          </div>
                        </div>
                    )}
                  </div>

                  <div className="overflow-x-auto border border-gray-200 rounded-lg">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Member</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Payment Amount</th>
                          {selectedRecipient?.entityType === 'Agent' && (
                            <>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Commission</th>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Commission Payout</th>
                              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Rule</th>
                            </>
                          )}
                          {selectedRecipient?.entityType === 'Vendor' && (
                            <>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">NetRate (Vendor Payout)</th>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Commission</th>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">OverrideRate</th>
                            </>
                          )}
                          {selectedRecipient?.entityType === 'Tenant' && (
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">OverrideRate (Payout)</th>
                          )}
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {paymentDetails.map((payment, idx) => (
                          <tr key={payment.paymentId || idx} className="hover:bg-gray-50">
                            <td className="px-4 py-3 text-sm text-gray-900">
                              {payment.memberName}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-500">
                              {new Date(payment.paymentDate).toLocaleDateString()}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-900 text-right">
                              {formatCurrency(payment.paymentAmount)}
                            </td>
                            {selectedRecipient?.entityType === 'Agent' && (
                              <>
                                <td className="px-4 py-3 text-sm text-gray-600 text-right">
                                  {formatCurrency(payment.commissionPool || 0)}
                                </td>
                                <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">
                                  {formatCurrency(payment.commissionAmount || 0)}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-700">
                                  {payment.ruleName ? (
                                    <span>{payment.ruleName}</span>
                                  ) : (
                                    <span className="text-gray-400 italic">No rule</span>
                                  )}
                                </td>
                              </>
                            )}
                            {selectedRecipient?.entityType === 'Vendor' && (
                              <>
                                <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">
                                  {formatCurrency((payment as any).vendorPayout || 0)}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-600 text-right">
                                  {formatCurrency((payment as any).commissionPool || 0)}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-600 text-right">
                                  {formatCurrency((payment as any).overrideRate || 0)}
                                </td>
                              </>
                            )}
                            {selectedRecipient?.entityType === 'Tenant' && (
                              <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">
                                  {formatCurrency((payment as any).overridePayout || 0)}
                                </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Overview Modal for Multiple Selections */}
      {showOverviewModal && (
        <NACHAOverviewModal
          isOpen={showOverviewModal}
          onClose={() => {
            setShowOverviewModal(false);
            setStalePayablesSummary(null);
          }}
          previews={multiplePreviews}
          startDate={startDate}
          endDate={endDate}
          tenantId={tenantId || undefined}
          onGenerate={handleGenerateMultiple}
          stalePayablesSummary={stalePayablesSummary}
        />
      )}
    </div>
  );
};

export default NACHAWizard;


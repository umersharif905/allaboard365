// frontend/src/components/accounting/CommissionRuleDetailsModal.tsx
import { Calendar, FileText, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';

interface CommissionRuleDetailsModalProps {
  ruleId: string | null;
  isOpen: boolean;
  onClose: () => void;
  appliedTierLevel?: number | null; // The tier level that was applied to this agent/payment
  productTier?: string | null; // EE, ES, EC, or EF - the product tier for this payment
  paymentDate?: string | null; // Payment successful date
  paymentCreatedDate?: string | null; // Payment created/expected date
  ruleIds?: string[]; // All rule IDs in order of application
  ruleIndex?: number; // Which rule in the sequence (1, 2, 3, etc.)
}

interface CommissionRule {
  RuleId: string;
  RuleName: string;
  ProductId: string;
  ProductName?: string;
  EntityType: string;
  EntityId?: string;
  TierLevel?: number;
  CommissionType: string;
  CommissionRate?: number;
  FlatAmount?: number;
  TieredRates?: string;
  CommissionJson?: string;
  PaymentTiming?: string;
  YearlySchedule?: string;
  MinimumPremium?: number;
  MaximumPremium?: number;
  EffectiveDate: string;
  TerminationDate?: string;
  Priority: number;
  Status: string;
  TenantId?: string;
  TenantName?: string;
  IsGlobal?: boolean;
  CreatedDate: string;
  ModifiedDate: string;
}

const CommissionRuleDetailsModal: React.FC<CommissionRuleDetailsModalProps> = ({
  ruleId,
  isOpen,
  onClose,
  appliedTierLevel = null,
  productTier = null, // EE, ES, EC, or EF
  paymentDate = null,
  paymentCreatedDate = null,
  ruleIds = [],
  ruleIndex
}) => {
  const [rule, setRule] = useState<CommissionRule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && ruleId) {
      fetchRuleDetails();
    }
  }, [isOpen, ruleId]);

  const fetchRuleDetails = async () => {
    if (!ruleId) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const response = await apiService.get(`/api/commissions/rules/${ruleId}`) as any;
      
      if (response.success && response.rule) {
        setRule(response.rule);
      } else {
        throw new Error(response.message || 'Failed to load commission rule');
      }
    } catch (err: any) {
      console.error('Error fetching commission rule:', err);
      setError(err.message || 'Failed to load commission rule details');
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (amount: number | null | undefined) => {
    if (amount === null || amount === undefined) return 'N/A';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  };

  const formatPercentage = (rate: number | null | undefined) => {
    if (rate === null || rate === undefined) return 'N/A';
    return `${(rate * 100).toFixed(2)}%`;
  };

  // Format dates - calendar dates parse date parts to avoid timezone conversion issues
  const formatDate = (dateString: string | null | undefined, isTimestamp: boolean = false) => {
    if (!dateString) return 'N/A';
    
    try {
      if (isTimestamp) {
        return new Date(dateString).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        });
      } else {
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

  if (!isOpen || !ruleId) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[80]">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <FileText className="w-6 h-6 text-oe-primary" />
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">Commission Rule Details</h2>
              <p className="text-sm text-gray-600 mt-1">
                {rule ? rule.RuleName : 'Loading...'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
              <span className="ml-3 text-gray-600">Loading commission rule details...</span>
            </div>
          ) : error ? (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center gap-2">
                <X className="w-5 h-5 text-red-500" />
                <span className="text-red-700">{error}</span>
              </div>
            </div>
          ) : rule ? (
            <div className="space-y-6">
              {/* Basic Information */}
              <div className="bg-gray-50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Basic Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-gray-700">Rule Name</label>
                    <p className="text-sm text-gray-900 mt-1">{rule.RuleName}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">Status</label>
                    <p className="text-sm text-gray-900 mt-1">
                      <span className={`inline-flex px-2 py-1 rounded-full text-xs font-semibold ${
                        rule.Status === 'Active' 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-gray-100 text-gray-800'
                      }`}>
                        {rule.Status}
                      </span>
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">Product</label>
                    <p className="text-sm text-gray-900 mt-1">{rule.ProductName || 'All Products'}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">Entity Type</label>
                    <p className="text-sm text-gray-900 mt-1">{rule.EntityType}</p>
                  </div>
                  {rule.TierLevel !== null && rule.TierLevel !== undefined && (
                    <div>
                      <label className="text-sm font-medium text-gray-700">Tier Level</label>
                      <p className="text-sm text-gray-900 mt-1">
                        {appliedTierLevel !== null && appliedTierLevel !== undefined 
                          ? `Level ${appliedTierLevel} (Applied)`
                          : `Level ${rule.TierLevel}`}
                      </p>
                    </div>
                  )}
                  <div>
                    <label className="text-sm font-medium text-gray-700">Priority</label>
                    <p className="text-sm text-gray-900 mt-1">{rule.Priority}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">Scope</label>
                    <p className="text-sm text-gray-900 mt-1">
                      {rule.IsGlobal ? 'Global' : rule.TenantName || 'Tenant-specific'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Payment Dates */}
              {(paymentDate || paymentCreatedDate) && (() => {
                const successfulDate = paymentDate ? formatDate(paymentDate, true) : null;
                const expectedDate = paymentCreatedDate ? formatDate(paymentCreatedDate, true) : null;
                const datesAreDifferent = successfulDate && expectedDate && successfulDate !== expectedDate;
                
                return datesAreDifferent || successfulDate || expectedDate ? (
                  <div className="bg-gray-50 rounded-lg p-4">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4">Payment Dates</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {expectedDate && (
                        <div>
                          <label className="text-sm font-medium text-gray-700">Payment Expected Date</label>
                          <p className="text-sm text-gray-900 mt-1 flex items-center gap-2">
                            <Calendar className="w-4 h-4 text-gray-500" />
                            {expectedDate}
                          </p>
                        </div>
                      )}
                      {successfulDate && (
                        <div>
                          <label className="text-sm font-medium text-gray-700">Payment Successful Date</label>
                          <p className="text-sm text-gray-900 mt-1 flex items-center gap-2">
                            <Calendar className="w-4 h-4 text-gray-500" />
                            {successfulDate}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                ) : null;
              })()}

              {/* Tiered Commission Structure */}
              {rule.CommissionJson && (() => {
                try {
                  const commissionConfig = typeof rule.CommissionJson === 'string' 
                    ? JSON.parse(rule.CommissionJson) 
                    : rule.CommissionJson;
                  
                  if (commissionConfig.tiers && Array.isArray(commissionConfig.tiers)) {
                    const commissionType = commissionConfig.type || 'percentage';
                    const familyTiers = ['EE', 'ES', 'EC', 'EF'];
                    
                    return (
                      <div className="bg-gray-50 rounded-lg p-4">
                        <h3 className="text-lg font-semibold text-gray-900 mb-4">
                          Tiered Commission Structure
                          {ruleIndex !== undefined && (
                            <span className="ml-2 text-sm font-normal text-gray-600">
                              (Rule #{ruleIndex} of {ruleIds.length})
                            </span>
                          )}
                        </h3>
                        <div className="space-y-3">
                          <div className="text-sm text-gray-600 mb-3">
                            Commission Type: <span className="font-semibold">{commissionType === 'flatrate' ? 'Flat Rate' : 'Percentage'}</span>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200 bg-white rounded-lg border border-gray-200">
                              <thead className="bg-gray-100">
                                <tr>
                                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Tier Level</th>
                                  {familyTiers.map(tier => (
                                    <th key={tier} className="px-4 py-3 text-center text-xs font-semibold text-gray-700 uppercase">{tier}</th>
                                  ))}
                                  <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700 uppercase">Base Rate</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-200">
                                {commissionConfig.tiers
                                  .sort((a: any, b: any) => (a.tierLevel || a.level || 0) - (b.tierLevel || b.level || 0))
                                  .map((tier: any, idx: number) => {
                                    const tierLevel = tier.tierLevel !== undefined ? tier.tierLevel : (tier.level !== undefined ? tier.level : 0);
                                    const isApplied = appliedTierLevel !== null && appliedTierLevel === tierLevel;
                                    
                                    return (
                                      <tr 
                                        key={idx}
                                        className={isApplied ? 'bg-blue-50 font-semibold' : ''}
                                      >
                                        <td className={`px-4 py-3 text-sm ${isApplied ? 'text-blue-900 font-bold' : 'text-gray-900'}`}>
                                          Level {tierLevel}
                                          {isApplied && <span className="ml-2 text-oe-primary">(Applied)</span>}
                                        </td>
                                        {familyTiers.map(familyTier => {
                                          const tierConfig = tier.productTiers?.[familyTier];
                                          let display = '—';
                                          // Only underline if this is the applied tier level AND the product tier matches
                                          const isApplicableTier = isApplied && productTier && productTier === familyTier;
                                          
                                          if (tierConfig) {
                                            if (commissionType === 'percentage' && tierConfig.rate !== undefined) {
                                              const rate = tierConfig.rate > 1 ? tierConfig.rate / 100 : tierConfig.rate;
                                              display = `${(rate * 100).toFixed(2)}%`;
                                            } else if (commissionType === 'flatrate' && tierConfig.flatAmount !== undefined) {
                                              display = formatCurrency(tierConfig.flatAmount);
                                            }
                                          }
                                          
                                          return (
                                            <td 
                                              key={familyTier} 
                                              className={`px-4 py-3 text-sm text-center ${
                                                isApplied ? 'text-blue-900 font-bold' : 'text-gray-600'
                                              } ${isApplicableTier ? 'underline decoration-2 underline-offset-2' : ''}`}
                                            >
                                              {display}
                                            </td>
                                          );
                                        })}
                                        <td className={`px-4 py-3 text-sm text-center ${isApplied ? 'text-blue-900 font-bold' : 'text-gray-600'}`}>
                                          {commissionType === 'percentage' 
                                            ? (tier.rate !== undefined 
                                                ? `${((tier.rate > 1 ? tier.rate / 100 : tier.rate) * 100).toFixed(2)}%`
                                                : tier.percentage !== undefined
                                                  ? `${((tier.percentage > 1 ? tier.percentage / 100 : tier.percentage) * 100).toFixed(2)}%`
                                                  : '—')
                                            : commissionType === 'flatrate'
                                              ? (tier.flatAmount !== undefined 
                                                  ? formatCurrency(tier.flatAmount)
                                                  : tier.amount !== undefined
                                                    ? formatCurrency(tier.amount)
                                                    : '—')
                                              : '—'}
                                        </td>
                                      </tr>
                                    );
                                  })}
                              </tbody>
                            </table>
                          </div>
                          {appliedTierLevel === null && (
                            <p className="text-sm text-gray-500 italic mt-2">
                              Note: No tier level was applied to this payment (may be overflow or non-tiered commission)
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  }
                } catch (error) {
                  console.error('Error parsing CommissionJson:', error);
                }
                return null;
              })()}

              {/* Simple Tier Level Display (for non-JSON tiered rules) */}
              {rule.TierLevel !== null && rule.TierLevel !== undefined && !rule.CommissionJson && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Tier Information</h3>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-700">Tier Level:</span>
                      <span className={`text-sm font-semibold ${
                        appliedTierLevel !== null && appliedTierLevel === rule.TierLevel 
                          ? 'text-blue-900 bg-blue-50 px-2 py-1 rounded' 
                          : 'text-gray-900'
                      }`}>
                        Level {rule.TierLevel}
                        {appliedTierLevel !== null && appliedTierLevel === rule.TierLevel && (
                          <span className="ml-2 text-oe-primary">(Applied)</span>
                        )}
                      </span>
                    </div>
                    {rule.CommissionType === 'Percentage' && rule.CommissionRate !== null && (
                      <div className="text-sm text-gray-600">
                        Rate: {formatPercentage(rule.CommissionRate)}
                      </div>
                    )}
                    {rule.CommissionType === 'Flat' && rule.FlatAmount !== null && (
                      <div className="text-sm text-gray-600">
                        Amount: {formatCurrency(rule.FlatAmount)}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Additional Information */}
              {(rule.TieredRates || (rule.CommissionJson && rule.CommissionType !== 'Tiered') || rule.YearlySchedule) && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Additional Configuration</h3>
                  <div className="space-y-3">
                    {rule.TieredRates && (
                      <div>
                        <label className="text-sm font-medium text-gray-700">Tiered Rates</label>
                        <pre className="text-xs text-gray-600 mt-1 bg-white p-2 rounded border overflow-x-auto">
                          {rule.TieredRates}
                        </pre>
                      </div>
                    )}
                    {rule.CommissionJson && rule.CommissionType !== 'Tiered' && (
                      <div>
                        <label className="text-sm font-medium text-gray-700">Commission JSON</label>
                        <pre className="text-xs text-gray-600 mt-1 bg-white p-2 rounded border overflow-x-auto">
                          {typeof rule.CommissionJson === 'string' ? rule.CommissionJson : JSON.stringify(rule.CommissionJson, null, 2)}
                        </pre>
                      </div>
                    )}
                    {rule.YearlySchedule && (
                      <div>
                        <label className="text-sm font-medium text-gray-700">Yearly Schedule</label>
                        <pre className="text-xs text-gray-600 mt-1 bg-white p-2 rounded border overflow-x-auto">
                          {rule.YearlySchedule}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 p-4 bg-gray-50">
          <div className="flex items-center justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CommissionRuleDetailsModal;


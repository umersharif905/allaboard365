import { AlertCircle, Building2, Calendar, CheckCircle, Clock, Package, User, XCircle } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import SharedHeader from '../../components/layout/SharedHeader';
import { apiService } from '../../services/api.service';

interface PendingSubscription {
  ProductSubscriptionId?: string;
  RequestId?: string;
  id?: string;
  RequestDate: string;
  Notes: string;
  ProductId: string;
  ProductName: string;
  ProductType: string;
  ProductOwnerName: string;
  TenantId: string;
  TenantName: string;
  TenantEmail: string;
  RequestedByName: string;
  RequestedByEmail: string;
  RequestedDiscount?: number;
  DiscountType?: string;
  BasePrice?: number;
}

interface PricingSummary {
  min: number;
  max: number;
  avg: number;
}

interface ApprovalModalProps {
  subscription: PendingSubscription | null;
  isOpen: boolean;
  onClose: () => void;
  onApprove: (id: string, data: any) => void;
  onDeny: (id: string, data: any) => void;
}

const ApprovalModal: React.FC<ApprovalModalProps> = ({ subscription, isOpen, onClose, onApprove, onDeny }) => {
  const [discountType, setDiscountType] = useState<'percentage' | 'flatRate'>('percentage');
  const [discountAmount, setDiscountAmount] = useState<number>(0);
  const [discountEffectiveDate, setDiscountEffectiveDate] = useState<string>('');
  const [discountEndDate, setDiscountEndDate] = useState<string>('');
  const [approvalNotes, setApprovalNotes] = useState<string>('');
  const [denialReason, setDenialReason] = useState<string>('');
  const [showDenialForm, setShowDenialForm] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'pricing'>('details');
  const [pricingData, setPricingData] = useState<any[]>([]);
  const [loadingPricing, setLoadingPricing] = useState(false);
  const [pricingSummary, setPricingSummary] = useState<PricingSummary>({ min: 0, max: 0, avg: 0 });

  useEffect(() => {
    if (subscription) {
      // Pre-fill with requested discount if available
      if (subscription.RequestedDiscount !== undefined) {
        setDiscountAmount(subscription.RequestedDiscount);
      }
      if (subscription.DiscountType) {
        setDiscountType(subscription.DiscountType as 'percentage' | 'flatRate');
      }
      // Fetch pricing data when subscription is selected
      fetchPricingData(subscription.ProductId);
    }
  }, [subscription]);

  const fetchPricingData = async (productId: string) => {
    try {
      setLoadingPricing(true);
      
      // Fetch product details endpoint directly (skip the pricing-only endpoint)
      const response = await apiService.get<{
        success: boolean;
        product?: any;
      }>(`/api/products/${productId}`);
      
      if (response?.success && response.product) {
        // Look for PricingTiers property specifically
        let pricingArray: any[] = [];
        
        // Check for PricingTiers
        if (response.product.PricingTiers && Array.isArray(response.product.PricingTiers)) {
          pricingArray = response.product.PricingTiers;
        } else if (response.product.pricingTiers && Array.isArray(response.product.pricingTiers)) {
          pricingArray = response.product.pricingTiers;
        } else if (response.product.pricing && Array.isArray(response.product.pricing)) {
          pricingArray = response.product.pricing;
        } else if (response.product.ProductPricing && Array.isArray(response.product.ProductPricing)) {
          pricingArray = response.product.ProductPricing;
        }
        
        // Flatten the pricing data if it has nested ageBands
        let flattenedPricingData: any[] = [];
        if (pricingArray.length > 0 && pricingArray[0].ageBands) {
          // The data is in the nested format with ageBands
          pricingArray.forEach(tier => {
            if (tier.ageBands && Array.isArray(tier.ageBands)) {
              tier.ageBands.forEach((band: any) => {
                flattenedPricingData.push({
                  ProductPricingId: band.id,
                  TierType: tier.tierType,
                  TobaccoStatus: tier.tobaccoStatus,
                  MinAge: band.minAge,
                  MaxAge: band.maxAge,
                  NetRate: band.netRate,
                  OverrideRate: band.overrideRate,
                  MSRPRate: band.affiliateRate, // affiliateRate is the MSRP
                  ConfigValue1: band.configValue1,
                  ConfigValue2: band.configValue2,
                  ConfigValue3: band.configValue3,
                  ConfigValue4: band.configValue4,
                  ConfigValue5: band.configValue5
                });
              });
            }
          });
          setPricingData(flattenedPricingData);
          calculatePricingSummary(flattenedPricingData);
        } else {
          // Data is already flat or in a different format
          setPricingData(pricingArray);
          calculatePricingSummary(pricingArray);
        }
      } else {
        setPricingData([]);
        setPricingSummary({ min: 0, max: 0, avg: 0 });
      }
    } catch (error: any) {
      console.error('Error fetching product/pricing data:', error);
      setPricingData([]);
      setPricingSummary({ min: 0, max: 0, avg: 0 });
    } finally {
      setLoadingPricing(false);
    }
  };

  const calculatePricingSummary = (pricingArray: any[]) => {
    if (pricingArray.length > 0) {
      const rates = pricingArray.map(tier => {
        // Handle different property names - affiliateRate is used as MSRP in the nested structure
        let msrpRate = 0;
        
        if (tier.MSRPRate !== undefined) {
          msrpRate = parseFloat(tier.MSRPRate) || 0;
        } else if (tier.affiliateRate !== undefined) {
          msrpRate = parseFloat(tier.affiliateRate) || 0;
        }
        
        return msrpRate;
      });
      
      const validRates = rates.filter(rate => rate > 0);
      
      if (validRates.length > 0) {
        const summary: PricingSummary = {
          min: Math.min(...validRates),
          max: Math.max(...validRates),
          avg: validRates.reduce((a, b) => a + b, 0) / validRates.length
        };
        setPricingSummary(summary);
      } else {
        setPricingSummary({ min: 0, max: 0, avg: 0 });
      }
    } else {
      setPricingSummary({ min: 0, max: 0, avg: 0 });
    }
  };

  if (!isOpen || !subscription) return null;

  const handleApprove = () => {
    const id = subscription.RequestId || subscription.id || subscription.ProductSubscriptionId;
    onApprove(id!, {
      status: 'Approved',
      discountAmount,
      discountType,
      discountEffectiveDate,
      discountEndDate,
      notes: approvalNotes
    });
  };

  const handleDeny = () => {
    const id = subscription.RequestId || subscription.id || subscription.ProductSubscriptionId;
    onDeny(id!, {
      status: 'Denied',
      denialReason,
      notes: denialReason
    });
  };

  const getRateFromTier = (tier: any): number => {
    // Check for MSRPRate first (this is what tenants pay)
    if (tier.MSRPRate !== undefined && typeof tier.MSRPRate === 'number') {
      return tier.MSRPRate;
    }
    
    // Check case variations
    if (tier.msrpRate !== undefined && typeof tier.msrpRate === 'number') {
      return tier.msrpRate;
    }
    
    if (tier.msrp_rate !== undefined && typeof tier.msrp_rate === 'number') {
      return tier.msrp_rate;
    }
    
    // Fallback to other rate properties
    const rateKeys = ['MSRP', 'msrp', 'Rate', 'rate', 'MonthlyRate', 'monthlyRate', 'monthly_rate', 'Premium', 'premium', 'Price', 'price'];
    for (const key of rateKeys) {
      if (tier[key] !== undefined && typeof tier[key] === 'number') {
        return tier[key];
      }
    }
    
    // If no specific key found, look for any numeric property with rate/price in the name
    for (const key in tier) {
      if ((key.toLowerCase().includes('rate') || key.toLowerCase().includes('price') || key.toLowerCase().includes('premium')) 
          && typeof tier[key] === 'number' && tier[key] > 0) {
        return tier[key];
      }
    }
    
    return 0;
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-5xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-gray-900">Review Subscription Request</h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-500"
            >
              <span className="text-2xl">&times;</span>
            </button>
          </div>

          {!showDenialForm ? (
            <>
              {/* Tabs */}
              <div className="flex border-b border-gray-200 mb-6">
                <button
                  onClick={() => setActiveTab('details')}
                  className={`px-4 py-2 font-medium text-sm border-b-2 ${
                    activeTab === 'details'
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Request Details
                </button>
                <button
                  onClick={() => setActiveTab('pricing')}
                  className={`px-4 py-2 font-medium text-sm border-b-2 ${
                    activeTab === 'pricing'
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Pricing Tiers
                </button>
              </div>

              {activeTab === 'details' ? (
                <>
                  {/* Request Details */}
                  <div className="bg-gray-50 rounded-lg p-4 mb-6">
                    <h3 className="font-semibold text-gray-900 mb-3">Request Details</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-sm text-gray-600">Product</p>
                        <p className="font-medium text-gray-900">{subscription.ProductName}</p>
                        <p className="text-sm text-gray-500">{subscription.ProductType}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-600">Product Owner</p>
                        <p className="font-medium text-gray-900">{subscription.ProductOwnerName}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-600">Requesting Tenant</p>
                        <p className="font-medium text-gray-900">{subscription.TenantName}</p>
                        <p className="text-sm text-gray-500">{subscription.TenantEmail}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-600">Requested By</p>
                        <p className="font-medium text-gray-900">{subscription.RequestedByName}</p>
                        <p className="text-sm text-gray-500">{subscription.RequestedByEmail}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-600">Request Date</p>
                        <p className="font-medium text-gray-900">
                          {new Date(subscription.RequestDate).toLocaleDateString()}
                        </p>
                      </div>
                      {subscription.RequestedDiscount !== undefined && (
                        <div>
                          <p className="text-sm text-gray-600">Requested Discount</p>
                          <p className="font-medium text-gray-900">
                            {subscription.DiscountType === 'percentage' ? `${subscription.RequestedDiscount}%` : `$${subscription.RequestedDiscount}`}
                          </p>
                        </div>
                      )}
                    </div>
                    {subscription.Notes && (
                      <div className="mt-4">
                        <p className="text-sm text-gray-600">Message from Tenant</p>
                        <p className="mt-1 text-gray-900 bg-white p-3 rounded border border-gray-200">
                          {subscription.Notes}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Pricing Summary */}
                  {pricingSummary.max > 0 && (
                    <div className="bg-oe-light rounded-lg p-4 mb-6">
                      <h3 className="font-semibold text-gray-900 mb-3">Pricing Summary</h3>
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-gray-700">Price Range:</span>
                          <span className="font-medium">
                            ${pricingSummary.min.toFixed(2)} - ${pricingSummary.max.toFixed(2)}/month
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-700">Average Price:</span>
                          <span className="font-medium">${pricingSummary.avg.toFixed(2)}/month</span>
                        </div>
                        <p className="text-xs text-gray-600 mt-2">
                          * Varies by tier type, tobacco status, and age band. 
                          Click "Pricing Tiers" tab to see full details.
                        </p>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                /* Pricing Tab */
                <div className="mb-6">
                  {loadingPricing ? (
                    <div className="flex justify-center py-8">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
                    </div>
                  ) : pricingData.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="min-w-full">
                        <thead>
                          <tr className="bg-gray-50">
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Tier Type
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Tobacco Status
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Age Band
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Net Rate
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Override
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              MSRP Rate
                            </th>
                            {discountAmount > 0 && (
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                After Discount
                              </th>
                            )}
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {pricingData.map((tier: any, index: number) => {
                            // Handle SQL Server decimal types which might be objects
                            const parseDecimal = (value: any): number => {
                              if (value === undefined || value === null) return 0;
                              if (typeof value === 'object' && value !== null) {
                                return parseFloat(value.value || value.toString()) || 0;
                              }
                              return parseFloat(value) || 0;
                            };
                            
                            const netRate = parseDecimal(tier.NetRate);
                            const overrideRate = parseDecimal(tier.OverrideRate);
                            const msrpRate = parseDecimal(tier.MSRPRate);
                            
                            const discountedRate = discountType === 'percentage'
                              ? msrpRate * (1 - discountAmount / 100)
                              : Math.max(0, msrpRate - discountAmount);
                            
                            return (
                              <tr key={tier.ProductPricingId || index} className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                                <td className="px-4 py-3 text-sm text-gray-900">
                                  {tier.TierType || 'Standard'}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-900">
                                  {tier.TobaccoStatus || 'N/A'}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-900">
                                  {tier.AgeBand || `Ages ${tier.MinAge || 0} - ${tier.MaxAge || 65}`}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-900 text-right font-medium">
                                  ${netRate.toFixed(2)}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-900 text-right font-medium">
                                  ${overrideRate.toFixed(2)}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-900 text-right font-medium">
                                  ${msrpRate.toFixed(2)}
                                </td>
                                {discountAmount > 0 && (
                                  <td className="px-4 py-3 text-sm text-green-600 text-right font-medium">
                                    ${discountedRate.toFixed(2)}
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="text-center py-8 text-gray-500">
                      <p>No pricing tiers available for this product.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Approval Options - Show on both tabs */}
              <div className="space-y-4">
                <h3 className="font-semibold text-gray-900">Approval Options</h3>

                {/* Discount Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Discount Type
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setDiscountType('percentage')}
                      className={`px-4 py-2 rounded-lg border font-medium transition-colors ${
                        discountType === 'percentage'
                          ? 'bg-oe-light border-oe-primary text-oe-primary'
                          : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      % Percentage
                    </button>
                    <button
                      type="button"
                      onClick={() => setDiscountType('flatRate')}
                      className={`px-4 py-2 rounded-lg border font-medium transition-colors ${
                        discountType === 'flatRate'
                          ? 'bg-oe-light border-oe-primary text-oe-primary'
                          : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      $ Flat Rate
                    </button>
                  </div>
                </div>

                {/* Discount Amount */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Discount {discountType === 'percentage' ? 'Percentage' : 'Amount'}
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      value={discountAmount}
                      onChange={(e) => setDiscountAmount(Number(e.target.value))}
                      min="0"
                      max={discountType === 'percentage' ? 100 : undefined}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder={discountType === 'percentage' ? 'e.g., 10' : 'e.g., 25.00'}
                    />
                    <span className="absolute right-3 top-2.5 text-gray-500">
                      {discountType === 'percentage' ? '%' : '$'}
                    </span>
                  </div>
                  {discountType === 'percentage' && (
                    <p className="mt-1 text-sm text-gray-500">Maximum 100% discount allowed</p>
                  )}
                </div>

                {/* Date Fields */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Discount Effective Date
                    </label>
                    <div className="relative">
                      <input
                        type="date"
                        value={discountEffectiveDate}
                        onChange={(e) => setDiscountEffectiveDate(e.target.value)}
                        className="w-full px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      />
                      <Calendar className="absolute right-3 top-2.5 h-5 w-5 text-gray-400" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Discount End Date
                    </label>
                    <div className="relative">
                      <input
                        type="date"
                        value={discountEndDate}
                        onChange={(e) => setDiscountEndDate(e.target.value)}
                        className="w-full px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      />
                      <Calendar className="absolute right-3 top-2.5 h-5 w-5 text-gray-400" />
                    </div>
                  </div>
                </div>

                {/* Approval Notes */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Approval Notes
                  </label>
                  <textarea
                    value={approvalNotes}
                    onChange={(e) => setApprovalNotes(e.target.value)}
                    rows={3}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="Add any notes about this approval..."
                  />
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex justify-end gap-3 mt-6 pt-6 border-t">
                <button
                  onClick={onClose}
                  className="px-6 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => setShowDenialForm(true)}
                  className="px-6 py-2.5 text-white bg-oe-error rounded-lg hover:bg-red-700 flex items-center gap-2 font-medium transition-colors shadow-sm"
                >
                  <XCircle size={18} /> Deny Request
                </button>
                <button
                  onClick={handleApprove}
                  className="px-6 py-2.5 text-white bg-oe-primary rounded-lg hover:bg-oe-dark flex items-center gap-2 font-medium transition-colors shadow-sm"
                >
                  <CheckCircle size={18} /> Approve Request
                </button>
              </div>
            </>
          ) : (
            /* Denial Form */
            <div>
              <h3 className="font-semibold text-gray-900 mb-4">Deny Subscription Request</h3>
              
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Reason for Denial <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={denialReason}
                  onChange={(e) => setDenialReason(e.target.value)}
                  rows={4}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500"
                  placeholder="Please provide a reason for denying this request..."
                  required
                />
              </div>

              <div className="flex justify-end gap-3">
                <button
                  onClick={() => {
                    setShowDenialForm(false);
                    setDenialReason('');
                  }}
                  className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Back
                </button>
                <button
                  onClick={handleDeny}
                  disabled={!denialReason.trim()}
                  className="px-4 py-2 text-white bg-oe-error rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Confirm Denial
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const SubscriptionApprovals: React.FC = () => {
  const [pendingSubscriptions, setPendingSubscriptions] = useState<PendingSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSubscription, setSelectedSubscription] = useState<PendingSubscription | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [notification, setNotification] = useState<{show: boolean; type: 'success' | 'error'; message: string}>({
    show: false,
    type: 'success',
    message: ''
  });

  // Get current user info
  const currentUser = {
    firstName: localStorage.getItem('firstName') || 'Admin',
    lastName: localStorage.getItem('lastName') || 'User',
    email: localStorage.getItem('email') || 'admin@openenroll.com',
    role: 'SysAdmin'
  };

  useEffect(() => {
    fetchPendingSubscriptions();
  }, []);

  const fetchPendingSubscriptions = async () => {
    try {
      setLoading(true);
      
      const response = await apiService.get<{
        success: boolean;
        pendingRequests?: PendingSubscription[];
        count?: number;
        message?: string;
      }>('/api/subscriptions/pending');
      
      if (response.success === false) {
        showNotification('error', response.message || 'Failed to load pending subscriptions');
        setPendingSubscriptions([]);
      } else if (response.pendingRequests) {
        setPendingSubscriptions(response.pendingRequests);
      } else {
        setPendingSubscriptions([]);
      }
    } catch (error: any) {
      console.error('Error fetching pending subscriptions:', error);
      
      // Check if it's a 404 or other specific error
      if (error.response?.status === 404) {
        showNotification('error', 'Subscription endpoint not found. Please check if the backend route is properly configured.');
      } else if (error.response?.status === 401) {
        showNotification('error', 'Authentication failed. Please login again.');
      } else {
        showNotification('error', error.message || 'Failed to load pending subscriptions');
      }
      
      setPendingSubscriptions([]);
    } finally {
      setLoading(false);
    }
  };

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ show: true, type, message });
    setTimeout(() => setNotification({ show: false, type: 'success', message: '' }), 5000);
  };

  const handleApprove = async (id: string, data: any) => {
    try {
      await apiService.put(`/api/subscriptions/${id}`, data);
      showNotification('success', 'Subscription approved successfully');
      setModalOpen(false);
      fetchPendingSubscriptions();
    } catch (error) {
      console.error('Error approving subscription:', error);
      showNotification('error', 'Failed to approve subscription');
    }
  };

  const handleDeny = async (id: string, data: any) => {
    try {
      await apiService.put(`/api/subscriptions/${id}`, data);
      showNotification('success', 'Subscription request denied');
      setModalOpen(false);
      fetchPendingSubscriptions();
    } catch (error) {
      console.error('Error denying subscription:', error);
      showNotification('error', 'Failed to deny subscription');
    }
  };

  const openApprovalModal = (subscription: PendingSubscription) => {
    setSelectedSubscription(subscription);
    setModalOpen(true);
  };

  const handleLogout = () => {
    localStorage.clear();
    window.location.href = '/login';
  };

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Admin Navigation Sidebar */}
      {/* <AdminNavigation 
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        currentUser={currentUser}
        onLogout={handleLogout}
      /> */}
      
      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <SharedHeader 
          title="Subscription Approvals"
          showSearch={false}
          showNotifications={true}
        />
        
        {/* Page Content */}
        <main className="flex-1 overflow-y-auto bg-gray-50">
          <div className="p-6">
            <div className="mb-6">
              <h1 className="text-3xl font-bold text-gray-900 mb-2">Subscription Approvals</h1>
              <p className="text-gray-600">Review and approve pending product subscription requests</p>
            </div>

            {/* Notification */}
            {notification.show && (
              <div className={`mb-4 p-4 rounded-lg flex items-center ${
                notification.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
              }`}>
                {notification.type === 'success' ? (
                  <CheckCircle className="mr-2" size={20} />
                ) : (
                  <AlertCircle className="mr-2" size={20} />
                )}
                {notification.message}
              </div>
            )}

            {/* Loading State */}
            {loading ? (
              <div className="flex items-center justify-center h-64">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
              </div>
            ) : (
              <>
                {/* Pending Count Badge */}
                {pendingSubscriptions.length > 0 && (
                  <div className="mb-4 flex items-center">
                    <span className="bg-yellow-100 text-yellow-800 px-3 py-1 rounded-full text-sm font-medium flex items-center">
                      <Clock size={16} className="mr-1" />
                      {pendingSubscriptions.length} Pending {pendingSubscriptions.length === 1 ? 'Request' : 'Requests'}
                    </span>
                  </div>
                )}

                {/* Subscriptions List */}
                {pendingSubscriptions.length === 0 ? (
                <div className="bg-white rounded-lg shadow p-12 text-center">
                    <CheckCircle className="mx-auto h-12 w-12 text-green-500 mb-4" />
                    <h3 className="text-lg font-medium text-gray-900 mb-2">All Caught Up!</h3>
                    <p className="text-gray-600">No pending subscription requests at this time.</p>
                  </div>
                ) : (
                  <div className="bg-white rounded-lg shadow overflow-hidden">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Product
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Requesting Tenant
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Requested By
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Request Date
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {pendingSubscriptions.map((subscription) => (
                          <tr key={subscription.RequestId || subscription.id || subscription.ProductSubscriptionId} className="hover:bg-gray-50">
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="flex items-center">
                                <Package className="h-8 w-8 text-gray-400 mr-3" />
                                <div>
                                  <div className="text-sm font-medium text-gray-900">{subscription.ProductName}</div>
                                  <div className="text-sm text-gray-500">{subscription.ProductType}</div>
                                  <div className="text-xs text-gray-400">by {subscription.ProductOwnerName}</div>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="flex items-center">
                                <Building2 className="h-5 w-5 text-gray-400 mr-2" />
                                <div>
                                  <div className="text-sm font-medium text-gray-900">{subscription.TenantName}</div>
                                  <div className="text-sm text-gray-500">{subscription.TenantEmail}</div>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="flex items-center">
                                <User className="h-5 w-5 text-gray-400 mr-2" />
                                <div>
                                  <div className="text-sm text-gray-900">{subscription.RequestedByName}</div>
                                  <div className="text-sm text-gray-500">{subscription.RequestedByEmail}</div>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="flex items-center text-sm text-gray-900">
                                <Calendar className="h-4 w-4 text-gray-400 mr-2" />
                                {new Date(subscription.RequestDate).toLocaleDateString()}
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                              <button
                                onClick={() => openApprovalModal(subscription)}
                                className="text-oe-primary hover:text-oe-dark font-medium"
                              >
                                Review Request
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </main>
      </div>

      {/* Enhanced Approval Modal */}
      <ApprovalModal
        subscription={selectedSubscription}
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setSelectedSubscription(null);
        }}
        onApprove={handleApprove}
        onDeny={handleDeny}
      />
    </div>
  );
};

export default SubscriptionApprovals;
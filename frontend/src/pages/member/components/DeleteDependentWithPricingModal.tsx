import { AlertCircle, Calendar, DollarSign, Trash2, Users, X } from 'lucide-react';
import React, { useState } from 'react';
import { useMemberEnrollments } from '../../../hooks/member/useMemberEnrollments';
import { HouseholdMember, useMemberHousehold } from '../../../hooks/member/useMemberHousehold';
import { useMemberPricing } from '../../../hooks/useMemberPricing';
import { useTierChange } from '../../../hooks/usePricing';
import { usePricingSimulation } from '../../../hooks/usePricingSimulation';
import { PricingService } from '../../../services/pricing.service';

interface DeleteDependentWithPricingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDelete: (memberId: string) => Promise<{ success: boolean; data: any; message?: string }>;
  member: HouseholdMember;
  isLoading: boolean;
}

type TabType = 'confirm' | 'pricing' | 'final';

const DeleteDependentWithPricingModal: React.FC<DeleteDependentWithPricingModalProps> = ({
  isOpen,
  onClose,
  onDelete,
  member,
  isLoading
}) => {
  const [currentTab, setCurrentTab] = useState<TabType>('confirm');

  // Get current household data
  const { data: householdData } = useMemberHousehold();
  const currentMember = householdData?.householdMembers?.find(m => m.IsCurrentUser);
  const existingDependents = householdData?.householdMembers?.filter(m => !m.IsCurrentUser) || [];

  // Get current enrollments to use real product data
  const { data: currentEnrollments } = useMemberEnrollments();

  // Calculate current tier based on existing dependents
  const hasSpouse = existingDependents.some(dep => dep.RelationshipType === 'S');
  const childrenCount = existingDependents.filter(dep => dep.RelationshipType === 'C').length;
  const currentTier = PricingService.calculateMemberTier(hasSpouse, childrenCount);

  // Calculate new tier after removing dependent
  const newHasSpouse = hasSpouse && member.RelationshipType !== 'S';
  const newChildrenCount = childrenCount - (member.RelationshipType === 'C' ? 1 : 0);
  const tierChange = useTierChange(currentTier, newHasSpouse, newChildrenCount);

  // Get current pricing for comparison
  const { data: currentPricingData } = useMemberPricing();

  // Calculate pricing for new tier (after removing dependent)
  const simulationChanges = {
    addProducts: [], // No products being added, just tier change
    removeProducts: [],
    configChanges: {},
    simulationContext: {
      type: 'remove-dependent' as const,
      changes: {
        removeDependents: [{ relationshipType: member.RelationshipType }],
      },
    },
  };

  const { data: newPricingData, isLoading: pricingLoading, error: pricingError } = usePricingSimulation(
    undefined, // memberId - will use current user
    simulationChanges,
    currentTab === 'pricing' || currentTab === 'final'
  );

  // Calculate pricing comparison
  const pricingComparison = {
    currentTotal: currentPricingData?.totals?.totalPremium || 0,
    newTotal: newPricingData?.totals?.totalPremium || 0,
    difference: 0,
    isIncrease: false,
    isDecrease: false,
    isNoChange: true
  };

  if (currentPricingData && newPricingData) {
    pricingComparison.currentTotal = currentPricingData.totals?.totalPremium || 0;
    pricingComparison.newTotal = newPricingData.totals?.totalPremium || 0;
    pricingComparison.difference = pricingComparison.newTotal - pricingComparison.currentTotal;
    pricingComparison.isIncrease = pricingComparison.difference > 0;
    pricingComparison.isDecrease = pricingComparison.difference < 0;
    pricingComparison.isNoChange = pricingComparison.difference === 0;
  }

  const handleDelete = async () => {
    try {
      const result = await onDelete(member.MemberId);
      if (result.success) {
        // Wait a moment for the cache invalidation to complete
        setTimeout(() => {
          onClose();
        }, 500);
      }
    } catch (error) {
      console.error('Failed to delete dependent:', error);
    }
  };

  const getRelationshipIcon = (relationshipType: string) => {
    switch (relationshipType) {
      case 'S': return '💕';
      case 'C': return '👶';
      default: return '👤';
    }
  };

  const getRelationshipDescription = (relationshipType: string) => {
    switch (relationshipType) {
      case 'S': return 'Spouse';
      case 'C': return 'Child';
      default: return 'Dependent';
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center">
              <Trash2 size={20} className="text-red-600" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Remove Dependent</h2>
              <p className="text-sm text-gray-600">This action cannot be undone</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Tab Navigation */}
          <div className="flex space-x-1 mb-6 bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setCurrentTab('confirm')}
              className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                currentTab === 'confirm'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Confirm Removal
            </button>
            <button
              onClick={() => setCurrentTab('pricing')}
              className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                currentTab === 'pricing'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Pricing Impact
            </button>
            <button
              onClick={() => setCurrentTab('final')}
              className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                currentTab === 'final'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Final Confirmation
            </button>
          </div>

          {/* Tab Content */}
          {currentTab === 'confirm' && (
            <div className="space-y-6">
              {/* Member Info */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <div className="flex items-center space-x-3">
                  <div className="text-2xl">{getRelationshipIcon(member.RelationshipType)}</div>
                  <div>
                    <h3 className="font-medium text-gray-900">
                      {member.FirstName} {member.LastName}
                    </h3>
                    <p className="text-sm text-gray-600">{member.Email}</p>
                    <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800 mt-1">
                      {getRelationshipDescription(member.RelationshipType)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Warning */}
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <div className="flex items-start space-x-3">
                  <AlertCircle size={20} className="text-red-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-medium text-red-900">Important Notice</h4>
                    <p className="text-sm text-red-800 mt-1">
                      Removing this dependent will:
                    </p>
                    <ul className="text-sm text-red-800 mt-2 space-y-1 list-disc list-inside">
                      <li>Remove them from all coverage plans on the next billing cycle</li>
                      <li>Update your household tier and pricing</li>
                      <li>Their account will remain active until termination date</li>
                      <li>This action cannot be undone</li>
                    </ul>
                  </div>
                </div>
              </div>

              {/* Navigation */}
              <div className="flex justify-end space-x-3">
                <button
                  onClick={onClose}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => setCurrentTab('pricing')}
                  className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors"
                >
                  Review Pricing Impact
                </button>
              </div>
            </div>
          )}

          {currentTab === 'pricing' && (
            <div className="space-y-6">
              {/* Pricing Summary */}
              {pricingLoading ? (
                <div className="text-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto"></div>
                  <p className="text-gray-600 mt-2">Calculating pricing impact...</p>
                </div>
              ) : pricingError ? (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <div className="flex items-center space-x-3">
                    <AlertCircle size={20} className="text-red-600" />
                    <div>
                      <p className="font-medium text-red-900">Unable to calculate pricing</p>
                      <p className="text-sm text-red-800 mt-1">
                        {pricingError.message || 'Please try again later.'}
                      </p>
                    </div>
                  </div>
                </div>
              ) : pricingComparison && (
                <div className="space-y-4">
                  {/* Current vs New Pricing */}
                  <div className="bg-white border border-gray-200 rounded-lg p-6">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 flex items-center">
                      <DollarSign size={20} className="mr-2" />
                      Pricing Impact
                    </h3>
                    
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                      <div className="text-center">
                        <p className="text-sm text-gray-600">Current Premium</p>
                        <p className="text-2xl font-semibold text-gray-900">
                          {PricingService.formatCurrency(pricingComparison.currentTotal)}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-sm text-gray-600">New Premium</p>
                        <p className="text-2xl font-semibold text-gray-900">
                          {PricingService.formatCurrency(pricingComparison.newTotal)}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-sm text-gray-600">Monthly Change</p>
                        <p className={`text-2xl font-semibold ${
                          pricingComparison.isIncrease ? 'text-gray-900' : 'text-green-600'
                        }`}>
                          {pricingComparison.isIncrease 
                            ? `+$${pricingComparison.difference.toFixed(2)}/month` 
                            : pricingComparison.isDecrease 
                              ? `-$${Math.abs(pricingComparison.difference).toFixed(2)}/month` 
                              : 'No change'
                          }
                        </p>
                      </div>
                    </div>

                    {/* Itemized Product Breakdown */}
                    <div className="border-t border-gray-200 pt-4">
                      <h5 className="text-sm font-medium text-gray-700 mb-3">Product Breakdown</h5>
                      <div className="space-y-2">
                        {currentPricingData?.products ? currentPricingData.products.map((product: any) => {
                          const newProduct = newPricingData?.products ? newPricingData.products.find((p: any) => p.productId === product.productId) : undefined;
                          const currentCost = product.employeeContribution || 0;
                          const newCost = newProduct?.employeeContribution || 0;
                          const productChange = newCost - currentCost;
                          
                          return (
                            <div key={product.productId} className="flex justify-between items-center py-2 px-3 bg-gray-50 rounded border">
                              <div>
                                <span className="text-sm font-medium text-gray-900">{product.productName || 'Unknown Product'}</span>
                                <span className="text-xs text-gray-500 ml-2">
                                  {product.tierType || 'N/A'} → {newProduct?.tierType || 'N/A'}
                                </span>
                              </div>
                              <div className="text-right">
                                <div className="text-sm text-gray-600">
                                  {PricingService.formatCurrency(currentCost)} → {PricingService.formatCurrency(newCost)}
                                </div>
                                <div className={`text-xs font-medium ${
                                  productChange > 0 ? 'text-gray-700' : productChange < 0 ? 'text-green-600' : 'text-gray-500'
                                }`}>
                                  {productChange !== 0 ? PricingService.formatCurrency(productChange) : 'No change'}
                                </div>
                              </div>
                            </div>
                          );
                        }) : (
                          <div className="text-center py-4 text-gray-500">
                            <p className="text-sm">No product information available</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Effective Date */}
                  {newPricingData && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                      <div className="flex items-center space-x-3">
                        <Calendar size={20} className="text-oe-primary" />
                        <div>
                          <p className="font-medium text-blue-900">Effective Date</p>
                          <p className="text-sm text-oe-primary-dark">
                            Changes will take effect on your next billing cycle: {new Date().toLocaleDateString('en-US', {
                              weekday: 'long',
                              year: 'numeric',
                              month: 'long',
                              day: 'numeric'
                            })}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Coverage Tier Change */}
                  {tierChange.hasChanged && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center">
                          <Users size={20} className="text-oe-primary mr-2" />
                          <span className="font-medium text-blue-900">Coverage Tier:</span>
                        </div>
                        <span className="text-blue-900">
                          {currentTier} → {tierChange.newTier}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Navigation */}
              <div className="flex justify-between">
                <button
                  onClick={() => setCurrentTab('confirm')}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => setCurrentTab('final')}
                  className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors"
                >
                  Continue to Final Confirmation
                </button>
              </div>
            </div>
          )}

          {currentTab === 'final' && (
            <div className="space-y-6">
              {/* Final Warning */}
              <div className="bg-red-50 border border-red-200 rounded-lg p-6">
                <div className="flex items-start space-x-3">
                  <AlertCircle size={24} className="text-red-600 flex-shrink-0" />
                  <div>
                    <h3 className="text-lg font-medium text-red-900">Final Confirmation</h3>
                    <p className="text-red-800 mt-2">
                      You are about to permanently remove <strong>{member.FirstName} {member.LastName}</strong> from your household.
                    </p>
                    <p className="text-red-800 mt-2">
                      This action will:
                    </p>
                    <ul className="text-red-800 mt-2 space-y-1 list-disc list-inside">
                      <li>Remove them from all coverage plans on the next billing cycle</li>
                      <li>Update your household tier and pricing</li>
                      <li>Their account will remain active until termination date</li>
                      <li>Cannot be undone</li>
                    </ul>
                  </div>
                </div>
              </div>

              {/* Pricing Summary */}
              {pricingComparison && (
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900 mb-3">Pricing Impact Summary</h4>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-700">Current Monthly Premium:</span>
                      <span className="font-medium text-gray-900">
                        {PricingService.formatCurrency(pricingComparison.currentTotal)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-700">New Monthly Premium:</span>
                      <span className="font-medium text-gray-900">
                        {PricingService.formatCurrency(pricingComparison.newTotal)}
                      </span>
                    </div>
                    <div className="flex justify-between border-t border-gray-200 pt-2">
                      <span className="font-medium text-gray-900">Monthly Change:</span>
                      <span className={`font-medium ${
                        pricingComparison.isIncrease ? 'text-red-600' : 'text-green-600'
                      }`}>
                        {pricingComparison.isIncrease 
                          ? `+$${pricingComparison.difference.toFixed(2)}/month` 
                          : pricingComparison.isDecrease 
                            ? `-$${Math.abs(pricingComparison.difference).toFixed(2)}/month` 
                            : 'No change'
                        }
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Navigation */}
              <div className="flex justify-between">
                <button
                  onClick={() => setCurrentTab('pricing')}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Back
                </button>
                <div className="flex space-x-3">
                  <button
                    onClick={onClose}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={isLoading}
                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors flex items-center"
                  >
                    {isLoading ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                        Removing...
                      </>
                    ) : (
                      <>
                        <Trash2 size={16} className="mr-2" />
                        Remove Dependent
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DeleteDependentWithPricingModal;

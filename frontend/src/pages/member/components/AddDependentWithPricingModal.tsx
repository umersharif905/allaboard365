import { AlertCircle, Calendar, CheckCircle, ChevronLeft, ChevronRight, DollarSign, Users, X } from 'lucide-react';
import React, { useState } from 'react';
import { AddDependentData, useMemberHousehold } from '../../../hooks/member/useMemberHousehold';
import { useMemberPricing } from '../../../hooks/useMemberPricing';
import { useTierChange } from '../../../hooks/usePricing';
import { usePricingSimulation } from '../../../hooks/usePricingSimulation';
import { PricingService } from '../../../services/pricing.service';
import { validateSSN } from '../../../utils/helpers';

interface AddDependentWithPricingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (dependentData: AddDependentData) => Promise<{ success: boolean; data: any; message?: string }>;
  isLoading: boolean;
}

type TabType = 'add' | 'pricing' | 'confirm';

const AddDependentWithPricingModal: React.FC<AddDependentWithPricingModalProps> = ({
  isOpen,
  onClose,
  onAdd,
  isLoading
}) => {
  const [currentTab, setCurrentTab] = useState<TabType>('add');
  const [dependentData, setDependentData] = useState<AddDependentData>({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    dateOfBirth: '',
    gender: '',
    ssn: '',
    relationshipType: 'C' // Default to child instead of spouse
  });

  // Get current household data
  const { data: householdData } = useMemberHousehold();
  const existingDependents = householdData?.householdMembers?.filter(member => !member.IsCurrentUser) || [];

  // Calculate current tier based on existing dependents
  const hasSpouse = existingDependents.some(dep => dep.RelationshipType === 'S');
  const childrenCount = existingDependents.filter(dep => dep.RelationshipType === 'C').length;
  const currentTier = PricingService.calculateMemberTier(hasSpouse, childrenCount);

  // Calculate new tier after adding dependent
  const newHasSpouse = hasSpouse || dependentData.relationshipType === 'S';
  const newChildrenCount = childrenCount + (dependentData.relationshipType === 'C' ? 1 : 0);
  const tierChange = useTierChange(currentTier, newHasSpouse, newChildrenCount);

  // Get current pricing for comparison
  const { data: currentPricingData } = useMemberPricing();

  // Calculate pricing for new tier (after adding dependent)
  const simulationChanges = {
    addProducts: [], // No products being added, just tier change
    removeProducts: [],
    configChanges: {},
    simulationContext: {
      type: 'add-dependent' as const,
      changes: {
        addDependents: [{ relationshipType: dependentData.relationshipType || 'C' }],
      },
    },
  };

  const { data: newPricingData, isLoading: pricingLoading, error: pricingError } = usePricingSimulation(
    undefined, // memberId - will use current user
    simulationChanges,
    currentTab === 'pricing' || currentTab === 'confirm'
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

  const handleInputChange = (field: keyof AddDependentData, value: string) => {
    setDependentData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleNext = () => {
    if (currentTab === 'add') {
      setCurrentTab('pricing');
    } else if (currentTab === 'pricing') {
      setCurrentTab('confirm');
    }
  };

  const handleBack = () => {
    if (currentTab === 'pricing') {
      setCurrentTab('add');
    } else if (currentTab === 'confirm') {
      setCurrentTab('pricing');
    }
  };

  const handleConfirm = async () => {
    if (dependentData.relationshipType === 'S') {
      const em = (dependentData.email || '').trim();
      if (!em) {
        alert('Email is required when adding a spouse.');
        return;
      }
      const simpleEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!simpleEmail.test(em)) {
        alert('Please enter a valid email address for your spouse.');
        return;
      }
    }
    const ssnDigits = (dependentData.ssn || '').replace(/\D/g, '');
    if (ssnDigits.length > 0 && ssnDigits.length !== 9) {
      alert('Social Security Number must be exactly 9 digits or left blank.');
      return;
    }
    if (ssnDigits.length === 9) {
      const check = validateSSN(ssnDigits);
      if (!check.isValid) {
        alert(check.error || 'Invalid SSN');
        return;
      }
    }
    const payload: AddDependentData = {
      firstName: dependentData.firstName,
      lastName: dependentData.lastName,
      phone: dependentData.phone,
      dateOfBirth: dependentData.dateOfBirth,
      gender: dependentData.gender,
      relationshipType: dependentData.relationshipType,
      ssn: ssnDigits.length === 9 ? ssnDigits : undefined
    };
    if (dependentData.relationshipType === 'S') {
      payload.email = (dependentData.email || '').trim();
    }
    try {
      const result = await onAdd(payload);
      if (result?.success) {
        onClose();
        // Reset form
        setDependentData({
          firstName: '',
          lastName: '',
          email: '',
          phone: '',
          dateOfBirth: '',
          gender: '',
          ssn: '',
          relationshipType: 'C'
        });
        setCurrentTab('add');
      }
    } catch (error) {
      console.error('Failed to add dependent:', error);
    }
  };

  const isAddStepValid =
    !!dependentData.firstName &&
    !!dependentData.lastName &&
    !!dependentData.dateOfBirth &&
    !!dependentData.gender &&
    (dependentData.relationshipType === 'C' ||
      !!(dependentData.email && dependentData.email.trim()));

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
              <Users size={20} className="text-oe-primary" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Add Dependent</h2>
              <p className="text-sm text-gray-600">Add a family member to your coverage</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X size={24} />
          </button>
        </div>

        {/* Progress Steps */}
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            {[
              { key: 'add', label: 'Add Dependent', icon: Users },
              { key: 'pricing', label: 'Review Cost', icon: DollarSign },
              { key: 'confirm', label: 'Confirm', icon: CheckCircle }
            ].map((step, index) => {
              const Icon = step.icon;
              const isActive = currentTab === step.key;
              const isCompleted = ['add', 'pricing', 'confirm'].indexOf(currentTab) > index;
              
              return (
                <div key={step.key} className="flex items-center">
                  <div className={`flex items-center space-x-2 ${index > 0 ? 'ml-8' : ''}`}>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      isActive ? 'bg-oe-primary text-white' : 
                      isCompleted ? 'bg-green-600 text-white' : 
                      'bg-gray-200 text-gray-600'
                    }`}>
                      <Icon size={16} />
                    </div>
                    <span className={`text-sm font-medium ${
                      isActive ? 'text-oe-primary' : 
                      isCompleted ? 'text-green-600' : 
                      'text-gray-500'
                    }`}>
                      {step.label}
                    </span>
                  </div>
                  {index < 2 && (
                    <div className={`w-8 h-0.5 mx-4 ${
                      isCompleted ? 'bg-green-600' : 'bg-gray-200'
                    }`} />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[60vh]">
          {currentTab === 'add' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-4">Dependent Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="form-label">First Name *</label>
                    <input
                      type="text"
                      value={dependentData.firstName}
                      onChange={(e) => handleInputChange('firstName', e.target.value)}
                      className="form-input"
                      placeholder="Enter first name"
                    />
                  </div>
                  <div>
                    <label className="form-label">Last Name *</label>
                    <input
                      type="text"
                      value={dependentData.lastName}
                      onChange={(e) => handleInputChange('lastName', e.target.value)}
                      className="form-input"
                      placeholder="Enter last name"
                    />
                  </div>
                  {dependentData.relationshipType === 'S' && (
                    <div>
                      <label className="form-label">Email Address *</label>
                      <input
                        type="email"
                        value={dependentData.email}
                        onChange={(e) => handleInputChange('email', e.target.value)}
                        className="form-input"
                        placeholder="Enter email address"
                      />
                      <p className="text-xs text-gray-500 mt-1">Must be unique in the system. Not required for a child.</p>
                    </div>
                  )}
                  {dependentData.relationshipType === 'C' && (
                    <div className="md:col-span-2 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-3">
                      Email is assigned automatically for a child. Address will match the primary member&apos;s household.
                    </div>
                  )}
                  <div>
                    <label className="form-label">Phone Number</label>
                    <input
                      type="tel"
                      value={dependentData.phone || ''}
                      onChange={(e) => handleInputChange('phone', e.target.value)}
                      className="form-input"
                      placeholder="Enter phone number"
                    />
                  </div>
                  <div>
                    <label className="form-label">Date of Birth *</label>
                    <input
                      type="date"
                      value={dependentData.dateOfBirth}
                      onChange={(e) => handleInputChange('dateOfBirth', e.target.value)}
                      className="form-input"
                    />
                  </div>
                  <div>
                    <label className="form-label">Gender *</label>
                    <select
                      value={dependentData.gender}
                      onChange={(e) => handleInputChange('gender', e.target.value)}
                      className="form-select"
                    >
                      <option value="">Select gender</option>
                      <option value="Male">Male</option>
                      <option value="Female">Female</option>

                    </select>
                  </div>
                  <div className="md:col-span-2">
                    <label className="form-label">Social Security Number (optional)</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={dependentData.ssn || ''}
                      onChange={(e) =>
                        setDependentData((prev) => ({
                          ...prev,
                          ssn: e.target.value.replace(/\D/g, '').slice(0, 9)
                        }))
                      }
                      className="form-input"
                      placeholder="Enter 9 digits"
                      maxLength={9}
                    />
                    <p className="text-xs text-gray-500 mt-1">Nine digits, no dashes.</p>
                  </div>
                  <div className="md:col-span-2">
                    <label className="form-label">Relationship *</label>
                    <div className="grid grid-cols-2 gap-4 mt-2">
                      <label className={`flex items-center p-4 border border-gray-200 rounded-lg ${hasSpouse ? 'cursor-not-allowed opacity-50 bg-gray-50' : 'cursor-pointer hover:bg-gray-50'}`}>
                        <input
                          type="radio"
                          name="relationshipType"
                          value="S"
                          checked={dependentData.relationshipType === 'S'}
                          onChange={(e) => handleInputChange('relationshipType', e.target.value as 'S' | 'C')}
                          disabled={hasSpouse}
                          className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                        />
                        <div className="ml-3">
                          <div className="flex items-center">
                            <Users size={20} className="text-red-500 mr-2" />
                            <span className="font-medium text-gray-900">Spouse</span>
                            {hasSpouse && <span className="ml-2 text-xs text-gray-500">(Already exists)</span>}
                          </div>
                          <p className="text-sm text-gray-600">Your husband or wife</p>
                        </div>
                      </label>
                      <label className="flex items-center p-4 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50">
                        <input
                          type="radio"
                          name="relationshipType"
                          value="C"
                          checked={dependentData.relationshipType === 'C'}
                          onChange={() =>
                            setDependentData((prev) => ({ ...prev, relationshipType: 'C', email: '' }))
                          }
                          className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                        />
                        <div className="ml-3">
                          <div className="flex items-center">
                            <Users size={20} className="text-blue-500 mr-2" />
                            <span className="font-medium text-gray-900">Child</span>
                          </div>
                          <p className="text-sm text-gray-600">Your son or daughter</p>
                        </div>
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {currentTab === 'pricing' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-4">Coverage Impact</h3>
                


                {/* Pricing Comparison */}
                {pricingLoading && (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
                    <span className="ml-3 text-gray-600">Calculating pricing...</span>
                  </div>
                )}

                {pricingError && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <div className="flex items-center">
                      <AlertCircle size={20} className="text-red-600 mr-2" />
                      <p className="text-red-800">Unable to calculate pricing. Please try again.</p>
                    </div>
                  </div>
                )}

                {(pricingComparison.isIncrease || pricingComparison.isDecrease || pricingComparison.isNoChange) && (
                  <div className="bg-white border border-gray-200 rounded-lg p-6">
                    <h4 className="font-medium text-gray-900 mb-4">Monthly Premium Impact</h4>
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
                                <span className="text-sm font-medium text-gray-900">{product.productName}</span>
                                <span className="text-xs text-gray-500 ml-2">
                                  {product.tierType} → {newProduct?.tierType || 'N/A'}
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
                )}

                {/* Effective Date */}
                {newPricingData && (
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                    <div className="flex items-center">
                      <Calendar size={20} className="text-gray-600 mr-2" />
                      <div>
                        <p className="font-medium text-gray-900">Effective Date</p>
                        <p className="text-sm text-gray-600">
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

                {/* Coverage Tier Change - Simple 1-line format */}
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
            </div>
          )}

          {currentTab === 'confirm' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-4">Confirm Addition</h3>
                
                {/* Dependent Summary */}
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-6">
                  <h4 className="font-medium text-gray-900 mb-3">Dependent to be Added</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-gray-600">Name</p>
                      <p className="font-medium text-gray-900">
                        {dependentData.firstName} {dependentData.lastName}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Relationship</p>
                      <p className="font-medium text-gray-900">
                        {dependentData.relationshipType === 'S' ? 'Spouse' : 'Child'}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Email</p>
                      <p className="font-medium text-gray-900">
                        {dependentData.relationshipType === 'S'
                          ? dependentData.email
                          : 'Assigned automatically for child dependents'}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Date of Birth</p>
                      <p className="font-medium text-gray-900">{dependentData.dateOfBirth}</p>
                    </div>
                  </div>
                </div>

                {/* Final Pricing Summary */}
                {(pricingComparison.isIncrease || pricingComparison.isDecrease || pricingComparison.isNoChange) && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <h4 className="font-medium text-blue-900 mb-3">Final Pricing Summary</h4>
                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <span className="text-oe-primary-dark">Current Monthly Premium:</span>
                        <span className="font-medium text-blue-900">
                          {PricingService.formatCurrency(pricingComparison.currentTotal)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-oe-primary-dark">New Monthly Premium:</span>
                        <span className="font-medium text-blue-900">
                          {PricingService.formatCurrency(pricingComparison.newTotal)}
                        </span>
                      </div>

                    </div>
                  </div>
                )}

                {/* Confirmation Message */}
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <div className="flex items-start">
                    <AlertCircle size={20} className="text-yellow-600 mr-2 mt-0.5" />
                    <div>
                      <p className="font-medium text-yellow-900">Please Review Carefully</p>
                      <p className="text-sm text-yellow-800 mt-1">
                        By confirming, you agree to add this dependent to your coverage and accept the new monthly premium amount. 
                        This change will take effect on your next billing cycle.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-gray-200 bg-gray-50">
          <button
            onClick={handleBack}
            disabled={currentTab === 'add'}
            className="btn-secondary flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={16} className="mr-2" />
            Back
          </button>
          
          <div className="flex items-center space-x-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 hover:text-gray-900 transition-colors"
            >
              Cancel
            </button>
            
            {currentTab === 'confirm' ? (
              <button
                onClick={handleConfirm}
                disabled={isLoading}
                className="btn-primary flex items-center"
              >
                {isLoading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                    Adding...
                  </>
                ) : (
                  <>
                    <CheckCircle size={16} className="mr-2" />
                    Confirm Addition
                  </>
                )}
              </button>
            ) : (
              <button
                onClick={handleNext}
                disabled={currentTab === 'add' && !isAddStepValid}
                className="btn-primary flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
                <ChevronRight size={16} className="ml-2" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AddDependentWithPricingModal;

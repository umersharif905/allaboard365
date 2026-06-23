import { CheckCircle, DollarSign, Plus, Settings, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useMemberPricing } from '../../hooks/useMemberPricing';
import { usePricingSimulation } from '../../hooks/usePricingSimulation';
import { MemberEnrollment, MemberEnrollmentService } from '../../services/member/member-enrollments.service';

interface PlanChangesModalProps {
  enrollment: MemberEnrollment;
  isOpen: boolean;
  onClose: () => void;
  onSaveChanges: (changes: PlanChanges) => Promise<void>;
}

interface PlanChanges {
  configFieldChanges: Record<string, string>;
  addProducts: string[];
  removeProducts: string[];
  effectiveDate?: string;
}

interface ConfigField {
  fieldName: string;
  fieldType: string;
  options: string[];
  currentValue: string;
}

export default function PlanChangesModal({ 
  enrollment, 
  isOpen, 
  onClose, 
  onSaveChanges 
}: PlanChangesModalProps) {
  const [activeTab, setActiveTab] = useState<'config' | 'products' | 'summary'>('config');
  const [configFields, setConfigFields] = useState<ConfigField[]>([]);
  const [configChanges, setConfigChanges] = useState<Record<string, string>>({});
  const [availableProducts, setAvailableProducts] = useState<any[]>([]);
  const [selectedProductsToAdd, setSelectedProductsToAdd] = useState<string[]>([]);
  const [selectedProductsToRemove, setSelectedProductsToRemove] = useState<string[]>([]);
  const [effectiveDate, setEffectiveDate] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [pricingImpact, setPricingImpact] = useState<any>(null);

  // Get current pricing for comparison
  const { data: currentPricing } = useMemberPricing();

  // Load configuration fields from current pricing data
  useEffect(() => {
    if (currentPricing?.products) {
      const productPricing = currentPricing.products.find(
        (p: any) => p.productId === enrollment.productId
      );
      
      if (productPricing?.hasConfigurationFields && productPricing.requiredDataFields) {
        const fields = productPricing.requiredDataFields.map((field: any) => ({
          fieldName: field.fieldName || field.name,
          fieldType: field.fieldType || 'dropdown',
          options: field.options || field.fieldOptions || [],
          currentValue: field.currentValue || ''
        }));
        setConfigFields(fields);
      } else {
        setConfigFields([]);
      }
    }
  }, [currentPricing, enrollment.productId]);

  // Load available products for adding
  useEffect(() => {
    const loadAvailableProducts = async () => {
      try {
        const response = await MemberEnrollmentService.getAvailableProducts();
        if (response.success) {
          // Filter out products that are already enrolled
          const availableProducts = response.data.filter((product: any) => 
            product.productId !== enrollment.productId && product.canEnroll
          );
          setAvailableProducts(availableProducts);
        }
      } catch (error) {
        console.error('Error loading available products:', error);
      }
    };

    if (isOpen) {
      loadAvailableProducts();
    }
  }, [isOpen, enrollment.productId]);

  // Calculate pricing impact using new simulation hook
  const simulationChanges = {
    addProducts: selectedProductsToAdd,
    removeProducts: selectedProductsToRemove,
    configChanges: Object.keys(configChanges).length > 0 ? {
      [enrollment.productId]: configChanges
    } : undefined
  };

  const { data: newPricing, isLoading: pricingLoading, error: pricingError } = usePricingSimulation(
    undefined, // memberId - will use current user
    simulationChanges,
    isOpen && (Object.keys(configChanges).length > 0 || selectedProductsToAdd.length > 0 || selectedProductsToRemove.length > 0)
  );

  // Calculate pricing impact for display
  useEffect(() => {
    if (currentPricing && newPricing) {
      const currentTotal = currentPricing.totals?.totalPremium || 0;
      const newTotal = newPricing?.totals?.totalPremium || 0;
      const difference = newTotal - currentTotal;

      setPricingImpact({
        currentTotal,
        newTotal,
        difference,
        isIncrease: difference > 0,
        isDecrease: difference < 0,
        isNoChange: difference === 0
      });
    }
  }, [currentPricing, newPricing]);

  const handleConfigChange = (fieldName: string, value: string) => {
    setConfigChanges(prev => ({
      ...prev,
      [fieldName]: value
    }));
  };

  const handleAddProduct = (productId: string) => {
    setSelectedProductsToAdd(prev => [...prev, productId]);
  };

  const handleRemoveProduct = (productId: string) => {
    setSelectedProductsToRemove(prev => [...prev, productId]);
  };

  const handleSaveChanges = async () => {
    setIsLoading(true);
    try {
      const changes: PlanChanges = {
        configFieldChanges: configChanges,
        addProducts: selectedProductsToAdd,
        removeProducts: selectedProductsToRemove,
        effectiveDate: effectiveDate || undefined
      };

      // Call the API service
      const response = await MemberEnrollmentService.submitPlanChangesRequest({
        enrollmentId: enrollment.enrollmentId,
        configFieldChanges: configChanges,
        addProducts: selectedProductsToAdd,
        removeProducts: selectedProductsToRemove,
        effectiveDate: effectiveDate || undefined
      });

      if (response.success) {
        await onSaveChanges(changes);
        onClose();
      } else {
        console.error('Failed to submit plan changes:', response.message);
        // TODO: Show error message to user
      }
    } catch (error) {
      console.error('Error saving plan changes:', error);
      // TODO: Show error message to user
    } finally {
      setIsLoading(false);
    }
  };

  const hasChanges = Object.keys(configChanges).length > 0 || 
                    selectedProductsToAdd.length > 0 || 
                    selectedProductsToRemove.length > 0;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-900">
              Make Changes to {enrollment.product.name}
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="h-6 w-6" />
            </button>
          </div>
        </div>

        <div className="p-6">
          {/* Tab Navigation */}
          <div className="flex gap-2 mb-6">
            <button
              onClick={() => setActiveTab('config')}
              className={`px-4 py-2 rounded-lg font-medium ${
                activeTab === 'config' 
                  ? 'bg-oe-primary text-white' 
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              <Settings className="w-4 h-4 inline-block mr-2" />
              Configuration
            </button>
            <button
              onClick={() => setActiveTab('products')}
              className={`px-4 py-2 rounded-lg font-medium ${
                activeTab === 'products' 
                  ? 'bg-oe-primary text-white' 
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              <Plus className="w-4 h-4 inline-block mr-2" />
              Add/Remove Products
            </button>
            <button
              onClick={() => setActiveTab('summary')}
              className={`px-4 py-2 rounded-lg font-medium ${
                activeTab === 'summary' 
                  ? 'bg-oe-primary text-white' 
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              <CheckCircle className="w-4 h-4 inline-block mr-2" />
              Summary
            </button>
          </div>

          {/* Configuration Tab */}
          {activeTab === 'config' && (
            <div className="space-y-6">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h3 className="font-semibold text-blue-900 mb-2">Configuration Changes</h3>
                <p className="text-sm text-blue-800">
                  Modify your plan configuration. Changes may affect your monthly premium.
                </p>
              </div>

              {configFields.length > 0 ? (
                <div className="space-y-4">
                  {configFields.map((field, index) => (
                    <div key={index} className="bg-white border border-gray-200 rounded-lg p-4">
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        {field.fieldName}
                      </label>
                      {field.fieldType === 'dropdown' ? (
                        <select
                          value={configChanges[field.fieldName] || field.currentValue}
                          onChange={(e) => handleConfigChange(field.fieldName, e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        >
                          {field.options.map((option, optIndex) => (
                            <option key={optIndex} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={field.fieldType === 'number' ? 'number' : 'text'}
                          value={configChanges[field.fieldName] || field.currentValue}
                          onChange={(e) => handleConfigChange(field.fieldName, e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8">
                  <Settings className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-gray-600">No configuration fields available for this product.</p>
                </div>
              )}

              {/* Pricing Impact Display */}
              {pricingImpact && (pricingImpact.isIncrease || pricingImpact.isDecrease || pricingImpact.isNoChange) && (
                <div className={`border rounded-lg p-4 ${
                  pricingImpact.difference > 0 
                    ? 'bg-red-50 border-red-200' 
                    : pricingImpact.difference < 0 
                      ? 'bg-green-50 border-green-200' 
                      : 'bg-yellow-50 border-yellow-200'
                }`}>
                  <div className="flex items-center">
                    <DollarSign className={`h-5 w-5 mr-3 ${
                      pricingImpact.difference > 0 
                        ? 'text-red-600' 
                        : pricingImpact.difference < 0 
                          ? 'text-green-600' 
                          : 'text-yellow-600'
                    }`} />
                    <div>
                      <h3 className={`text-sm font-medium ${
                        pricingImpact.difference > 0 
                          ? 'text-red-800' 
                          : pricingImpact.difference < 0 
                            ? 'text-green-800' 
                            : 'text-yellow-800'
                      }`}>
                        Pricing Impact
                      </h3>
                      <p className={`text-sm ${
                        pricingImpact.difference > 0 
                          ? 'text-red-700' 
                          : pricingImpact.difference < 0 
                            ? 'text-green-700' 
                            : 'text-yellow-700'
                      }`}>
                        {pricingImpact.isIncrease 
                          ? `+$${pricingImpact.difference.toFixed(2)}/month` 
                          : pricingImpact.isDecrease 
                            ? `-$${Math.abs(pricingImpact.difference).toFixed(2)}/month` 
                            : 'No change in price'
                        }
                      </p>
                      {pricingImpact.breakdown && (
                        <div className="mt-2 text-xs">
                          {pricingImpact.breakdown.configChanges !== 0 && (
                            <div>Config changes: {pricingImpact.breakdown.configChanges > 0 ? '+' : ''}${pricingImpact.breakdown.configChanges.toFixed(2)}</div>
                          )}
                          {pricingImpact.breakdown.addedProducts !== 0 && (
                            <div>Added products: +${pricingImpact.breakdown.addedProducts.toFixed(2)}</div>
                          )}
                          {pricingImpact.breakdown.removedProducts !== 0 && (
                            <div>Removed products: ${pricingImpact.breakdown.removedProducts.toFixed(2)}</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Loading State */}
              {pricingLoading && (
                <div className="border rounded-lg p-4 bg-gray-50 border-gray-200">
                  <div className="flex items-center">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-oe-primary mr-3"></div>
                    <p className="text-sm text-gray-600">Calculating pricing impact...</p>
                  </div>
                </div>
              )}

              {/* Error State */}
              {pricingError && (
                <div className="border rounded-lg p-4 bg-red-50 border-red-200">
                  <div className="flex items-center">
                    <X className="h-5 w-5 text-red-600 mr-3" />
                    <p className="text-sm text-red-700">Failed to calculate pricing impact. Please try again.</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Products Tab */}
          {activeTab === 'products' && (
            <div className="space-y-6">
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <h3 className="font-semibold text-green-900 mb-2">Add or Remove Products</h3>
                <p className="text-sm text-green-800">
                  You can add additional products to your plan or remove existing ones.
                </p>
              </div>

              {/* Add Products Section */}
              <div>
                <h4 className="text-lg font-medium text-gray-900 mb-4">Add Products</h4>
                {availableProducts.length > 0 ? (
                  <div className="grid gap-4">
                    {availableProducts.map((product) => (
                      <div key={product.productId} className="bg-white border border-gray-200 rounded-lg p-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <h5 className="font-medium text-gray-900">{product.name}</h5>
                            <p className="text-sm text-gray-600">{product.description}</p>
                            <p className="text-sm text-oe-primary">From ${product.basePrice}/month</p>
                          </div>
                          <button
                            onClick={() => handleAddProduct(product.productId)}
                            className="inline-flex items-center px-3 py-2 border border-transparent rounded-lg text-sm font-medium text-white bg-oe-primary hover:bg-oe-primary-dark"
                          >
                            <Plus className="h-4 w-4 mr-2" />
                            Add
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <Plus className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                    <p className="text-gray-600">No additional products available to add.</p>
                  </div>
                )}
              </div>

              {/* Remove Products Section */}
              <div>
                <h4 className="text-lg font-medium text-gray-900 mb-4">Remove Products</h4>
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h5 className="font-medium text-gray-900">{enrollment.product.name}</h5>
                      <p className="text-sm text-gray-600">Current plan</p>
                    </div>
                    <button
                      onClick={() => handleRemoveProduct(enrollment.productId)}
                      className="inline-flex items-center px-3 py-2 border border-red-300 rounded-lg text-sm font-medium text-red-700 bg-white hover:bg-red-50"
                    >
                      <X className="h-4 w-4 mr-2" />
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Summary Tab */}
          {activeTab === 'summary' && (
            <div className="space-y-6">
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <h3 className="font-semibold text-gray-900 mb-4">Change Summary</h3>
                
                {/* Configuration Changes */}
                {Object.keys(configChanges).length > 0 && (
                  <div className="mb-4">
                    <h4 className="font-medium text-gray-700 mb-2">Configuration Changes:</h4>
                    <ul className="list-disc list-inside text-sm text-gray-600">
                      {Object.entries(configChanges).map(([field, value]) => (
                        <li key={field}>
                          {field}: {value}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Product Changes */}
                {selectedProductsToAdd.length > 0 && (
                  <div className="mb-4">
                    <h4 className="font-medium text-gray-700 mb-2">Products to Add:</h4>
                    <ul className="list-disc list-inside text-sm text-gray-600">
                      {selectedProductsToAdd.map((productId) => (
                        <li key={productId}>Product ID: {productId}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {selectedProductsToRemove.length > 0 && (
                  <div className="mb-4">
                    <h4 className="font-medium text-gray-700 mb-2">Products to Remove:</h4>
                    <ul className="list-disc list-inside text-sm text-gray-600">
                      {selectedProductsToRemove.map((productId) => (
                        <li key={productId}>Product ID: {productId}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {!hasChanges && (
                  <p className="text-gray-600">No changes made yet.</p>
                )}
              </div>

              {/* Effective Date */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Effective Date (Optional)
                </label>
                <input
                  type="date"
                  value={effectiveDate}
                  onChange={(e) => setEffectiveDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Leave blank to use the default effective date
                </p>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="mt-8 flex justify-end gap-4">
            <button
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveChanges}
              disabled={!hasChanges || isLoading}
              className="px-4 py-2 border border-transparent rounded-lg text-sm font-medium text-white bg-oe-primary hover:bg-oe-primary-dark disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

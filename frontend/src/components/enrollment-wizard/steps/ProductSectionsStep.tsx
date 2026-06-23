// frontend/src/components/enrollment-wizard/steps/ProductSectionsStep.tsx
import { AlertCircle } from 'lucide-react';
import React, { useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useAvailableBundles } from '../../../hooks/useAvailableBundles';
import { useAvailableProductTypes } from '../../../hooks/useAvailableProductTypes';
import ProductSectionCard from '../components/ProductSectionCard';
import { WizardProductSection, WizardStepProps } from '../types/wizard.types';

interface ProductCategory {
  id: string;
  label: string;
  productType: string;
  description: string;
  defaultPage: string;
  emoji: string;
}

const PRODUCT_CATEGORIES: ProductCategory[] = [
  {
    id: 'healthcare',
    label: 'Medical',
    productType: 'Healthcare',
    description: 'Health insurance plans covering medical services',
    defaultPage: 'Healthcare Plans',
    emoji: '🏥'
  },
  {
    id: 'dental',
    label: 'Dental',
    productType: 'Dental',
    description: 'Dental insurance plans for preventive and restorative care',
    defaultPage: 'Dental Plans',
    emoji: '🦷'
  },
  {
    id: 'vision',
    label: 'Vision',
    productType: 'Vision',
    description: 'Vision insurance plans covering eye exams and eyewear',
    defaultPage: 'Vision Plans',
    emoji: '👁️'
  },
  {
    id: 'life',
    label: 'Life Insurance',
    productType: 'Life Insurance',
    description: 'Life insurance policies for financial protection',
    defaultPage: 'Life Insurance',
    emoji: '❤️'
  },
  {
    id: 'telemedicine',
    label: 'Telemedicine',
    productType: 'Telemedicine',
    description: 'Virtual healthcare consultation services',
    defaultPage: 'Telemedicine Services',
    emoji: '📱'
  },
  {
    id: 'supplemental',
    label: 'Supplemental',
    productType: 'Other',
    description: 'Additional coverage for specific medical events',
    defaultPage: 'Supplemental Plans',
    emoji: '📋'
  }
];

const ProductSectionsStep: React.FC<WizardStepProps> = ({
  data,
  onDataChange,
  isValid
}) => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<string>(PRODUCT_CATEGORIES[0].id);
  
  // Debug logging for tenantId
  console.log('🔍 ProductSectionsStep - Current wizard data:', {
    tenantId: data.tenantId,
    userRole: user?.currentRole,
    hasTenantId: !!data.tenantId,
    userTenantId: user?.tenantId,
    fullData: data // Log the full data structure
  });

  // Monitor tenantId changes
  React.useEffect(() => {
    console.log('🔍 ProductSectionsStep - tenantId changed:', {
      tenantId: data.tenantId,
      userRole: user?.currentRole,
      hasTenantId: !!data.tenantId
    });
    
    // Force reload of products when tenantId changes
    if (data.tenantId) {
      console.log('🔍 ProductSectionsStep - Tenant ID changed, products should reload automatically');
    }
  }, [data.tenantId, user?.currentRole]);

  const { data: availableProductTypes = [], isLoading, isError } = useAvailableProductTypes(data.tenantId, data.templateType);
  const { data: availableBundles = [], isLoading: isBundlesLoading } = useAvailableBundles(data.tenantId);

  // Debug logging for API results
  console.log('🔍 ProductSectionsStep - API Results:', {
    tenantId: data.tenantId,
    availableProductTypes: availableProductTypes.length,
    availableBundles: availableBundles.length,
    isLoading,
    isBundlesLoading,
    isError
  });

  // Debug: Log each product type with its count
  console.log('🔍 ProductSectionsStep - Product Type Details:', 
    availableProductTypes.map(type => ({
      productType: type.productType,
      count: type.count,
      hasProducts: type.count > 0
    }))
  );
  
  // Check which categories are enabled (have a section in data.products)
  const isCategoryEnabled = (categoryId: string): boolean => {
    const category = PRODUCT_CATEGORIES.find(c => c.id === categoryId);
    if (!category) return false;
    return data.products.some(p => p.productType === category.productType);
  };
  
  // Get the section for a specific category
  const getCategorySection = (categoryId: string): WizardProductSection | undefined => {
    const category = PRODUCT_CATEGORIES.find(c => c.id === categoryId);
    if (!category) return undefined;
    return data.products.find(p => p.productType === category.productType);
  };
  
  // Get the index of a category's section in the products array
  const getCategorySectionIndex = (categoryId: string): number => {
    const category = PRODUCT_CATEGORIES.find(c => c.id === categoryId);
    if (!category) return -1;
    return data.products.findIndex(p => p.productType === category.productType);
  };


  // Toggle category on/off
  const toggleCategory = (categoryId: string) => {
    const category = PRODUCT_CATEGORIES.find(c => c.id === categoryId);
    if (!category) return;
    
    const isEnabled = isCategoryEnabled(categoryId);
    
    if (isEnabled) {
      // Remove the section
      const updatedProducts = data.products.filter(p => p.productType !== category.productType);
      onDataChange({ products: updatedProducts });
    } else {
      // Add the section
      const newSection: WizardProductSection = {
        id: `product-${Date.now()}`,
        page: category.defaultPage,
        productType: category.productType,
        description: category.description,
        specificProducts: [],
        includeAllProducts: false,
        sectionType: 'products'
      };
      
      onDataChange({
        products: [...data.products, newSection]
      });
    }
  };

  const updateProductSection = (index: number, updates: Partial<WizardProductSection>) => {
    const updatedProducts = data.products.map((product, i) => 
      i === index ? { ...product, ...updates } : product
    );
    onDataChange({ products: updatedProducts });
  };

  if (isLoading || isBundlesLoading) {
    return (
      <div className="p-6 text-center">
        <div className="flex flex-col items-center py-6">
          <div className="h-6 w-6 border-2 border-oe-primary border-t-transparent rounded-full animate-spin mb-2" />
          <p className="text-sm text-gray-500">Loading available products and bundles...</p>
        </div>
      </div>
    );
  }

  // Show message for SysAdmin users who haven't selected a tenant
  if (user?.currentRole === 'SysAdmin' && !data.tenantId) {
    return (
      <div>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start">
            <AlertCircle className="h-5 w-5 text-oe-primary mr-2 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-blue-800">Tenant Selection Required</p>
              <p className="text-sm text-oe-primary-dark mt-1">
                As a System Administrator, you need to select a tenant in the Basic Information step before you can configure product sections. 
                Please go back to the first step and select a tenant.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-start">
            <AlertCircle className="h-5 w-5 text-red-600 mr-2 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-800">Error Loading Product Types</p>
              <p className="text-sm text-red-700 mt-1">Unable to load available product types. You can still create sections manually.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-lg font-medium text-gray-900 mb-1">Product Sections</h3>
      <p className="text-sm text-gray-600 mb-4">
        Configure which product categories will appear in the enrollment wizard. Each enabled category becomes a dedicated section.
      </p>

      {/* Tab Bar */}
      <div className="bg-white rounded-lg border border-gray-200 mb-4">
        <div className="border-b border-gray-200 bg-gray-50">
          <div className="flex overflow-x-auto">
            {PRODUCT_CATEGORIES.map((category) => {
              const isEnabled = isCategoryEnabled(category.id);
              const isActive = activeTab === category.id;
              
              return (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => setActiveTab(category.id)}
                  className={`px-6 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors flex items-center gap-2 ${
                    isActive
                      ? 'border-oe-primary text-oe-primary bg-white'
                      : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                  }`}
                >
                  <span>{category.emoji}</span>
                  <span>{category.label}</span>
                  {isEnabled && (
                    <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-green-100 text-green-800 text-xs font-semibold">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {PRODUCT_CATEGORIES.map((category) => {
            if (activeTab !== category.id) return null;
            
            const isEnabled = isCategoryEnabled(category.id);
            const section = getCategorySection(category.id);
            const sectionIndex = getCategorySectionIndex(category.id);
            
            return (
              <div key={category.id} className="space-y-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-3xl">{category.emoji}</span>
                      <div>
                        <h4 className="text-lg font-semibold text-gray-900">{category.label}</h4>
                        <p className="text-sm text-gray-600">{category.description}</p>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleCategory(category.id)}
                    className={`ml-4 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      isEnabled
                        ? 'bg-green-100 text-green-800 hover:bg-green-200'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {isEnabled ? 'Enabled ✓' : 'Disabled'}
                  </button>
                </div>

                {isEnabled && section ? (
                  <div className="space-y-4">
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                      <p className="text-sm font-medium text-green-800">
                        ✓ {category.label} section is enabled and will appear in the enrollment wizard
                      </p>
                      <p className="text-xs text-green-700 mt-1">
                        Members will be able to select products from this category during enrollment
                      </p>
                    </div>

                    {/* Product Selection Card */}
                    <ProductSectionCard
                      section={section}
                      availableProductTypes={availableProductTypes}
                      onUpdate={(updates) => updateProductSection(sectionIndex, updates)}
                      onRemove={() => toggleCategory(category.id)}
                      canRemove={false}
                      tenantId={data.tenantId}
                      templateType={data.templateType}
                      groupId={data.groupId}
                      index={sectionIndex}
                      totalSections={data.products.length}
                      onMoveUp={() => {}}
                      onMoveDown={() => {}}
                    />
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="bg-gray-50 border-2 border-gray-200 rounded-lg p-6 text-center">
                      <p className="text-sm font-medium text-gray-700">
                        {category.label} section is currently disabled
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        This section will not appear in the enrollment wizard
                      </p>
                      <button
                        type="button"
                        onClick={() => toggleCategory(category.id)}
                        className="mt-3 px-4 py-2 bg-oe-primary text-white rounded-lg text-sm font-medium hover:bg-oe-primary-dark"
                      >
                        Enable {category.label}
                      </button>
                    </div>

                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                      <p className="text-sm text-yellow-800">
                        <strong>Note:</strong> When disabled, this entire section will be excluded from the enrollment wizard.
                        Members won't see {category.label.toLowerCase()} options at all.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Validation Summary - Removed healthcare product requirement */}

      {/* Empty State */}
      {data.products.length === 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
          <div className="flex items-start">
            <AlertCircle className="h-5 w-5 text-oe-primary mr-2 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-blue-800">No sections enabled</p>
              <p className="text-sm text-oe-primary-dark mt-1">
                Please enable at least one product category above to create your enrollment wizard. 
                Click on any tab and enable the section to get started.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Debug Panel - Development Only */}
      {(() => {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('debug') === '1';
      })() && (
        <div className="mt-3 bg-gray-100 border border-gray-300 rounded-lg p-4">
          <details className="group">
            <summary className="cursor-pointer font-medium text-gray-700 hover:text-gray-900">
              🔍 Debug Info (Dev Only)
            </summary>
            <div className="mt-2 text-xs text-gray-600 space-y-2">
              <div>
                <strong>Current State:</strong>
                <ul className="ml-4 mt-1 space-y-1">
                  <li>Tenant ID: {data.tenantId || 'Not set'}</li>
                  <li>User Role: {user?.currentRole || 'Unknown'}</li>
                  <li>User Tenant ID: {user?.tenantId || 'Not set'}</li>
                  <li>Product Types Loaded: {availableProductTypes.length}</li>
                  <li>Bundles Loaded: {availableBundles.length}</li>
                  <li>Loading States: Products={isLoading ? 'Yes' : 'No'}, Bundles={isBundlesLoading ? 'Yes' : 'No'}</li>
                </ul>
              </div>
              
              <div>
                <strong>Product Type Details:</strong>
                <ul className="ml-4 mt-1 space-y-1">
                  {availableProductTypes.map((type, index) => (
                    <li key={index}>
                      {type.productType}: {type.count} products
                      {type.count > 0 && (
                        <button 
                          onClick={() => {
                            console.log(`🔍 Debug: Testing product loading for ${type.productType}`);
                            console.log(`🔍 Debug: Current tenantId: ${data.tenantId}`);
                            console.log(`🔍 Debug: User role: ${user?.currentRole}`);
                            // Force a product section to test loading
                            const testSection: WizardProductSection = {
                              id: `test-${Date.now()}`,
                              page: `Test ${type.productType}`,
                              productType: type.productType,
                              description: `Testing ${type.productType} product loading`,
                              specificProducts: [],
                              includeAllProducts: false,
                              sectionType: 'products'
                            };
                            onDataChange({
                              products: [...data.products, testSection]
                            });
                          }}
                          className="ml-2 px-2 py-1 bg-blue-200 text-blue-800 rounded text-xs hover:bg-blue-300"
                        >
                          Test Load
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <strong>Raw API Data:</strong>
                <pre className="mt-1 p-2 bg-gray-200 rounded overflow-auto max-h-32">
                  {JSON.stringify({
                    tenantId: data.tenantId,
                    productTypes: availableProductTypes,
                    bundles: availableBundles
                  }, null, 2)}
                </pre>
              </div>
            </div>
          </details>
        </div>
      )}
    </div>
  );
};

export default ProductSectionsStep;

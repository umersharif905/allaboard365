import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';
import ContributionCalculator, { type ContributionRule, type Product } from '../../services/ContributionCalculator';
import ContributionBreakdown from '../enrollment-wizard/ContributionBreakdown';

// Real data from enrollment API
const ENROLLMENT_LINK_TOKEN = 'enroll_1758577890007_6wf1omrhm';

const ContributionTestComponent: React.FC = () => {
  const [products, setProducts] = useState<Product[]>([]);
  const [allProductsRules, setAllProductsRules] = useState<ContributionRule[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [selectedConfigs, setSelectedConfigs] = useState<Record<string, string>>({});
  const [totals, setTotals] = useState({
    totalPremium: 0,
    totalEmployerContribution: 0,
    totalEmployeeContribution: 0
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Member criteria controls
  const [memberAge, setMemberAge] = useState(30);
  const [tobaccoUse, setTobaccoUse] = useState<'Yes' | 'No'>('No');
  const [memberTier, setMemberTier] = useState<'EE' | 'EE+SP' | 'EE+CH' | 'FAM'>('EE');

  // Fetch real data from API
  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);
      
      console.log('Fetching real data from API with criteria:', { memberAge, tobaccoUse, memberTier });
      
      // Fetch product pricing data
      const response = await apiService.get<{
        success: boolean;
        data: {
          products: Product[];
          allProductsRules: ContributionRule[];
        };
        message?: string;
      }>(`/api/enrollment-links/${ENROLLMENT_LINK_TOKEN}/product-pricing`, {
        params: {
          memberAge: memberAge,
          tobaccoUse: tobaccoUse,
          memberTier: memberTier,
          selectedProducts: JSON.stringify(selectedProducts),
          selectedConfigs: JSON.stringify(selectedConfigs)
        }
      });
      
      if (response.success && response.data) {
        console.log('API Response:', response.data);
        
        setProducts(response.data.products || []);
        setAllProductsRules(response.data.allProductsRules || []);
        
        // Auto-select the first product (bundle) if no products selected
        if (selectedProducts.length === 0 && response.data.products && response.data.products.length > 0) {
          const firstProduct = response.data.products[0];
          setSelectedProducts([firstProduct.productId]);
          
          // Set default config for the first product
          if (firstProduct.pricingVariations && firstProduct.pricingVariations.length > 0) {
            setSelectedConfigs({
              [firstProduct.productId]: firstProduct.pricingVariations[0].configValue
            });
          }
        }
      } else {
        setError('Failed to fetch product data');
      }
    } catch (err) {
      console.error('Error fetching data:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  // Initial data fetch
  useEffect(() => {
    fetchData();
  }, []);

  // Refetch data when member criteria change
  useEffect(() => {
    if (products.length > 0) {
      fetchData();
    }
  }, [memberAge, tobaccoUse, memberTier]);

  // Calculate totals when selections change
  useEffect(() => {
    if (products.length === 0) return;
    
    const selectedProductsData = products.filter(product => 
      selectedProducts.includes(product.productId)
    );
    
    const contributionResult = ContributionCalculator.calculateTotalContributions(
      selectedProductsData,
      selectedConfigs,
      allProductsRules
    );
    
    setTotals(contributionResult.totals);
  }, [products, selectedProducts, selectedConfigs, allProductsRules]);

  const handleProductToggle = (productId: string) => {
    setSelectedProducts(prev => 
      prev.includes(productId) 
        ? prev.filter(id => id !== productId)
        : [...prev, productId]
    );
  };

  const handleConfigChange = (productId: string, configValue: string) => {
    setSelectedConfigs(prev => ({
      ...prev,
      [productId]: configValue
    }));
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">Contribution System Test</h1>
        <div className="flex items-center justify-center py-12">
          <div className="text-lg text-gray-600">Loading product data...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">Contribution System Test</h1>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="text-red-800 font-medium">Error loading data:</div>
          <div className="text-red-600 mt-1">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">Contribution System Test</h1>
      
      {/* Member Criteria Controls */}
      <div className="mb-8 bg-gray-50 rounded-lg p-6">
        <h2 className="text-xl font-semibold text-gray-800 mb-4">Member Criteria</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Age:
            </label>
            <input
              type="number"
              value={memberAge}
              onChange={(e) => setMemberAge(parseInt(e.target.value) || 30)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              min="18"
              max="100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Tobacco Use:
            </label>
            <select
              value={tobaccoUse}
              onChange={(e) => setTobaccoUse(e.target.value as 'Yes' | 'No')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            >
              <option value="No">No</option>
              <option value="Yes">Yes</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Member Tier:
            </label>
            <select
              value={memberTier}
              onChange={(e) => setMemberTier(e.target.value as 'EE' | 'EE+SP' | 'EE+CH' | 'FAM')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            >
              <option value="EE">Employee Only</option>
              <option value="EE+SP">Employee + Spouse</option>
              <option value="EE+CH">Employee + Children</option>
              <option value="FAM">Family</option>
            </select>
          </div>
        </div>
      </div>
      
      {/* Product Selection */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold text-gray-800 mb-4">Product Selection</h2>
        <div className="space-y-4">
          {products.map(product => (
            <div key={product.productId} className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={selectedProducts.includes(product.productId)}
                    onChange={() => handleProductToggle(product.productId)}
                    className="mr-3 h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                  />
                  <div>
                    <h3 className="text-lg font-medium text-gray-900">{product.productName}</h3>
                    <p className="text-sm text-gray-600">{product.description}</p>
                    {product.isBundle && (
                      <span className="inline-block mt-1 px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded-full">
                        Bundle
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-gray-600">
                    {product.contributionRules.length > 0 && (
                      <div>
                        {product.contributionRules[0].type === 'flat_rate' 
                          ? `$${product.contributionRules[0].amount} flat rate`
                          : `${product.contributionRules[0].amount}% contribution`
                        }
                      </div>
                    )}
                  </div>
                </div>
              </div>
              
              {/* Configuration Selection */}
              {product.pricingVariations.length > 1 && selectedProducts.includes(product.productId) && (
                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Configuration:
                  </label>
                  <select
                    value={selectedConfigs[product.productId] || ''}
                    onChange={(e) => handleConfigChange(product.productId, e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    {product.pricingVariations.map(variation => (
                      <option key={variation.configValue} value={variation.configValue}>
                        {variation.configValue} - ${variation.monthlyPremium}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              
              {/* Included Products (for bundles) */}
              {product.isBundle && product.includedProducts && selectedProducts.includes(product.productId) && (
                <div className="mt-4">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Includes:</h4>
                  <div className="space-y-2">
                    {product.includedProducts.map(included => {
                      // Calculate the cost for this product based on selected configuration
                      let productCost = 0;
                      
                      // Get pricing from the included product's pricing variations
                      if (included.pricingVariations && included.pricingVariations.length > 0) {
                        // For products with configuration options, try to match the bundle's selected config
                        const selectedConfig = selectedConfigs[product.productId];
                        let selectedVariation = null;
                        
                        if (selectedConfig) {
                          selectedVariation = included.pricingVariations.find((variation: any) => 
                            variation.configValue === selectedConfig
                          );
                        }
                        
                        // If no match found or no config selected, use the first available variation
                        if (!selectedVariation) {
                          selectedVariation = included.pricingVariations[0];
                        }
                        
                        productCost = selectedVariation?.monthlyPremium || 0;
                      } else {
                        // Fallback to monthlyPremium if no variations
                        productCost = (included as any).monthlyPremium || 0;
                      }
                      
                      return (
                        <div key={included.productId} className="ml-4 text-sm text-gray-600">
                          <div className="flex justify-between">
                            <span>{included.productName}</span>
                            <span>${productCost.toFixed(2)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      
      {/* Contribution Breakdown */}
      {selectedProducts.length > 0 && (
        <ContributionBreakdown
          products={products}
          selectedConfigs={selectedConfigs}
          allProductsRules={allProductsRules}
          totals={totals}
        />
      )}
      
      {/* Debug Information */}
      <div className="mt-8 bg-gray-100 rounded-lg p-4">
        <h3 className="text-lg font-medium text-gray-800 mb-4">Debug Information</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <strong>Selected Products:</strong>
            <pre className="mt-1 text-xs bg-white p-2 rounded border">
              {JSON.stringify(selectedProducts, null, 2)}
            </pre>
          </div>
          <div>
            <strong>Selected Configs:</strong>
            <pre className="mt-1 text-xs bg-white p-2 rounded border">
              {JSON.stringify(selectedConfigs, null, 2)}
            </pre>
          </div>
          <div>
            <strong>Totals:</strong>
            <pre className="mt-1 text-xs bg-white p-2 rounded border">
              {JSON.stringify(totals, null, 2)}
            </pre>
          </div>
          <div>
            <strong>All Products Rules:</strong>
            <pre className="mt-1 text-xs bg-white p-2 rounded border">
              {JSON.stringify(allProductsRules, null, 2)}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ContributionTestComponent;

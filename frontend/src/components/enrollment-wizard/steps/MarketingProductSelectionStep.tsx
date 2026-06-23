// frontend/src/components/enrollment-wizard/steps/MarketingProductSelectionStep.tsx
import { ExternalLink, Eye, FileText, GitCompare, Grid3x3, List, Package, Search, ShoppingCart, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { apiService } from '../../../services/api.service';
import { ProductWithPricing } from '../../../types/enrollment-link-templates.types';
import { getProductDocumentItems, hasProductDocuments } from '../../../utils/productDocuments';

interface MarketingProductSelectionStepProps {
  products: ProductWithPricing[];
  selectedProducts: string[];
  onProductSelect: (productId: string) => void;
  onProductDeselect: (productId: string) => void;
  onCompareProducts: (productIds: string[]) => void;
  onStartEnrollment: (selectedProductIds: string[]) => void;
  /** When true (e.g. group marketing link), user can browse/compare products but cannot start enrollment from this link */
  disableStartEnrollment?: boolean;
}

const MarketingProductSelectionStep: React.FC<MarketingProductSelectionStepProps> = ({
  products,
  selectedProducts,
  onProductSelect,
  onProductDeselect,
  onCompareProducts,
  onStartEnrollment,
  disableStartEnrollment = false
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedForComparison, setSelectedForComparison] = useState<string[]>([]);
  const [showComparisonModal, setShowComparisonModal] = useState(false);
  const [showDocumentModal, setShowDocumentModal] = useState(false);
  const [selectedProductForDocument, setSelectedProductForDocument] = useState<ProductWithPricing | null>(null);
  const [selectedDocumentTab, setSelectedDocumentTab] = useState<string>('');
  const [showPDFModal, setShowPDFModal] = useState(false);
  const [selectedProductForPDF, setSelectedProductForPDF] = useState<ProductWithPricing | null>(null);
  const [selectedPDFTab, setSelectedPDFTab] = useState<string>('');
  const [pdfUrls, setPdfUrls] = useState<Map<string, string>>(new Map()); // Cache authenticated PDF URLs
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid'); // Default to grid view

  // Filter products based on search term
  const filteredProducts = useMemo(() => {
    if (!searchTerm.trim()) return products;
    
    const searchLower = searchTerm.toLowerCase();
    return products.filter(product =>
      product.productName?.toLowerCase().includes(searchLower) ||
      product.productType?.toLowerCase().includes(searchLower) ||
      product.description?.toLowerCase().includes(searchLower)
    );
  }, [products, searchTerm]);

  // Group products by type - combine Bundles with Healthcare
  const productsByType = useMemo(() => {
    const grouped: Record<string, ProductWithPricing[]> = {};
    filteredProducts.forEach(product => {
      // Map bundles to Healthcare category
      let type = product.productType || 'Other';
      if (type === 'Bundle' || product.isBundle) {
        type = 'Healthcare';
      }
      
      if (!grouped[type]) {
        grouped[type] = [];
      }
      grouped[type].push(product);
    });
    return grouped;
  }, [filteredProducts]);

  const handleCompareToggle = (productId: string) => {
    setSelectedForComparison(prev => {
      if (prev.includes(productId)) {
        return prev.filter(id => id !== productId);
      } else if (prev.length < 3) {
        return [...prev, productId];
      } else {
        // Replace the first one if already at max
        return [productId, ...prev.slice(1)];
      }
    });
  };

  const handleOpenComparison = () => {
    if (selectedForComparison.length >= 2) {
      onCompareProducts(selectedForComparison);
      setShowComparisonModal(true);
    }
  };

  const handleProductInfo = (product: ProductWithPricing) => {
    // Open PlanDetailsData modal
    setSelectedProductForDocument(product);
    // Set initial tab to main product if bundle, or first included product with PlanDetailsData
    if (product.isBundle && product.includedProducts) {
      if (product.planDetailsData && product.planDetailsData.Plan_Data) {
        setSelectedDocumentTab(product.productId);
      } else {
        const firstWithPlanDetails = product.includedProducts.find(p => p.planDetailsData && p.planDetailsData.Plan_Data);
        setSelectedDocumentTab(firstWithPlanDetails?.productId || product.productId);
      }
    } else {
      setSelectedDocumentTab(product.productId);
    }
    setShowDocumentModal(true);
  };

  const handleViewDocument = (product: ProductWithPricing) => {
    // Alias for handleProductInfo - opens PlanDetailsData
    handleProductInfo(product);
  };

  const handleViewPDF = async (product: ProductWithPricing) => {
    setSelectedProductForPDF(product);
    
    if (product.isBundle && product.includedProducts) {
      if (hasProductDocuments(product)) {
        setSelectedPDFTab(product.productId);
      } else {
        const firstWithPDF = product.includedProducts.find(p => hasProductDocuments(p as any));
        setSelectedPDFTab(firstWithPDF?.productId || product.productId);
      }
    } else {
      setSelectedPDFTab(product.productId);
    }
    
    const productsToFetch: Array<{ productId: string; documentUrl: string }> = [];
    const mainDocs = getProductDocumentItems(product as any);
    if (mainDocs.length > 0) {
      productsToFetch.push({ productId: product.productId, documentUrl: mainDocs[0].documentUrl });
    }
    if (product.isBundle && product.includedProducts) {
      product.includedProducts.forEach((included: any) => {
        const docs = getProductDocumentItems(included);
        if (docs.length > 0) {
          productsToFetch.push({ productId: included.productId, documentUrl: docs[0].documentUrl });
        }
      });
    }
    
    const urlPromises = productsToFetch.map(async ({ productId, documentUrl }) => {
      if (!documentUrl) return;
      if (documentUrl.startsWith('http')) {
        setPdfUrls(prev => new Map(prev).set(productId, documentUrl));
        return;
      }
      try {
        const response = await apiService.get<{ success: boolean; data?: { downloadUrl: string } }>(
          `/api/products/${productId}/document`
        );
        if (response.success && response.data?.downloadUrl) {
          setPdfUrls(prev => new Map(prev).set(productId, response.data!.downloadUrl));
        } else {
          setPdfUrls(prev => new Map(prev).set(productId, documentUrl));
        }
      } catch {
        setPdfUrls(prev => new Map(prev).set(productId, documentUrl));
      }
    });
    await Promise.all(urlPromises);
    setShowPDFModal(true);
  };

  // When a bundle (or product) has availableConfigs, only those config values are shown in the enrollment flow.
  // Use this for any price/option display so we don't show hidden config values.
  const getDisplayPricingVariations = (product: ProductWithPricing): Array<{ configValue: string; monthlyPremium: number; employerContribution?: number; employeeContribution?: number }> => {
    const variations = product.pricingVariations || [];
    if (!variations.length) return [];
    const allowed = product.availableConfigs && product.availableConfigs.length > 0
      ? new Set((product.availableConfigs || []).map(c => String(c)))
      : null;
    if (!allowed) return variations;
    return variations.filter(v => allowed.has(String(v.configValue ?? '')));
  };

  // Helper function to get product type display (show Healthcare for bundles)
  const getProductTypeDisplay = (product: ProductWithPricing): string => {
    if (product.isBundle || product.productType === 'Bundle') {
      return 'Healthcare';
    }
    return product.productType || 'Other';
  };

  // Categories that allow only 1 product per category; "Other" allows multiple
  const ONE_PER_CATEGORY = ['Healthcare', 'Dental', 'Vision', 'Telemed', 'Telemedicine'];

  const handleSelectProduct = (product: ProductWithPricing) => {
    if (selectedProducts.includes(product.productId)) {
      onProductDeselect(product.productId);
      return;
    }
    const category = getProductTypeDisplay(product);
    if (ONE_PER_CATEGORY.includes(category)) {
      const otherSelectedInCategory = products.filter(
        (p) =>
          p.productId !== product.productId &&
          getProductTypeDisplay(p) === category &&
          selectedProducts.includes(p.productId)
      );
      otherSelectedInCategory.forEach((p) => onProductDeselect(p.productId));
    }
    onProductSelect(product.productId);
  };

  // Helper function to render product price for display in cards
  const renderProductPrice = (product: ProductWithPricing): React.ReactNode => {
    // For bundles, use aggregated bundle pricing if available
    if (product.isBundle && product.bundleMinMSRP !== null && product.bundleMinMSRP !== undefined &&
        product.bundleMaxMSRP !== null && product.bundleMaxMSRP !== undefined) {
      const min = product.bundleMinMSRP;
      const max = product.bundleMaxMSRP;
      if (min === max) {
        return (
          <div className="space-y-1">
            <div className="text-sm text-gray-900 font-medium">
              ${min.toFixed(2)}/month
            </div>
            <div className="text-xs text-gray-500">
              Bundle ({product.includedProducts?.length || 0} products)
            </div>
          </div>
        );
      }
      return (
        <div className="space-y-1">
          <div className="text-sm text-gray-900 font-medium">
            ${min.toFixed(2)} - ${max.toFixed(2)}/month
          </div>
          <div className="text-xs text-gray-500">
            Bundle ({product.includedProducts?.length || 0} products)
          </div>
        </div>
      );
    }
    
    // First check if pricingTiers is available (from enrollment-data with MSRPRate)
    if (product.pricingTiers && product.pricingTiers.length > 0) {
      // Get all MSRP rates from all tiers
      const allMSRPRates: number[] = [];
      product.pricingTiers.forEach(tier => {
        if (tier.minMSRP > 0) allMSRPRates.push(tier.minMSRP);
        if (tier.maxMSRP > 0 && tier.maxMSRP !== tier.minMSRP) allMSRPRates.push(tier.maxMSRP);
      });
      
      if (allMSRPRates.length > 0) {
        const min = Math.min(...allMSRPRates);
        const max = Math.max(...allMSRPRates);
        if (min === max) {
          return (
            <div className="text-sm text-gray-900 font-medium">
              ${min.toFixed(2)}/month
            </div>
          );
        }
        return (
          <div className="space-y-1">
            <div className="text-sm text-gray-900 font-medium">
              ${min.toFixed(2)} - ${max.toFixed(2)}/month
            </div>
            <div className="text-xs text-gray-500">
              {product.pricingTiers.length} tier{product.pricingTiers.length !== 1 ? 's' : ''}
            </div>
          </div>
        );
      }
    }
    
    // Fallback to pricingOptions if available
    if (product.pricingOptions && product.pricingOptions.length > 0) {
      const prices = product.pricingOptions
        .map(opt => opt.monthlyPremium)
        .filter(p => p !== undefined && p !== null);
      
      if (prices.length > 0) {
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        if (min === max) {
          return (
            <div className="text-sm text-gray-900 font-medium">
              ${min.toFixed(2)}/month
            </div>
          );
        }
        return (
          <div className="text-sm text-gray-900 font-medium">
            ${min.toFixed(2)} - ${max.toFixed(2)}/month
          </div>
        );
      }
    }
    
    // Fallback to pricingVariations if available (only allowed configs when availableConfigs is set)
    const displayVariations = getDisplayPricingVariations(product);
    if (displayVariations.length > 0) {
      const prices = displayVariations
        .map(v => v.monthlyPremium)
        .filter(p => p !== undefined && p !== null);
      
      if (prices.length > 0) {
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        if (min === max) {
          return (
            <div className="text-sm text-gray-900 font-medium">
              ${min.toFixed(2)}/month
            </div>
          );
        }
        return (
          <div className="text-sm text-gray-900 font-medium">
            ${min.toFixed(2)} - ${max.toFixed(2)}/month
          </div>
        );
      }
    }
    
    return <span className="text-gray-500">N/A</span>;
  };

  // Helper function to get price range from pricing tiers (MSRPRate) or pricing options
  const getPriceRange = (product: ProductWithPricing): React.ReactNode => {
    // For bundles, use aggregated bundle pricing if available
    if (product.isBundle && product.bundleMinMSRP !== null && product.bundleMinMSRP !== undefined &&
        product.bundleMaxMSRP !== null && product.bundleMaxMSRP !== undefined) {
      const min = product.bundleMinMSRP;
      const max = product.bundleMaxMSRP;
      if (min === max) {
        return (
          <div className="space-y-1">
            <div className="text-sm text-gray-900 font-medium">
              ${min.toFixed(2)}/month
            </div>
            <div className="text-xs text-gray-500">
              Bundle ({product.includedProducts?.length || 0} products)
            </div>
          </div>
        );
      }
      return (
        <div className="space-y-1">
          <div className="text-sm text-gray-900 font-medium">
            ${min.toFixed(2)} - ${max.toFixed(2)}/month
          </div>
          <div className="text-xs text-gray-500">
            Bundle ({product.includedProducts?.length || 0} products)
          </div>
        </div>
      );
    }
    
    // First check if pricingTiers is available (from enrollment-data with MSRPRate)
    if (product.pricingTiers && product.pricingTiers.length > 0) {
      // Get all MSRP rates from all tiers
      const allMSRPRates: number[] = [];
      product.pricingTiers.forEach(tier => {
        if (tier.minMSRP > 0) allMSRPRates.push(tier.minMSRP);
        if (tier.maxMSRP > 0 && tier.maxMSRP !== tier.minMSRP) allMSRPRates.push(tier.maxMSRP);
      });
      
      if (allMSRPRates.length > 0) {
        const min = Math.min(...allMSRPRates);
        const max = Math.max(...allMSRPRates);
        if (min === max) {
          return (
            <div className="text-sm text-gray-900 font-medium">
              ${min.toFixed(2)}/month
            </div>
          );
        }
        return (
          <div className="space-y-1">
            <div className="text-sm text-gray-900 font-medium">
              ${min.toFixed(2)} - ${max.toFixed(2)}/month
            </div>
            <div className="text-xs text-gray-500">
              {product.pricingTiers.length} tier{product.pricingTiers.length !== 1 ? 's' : ''}
            </div>
          </div>
        );
      }
    }
    
    // Fallback to pricingOptions if available
    if (product.pricingOptions && product.pricingOptions.length > 0) {
      const prices = product.pricingOptions
        .map(opt => opt.monthlyPremium)
        .filter(p => p !== undefined && p !== null);
      
      if (prices.length > 0) {
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        if (min === max) {
          return (
            <div className="text-sm text-gray-900 font-medium">
              ${min.toFixed(2)}/month
            </div>
          );
        }
        return (
          <div className="text-sm text-gray-900 font-medium">
            ${min.toFixed(2)} - ${max.toFixed(2)}/month
          </div>
        );
      }
    }
    
    // Fallback to pricingVariations if available (only allowed configs when availableConfigs is set)
    const displayVariationsForRange = getDisplayPricingVariations(product);
    if (displayVariationsForRange.length > 0) {
      const prices = displayVariationsForRange
        .map(v => v.monthlyPremium)
        .filter(p => p !== undefined && p !== null);
      
      if (prices.length > 0) {
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        if (min === max) {
          return (
            <div className="text-sm text-gray-900 font-medium">
              ${min.toFixed(2)}/month
            </div>
          );
        }
        return (
          <div className="text-sm text-gray-900 font-medium">
            ${min.toFixed(2)} - ${max.toFixed(2)}/month
          </div>
        );
      }
    }
    
    return <span className="text-gray-500">N/A</span>;
  };

  // Helper function to get tiers information
  const getTiersInfo = (product: ProductWithPricing): React.ReactNode => {
    // For bundles, aggregate tier types from all included products
    if (product.isBundle && product.includedProducts && product.includedProducts.length > 0) {
      const allTierTypes = new Set<string>();
      
      // Collect tier types from all included products
      product.includedProducts.forEach(includedProduct => {
        if (includedProduct.pricingTiers && includedProduct.pricingTiers.length > 0) {
          includedProduct.pricingTiers.forEach(tier => {
            if (tier.tierType) {
              allTierTypes.add(tier.tierType);
            }
          });
        }
      });
      
      // Also check bundle's own pricing tiers
      if (product.pricingTiers && product.pricingTiers.length > 0) {
        product.pricingTiers.forEach(tier => {
          if (tier.tierType) {
            allTierTypes.add(tier.tierType);
          }
        });
      }
      
      if (allTierTypes.size > 0) {
        return (
          <div className="space-y-1">
            <div className="text-sm text-gray-900">
              {Array.from(allTierTypes).sort().join(', ')}
            </div>
            <div className="text-xs text-gray-500">
              From {product.includedProducts.length} product{product.includedProducts.length !== 1 ? 's' : ''}
            </div>
          </div>
        );
      }
    }
    
    // First check if pricingTiers is available (from enrollment-data)
    if (product.pricingTiers && product.pricingTiers.length > 0) {
      const tierTypes = product.pricingTiers.map(tier => tier.tierType).filter(Boolean);
      if (tierTypes.length > 0) {
        return (
          <div className="text-sm text-gray-900">
            {tierTypes.join(', ')}
          </div>
        );
      }
    }
    
    // Fallback to pricingOptions if available
    if (product.pricingOptions && product.pricingOptions.length > 0) {
      const tierTypes = new Set(product.pricingOptions.map(opt => opt.tierType).filter(Boolean));
      if (tierTypes.size > 0) {
        return (
          <div className="text-sm text-gray-900">
            {Array.from(tierTypes).join(', ')}
          </div>
        );
      }
    }
    
    return <span className="text-gray-500">N/A</span>;
  };

  // Helper function to extract deductible from requiredDataFields
  const getDeductible = (product: ProductWithPricing): React.ReactNode => {
    // Debug logging - always log in development
    console.log('🔍 getDeductible for product:', product.productName, {
      hasRequiredDataFields: !!product.requiredDataFields,
      requiredDataFields: product.requiredDataFields,
      isArray: Array.isArray(product.requiredDataFields),
      type: typeof product.requiredDataFields,
      isBundle: product.isBundle,
      hasIncludedProducts: !!(product.includedProducts && product.includedProducts.length > 0)
    });

    // For bundles, collect deductibles from all included products
    if (product.isBundle && product.includedProducts && product.includedProducts.length > 0) {
      const allDeductibleFields: Array<{ fieldName: string; options: string[]; productName: string }> = [];
      
      // Check each included product for deductibles
      product.includedProducts.forEach((includedProduct: any) => {
        if (includedProduct.requiredDataFields && Array.isArray(includedProduct.requiredDataFields)) {
          const deductibleField = includedProduct.requiredDataFields.find((field: any) => {
            if (typeof field === 'object' && field !== null) {
              return field.isDeductible === true || field.isDeductible === 1 || field.isDeductible === 'true';
            }
            return false;
          });
          
          if (deductibleField && typeof deductibleField === 'object') {
            const fieldName = deductibleField.fieldName || '';
            const options = deductibleField.fieldOptions || [];
            
            if (fieldName || options.length > 0) {
              allDeductibleFields.push({
                fieldName,
                options: Array.isArray(options) ? options : [],
                productName: includedProduct.productName || ''
              });
            }
          }
        }
      });
      
      // If we found deductibles from included products, display them
      if (allDeductibleFields.length > 0) {
        // Group by field name (in case multiple products have the same deductible field name)
        const groupedByFieldName = new Map<string, { options: Set<string>; productNames: string[] }>();
        
        allDeductibleFields.forEach(({ fieldName, options, productName }) => {
          const key = fieldName || 'Deductible';
          if (!groupedByFieldName.has(key)) {
            groupedByFieldName.set(key, { options: new Set(), productNames: [] });
          }
          const group = groupedByFieldName.get(key)!;
          options.forEach(opt => group.options.add(opt));
          if (productName && !group.productNames.includes(productName)) {
            group.productNames.push(productName);
          }
        });
        
        // Display all deductibles
        return (
          <div className="space-y-2">
            {Array.from(groupedByFieldName.entries()).map(([fieldName, { options, productNames }], index) => (
              <div key={index} className="space-y-1">
                {fieldName && (
                  <div className="text-xs font-medium text-gray-700">{fieldName}</div>
                )}
                <div className="text-sm text-gray-900">
                  {Array.from(options).sort().join(', ')}
                </div>
                {productNames.length > 1 && (
                  <div className="text-xs text-gray-500">
                    From: {productNames.join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      }
    }
    
    // For non-bundle products, check the product's own requiredDataFields
    if (!product.requiredDataFields || !Array.isArray(product.requiredDataFields)) {
      return <span className="text-gray-500">N/A</span>;
    }
    
    // Look for deductible field in requiredDataFields where isDeductible = true
    const deductibleField = product.requiredDataFields.find((field: any) => {
      if (typeof field === 'object' && field !== null) {
        const isDeductible = field.isDeductible === true || field.isDeductible === 1 || field.isDeductible === 'true';
        if (process.env.NODE_ENV === 'development' && isDeductible) {
          console.log('✅ Found deductible field:', field);
        }
        return isDeductible;
      }
      return false;
    });
    
    if (deductibleField && typeof deductibleField === 'object' && deductibleField !== null) {
      const fieldName = (deductibleField as any).fieldName || '';
      const options = (deductibleField as any).fieldOptions || [];
      
      if (options.length > 0) {
        return (
          <div className="space-y-1">
            {fieldName && (
              <div className="text-xs font-medium text-gray-700">{fieldName}</div>
            )}
            <div className="text-sm text-gray-900">{options.join(', ')}</div>
          </div>
        );
      } else if (fieldName) {
        return (
          <div className="text-sm text-gray-900">{fieldName}</div>
        );
      }
      return <span className="text-gray-500">Available</span>;
    }
    
    return <span className="text-gray-500">N/A</span>;
  };

  // Helper function to render PlanDetailsData preview
  const renderPlanDetailsPreview = (product: ProductWithPricing): React.ReactNode => {
    if (!product.planDetailsData || !product.planDetailsData.Plan_Data) {
      return (
        <div className="text-sm text-gray-500">
          {product.description || 'No plan details available'}
        </div>
      );
    }

    const planData = product.planDetailsData.Plan_Data;
    const header = planData.Header;
    const footer = planData.Footer;
    
    // Get body sections
    const bodySections: any[] = [];
    if (product.planDetailsData.Plan_Body) {
      const bodyCount = parseInt(product.planDetailsData.Plan_Body.Body_Count || "0");
      for (let i = 1; i <= bodyCount; i++) {
        const section = product.planDetailsData.Plan_Body[`Body${i}`];
        if (section) {
          bodySections.push(section);
        }
      }
    }

    return (
      <div className="space-y-3">
        {/* Header Preview */}
        {header && (
          <div 
            className="p-3 rounded text-sm"
            style={{ 
              backgroundColor: header.Background_color || '#1f8dbf',
              color: header.Text_color || '#FFFFFF'
            }}
          >
            {header.Image && (
              <div className="mb-2">
                <img 
                  src={header.Image} 
                  alt="Plan logo" 
                  className="h-8 object-contain"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              </div>
            )}
            <div className="font-semibold">{header.Text1}</div>
            {header.Text2 && <div className="text-xs mt-1 opacity-90">{header.Text2}</div>}
          </div>
        )}

        {/* Body Sections Preview */}
        {bodySections.length > 0 && (
          <div className="space-y-2 max-h-40 overflow-y-auto">
            {bodySections.slice(0, 3).map((section: any, idx: number) => (
              <div key={idx} className="bg-gray-50 rounded p-2 text-xs">
                <div className="font-semibold text-gray-900 mb-1">{section.Header}</div>
                <div className="text-gray-600 line-clamp-2">{section.Text1}</div>
              </div>
            ))}
            {bodySections.length > 3 && (
              <div className="text-xs text-gray-500 italic">
                +{bodySections.length - 3} more section{bodySections.length - 3 !== 1 ? 's' : ''}
              </div>
            )}
          </div>
        )}

        {/* Footer Preview */}
        {footer && (
          <div 
            className="p-2 rounded text-xs border-t"
            style={{ 
              backgroundColor: footer.Background_color || '#FFFFFF',
              color: footer.Text_color || '#000000'
            }}
          >
            <div className="font-semibold">{footer.Header}</div>
            {footer.Text1 && <div className="text-gray-600">{footer.Text1}</div>}
            {footer.Text2 && <div className="font-bold mt-1">{footer.Text2}</div>}
          </div>
        )}

        {/* View Full Details Button */}
        <button
          onClick={() => handleViewDocument(product)}
          className="text-oe-primary hover:text-oe-primary-dark text-sm font-medium flex items-center gap-1 mt-2"
        >
          <Eye className="h-4 w-4" />
          View Full Plan Details
        </button>
      </div>
    );
  };

  const comparisonProducts = selectedForComparison
    .map(id => products.find(p => p.productId === id))
    .filter((p): p is ProductWithPricing => p !== undefined);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-semibold text-gray-900 mb-2">
          Explore Our Products
        </h2>
        <p className="text-gray-600">
          Browse and compare our available products. Select up to 3 products to compare side-by-side, or choose products you're interested in to start enrollment.
        </p>
      </div>

      {/* Search and Actions Bar */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
          <input
            type="text"
            placeholder="Search products..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
          />
        </div>

        <div className="flex items-center gap-2">
          {/* View Mode Toggle */}
          <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode('grid')}
              className={`px-3 py-2 transition-colors ${
                viewMode === 'grid'
                  ? 'bg-oe-primary text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
              title="Grid View"
            >
              <Grid3x3 className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-2 transition-colors ${
                viewMode === 'list'
                  ? 'bg-oe-primary text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
              title="List View"
            >
              <List className="h-4 w-4" />
            </button>
          </div>

          {selectedForComparison.length >= 2 && (
            <button
              onClick={handleOpenComparison}
              className="px-4 py-2 bg-oe-secondary text-white rounded-lg hover:bg-oe-primary-dark flex items-center gap-2 transition-colors"
            >
              <GitCompare className="h-4 w-4" />
              <span className="hidden sm:inline">Compare {selectedForComparison.length} Products</span>
              <span className="sm:hidden">Compare ({selectedForComparison.length})</span>
            </button>
          )}
          
          {selectedProducts.length > 0 && !disableStartEnrollment && (
            <button
              onClick={() => onStartEnrollment(selectedProducts)}
              className="hidden sm:flex px-4 py-2 bg-oe-success text-white rounded-lg hover:bg-green-700 items-center gap-2 transition-colors"
            >
              <ShoppingCart className="h-4 w-4" />
              Start Enrollment ({selectedProducts.length})
            </button>
          )}
        </div>
      </div>

      {/* Selected Products Summary */}
      {selectedProducts.length > 0 && (
        <div className="bg-oe-primary-light border border-oe-primary rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-oe-primary-dark">
                {selectedProducts.length} product{selectedProducts.length !== 1 ? 's' : ''} selected
              </h3>
              <p className="text-sm text-oe-primary-dark mt-1">
                {disableStartEnrollment
                  ? 'To enroll in coverage, use your group\'s enrollment portal or contact your benefits administrator.'
                  : 'Click "Start Enrollment" to begin the enrollment process with your selected products.'}
              </p>
            </div>
            <button
              onClick={() => selectedProducts.forEach(id => onProductDeselect(id))}
              className="text-sm text-oe-primary hover:text-oe-primary-dark"
            >
              Clear All
            </button>
          </div>
        </div>
      )}

      {/* Products by Type */}
      {Object.entries(productsByType).map(([type, typeProducts]) => (
        <div key={type} className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900 border-b border-gray-200 pb-2">
            {type} ({typeProducts.length})
          </h3>
          
          {viewMode === 'grid' ? (
            /* Grid View - 3 cards wide, responsive */
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {typeProducts.map((product) => {
                const isSelected = selectedProducts.includes(product.productId);
                const isInComparison = selectedForComparison.includes(product.productId);
                const canAddToComparison = selectedForComparison.length < 3 || isInComparison;

                return (
                  <div
                    key={product.productId}
                    className={`bg-white border-2 rounded-lg p-4 transition-all flex flex-col ${
                      isSelected
                        ? 'border-green-500 shadow-md'
                        : isInComparison
                        ? 'border-blue-500 shadow-md'
                        : 'border-gray-200 hover:border-gray-300 hover:shadow-md'
                    }`}
                  >
                    {/* Product Logo */}
                    <div className="w-full h-32 bg-gray-50 rounded-lg border border-gray-200 flex items-center justify-center overflow-hidden mb-3">
                      {product.productLogoUrl ? (
                        <img
                          src={product.productLogoUrl}
                          alt={`${product.productName} logo`}
                          className="max-w-full max-h-full object-contain p-2"
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            target.style.display = 'none';
                            const fallback = target.nextElementSibling as HTMLElement;
                            if (fallback) fallback.style.display = 'flex';
                          }}
                        />
                      ) : null}
                      <div className={`w-full h-full items-center justify-center ${product.productLogoUrl ? 'hidden' : 'flex'}`}>
                        <Package className="h-12 w-12 text-gray-400" />
                      </div>
                    </div>

                    {/* Product Name and Price */}
                    <div className="flex items-start justify-between mb-2">
                      <h4 className="text-base font-semibold text-gray-900 flex-1 pr-2">
                        {product.productName}
                      </h4>
                      <div className="flex-shrink-0 text-right">
                        {renderProductPrice(product)}
                      </div>
                    </div>

                    {/* Description */}
                    {product.description && (
                      <p className="text-sm text-gray-600 mb-3 line-clamp-2 flex-1">
                        {product.description}
                      </p>
                    )}

                    {/* Action Buttons */}
                    <div className="flex flex-col gap-2 mt-auto">
                      <div className="flex items-center gap-2">
                        {(product.planDetailsData && product.planDetailsData.Plan_Data) || 
                         (product.isBundle && product.includedProducts?.some(p => p.planDetailsData && p.planDetailsData.Plan_Data)) ? (
                          <button
                            onClick={() => handleProductInfo(product)}
                            className="flex-1 px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200 flex items-center justify-center gap-1.5 transition-colors"
                            title="View Plan Details"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            Details
                          </button>
                        ) : null}

                        {hasProductDocuments(product as any) || (product.isBundle && product.includedProducts?.some((p: any) => hasProductDocuments(p))) ? (
                          <button
                            onClick={() => handleViewPDF(product)}
                            className="flex-1 px-3 py-1.5 text-xs font-medium text-oe-primary bg-oe-primary-light rounded hover:bg-oe-primary hover:text-white flex items-center justify-center gap-1.5 transition-colors"
                            title="View Product PDF"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            PDF
                          </button>
                        ) : null}
                      </div>

                      {!disableStartEnrollment && (
                        <button
                          onClick={() => handleSelectProduct(product)}
                          className={`w-full px-4 py-2 rounded-lg transition-colors flex items-center justify-center gap-2 ${
                            isSelected
                              ? 'bg-oe-success text-white hover:bg-green-700'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                          }`}
                        >
                          <ShoppingCart className="h-4 w-4" />
                          {isSelected ? 'Selected' : 'Select for Enrollment'}
                        </button>
                      )}

                      <button
                        onClick={() => handleCompareToggle(product.productId)}
                        disabled={!canAddToComparison && !isInComparison}
                        className={`w-full px-4 py-2 rounded-lg transition-colors flex items-center justify-center gap-2 ${
                          isInComparison
                            ? 'bg-oe-secondary text-white hover:bg-oe-primary-dark'
                            : canAddToComparison
                            ? 'border border-oe-secondary text-oe-secondary hover:bg-oe-primary-light'
                            : 'border border-gray-300 text-gray-400 cursor-not-allowed'
                        }`}
                      >
                        <GitCompare className="h-4 w-4" />
                        {isInComparison ? 'Remove from Compare' : 'Add to Compare'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* List View - Compact */
            <div className="space-y-2">
              {typeProducts.map((product) => {
                const isSelected = selectedProducts.includes(product.productId);
                const isInComparison = selectedForComparison.includes(product.productId);
                const canAddToComparison = selectedForComparison.length < 3 || isInComparison;

                return (
                  <div
                    key={product.productId}
                    className={`bg-white border-2 rounded-lg p-3 transition-all hover:shadow-md ${
                      isSelected
                        ? 'border-green-500 shadow-sm'
                        : isInComparison
                        ? 'border-blue-500 shadow-sm'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {/* Product Logo */}
                      <div className="flex-shrink-0 w-20 h-20 bg-gray-50 rounded-lg border border-gray-200 flex items-center justify-center overflow-hidden">
                        {product.productLogoUrl ? (
                          <img
                            src={product.productLogoUrl}
                            alt={`${product.productName} logo`}
                            className="w-full h-full object-contain p-2"
                            onError={(e) => {
                              const target = e.target as HTMLImageElement;
                              target.style.display = 'none';
                              const fallback = target.nextElementSibling as HTMLElement;
                              if (fallback) fallback.style.display = 'flex';
                            }}
                          />
                        ) : null}
                        <div className={`w-full h-full items-center justify-center ${product.productLogoUrl ? 'hidden' : 'flex'}`}>
                          <Package className="h-8 w-8 text-gray-400" />
                        </div>
                      </div>

                      {/* Product Details */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <h4 className="text-base font-semibold text-gray-900 flex-1">
                            {product.productName}
                          </h4>
                          <div className="flex-shrink-0 text-right">
                            {renderProductPrice(product)}
                          </div>
                        </div>

                        {product.description && (
                          <p className="text-sm text-gray-600 mb-2 line-clamp-2">
                            {product.description}
                          </p>
                        )}

                        {/* Action Buttons Row */}
                        <div className="flex items-center gap-2 flex-wrap">
                          {(product.planDetailsData && product.planDetailsData.Plan_Data) || 
                           (product.isBundle && product.includedProducts?.some(p => p.planDetailsData && p.planDetailsData.Plan_Data)) ? (
                            <button
                              onClick={() => handleProductInfo(product)}
                              className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200 flex items-center gap-1.5 transition-colors"
                              title="View Plan Details"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              Details
                            </button>
                          ) : null}

                          {hasProductDocuments(product as any) || (product.isBundle && product.includedProducts?.some((p: any) => hasProductDocuments(p))) ? (
                            <button
                              onClick={() => handleViewPDF(product)}
                              className="px-3 py-1.5 text-xs font-medium text-oe-primary bg-oe-primary-light rounded hover:bg-oe-primary hover:text-white flex items-center gap-1.5 transition-colors"
                              title="View Product PDF"
                            >
                              <FileText className="h-3.5 w-3.5" />
                              PDF
                            </button>
                          ) : null}

                          <button
                            onClick={() => handleCompareToggle(product.productId)}
                            disabled={!canAddToComparison && !isInComparison}
                            className={`px-3 py-1.5 text-xs font-medium rounded flex items-center gap-1.5 transition-colors ${
                              isInComparison
                                ? 'bg-oe-secondary text-white hover:bg-oe-primary-dark'
                                : canAddToComparison
                                ? 'border border-oe-secondary text-oe-secondary hover:bg-oe-primary-light'
                                : 'border border-gray-300 text-gray-400 cursor-not-allowed'
                            }`}
                            title={isInComparison ? 'Remove from comparison' : 'Add to comparison (max 3)'}
                          >
                            <GitCompare className="h-3.5 w-3.5" />
                            {isInComparison ? 'Comparing' : 'Compare'}
                          </button>

                          {!disableStartEnrollment && (
                            <button
                              onClick={() => handleSelectProduct(product)}
                              className={`px-3 py-1.5 text-xs font-medium rounded flex items-center gap-1.5 transition-colors ${
                                isSelected
                                  ? 'bg-oe-success text-white hover:bg-green-700'
                                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                              }`}
                            >
                              <ShoppingCart className="h-3.5 w-3.5" />
                              {isSelected ? 'Selected' : 'Select'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}

      {/* Empty State */}
      {filteredProducts.length === 0 && (
        <div className="text-center py-12">
          <p className="text-gray-500">No products found matching your search.</p>
        </div>
      )}

      {/* Floating Action Buttons - Mobile Friendly */}
      <div className="fixed bottom-6 z-40 sm:hidden flex items-center gap-3 left-1/2 transform -translate-x-1/2">
        {/* Floating Compare Button */}
        {selectedForComparison.length >= 2 && (
          <button
            onClick={handleOpenComparison}
            className="px-6 py-3 bg-oe-secondary text-white rounded-full shadow-lg hover:bg-oe-primary-dark flex items-center gap-2 transition-all transform hover:scale-105"
          >
            <GitCompare className="h-5 w-5" />
            <span className="font-semibold">Compare ({selectedForComparison.length})</span>
          </button>
        )}
        
        {/* Floating Start Enrollment Button - hidden for group marketing links */}
        {selectedProducts.length > 0 && !disableStartEnrollment && (
          <button
            onClick={() => onStartEnrollment(selectedProducts)}
            className="px-6 py-3 bg-oe-success text-white rounded-full shadow-lg hover:bg-green-700 flex items-center gap-2 transition-all transform hover:scale-105"
          >
            <ShoppingCart className="h-5 w-5" />
            <span className="font-semibold">Start ({selectedProducts.length})</span>
          </button>
        )}
      </div>

      {/* Comparison Modal */}
      {showComparisonModal && comparisonProducts.length >= 2 && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-2 sm:p-4">
          <div className="bg-white rounded-lg max-w-6xl w-full max-h-[95vh] sm:max-h-[90vh] flex flex-col">
            <div className="p-4 sm:p-6 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
              <h3 className="text-lg sm:text-xl font-semibold text-gray-900">
                Compare Products ({comparisonProducts.length})
              </h3>
              <button
                onClick={() => {
                  setShowComparisonModal(false);
                  setSelectedForComparison([]);
                }}
                className="text-gray-400 hover:text-gray-600 p-1"
              >
                <X className="h-5 w-5 sm:h-6 sm:w-6" />
              </button>
            </div>
            <div className="p-4 sm:p-6 overflow-x-auto flex-1 min-h-0">
              <div className="overflow-x-auto -mx-4 sm:mx-0">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-2 sm:px-4 py-2 sm:py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Feature
                      </th>
                      {comparisonProducts.map((product) => (
                        <th key={product.productId} className="px-2 sm:px-4 py-2 sm:py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider min-w-[120px]">
                          <span className="line-clamp-2">{product.productName}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    <tr>
                      <td className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-gray-900">Product Name</td>
                      {comparisonProducts.map((product) => (
                        <td key={product.productId} className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-gray-700">
                          <span className="line-clamp-2">{product.productName}</span>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-gray-900">Type</td>
                      {comparisonProducts.map((product) => (
                        <td key={product.productId} className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-gray-700">
                          {getProductTypeDisplay(product)}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-gray-900">Product Details</td>
                      {comparisonProducts.map((product) => (
                        <td key={product.productId} className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-gray-700">
                          <div className="space-y-2">
                            {(product.planDetailsData && product.planDetailsData.Plan_Data) || 
                             (product.isBundle && product.includedProducts?.some(p => p.planDetailsData && p.planDetailsData.Plan_Data)) ? (
                              <button
                                onClick={() => handleViewDocument(product)}
                                className="text-oe-primary hover:text-oe-primary-dark text-xs sm:text-sm font-medium flex items-center gap-1"
                              >
                                <Eye className="h-3 w-3 sm:h-4 sm:w-4 flex-shrink-0" />
                                <span className="whitespace-nowrap">View Plan Details</span>
                              </button>
                            ) : null}
                            {(hasProductDocuments(product as any) || (product.isBundle && product.includedProducts?.some((p: any) => hasProductDocuments(p)))) ? (
                              <button
                                onClick={() => handleViewPDF(product)}
                                className="text-oe-primary hover:text-oe-primary-dark text-xs sm:text-sm font-medium flex items-center gap-1"
                              >
                                <FileText className="h-3 w-3 sm:h-4 sm:w-4 flex-shrink-0" />
                                <span className="whitespace-nowrap">View PDF</span>
                              </button>
                            ) : null}
                            {(!product.planDetailsData || !product.planDetailsData.Plan_Data) && 
                             !hasProductDocuments(product as any) && 
                             (!product.isBundle || !product.includedProducts?.some((p: any) => p.planDetailsData || hasProductDocuments(p))) && (
                              <span className="text-gray-400 text-xs sm:text-sm">No details available</span>
                            )}
                          </div>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-gray-900">Tiers</td>
                      {comparisonProducts.map((product) => (
                        <td key={product.productId} className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-gray-700">
                          {getTiersInfo(product)}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-gray-900">Price Range</td>
                      {comparisonProducts.map((product) => (
                        <td key={product.productId} className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-gray-700 font-medium">
                          {getPriceRange(product)}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-gray-900">Deductible</td>
                      {comparisonProducts.map((product) => (
                        <td key={product.productId} className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-gray-700">
                          {getDeductible(product)}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div className="p-4 sm:p-6 border-t border-gray-200 flex flex-col sm:flex-row justify-end gap-2 flex-shrink-0">
              <button
                onClick={() => {
                  setShowComparisonModal(false);
                  setSelectedForComparison([]);
                }}
                className="w-full sm:w-auto px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Close
              </button>
                {!disableStartEnrollment && (
                  <button
                    onClick={() => {
                      comparisonProducts.forEach(p => {
                        if (!selectedProducts.includes(p.productId)) {
                          handleSelectProduct(p);
                        }
                      });
                      setShowComparisonModal(false);
                      setSelectedForComparison([]);
                    }}
                    className="w-full sm:w-auto px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark"
                  >
                    Select All for Enrollment
                  </button>
                )}
            </div>
          </div>
        </div>
      )}

      {/* Product Document Modal - Shows PlanDetailsData */}
      {showDocumentModal && selectedProductForDocument && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-2 sm:p-4">
          <div className="bg-white rounded-lg max-w-5xl w-full max-h-[95vh] sm:max-h-[90vh] flex flex-col">
            <div className="p-4 sm:p-6 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
              <h3 className="text-lg sm:text-xl font-semibold text-gray-900">
                {selectedProductForDocument.isBundle && selectedProductForDocument.includedProducts && 
                 ((selectedProductForDocument.planDetailsData && selectedProductForDocument.planDetailsData.Plan_Data) ||
                  selectedProductForDocument.includedProducts.some(p => p.planDetailsData && p.planDetailsData.Plan_Data))
                  ? 'Plan Details'
                  : selectedProductForDocument.productName}
              </h3>
              <button
                onClick={() => {
                  setShowDocumentModal(false);
                  setSelectedProductForDocument(null);
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-6 w-6" />
              </button>
            </div>
            <div className="flex flex-col flex-1 overflow-hidden">
              {/* Tabs for bundle products */}
              {selectedProductForDocument.isBundle && selectedProductForDocument.includedProducts && 
               ((selectedProductForDocument.planDetailsData && selectedProductForDocument.planDetailsData.Plan_Data) ||
                selectedProductForDocument.includedProducts.some(p => p.planDetailsData && p.planDetailsData.Plan_Data)) && (
                <div className="border-b border-gray-200 px-4 sm:px-6 pt-4 flex-shrink-0">
                  <div className="flex space-x-1 overflow-x-auto scrollbar-hide -mx-4 sm:mx-0 px-4 sm:px-0">
                    {(selectedProductForDocument.planDetailsData && selectedProductForDocument.planDetailsData.Plan_Data) && (
                      <button
                        onClick={() => setSelectedDocumentTab(selectedProductForDocument.productId)}
                        className={`px-3 sm:px-4 py-2 text-xs sm:text-sm font-medium border-b-2 transition-colors flex-shrink-0 ${
                          selectedDocumentTab === selectedProductForDocument.productId
                            ? 'border-oe-primary text-oe-primary'
                            : 'border-transparent text-gray-500 hover:text-gray-700'
                        }`}
                      >
                        {selectedProductForDocument.productName}
                      </button>
                    )}
                    {selectedProductForDocument.includedProducts
                      .filter(p => p.planDetailsData && p.planDetailsData.Plan_Data)
                      .map((includedProduct) => (
                        <button
                          key={includedProduct.productId}
                          onClick={() => setSelectedDocumentTab(includedProduct.productId)}
                          className={`px-3 sm:px-4 py-2 text-xs sm:text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex-shrink-0 ${
                            selectedDocumentTab === includedProduct.productId
                              ? 'border-oe-primary text-oe-primary'
                              : 'border-transparent text-gray-500 hover:text-gray-700'
                          }`}
                        >
                          {includedProduct.productName}
                        </button>
                      ))}
                  </div>
                </div>
              )}
              
              {/* Document Content */}
              <div className="p-6 overflow-y-auto flex-1">
                {(() => {
                  // Determine which product to show based on selected tab
                  let displayProduct: ProductWithPricing | null = null;
                  
                  if (selectedProductForDocument.isBundle && selectedProductForDocument.includedProducts) {
                    if (selectedDocumentTab === selectedProductForDocument.productId) {
                      displayProduct = selectedProductForDocument;
                    } else {
                      const foundProduct = selectedProductForDocument.includedProducts.find(
                        p => p.productId === selectedDocumentTab
                      );
                      // Cast to ProductWithPricing for display purposes (included products have a subset of fields)
                      displayProduct = foundProduct as any || null;
                    }
                  } else {
                    displayProduct = selectedProductForDocument;
                  }

                  if (!displayProduct) {
                    return <p className="text-gray-500 text-center py-8">No product selected.</p>;
                  }

                  // Show PlanDetailsData if available (this is the Plan Details modal)
                  if (displayProduct.planDetailsData && displayProduct.planDetailsData.Plan_Data) {
                    const planData = displayProduct.planDetailsData.Plan_Data;
                    const header = planData.Header;
                    const footer = planData.Footer;
                    
                    // Get body sections
                    const bodySections: any[] = [];
                    if (displayProduct.planDetailsData.Plan_Body) {
                      const bodyCount = parseInt(displayProduct.planDetailsData.Plan_Body.Body_Count || "0");
                      for (let i = 1; i <= bodyCount; i++) {
                        const section = displayProduct.planDetailsData.Plan_Body[`Body${i}`];
                        if (section) {
                          bodySections.push(section);
                        }
                      }
                    }

                    return (
                      <div className="space-y-4">
                        {/* Header */}
                        {header && (
                          <div 
                            className="p-6 rounded-lg text-center"
                            style={{ 
                              backgroundColor: header.Background_color || '#1f8dbf',
                              color: header.Text_color || '#FFFFFF'
                            }}
                          >
                            {header.Image && (
                              <div className="mb-4">
                                <img 
                                  src={header.Image} 
                                  alt="Plan logo" 
                                  className="h-24 mx-auto object-contain"
                                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                                />
                              </div>
                            )}
                            <h2 className="text-2xl font-bold">{header.Text1}</h2>
                            {header.Text2 && (
                              <p className="text-sm mt-2 opacity-90">{header.Text2}</p>
                            )}
                          </div>
                        )}

                        {/* Body Sections */}
                        {bodySections.length > 0 && (
                          <div className="space-y-4">
                            {bodySections.map((section: any, idx: number) => (
                              <div key={idx} className="bg-white rounded-lg border border-gray-200 p-4">
                                <h3 className="font-bold text-gray-900 mb-3 text-lg">{section.Header}</h3>
                                <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                                  {section.Text1}
                                </div>
                                
                                {/* Links */}
                                <div className="mt-4 space-y-2">
                                  {section.Link_Name1 && section.URL1 && (
                                    <a 
                                      href={section.URL1} 
                                      target="_blank" 
                                      rel="noopener noreferrer"
                                      className="flex items-center gap-2 text-oe-primary hover:text-oe-primary-dark text-sm font-medium"
                                    >
                                      <ExternalLink className="h-4 w-4" />
                                      {section.Link_Name1}
                                    </a>
                                  )}
                                  
                                  {section.Link_Name2 && section.URL2 && (
                                    <a 
                                      href={section.URL2} 
                                      target="_blank" 
                                      rel="noopener noreferrer"
                                      className="flex items-center gap-2 text-oe-primary hover:text-oe-primary-dark text-sm font-medium"
                                    >
                                      <ExternalLink className="h-4 w-4" />
                                      {section.Link_Name2}
                                    </a>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Footer */}
                        {footer && (
                          <div 
                            className="p-4 text-center border-t rounded-lg"
                            style={{ 
                              backgroundColor: footer.Background_color || '#FFFFFF',
                              color: footer.Text_color || '#000000'
                            }}
                          >
                            <h3 className="font-bold text-sm mb-2">{footer.Header}</h3>
                            <p className="text-xs opacity-75">{footer.Text1}</p>
                            {footer.Text2 && (
                              <p className="text-lg font-bold mt-2">{footer.Text2}</p>
                            )}
                          </div>
                        )}

                        {/* PDF Link - Optional link to view PDF if available */}
                        {hasProductDocuments(displayProduct as any) && (
                          <div className="border-t pt-4">
                            <button
                              onClick={() => {
                                setShowDocumentModal(false);
                                handleViewPDF(selectedProductForDocument!);
                              }}
                              className="text-oe-primary hover:text-oe-primary-dark text-sm font-medium flex items-center gap-2"
                            >
                              <FileText className="h-4 w-4" />
                              View Product Document PDF
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  }

                  // Fallback: No PlanDetailsData available
                  return (
                    <div className="text-center py-8">
                      <p className="text-gray-500">No plan details available for this product.</p>
                      {hasProductDocuments(displayProduct as any) && (
                        <button
                          onClick={() => {
                            setShowDocumentModal(false);
                            handleViewPDF(selectedProductForDocument!);
                          }}
                          className="mt-4 text-oe-primary hover:text-oe-primary-dark text-sm font-medium flex items-center gap-2 mx-auto"
                        >
                          <FileText className="h-4 w-4" />
                          View Product Document PDF
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
            <div className="p-4 sm:p-6 border-t border-gray-200 flex justify-end flex-shrink-0">
              <button
                onClick={() => {
                  setShowDocumentModal(false);
                  setSelectedProductForDocument(null);
                }}
                className="w-full sm:w-auto px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PDF Modal */}
      {showPDFModal && selectedProductForPDF && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-2 sm:p-4">
          <div className="bg-white rounded-lg max-w-6xl w-full max-h-[95vh] sm:max-h-[90vh] flex flex-col">
            <div className="p-4 sm:p-6 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
              <h3 className="text-lg sm:text-xl font-semibold text-gray-900">
                Product Documents
                {selectedProductForPDF.isBundle && selectedProductForPDF.includedProducts && (
                  <span className="text-xs sm:text-sm font-normal text-gray-500 ml-2">
                    ({(selectedProductForPDF.includedProducts?.filter((p: any) => hasProductDocuments(p)).length ?? 0) + (hasProductDocuments(selectedProductForPDF as any) ? 1 : 0)} documents)
                  </span>
                )}
              </h3>
              <button
                onClick={() => {
                  setShowPDFModal(false);
                  setSelectedProductForPDF(null);
                  setPdfUrls(new Map());
                }}
                className="text-gray-400 hover:text-gray-600 p-1"
              >
                <X className="h-5 w-5 sm:h-6 sm:w-6" />
              </button>
            </div>
            
            {/* Tabs for bundles */}
            {selectedProductForPDF.isBundle && selectedProductForPDF.includedProducts && 
             (selectedProductForPDF.productDocumentUrl || selectedProductForPDF.includedProducts.some(p => p.productDocumentUrl)) && (
              <div className="border-b border-gray-200 px-4 sm:px-6 flex-shrink-0">
                <div className="flex space-x-1 overflow-x-auto scrollbar-hide -mx-4 sm:mx-0 px-4 sm:px-0">
                  {hasProductDocuments(selectedProductForPDF as any) && (
                    <button
                      onClick={() => setSelectedPDFTab(selectedProductForPDF!.productId)}
                      className={`px-3 sm:px-4 py-2 text-xs sm:text-sm font-medium border-b-2 transition-colors flex-shrink-0 ${
                        selectedPDFTab === selectedProductForPDF.productId
                          ? 'border-oe-primary text-oe-primary'
                          : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                      }`}
                    >
                      {selectedProductForPDF.productName}
                    </button>
                  )}
                  {selectedProductForPDF.includedProducts
                    .filter((p: any) => hasProductDocuments(p))
                    .map((included) => (
                      <button
                        key={included.productId}
                        onClick={() => setSelectedPDFTab(included.productId)}
                        className={`px-3 sm:px-4 py-2 text-xs sm:text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex-shrink-0 ${
                          selectedPDFTab === included.productId
                            ? 'border-oe-primary text-oe-primary'
                            : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                        }`}
                      >
                        {included.productName}
                      </button>
                    ))}
                </div>
              </div>
            )}
            
            {/* PDF Content */}
            <div className="p-4 sm:p-6 overflow-y-auto flex-1 min-h-0">
              {(() => {
                // Determine which product to show based on selected tab
                let displayProduct: ProductWithPricing | null = null;
                
                if (selectedProductForPDF.isBundle && selectedProductForPDF.includedProducts) {
                  if (selectedPDFTab === selectedProductForPDF.productId) {
                    displayProduct = selectedProductForPDF;
                  } else {
                    const foundProduct = selectedProductForPDF.includedProducts.find(
                      p => p.productId === selectedPDFTab
                    );
                    // Cast to ProductWithPricing for display purposes (included products have a subset of fields)
                    displayProduct = foundProduct as any || null;
                  }
                } else {
                  displayProduct = selectedProductForPDF;
                }

                if (!displayProduct || !hasProductDocuments(displayProduct as any)) {
                  return <p className="text-gray-500 text-center py-8">No PDF document available for this product.</p>;
                }

                const docs = getProductDocumentItems(displayProduct as any);
                const pdfUrl = pdfUrls.get(displayProduct.productId) || (docs.length > 0 ? docs[0].documentUrl : undefined);

                return (
                  <div className="w-full h-full">
                    <iframe
                      src={pdfUrl}
                      className="w-full h-full min-h-[400px] sm:min-h-[600px] border border-gray-200 rounded"
                      title={`PDF for ${displayProduct.productName}`}
                    />
                  </div>
                );
              })()}
            </div>
            
            <div className="p-4 sm:p-6 border-t border-gray-200 flex justify-end flex-shrink-0">
              <button
                onClick={() => {
                  setShowPDFModal(false);
                  setSelectedProductForPDF(null);
                  setPdfUrls(new Map());
                }}
                className="w-full sm:w-auto px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MarketingProductSelectionStep;

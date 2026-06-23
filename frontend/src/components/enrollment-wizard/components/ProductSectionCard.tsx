// frontend/src/components/enrollment-wizard/components/ProductSectionCard.tsx
import { ChevronDown, ChevronUp, GripVertical, Info } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useAvailableBundles } from '../../../hooks/useAvailableBundles';
import { useProductsByType } from '../../../hooks/useProductsByType';
import { apiService } from '../../../services/api.service';
import PerProductLicenseValidationSummary, { type LicenseValidationProduct } from './PerProductLicenseValidationSummary';
import { AvailableProductType, WizardProductSection } from '../types/wizard.types';

interface ProductSectionCardProps {
  section: WizardProductSection;
  availableProductTypes: AvailableProductType[];
  onUpdate: (updates: Partial<WizardProductSection>) => void;
  onRemove: () => void;
  canRemove: boolean;
  tenantId?: string; // For SysAdmin to get tenant-specific products
  templateType?: 'Individual' | 'Group'; // Template type to filter products by SalesType
  groupId?: string; // Group ID for Group templates
  index: number;
  totalSections: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  mustBeSoldWithByProductId?: Record<string, { mustBeSoldWithProductIds: string[]; mustBeSoldWithProductNames: string[] }>;
  licenseValidationProducts?: LicenseValidationProduct[];
  isLicenseValidationLoading?: boolean;
  onFixLicenses?: () => void;
}

const ProductSectionCard: React.FC<ProductSectionCardProps> = ({
  section,
  availableProductTypes,
  onUpdate,
  onRemove,
  canRemove,
  tenantId,
  templateType,
  groupId,
  index,
  totalSections,
  onMoveUp,
  onMoveDown,
  mustBeSoldWithByProductId = {},
  licenseValidationProducts = [],
  isLicenseValidationLoading = false,
  onFixLicenses
}) => {
  
  // Auto-expand accordion for quick-added sections (when includeAllProducts is false initially)
  const [touched, setTouched] = useState({ page: false });
  const [bundleProducts, setBundleProducts] = useState<Record<string, any[]>>({});
  const { data: availableProducts = [], isLoading: isLoadingProducts } = useProductsByType(section.productType, tenantId, templateType, groupId);
  const { data: allAvailableBundles = [], isLoading: isLoadingBundles } = useAvailableBundles(tenantId);
  
  // Only show bundles for Healthcare/Medical product types
  const isHealthcareSection = section.productType?.toLowerCase() === 'healthcare' || section.productType?.toLowerCase() === 'medical';
  const availableBundles = isHealthcareSection ? allAvailableBundles : [];
  const selectedProductIds = React.useMemo(() => {
    const ids = new Set<string>();
    (section.specificProducts || []).forEach((id) => ids.add(String(id)));
    (section.specificBundles || []).forEach((id) => ids.add(String(id)));
    return ids;
  }, [section.specificProducts, section.specificBundles]);

  const hasValidationScope = selectedProductIds.size > 0 || section.includeAllProducts === true || section.includeAllBundles === true;

  const relevantValidationProducts = React.useMemo(() => {
    if (!licenseValidationProducts.length) return [];

    if (selectedProductIds.size > 0) {
      return licenseValidationProducts.filter((item) => selectedProductIds.has(String(item.productId)));
    }

    if (section.sectionType === 'bundles' && section.includeAllBundles === true) {
      return licenseValidationProducts.filter((item) => {
        if (!item.isBundle) return false;
        if (section.productType && item.productType !== section.productType) return false;
        return true;
      });
    }

    if (section.includeAllProducts === true) {
      return licenseValidationProducts.filter((item) => {
        if (section.productType && item.productType !== section.productType) return false;
        return true;
      });
    }

    return [];
  }, [
    licenseValidationProducts,
    selectedProductIds,
    section.sectionType,
    section.includeAllBundles,
    section.includeAllProducts,
    section.productType
  ]);

  /** Products in this section where required license types are met by the direct upline agent’s licenses */
  const uplineLicenseCoverageProducts = React.useMemo(() => {
    if (isLicenseValidationLoading) return [];
    return relevantValidationProducts.filter(
      (item) =>
        item.isValid &&
        Array.isArray(item.licensesSatisfiedByUpline) &&
        item.licensesSatisfiedByUpline.length > 0
    );
  }, [relevantValidationProducts, isLicenseValidationLoading]);

  // For product list: split into bundles (first) and individual products, for clear labeling
  const productListsForDisplay = React.useMemo(() => {
    const allFiltered = availableProducts.filter((product: any) => {
      if (!isHealthcareSection) {
        const isBundle = product.IsBundle === 1 || product.IsBundle === true;
        return !isBundle;
      }
      return true;
    });
    const bundles = allFiltered.filter((p: any) => p.IsBundle === 1 || p.IsBundle === true);
    const individualProducts = allFiltered.filter((p: any) => !(p.IsBundle === 1 || p.IsBundle === true));
    return { bundles, individualProducts };
  }, [availableProducts, isHealthcareSection]);

  // Ensure sectionType is 'products' for non-Healthcare sections
  useEffect(() => {
    if (!isHealthcareSection && section.sectionType === 'bundles') {
      onUpdate({ sectionType: 'products' });
    }
  }, [isHealthcareSection, section.sectionType, onUpdate]);

  // Fetch included products for bundles
  useEffect(() => {
    const fetchBundleProducts = async () => {
      const bundles = availableProducts.filter(p => (p as any).IsBundle === 1 || (p as any).IsBundle === true);
      
      for (const bundle of bundles) {
        if (!bundleProducts[bundle.ProductId]) {
          try {
            const response = await apiService.get<{ success: boolean; data: any[] }>(`/api/products/${bundle.ProductId}/bundle-products`);
            if (response.success && response.data) {
              setBundleProducts(prev => ({
                ...prev,
                [bundle.ProductId]: response.data
              }));
            }
          } catch (error) {
            console.error(`Error fetching bundle products for ${bundle.ProductId}:`, error);
          }
        }
      }
    };

    if (availableProducts.length > 0) {
      fetchBundleProducts();
    }
  }, [availableProducts, bundleProducts]);



  // Auto-select disabled - products start unselected by default
  // Users can manually select products or use the "Select All" button

  const handleInputChange = (field: keyof WizardProductSection, value: string) => {
    onUpdate({ [field]: value });
    
    // Reset product selection when product type changes
    if (field === 'productType') {
      onUpdate({ 
        [field]: value,
        specificProducts: [],
        includeAllProducts: false 
      });
    }
  };


  const handleSelectAllToggle = () => {
    const allProductIds = availableProducts.map(product => product.ProductId);
    const allSelected = (section.specificProducts || []).length === availableProducts.length;
    
    if (allSelected) {
      // Unselect all products
      onUpdate({ 
        includeAllProducts: false,
        specificProducts: []
      });
    } else {
      // Select all products
      onUpdate({ 
        includeAllProducts: false,  // Use specificProducts array, not "include all"
        specificProducts: allProductIds
      });
    }
  };

  const handleSpecificProductToggle = (productId: string, checked: boolean) => {
    const currentProducts = section.specificProducts || [];
    const updatedProducts = checked
      ? [...currentProducts, productId]
      : currentProducts.filter(id => id !== productId);
    
    // Always use false for includeAllProducts when selecting specific products
    // includeAllProducts: true means "fetch ALL products dynamically from database"
    // includeAllProducts: false means "only use the products in specificProducts array"
    onUpdate({ 
      specificProducts: updatedProducts,
      includeAllProducts: false
    });
  };

  const handleSelectAllBundlesToggle = () => {
    const allBundleIds = availableBundles.map(bundle => bundle.ProductId);
    const allSelected = (section.specificBundles || []).length === availableBundles.length;
    
    if (allSelected) {
      // Unselect all bundles
      onUpdate({ 
        includeAllBundles: false,
        specificBundles: []
      });
    } else {
      // Select all bundles
      onUpdate({ 
        includeAllBundles: false,  // Use specificBundles array, not "include all"
        specificBundles: allBundleIds
      });
    }
  };

  const handleSpecificBundleToggle = (bundleId: string, checked: boolean) => {
    const currentBundles = section.specificBundles || [];
    const updatedBundles = checked
      ? [...currentBundles, bundleId]
      : currentBundles.filter(id => id !== bundleId);
    
    // Always use false - we're selecting specific bundles, not "all bundles dynamically"
    onUpdate({
      specificBundles: updatedBundles,
      includeAllBundles: false
    });
  };

  const moveProductInOrder = (productId: string, direction: 'up' | 'down') => {
    const list = section.specificProducts || [];
    const idx = list.indexOf(productId);
    if (idx === -1) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= list.length) return;
    const next = [...list];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    onUpdate({ specificProducts: next, includeAllProducts: false });
  };

  const moveBundleInOrder = (bundleId: string, direction: 'up' | 'down') => {
    const list = section.specificBundles || [];
    const idx = list.indexOf(bundleId);
    if (idx === -1) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= list.length) return;
    const next = [...list];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    onUpdate({ specificBundles: next, includeAllBundles: false });
  };

  const getProductTypeIcon = (productType: string) => {
    switch (productType.toLowerCase()) {
      case 'medical':
      case 'healthcare':
        return '🏥';
      case 'dental':
        return '🦷';
      case 'vision':
        return '👁️';
      case 'life':
      case 'life insurance':
        return '❤️';
      case 'disability':
        return '♿';
      case 'accident':
        return '🚑';
      case 'critical illness':
        return '⚕️';
      case 'hospital indemnity':
        return '🏨';
      case 'telemedicine':
      case 'telemed':
        return '📱';
      case 'bundle':
        return '📦';
      default:
        return '📋';
    }
  };

  const isValid = section.page.trim().length > 0 && 
                 section.productType?.trim().length > 0;
  const hasTouched = touched.page;

  return (
    <div>
      <div className="grid grid-cols-1 gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Section Title</label>
          <input
            type="text"
            value={section.page}
            onChange={(e) => handleInputChange('page', e.target.value)}
            onBlur={() => setTouched(prev => ({ ...prev, page: true }))}
            placeholder="e.g., Medical Plans"
            className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${touched.page && !section.page.trim() ? 'border-red-300' : 'border-gray-300'}`}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea
            value={section.description}
            onChange={(e) => handleInputChange('description', e.target.value)}
            placeholder="Optional description to help users understand this section"
            rows={2}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
          />
        </div>
      </div>

        {section.productType && (
          <div className="mt-3">
            <div className="w-full flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-gray-900">
                {section.sectionType === 'bundles' ? 'Bundle Selection' : 'Product Selection'}
              </span>
              <span className="text-xs text-gray-500">
                {section.sectionType === 'bundles'
                  ? `(${(section.specificBundles || []).length} of ${availableBundles.length} Selected)`
                  : `(${(section.specificProducts || []).length} of ${availableProducts.length} Selected)` }
              </span>
            </div>

            <div>
              {/* Only show bundle selection for Healthcare/Medical sections */}
              {section.sectionType === 'bundles' && isHealthcareSection ? (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm text-gray-500">Select bundles to include in this section:</p>
                    <button
                      onClick={handleSelectAllBundlesToggle}
                      disabled={isLoadingBundles || availableBundles.length === 0}
                      className="px-3 py-1.5 text-xs font-medium text-oe-primary border border-oe-primary rounded-lg hover:bg-oe-primary-light disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {(section.specificBundles || []).length === availableBundles.length && availableBundles.length > 0
                        ? 'Unselect All'
                        : 'Select All'}
                    </button>
                  </div>
                  {isLoadingBundles ? (
                    <p className="text-sm text-gray-500">Loading available bundles...</p>
                  ) : availableBundles.length === 0 ? (
                    <p className="text-sm text-gray-500">No bundles available</p>
                  ) : (
                    <div>
                      {availableBundles.map((bundle, index) => (
                        <label key={`${bundle.ProductId}-${index}`} className="flex items-start mb-2">
                          <input
                            type="checkbox"
                            checked={(section.specificBundles || []).includes(bundle.ProductId)}
                            onChange={(e) => handleSpecificBundleToggle(bundle.ProductId, e.target.checked)}
                            className="h-4 w-4 text-oe-primary border-gray-300 rounded mt-0.5"
                          />
                          <span className="ml-2">
                            <span className="text-sm font-medium">📦 {bundle.Name}</span>
                            {bundle.Description && (
                              <span className="block text-xs text-gray-500">{bundle.Description}</span>
                            )}
                            {mustBeSoldWithByProductId[String(bundle.ProductId)]?.mustBeSoldWithProductNames?.length > 0 && (
                              <span className="block text-xs text-amber-600 mt-0.5">
                                This product must be sold with at least one of: {mustBeSoldWithByProductId[String(bundle.ProductId)].mustBeSoldWithProductNames.join(', ')}.
                              </span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm text-gray-500">Select products to include in this section:</p>
                    <button
                      onClick={handleSelectAllToggle}
                      disabled={isLoadingProducts || availableProducts.length === 0}
                      className="px-3 py-1.5 text-xs font-medium text-oe-primary border border-oe-primary rounded-lg hover:bg-oe-primary-light disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {(section.specificProducts || []).length === availableProducts.length && availableProducts.length > 0
                        ? 'Unselect All'
                        : 'Select All'}
                    </button>
                  </div>
                  {isLoadingProducts ? (
                    <p className="text-sm text-gray-500">Loading available products...</p>
                  ) : availableProducts.length === 0 ? (
                    <p className="text-sm text-gray-500">No products available for this type</p>
                  ) : (
                    <div className="space-y-4">
                      {isHealthcareSection && productListsForDisplay.bundles.length > 0 && (
                        <div>
                          <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Bundles</div>
                          <div className="pl-0">
                            {productListsForDisplay.bundles.map((product: any, index: number) => {
                              const includedProducts = bundleProducts[product.ProductId] || [];
                              return (
                                <div key={`${product.ProductId}-${index}`} className="mb-2">
                                  <label className="flex items-start">
                                    <input
                                      type="checkbox"
                                      checked={(section.specificProducts || []).includes(product.ProductId)}
                                      onChange={(e) => handleSpecificProductToggle(product.ProductId, e.target.checked)}
                                      className="h-4 w-4 text-oe-primary border-gray-300 rounded mt-0.5"
                                    />
                                    <span className="ml-2">
                                      <span className="text-sm font-medium">📦 {product.Name}</span>
                                      {product.Carrier && <span className="block text-xs text-gray-500">{product.Carrier}</span>}
                                      {mustBeSoldWithByProductId[String(product.ProductId)]?.mustBeSoldWithProductNames?.length > 0 && (
                                        <span className="block text-xs text-amber-600 mt-0.5">
                                          This product must be sold with at least one of: {mustBeSoldWithByProductId[String(product.ProductId)].mustBeSoldWithProductNames.join(', ')}.
                                        </span>
                                      )}
                                    </span>
                                  </label>
                                  {includedProducts.length > 0 && (
                                    <div className="ml-8 mt-1 space-y-0.5">
                                      <div className="text-xs text-gray-500 font-medium">Includes:</div>
                                      {includedProducts.map((includedProduct: any) => (
                                        <div key={includedProduct.IncludedProductId} className="text-xs text-gray-600">
                                          • {includedProduct.ProductName}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {productListsForDisplay.individualProducts.length > 0 && (
                        <div>
                          <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Individual products</div>
                          <div className="pl-0">
                            {productListsForDisplay.individualProducts.map((product: any, index: number) => {
                              const includedProducts = bundleProducts[product.ProductId] || [];
                              return (
                                <div key={`${product.ProductId}-${index}`} className="mb-2">
                                  <label className="flex items-start">
                                    <input
                                      type="checkbox"
                                      checked={(section.specificProducts || []).includes(product.ProductId)}
                                      onChange={(e) => handleSpecificProductToggle(product.ProductId, e.target.checked)}
                                      className="h-4 w-4 text-oe-primary border-gray-300 rounded mt-0.5"
                                    />
                                    <span className="ml-2">
                                      <span className="text-sm font-medium">{product.Name}</span>
                                      {product.Carrier && <span className="block text-xs text-gray-500">{product.Carrier}</span>}
                                      {mustBeSoldWithByProductId[String(product.ProductId)]?.mustBeSoldWithProductNames?.length > 0 && (
                                        <span className="block text-xs text-amber-600 mt-0.5">
                                          This product must be sold with at least one of: {mustBeSoldWithByProductId[String(product.ProductId)].mustBeSoldWithProductNames.join(', ')}.
                                        </span>
                                      )}
                                    </span>
                                  </label>
                                  {includedProducts.length > 0 && (
                                    <div className="ml-8 mt-1 space-y-0.5">
                                      <div className="text-xs text-gray-500 font-medium">Includes:</div>
                                      {includedProducts.map((includedProduct: any) => (
                                        <div key={includedProduct.IncludedProductId} className="text-xs text-gray-600">
                                          • {includedProduct.ProductName}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Display order: reorder selected products/bundles within this section */}
              {hasValidationScope && (
                <>
                  <PerProductLicenseValidationSummary
                    items={relevantValidationProducts}
                    isLoading={isLicenseValidationLoading}
                    onFix={onFixLicenses}
                  />
                  {uplineLicenseCoverageProducts.length > 0 && (
                    <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3">
                      <div className="flex gap-2">
                        <Info className="h-4 w-4 shrink-0 text-blue-600 mt-0.5" aria-hidden="true" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-blue-900">Qualified via your direct upline</p>
                          <p className="mt-1 text-xs text-blue-800">
                            For the product(s) below, the license requirement is satisfied by your direct upline
                            agent&apos;s active license (not your own).
                          </p>
                          <ul className="mt-2 list-disc list-inside space-y-1 text-xs text-blue-900">
                            {uplineLicenseCoverageProducts.map((item) => (
                              <li key={item.productId}>
                                <span className="font-medium">{item.productName}</span>
                                {item.licensesSatisfiedByUpline && item.licensesSatisfiedByUpline.length > 0 && (
                                  <span className="text-blue-800">
                                    {' '}
                                    — {item.licensesSatisfiedByUpline.join(', ')}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Display order: reorder selected products/bundles within this section */}
              {section.sectionType === 'bundles' && (section.specificBundles || []).length > 0 && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Display order (drag order in enrollment)</div>
                  <div className="space-y-1">
                    {(section.specificBundles || []).map((bundleId, i) => {
                      const bundle = availableBundles.find((b: any) => b.ProductId === bundleId);
                      const name = bundle?.Name ?? bundleId;
                      return (
                        <div key={bundleId} className="flex items-center gap-2 py-1.5 px-2 rounded bg-gray-50 border border-gray-100">
                          <GripVertical className="h-4 w-4 text-gray-400 flex-shrink-0" />
                          <span className="text-sm text-gray-900 flex-1 truncate">{name}</span>
                          <div className="flex flex-col gap-0">
                            <button type="button" onClick={() => moveBundleInOrder(bundleId, 'up')} disabled={i === 0} className="p-0.5 text-gray-500 hover:text-oe-primary disabled:opacity-30 disabled:cursor-not-allowed" title="Move up"><ChevronUp className="h-4 w-4" /></button>
                            <button type="button" onClick={() => moveBundleInOrder(bundleId, 'down')} disabled={i === (section.specificBundles?.length ?? 0) - 1} className="p-0.5 text-gray-500 hover:text-oe-primary disabled:opacity-30 disabled:cursor-not-allowed" title="Move down"><ChevronDown className="h-4 w-4" /></button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {section.sectionType !== 'bundles' && (section.specificProducts || []).length > 0 && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Display order (order in enrollment)</div>
                  <div className="space-y-1">
                    {(section.specificProducts || []).map((productId, i) => {
                      const product = availableProducts.find((p: any) => p.ProductId === productId);
                      const name = product?.Name ?? productId;
                      return (
                        <div key={productId} className="flex items-center gap-2 py-1.5 px-2 rounded bg-gray-50 border border-gray-100">
                          <GripVertical className="h-4 w-4 text-gray-400 flex-shrink-0" />
                          <span className="text-sm text-gray-900 flex-1 truncate">{name}</span>
                          <div className="flex flex-col gap-0">
                            <button type="button" onClick={() => moveProductInOrder(productId, 'up')} disabled={i === 0} className="p-0.5 text-gray-500 hover:text-oe-primary disabled:opacity-30 disabled:cursor-not-allowed" title="Move up"><ChevronUp className="h-4 w-4" /></button>
                            <button type="button" onClick={() => moveProductInOrder(productId, 'down')} disabled={i === (section.specificProducts?.length ?? 0) - 1} className="p-0.5 text-gray-500 hover:text-oe-primary disabled:opacity-30 disabled:cursor-not-allowed" title="Move down"><ChevronDown className="h-4 w-4" /></button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              </div>
          </div>
        )}

        {!isValid && hasTouched && (
          <div className="mt-2 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <p className="text-sm font-medium text-yellow-800 mb-1">Missing required fields:</p>
            <ul className="list-disc list-inside text-sm text-yellow-700">
              {touched.page && !section.page.trim() && <li>Section title is required</li>}
              {!section.productType?.trim() && <li>Product type is required (this should be set automatically by the category tab)</li>}
            </ul>
          </div>
        )}

        {/* Debug Panel - Development Only */}
        {(() => {
          const urlParams = new URLSearchParams(window.location.search);
          return urlParams.get('debug') === '1' && section.productType;
        })() && (
          <div className="mt-2 bg-gray-100 border border-gray-300 rounded-lg p-3">
            <details className="group">
              <summary className="cursor-pointer font-medium text-gray-700 hover:text-gray-900 text-xs">
                🔍 Product Debug (Dev Only)
              </summary>
              <div className="mt-2 text-xs text-gray-600 space-y-2">
                                  <div>
                    <strong>Product Loading State:</strong>
                    <ul className="ml-4 mt-1 space-y-1">
                      <li>Product Type: {section.productType}</li>
                      <li>Tenant ID: {tenantId || 'Not set'}</li>
                      <li>Loading Products: {isLoadingProducts ? 'Yes' : 'No'}</li>
                      <li>Available Products: {availableProducts.length}</li>
                      <li>Section Config: includeAllProducts={section.includeAllProducts ? 'true' : 'false'}</li>
                      <li>Specific Products: {section.specificProducts?.length || 0}</li>
                    </ul>
                    
                    <div className="mt-2">
                      <button 
                        onClick={() => {
                          console.log('🔍 Manual refresh requested for:', section.productType);
                          // This will trigger a manual refresh
                          window.location.reload();
                        }}
                        className="px-2 py-1 bg-blue-200 text-blue-800 rounded text-xs hover:bg-blue-300"
                      >
                        🔄 Force Refresh
                      </button>
                    </div>
                  </div>
                
                <div>
                  <strong>Raw Product Data:</strong>
                  <pre className="mt-1 p-2 bg-gray-200 rounded overflow-auto max-h-32 text-xs">
                    {JSON.stringify({
                      productType: section.productType,
                      tenantId,
                      availableProducts: availableProducts.map(p => ({ id: p.ProductId, name: p.Name, type: p.ProductType, status: p.Status })),
                      sectionConfig: {
                        includeAllProducts: section.includeAllProducts,
                        specificProducts: section.specificProducts,
                        sectionType: section.sectionType
                      }
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

export default ProductSectionCard;

// File: frontend/src/pages/agent/AgentProducts.tsx

import {
    AlertTriangle,
    Building,
    CheckCircle,
    Clock,
    DollarSign,
    Eye,
    Grid,
    List,
    Package,
    Search,
    Sparkles,
    User,
    XCircle,
} from 'lucide-react';
import React, { useState } from 'react';
import QuickQuoteWizardModal from '../../components/agents/QuickQuoteWizardModal';
import { useAgentProducts } from '../../hooks/agent/useAgentProducts';
import SubscribedProductDetailsModal, {
    type SubscribedProduct,
} from '../../components/products/SubscribedProductDetailsModal';

// Feature flag - set to false to hide pending products from agents
const SHOW_PENDING_PRODUCTS_TO_AGENTS = true;

// Notification component
const Notification: React.FC<{ message: string; onDismiss: () => void }> = ({ message, onDismiss }) => {
  if (!message) return null;

  return (
    <div className="fixed top-5 right-5 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg shadow-md z-50 flex items-center">
      <AlertTriangle className="h-5 w-5 mr-3" />
      <span>{message}</span>
      <button onClick={onDismiss} className="ml-4 text-red-700 hover:text-red-900">
        <XCircle className="h-5 w-5" />
      </button>
    </div>
  );
};

const AgentProducts: React.FC = () => {
  const { data: subscribedProducts = [], isLoading, isError, error } = useAgentProducts();
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProductType, setSelectedProductType] = useState<string>('');
  const [audienceTab, setAudienceTab] = useState<'individual' | 'group'>('individual');
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [selectedSubscription, setSelectedSubscription] = useState<SubscribedProduct | null>(null);
  const [viewMode, setViewMode] = useState<'cards' | 'list'>('cards');
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [showQuickQuoteModal, setShowQuickQuoteModal] = useState(false);

  const isBundle = (p: SubscribedProduct) => p.isBundle === true;

  const getProductTypes = () => {
    const types = new Set(subscribedProducts.map(p => p.productType).filter(Boolean));
    return Array.from(types).filter(t => t !== 'Bundle' && t !== 'bundle');
  };

  const matchesAudience = (product: SubscribedProduct, tab: 'individual' | 'group') => {
    const salesType = String(product.salesType || (product as any).SalesType || '').trim().toLowerCase();
    if (!salesType || salesType === 'both') return true;
    return tab === 'individual' ? salesType === 'individual' : salesType === 'group';
  };

  const baseFilteredProducts = subscribedProducts.filter(product => {
    const matchesSearch = !searchTerm || 
      product.productName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      product.description?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = !selectedProductType || product.productType === selectedProductType;
    
    const statusOk = product.subscriptionStatus === 'Active' || 
      (SHOW_PENDING_PRODUCTS_TO_AGENTS && product.subscriptionStatus === 'Pending');
    
    return matchesSearch && matchesType && statusOk;
  });

  const individualCount = baseFilteredProducts.filter(p => matchesAudience(p, 'individual')).length;
  const groupCount = baseFilteredProducts.filter(p => matchesAudience(p, 'group')).length;
  const audienceFilteredProducts = baseFilteredProducts
    .filter(product => matchesAudience(product, audienceTab))
    .sort((a, b) => {
      const bundleSort = Number(isBundle(b)) - Number(isBundle(a));
      if (bundleSort !== 0) return bundleSort;
      return a.productName.localeCompare(b.productName);
    });

  // Pagination calculations (based on audience-filtered list)
  const totalItems = audienceFilteredProducts.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedProducts = audienceFilteredProducts.slice(startIndex, endIndex);

  // Reset to first page when filters change
  const handleSearchChange = (value: string) => {
    setSearchTerm(value);
    setCurrentPage(1);
  };

  const handleProductTypeChange = (value: string) => {
    setSelectedProductType(value);
    setCurrentPage(1);
  };

  const handleAudienceTabChange = (tab: 'individual' | 'group') => {
    setAudienceTab(tab);
    setCurrentPage(1);
  };

  const handleItemsPerPageChange = (value: number) => {
    setItemsPerPage(value);
    setCurrentPage(1);
  };

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-full">
      <Notification message={isError ? (error as Error)?.message || 'An unknown error occurred' : ''} onDismiss={() => {}} />

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#1f8dbf]"></div>
        </div>
      ) : (
        <>
          {/* Products Table */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <div className="border-b border-gray-200 p-6">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                  <h2 className="text-lg font-semibold text-gray-900">Available Products</h2>
                  <div className="flex items-center space-x-4 w-full sm:w-auto">
                  <div className="relative w-full sm:w-auto">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                      type="text"
                      placeholder="Search products..."
                      value={searchTerm}
                      onChange={(e) => handleSearchChange(e.target.value)}
                      className="pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:ring-[#1f8dbf] focus:border-[#1f8dbf] w-full"
                    />
                  </div>
                  <select
                    value={selectedProductType}
                    onChange={(e) => handleProductTypeChange(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-md focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                  >
                    <option value="">All Product Types</option>
                    {getProductTypes().map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                  {/* View Toggle */}
                  <div className="flex items-center border border-gray-300 rounded-md overflow-hidden">
                    <button
                      onClick={() => setViewMode('cards')}
                      className={`p-2 ${viewMode === 'cards' ? 'bg-[#1f8dbf] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                      title="Card View"
                    >
                      <Grid className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setViewMode('list')}
                      className={`p-2 ${viewMode === 'list' ? 'bg-[#1f8dbf] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                      title="List View"
                    >
                      <List className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                </div>
              </div>
                {/* Individual / Group sub-tabs */}
                <div className="flex border-b border-gray-200 -mb-px gap-1">
                  <button
                    type="button"
                    onClick={() => handleAudienceTabChange('individual')}
                    className={`flex items-center gap-3 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                      audienceTab === 'individual'
                        ? 'border-[var(--oe-primary)] text-gray-900'
                        : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                    }`}
                    style={audienceTab === 'individual' ? { borderBottomColor: 'var(--oe-primary)' } : undefined}
                  >
                    <User className={`h-5 w-5 ${audienceTab === 'individual' ? 'text-[var(--oe-primary)]' : 'text-gray-500'}`} style={audienceTab === 'individual' ? { color: 'var(--oe-primary)' } : undefined} />
                    Individual
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      audienceTab === 'individual' ? 'bg-[var(--oe-primary)]/10 text-[var(--oe-primary)]' : 'bg-gray-100 text-gray-600'
                    }`} style={audienceTab === 'individual' ? { backgroundColor: 'rgba(31, 141, 191, 0.1)', color: 'var(--oe-primary)' } : undefined}>
                      {individualCount}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAudienceTabChange('group')}
                    className={`flex items-center gap-3 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                      audienceTab === 'group'
                        ? 'border-[var(--oe-primary)] text-gray-900'
                        : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                    }`}
                    style={audienceTab === 'group' ? { borderBottomColor: 'var(--oe-primary)' } : undefined}
                  >
                    <Building className={`h-5 w-5 ${audienceTab === 'group' ? 'text-[var(--oe-primary)]' : 'text-gray-500'}`} style={audienceTab === 'group' ? { color: 'var(--oe-primary)' } : undefined} />
                    Group
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      audienceTab === 'group' ? 'bg-[var(--oe-primary)]/10 text-[var(--oe-primary)]' : 'bg-gray-100 text-gray-600'
                    }`} style={audienceTab === 'group' ? { backgroundColor: 'rgba(31, 141, 191, 0.1)', color: 'var(--oe-primary)' } : undefined}>
                      {groupCount}
                    </span>
                  </button>
                </div>
              </div>

            {/* Pagination Controls */}
            <div className="px-6 py-3 border-b border-gray-200 bg-gray-50">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <span className="text-sm text-gray-700">
                    Showing {totalItems === 0 ? 0 : startIndex + 1} to {Math.min(endIndex, totalItems)} of {totalItems} products
                  </span>
                  <div className="flex items-center space-x-2">
                    <span className="text-sm text-gray-700">Show:</span>
                    <select
                      value={itemsPerPage}
                      onChange={(e) => handleItemsPerPageChange(Number(e.target.value))}
                      className="px-2 py-1 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                    >
                      <option value={10}>10</option>
                      <option value={25}>25</option>
                      <option value={50}>50</option>
                    </select>
                  </div>
                </div>
                
                {totalPages > 1 && (
                  <div className="flex items-center space-x-2">
                    <button
                      type="button"
                      onClick={() => setShowQuickQuoteModal(true)}
                      className="inline-flex items-center rounded-lg bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      <Sparkles className="mr-1.5 h-4 w-4" />
                      Quick Quote
                    </button>
                    <button
                      onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                      disabled={currentPage === 1}
                      className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Previous
                    </button>
                    <span className="text-sm text-gray-700">
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                      disabled={currentPage === totalPages}
                      className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                )}
                {totalPages <= 1 && (
                  <div className="flex items-center space-x-2">
                    <button
                      type="button"
                      onClick={() => setShowQuickQuoteModal(true)}
                      className="inline-flex items-center rounded-lg bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      <Sparkles className="mr-1.5 h-4 w-4" />
                      Quick Quote
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="p-6">
              <SubscribedProductsTab
                products={paginatedProducts}
                loading={isLoading}
                viewMode={viewMode}
                audienceTab={audienceTab}
                onViewDetails={(product: SubscribedProduct) => {
                  setSelectedSubscription(product);
                  setShowDetailsModal(true);
                }}
              />
            </div>
          </div>
        </>
      )}

      {showDetailsModal && selectedSubscription && (
        <SubscribedProductDetailsModal
          key={selectedSubscription.subscriptionId || selectedSubscription.productId}
          product={selectedSubscription}
          onClose={() => {
            setShowDetailsModal(false);
            setSelectedSubscription(null);
          }}
        />
      )}
      {showQuickQuoteModal && (
        <QuickQuoteWizardModal
          isOpen={showQuickQuoteModal}
          onClose={() => setShowQuickQuoteModal(false)}
          products={subscribedProducts}
        />
      )}
    </div>
  );
};

// Subscribed Products Tab Component
interface SubscribedProductsTabProps {
  products: SubscribedProduct[];
  loading: boolean;
  viewMode: 'cards' | 'list';
  audienceTab: 'individual' | 'group';
  onViewDetails: (product: SubscribedProduct) => void;
}

const SubscribedProductsTab: React.FC<SubscribedProductsTabProps> = ({ products, loading, viewMode, audienceTab, onViewDetails }) => {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#1f8dbf]"></div>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="text-center py-12">
        <Package className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">
          {audienceTab === 'individual' ? 'No individual products available' : 'No group products available'}
        </h3>
        <p className="text-gray-600">
          Contact your tenant administrator to add products for this sales type
        </p>
      </div>
    );
  }

  const getStatusBadge = (product: SubscribedProduct) => {
    if (product.subscriptionStatus === 'Active') {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
          <CheckCircle className="h-3 w-3 mr-1" />
          Active
        </span>
      );
    } else if (product.subscriptionStatus === 'Pending') {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
          <Clock className="h-3 w-3 mr-1" />
          Pending
        </span>
      );
    }
    return null;
  };

  // Card View
  if (viewMode === 'cards') {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {products.map((product) => (
          <div 
            key={product.subscriptionId} 
            className={`bg-white rounded-lg shadow-sm border hover:shadow-md transition-shadow overflow-hidden flex flex-col h-full ${
              product.subscriptionStatus === 'Pending' ? 'border-yellow-300 bg-yellow-50' : 'border-gray-200'
            }`}
          >
            {/* Card Header with Logo */}
            <div className="bg-gradient-to-r from-[#1f8dbf]/10 to-[#1f8dbf]/5 p-4">
              <div className="flex items-start space-x-3">
                {(product.productImageUrl || product.productLogoUrl) ? (
                  <img 
                    src={product.productImageUrl || product.productLogoUrl} 
                    alt={product.productName}
                    className="h-14 w-24 rounded-lg object-contain bg-white p-1 flex-shrink-0"
                  />
                ) : (
                  <div className="h-14 w-14 bg-white rounded-lg flex items-center justify-center flex-shrink-0">
                    <Package className="h-7 w-7 text-[#1f8dbf]" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-gray-900 truncate">{product.productName}</h3>
                  <p className="text-sm text-gray-600">{product.productType}</p>
                </div>
              </div>
            </div>

            {/* Card Body */}
            <div className="p-4 flex-1 flex flex-col">
              <div className="flex items-center gap-2 mb-3">
                {getStatusBadge(product)}
                {product.isBundle && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                    <Package className="h-3 w-3 mr-1" />
                    Bundle
                  </span>
                )}
              </div>

              {product.description && (
                <p className="text-sm text-gray-700 line-clamp-2 mb-3">{product.description}</p>
              )}

              <div className="space-y-2 flex-1">
                {/* Price */}
                {product.salePrice !== undefined && product.salePrice > 0 && (
                  <div className="flex items-center space-x-2">
                    <DollarSign className="h-4 w-4 text-gray-400" />
                    <span className="text-sm font-medium text-gray-900">${product.salePrice.toFixed(2)}/month</span>
                  </div>
                )}
              </div>

              {product.subscriptionStatus === 'Pending' && SHOW_PENDING_PRODUCTS_TO_AGENTS && (
                <div className="mt-3 p-2 bg-yellow-100 border border-yellow-200 rounded-md">
                  <p className="text-xs text-yellow-800 flex items-center">
                    <Clock className="h-3.5 w-3.5 mr-1" />
                    Pending approval
                  </p>
                </div>
              )}

              {/* Card Footer */}
              <div className="mt-4 pt-3 border-t border-gray-100">
                <button
                  onClick={() => onViewDetails(product)}
                  className="w-full inline-flex items-center justify-center px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors"
                >
                  <Eye className="h-4 w-4 mr-2" />
                  View Details
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // List View (original)
  return (
    <div className="space-y-4">
      {products.map((product) => (
        <div key={product.subscriptionId} className={`bg-white border border-gray-200 rounded-lg p-6 hover:shadow-md transition-shadow ${product.subscriptionStatus === 'Pending' ? 'bg-yellow-50 border-yellow-200' : ''}`}>
          <div className="flex items-start justify-between">
            <div className="flex items-start space-x-4">
              {(product.productImageUrl || product.productLogoUrl) ? (
                <img 
                  src={product.productImageUrl || product.productLogoUrl} 
                  alt={product.productName}
                  className="h-16 w-16 rounded-lg object-contain bg-white p-1 flex-shrink-0"
                />
              ) : (
                <div className="h-16 w-16 bg-[#1f8dbf]/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Package className="h-8 w-8 text-[#1f8dbf]" />
                </div>
              )}
              <div className="flex-1">
                <div className="flex items-center space-x-3">
                  <h3 className="text-lg font-semibold text-gray-900">{product.productName}</h3>
                  {getStatusBadge(product)}
                </div>
                <p className="text-sm text-gray-600 mt-1">{product.productType}</p>
                {product.description && (
                  <p className="text-sm text-gray-700 mt-2">{product.description}</p>
                )}
                
                {/* Price - Only show if available and greater than 0 */}
                {product.salePrice !== undefined && product.salePrice > 0 && (
                  <div className="mt-3 flex items-start space-x-2">
                    <DollarSign className="h-4 w-4 text-gray-400 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-500">Price:</p>
                      <p className="text-sm text-gray-700">${product.salePrice.toFixed(2)}/month</p>
                    </div>
                  </div>
                )}

                {product.subscriptionStatus === 'Pending' && SHOW_PENDING_PRODUCTS_TO_AGENTS && (
                  <div className="mt-3 p-2 bg-yellow-100 border border-yellow-200 rounded-md">
                    <p className="text-xs text-yellow-800 flex items-center">
                      <Clock className="h-3.5 w-3.5 mr-1" />
                      This product is pending approval and not yet available for use
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <button
                onClick={() => onViewDetails(product)}
                className="p-2 text-[#1f8dbf] hover:text-[#175a7a]"
              >
                <Eye className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export type { BundleProduct, PricingTier, ProductOwner, SubscribedProduct, SystemFees } from '../../components/products/SubscribedProductDetailsModal';

export default AgentProducts;

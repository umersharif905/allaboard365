// frontend/src/pages/vendor/VendorProducts.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { Package, Layers, Search, DollarSign, Eye, FileText } from 'lucide-react';
import { apiService } from '../../services/api.service';
import VendorProductDetailsModal, { type VendorProductDetails } from './VendorProductDetailsModal';

type Product = VendorProductDetails;

type CategoryTab = 'products' | 'bundles';

const isBundle = (p: Product): boolean => p.IsBundle === true;

const formatCurrency = (n: number | undefined): string => {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
};

const statusBadge = (status?: string) => {
  const s = (status || '').toLowerCase();
  if (s === 'active') return 'bg-green-100 text-green-800';
  if (s === 'inactive' || s === 'archived') return 'bg-gray-200 text-gray-700';
  if (s === 'pending' || s === 'draft') return 'bg-yellow-100 text-yellow-800';
  return 'bg-gray-100 text-gray-700';
};

const VendorProducts: React.FC = () => {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('');
  const [selectedType, setSelectedType] = useState<string>('');
  const [categoryTab, setCategoryTab] = useState<CategoryTab>('products');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

  useEffect(() => {
    void loadProducts();
  }, []);

  const loadProducts = async () => {
    try {
      setLoading(true);
      const response = await apiService.get<{ success: boolean; data?: Product[] }>('/api/me/vendor/products');
      if (response?.success) {
        setProducts(response.data || []);
      }
    } catch (error) {
      console.error('Error loading products:', error);
    } finally {
      setLoading(false);
    }
  };

  const { productTypes, statuses } = useMemo(() => {
    const types = new Set<string>();
    const stats = new Set<string>();
    for (const p of products) {
      if (p.ProductType) types.add(p.ProductType);
      if (p.Status) stats.add(p.Status);
    }
    return {
      productTypes: Array.from(types).sort(),
      statuses: Array.from(stats).sort(),
    };
  }, [products]);

  const filtered = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return products.filter((p) => {
      const matchesCategory = categoryTab === 'bundles' ? isBundle(p) : !isBundle(p);
      if (!matchesCategory) return false;

      const name = (p.ProductName || p.Name || '').toLowerCase();
      const desc = (p.Description || '').toLowerCase();
      const matchesSearch = !term || name.includes(term) || desc.includes(term);
      if (!matchesSearch) return false;

      if (selectedStatus && p.Status !== selectedStatus) return false;
      if (selectedType && p.ProductType !== selectedType) return false;
      return true;
    });
  }, [products, categoryTab, searchTerm, selectedStatus, selectedType]);

  const productsCount = products.filter((p) => !isBundle(p)).length;
  const bundlesCount = products.filter(isBundle).length;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Products</h1>
        <p className="text-sm text-gray-600 mt-1">
          View product information, pricing, and documentation.
        </p>
      </div>

      <div className="bg-white rounded-lg border border-gray-200">
        {/* Tabs */}
        <div className="flex border-b border-gray-200 px-2 gap-1">
          <button
            type="button"
            onClick={() => setCategoryTab('products')}
            className={`flex items-center gap-3 px-6 py-4 text-base font-semibold border-b-2 transition-colors ${
              categoryTab === 'products'
                ? 'border-oe-primary text-gray-900'
                : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            <Package
              className={`h-5 w-5 ${categoryTab === 'products' ? 'text-oe-primary' : 'text-gray-500'}`}
            />
            Products
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-medium ${
                categoryTab === 'products' ? 'bg-oe-light text-oe-dark' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {productsCount}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setCategoryTab('bundles')}
            className={`flex items-center gap-3 px-6 py-4 text-base font-semibold border-b-2 transition-colors ${
              categoryTab === 'bundles'
                ? 'border-oe-primary text-gray-900'
                : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            <Layers
              className={`h-5 w-5 ${categoryTab === 'bundles' ? 'text-oe-primary' : 'text-gray-500'}`}
            />
            Bundles
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-medium ${
                categoryTab === 'bundles' ? 'bg-oe-light text-oe-dark' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {bundlesCount}
            </span>
          </button>
        </div>

        {/* Filters */}
        <div className="p-6 border-b border-gray-200 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={categoryTab === 'bundles' ? 'Search bundles...' : 'Search products...'}
              className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent"
            />
          </div>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-oe-primary"
          >
            <option value="">All types</option>
            {productTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-oe-primary"
          >
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        {/* Content */}
        <div className="p-6">
          {loading ? (
            <div className="text-center py-12 text-gray-500 text-sm">Loading...</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12">
              {categoryTab === 'bundles' ? (
                <Layers className="h-10 w-10 text-gray-300 mx-auto mb-3" />
              ) : (
                <Package className="h-10 w-10 text-gray-300 mx-auto mb-3" />
              )}
              <h3 className="text-base font-medium text-gray-900 mb-1">
                No {categoryTab === 'bundles' ? 'bundles' : 'products'} found
              </h3>
              <p className="text-sm text-gray-500">
                {searchTerm || selectedStatus || selectedType
                  ? 'Try adjusting your filters.'
                  : categoryTab === 'bundles'
                  ? 'There are no bundles to display.'
                  : 'There are no products to display.'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filtered.map((product) => {
                const name = product.ProductName || product.Name || 'Untitled';
                const logo = product.ProductLogoUrl || product.ProductImageUrl;
                const Icon = product.IsBundle ? Layers : Package;
                const hasDoc =
                  (product.productDocuments && product.productDocuments.length > 0) ||
                  !!product.ProductDocumentUrl;
                return (
                  <div
                    key={product.ProductId}
                    className="bg-white rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow overflow-hidden flex flex-col h-full"
                  >
                    {/* Card header */}
                    <div className="bg-gradient-to-r from-oe-primary/10 to-oe-primary/5 p-4">
                      <div className="flex items-start gap-3">
                        {logo ? (
                          <img
                            src={logo}
                            alt={name}
                            className="h-14 w-24 rounded-lg object-contain bg-white p-1 flex-shrink-0"
                          />
                        ) : (
                          <div className="h-14 w-24 bg-white rounded-lg flex items-center justify-center flex-shrink-0">
                            <Icon className="h-7 w-7 text-oe-primary" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <h3 className="text-base font-semibold text-gray-900 truncate">{name}</h3>
                          {product.ProductType && (
                            <p className="text-sm text-gray-600 truncate">{product.ProductType}</p>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Card body */}
                    <div className="p-4 flex-1 flex flex-col">
                      <div className="flex flex-wrap items-center gap-2 mb-3">
                        {product.Status && (
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusBadge(product.Status)}`}
                          >
                            {product.Status}
                          </span>
                        )}
                        {product.IsBundle && (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-oe-light text-oe-dark">
                            <Layers className="h-3 w-3 mr-1" />
                            Bundle
                          </span>
                        )}
                      </div>

                      {product.Description && (
                        <p className="text-sm text-gray-700 line-clamp-2 mb-3">{product.Description}</p>
                      )}

                      <div className="space-y-2 flex-1">
                        {product.Price !== undefined && product.Price > 0 && (
                          <div className="flex items-center gap-2">
                            <DollarSign className="h-4 w-4 text-gray-400" />
                            <span className="text-sm font-medium text-gray-900">
                              {formatCurrency(product.Price)}
                              <span className="text-gray-500 font-normal">/mo MSRP</span>
                            </span>
                          </div>
                        )}
                        {hasDoc && (
                          <div className="flex items-center gap-2 text-xs text-gray-500">
                            <FileText className="h-3.5 w-3.5" />
                            Documentation available
                          </div>
                        )}
                      </div>

                      {/* Footer */}
                      <div className="mt-4 pt-3 border-t border-gray-100">
                        <button
                          type="button"
                          onClick={() => setSelectedProduct(product)}
                          className="w-full inline-flex items-center justify-center px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors"
                        >
                          <Eye className="h-4 w-4 mr-2" />
                          View Details
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {selectedProduct && (
        <VendorProductDetailsModal
          product={selectedProduct}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </div>
  );
};

export default VendorProducts;

// src/components/commissions/CommissionRuleEditForm.tsx
import React, { useState, useEffect } from 'react';
import { X, Save, Loader2, Lock } from 'lucide-react';
import { commissionRuleService, CommissionRule, CreateRuleDTO } from '../../services/commissionRules.service';
import { apiService } from '../../services/api.service';
import { format } from 'date-fns';

interface CommissionRuleEditFormProps {
  rule: CommissionRule;
  onClose: () => void;
  onSave: () => void;
}

interface ProductOption {
  ProductId: string;
  Name: string;
  VendorName: string;
}

const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';

function isRuleLocked(rule: CommissionRule): boolean {
  return rule.Locked === true || rule.Locked === 1;
}

export const CommissionRuleEditForm: React.FC<CommissionRuleEditFormProps> = ({
  rule,
  onClose,
  onSave,
}) => {
  const ruleIsLocked = isRuleLocked(rule);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [productsLoading, setProductsLoading] = useState(true);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [onlyShowWithoutRules, setOnlyShowWithoutRules] = useState(false);
  const [productRuleCounts, setProductRuleCounts] = useState<Record<string, number>>({});
  const [formData, setFormData] = useState({
    ruleName: rule.RuleName || '',
    productId: rule.ProductId || '',
    commissionType: rule.CommissionType || 'Percentage',
    commissionRate: rule.CommissionRate ? (rule.CommissionRate * 100).toFixed(2) : '',
    flatAmount: rule.FlatAmount?.toFixed(2) || '',
    effectiveDate: rule.EffectiveDate ? format(new Date(rule.EffectiveDate), 'yyyy-MM-dd') : '',
    terminationDate: rule.TerminationDate ? format(new Date(rule.TerminationDate), 'yyyy-MM-dd') : '',
    priority: rule.Priority?.toString() || '100',
    status: rule.Status || 'Active',
  });

  useEffect(() => {
    const fetchProducts = async () => {
      try {
        setProductsLoading(true);
        const storedRoles = localStorage.getItem('roles');
        const roles = storedRoles ? JSON.parse(storedRoles) : [];
        const currentRole = localStorage.getItem('currentRole') || roles[0] || undefined;
        const currentTenantId = localStorage.getItem('currentTenantId') || localStorage.getItem('tenantId') || null;
        const isSysAdmin = roles.includes('SysAdmin');

        const [productsResponse, rules] = await Promise.all([
          apiService.get('/api/products'),
          commissionRuleService.getRules({}, currentRole)
        ]);

        const list = Array.isArray((productsResponse as any)?.products)
          ? (productsResponse as any).products
          : Array.isArray(productsResponse)
            ? productsResponse
            : [];

        const nextProductRuleCounts: Record<string, number> = {};
        (rules || []).forEach((r) => {
          // Keep rule counts tenant-scoped (SysAdmin may receive cross-tenant rules).
          if (isSysAdmin && currentTenantId && r?.TenantId && r.TenantId !== currentTenantId) return;
          const productId = r?.ProductId;
          if (!productId || productId === ALL_PRODUCTS_GUID) return;
          nextProductRuleCounts[productId] = (nextProductRuleCounts[productId] || 0) + 1;
        });
        setProductRuleCounts(nextProductRuleCounts);

        const mapped = list
          .filter((p: any) => p?.ProductId && p?.Name)
          .map((p: any) => ({
            ProductId: p.ProductId,
            Name: p.Name,
            VendorName: p.VendorName || p.ProductOwnerName || 'Unknown Vendor'
          }))
          .sort((a: ProductOption, b: ProductOption) => {
            const vendorCompare = a.VendorName.localeCompare(b.VendorName);
            if (vendorCompare !== 0) return vendorCompare;
            return a.Name.localeCompare(b.Name);
          });

        // Keep current product selectable even if not in fetched list.
        if (rule.ProductId && !mapped.some(p => p.ProductId === rule.ProductId)) {
          mapped.unshift({
            ProductId: rule.ProductId,
            Name: rule.ProductName || 'Current Product',
            VendorName: 'Unknown Vendor'
          });
        }

        setProducts(mapped);
      } catch (err) {
        console.error('Error fetching products for edit form:', err);
        setProducts([]);
        setProductRuleCounts({});
      } finally {
        setProductsLoading(false);
      }
    };

    fetchProducts();
  }, [rule.ProductId, rule.ProductName]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // Validate required fields
      if (!formData.ruleName || !formData.effectiveDate || !formData.productId) {
        setError('Rule name, product, and effective date are required');
        setLoading(false);
        return;
      }

      if (formData.commissionType === 'Percentage' && (formData.commissionRate === '' || formData.commissionRate === null || formData.commissionRate === undefined)) {
        setError('Commission rate is required for percentage type');
        setLoading(false);
        return;
      }

      if (formData.commissionType === 'Flat' && (formData.flatAmount === '' || formData.flatAmount === null || formData.flatAmount === undefined)) {
        setError('Flat amount is required for flat type');
        setLoading(false);
        return;
      }

      // Prepare update data
      const updates: Partial<CreateRuleDTO> = {
        ruleName: formData.ruleName,
        productId: formData.productId,
        productName: products.find(p => p.ProductId === formData.productId)?.Name || rule.ProductName || '',
        commissionType: formData.commissionType as 'Percentage' | 'Flat' | 'Tiered',
        effectiveDate: new Date(formData.effectiveDate).toISOString(),
        priority: parseInt(formData.priority) || 100,
        status: formData.status as 'Active' | 'Inactive' | 'Pending',
      };

      if (formData.commissionType === 'Percentage') {
        updates.rate = parseFloat(formData.commissionRate) / 100;
      } else if (formData.commissionType === 'Flat') {
        updates.amount = parseFloat(formData.flatAmount);
      }

      if (formData.terminationDate) {
        updates.terminationDate = new Date(formData.terminationDate).toISOString();
      } else {
        updates.terminationDate = null;
      }

      // Update the rule
      await commissionRuleService.updateRule(rule.RuleId, updates);
      
      onSave();
      onClose();
    } catch (err: any) {
      console.error('Error updating rule:', err);
      setError(err.message || 'Failed to update commission rule');
    } finally {
      setLoading(false);
    }
  };

  const filteredProducts = products.filter((p) => {
    const q = productSearch.trim().toLowerCase();
    const matchesSearch = !q || (
      p.Name.toLowerCase().includes(q) ||
      p.VendorName.toLowerCase().includes(q)
    );
    if (!matchesSearch) return false;

    if (!onlyShowWithoutRules) return true;
    if (formData.productId === p.ProductId) return true; // Keep selected product visible.
    if (p.ProductId === ALL_PRODUCTS_GUID) return false;
    return (productRuleCounts[p.ProductId] || 0) === 0;
  });

  const groupedProducts = filteredProducts.reduce<Record<string, ProductOption[]>>((acc, product) => {
    const key = product.VendorName || 'Unknown Vendor';
    if (!acc[key]) acc[key] = [];
    acc[key].push(product);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-semibold text-gray-900">Edit Commission Rule</h2>
          <button
            onClick={onClose}
            disabled={loading}
            className="text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg">
              {error}
            </div>
          )}

          {ruleIsLocked && (
            <div className="bg-yellow-50 border border-yellow-200 text-yellow-900 px-4 py-3 rounded-lg flex gap-2 text-sm">
              <Lock className="h-5 w-5 shrink-0 text-yellow-700" aria-hidden />
              <p>
                This rule is <span className="font-medium">locked</span> (active). All fields below stay editable; save applies your changes.
              </p>
            </div>
          )}

          {/* Rule Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Rule Name *
            </label>
            <input
              type="text"
              value={formData.ruleName}
              onChange={(e) => setFormData({ ...formData, ruleName: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              required
              disabled={loading}
            />
          </div>

          {/* Product */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Product *
            </label>
            <input
              type="text"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              placeholder={productsLoading ? 'Loading products...' : 'Search by product or vendor'}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary mb-2"
              disabled={loading || productsLoading}
            />
            <label className="flex items-center gap-2 text-sm text-gray-700 mb-2">
              <input
                type="checkbox"
                checked={onlyShowWithoutRules}
                onChange={(e) => setOnlyShowWithoutRules(e.target.checked)}
                disabled={loading || productsLoading}
                className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
              />
              Only show products without commission rules
            </label>
            <div className="max-h-64 overflow-y-auto border border-gray-300 rounded-lg divide-y divide-gray-100">
              {productsLoading ? (
                <div className="p-3 text-sm text-gray-500">Loading products...</div>
              ) : filteredProducts.length === 0 ? (
                <div className="p-3 text-sm text-gray-500">No products found.</div>
              ) : (
                Object.entries(groupedProducts).map(([vendorName, vendorProducts]) => (
                  <div key={vendorName}>
                    <div className="px-3 py-1.5 bg-gray-50 text-xs font-semibold text-gray-600 uppercase tracking-wide">
                      {vendorName}
                    </div>
                    {vendorProducts.map((product) => {
                      const selected = formData.productId === product.ProductId;
                      const isAllProducts = product.ProductId === ALL_PRODUCTS_GUID;
                      const existingRuleCount = productRuleCounts[product.ProductId] || 0;
                      return (
                        <button
                          key={product.ProductId}
                          type="button"
                          onClick={() => setFormData({ ...formData, productId: product.ProductId })}
                          disabled={loading}
                          className={`w-full text-left px-3 py-2 transition-colors ${
                            selected
                              ? 'bg-blue-50 border-l-4 border-blue-500'
                              : 'hover:bg-gray-50'
                          }`}
                        >
                          <div className="text-sm font-medium text-gray-900">{product.Name}</div>
                          <div className="text-xs text-gray-500">{product.VendorName}</div>
                          {!isAllProducts && (
                            <div className={`text-xs mt-1 ${existingRuleCount === 0 ? 'text-red-600 font-medium' : 'text-gray-600'}`}>
                              {existingRuleCount === 0
                                ? 'Has no commission rules'
                                : `Has ${existingRuleCount} existing commission rule${existingRuleCount === 1 ? '' : 's'}`}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Commission Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Commission Type *
            </label>
            <select
              value={formData.commissionType}
              onChange={(e) => setFormData({ ...formData, commissionType: e.target.value as "Percentage" | "Flat" | "Tiered" })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              required
              disabled={loading}
            >
              <option value="Percentage">Percentage</option>
              <option value="Flat">Flat</option>
              <option value="Tiered">Tiered</option>
            </select>
          </div>

          {/* Commission Rate or Amount */}
          {formData.commissionType === 'Percentage' ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Commission Rate (%) *
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                max="100"
                value={formData.commissionRate}
                onChange={(e) => setFormData({ ...formData, commissionRate: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                required
                disabled={loading}
              />
            </div>
          ) : formData.commissionType === 'Flat' ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Flat Amount ($) *
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={formData.flatAmount}
                onChange={(e) => setFormData({ ...formData, flatAmount: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                required
                disabled={loading}
              />
            </div>
          ) : (
            <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded-lg">
              Tiered commission editing is not yet supported in this form. Please use the full wizard for tiered rules.
            </div>
          )}

          {/* Dates */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Effective Date *
              </label>
              <input
                type="date"
                value={formData.effectiveDate}
                onChange={(e) => setFormData({ ...formData, effectiveDate: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                required
                disabled={loading}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Termination Date
              </label>
              <input
                type="date"
                value={formData.terminationDate}
                onChange={(e) => setFormData({ ...formData, terminationDate: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                disabled={loading}
              />
            </div>
          </div>

          {/* Priority and Status */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Priority
              </label>
              <input
                type="number"
                value={formData.priority}
                onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                disabled={loading}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Status
              </label>
              <select
                value={formData.status}
                onChange={(e) => setFormData({ ...formData, status: e.target.value as "Pending" | "Active" | "Inactive" | "Deleted" })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                disabled={loading}
              >
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
                <option value="Pending">Pending</option>
              </select>
            </div>
          </div>

          {/* Read-only fields */}
          <div className="bg-gray-50 p-4 rounded-lg space-y-2">
            <div className="text-sm text-gray-600">
              <strong>Original Product:</strong> {rule.ProductName || 'N/A'}
            </div>
            <div className="text-sm text-gray-600">
              <strong>Entity Type:</strong> {rule.EntityType}
            </div>
            {rule.TierLevel !== undefined && (
              <div className="text-sm text-gray-600">
                <strong>Tier Level:</strong> {rule.TierLevel}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  Save Changes
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};


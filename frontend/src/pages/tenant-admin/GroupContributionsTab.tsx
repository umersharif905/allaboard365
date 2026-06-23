import {
    Alert,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    Snackbar
} from '@mui/material';
import {
    Briefcase,
    Building2,
    Calendar,
    Clock,
    DollarSign,
    Edit,
    Filter,
    Info,
    Percent,
    Plus,
    Save,
    Settings,
    Shield,
    ShieldCheck,
    Trash2,
    Users,
    X,
    Zap
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/apiServices';

// Types matching the backend structure
interface ContributionRule {
  contributionId: string;
  groupId: string;
  productId?: string;
  productName?: string;
  name: string;
  description?: string;
  contributionType: 'flat_rate' | 'percentage' | 'tier_based' | 'role_based' | 'tenure_based' | 'division_based' | 'override' | 'minimum_threshold';
  
  // Basic amounts
  flatRateAmount?: number;
  percentageAmount?: number;
  
  // Tier-based contributions
  tierContributions?: {
    employee_only?: number;
    employee_spouse?: number;
    employee_children?: number;
    family?: number;
  };
  
  // Role-based contributions
  roleContributions?: Array<{
    role: string;
    contributionAmount: number;
    contributionType: 'flat' | 'percentage';
  }>;
  
  // Tenure-based contributions
  tenureRules?: Array<{
    minYears: number;
    maxYears?: number;
    contributionAmount: number;
    contributionType: 'flat' | 'percentage';
  }>;
  
  // Division-based contributions
  divisionRules?: Array<{
    division: string;
    contributionAmount: number;
    contributionType: 'flat' | 'percentage';
  }>;
  
  // Override settings
  overrideType?: 'full_premium' | 'fixed_amount' | 'percentage_override';
  overrideAmount?: number;
  
  // Minimum threshold
  minimumAmount?: number;
  
  // Rule settings
  priority: number;
  stacking: boolean;
  appliesTo?: {
    employmentClass?: string[];
    coverageTier?: string[];
    planType?: string[];
  };
  
  effectiveDate: string;
  endDate?: string;
  status: 'Active' | 'Inactive' | 'Pending';
  createdDate: string;
}

interface Product {
  ProductId: string;
  Name: string;
  ProductType: string;
}

interface GroupContributionsTabProps {
  groupId: string;
  groupName: string;
}

// Snackbar state interface
interface SnackbarState {
  open: boolean;
  message: string;
  severity: 'success' | 'error' | 'warning' | 'info';
}

// Contribution Modal Component
interface ContributionModalProps {
  isOpen: boolean;
  onClose: () => void;
  groupId: string;
  products: Product[];
  contribution?: ContributionRule | null;
  onSave: () => void;
  showSnackbar: (message: string, severity: 'success' | 'error' | 'warning' | 'info') => void;
}

const ContributionModal: React.FC<ContributionModalProps> = ({
  isOpen,
  onClose,
  groupId,
  products,
  contribution,
  onSave,
  showSnackbar
}) => {
  // Helper functions
  const getFirstOfCurrentMonth = () => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  };

  const getFirstOfMonth = (dateString: string) => {
    if (!dateString) return getFirstOfCurrentMonth();
    const date = new Date(dateString);
    return new Date(date.getFullYear(), date.getMonth(), 1).toISOString().split('T')[0];
  };

  const generateUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  };

  const [formData, setFormData] = useState<Partial<ContributionRule>>({
    contributionType: 'flat_rate',
    effectiveDate: getFirstOfCurrentMonth(),
    status: 'Active',
    priority: 1,
    stacking: true,
    name: '',
    description: '',
    tierContributions: undefined
  });

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (contribution) {
      setFormData(contribution);
    } else {
      setFormData({
        contributionType: 'flat_rate',
        effectiveDate: getFirstOfCurrentMonth(),
        status: 'Active',
        priority: 1,
        stacking: true,
        name: '',
        description: '',
        tierContributions: undefined
      });
    }
  }, [contribution, isOpen]);

  const handleSave = async () => {
    if (!formData.name || !formData.contributionType) {
      showSnackbar('Please fill in all required fields', 'warning');
      return;
    }

    setSaving(true);

    try {
      const token = localStorage.getItem('accessToken') || localStorage.getItem('token');
      const isEdit = !!contribution;
      
      const url = isEdit 
        ? `/api/groups/${groupId}/contributions/${contribution.contributionId}`
        : `/api/groups/${groupId}/contributions`;
      
      const result = isEdit
        ? await apiService.put<{ success: boolean; message?: string }>(url, {
            ...formData,
            groupId: groupId // Ensure groupId is included
          })
        : await apiService.post<{ success: boolean; message?: string }>(url, {
            ...formData,
            groupId: groupId // Ensure groupId is included
          });
      
      if (result.success) {
        showSnackbar(`Contribution rule ${isEdit ? 'updated' : 'added'} successfully`, 'success');
        onSave();
        onClose();
      } else {
        showSnackbar(`Failed to ${isEdit ? 'update' : 'add'} contribution rule: ${result.message}`, 'error');
      }
    } catch (error: any) {
      const isEdit = !!contribution;
      if (error?.response?.status === 404) {
        showSnackbar(`The ${isEdit ? 'update' : 'add'} contribution endpoint is not implemented yet`, 'info');
        console.log('Contribution endpoint not implemented (404)');
      } else {
        console.error('Error saving contribution rule:', error);
        showSnackbar('Error saving contribution rule', 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const contributionType = formData.contributionType;

  // Icon mapping for contribution types
  const contributionTypeIcons = {
    flat_rate: <DollarSign className="h-4 w-4" />,
    percentage: <Percent className="h-4 w-4" />,
    tier_based: <Users className="h-4 w-4" />,
    role_based: <Briefcase className="h-4 w-4" />,
    tenure_based: <Clock className="h-4 w-4" />,
    division_based: <Building2 className="h-4 w-4" />,
    override: <Zap className="h-4 w-4" />,
    minimum_threshold: <ShieldCheck className="h-4 w-4" />
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h3 className="text-xl font-semibold text-gray-900 flex items-center space-x-2">
            {contribution ? <Edit className="h-6 w-6 text-oe-success" /> : <Plus className="h-6 w-6 text-oe-primary" />}
            <span>{contribution ? 'Edit' : 'Add'} Contribution Rule</span>
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-6">
            {/* Basic Information */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Rule Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.name || ''}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="e.g., Base Medical Contribution"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
                <input
                  type="number"
                  min="0"
                  value={formData.priority || 1}
                  onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                />
                <p className="text-xs text-gray-500 mt-1">Lower numbers = higher priority</p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={formData.description || ''}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                rows={2}
                placeholder="Optional description of this rule..."
              />
            </div>

            {/* Product Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Apply to Product (Optional)
              </label>
              <select
                value={formData.productId || ''}
                onChange={(e) => setFormData({ 
                  ...formData,
                  productId: e.target.value || undefined,
                  productName: e.target.value && products ? products.find(p => p.ProductId === e.target.value)?.Name : undefined
                })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value="">All Products</option>
                {products && products.map((product) => (
                  <option key={product.ProductId} value={product.ProductId}>
                    {product.Name} ({product.ProductType})
                  </option>
                ))}
              </select>
            </div>

            {/* Contribution Type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Contribution Type <span className="text-red-500">*</span>
              </label>
              <select
                value={contributionType}
                onChange={(e) => {
                  const newType = e.target.value as ContributionRule['contributionType'];
                  const updates: Partial<ContributionRule> = { 
                    contributionType: newType 
                  };
                  
                  // Initialize default values based on type
                  if (newType === 'tier_based' && !formData.tierContributions) {
                    updates.tierContributions = {
                      employee_only: 0,
                      employee_spouse: 0,
                      employee_children: 0,
                      family: 0
                    };
                  }
                  
                  setFormData({ ...formData, ...updates });
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value="flat_rate">💵 Flat Rate</option>
                <option value="percentage">📊 Percentage</option>
                <option value="tier_based">👥 Tier Based (EE/ES/EC/Family)</option>
                <option value="role_based">💼 Role Based</option>
                <option value="tenure_based">⏰ Tenure Based</option>
                <option value="division_based">🏢 Division Based</option>
                <option value="override">🚀 Override (Full Coverage)</option>
                <option value="minimum_threshold">🛡️ Minimum Threshold</option>
              </select>
            </div>

            {/* Dynamic Form Fields Based on Type */}
            {contributionType === 'flat_rate' && (
              <div className="bg-oe-light/30 p-4 rounded-lg">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Monthly Contribution Amount ($) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.flatRateAmount || ''}
                  onChange={(e) => setFormData({ ...formData, flatRateAmount: parseFloat(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="400.00"
                />
                <p className="text-xs text-gray-600 mt-2 flex items-center">
                  <Info className="h-3 w-3 mr-1" />
                  Fixed dollar amount the employer contributes per employee per month
                </p>
              </div>
            )}

            {contributionType === 'percentage' && (
              <div className="bg-green-50 p-4 rounded-lg">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Contribution Percentage (%) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={formData.percentageAmount || ''}
                  onChange={(e) => setFormData({ ...formData, percentageAmount: parseFloat(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="80"
                />
                <p className="text-xs text-gray-600 mt-2 flex items-center">
                  <Info className="h-3 w-3 mr-1" />
                  Percentage of premium the employer pays (e.g., 80% = employer pays 80%, employee pays 20%)
                </p>
              </div>
            )}

            {contributionType === 'tier_based' && (
              <div className="bg-purple-50 p-4 rounded-lg">
                <label className="block text-sm font-medium text-gray-700 mb-3">
                  Contribution by Coverage Tier ($) <span className="text-red-500">*</span>
                </label>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">👤 Employee Only</label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.tierContributions?.employee_only || ''}
                      onChange={(e) => setFormData({ 
                        ...formData,
                        tierContributions: { 
                          ...formData.tierContributions || {}, 
                          employee_only: parseFloat(e.target.value) || 0 
                        }
                      })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="500.00"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">👥 Employee + Spouse</label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.tierContributions?.employee_spouse || ''}
                      onChange={(e) => setFormData({ 
                        ...formData,
                        tierContributions: { 
                          ...formData.tierContributions || {}, 
                          employee_spouse: parseFloat(e.target.value) || 0 
                        }
                      })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="800.00"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">👨‍👩‍👧 Employee + Children</label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.tierContributions?.employee_children || ''}
                      onChange={(e) => setFormData({ 
                        ...formData,
                        tierContributions: { 
                          ...formData.tierContributions || {}, 
                          employee_children: parseFloat(e.target.value) || 0 
                        }
                      })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="750.00"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">👨‍👩‍👧‍👦 Family</label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.tierContributions?.family || ''}
                      onChange={(e) => setFormData({ 
                        ...formData,
                        tierContributions: { 
                          ...formData.tierContributions || {}, 
                          family: parseFloat(e.target.value) || 0 
                        }
                      })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="1000.00"
                    />
                  </div>
                </div>
              </div>
            )}

            {contributionType === 'minimum_threshold' && (
              <div className="bg-indigo-50 p-4 rounded-lg">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Minimum Contribution Amount ($) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.minimumAmount || ''}
                  onChange={(e) => setFormData({ ...formData, minimumAmount: parseFloat(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="350.00"
                />
                <p className="text-xs text-gray-600 mt-2 flex items-center">
                  <Shield className="h-3 w-3 mr-1" />
                  Ensures employer contribution never falls below this amount
                </p>
              </div>
            )}

            {/* Rule Settings */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Effective Date <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={formData.effectiveDate}
                  onChange={(e) => setFormData({ ...formData, effectiveDate: getFirstOfMonth(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                />
                <p className="text-xs text-oe-primary mt-1">📅 Auto-set to first of month</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">End Date (Optional)</label>
                <input
                  type="date"
                  value={formData.endDate || ''}
                  onChange={(e) => setFormData({ ...formData, endDate: e.target.value ? getFirstOfMonth(e.target.value) : undefined })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value as any })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                  <option value="Pending">Pending</option>
                </select>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={formData.stacking}
                  onChange={(e) => setFormData({ ...formData, stacking: e.target.checked })}
                  className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                />
                <span className="text-sm text-gray-700">Allow Stacking</span>
              </label>
              <p className="text-xs text-gray-500">
                When enabled, this rule can be combined with other rules
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end space-x-3 p-6 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-oe-primary border border-transparent rounded-md hover:bg-oe-dark flex items-center space-x-2 disabled:opacity-50"
          >
            {saving ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                <span>Saving...</span>
              </>
            ) : (
              <>
                <Save className="h-4 w-4" />
                <span>{contribution ? 'Update' : 'Add'} Rule</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

// Main Tab Component
const GroupContributionsTab: React.FC<GroupContributionsTabProps> = ({ groupId, groupName }) => {
  const [contributionRules, setContributionRules] = useState<ContributionRule[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [editingContribution, setEditingContribution] = useState<ContributionRule | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterProduct, setFilterProduct] = useState<string>('all');
  
  // Snackbar state
  const [snackbar, setSnackbar] = useState<SnackbarState>({
    open: false,
    message: '',
    severity: 'info'
  });

  // Delete confirmation dialog state
  const [deleteDialog, setDeleteDialog] = useState({
    open: false,
    contributionId: '',
    contributionName: ''
  });

  // Snackbar handler
  const showSnackbar = (message: string, severity: 'success' | 'error' | 'warning' | 'info' = 'info') => {
    setSnackbar({ open: true, message, severity });
  };

  const handleCloseSnackbar = () => {
    setSnackbar({ ...snackbar, open: false });
  };

  // Fetch contribution rules
  const fetchContributionRules = async () => {
    try {
      console.log('Fetching contribution rules for group:', groupId);
      const result = await apiService.get<{ success: boolean; data?: any; contributions?: any }>(`/api/groups/${groupId}/contributions`);
      console.log('Contribution API response:', result); // Debug log
      
      if (result.success) {
        // Handle different possible response structures
        let rulesData = [];
        if (Array.isArray(result.data)) {
          rulesData = result.data;
        } else if (Array.isArray(result.contributions)) {
          rulesData = result.contributions;
        } else if (result.data && Array.isArray((result.data as any).rules)) {
          rulesData = (result.data as any).rules;
        } else if (result.data && Array.isArray(result.data.contributionRules)) {
          rulesData = result.data.contributionRules;
        }
        
        console.log('Rules data to map:', rulesData);
        
        // Map backend PascalCase to frontend camelCase
        const mappedRules = rulesData.map((rule: any) => ({
          contributionId: rule.ContributionId,
          groupId: rule.GroupId,
          productId: rule.ProductId,
          productName: rule.ProductName,
          name: rule.Name,
          description: rule.Description,
          contributionType: rule.ContributionType,
          flatRateAmount: rule.FlatRateAmount,
          percentageAmount: rule.PercentageAmount,
          tierContributions: rule.tierContributions,
          roleContributions: rule.roleContributions,
          tenureRules: rule.tenureRules,
          divisionRules: rule.divisionRules,
          overrideType: rule.OverrideType,
          overrideAmount: rule.OverrideAmount,
          minimumAmount: rule.MinimumAmount,
          priority: rule.Priority,
          stacking: rule.Stacking,
          appliesTo: rule.appliesTo,
          effectiveDate: rule.EffectiveDate ? new Date(rule.EffectiveDate).toISOString().split('T')[0] : '',
          endDate: rule.EndDate ? new Date(rule.EndDate).toISOString().split('T')[0] : undefined,
          status: rule.Status,
          createdDate: rule.CreatedDate
        }));

        setContributionRules(mappedRules);
      } else {
        // If no data or success is false, set empty array
        setContributionRules([]);
        console.log('No contribution rules found or request failed');
      }
    } catch (error: any) {
      if (error?.response?.status === 404) {
        console.log('Contribution rules endpoint not implemented yet (404)');
        showSnackbar('Contribution rules endpoint not implemented yet', 'info');
        setContributionRules([]);
      } else {
        console.error('Error fetching contribution rules:', error);
        showSnackbar('Error fetching contribution rules', 'error');
        setContributionRules([]);
      }
    } finally {
      setLoading(false);
    }
  };

  // Fetch products
  const fetchProducts = async () => {
    try {
      const result = await apiService.get<{ success: boolean; data?: any; products?: any }>(`/api/groups/${groupId}/products`);
      console.log('Products API response:', result); // Debug log
      
      if (result.success) {
        // Handle different possible response structures
        let productsData = [];
        if (Array.isArray(result.data)) {
          productsData = result.data;
        } else if (Array.isArray(result.products)) {
          productsData = result.products;
        } else if (result.data && Array.isArray(result.data.groupProducts)) {
          // Use groupProducts - these are products assigned to this group
          productsData = result.data.groupProducts;
        } else if (result.data && Array.isArray(result.data.assignedProducts)) {
          productsData = result.data.assignedProducts;
        }
        
        setProducts(productsData);
      } else {
        setProducts([]);
        console.log('No products found or request failed');
      }
    } catch (error: any) {
      if (error?.response?.status === 404) {
        console.log('Products endpoint not implemented yet (404)');
        setProducts([]);
      } else {
        console.error('Error fetching products:', error);
        setProducts([]);
      }
    }
  };

  useEffect(() => {
    fetchContributionRules();
    fetchProducts();
  }, [groupId]);

  const handleAdd = () => {
    setEditingContribution(null);
    setModalOpen(true);
  };

  const handleEdit = (contribution: ContributionRule) => {
    setEditingContribution(contribution);
    setModalOpen(true);
  };

  const handleDeleteClick = (contribution: ContributionRule) => {
    setDeleteDialog({
      open: true,
      contributionId: contribution.contributionId,
      contributionName: contribution.name
    });
  };

  const handleDeleteConfirm = async () => {
    const { contributionId } = deleteDialog;

    try {
      const result = await apiService.delete<{ success: boolean; message?: string }>(`/api/groups/${groupId}/contributions/${contributionId}`);
      if (result.success) {
        showSnackbar('Contribution rule deleted successfully', 'success');
        fetchContributionRules();
      } else {
        showSnackbar('Failed to delete contribution rule: ' + result.message, 'error');
      }
    } catch (error: any) {
      if (error?.response?.status === 404) {
        showSnackbar('The delete contribution endpoint is not implemented yet', 'info');
        console.log('Delete contribution endpoint not implemented (404)');
      } else {
        console.error('Error deleting contribution rule:', error);
        showSnackbar('Error deleting contribution rule', 'error');
      }
    } finally {
      setDeleteDialog({ open: false, contributionId: '', contributionName: '' });
    }
  };

  const handleModalSave = () => {
    fetchContributionRules();
  };

  // Filter rules
  const filteredRules = contributionRules ? contributionRules.filter(rule => {
    if (filterStatus !== 'all' && rule.status !== filterStatus) return false;
    if (filterProduct !== 'all' && rule.productId !== filterProduct) return false;
    return true;
  }) : [];

  // Get contribution type icon
  const getContributionTypeIcon = (type: string) => {
    switch (type) {
      case 'flat_rate': return <DollarSign className="h-4 w-4" />;
      case 'percentage': return <Percent className="h-4 w-4" />;
      case 'tier_based': return <Users className="h-4 w-4" />;
      case 'role_based': return <Briefcase className="h-4 w-4" />;
      case 'tenure_based': return <Clock className="h-4 w-4" />;
      case 'division_based': return <Building2 className="h-4 w-4" />;
      case 'override': return <Zap className="h-4 w-4" />;
      case 'minimum_threshold': return <ShieldCheck className="h-4 w-4" />;
      default: return <Settings className="h-4 w-4" />;
    }
  };

  // Format contribution type
  const formatContributionType = (type: string) => {
    return type.replace(/_/g, ' ').split(' ').map(word => 
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');
  };

  // Get contribution details summary
  const getContributionSummary = (rule: ContributionRule) => {
    switch (rule.contributionType) {
      case 'flat_rate':
        return `$${rule.flatRateAmount || 0} per month`;
      case 'percentage':
        return `${rule.percentageAmount || 0}% of premium`;
      case 'tier_based':
        if (rule.tierContributions) {
          const tiers = [];
          if (rule.tierContributions.employee_only) tiers.push(`EE: $${rule.tierContributions.employee_only}`);
          if (rule.tierContributions.employee_spouse) tiers.push(`ES: $${rule.tierContributions.employee_spouse}`);
          if (rule.tierContributions.employee_children) tiers.push(`EC: $${rule.tierContributions.employee_children}`);
          if (rule.tierContributions.family) tiers.push(`Family: $${rule.tierContributions.family}`);
          return tiers.join(' • ');
        }
        return 'Tier-based contribution';
      case 'minimum_threshold':
        return `Minimum: $${rule.minimumAmount || 0}`;
      case 'override':
        return 'Full premium coverage';
      default:
        return formatContributionType(rule.contributionType);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Contribution Rules</h3>
          <p className="text-sm text-gray-600 mt-1">
            Manage employer contribution rules for {groupName}
          </p>
        </div>
        <button
          onClick={handleAdd}
          className="px-4 py-2 bg-oe-primary text-white rounded-md hover:bg-oe-dark flex items-center space-x-2"
        >
          <Plus className="h-4 w-4" />
          <span>Add Contribution</span>
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center space-x-4 bg-gray-50 p-4 rounded-lg">
        <div className="flex items-center space-x-2">
          <Filter className="h-4 w-4 text-gray-500" />
          <span className="text-sm font-medium text-gray-700">Filters:</span>
        </div>
        
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-1 border border-gray-300 rounded-md text-sm focus:ring-oe-primary focus:border-oe-primary"
        >
          <option value="all">All Status</option>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
          <option value="Pending">Pending</option>
        </select>

        <select
          value={filterProduct}
          onChange={(e) => setFilterProduct(e.target.value)}
          className="px-3 py-1 border border-gray-300 rounded-md text-sm focus:ring-oe-primary focus:border-oe-primary"
        >
          <option value="all">All Products</option>
          {products && products.map(product => (
            <option key={product.ProductId} value={product.ProductId}>
              {product.Name}
            </option>
          ))}
        </select>

        <div className="flex-1"></div>
        
        <span className="text-sm text-gray-600">
          {filteredRules.length} rule{filteredRules.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Rules List */}
      {filteredRules.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
          <Settings className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <p className="text-lg font-medium text-gray-900">No contribution rules found</p>
          <p className="text-sm text-gray-600 mt-1">
            {filterStatus !== 'all' || filterProduct !== 'all' 
              ? 'Try adjusting your filters or add a new rule'
              : 'Click "Add Contribution" to create your first rule'}
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {filteredRules
            .sort((a, b) => a.priority - b.priority)
            .map((rule) => (
              <div
                key={rule.contributionId}
                className="bg-white border border-gray-200 rounded-lg p-6 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    {/* Rule Header */}
                    <div className="flex items-center space-x-3 mb-3">
                      <div className="flex items-center space-x-2">
                        <div className="w-8 h-8 bg-oe-light text-oe-primary rounded-full flex items-center justify-center">
                          {getContributionTypeIcon(rule.contributionType)}
                        </div>
                        <h4 className="font-semibold text-gray-900">{rule.name}</h4>
                      </div>
                      <div className="flex items-center space-x-2">
                        <span className={`px-2 py-1 text-xs rounded-full ${
                          rule.status === 'Active' ? 'bg-green-100 text-green-800' : 
                          rule.status === 'Pending' ? 'bg-yellow-100 text-yellow-800' :
                          'bg-gray-100 text-gray-800'
                        }`}>
                          {rule.status}
                        </span>
                        {rule.stacking && (
                          <span className="px-2 py-1 text-xs bg-oe-light text-oe-primary rounded-full">
                            Stacking
                          </span>
                        )}
                        <span className="px-2 py-1 text-xs bg-gray-100 text-gray-800 rounded-full">
                          Priority: {rule.priority}
                        </span>
                      </div>
                    </div>

                    {/* Description */}
                    {rule.description && (
                      <p className="text-sm text-gray-600 mb-3">{rule.description}</p>
                    )}

                    {/* Contribution Details */}
                    <div className="bg-gray-50 rounded-lg p-3 mb-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                            {formatContributionType(rule.contributionType)}
                          </p>
                          <p className="text-sm font-semibold text-gray-900 mt-1">
                            {getContributionSummary(rule)}
                          </p>
                        </div>
                        {rule.productName && (
                          <div className="text-right">
                            <p className="text-xs font-medium text-gray-500">Applied to</p>
                            <p className="text-sm font-medium text-gray-900">{rule.productName}</p>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Dates */}
                    <div className="flex items-center space-x-4 text-xs text-gray-500">
                      <div className="flex items-center space-x-1">
                        <Calendar className="h-3 w-3" />
                        <span>Effective: {new Date(rule.effectiveDate).toLocaleDateString()}</span>
                      </div>
                      {rule.endDate && (
                        <div className="flex items-center space-x-1">
                          <Calendar className="h-3 w-3" />
                          <span>Ends: {new Date(rule.endDate).toLocaleDateString()}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center space-x-1 ml-4">
                    <button
                      onClick={() => handleEdit(rule)}
                      className="p-2 text-gray-600 hover:text-oe-primary hover:bg-oe-light rounded-md transition-colors"
                      title="Edit Rule"
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteClick(rule)}
                      className="p-2 text-gray-600 hover:text-oe-error hover:bg-red-50 rounded-md transition-colors"
                      title="Delete Rule"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Modal */}
      <ContributionModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        groupId={groupId}
        products={products}
        contribution={editingContribution}
        onSave={handleModalSave}
        showSnackbar={showSnackbar}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialog.open}
        onClose={() => setDeleteDialog({ open: false, contributionId: '', contributionName: '' })}
      >
        <DialogTitle>Delete Contribution Rule</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete the contribution rule "{deleteDialog.contributionName}"? This action cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button 
            onClick={() => setDeleteDialog({ open: false, contributionId: '', contributionName: '' })} 
            color="primary"
          >
            Cancel
          </Button>
          <Button 
            onClick={handleDeleteConfirm} 
            color="error" 
            autoFocus
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={handleCloseSnackbar}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={handleCloseSnackbar} severity={snackbar.severity} sx={{ width: '100%' }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </div>
  );
};

export default GroupContributionsTab;
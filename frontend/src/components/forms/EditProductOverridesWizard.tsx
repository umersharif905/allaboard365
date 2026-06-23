import { Plus, Save, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
    CreateOverrideData,
    OverrideACHAccount,
    ProductOverride,
    ProductOverridesService
} from '../../services/product-overrides.service';

interface EditProductOverridesWizardProps {
  isOpen: boolean;
  productId: string;
  productName: string;
  onClose: () => void;
  onSuccess: () => void;
}

export default function EditProductOverridesWizard({
  isOpen,
  productId,
  productName,
  onClose,
  onSuccess
}: EditProductOverridesWizardProps) {
  const { user } = useAuth();
  const isSysAdmin = user?.currentRole === 'SysAdmin';
  
  const [loading, setLoading] = useState(false);
  const [overrides, setOverrides] = useState<ProductOverride[]>([]);
  const [achAccounts, setACHAccounts] = useState<OverrideACHAccount[]>([]);
  const [tenants, setTenants] = useState<{ TenantId: string; Name: string }[]>([]);
  const [currentTenantName, setCurrentTenantName] = useState<string>('');
  const [editingOverride, setEditingOverride] = useState<ProductOverride | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [notification, setNotification] = useState<{
    message: string;
    type: 'success' | 'error';
  } | null>(null);

  // Form state - Initialize tenantId with current user's tenant if not SysAdmin
  // Default effective date to today
  const [formData, setFormData] = useState<CreateOverrideData>({
    tenantId: isSysAdmin ? '' : (user?.tenantId || ''),
    overrideAmount: '' as any, // Start empty, will be converted to number on submit
    priority: undefined, // Priority is optional/nullable
    isActive: true,
    effectiveDate: new Date().toISOString().split('T')[0],
    productPricingId: undefined
  });

  // Delete modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletingOverride, setDeletingOverride] = useState<ProductOverride | null>(null);
  const [deleteOption, setDeleteOption] = useState<'immediate' | 'scheduled'>('immediate');
  const [expirationDate, setExpirationDate] = useState<string>('');

  // ACH Account creation state
  const [showACHForm, setShowACHForm] = useState(false);
const [achFormData, setACHFormData] = useState({
    accountName: '',
    accountHolderName: '',
    bankName: '',
    accountNumber: '',
    routingNumber: '',
    bankAccountType: 'Checking' as 'Checking' | 'Savings'
  });

  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen, productId]);

  const loadData = async () => {
    setLoading(true);
    try {
      // Load overrides
      const overridesResponse = await ProductOverridesService.getProductOverrides(productId);
      if (overridesResponse.success && overridesResponse.data) {
        setOverrides(overridesResponse.data);
      } else {
        // Check if it's the tables not found error
        if (overridesResponse.error && (overridesResponse.error as any).code === 'TABLES_NOT_FOUND') {
          showNotification(
            'Product overrides feature requires database setup. Please contact your administrator to run the migration script: backend/scripts/create-product-overrides-tables.sql',
            'error'
          );
          return;
        }
      }

      // Load ACH accounts
      const achResponse = await ProductOverridesService.getOverrideACHAccounts();
      if (achResponse.success && achResponse.data) {
        setACHAccounts(achResponse.data);
      }

      // Load tenant info
      if (isSysAdmin) {
        // Load all tenants for dropdown
        const tenantsResponse = await ProductOverridesService.getAvailableTenants();
        if (tenantsResponse.success && tenantsResponse.data) {
          setTenants(tenantsResponse.data);
        }
      } else {
        // Load current tenant name for display
        const tenantResponse = await ProductOverridesService.getCurrentTenant();
        if (tenantResponse.success && tenantResponse.data) {
          setCurrentTenantName(tenantResponse.data.Name);
        }
      }
    } catch (error: any) {
      console.error('Failed to load override data:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to load override data. Please try again.';
      showNotification(errorMessage, 'error');
    } finally {
      setLoading(false);
    }
  };

  const showNotification = (message: string, type: 'success' | 'error') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 5000);
  };

  const handleAddNew = () => {
    setEditingOverride(null);
    setFormData({
      tenantId: isSysAdmin ? '' : (user?.tenantId || ''),
      overrideAmount: '' as any,
      priority: undefined, // Priority is optional/nullable
      isActive: true,
      effectiveDate: new Date().toISOString().split('T')[0],
      productPricingId: undefined
    });
    setShowAddForm(true);
  };

  const handleEdit = (override: ProductOverride) => {
    setEditingOverride(override);
    setFormData({
      tenantId: override.TenantId,
      overrideACHId: override.OverrideACHId,
      overrideName: override.OverrideName,
      overrideAmount: override.OverrideAmount,
      priority: override.Priority,
      isActive: override.IsActive,
      effectiveDate: override.EffectiveDate,
      productPricingId: override.ProductPricingId || undefined
    });
    setShowAddForm(true);
  };

  const handleSave = async () => {
    try {
      setLoading(true);

      if (editingOverride) {
        // Update existing override
        const response = await ProductOverridesService.updateOverride(
          productId,
          editingOverride.OverrideId,
          formData
        );
        if (response.success) {
          showNotification('Override updated successfully', 'success');
          await loadData();
          setShowAddForm(false);
        } else {
          showNotification(response.message || 'Failed to update override', 'error');
        }
      } else {
        // Create new override
        const response = await ProductOverridesService.createOverride(productId, formData);
        if (response.success) {
          showNotification('Override created successfully', 'success');
          await loadData();
          setShowAddForm(false);
        } else {
          showNotification(response.message || 'Failed to create override', 'error');
        }
      }
    } catch (error: any) {
      console.error('Failed to save override:', error);
      showNotification(error.message || 'Failed to save override', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteClick = (override: ProductOverride) => {
    setDeletingOverride(override);
    setDeleteOption('immediate');
    setExpirationDate('');
    setShowDeleteModal(true);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingOverride) return;

    try {
      setLoading(true);

      if (deleteOption === 'immediate') {
        // Permanent delete
        const response = await ProductOverridesService.deleteOverride(productId, deletingOverride.OverrideId);
        if (response.success) {
          showNotification('Override deleted successfully', 'success');
          setShowDeleteModal(false);
          await loadData();
        } else {
          showNotification(response.message || 'Failed to delete override', 'error');
        }
      } else {
        // Set expiration date
        if (!expirationDate) {
          showNotification('Please select an expiration date', 'error');
          return;
        }

        const response = await ProductOverridesService.updateOverride(
          productId,
          deletingOverride.OverrideId,
          {
            tenantId: deletingOverride.TenantId,
            overrideACHId: deletingOverride.OverrideACHId,
            overrideName: deletingOverride.OverrideName,
            overrideAmount: deletingOverride.OverrideAmount,
            priority: deletingOverride.Priority,
            effectiveDate: deletingOverride.EffectiveDate,
            expirationDate: expirationDate,
            isActive: true, // Keep active until expiration date
            productPricingId: deletingOverride.ProductPricingId || undefined
          }
        );

        if (response.success) {
          showNotification(`Override will expire on ${new Date(expirationDate).toLocaleDateString()}`, 'success');
          setShowDeleteModal(false);
          await loadData();
        } else {
          showNotification(response.message || 'Failed to set expiration date', 'error');
        }
      }
    } catch (error: any) {
      console.error('Failed to delete override:', error);
      showNotification(error.message || 'Failed to delete override', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setShowAddForm(false);
    setEditingOverride(null);
    setFormData({
      tenantId: isSysAdmin ? '' : (user?.tenantId || ''),
      overrideAmount: '' as any,
      priority: undefined, // Priority is optional/nullable
      isActive: true,
      effectiveDate: new Date().toISOString().split('T')[0],
      productPricingId: undefined
    });
  };

  const handleCreateACHAccount = async () => {
    try {
      setLoading(true);

      // Validate ACH form
      if (
        !achFormData.accountName ||
        !achFormData.accountHolderName ||
        !achFormData.bankName ||
        !achFormData.accountNumber ||
        !achFormData.routingNumber
      ) {
        showNotification('Please fill in all required ACH account fields', 'error');
        return;
      }

      const response = await ProductOverridesService.createACHAccount({
        ...achFormData,
        accountNumber: achFormData.accountNumber.replace(/\D/g, ''),
        routingNumber: achFormData.routingNumber.replace(/\D/g, '')
      });
      
      if (response.success && response.data) {
        showNotification('ACH account created successfully', 'success');
        
        // Reload ACH accounts
        const achResponse = await ProductOverridesService.getOverrideACHAccounts();
        if (achResponse.success && achResponse.data) {
          setACHAccounts(achResponse.data);
        }

        // Select the newly created account
        setFormData({ ...formData, overrideACHId: response.data.OverrideACHId });
        
        // Close ACH form
        setShowACHForm(false);
        setACHFormData({
          accountName: '',
          accountHolderName: '',
          bankName: '',
          accountNumber: '',
          routingNumber: '',
          bankAccountType: 'Checking'
        });
      } else {
        showNotification(response.message || 'Failed to create ACH account', 'error');
      }
    } catch (error: any) {
      console.error('Failed to create ACH account:', error);
      showNotification(error.message || 'Failed to create ACH account', 'error');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg w-full max-w-5xl max-h-[90vh] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-gray-200 bg-gradient-primary">
          <div>
            <h2 className="text-xl font-bold text-white">Edit Override Distributions</h2>
            <p className="text-sm text-white opacity-90 mt-1">{productName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-white hover:bg-white hover:bg-opacity-20 p-2 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Notification */}
        {notification && (
          <div
            className={`mx-6 mt-4 p-4 rounded-lg ${
              notification.type === 'success'
                ? 'bg-green-50 border border-green-200 text-green-800'
                : 'bg-red-50 border border-red-200 text-red-800'
            }`}
          >
            {notification.message}
          </div>
        )}

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-200px)]">
          {loading && !showAddForm ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
            </div>
          ) : showAddForm ? (
            /* Add/Edit Form */
            <div className="bg-gray-50 rounded-lg p-6 space-y-4">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                {editingOverride ? 'Edit Override Distribution' : 'Add New Override Distribution'}
              </h3>

              {/* Tenant Selection - Only show for SysAdmin */}
              {isSysAdmin ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tenant <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={formData.tenantId}
                    onChange={(e) => setFormData({ ...formData, tenantId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                  >
                    <option value="">Select Tenant</option>
                    {tenants.map((tenant) => (
                      <option key={tenant.TenantId} value={tenant.TenantId}>
                        {tenant.Name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tenant
                  </label>
                  <div className="px-3 py-2 bg-gray-50 border border-gray-300 rounded-lg text-gray-700">
                    {currentTenantName || 'Your Organization'}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    This override will apply to your organization only
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Override Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Override Name
                  </label>
                  <input
                    type="text"
                    value={formData.overrideName || ''}
                    onChange={(e) => setFormData({ ...formData, overrideName: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="e.g., Q1 2025 Promotional Override"
                  />
                </div>

                {/* Override Amount */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Override Amount <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <span className="text-gray-500">$</span>
                    </div>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.overrideAmount}
                      onChange={(e) =>
                        setFormData({ ...formData, overrideAmount: e.target.value })
                      }
                      className="w-full pl-7 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="0.00"
                      required
                    />
                  </div>
                </div>

                {/* Priority - Optional, no longer used */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Priority (Optional - Deprecated)
                  </label>
                  <input
                    type="number"
                    value={formData.priority || ''}
                    onChange={(e) =>
                      setFormData({ ...formData, priority: e.target.value ? Number(e.target.value) : undefined })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="Leave empty"
                  />
                  <p className="text-xs text-gray-500 mt-1">Priority is no longer used for product overrides</p>
                </div>

                {/* ACH Account */}
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    ACH Account <span className="text-red-500">*</span>
                  </label>
                  <div className="flex space-x-2">
                    <select
                      value={formData.overrideACHId || ''}
                      onChange={(e) => {
                        if (e.target.value === 'CREATE_NEW') {
                          setShowACHForm(true);
                        } else {
                          setFormData({ ...formData, overrideACHId: e.target.value });
                        }
                      }}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      required
                    >
                      <option value="">Select ACH Account</option>
                      {achAccounts.map((account) => (
                        <option key={account.OverrideACHId} value={account.OverrideACHId}>
                          {(account.AccountName || account.AccountHolderName) ?? 'Override Account'} - {account.BankName}
                        </option>
                      ))}
                      <option value="CREATE_NEW">+ Create New ACH Account</option>
                    </select>
                  </div>

                  {/* Inline ACH Account Creation Form */}
                  {showACHForm && (
                    <div className="mt-4 p-4 border-2 border-oe-primary border-opacity-30 rounded-lg bg-oe-light space-y-3">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-sm font-semibold text-gray-900">New ACH Account</h4>
                        <button
                          onClick={() => {
                            setShowACHForm(false);
                            setACHFormData({
                              accountName: '',
                              accountHolderName: '',
                              bankName: '',
                              accountNumber: '',
                              routingNumber: '',
                              bankAccountType: 'Checking'
                            });
                          }}
                          className="text-gray-400 hover:text-gray-600"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">
                            Account Name <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={achFormData.accountName}
                            onChange={(e) => setACHFormData({ ...achFormData, accountName: e.target.value })}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="e.g., MightyWELL Primary Account"
                          />
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">
                            Account Holder Name <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={achFormData.accountHolderName}
                            onChange={(e) => setACHFormData({ ...achFormData, accountHolderName: e.target.value })}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="e.g., MightyWELL Health LLC"
                          />
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">
                            Bank Name <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={achFormData.bankName}
                            onChange={(e) => setACHFormData({ ...achFormData, bankName: e.target.value })}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="e.g., Chase Bank"
                          />
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">
                            Routing Number <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={achFormData.routingNumber}
                            onChange={(e) => setACHFormData({ ...achFormData, routingNumber: e.target.value.replace(/\D/g, '') })}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="9 digits"
                            maxLength={9}
                          />
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">
                            Account Number <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={achFormData.accountNumber}
                            onChange={(e) => setACHFormData({ ...achFormData, accountNumber: e.target.value.replace(/\D/g, '') })}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="Account number"
                          />
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">
                            Account Type <span className="text-red-500">*</span>
                          </label>
                          <select
                            value={achFormData.bankAccountType}
                            onChange={(e) => setACHFormData({ ...achFormData, bankAccountType: e.target.value as 'Checking' | 'Savings' })}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          >
                            <option value="Checking">Checking</option>
                            <option value="Savings">Savings</option>
                          </select>
                        </div>
                      </div>

                      <div className="flex justify-end space-x-2 pt-2 border-t border-oe-primary border-opacity-30">
                        <button
                          onClick={() => {
                            setShowACHForm(false);
                            setACHFormData({
                              accountName: '',
                              accountHolderName: '',
                              bankName: '',
                              accountNumber: '',
                              routingNumber: '',
                              bankAccountType: 'Checking'
                            });
                          }}
                          className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleCreateACHAccount}
                          disabled={
                            loading ||
                            !achFormData.accountName ||
                            !achFormData.accountHolderName ||
                            !achFormData.bankName ||
                            !achFormData.accountNumber ||
                            !achFormData.routingNumber
                          }
                          className="px-3 py-1.5 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-dark disabled:opacity-50"
                        >
                          {loading ? 'Creating...' : 'Create Account'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Effective Date */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Effective Date
                  </label>
                  <input
                    type="date"
                    value={formData.effectiveDate || ''}
                    onChange={(e) => setFormData({ ...formData, effectiveDate: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                  <p className="text-xs text-gray-500 mt-1">When this override becomes active</p>
                </div>
              </div>

              {/* Form Actions */}
              <div className="flex justify-end space-x-3 pt-4 border-t">
                <button
                  onClick={handleCancel}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                  disabled={loading}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  className="btn-primary disabled:opacity-50"
                  disabled={loading || (isSysAdmin && !formData.tenantId) || !formData.overrideAmount || !formData.overrideACHId}
                >
                  <Save className="w-4 h-4 mr-2" />
                  {loading ? 'Saving...' : 'Save Override'}
                </button>
              </div>
            </div>
          ) : (
            /* Overrides List */
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">
                  Existing Overrides ({overrides.length})
                </h3>
                <button
                  onClick={handleAddNew}
                  className="inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-[#1f8dbf] rounded-lg hover:bg-[#125e82]"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Override Distribution
                </button>
              </div>

              {overrides.length === 0 ? (
                <div className="text-center py-12 bg-gray-50 rounded-lg">
                  <p className="text-gray-600">No overrides configured for this product</p>
                  <p className="text-sm text-gray-500 mt-2">Click "Add Override Distribution" above to get started</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Tenant
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Name
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Amount
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Priority
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Status
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Dates
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {overrides.map((override) => (
                        <tr key={override.OverrideId} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm text-gray-900">
                            {override.TenantName}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900">
                            {override.OverrideName || '-'}
                          </td>
                          <td className="px-4 py-3 text-sm font-medium text-gray-900">
                            ${override.OverrideAmount.toFixed(2)}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">
                            {override.Priority ?? '-'}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <span
                              className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                override.IsActive
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-gray-100 text-gray-800'
                              }`}
                            >
                              {override.IsActive ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">
                            {override.EffectiveDate && (
                              <div>
                                From: {new Date(override.EffectiveDate).toLocaleDateString()}
                              </div>
                            )}
                            {override.ExpirationDate && (
                              <div>
                                To: {new Date(override.ExpirationDate).toLocaleDateString()}
                              </div>
                            )}
                            {!override.EffectiveDate && !override.ExpirationDate && '-'}
                          </td>
                          <td className="px-4 py-3 text-sm text-right space-x-2">
                            <button
                              onClick={() => handleEdit(override)}
                              className="text-oe-primary hover:text-oe-dark font-medium"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleDeleteClick(override)}
                              className="text-red-600 hover:text-red-800 font-medium"
                            >
                              <Trash2 className="w-4 h-4 inline" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end items-center p-6 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            className="px-6 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Close
          </button>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteModal && deletingOverride && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-lg max-w-lg w-full shadow-2xl">
            <div className="p-6 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Delete Override</h3>
              <p className="text-sm text-gray-600 mt-1">
                {deletingOverride.OverrideName || 'Override'}
                {deletingOverride.Priority !== null && ` - Priority ${deletingOverride.Priority}`}
              </p>
            </div>

            <div className="p-6 space-y-4">
              <p className="text-sm text-gray-700">
                Choose how you want to remove this override:
              </p>

              {/* Delete Option: Immediate */}
              <label className="flex items-start space-x-3 p-4 border-2 border-gray-200 rounded-lg cursor-pointer hover:border-red-500 transition-colors">
                <input
                  type="radio"
                  name="deleteOption"
                  value="immediate"
                  checked={deleteOption === 'immediate'}
                  onChange={() => setDeleteOption('immediate')}
                  className="mt-1 h-4 w-4 text-red-600 focus:ring-red-500 border-gray-300"
                />
                <div className="flex-1">
                  <div className="font-medium text-gray-900">Delete Immediately</div>
                  <p className="text-sm text-gray-600 mt-1">
                    Permanently remove this override right now. This action cannot be undone.
                  </p>
                </div>
              </label>

              {/* Delete Option: Scheduled */}
              <label className="flex items-start space-x-3 p-4 border-2 border-gray-200 rounded-lg cursor-pointer hover:border-oe-primary transition-colors">
                <input
                  type="radio"
                  name="deleteOption"
                  value="scheduled"
                  checked={deleteOption === 'scheduled'}
                  onChange={() => setDeleteOption('scheduled')}
                  className="mt-1 h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                />
                <div className="flex-1">
                  <div className="font-medium text-gray-900">Schedule Expiration</div>
                  <p className="text-sm text-gray-600 mt-1 mb-3">
                    Set an expiration date. The override will remain active until that date.
                  </p>
                  {deleteOption === 'scheduled' && (
                    <input
                      type="date"
                      value={expirationDate}
                      onChange={(e) => setExpirationDate(e.target.value)}
                      min={new Date().toISOString().split('T')[0]}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="Select expiration date"
                    />
                  )}
                </div>
              </label>
            </div>

            <div className="flex justify-end space-x-3 p-6 border-t border-gray-200 bg-gray-50">
              <button
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeletingOverride(null);
                  setDeleteOption('immediate');
                  setExpirationDate('');
                }}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                disabled={loading}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={loading || (deleteOption === 'scheduled' && !expirationDate)}
                className={`inline-flex items-center px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 ${
                  deleteOption === 'immediate'
                    ? 'bg-oe-error hover:bg-red-700'
                    : 'bg-oe-primary hover:bg-oe-dark'
                }`}
              >
                <Trash2 className="w-4 h-4 mr-2" />
                {loading
                  ? 'Processing...'
                  : deleteOption === 'immediate'
                  ? 'Delete Now'
                  : 'Set Expiration Date'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


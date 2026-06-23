// File: src/pages/admin/tenants.tsx
// Version 17: Modularized - Main Tenants Page
import React, { useEffect, useState } from 'react';
import SharedHeader from '../../components/layout/SharedHeader';
import UnifiedTenantSettingsModal from '../../components/UnifiedTenantSettingsModal';
import TenantUserManagementPanel from '../../components/tenant-admin/TenantUserManagementPanel';
import { API_CONFIG } from '../../config/api';
import { apiService } from '../../services/api.service';
import TenantService from '../../services/TenantService';
import TenantDetails from './tenantDetails';
import type { ApiResponse } from '../../types/api.types';

// Extend the Tenant interface to include missing properties
export interface ExtendedTenant {
  TenantId: string;
  Name: string;
  Status: string;
  ContactEmail: string;
  ContactPhone?: string;
  PrimaryAddress?: string;
  PrimaryCity?: string;
  PrimaryState?: string;
  PrimaryZip?: string;
  CustomLogoUrl?: string;
  PaymentProcessorSettings?: string;
  AdvancedSettings?: string;
  CreatedDate: string;
  ModifiedDate: string;
  CreatedBy?: string;
  ModifiedBy?: string;
  TaxIdNumber?: string;
  BusinessType?: string;
  YearsInBusiness?: number;
  NumberOfEmployees?: number;
  AnnualRevenue?: number;
  Website?: string;
  Industry?: string;
  Description?: string;
  SecondaryContactName?: string;
  SecondaryContactEmail?: string;
  SecondaryContactPhone?: string;
  SecondaryAddress?: string;
  SecondaryCity?: string;
  SecondaryState?: string;
  SecondaryZip?: string;
  BillingAddress?: string;
  BillingCity?: string;
  BillingState?: string;
  BillingZip?: string;
  SupportEmail?: string;
  SupportPhone?: string;
  TimeZone?: string;
  DateFormat?: string;
  CurrencyFormat?: string;
  TenantType?: string;
  SystemFees?: string;  // Add this line
  ContactPerson?: string;
   MonthlyRevenue: number;
  TotalMembers: number;
  ActiveMembers: number;
  TotalAgents: number;
  SubscribedProducts: number;
  TotalProducts: number;
  // Deprecated fields (but kept for backward compatibility)
  LogoUrl?: string;
  PrimaryColorHex?: string;
  SecondaryColorHex?: string;
  CustomDomain?: string;
  MemberIDPrefix?: string;
  IndividualMemberIDPrefix?: string;
  AgentIDPrefix?: string | null;
}

// Get API base URL from environment or default to localhost
export const API_BASE_URL = API_CONFIG.BASE_URL;

// Icons
import {
    Activity,
    AlertTriangle,
    Building,
    CheckCircle,
    DollarSign,
    Edit,
    Eye,
    Filter,
    Globe,
    Grid, List,
    Loader2,
    Mail,
    MapPin,
    Phone,
    Plus,
    RefreshCw,
    Save,
    Search,
    Settings,
    Shield,
    TrendingUp,
    Users,
    X,
    XCircle
} from 'lucide-react';

// US States constant
export const US_STATES = [
  { value: '', label: 'All States' },
  { value: 'AL', label: 'Alabama' },
  { value: 'AK', label: 'Alaska' },
  { value: 'AZ', label: 'Arizona' },
  { value: 'AR', label: 'Arkansas' },
  { value: 'CA', label: 'California' },
  { value: 'CO', label: 'Colorado' },
  { value: 'CT', label: 'Connecticut' },
  { value: 'DE', label: 'Delaware' },
  { value: 'FL', label: 'Florida' },
  { value: 'GA', label: 'Georgia' },
  { value: 'HI', label: 'Hawaii' },
  { value: 'ID', label: 'Idaho' },
  { value: 'IL', label: 'Illinois' },
  { value: 'IN', label: 'Indiana' },
  { value: 'IA', label: 'Iowa' },
  { value: 'KS', label: 'Kansas' },
  { value: 'KY', label: 'Kentucky' },
  { value: 'LA', label: 'Louisiana' },
  { value: 'ME', label: 'Maine' },
  { value: 'MD', label: 'Maryland' },
  { value: 'MA', label: 'Massachusetts' },
  { value: 'MI', label: 'Michigan' },
  { value: 'MN', label: 'Minnesota' },
  { value: 'MS', label: 'Mississippi' },
  { value: 'MO', label: 'Missouri' },
  { value: 'MT', label: 'Montana' },
  { value: 'NE', label: 'Nebraska' },
  { value: 'NV', label: 'Nevada' },
  { value: 'NH', label: 'New Hampshire' },
  { value: 'NJ', label: 'New Jersey' },
  { value: 'NM', label: 'New Mexico' },
  { value: 'NY', label: 'New York' },
  { value: 'NC', label: 'North Carolina' },
  { value: 'ND', label: 'North Dakota' },
  { value: 'OH', label: 'Ohio' },
  { value: 'OK', label: 'Oklahoma' },
  { value: 'OR', label: 'Oregon' },
  { value: 'PA', label: 'Pennsylvania' },
  { value: 'RI', label: 'Rhode Island' },
  { value: 'SC', label: 'South Carolina' },
  { value: 'SD', label: 'South Dakota' },
  { value: 'TN', label: 'Tennessee' },
  { value: 'TX', label: 'Texas' },
  { value: 'UT', label: 'Utah' },
  { value: 'VT', label: 'Vermont' },
  { value: 'VA', label: 'Virginia' },
  { value: 'WA', label: 'Washington' },
  { value: 'WV', label: 'West Virginia' },
  { value: 'WI', label: 'Wisconsin' },
  { value: 'WY', label: 'Wyoming' }
];

interface FilterState {
  search: string;
  status: string;
  state: string;
  memberRange: string;
  showDeactivated: boolean;
}

interface CreateTenantData {
  Name: string;
  ContactEmail: string;
  ContactPhone: string;
  PrimaryAddress: string;
  PrimaryCity: string;
  PrimaryState: string;
  PrimaryZip: string;
  TaxIdNumber: string;
  BusinessType: string;
  Website: string;
  Industry: string;
  Description: string;
  TimeZone: string;
  DefaultUrlPath?: string;
  IsExternal?: boolean;
}

export interface EditTenantData {
  Name: string;
  ContactEmail: string;
  ContactPhone: string;
  Website: string;
  PrimaryAddress: string;
  PrimaryCity: string;
  PrimaryState: string;
  PrimaryZip: string;
  TaxIdNumber: string;
  TimeZone: string;
  Description: string;
}

const AdminTenants: React.FC = () => {
  // const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showFilters, setShowFilters] = useState<boolean>(false);
  const [tenants, setTenants] = useState<ExtendedTenant[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTenant, setSelectedTenant] = useState<ExtendedTenant | null>(null);
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [addTenantLoading, setAddTenantLoading] = useState<boolean>(false);
  const [showAdvancedConfig, setShowAdvancedConfig] = useState<boolean>(false);
  const [advancedConfigTenant, setAdvancedConfigTenant] = useState<ExtendedTenant | null>(null);
  const [showEditModal, setShowEditModal] = useState<boolean>(false);
  const [editTenantLoading, setEditTenantLoading] = useState<boolean>(false);
  const [showDetailsModal, setShowDetailsModal] = useState<boolean>(false);
  const [tenantUsersModalTenant, setTenantUsersModalTenant] = useState<ExtendedTenant | null>(null);

  // Add Tenant Admin Modal states
  const [showAddTenantAdminModal, setShowAddTenantAdminModal] = useState<boolean>(false);
  const [addTenantAdminLoading, setAddTenantAdminLoading] = useState<boolean>(false);
  
  const [filters, setFilters] = useState<FilterState>({
    search: '',
    status: '',
    state: '',
    memberRange: '',
    showDeactivated: false
  });

  // Dashboard metrics
  const [metrics, setMetrics] = useState({
    totalTenants: 0,
    activeTenants: 0,
    totalRevenue: 0,
    avgRevenue: 0,
    tenantsChange: 0,
    activeChange: 0,
    revenueChange: 0,
    avgRevenueChange: 0
  });

  // Fetch tenants from API
  useEffect(() => {
    fetchTenants();
  }, [filters.showDeactivated]);

  const fetchTenants = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await TenantService.getTenants(
        filters.showDeactivated ? { status: 'Inactive' } : undefined
      );
      
      if (response.success && response.data) {
        setTenants(response.data);
        calculateMetrics(response.data);
      } else {
        setError(response.message || 'Failed to fetch tenants');
      }
    } catch (error) {
      console.error('Error fetching tenants:', error);
      setError('Failed to load tenants. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const calculateMetrics = (tenantData: ExtendedTenant[]) => {
    const totalTenants = tenantData.length;
    const activeTenants = tenantData.filter(t => t.Status === 'Active').length;
    const totalRevenue = tenantData.reduce((sum, t) => sum + t.MonthlyRevenue, 0);
    const avgRevenue = totalTenants > 0 ? totalRevenue / totalTenants : 0;

    setMetrics({
      totalTenants,
      activeTenants,
      totalRevenue,
      avgRevenue,
      tenantsChange: 2,
      activeChange: 1,
      revenueChange: 8.5,
      avgRevenueChange: 3.2
    });
  };

  const handleFilterChange = (key: keyof FilterState, value: string): void => {
    setFilters(prev => ({
      ...prev,
      [key]: value
    }));
  };

  const handleCreateTenant = async (tenantData: CreateTenantData) => {
    setAddTenantLoading(true);
    
    try {
      const response = await TenantService.createTenant(tenantData);
      
      if (response.success) {
        await fetchTenants();
        setShowAddModal(false);
      } else {
        setError(response.message || 'Failed to create tenant');
      }
    } catch (error) {
      console.error('Error creating tenant:', error);
      setError('Failed to create tenant. Please try again.');
    } finally {
      setAddTenantLoading(false);
    }
  };

  const handleCreateTenantAdmin = async (tenantAdminData: { tenantId: string; email: string; firstName: string; lastName: string }) => {
    setAddTenantAdminLoading(true);
    
    try {
      const response = await apiService.post<ApiResponse<any>>('/api/admin/tenant-admins', tenantAdminData);
      
      if (response.success) {
        setShowAddTenantAdminModal(false);
        // Show success message - you might want to add a toast notification here
        console.log('Tenant admin invitation sent successfully');
      } else {
        setError(response.message || 'Failed to create tenant admin invitation');
      }
    } catch (error) {
      console.error('Error creating tenant admin invitation:', error);
      setError('Failed to create tenant admin invitation. Please try again.');
    } finally {
      setAddTenantAdminLoading(false);
    }
  };

  const handleDeactivateTenant = async (tenantId: string): Promise<{ success: boolean; message?: string }> => {
    try {
      const response = await TenantService.deactivateTenant(tenantId);
      if (response.success) {
        await fetchTenants();
        setShowEditModal(false);
        setSelectedTenant(null);
        return { success: true, message: response.message };
      }
      return { success: false, message: response.message || 'Failed to deactivate tenant' };
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } }; message?: string };
      const message =
        err.response?.data?.message || err.message || 'Failed to deactivate tenant';
      return { success: false, message };
    }
  };

  const handleEditTenant = async (tenantData: EditTenantData) => {
    if (!selectedTenant) return;
    
    setEditTenantLoading(true);
    
    try {
      const response = await TenantService.updateTenant(selectedTenant.TenantId, tenantData);
      
      if (response.success) {
        await fetchTenants();
        setShowEditModal(false);
        setSelectedTenant(null);
      } else {
        setError(response.message || 'Failed to update tenant');
      }
    } catch (error) {
      console.error('Error updating tenant:', error);
      setError('Failed to update tenant. Please try again.');
    } finally {
      setEditTenantLoading(false);
    }
  };

  const handleOpenAdvancedConfig = (tenant: ExtendedTenant) => {
    setAdvancedConfigTenant(tenant);
    setShowAdvancedConfig(true);
  };

  const handleCloseAdvancedConfig = () => {
    setShowAdvancedConfig(false);
    setAdvancedConfigTenant(null);
  };

  const handleOpenDetails = (tenant: ExtendedTenant) => {
    setSelectedTenant(tenant);
    setShowDetailsModal(true);
  };

  const handleCloseDetails = () => {
    setShowDetailsModal(false);
    setSelectedTenant(null);
  };

  const handleCloseTenantUsersModal = () => {
    setTenantUsersModalTenant(null);
  };

  const filteredTenants = tenants.filter(tenant => {
    if (filters.search && !tenant.Name.toLowerCase().includes(filters.search.toLowerCase()) &&
        !tenant.ContactEmail.toLowerCase().includes(filters.search.toLowerCase())) {
      return false;
    }
    if (!filters.showDeactivated && filters.status && tenant.Status !== filters.status) {
      return false;
    }
    if (filters.state && tenant.PrimaryState !== filters.state) {
      return false;
    }
    if (filters.memberRange) {
      const memberCount = tenant.TotalMembers;
      switch (filters.memberRange) {
        case 'small':
          if (memberCount >= 500) return false;
          break;
        case 'medium':
          if (memberCount < 500 || memberCount >= 1000) return false;
          break;
        case 'large':
          if (memberCount < 1000) return false;
          break;
      }
    }
    return true;
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Active':
        return 'bg-green-100 text-green-800';
      case 'Suspended':
        return 'bg-red-100 text-red-800';
      case 'Pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'Inactive':
        return 'bg-gray-100 text-gray-600';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const formatCurrency = (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  };

  const formatLargeCurrency = (amount: number): string => {
    if (amount >= 1000000) {
      return `$${(amount / 1000000).toFixed(1)}M`;
    }
    if (amount >= 1000) {
      return `$${(amount / 1000).toFixed(0)}K`;
    }
    return formatCurrency(amount);
  };

  // Tenant Card Component
  const TenantCard: React.FC<{ tenant: ExtendedTenant }> = ({ tenant }) => (
    <div className="bg-white rounded-lg shadow-md hover:shadow-lg transition-shadow duration-200 overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            {tenant.LogoUrl ? (
              <img
                src={tenant.LogoUrl}
                alt={`${tenant.Name} logo`}
                className="w-12 h-12 rounded-lg object-contain bg-gray-50 p-1"
                onError={(e) => {
                  // Fallback to initial if logo fails to load
                  const target = e.target as HTMLImageElement;
                  target.style.display = 'none';
                  const fallback = target.nextElementSibling as HTMLElement;
                  if (fallback) fallback.style.display = 'flex';
                }}
              />
            ) : null}
            <div 
              className={`w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold text-lg ${tenant.LogoUrl ? 'hidden' : ''}`}
              style={{ backgroundColor: tenant.PrimaryColorHex || '#1f6db0' }}
            >
              {tenant.Name.charAt(0)}
            </div>
            <div>
              <h3 className="text-lg font-semibold text-oe-neutral-dark">{tenant.Name}</h3>
              <p className="text-sm text-gray-500">{tenant.ContactEmail}</p>
            </div>
          </div>
          <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(tenant.Status)}`}>
            {tenant.Status}
          </span>
        </div>
        
        <div className="space-y-2 mb-4">
          {(tenant.PrimaryCity || tenant.PrimaryState) && (
            <div className="flex items-center text-xs text-gray-500">
              <MapPin size={12} className="mr-1" />
              <span>{tenant.PrimaryCity || ''}{tenant.PrimaryCity && tenant.PrimaryState ? ', ' : ''}{tenant.PrimaryState || ''}</span>
            </div>
          )}
          <div className="flex items-center text-xs text-gray-500">
            <Users size={12} className="mr-1" />
            <span>{(tenant.ActiveMembers || 0).toLocaleString()} / {(tenant.TotalMembers || 0).toLocaleString()} Active Members</span>
          </div>
          <div className="flex items-center text-xs text-gray-500">
            <Shield size={12} className="mr-1" />
            <span>{tenant.TotalAgents || 0} Agents</span>
          </div>
          {tenant.CustomDomain && (
            <div className="flex items-center text-xs text-gray-500">
              <Globe size={12} className="mr-1" />
              <span className="truncate">{tenant.CustomDomain}</span>
            </div>
          )}
        </div>
        
        <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
          <div>
            <span className="text-gray-500">Monthly Revenue:</span>
            <p className="font-medium text-oe-success">{formatCurrency(tenant.MonthlyRevenue || 0)}</p>
          </div>
          <div>
            <span className="text-gray-500">Products:</span>
            <p className="font-medium">{tenant.SubscribedProducts || 0}/{tenant.TotalProducts || 0}</p>
          </div>
        </div>
        
        <div className="flex gap-2 flex-wrap">
          <button 
            onClick={() => handleOpenDetails(tenant)}
            className="flex-1 min-w-[7rem] bg-oe-primary text-white px-3 py-2 rounded-md text-sm font-medium hover:bg-oe-dark transition-colors flex items-center justify-center"
          >
            <Eye size={14} className="mr-1" />
            View Details
          </button>
          <button 
            type="button"
            onClick={() => setTenantUsersModalTenant(tenant)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm font-medium hover:bg-oe-neutral-light transition-colors flex items-center justify-center gap-1"
            title="Manage tenant admins"
          >
            <Users size={14} />
            <span className="hidden sm:inline">Admins</span>
          </button>
          <button 
            onClick={() => handleOpenAdvancedConfig(tenant)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm font-medium hover:bg-oe-neutral-light transition-colors flex items-center justify-center"
            title="Advanced Configuration"
          >
            <Settings size={14} />
          </button>
          <button 
            onClick={() => {
              setSelectedTenant(tenant);
              setShowEditModal(true);
            }}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm font-medium hover:bg-oe-neutral-light transition-colors flex items-center justify-center"
            title="Edit Tenant"
          >
            <Edit size={14} />
          </button>
        </div>
      </div>
    </div>
  );

  // Tenant List Item Component
  const TenantListItem: React.FC<{ tenant: ExtendedTenant }> = ({ tenant }) => (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow duration-200">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 flex-1 min-w-0">
          {tenant.LogoUrl ? (
            <img
              src={tenant.LogoUrl}
              alt={`${tenant.Name} logo`}
              className="w-12 h-12 rounded-lg object-contain bg-gray-50 p-1 flex-shrink-0"
              onError={(e) => {
                // Fallback to initial if logo fails to load
                const target = e.target as HTMLImageElement;
                target.style.display = 'none';
                const fallback = target.nextElementSibling as HTMLElement;
                if (fallback) fallback.style.display = 'flex';
              }}
            />
          ) : null}
          <div 
            className={`w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold text-lg flex-shrink-0 ${tenant.LogoUrl ? 'hidden' : ''}`}
            style={{ backgroundColor: tenant.PrimaryColorHex || '#1f6db0' }}
          >
            {tenant.Name.charAt(0)}
          </div>
          
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-lg font-semibold text-oe-neutral-dark truncate">{tenant.Name}</h3>
              <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(tenant.Status)}`}>
                {tenant.Status}
              </span>
            </div>
            
            <div className="flex items-center gap-6 text-sm text-gray-500">
              <div className="flex items-center">
                <Mail size={12} className="mr-1" />
                <span className="truncate">{tenant.ContactEmail}</span>
              </div>
              {tenant.ContactPhone && (
                <div className="flex items-center">
                  <Phone size={12} className="mr-1" />
                  <span>{tenant.ContactPhone}</span>
                </div>
              )}
              <div className="flex items-center">
                <MapPin size={12} className="mr-1" />
                <span>{[tenant.PrimaryCity, tenant.PrimaryState].filter(Boolean).join(', ') || '—'}</span>
              </div>
              {tenant.CustomDomain && (
                <div className="flex items-center">
                  <Globe size={12} className="mr-1" />
                  <span className="truncate">{tenant.CustomDomain}</span>
                </div>
              )}
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-6 text-sm flex-shrink-0">
          <div className="text-center">
            <div className="text-gray-500">Members</div>
            <div className="font-medium">{tenant.ActiveMembers.toLocaleString()}</div>
          </div>
          <div className="text-center">
            <div className="text-gray-500">Agents</div>
            <div className="font-medium">{tenant.TotalAgents}</div>
          </div>
          <div className="text-center">
            <div className="text-gray-500">Revenue</div>
            <div className="font-medium text-oe-success">{formatCurrency(tenant.MonthlyRevenue)}</div>
          </div>
          <div className="flex gap-2 flex-wrap justify-end">
            <button 
              onClick={() => handleOpenDetails(tenant)}
              className="bg-oe-primary text-white px-3 py-2 rounded-md text-sm font-medium hover:bg-oe-dark transition-colors flex items-center"
            >
              <Eye size={14} className="mr-1" />
              Details
            </button>
            <button 
              type="button"
              onClick={() => setTenantUsersModalTenant(tenant)}
              className="border border-gray-300 px-3 py-2 rounded-md text-sm font-medium hover:bg-oe-neutral-light transition-colors flex items-center gap-1"
              title="Manage tenant admins"
            >
              <Users size={14} />
              Admins
            </button>
            <button 
              onClick={() => handleOpenAdvancedConfig(tenant)}
              className="border border-gray-300 px-3 py-2 rounded-md text-sm font-medium hover:bg-oe-neutral-light transition-colors flex items-center"
              title="Advanced Configuration"
            >
              <Settings size={14} />
            </button>
            <button 
              onClick={() => {
                setSelectedTenant(tenant);
                setShowEditModal(true);
              }}
              className="border border-gray-300 px-3 py-2 rounded-md text-sm font-medium hover:bg-oe-neutral-light transition-colors flex items-center"
              title="Edit Tenant"
            >
              <Edit size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // Edit Tenant Modal Component
  const EditTenantModal: React.FC<{
    tenant: ExtendedTenant;
    onClose: () => void;
    onSubmit: (data: EditTenantData) => Promise<void>;
    onDeactivate: (tenantId: string) => Promise<{ success: boolean; message?: string }>;
    loading: boolean;
  }> = ({ tenant, onClose, onSubmit, onDeactivate, loading }) => {
    const [formData, setFormData] = useState<EditTenantData>({
      Name: tenant.Name || '',
      ContactEmail: tenant.ContactEmail || '',
      ContactPhone: tenant.ContactPhone || '',
      Website: tenant.Website || '',
      PrimaryAddress: tenant.PrimaryAddress || '',
      PrimaryCity: tenant.PrimaryCity || '',
      PrimaryState: tenant.PrimaryState || '',
      PrimaryZip: tenant.PrimaryZip || '',
      TaxIdNumber: tenant.TaxIdNumber || '',
      TimeZone: tenant.TimeZone || 'America/New_York',
      Description: tenant.Description || ''
    });

    const [errors, setErrors] = useState<Partial<EditTenantData>>({});
    const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);
    const [deactivateLoading, setDeactivateLoading] = useState(false);
    const [deactivateError, setDeactivateError] = useState<string | null>(null);

    const handleConfirmDeactivate = async () => {
      setDeactivateLoading(true);
      setDeactivateError(null);
      const result = await onDeactivate(tenant.TenantId);
      setDeactivateLoading(false);
      if (result.success) {
        setShowDeactivateConfirm(false);
      } else {
        setDeactivateError(result.message || 'Failed to deactivate tenant');
      }
    };

    const handleInputChange = (field: keyof EditTenantData, value: string) => {
      setFormData(prev => ({
        ...prev,
        [field]: value
      }));
      
      if (errors[field]) {
        setErrors(prev => ({
          ...prev,
          [field]: undefined
        }));
      }
    };

    const validateForm = (): boolean => {
      const newErrors: Partial<EditTenantData> = {};

      if (!formData.Name.trim()) newErrors.Name = 'Company name is required';
      if (!formData.ContactEmail.trim()) newErrors.ContactEmail = 'Contact email is required';
      if (formData.ContactEmail && !/\S+@\S+\.\S+/.test(formData.ContactEmail)) {
        newErrors.ContactEmail = 'Please enter a valid email address';
      }

      setErrors(newErrors);
      return Object.keys(newErrors).length === 0;
    };

    const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      if (validateForm()) {
        await onSubmit(formData);
      }
    };

    const timeZones = [
      { value: 'America/New_York', label: 'Eastern Time (ET)' },
      { value: 'America/Chicago', label: 'Central Time (CT)' },
      { value: 'America/Denver', label: 'Mountain Time (MT)' },
      { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
      { value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
      { value: 'Pacific/Honolulu', label: 'Hawaii Time (HST)' }
    ];

    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
          <div className="p-6">
            {/* Header */}
            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center gap-3">
                {tenant.LogoUrl ? (
                  <img
                    src={tenant.LogoUrl}
                    alt={`${tenant.Name} logo`}
                    className="w-10 h-10 rounded-lg object-contain bg-gray-50 p-1"
                    onError={(e) => {
                      // Fallback to initial if logo fails to load
                      const target = e.target as HTMLImageElement;
                      target.style.display = 'none';
                      const fallback = target.nextElementSibling as HTMLElement;
                      if (fallback) fallback.style.display = 'flex';
                    }}
                  />
                ) : null}
                <div 
                  className={`w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold ${tenant.LogoUrl ? 'hidden' : ''}`}
                  style={{ backgroundColor: tenant.PrimaryColorHex || '#1f6db0' }}
                >
                  {tenant.Name.charAt(0)}
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-oe-neutral-dark">Edit Tenant</h2>
                  <p className="text-gray-600 mt-1">Update {tenant.Name} information</p>
                </div>
              </div>
              <button 
                onClick={onClose}
                className="text-gray-400 hover:text-gray-600"
                disabled={loading}
              >
                <X size={24} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Company Information */}
              <div>
                <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Company Information</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Company Name *
                    </label>
                    <input
                      type="text"
                      value={formData.Name}
                      onChange={(e) => handleInputChange('Name', e.target.value)}
                      className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                        errors.Name ? 'border-red-500' : 'border-gray-300'
                      }`}
                      placeholder="Enter company name"
                    />
                    {errors.Name && <p className="text-red-500 text-sm mt-1">{errors.Name}</p>}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Contact Email *
                      </label>
                      <input
                        type="email"
                        value={formData.ContactEmail}
                        onChange={(e) => handleInputChange('ContactEmail', e.target.value)}
                        className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                          errors.ContactEmail ? 'border-red-500' : 'border-gray-300'
                        }`}
                        placeholder="contact@company.com"
                      />
                      {errors.ContactEmail && <p className="text-red-500 text-sm mt-1">{errors.ContactEmail}</p>}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Contact Phone
                      </label>
                      <input
                        type="tel"
                        value={formData.ContactPhone}
                        onChange={(e) => handleInputChange('ContactPhone', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        placeholder="(555) 123-4567"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Website
                    </label>
                    <input
                      type="url"
                      value={formData.Website}
                      onChange={(e) => handleInputChange('Website', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      placeholder="https://www.company.com"
                    />
                  </div>
                </div>
              </div>

              {/* Address Information */}
              <div>
                <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Address Information</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Address
                    </label>
                    <input
                      type="text"
                      value={formData.PrimaryAddress}
                      onChange={(e) => handleInputChange('PrimaryAddress', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      placeholder="123 Main Street"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        City
                      </label>
                      <input
                        type="text"
                        value={formData.PrimaryCity}
                        onChange={(e) => handleInputChange('PrimaryCity', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        placeholder="City"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        State
                      </label>
                      <select
                        value={formData.PrimaryState}
                        onChange={(e) => handleInputChange('PrimaryState', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      >
                        <option value="">Select State</option>
                        {US_STATES.slice(1).map(state => (
                          <option key={state.value} value={state.value}>{state.label}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        ZIP Code
                      </label>
                      <input
                        type="text"
                        value={formData.PrimaryZip}
                        onChange={(e) => handleInputChange('PrimaryZip', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        placeholder="12345"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Additional Details */}
              <div>
                <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Additional Details</h3>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Tax ID Number
                      </label>
                      <input
                        type="text"
                        value={formData.TaxIdNumber}
                        onChange={(e) => handleInputChange('TaxIdNumber', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        placeholder="XX-XXXXXXX"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Time Zone
                      </label>
                      <select
                        value={formData.TimeZone}
                        onChange={(e) => handleInputChange('TimeZone', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      >
                        {timeZones.map(tz => (
                          <option key={tz.value} value={tz.value}>
                            {tz.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Description
                    </label>
                    <textarea
                      value={formData.Description}
                      onChange={(e) => handleInputChange('Description', e.target.value)}
                      rows={3}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      placeholder="Brief description of the company..."
                    />
                  </div>

                </div>
              </div>

              {/* Footer Buttons */}
              <div className="flex flex-col gap-4 pt-6 border-t border-gray-200">
                {tenant.Status === 'Active' && (
                  <div className="flex justify-start">
                    <button
                      type="button"
                      onClick={() => {
                        setDeactivateError(null);
                        setShowDeactivateConfirm(true);
                      }}
                      className="px-4 py-2 text-red-700 border border-red-300 rounded-md hover:bg-red-50 transition-colors text-sm font-medium"
                      disabled={loading || deactivateLoading}
                    >
                      Deactivate tenant
                    </button>
                  </div>
                )}
                <div className="flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                    disabled={loading || deactivateLoading}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading || deactivateLoading}
                    className="px-6 py-2 bg-oe-primary text-white rounded-md hover:bg-oe-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="animate-spin mr-2" size={16} />
                        Updating...
                      </>
                    ) : (
                      <>
                        <Save size={16} className="mr-2" />
                        Update Tenant
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>

        {showDeactivateConfirm && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
            <div className="bg-white rounded-lg max-w-md w-full p-6 shadow-xl">
              <div className="flex items-start gap-3 mb-4">
                <AlertTriangle className="h-6 w-6 text-red-600 shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Deactivate {tenant.Name}?</h3>
                  <p className="text-sm text-gray-600 mt-2">
                    This soft-deletes the organization. It will be hidden from the tenants list unless you
                    use the &quot;Show deactivated tenants&quot; filter. Deactivation is only allowed when
                    there are no active enrollments.
                  </p>
                </div>
              </div>
              {deactivateError && (
                <div className="mb-4 p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-800">
                  {deactivateError}
                </div>
              )}
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowDeactivateConfirm(false);
                    setDeactivateError(null);
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
                  disabled={deactivateLoading}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDeactivate}
                  className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
                  disabled={deactivateLoading}
                >
                  {deactivateLoading ? (
                    <>
                      <Loader2 className="animate-spin inline mr-2" size={16} />
                      Deactivating...
                    </>
                  ) : (
                    'Deactivate tenant'
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // Add Tenant Modal Component
  const AddTenantModal: React.FC<{
    onClose: () => void;
    onSubmit: (data: CreateTenantData) => Promise<void>;
    loading: boolean;
  }> = ({ onClose, onSubmit, loading }) => {
    const [formData, setFormData] = useState<CreateTenantData>({
      Name: '',
      ContactEmail: '',
      ContactPhone: '',
      PrimaryAddress: '',
      PrimaryCity: '',
      PrimaryState: '',
      PrimaryZip: '',
      TaxIdNumber: '',
      BusinessType: 'Corporation',
      Website: '',
      Industry: '',
      Description: '',

      TimeZone: 'America/New_York',
      IsExternal: false
    });

    const [currentStep, setCurrentStep] = useState(1);
    const [errors, setErrors] = useState<Partial<CreateTenantData>>({});
    const [urlPathLoading, setUrlPathLoading] = useState(false);
    const [urlPathError, setUrlPathError] = useState<string | null>(null);
    const [selectedUrlPath, setSelectedUrlPath] = useState<string>('');
    const [urlPathAvailability, setUrlPathAvailability] = useState<boolean | null>(null);
    const [checkingAvailability, setCheckingAvailability] = useState(false);
    const [urlPathDebounceTimer, setUrlPathDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

    const handleInputChange = (field: keyof CreateTenantData, value: string) => {
      setFormData(prev => ({
        ...prev,
        [field]: value
      }));
      
      if (errors[field]) {
        setErrors(prev => ({
          ...prev,
          [field]: undefined
        }));
      }
    };

    // Generate URL path suggestions based on tenant name
    // Generate the best available URL path based on tenant name
    const generateBestUrlPath = async (tenantName: string) => {
      if (!tenantName.trim()) return;
      
      try {
        setUrlPathLoading(true);
        setUrlPathError(null);
        
        const response: any = await apiService.post('/api/tenant-identification/generate-path', {
          tenantName: tenantName.trim()
        });
        
        if (response.success && response.data) {
          const { urlPath, isAvailable } = response.data;
          setSelectedUrlPath(urlPath);
          setFormData(prev => ({ ...prev, DefaultUrlPath: urlPath }));
          setUrlPathAvailability(isAvailable);
          console.log('✅ Generated URL path:', urlPath, 'Available:', isAvailable);
        } else {
          setUrlPathError('Failed to generate URL path');
        }
      } catch (error) {
        console.error('Error generating URL path:', error);
        setUrlPathError('Failed to generate URL path');
      } finally {
        setUrlPathLoading(false);
      }
    };

    // Validate URL path format
    const validateUrlPathFormat = (urlPath: string): string | null => {
      if (!urlPath.trim()) return null;
      
      // Check for valid characters (lowercase letters, numbers, hyphens)
      if (!/^[a-z0-9-]+$/.test(urlPath)) {
        return 'URL path can only contain lowercase letters, numbers, and hyphens';
      }
      
      // Check that it doesn't start or end with hyphen
      if (urlPath.startsWith('-') || urlPath.endsWith('-')) {
        return 'URL path cannot start or end with a hyphen';
      }
      
      // Check minimum length
      if (urlPath.length < 3) {
        return 'URL path must be at least 3 characters long';
      }
      
      // Check maximum length
      if (urlPath.length > 50) {
        return 'URL path cannot exceed 50 characters';
      }
      
      return null;
    };

    // Check if URL path is available
    const checkUrlPathAvailability = async (urlPath: string) => {
      if (!urlPath.trim()) {
        setUrlPathAvailability(null);
        return;
      }

      // First validate format
      const formatError = validateUrlPathFormat(urlPath);
      if (formatError) {
        setUrlPathAvailability(false);
        setErrors(prev => ({ ...prev, DefaultUrlPath: formatError }));
        return;
      }

      try {
        setCheckingAvailability(true);
        const data = await apiService.get<{ success: boolean; data?: { isAvailable: boolean } }>(`/api/tenant-identification/check-availability/${urlPath}`);
        
        if (data.success) {
          setUrlPathAvailability(data.data?.isAvailable ?? false);
          if (data.data?.isAvailable) {
            setErrors(prev => ({ ...prev, DefaultUrlPath: undefined }));
          }
        } else {
          setUrlPathAvailability(false);
        }
      } catch (error) {
        console.error('Error checking URL path availability:', error);
        setUrlPathAvailability(false);
      } finally {
        setCheckingAvailability(false);
      }
    };

    // Debounced URL path availability check
    const debouncedCheckAvailability = (urlPath: string) => {
      if (urlPathDebounceTimer) {
        clearTimeout(urlPathDebounceTimer);
      }
      
      const timer = setTimeout(() => {
        checkUrlPathAvailability(urlPath);
      }, 500); // 500ms delay
      
      setUrlPathDebounceTimer(timer);
    };


    // Cleanup timer on unmount
    React.useEffect(() => {
      return () => {
        if (urlPathDebounceTimer) {
          clearTimeout(urlPathDebounceTimer);
        }
      };
    }, [urlPathDebounceTimer]);

    const validateStep = (step: number): boolean => {
      const newErrors: Partial<CreateTenantData> = {};

      if (step === 1) {
        if (!formData.Name.trim()) newErrors.Name = 'Company name is required';
        if (!formData.ContactEmail.trim()) newErrors.ContactEmail = 'Contact email is required';
        if (formData.ContactEmail && !/\S+@\S+\.\S+/.test(formData.ContactEmail)) {
          newErrors.ContactEmail = 'Please enter a valid email address';
        }
        if (!formData.Industry.trim()) newErrors.Industry = 'Industry is required';
      }

      if (step === 3) {
        if (!formData.DefaultUrlPath?.trim()) newErrors.DefaultUrlPath = 'URL path is required';
        if (formData.DefaultUrlPath && urlPathAvailability === false) {
          newErrors.DefaultUrlPath = 'Selected URL path is not available';
        }
      }

      if (step === 4) {
        // TaxIdNumber is optional, but TimeZone is required
        if (!formData.TimeZone.trim()) newErrors.TimeZone = 'Time zone is required';
      }

      setErrors(newErrors);
      return Object.keys(newErrors).length === 0;
    };

    const handleNext = () => {
      if (validateStep(currentStep)) {
        // Generate URL path when moving to step 3 (Domain)
        if (currentStep === 2 && formData.Name.trim()) {
          generateBestUrlPath(formData.Name);
        }
        setCurrentStep(prev => prev + 1);
      }
    };

    const handleBack = () => {
      setCurrentStep(prev => prev - 1);
    };

    const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
    };

    const businessTypes = [
      'Corporation',
      'LLC',
      'Partnership',
      'Sole Proprietorship',
      'Non-Profit',
      'Other'
    ];

    const industries = [
      'Healthcare',
      'Technology',
      'Manufacturing',
      'Retail',
      'Education',
      'Financial Services',
      'Construction',
      'Hospitality',
      'Transportation',
      'Other'
    ];

    const timeZones = [
      { value: 'America/New_York', label: 'Eastern Time (ET)' },
      { value: 'America/Chicago', label: 'Central Time (CT)' },
      { value: 'America/Denver', label: 'Mountain Time (MT)' },
      { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
      { value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
      { value: 'Pacific/Honolulu', label: 'Hawaii Time (HST)' }
    ];

    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
          <div className="p-6">
            {/* Header */}
            <div className="flex justify-between items-center mb-6">
              <div>
                <h2 className="text-2xl font-bold text-oe-neutral-dark">Add New Tenant</h2>
                <p className="text-gray-600 mt-1">Step {currentStep} of 4</p>
              </div>
              <button 
                onClick={onClose}
                className="text-gray-400 hover:text-gray-600"
                disabled={loading}
              >
                <X size={24} />
              </button>
            </div>

            {/* Progress Bar */}
            <div className="mb-8">
              <div className="flex items-center">
                {[1, 2, 3, 4].map((step) => (
                  <React.Fragment key={step}>
                    <div className="flex flex-col items-center">
                      <div 
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                          currentStep >= step 
                            ? 'bg-oe-primary text-white' 
                            : 'bg-gray-200 text-gray-600'
                        }`}
                      >
                        {step}
                      </div>
                      <span className="mt-2 text-xs text-gray-600 text-center">
                        {step === 1 && 'Company Info'}
                        {step === 2 && 'Address'}
                        {step === 3 && 'Domain'}
                        {step === 4 && 'Additional Details'}
                      </span>
                    </div>
                    {step < 4 && (
                      <div 
                        className={`flex-1 h-1 mx-2 rounded ${
                          currentStep > step ? 'bg-oe-primary' : 'bg-gray-200'
                        }`}
                      />
                    )}
                  </React.Fragment>
                ))}
              </div>
            </div>

            <form onSubmit={handleSubmit}>
              {/* Step 1: Company Information */}
              {currentStep === 1 && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Company Name *
                    </label>
                    <input
                      type="text"
                      value={formData.Name}
                      onChange={(e) => handleInputChange('Name', e.target.value)}
                      className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                        errors.Name ? 'border-red-500' : 'border-gray-300'
                      }`}
                      placeholder="Enter company name"
                    />
                    {errors.Name && <p className="text-red-500 text-sm mt-1">{errors.Name}</p>}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Contact Email *
                      </label>
                      <input
                        type="email"
                        value={formData.ContactEmail}
                        onChange={(e) => handleInputChange('ContactEmail', e.target.value)}
                        className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                          errors.ContactEmail ? 'border-red-500' : 'border-gray-300'
                        }`}
                        placeholder="contact@company.com"
                      />
                      {errors.ContactEmail && <p className="text-red-500 text-sm mt-1">{errors.ContactEmail}</p>}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Contact Phone
                      </label>
                      <input
                        type="tel"
                        value={formData.ContactPhone}
                        onChange={(e) => handleInputChange('ContactPhone', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        placeholder="(555) 123-4567"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Industry *
                      </label>
                      <select
                        value={formData.Industry}
                        onChange={(e) => handleInputChange('Industry', e.target.value)}
                        className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                          errors.Industry ? 'border-red-500' : 'border-gray-300'
                        }`}
                      >
                        <option value="">Select Industry</option>
                        {industries.map(industry => (
                          <option key={industry} value={industry}>{industry}</option>
                        ))}
                      </select>
                      {errors.Industry && <p className="text-red-500 text-sm mt-1">{errors.Industry}</p>}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Business Type
                      </label>
                      <select
                        value={formData.BusinessType}
                        onChange={(e) => handleInputChange('BusinessType', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      >
                        {businessTypes.map(type => (
                          <option key={type} value={type}>{type}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Website
                    </label>
                    <input
                      type="url"
                      value={formData.Website}
                      onChange={(e) => handleInputChange('Website', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      placeholder="https://www.company.com"
                    />
                  </div>
                </div>
              )}

              {/* Step 2: Address Information */}
              {currentStep === 2 && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Primary address
                    </label>
                    <input
                      type="text"
                      value={formData.PrimaryAddress}
                      onChange={(e) => handleInputChange('PrimaryAddress', e.target.value)}
                      className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                        errors.PrimaryAddress ? 'border-red-500' : 'border-gray-300'
                      }`}
                      placeholder="123 Main Street"
                    />
                    {errors.PrimaryAddress && <p className="text-red-500 text-sm mt-1">{errors.PrimaryAddress}</p>}
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        City
                      </label>
                      <input
                        type="text"
                        value={formData.PrimaryCity}
                        onChange={(e) => handleInputChange('PrimaryCity', e.target.value)}
                        className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                          errors.PrimaryCity ? 'border-red-500' : 'border-gray-300'
                        }`}
                        placeholder="City"
                      />
                      {errors.PrimaryCity && <p className="text-red-500 text-sm mt-1">{errors.PrimaryCity}</p>}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        State
                      </label>
                      <select
                        value={formData.PrimaryState}
                        onChange={(e) => handleInputChange('PrimaryState', e.target.value)}
                        className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                          errors.PrimaryState ? 'border-red-500' : 'border-gray-300'
                        }`}
                      >
                        <option value="">Select State</option>
                        {US_STATES.slice(1).map(state => (
                          <option key={state.value} value={state.value}>{state.label}</option>
                        ))}
                      </select>
                      {errors.PrimaryState && <p className="text-red-500 text-sm mt-1">{errors.PrimaryState}</p>}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        ZIP code
                      </label>
                      <input
                        type="text"
                        value={formData.PrimaryZip}
                        onChange={(e) => handleInputChange('PrimaryZip', e.target.value)}
                        className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                          errors.PrimaryZip ? 'border-red-500' : 'border-gray-300'
                        }`}
                        placeholder="12345"
                      />
                      {errors.PrimaryZip && <p className="text-red-500 text-sm mt-1">{errors.PrimaryZip}</p>}
                    </div>
                  </div>
                </div>
              )}

              {/* Step 3: Domain (URL Path) */}
              {currentStep === 3 && (
                <div className="space-y-4">
                  <div>
                    <label className="form-label mb-3">
                      Default URL Path
                    </label>
                    <p className="text-sm text-gray-600 mb-4">
                      This will be the default URL path for your tenant. It's automatically generated based on your company name.
                    </p>
                    
                    <div className="flex items-center gap-2">
                      <div className="flex items-center px-3 py-2 bg-gray-50 border border-gray-300 rounded-l-md text-sm text-gray-700 font-mono">
                        app.allaboard365.com/
                      </div>
                      <input
                        type="text"
                        value={selectedUrlPath}
                        onChange={(e) => {
                          setSelectedUrlPath(e.target.value);
                          setFormData(prev => ({ ...prev, DefaultUrlPath: e.target.value }));
                          debouncedCheckAvailability(e.target.value);
                        }}
                        className={`form-input flex-1 rounded-l-none ${
                          errors.DefaultUrlPath ? 'border-red-500' : ''
                        }`}
                        placeholder="mightywellhealth"
                        disabled={urlPathLoading}
                      />
                      <button
                        type="button"
                        onClick={() => generateBestUrlPath(formData.Name)}
                        disabled={urlPathLoading || !formData.Name.trim()}
                        className="btn-primary flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {urlPathLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    
                    {/* Availability Status */}
                    {selectedUrlPath && (
                      <div className="mt-2 flex items-center gap-2">
                        {checkingAvailability ? (
                          <div className="flex items-center text-gray-500">
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            <span className="text-sm">Checking availability...</span>
                          </div>
                        ) : urlPathAvailability === true ? (
                          <div className="flex items-center text-green-600">
                            <CheckCircle className="h-4 w-4 mr-2" />
                            <span className="text-sm">Available</span>
                          </div>
                        ) : urlPathAvailability === false ? (
                          <div className="flex items-center text-red-600">
                            <XCircle className="h-4 w-4 mr-2" />
                            <span className="text-sm">Not available</span>
                          </div>
                        ) : null}
                      </div>
                    )}
                    
                    {urlPathError && (
                      <div className="mt-2 text-sm text-red-600">
                        {urlPathError}
                      </div>
                    )}
                    
                    {errors.DefaultUrlPath && (
                      <div className="mt-2 text-sm text-red-600">
                        {errors.DefaultUrlPath}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Step 4: Additional Details */}
              {currentStep === 4 && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Tax ID Number
                    </label>
                    <input
                      type="text"
                      value={formData.TaxIdNumber}
                      onChange={(e) => handleInputChange('TaxIdNumber', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      placeholder="XX-XXXXXXX"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Time Zone *
                    </label>
                    <select
                      value={formData.TimeZone}
                      onChange={(e) => handleInputChange('TimeZone', e.target.value)}
                      className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                        errors.TimeZone ? 'border-red-500' : 'border-gray-300'
                      }`}
                    >
                      {timeZones.map(tz => (
                        <option key={tz.value} value={tz.value}>
                          {tz.label}
                        </option>
                      ))}
                    </select>
                    {errors.TimeZone && <p className="text-red-500 text-sm mt-1">{errors.TimeZone}</p>}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Description
                    </label>
                    <textarea
                      value={formData.Description}
                      onChange={(e) => handleInputChange('Description', e.target.value)}
                      rows={3}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      placeholder="Brief description of the company..."
                    />
                  </div>

                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                    <h4 className="text-sm font-medium text-gray-900 mb-1">External billing</h4>
                    <p className="text-xs text-gray-500 mb-3">
                      External tenants use master invoicing without member-level NACHA or commission processing.
                      Merchant Setup will be hidden and locked.
                    </p>
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        id="createTenantIsExternal"
                        checked={!!formData.IsExternal}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            IsExternal: e.target.checked
                          }))
                        }
                        className="w-4 h-4 text-oe-primary bg-gray-100 border-gray-300 rounded focus:ring-oe-primary flex-shrink-0 mt-0.5"
                        disabled={loading}
                      />
                      <div>
                        <label htmlFor="createTenantIsExternal" className="text-sm font-medium text-gray-900 cursor-pointer">
                          External billing tenant
                        </label>
                        <p className="text-xs text-gray-500 mt-1">
                          Enable for vendor-style tenants billed outside OpenEnroll. Leave unchecked for standard
                          tenants that collect member payments through Merchant Setup.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}


              {/* Footer Buttons */}
              <div className="flex justify-between mt-8 pt-6 border-t border-gray-200">
                <div>
                  {currentStep > 1 && (
                    <button
                      type="button"
                      onClick={handleBack}
                      className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                      disabled={loading}
                    >
                      Back
                    </button>
                  )}
                </div>

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                    disabled={loading}
                  >
                    Cancel
                  </button>

                  {currentStep < 4 ? (
                    <button
                      type="button"
                      onClick={handleNext}
                      className="btn-primary"
                    >
                      Next
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.preventDefault();
                        const isValid = validateStep(4);
                        if (isValid) {
                          await onSubmit(formData);
                        } else {
                          // Scroll to first error
                          const firstErrorField = document.querySelector('.border-red-500');
                          if (firstErrorField) {
                            firstErrorField.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          }
                        }
                      }}
                      disabled={loading}
                      className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                    >
                      {loading ? (
                        <>
                          <Loader2 className="animate-spin mr-2" size={16} />
                          Creating...
                        </>
                      ) : (
                        'Create Tenant'
                      )}
                    </button>
                  )}
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  };

  // Add Tenant Admin Modal Component
  const AddTenantAdminModal: React.FC<{
    tenants: ExtendedTenant[];
    onClose: () => void;
    onSubmit: (data: { tenantId: string; email: string; firstName: string; lastName: string }) => void;
    loading: boolean;
  }> = ({ tenants, onClose, onSubmit, loading }) => {
    const [formData, setFormData] = useState({
      tenantId: '',
      email: '',
      firstName: '',
      lastName: ''
    });
    const [searchTerm, setSearchTerm] = useState('');
    const [errors, setErrors] = useState<Record<string, string>>({});

    // Filter tenants based on search term
    const filteredTenants = tenants.filter(tenant =>
      tenant.Name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      tenant.ContactEmail.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      
      // Validation
      const newErrors: Record<string, string> = {};
      if (!formData.tenantId) newErrors.tenantId = 'Please select a tenant';
      if (!formData.email) newErrors.email = 'Email is required';
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) newErrors.email = 'Please enter a valid email';
      if (!formData.firstName.trim()) newErrors.firstName = 'First name is required';
      if (!formData.lastName.trim()) newErrors.lastName = 'Last name is required';

      if (Object.keys(newErrors).length > 0) {
        setErrors(newErrors);
        return;
      }

      onSubmit(formData);
    };

    const handleInputChange = (field: string, value: string) => {
      setFormData(prev => ({ ...prev, [field]: value }));
      if (errors[field]) {
        setErrors(prev => ({ ...prev, [field]: '' }));
      }
    };

    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-gray-900">Add Tenant Admin</h2>
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-6">
            {/* Tenant Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Select Tenant *
              </label>
              <div className="space-y-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                  <input
                    type="text"
                    placeholder="Search tenants..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>
                
                <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg">
                  {filteredTenants.length === 0 ? (
                    <div className="p-4 text-center text-gray-500">
                      No tenants found
                    </div>
                  ) : (
                    filteredTenants.map((tenant) => (
                      <div
                        key={tenant.TenantId}
                        className={`p-3 cursor-pointer hover:bg-gray-50 border-b border-gray-100 last:border-b-0 ${
                          formData.tenantId === tenant.TenantId ? 'bg-blue-50 border-blue-200' : ''
                        }`}
                        onClick={() => handleInputChange('tenantId', tenant.TenantId)}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="font-medium text-gray-900">{tenant.Name}</div>
                            <div className="text-sm text-gray-500">{tenant.ContactEmail}</div>
                          </div>
                          {formData.tenantId === tenant.TenantId && (
                            <CheckCircle className="w-5 h-5 text-oe-primary" />
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
                {errors.tenantId && (
                  <p className="text-red-500 text-sm">{errors.tenantId}</p>
                )}
              </div>
            </div>

            {/* Admin Details */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  First Name *
                </label>
                <input
                  type="text"
                  value={formData.firstName}
                  onChange={(e) => handleInputChange('firstName', e.target.value)}
                  className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                    errors.firstName ? 'border-red-300' : 'border-gray-300'
                  }`}
                  placeholder="Enter first name"
                />
                {errors.firstName && (
                  <p className="text-red-500 text-sm mt-1">{errors.firstName}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Last Name *
                </label>
                <input
                  type="text"
                  value={formData.lastName}
                  onChange={(e) => handleInputChange('lastName', e.target.value)}
                  className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                    errors.lastName ? 'border-red-300' : 'border-gray-300'
                  }`}
                  placeholder="Enter last name"
                />
                {errors.lastName && (
                  <p className="text-red-500 text-sm mt-1">{errors.lastName}</p>
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email Address *
              </label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => handleInputChange('email', e.target.value)}
                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                  errors.email ? 'border-red-300' : 'border-gray-300'
                }`}
                placeholder="Enter email address"
              />
              {errors.email && (
                <p className="text-red-500 text-sm mt-1">{errors.email}</p>
              )}
              <p className="text-gray-500 text-sm mt-1">
                An invitation email will be sent to this address with instructions to set up their account.
              </p>
            </div>

            {/* Action Buttons */}
            <div className="flex justify-end space-x-3 pt-4 border-t border-gray-200">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              >
                {loading ? (
                  <>
                    <Loader2 className="animate-spin mr-2" size={16} />
                    Sending Invitation...
                  </>
                ) : (
                  <>
                    <Mail size={16} className="mr-2" />
                    Send Invitation
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar Navigation */}
      {/* <AdminNavigation 
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
      /> */}
      
      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <SharedHeader 
          title="Tenant Management"
          showSearch={true}
          showNotifications={true}
          searchValue={filters.search}
          onSearch={(query) => handleFilterChange('search', query)}
        />
        
        {/* Content */}
        <div className="flex-1 overflow-auto">
          <div className="p-6">
            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-500">Total Tenants</p>
                    <p className="text-2xl font-bold">{metrics.totalTenants}</p>
                  </div>
                  <div className="bg-oe-primary p-3 rounded-full text-white">
                    <Building size={24} />
                  </div>
                </div>
                <div className="text-sm mt-2">
                  <span className="text-oe-success">+{metrics.tenantsChange}</span>
                  <span className="text-gray-500 ml-1">from last month</span>
                </div>
              </div>
              
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-500">Active Tenants</p>
                    <p className="text-2xl font-bold">{metrics.activeTenants}</p>
                  </div>
                  <div className="bg-oe-success p-3 rounded-full text-white">
                    <Activity size={24} />
                  </div>
                </div>
                <div className="text-sm mt-2">
                  <span className="text-oe-success">+{metrics.activeChange}</span>
                  <span className="text-gray-500 ml-1">from last month</span>
                </div>
              </div>
              
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-500">Total Revenue</p>
                    <p className="text-2xl font-bold">{formatLargeCurrency(metrics.totalRevenue)}</p>
                  </div>
                  <div className="bg-purple-500 p-3 rounded-full text-white">
                    <DollarSign size={24} />
                  </div>
                </div>
                <div className="text-sm mt-2">
                  <span className="text-oe-success">+{metrics.revenueChange}%</span>
                  <span className="text-gray-500 ml-1">from last month</span>
                </div>
              </div>
              
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-500">Avg. Revenue</p>
                    <p className="text-2xl font-bold">{formatLargeCurrency(metrics.avgRevenue)}</p>
                  </div>
                  <div className="bg-orange-500 p-3 rounded-full text-white">
                    <TrendingUp size={24} />
                  </div>
                </div>
                <div className="text-sm mt-2">
                  <span className="text-oe-success">+{metrics.avgRevenueChange}%</span>
                  <span className="text-gray-500 ml-1">from last month</span>
                </div>
              </div>
            </div>

            {/* Toolbar */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setShowFilters(!showFilters)}
                  className="flex items-center px-4 py-2 border border-gray-300 rounded-md hover:bg-oe-neutral-light transition-colors"
                >
                  <Filter size={16} className="mr-2" />
                  Filters
                </button>
                
                <div className="flex items-center border border-gray-300 rounded-md">
                  <button
                    onClick={() => setViewMode('grid')}
                    className={`p-2 ${viewMode === 'grid' ? 'bg-oe-primary text-white' : 'text-gray-600 hover:bg-oe-neutral-light'}`}
                  >
                    <Grid size={16} />
                  </button>
                  <button
                    onClick={() => setViewMode('list')}
                    className={`p-2 ${viewMode === 'list' ? 'bg-oe-primary text-white' : 'text-gray-600 hover:bg-oe-neutral-light'}`}
                  >
                    <List size={16} />
                  </button>
                </div>
              </div>
              
              <div className="flex items-center gap-4">
                <span className="text-sm text-gray-600">
                  {filteredTenants.length} tenants found
                </span>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setShowAddModal(true)}
                    className="bg-oe-primary text-white px-4 py-2 rounded-md hover:bg-oe-dark transition-colors flex items-center"
                  >
                    <Plus size={16} className="mr-2" />
                    Add Tenant
                  </button>
                  <button 
                    onClick={() => setShowAddTenantAdminModal(true)}
                    className="bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-700 transition-colors flex items-center"
                  >
                    <Users size={16} className="mr-2" />
                    Add Tenant Admin
                  </button>
                </div>
              </div>
            </div>

            {/* Filters Panel */}
            {showFilters && (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                    <select
                      value={filters.status}
                      onChange={(e) => handleFilterChange('status', e.target.value)}
                      disabled={filters.showDeactivated}
                      className="w-full form-input focus:outline-none focus:ring-2 focus:ring-oe-primary disabled:bg-gray-100 disabled:text-gray-500"
                    >
                      <option value="">All Statuses</option>
                      <option value="Active">Active</option>
                      <option value="Suspended">Suspended</option>
                      <option value="Pending">Pending</option>
                    </select>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                    <select
                      value={filters.state}
                      onChange={(e) => handleFilterChange('state', e.target.value)}
                      className="w-full form-input focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    >
                      {US_STATES.map(state => (
                        <option key={state.value} value={state.value}>
                          {state.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Member Range</label>
                    <select
                      value={filters.memberRange}
                      onChange={(e) => handleFilterChange('memberRange', e.target.value)}
                      className="w-full form-input focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    >
                      <option value="">All Sizes</option>
                      <option value="small">Small (&lt; 500)</option>
                      <option value="medium">Medium (500-999)</option>
                      <option value="large">Large (1000+)</option>
                    </select>
                  </div>
                  
                  <div className="flex items-end">
                    <label className="flex items-center gap-2 w-full px-3 py-2 border border-gray-300 rounded-md cursor-pointer hover:bg-oe-neutral-light">
                      <input
                        type="checkbox"
                        checked={filters.showDeactivated}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setFilters((prev) => ({
                            ...prev,
                            showDeactivated: checked,
                            status: checked ? 'Inactive' : ''
                          }));
                        }}
                        className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                      />
                      <span className="text-sm text-gray-700">Show deactivated tenants</span>
                    </label>
                  </div>

                  <div className="flex items-end">
                    <button
                      onClick={() => setFilters({
                        search: '',
                        status: '',
                        state: '',
                        memberRange: '',
                        showDeactivated: false
                      })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-md hover:bg-oe-neutral-light transition-colors"
                    >
                      Clear Filters
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Tenants Display */}
            {loading ? (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="animate-spin text-oe-primary mr-2" size={24} />
                <span className="text-lg text-gray-600">Loading tenants...</span>
              </div>
            ) : error ? (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-800">
                {error}
                <button 
                  onClick={fetchTenants}
                  className="ml-4 text-red-600 hover:text-red-700 underline"
                >
                  Try Again
                </button>
              </div>
            ) : (
              <div className={
                viewMode === 'grid' 
                  ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
                  : "space-y-4"
              }>
                {filteredTenants.map((tenant) => (
                  viewMode === 'grid' 
                    ? <TenantCard key={tenant.TenantId} tenant={tenant} />
                    : <TenantListItem key={tenant.TenantId} tenant={tenant} />
                ))}
              </div>
            )}

            {filteredTenants.length === 0 && !loading && !error && (
              <div className="text-center py-12">
                <Building size={48} className="mx-auto text-gray-400 mb-4" />
                <h3 className="text-lg font-medium text-oe-neutral-dark mb-2">
                  {filters.showDeactivated ? 'No deactivated tenants' : 'No tenants found'}
                </h3>
                <p className="text-gray-600">
                  {filters.showDeactivated
                    ? 'No organizations have been deactivated yet.'
                    : 'Try adjusting your filters or search terms.'}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Advanced Configuration Modal */}
      {showAdvancedConfig && advancedConfigTenant && (
        <UnifiedTenantSettingsModal
          tenant={advancedConfigTenant}
          onClose={handleCloseAdvancedConfig}
          onSave={fetchTenants}
          setError={setError}
        />
      )}

      {/* Tenant Details Modal */}
      {showDetailsModal && selectedTenant && (
        <TenantDetails
          tenant={selectedTenant}
          onClose={handleCloseDetails}
          onEdit={() => {
            setShowDetailsModal(false);
            setShowEditModal(true);
          }}
          formatCurrency={formatCurrency}
        />
      )}

      {/* Edit Tenant Modal */}
      {showEditModal && selectedTenant && (
        <EditTenantModal
          tenant={selectedTenant}
          onClose={() => {
            setShowEditModal(false);
            setSelectedTenant(null);
          }}
          onSubmit={handleEditTenant}
          onDeactivate={handleDeactivateTenant}
          loading={editTenantLoading}
        />
      )}

      {/* Add Tenant Modal */}
      {showAddModal && (
        <AddTenantModal
          onClose={() => setShowAddModal(false)}
          onSubmit={handleCreateTenant}
          loading={addTenantLoading}
        />
      )}

      {/* Add Tenant Admin Modal */}
      {showAddTenantAdminModal && (
        <AddTenantAdminModal
          tenants={tenants}
          onClose={() => setShowAddTenantAdminModal(false)}
          onSubmit={handleCreateTenantAdmin}
          loading={addTenantAdminLoading}
        />
      )}

      {tenantUsersModalTenant && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-lg shadow-xl max-w-5xl w-full max-h-[92vh] overflow-hidden flex flex-col border border-gray-200">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 flex-shrink-0">
              <h2 className="text-lg font-semibold text-gray-900">Tenant admins</h2>
              <button
                type="button"
                onClick={handleCloseTenantUsersModal}
                className="text-gray-400 hover:text-gray-600 p-1 rounded-lg"
                aria-label="Close"
              >
                <X size={22} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              <TenantUserManagementPanel
                tenantId={tenantUsersModalTenant.TenantId}
                subtitle={tenantUsersModalTenant.Name}
                className="p-4 space-y-4"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminTenants;
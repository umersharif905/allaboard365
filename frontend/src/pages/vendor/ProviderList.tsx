// pages/vendor/ProviderList.tsx
// Provider Management List for Vendor Portal

import { useEffect, useState, useCallback } from 'react';
import {
  Search, 
  Plus, 
  ChevronLeft, 
  ChevronRight,
  Edit2,
  Building2,
  Phone,
  Mail,
  X,
  Save,
  MessageSquare,
  Star,
  Upload,
  Link as LinkIcon
} from 'lucide-react';
import { apiService } from '../../services/api.service';
import Skeleton from '../../components/vendor/ui/Skeleton';
import { 
  Provider,
  ProviderListResponse,
  ProviderFilters
} from '../../types/shareRequest.types';
import {
  ProviderFAPSummary,
  FAPSubmission,
  FAPDocument,
  FAPNote,
  ProviderRanking
} from '../../types/fap.types';
import FAPSubmissionsSection from '../../components/fap/FAPSubmissionsSection';
import FAPDocumentsSection from '../../components/fap/FAPDocumentsSection';
import FAPNotesSection from '../../components/fap/FAPNotesSection';
import FAPRankingsSection from '../../components/fap/FAPRankingsSection';

const ProviderList = () => {
  // const navigate = useNavigate(); // Not needed - FAP is inline now
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0
  });
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeModalTab, setActiveModalTab] = useState<'overview' | 'fapLinks' | 'documents' | 'notes' | 'ranking'>('overview');
  
  // FAP Management state (for modal)
  const [modalFapData, setModalFapData] = useState<{
    summary?: ProviderFAPSummary;
    submissions?: FAPSubmission[];
    documents?: FAPDocument[];
    notes?: FAPNote[];
    ranking?: ProviderRanking;
  }>({});
  const [loadingModalFap, setLoadingModalFap] = useState(false);
  
  // Filter state
  const [filters, setFilters] = useState<ProviderFilters>({
    search: '',
    providerType: '',
    isActive: true,
    page: 1,
    limit: 25
  });

  // Form state
  const [formData, setFormData] = useState({
    providerName: '',
    providerType: '',
    npi: '',
    phone: '',
    fax: '',
    email: '',
    address1: '',
    address2: '',
    city: '',
    state: '',
    zipCode: '',
    specialty: '',
    isActive: true
  });

  // NPI lookup state
  const [lookingUpNPI, setLookingUpNPI] = useState(false);
  const [npiLookupError, setNpiLookupError] = useState('');
  const [npiSearchFields, setNpiSearchFields] = useState({
    organizationName: '',
    lastName: '',
    city: '',
    state: ''
  });
  const [npiSearchResults, setNpiSearchResults] = useState<any[]>([]);
  const [searchingNPI, setSearchingNPI] = useState(false);

  const providerTypes = [
    'Hospital',
    'Physician',
    'Clinic',
    'Lab',
    'Pharmacy',
    'Specialist',
    'Urgent Care',
    'Emergency Room',
    'Imaging Center',
    'Surgery Center',
    'Other'
  ];

  const loadProviders = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const params = new URLSearchParams();
      if (filters.search) params.set('search', filters.search);
      if (filters.providerType) params.set('providerType', filters.providerType);
      if (filters.isActive !== undefined) params.set('isActive', String(filters.isActive));
      params.set('page', String(filters.page || 1));
      params.set('limit', String(filters.limit || 25));
      
      const response = await apiService.get<ProviderListResponse>(
        `/api/me/vendor/providers?${params.toString()}`
      );
      
      if (response.success) {
        setProviders(response.data);
        setPagination(response.pagination);
      } else {
        setError('Failed to load providers');
      }
    } catch (err: any) {
      console.error('Error loading providers:', err);
      setError(err.message || 'Failed to load providers');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);


  const handleSearch = (value: string) => {
    setFilters(prev => ({ ...prev, search: value, page: 1 }));
  };

  const handleFilterChange = (key: keyof ProviderFilters, value: any) => {
    setFilters(prev => ({ ...prev, [key]: value, page: 1 }));
  };

  // NPI Lookup function
  const lookupNPI = async (npiNumber: string) => {
    if (!/^\d{10}$/.test(npiNumber)) {
      setNpiLookupError('NPI must be exactly 10 digits');
      return;
    }
    
    setLookingUpNPI(true);
    setNpiLookupError('');
    
    try {
      const response = await apiService.get<{ success: boolean; data: any; message?: string }>(
        `/api/me/vendor/npi/lookup/${npiNumber}`
      );
      
      if (response.success && response.data) {
        setFormData({
          ...formData,
          providerName: response.data.providerName || '',
          providerType: response.data.providerType || '',
          npi: response.data.npi || npiNumber,
          phone: response.data.phone || '',
          fax: response.data.fax || '',
          email: '',
          address1: response.data.address1 || '',
          address2: response.data.address2 || '',
          city: response.data.city || '',
          state: response.data.state || '',
          zipCode: response.data.zipCode || '',
          specialty: response.data.specialty || '',
          isActive: true
        });
        setNpiLookupError('');
      } else {
        setNpiLookupError(response.message || 'NPI not found in registry');
      }
    } catch (err: any) {
      console.error('Error looking up NPI:', err);
      setNpiLookupError(err.message || 'Failed to lookup NPI');
    } finally {
      setLookingUpNPI(false);
    }
  };

  // Search NPI Registry
  const searchNPIRegistry = async () => {
    const { organizationName, lastName, city, state } = npiSearchFields;
    
    if (!organizationName && !lastName) {
      setNpiLookupError('Please enter an Organization Name or Last Name');
      return;
    }
    
    setSearchingNPI(true);
    setNpiLookupError('');
    
    try {
      const params = new URLSearchParams();
      if (organizationName) params.append('organizationName', organizationName);
      if (lastName) params.append('lastName', lastName);
      if (city) params.append('city', city);
      if (state) params.append('state', state);
      params.append('limit', '30');
      
      const response = await apiService.get<{ success: boolean; data: any[] }>(
        `/api/me/vendor/npi/search?${params.toString()}`
      );
      
      if (response.success) {
        setNpiSearchResults(response.data || []);
        if (response.data.length === 0) {
          setNpiLookupError('No providers found matching your search criteria');
        }
      }
    } catch (err) {
      console.error('Error searching NPI Registry:', err);
      setNpiSearchResults([]);
      setNpiLookupError('Failed to search NPI Registry');
    } finally {
      setSearchingNPI(false);
    }
  };

  // Select an NPI result
  const selectNPIResult = (result: any) => {
    setFormData({
      ...formData,
      providerName: result.providerName || '',
      providerType: result.providerType || '',
      npi: result.npi || '',
      phone: result.phone || '',
      fax: result.fax || '',
      email: '',
      address1: result.address1 || '',
      address2: result.address2 || '',
      city: result.city || '',
      state: result.state || '',
      zipCode: result.zipCode || '',
      specialty: result.specialty || '',
      isActive: true
    });
    setNpiSearchResults([]);
    setNpiSearchFields({
      organizationName: '',
      lastName: '',
      city: '',
      state: ''
    });
  };

  const resetModal = () => {
    setShowModal(false);
    setEditingProvider(null);
    setActiveModalTab('overview');
    setModalFapData({});
    setLoadingModalFap(false);
    setNpiLookupError('');
    setNpiSearchResults([]);
    setNpiSearchFields({
      organizationName: '',
      lastName: '',
      city: '',
      state: ''
    });
    setFormData({
      providerName: '',
      providerType: '',
      npi: '',
      phone: '',
      fax: '',
      email: '',
      address1: '',
      address2: '',
      city: '',
      state: '',
      zipCode: '',
      specialty: '',
      isActive: true
    });
  };

  const openCreateModal = () => {
    setEditingProvider(null);
    setNpiLookupError('');
    setNpiSearchResults([]);
    setNpiSearchFields({
      organizationName: '',
      lastName: '',
      city: '',
      state: ''
    });
    setFormData({
      providerName: '',
      providerType: '',
      npi: '',
      phone: '',
      fax: '',
      email: '',
      address1: '',
      address2: '',
      city: '',
      state: '',
      zipCode: '',
      specialty: '',
      isActive: true
    });
    setShowModal(true);
  };

  const openEditModal = async (provider: Provider) => {
    setEditingProvider(provider);
    setNpiLookupError('');
    setNpiSearchResults([]);
    setFormData({
      providerName: provider.ProviderName,
      providerType: provider.ProviderType || '',
      npi: provider.NPI || '',
      phone: provider.Phone || '',
      fax: (provider as any).Fax || '',
      email: provider.Email || '',
      address1: provider.Address1 || '',
      address2: (provider as any).Address2 || '',
      city: provider.City || '',
      state: provider.State || '',
      zipCode: provider.ZipCode || '',
      specialty: (provider as any).Specialty || '',
      isActive: provider.IsActive
    });
    setActiveModalTab('overview');
    setShowModal(true);
    
    // Load FAP data for this provider
    await loadModalFAPData(provider.ProviderId);
  };

  // Load FAP data for modal
  const loadModalFAPData = async (providerId: string) => {
    if (loadingModalFap) return;
    
    setLoadingModalFap(true);
    
    try {
      const [summaryRes, submissionsRes, documentsRes, notesRes] = await Promise.allSettled([
        apiService.get<{ success: boolean; data: ProviderFAPSummary }>(
          `/api/me/vendor/providers/${providerId}/fap/summary`
        ),
        apiService.get<{ success: boolean; data: FAPSubmission[]; pagination: any }>(
          `/api/me/vendor/providers/${providerId}/fap/submissions`
        ),
        apiService.get<{ success: boolean; data: FAPDocument[] }>(
          `/api/me/vendor/providers/${providerId}/fap/documents`
        ),
        apiService.get<{ success: boolean; data: FAPNote[] }>(
          `/api/me/vendor/providers/${providerId}/fap/notes`
        )
        // Rankings are loaded directly by FAPRankingsSection component
      ]);

      const newFapData: any = {};
      
      if (summaryRes.status === 'fulfilled' && summaryRes.value.success) {
        newFapData.summary = summaryRes.value.data;
      }
      if (submissionsRes.status === 'fulfilled' && submissionsRes.value.success) {
        newFapData.submissions = submissionsRes.value.data;
      }
      if (documentsRes.status === 'fulfilled' && documentsRes.value.success) {
        newFapData.documents = documentsRes.value.data;
      }
      if (notesRes.status === 'fulfilled' && notesRes.value.success) {
        newFapData.notes = notesRes.value.data;
      }
      // Rankings are loaded directly by FAPRankingsSection component
      
      setModalFapData(newFapData);
    } catch (err: any) {
      console.error('Error loading FAP data:', err);
    } finally {
      setLoadingModalFap(false);
    }
  };

  const handleSubmit = async () => {
    if (!formData.providerName?.trim()) {
      alert('Provider name is required');
      return;
    }

    try {
      setSaving(true);
      
      if (editingProvider) {
        await apiService.put(`/api/me/vendor/providers/${editingProvider.ProviderId}`, formData);
      } else {
        await apiService.post('/api/me/vendor/providers', formData);
      }
      
      await loadProviders();
      resetModal();
    } catch (err: any) {
      console.error('Error saving provider:', err);
      
      // Extract the best error message from the response
      let errorMsg = 'Failed to save provider';
      
      if (err.response?.data) {
        // Server returned an error response
        errorMsg = err.response.data.message || err.response.data.error || errorMsg;
      } else if (err.message) {
        errorMsg = err.message;
      }
      
      // Show the error
      alert(errorMsg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Providers</h1>
          <p className="text-gray-600">Manage healthcare provider directory</p>
        </div>
        <button
          onClick={openCreateModal}
          className="btn-primary flex items-center"
        >
          <Plus className="h-5 w-5 mr-2" />
          Add Provider
        </button>
      </div>

      {/* Search and Filters */}
      <div className="bg-white rounded-lg border border-gray-200 mb-6">
        <div className="p-4">
          <div className="flex items-center gap-4">
            {/* Search */}
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
              <input
                type="text"
                placeholder="Search by name, NPI, or location..."
                value={filters.search}
                onChange={(e) => handleSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
            </div>
            
            {/* Provider Type Filter */}
            <select
              value={filters.providerType || ''}
              onChange={(e) => handleFilterChange('providerType', e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
            >
              <option value="">All Types</option>
              {providerTypes.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>

            {/* Active Filter */}
            <select
              value={filters.isActive === undefined ? '' : String(filters.isActive)}
              onChange={(e) => handleFilterChange('isActive', e.target.value === '' ? undefined : e.target.value === 'true')}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
            >
              <option value="true">Active</option>
              <option value="false">Inactive</option>
              <option value="">All</option>
            </select>
          </div>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p className="text-red-800">{error}</p>
          <button
            onClick={loadProviders}
            className="mt-2 text-red-600 hover:text-red-800 font-medium"
          >
            Try again
          </button>
        </div>
      )}

      {/* Providers Grid */}
      <div className="bg-white rounded-lg border border-gray-200">
        {loading ? (
          <div className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="bg-gray-50 rounded-lg p-4 space-y-2">
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-4 w-1/2 mb-2" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ))}
            </div>
          </div>
        ) : providers.length === 0 ? (
          <div className="p-12 text-center">
            <Building2 className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 text-lg font-medium">No providers found</p>
            <p className="text-gray-400 text-sm mt-1">
              {filters.search || filters.providerType ? 'Try adjusting your filters' : 'Add your first provider to get started'}
            </p>
            {!filters.search && !filters.providerType && (
              <button
                onClick={openCreateModal}
                className="btn-primary mt-4 inline-flex items-center"
              >
                <Plus className="h-5 w-5 mr-2" />
                Add Provider
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="p-6">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {providers.map((provider) => {
                  return (
                    <div
                      key={provider.ProviderId}
                      onClick={() => openEditModal(provider)}
                      className={`bg-white rounded-lg border ${
                        provider.IsActive ? 'border-gray-200' : 'border-gray-300 opacity-60'
                      } hover:border-oe-primary hover:shadow-md transition-all cursor-pointer`}
                    >
                      {/* Provider Card Header */}
                      <div className="p-4">
                        <div className="flex justify-between items-start mb-3">
                          <div className="flex-1">
                            <div className="font-medium text-gray-900">
                              {provider.ProviderName}
                            </div>
                            <div className="text-sm text-gray-600">{provider.ProviderType || 'Provider'}</div>
                            {(provider.City || provider.State) && (
                              <div className="text-xs text-gray-500 mt-1">
                                {provider.City}{provider.City && provider.State ? ', ' : ''}{provider.State}
                              </div>
                            )}
                          </div>
                          <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => openEditModal(provider)}
                              className="p-1 text-gray-400 hover:text-oe-primary"
                              title="Edit Provider"
                            >
                              <Edit2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        
                        {/* Quick Info */}
                        <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
                          {provider.Phone && (
                            <div className="flex items-center text-gray-600">
                              <Phone className="h-3 w-3 mr-1 text-gray-400" />
                              {provider.Phone}
                            </div>
                          )}
                          {provider.Email && (
                            <div className="flex items-center text-gray-600">
                              <Mail className="h-3 w-3 mr-1 text-gray-400" />
                              <span className="truncate">{provider.Email}</span>
                            </div>
                          )}
                          {provider.NPI && (
                            <div className="text-gray-500 font-mono">
                              NPI: {provider.NPI}
                            </div>
                          )}
                          {!provider.IsActive && (
                            <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-gray-200 text-gray-600">
                              Inactive
                            </span>
                          )}
                        </div>


                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Pagination */}
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="text-sm text-gray-700">
                  Showing <span className="font-medium">{((pagination.page - 1) * pagination.limit) + 1}</span> to{' '}
                  <span className="font-medium">
                    {Math.min(pagination.page * pagination.limit, pagination.total)}
                  </span>{' '}
                  of <span className="font-medium">{pagination.total}</span> providers
                </div>
                
                {/* Page Size Selector */}
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">Show:</span>
                  <select
                    value={filters.limit}
                    onChange={(e) => setFilters(prev => ({ ...prev, limit: parseInt(e.target.value), page: 1 }))}
                    className="px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-oe-primary"
                  >
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </div>
              </div>
              
              {pagination.totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setFilters(prev => ({ ...prev, page: (prev.page || 1) - 1 }))}
                    disabled={pagination.page <= 1}
                    className="p-2 border border-gray-300 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  
                  <span className="px-4 py-2 text-sm text-gray-700">
                    Page {pagination.page} of {pagination.totalPages}
                  </span>
                  
                  <button
                    onClick={() => setFilters(prev => ({ ...prev, page: (prev.page || 1) + 1 }))}
                    disabled={pagination.page >= pagination.totalPages}
                    className="p-2 border border-gray-300 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Add/Edit Provider Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-4xl h-[85vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-medium text-gray-900">
                {editingProvider ? `Provider Details: ${editingProvider.ProviderName}` : 'Add Provider'}
              </h3>
              <button
                onClick={resetModal}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            
            {/* Tabs - Only show when editing */}
            {editingProvider && (
              <div className="border-b border-gray-200 px-6">
                <div className="flex gap-1">
                  <button
                    onClick={() => setActiveModalTab('overview')}
                    className={`py-3 px-4 border-b-2 font-medium text-sm transition-colors ${
                      activeModalTab === 'overview'
                        ? 'border-oe-primary text-oe-primary'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    Provider Overview
                  </button>
                  <button
                    onClick={() => setActiveModalTab('fapLinks')}
                    className={`py-3 px-4 border-b-2 font-medium text-sm transition-colors flex items-center gap-2 ${
                      activeModalTab === 'fapLinks'
                        ? 'border-oe-primary text-oe-primary'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    <LinkIcon className="h-4 w-4" />
                    FAP Links
                  </button>
                  <button
                    onClick={() => setActiveModalTab('documents')}
                    className={`py-3 px-4 border-b-2 font-medium text-sm transition-colors flex items-center gap-2 ${
                      activeModalTab === 'documents'
                        ? 'border-oe-primary text-oe-primary'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    <Upload className="h-4 w-4" />
                    Documents
                  </button>
                  <button
                    onClick={() => setActiveModalTab('notes')}
                    className={`py-3 px-4 border-b-2 font-medium text-sm transition-colors flex items-center gap-2 ${
                      activeModalTab === 'notes'
                        ? 'border-oe-primary text-oe-primary'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    <MessageSquare className="h-4 w-4" />
                    Notes
                  </button>
                  <button
                    onClick={() => setActiveModalTab('ranking')}
                    className={`py-3 px-4 border-b-2 font-medium text-sm transition-colors flex items-center gap-2 ${
                      activeModalTab === 'ranking'
                        ? 'border-oe-primary text-oe-primary'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    <Star className="h-4 w-4" />
                    Ranking
                  </button>
                </div>
              </div>
            )}
            
            <div className="p-6 overflow-y-auto flex-1 space-y-4 min-h-0">
              {/* Overview Tab Content */}
              {activeModalTab === 'overview' && (
                <>
              {/* NPI Lookup Section - only for new providers */}
              {!editingProvider && (
                <div className="bg-oe-light border border-oe-primary/30 rounded-lg p-4 mb-4">
                  <label className="block text-sm font-medium text-oe-primary mb-2">
                    🔍 Lookup from NPI Registry
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={formData.npi}
                      onChange={(e) => setFormData({ ...formData, npi: e.target.value.replace(/\D/g, '').slice(0, 10) })}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="Enter 10-digit NPI number"
                      maxLength={10}
                    />
                    <button
                      type="button"
                      onClick={() => lookupNPI(formData.npi)}
                      disabled={lookingUpNPI || formData.npi.length !== 10}
                      className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 whitespace-nowrap"
                    >
                      {lookingUpNPI ? 'Looking up...' : 'Lookup NPI'}
                    </button>
                  </div>
                  {npiLookupError && (
                    <p className="text-sm text-red-600 mt-2">{npiLookupError}</p>
                  )}
                  
                  {/* NPI Search Section */}
                  <div className="mt-3 pt-3 border-t border-oe-primary/30">
                    <label className="block text-sm font-medium text-oe-primary mb-2">Or search NPI Registry:</label>
                    
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Organization Name</label>
                        <input
                          type="text"
                          value={npiSearchFields.organizationName}
                          onChange={(e) => setNpiSearchFields({ ...npiSearchFields, organizationName: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          placeholder="e.g., Baptist Hospital"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Last Name</label>
                        <input
                          type="text"
                          value={npiSearchFields.lastName}
                          onChange={(e) => setNpiSearchFields({ ...npiSearchFields, lastName: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          placeholder="e.g., Smith"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">City</label>
                        <input
                          type="text"
                          value={npiSearchFields.city}
                          onChange={(e) => setNpiSearchFields({ ...npiSearchFields, city: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          placeholder="e.g., Dallas"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">State</label>
                        <select
                          value={npiSearchFields.state}
                          onChange={(e) => setNpiSearchFields({ ...npiSearchFields, state: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        >
                          <option value="">All States</option>
                          <option value="AL">Alabama</option>
                          <option value="AK">Alaska</option>
                          <option value="AZ">Arizona</option>
                          <option value="AR">Arkansas</option>
                          <option value="CA">California</option>
                          <option value="CO">Colorado</option>
                          <option value="CT">Connecticut</option>
                          <option value="DE">Delaware</option>
                          <option value="FL">Florida</option>
                          <option value="GA">Georgia</option>
                          <option value="HI">Hawaii</option>
                          <option value="ID">Idaho</option>
                          <option value="IL">Illinois</option>
                          <option value="IN">Indiana</option>
                          <option value="IA">Iowa</option>
                          <option value="KS">Kansas</option>
                          <option value="KY">Kentucky</option>
                          <option value="LA">Louisiana</option>
                          <option value="ME">Maine</option>
                          <option value="MD">Maryland</option>
                          <option value="MA">Massachusetts</option>
                          <option value="MI">Michigan</option>
                          <option value="MN">Minnesota</option>
                          <option value="MS">Mississippi</option>
                          <option value="MO">Missouri</option>
                          <option value="MT">Montana</option>
                          <option value="NE">Nebraska</option>
                          <option value="NV">Nevada</option>
                          <option value="NH">New Hampshire</option>
                          <option value="NJ">New Jersey</option>
                          <option value="NM">New Mexico</option>
                          <option value="NY">New York</option>
                          <option value="NC">North Carolina</option>
                          <option value="ND">North Dakota</option>
                          <option value="OH">Ohio</option>
                          <option value="OK">Oklahoma</option>
                          <option value="OR">Oregon</option>
                          <option value="PA">Pennsylvania</option>
                          <option value="RI">Rhode Island</option>
                          <option value="SC">South Carolina</option>
                          <option value="SD">South Dakota</option>
                          <option value="TN">Tennessee</option>
                          <option value="TX">Texas</option>
                          <option value="UT">Utah</option>
                          <option value="VT">Vermont</option>
                          <option value="VA">Virginia</option>
                          <option value="WA">Washington</option>
                          <option value="WV">West Virginia</option>
                          <option value="WI">Wisconsin</option>
                          <option value="WY">Wyoming</option>
                          <option value="DC">District of Columbia</option>
                        </select>
                      </div>
                    </div>
                    
                    <button
                      type="button"
                      onClick={searchNPIRegistry}
                      disabled={searchingNPI || (!npiSearchFields.organizationName && !npiSearchFields.lastName)}
                      className="w-full px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {searchingNPI ? (
                        <>
                          <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></div>
                          Searching...
                        </>
                      ) : (
                        <>
                          <Search className="h-4 w-4" />
                          Search NPI Registry
                        </>
                      )}
                    </button>
                    
                    {/* Search Results */}
                    {npiSearchResults.length > 0 && (
                      <div className="mt-3 border border-oe-primary/30 rounded-lg max-h-64 overflow-y-auto bg-white">
                        <div className="sticky top-0 bg-oe-light px-3 py-1.5 text-xs text-oe-primary font-medium border-b border-oe-primary/30">
                          {npiSearchResults.length} result{npiSearchResults.length !== 1 ? 's' : ''} found - Click to select
                        </div>
                        {npiSearchResults.map((result, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => selectNPIResult(result)}
                            className="w-full px-3 py-2.5 text-left hover:bg-oe-light border-b border-gray-100 last:border-0"
                          >
                            <div className="flex justify-between items-start">
                              <div className="font-medium text-gray-900">{result.providerName}</div>
                              <span className="font-mono text-xs text-oe-primary bg-oe-light px-2 py-0.5 rounded">
                                {result.npi}
                              </span>
                            </div>
                            <div className="text-sm text-gray-500 mt-0.5">
                              {result.providerType && (
                                <span className="inline-block bg-gray-100 text-gray-700 text-xs px-1.5 py-0.5 rounded mr-2">
                                  {result.providerType}
                                </span>
                              )}
                              {result.specialty && <span>{result.specialty}</span>}
                            </div>
                            {(result.city || result.state || result.address1) && (
                              <div className="text-xs text-gray-400 mt-1">
                                {result.address1 && <span>{result.address1}, </span>}
                                {result.city && <span>{result.city}, </span>}
                                {result.state} {result.zipCode}
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Provider Details Form */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Provider Name *</label>
                <input
                  type="text"
                  value={formData.providerName}
                  onChange={(e) => setFormData({ ...formData, providerName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="Hospital or practice name"
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                  <select
                    value={formData.providerType}
                    onChange={(e) => setFormData({ ...formData, providerType: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="">Select type</option>
                    {providerTypes.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Specialty</label>
                  <input
                    type="text"
                    value={formData.specialty}
                    onChange={(e) => setFormData({ ...formData, specialty: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="e.g., Internal Medicine"
                  />
                </div>
              </div>

              {editingProvider && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">NPI</label>
                  <input
                    type="text"
                    value={formData.npi}
                    onChange={(e) => setFormData({ ...formData, npi: e.target.value.replace(/\D/g, '').slice(0, 10) })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="10-digit NPI number"
                    maxLength={10}
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                  <input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="(555) 123-4567"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Fax</label>
                  <input
                    type="tel"
                    value={formData.fax}
                    onChange={(e) => setFormData({ ...formData, fax: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="(555) 123-4568"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="billing@provider.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                <input
                  type="text"
                  value={formData.address1}
                  onChange={(e) => setFormData({ ...formData, address1: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-2 focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="Street address"
                />
                <input
                  type="text"
                  value={formData.address2}
                  onChange={(e) => setFormData({ ...formData, address2: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="Suite, unit, etc. (optional)"
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
                  <input
                    type="text"
                    value={formData.city}
                    onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                  <input
                    type="text"
                    value={formData.state}
                    onChange={(e) => setFormData({ ...formData, state: e.target.value.toUpperCase() })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="TX"
                    maxLength={2}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">ZIP Code</label>
                  <input
                    type="text"
                    value={formData.zipCode}
                    onChange={(e) => setFormData({ ...formData, zipCode: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="12345"
                    maxLength={10}
                  />
                </div>
              </div>

              <div className="flex items-center pt-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={formData.isActive}
                  onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                  className="h-4 w-4 text-oe-primary rounded border-gray-300 focus:ring-oe-primary"
                />
                <label htmlFor="isActive" className="ml-2 text-sm text-gray-700">
                  Active provider
                </label>
              </div>
                </>
              )}

              {/* FAP Links Tab Content */}
              {activeModalTab === 'fapLinks' && editingProvider && (
                <FAPSubmissionsSection
                  key={`fap-links-${editingProvider.ProviderId}-${activeModalTab}`}
                  providerId={editingProvider.ProviderId}
                  onUpdate={() => loadModalFAPData(editingProvider.ProviderId)}
                />
              )}

              {/* Documents Tab Content */}
              {activeModalTab === 'documents' && editingProvider && (
                <FAPDocumentsSection providerId={editingProvider.ProviderId} />
              )}

              {/* Notes Tab Content */}
              {activeModalTab === 'notes' && editingProvider && (
                <FAPNotesSection providerId={editingProvider.ProviderId} />
              )}

              {/* Ranking Tab Content */}
              {activeModalTab === 'ranking' && editingProvider && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">Provider Rankings</h3>
                    <p className="text-sm text-gray-600 mb-4">
                      Rate this provider on Fair Pricing, Communication, and Negotiations. Rankings based on Share Request and Member ratings (TBD).
                    </p>
                  </div>
                  
                  <FAPRankingsSection providerId={editingProvider.ProviderId} />

                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mt-6">
                    <h4 className="text-sm font-medium text-gray-900 mb-2">Future Rankings</h4>
                    <p className="text-sm text-gray-600">
                      <strong>Ranking based on Share Request:</strong> Coming soon - will show aggregated rankings based on share request submissions.
                    </p>
                    <p className="text-sm text-gray-600 mt-2">
                      <strong>Ranking by Members (TBD):</strong> Member ratings and feedback will be displayed here once implemented.
                    </p>
                  </div>
                </div>
              )}
            </div>
            
            <div className="p-6 border-t border-gray-200 flex justify-end gap-3">
              <button
                onClick={resetModal}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              {activeModalTab === 'overview' && (
                <button
                  onClick={handleSubmit}
                  disabled={saving || !formData.providerName?.trim()}
                  className="btn-primary flex items-center gap-2 disabled:opacity-50"
                >
                  <Save className="h-4 w-4 mr-2" />
                  {saving ? 'Saving...' : editingProvider ? 'Save Changes' : 'Add Provider'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProviderList;


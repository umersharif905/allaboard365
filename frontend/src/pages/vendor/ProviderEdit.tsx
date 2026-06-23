// pages/vendor/ProviderEdit.tsx
// Edit Provider page with tabs for Overview, FAP Links, Documents, Notes, and Ranking

import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Save,
  Upload,
  MessageSquare,
  Star,
  Link as LinkIcon
} from 'lucide-react';
import { apiService } from '../../services/api.service';
import Skeleton from '../../components/vendor/ui/Skeleton';
import { Provider } from '../../types/shareRequest.types';
import {
  ProviderFAPSettings,
  FAPNote
} from '../../types/fap.types';
import FAPDocumentsSection from '../../components/fap/FAPDocumentsSection';
import FAPNotesSection from '../../components/fap/FAPNotesSection';
import FAPRankingsSection from '../../components/fap/FAPRankingsSection';

type TabType = 'overview' | 'fapLinks' | 'documents' | 'notes' | 'ranking';

const ProviderEdit = () => {
  const { providerId } = useParams<{ providerId: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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
    notes: '',
    isActive: true
  });

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

  useEffect(() => {
    if (providerId) {
      loadProvider();
    }
  }, [providerId]);

  const loadProvider = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiService.get<{ success: boolean; data: Provider }>(
        `/api/me/vendor/providers/${providerId}`
      );
      if (response.success && response.data) {
        const p = response.data;
        setProvider(p);
        setFormData({
          providerName: p.ProviderName || '',
          providerType: p.ProviderType || '',
          npi: p.NPI || '',
          phone: p.Phone || '',
          fax: (p as any).Fax || '',
          email: p.Email || '',
          address1: p.Address1 || '',
          address2: (p as any).Address2 || '',
          city: p.City || '',
          state: p.State || '',
          zipCode: p.ZipCode || '',
          specialty: (p as any).Specialty || '',
          notes: p.Notes || '',
          isActive: p.IsActive
        });
      } else {
        setError('Failed to load provider');
      }
    } catch (err: any) {
      console.error('Error loading provider:', err);
      setError(err.message || 'Failed to load provider');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!formData.providerName?.trim()) {
      setError('Provider name is required');
      return;
    }

    try {
      setSaving(true);
      setError(null);
      setSuccessMessage(null);

      const response = await apiService.put<{ success: boolean; message?: string }>(
        `/api/me/vendor/providers/${providerId}`,
        formData
      );

      if (response.success) {
        setSuccessMessage('Provider updated successfully');
        setTimeout(() => {
          navigate(`/vendor/providers/${providerId}`);
        }, 1500);
      } else {
        setError(response.message || 'Failed to update provider');
      }
    } catch (err: any) {
      console.error('Error saving provider:', err);
      setError(err.response?.data?.message || err.message || 'Failed to update provider');
    } finally {
      setSaving(false);
    }
  };

  const handleInputChange = (field: keyof typeof formData, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-1/4" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error && !provider) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">{error}</p>
          <button
            onClick={() => navigate('/vendor/providers')}
            className="mt-4 text-red-600 hover:text-red-800 font-medium"
          >
            Back to Providers
          </button>
        </div>
      </div>
    );
  }

  if (!provider) {
    return null;
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate(`/vendor/providers/${providerId}`)}
            className="p-2 text-gray-400 hover:text-gray-600"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Edit Provider</h1>
            <p className="text-gray-600">{provider.ProviderName}</p>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-oe-primary text-white px-4 py-2 rounded-lg hover:bg-oe-primary-dark disabled:opacity-50 flex items-center gap-2"
        >
          <Save className="h-4 w-4" />
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Messages */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p className="text-red-800">{error}</p>
        </div>
      )}
      {successMessage && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
          <p className="text-green-800">{successMessage}</p>
        </div>
      )}

      {/* Tabs */}
      <div className="bg-white rounded-lg border border-gray-200 mb-6">
        <div className="border-b border-gray-200">
          <nav className="flex -mb-px">
            <button
              onClick={() => setActiveTab('overview')}
              className={`py-4 px-6 border-b-2 font-medium text-sm ${
                activeTab === 'overview'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Provider Overview
            </button>
            <button
              onClick={() => setActiveTab('fapLinks')}
              className={`py-4 px-6 border-b-2 font-medium text-sm flex items-center gap-2 ${
                activeTab === 'fapLinks'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <LinkIcon className="h-4 w-4" />
              FAP Links
            </button>
            <button
              onClick={() => setActiveTab('documents')}
              className={`py-4 px-6 border-b-2 font-medium text-sm flex items-center gap-2 ${
                activeTab === 'documents'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <Upload className="h-4 w-4" />
              Documents
            </button>
            <button
              onClick={() => setActiveTab('notes')}
              className={`py-4 px-6 border-b-2 font-medium text-sm flex items-center gap-2 ${
                activeTab === 'notes'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <MessageSquare className="h-4 w-4" />
              Notes
            </button>
            <button
              onClick={() => setActiveTab('ranking')}
              className={`py-4 px-6 border-b-2 font-medium text-sm flex items-center gap-2 ${
                activeTab === 'ranking'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <Star className="h-4 w-4" />
              Ranking
            </button>
          </nav>
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {activeTab === 'overview' && (
            <OverviewTab formData={formData} onInputChange={handleInputChange} providerTypes={providerTypes} />
          )}
          {activeTab === 'fapLinks' && <FAPLinksTab providerId={providerId!} />}
          {activeTab === 'documents' && <FAPDocumentsSection providerId={providerId!} />}
          {activeTab === 'notes' && <FAPNotesSection providerId={providerId!} />}
          {activeTab === 'ranking' && <RankingTab providerId={providerId!} />}
        </div>
      </div>
    </div>
  );
};

// Overview Tab Component
interface OverviewTabProps {
  formData: {
    providerName: string;
    providerType: string;
    npi: string;
    phone: string;
    fax: string;
    email: string;
    address1: string;
    address2: string;
    city: string;
    state: string;
    zipCode: string;
    specialty: string;
    notes: string;
    isActive: boolean;
  };
  onInputChange: (field: keyof OverviewTabProps['formData'], value: any) => void;
  providerTypes: string[];
}

const OverviewTab: React.FC<OverviewTabProps> = ({ formData, onInputChange, providerTypes }) => {
  return (
    <div className="space-y-6">
      {/* Basic Information */}
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Basic Information</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Provider Name *</label>
            <input
              type="text"
              value={formData.providerName}
              onChange={(e) => onInputChange('providerName', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="Hospital or practice name"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
            <select
              value={formData.providerType}
              onChange={(e) => onInputChange('providerType', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            >
              <option value="">Select type</option>
              {providerTypes.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">NPI</label>
            <input
              type="text"
              value={formData.npi}
              onChange={(e) => onInputChange('npi', e.target.value.replace(/\D/g, '').slice(0, 10))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary font-mono"
              placeholder="10-digit NPI number"
              maxLength={10}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Specialty</label>
            <input
              type="text"
              value={formData.specialty}
              onChange={(e) => onInputChange('specialty', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="e.g., Internal Medicine"
            />
          </div>
        </div>
      </div>

      {/* Contact Information */}
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Contact Information</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
            <input
              type="tel"
              value={formData.phone}
              onChange={(e) => onInputChange('phone', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="(555) 123-4567"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Fax</label>
            <input
              type="tel"
              value={formData.fax}
              onChange={(e) => onInputChange('fax', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="(555) 123-4568"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              value={formData.email}
              onChange={(e) => onInputChange('email', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="billing@provider.com"
            />
          </div>
        </div>
      </div>

      {/* Address */}
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Address</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Address Line 1</label>
            <input
              type="text"
              value={formData.address1}
              onChange={(e) => onInputChange('address1', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="Street address"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Address Line 2</label>
            <input
              type="text"
              value={formData.address2}
              onChange={(e) => onInputChange('address2', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="Suite, unit, etc. (optional)"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
              <input
                type="text"
                value={formData.city}
                onChange={(e) => onInputChange('city', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
              <input
                type="text"
                value={formData.state}
                onChange={(e) => onInputChange('state', e.target.value.toUpperCase())}
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
                onChange={(e) => onInputChange('zipCode', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                placeholder="12345"
                maxLength={10}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Notes */}
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Notes</h3>
        <textarea
          value={formData.notes}
          onChange={(e) => onInputChange('notes', e.target.value)}
          rows={4}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
          placeholder="General notes about this provider..."
        />
      </div>

      {/* Status */}
      <div>
        <div className="flex items-center pt-2">
          <input
            type="checkbox"
            id="isActive"
            checked={formData.isActive}
            onChange={(e) => onInputChange('isActive', e.target.checked)}
            className="h-4 w-4 text-oe-primary rounded border-gray-300 focus:ring-oe-primary"
          />
          <label htmlFor="isActive" className="ml-2 text-sm text-gray-700">
            Active provider
          </label>
        </div>
      </div>
    </div>
  );
};

// FAP Links Tab Component
const FAPLinksTab: React.FC<{ providerId: string }> = ({ providerId }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<ProviderFAPSettings | null>(null);
  const [formData, setFormData] = useState({
    fapWebsiteUrl: '',
    fapFormUrl: '',
    fapInstructionsUrl: '',
    notes: ''
  });
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
    loadFAPNotes();
  }, [providerId]);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const response = await apiService.get<{ success: boolean; data: ProviderFAPSettings }>(
        `/api/me/vendor/providers/${providerId}/fap/settings`
      );
      if (response.success && response.data) {
        setSettings(response.data);
        setFormData({
          fapWebsiteUrl: response.data.fapWebsiteUrl || '',
          fapFormUrl: response.data.fapFormUrl || '',
          fapInstructionsUrl: response.data.fapInstructionsUrl || '',
          notes: ''
        });
      }
    } catch (err: any) {
      // Settings might not exist yet
      console.log('FAP settings not available:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadFAPNotes = async () => {
    try {
      const response = await apiService.get<{ success: boolean; data: FAPNote[] }>(
        `/api/me/vendor/providers/${providerId}/fap/notes`
      );
      if (response.success && response.data) {
        // Filter for notes related to FAP application links
        const fapLinkNotes = response.data.filter(note => 
          note.note.toLowerCase().includes('fap application') ||
          note.note.toLowerCase().includes('form') ||
          note.note.toLowerCase().includes('link')
        );
        // We'll handle notes separately, for now just load them
      }
    } catch (err) {
      // Notes might not exist
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccessMessage(null);

      const payload: Partial<ProviderFAPSettings> = {
        providerId,
        fapWebsiteUrl: formData.fapWebsiteUrl || undefined,
        fapFormUrl: formData.fapFormUrl || undefined,
        fapInstructionsUrl: formData.fapInstructionsUrl || undefined
      };

      const response = await apiService.put<{ success: boolean }>(
        `/api/me/vendor/providers/${providerId}/fap/settings`,
        payload
      );

      if (response.success) {
        setSuccessMessage('FAP links updated successfully');
        await loadSettings();
      } else {
        setError('Failed to save FAP links');
      }
    } catch (err: any) {
      console.error('Error saving FAP links:', err);
      setError(err.message || 'Failed to save FAP links');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
        <p className="text-sm text-blue-800">
          Add links and notes related to filling out the FAP application for this provider.
        </p>
      </div>

      {successMessage && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <p className="text-green-800">{successMessage}</p>
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">{error}</p>
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            FAP Website URL
          </label>
          <input
            type="url"
            value={formData.fapWebsiteUrl}
            onChange={(e) => setFormData({ ...formData, fapWebsiteUrl: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            placeholder="https://provider.com/fap"
          />
          <p className="text-xs text-gray-500 mt-1">Main FAP program website</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            FAP Application Form URL
          </label>
          <input
            type="url"
            value={formData.fapFormUrl}
            onChange={(e) => setFormData({ ...formData, fapFormUrl: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            placeholder="https://provider.com/fap/form"
          />
          <p className="text-xs text-gray-500 mt-1">Direct link to the FAP application form</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            FAP Instructions URL
          </label>
          <input
            type="url"
            value={formData.fapInstructionsUrl}
            onChange={(e) => setFormData({ ...formData, fapInstructionsUrl: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            placeholder="https://provider.com/fap/instructions"
          />
          <p className="text-xs text-gray-500 mt-1">Link to instructions for filling out the FAP application</p>
        </div>

        <div className="pt-4 border-t border-gray-200">
          <h4 className="text-sm font-medium text-gray-700 mb-2">Notes Related to FAP Application</h4>
          <p className="text-xs text-gray-500 mb-3">
            Use the Notes tab to add notes about filling out the FAP application for this provider.
          </p>
        </div>

        <div className="flex justify-end pt-4 border-t border-gray-200">
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-oe-primary text-white px-4 py-2 rounded-lg hover:bg-oe-primary-dark disabled:opacity-50 flex items-center gap-2"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save Links'}
          </button>
        </div>
      </div>
    </div>
  );
};

// Ranking Tab Component
const RankingTab: React.FC<{ providerId: string }> = ({ providerId }) => {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Provider Rankings</h3>
        <p className="text-sm text-gray-600 mb-4">
          Rate this provider on Fair Pricing, Communication, and Negotiations. Rankings based on Share Request and Member ratings (TBD).
        </p>
      </div>
      
      <FAPRankingsSection providerId={providerId} />

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
  );
};

export default ProviderEdit;


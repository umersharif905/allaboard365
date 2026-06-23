// pages/vendor/ProviderProfile.tsx
// Provider Profile page with FAP Management tab

import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Phone,
  Mail,
  MapPin,
  Globe,
  FileText,
  TrendingUp,
  MessageSquare,
  Star,
  Edit2,
  Upload,
  DollarSign
} from 'lucide-react';
import { apiService } from '../../services/api.service';
import Skeleton from '../../components/vendor/ui/Skeleton';
import { Provider } from '../../types/shareRequest.types';
import {
  ProviderFAPSettings,
  ProviderFAPSummary
} from '../../types/fap.types';
import FAPSubmissionsSection from '../../components/fap/FAPSubmissionsSection';
import FAPDocumentsSection from '../../components/fap/FAPDocumentsSection';
import FAPNotesSection from '../../components/fap/FAPNotesSection';
import FAPRankingsSection from '../../components/fap/FAPRankingsSection';

type TabType = 'overview' | 'fap';

const ProviderProfile = () => {
  const { providerId } = useParams<{ providerId: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [fapSummary, setFapSummary] = useState<ProviderFAPSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (providerId) {
      loadProvider();
      loadFAPSummary();
    }
  }, [providerId]);

  const loadProvider = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiService.get<{ success: boolean; data: Provider }>(
        `/api/me/vendor/providers/${providerId}`
      );
      if (response.success) {
        setProvider(response.data);
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

  const loadFAPSummary = async () => {
    try {
      const response = await apiService.get<{ success: boolean; data: ProviderFAPSummary }>(
        `/api/me/vendor/providers/${providerId}/fap/summary`
      );
      if (response.success && response.data) {
        setFapSummary(response.data);
      }
    } catch (err) {
      // FAP summary might not exist yet, that's okay
      console.log('FAP summary not available:', err);
    }
  };

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-1/4" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !provider) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">{error || 'Provider not found'}</p>
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

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/vendor/providers')}
            className="p-2 text-gray-400 hover:text-gray-600"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">{provider.ProviderName}</h1>
            <p className="text-gray-600">{provider.ProviderType || 'Provider'}</p>
          </div>
        </div>
        <button
          onClick={() => navigate(`/vendor/providers/${providerId}/edit`)}
          className="btn-primary flex items-center gap-2"
        >
          <Edit2 className="h-4 w-4" />
          Edit Provider
        </button>
      </div>

      {/* Provider Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Phone className="h-5 w-5 text-oe-primary" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Phone</p>
              <p className="text-sm font-medium text-gray-900">{provider.Phone || 'Not provided'}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-100 rounded-lg">
              <Mail className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Email</p>
              <p className="text-sm font-medium text-gray-900">{provider.Email || 'Not provided'}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-100 rounded-lg">
              <MapPin className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Location</p>
              <p className="text-sm font-medium text-gray-900">
                {provider.City && provider.State
                  ? `${provider.City}, ${provider.State}`
                  : provider.City || provider.State || 'Not provided'}
              </p>
            </div>
          </div>
        </div>
      </div>

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
              Overview
            </button>
            <button
              onClick={() => setActiveTab('fap')}
              className={`py-4 px-6 border-b-2 font-medium text-sm flex items-center gap-2 ${
                activeTab === 'fap'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <FileText className="h-4 w-4" />
              FAP Management
              {fapSummary && fapSummary.totalSubmissions > 0 && (
                <span className="bg-gray-100 text-gray-900 py-0.5 px-2 rounded-full text-xs">
                  {fapSummary.totalSubmissions}
                </span>
              )}
            </button>
          </nav>
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {activeTab === 'overview' && <OverviewTab provider={provider} />}
          {activeTab === 'fap' && <FAPTab providerId={providerId!} onSummaryUpdate={loadFAPSummary} />}
        </div>
      </div>
    </div>
  );
};

// Overview Tab Component
const OverviewTab: React.FC<{ provider: Provider }> = ({ provider }) => {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Basic Information */}
        <div>
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Basic Information</h3>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-gray-500">Provider Name</label>
              <p className="text-sm text-gray-900">{provider.ProviderName}</p>
            </div>
            {provider.ProviderType && (
              <div>
                <label className="text-sm font-medium text-gray-500">Type</label>
                <p className="text-sm text-gray-900">{provider.ProviderType}</p>
              </div>
            )}
            {provider.NPI && (
              <div>
                <label className="text-sm font-medium text-gray-500">NPI</label>
                <p className="text-sm text-gray-900 font-mono">{provider.NPI}</p>
              </div>
            )}
            <div>
              <label className="text-sm font-medium text-gray-500">Status</label>
              <span
                className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                  provider.IsActive
                    ? 'bg-green-100 text-green-800'
                    : 'bg-gray-100 text-gray-800'
                }`}
              >
                {provider.IsActive ? 'Active' : 'Inactive'}
              </span>
            </div>
          </div>
        </div>

        {/* Contact Information */}
        <div>
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Contact Information</h3>
          <div className="space-y-3">
            {provider.Phone && (
              <div className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-gray-400" />
                <span className="text-sm text-gray-900">{provider.Phone}</span>
              </div>
            )}
            {provider.Fax && (
              <div className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-gray-400" />
                <span className="text-sm text-gray-900">Fax: {provider.Fax}</span>
              </div>
            )}
            {provider.Email && (
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-gray-400" />
                <span className="text-sm text-gray-900">{provider.Email}</span>
              </div>
            )}
            {provider.Website && (
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-gray-400" />
                <a
                  href={provider.Website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-oe-primary hover:text-blue-800"
                >
                  {provider.Website}
                </a>
              </div>
            )}
          </div>
        </div>

        {/* Address */}
        {(provider.Address1 || provider.City || provider.State) && (
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Address</h3>
            <div className="space-y-1">
              {provider.Address1 && <p className="text-sm text-gray-900">{provider.Address1}</p>}
              {provider.Address2 && <p className="text-sm text-gray-900">{provider.Address2}</p>}
              <p className="text-sm text-gray-900">
                {provider.City}
                {provider.City && provider.State ? ', ' : ''}
                {provider.State} {provider.ZipCode}
              </p>
            </div>
          </div>
        )}

        {/* Notes */}
        {provider.Notes && (
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Notes</h3>
            <p className="text-sm text-gray-900 whitespace-pre-wrap">{provider.Notes}</p>
          </div>
        )}
      </div>
    </div>
  );
};

// FAP Tab Component
const FAPTab: React.FC<{ providerId: string; onSummaryUpdate: () => void }> = ({
  providerId,
  onSummaryUpdate
}) => {
  const [activeSection, setActiveSection] = useState<'overview' | 'submissions' | 'documents' | 'notes' | 'rankings'>('overview');

  return (
    <div>
      {/* FAP Sub-tabs */}
      <div className="flex border-b border-gray-200 mb-6 -mx-6 px-6">
        {[
          { key: 'overview', label: 'Overview', icon: TrendingUp },
          { key: 'submissions', label: 'Submissions', icon: FileText },
          { key: 'documents', label: 'Documents', icon: Upload },
          { key: 'notes', label: 'Notes', icon: MessageSquare },
          { key: 'rankings', label: 'Rankings', icon: Star }
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setActiveSection(key as any)}
            className={`py-3 px-4 border-b-2 font-medium text-sm flex items-center gap-2 ${
              activeSection === key
                ? 'border-oe-primary text-oe-primary'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Section Content */}
      {activeSection === 'overview' && <FAPOverviewSection providerId={providerId} />}
      {activeSection === 'submissions' && <FAPSubmissionsSection providerId={providerId} onUpdate={onSummaryUpdate} />}
      {activeSection === 'documents' && <FAPDocumentsSection providerId={providerId} />}
      {activeSection === 'notes' && <FAPNotesSection providerId={providerId} />}
      {activeSection === 'rankings' && <FAPRankingsSection providerId={providerId} />}
    </div>
  );
};

// FAP Overview Section
const FAPOverviewSection: React.FC<{ providerId: string }> = ({ providerId }) => {
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<ProviderFAPSettings | null>(null);
  const [summary, setSummary] = useState<ProviderFAPSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, [providerId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [settingsRes, summaryRes] = await Promise.all([
        apiService.get<{ success: boolean; data: ProviderFAPSettings }>(
          `/api/me/vendor/providers/${providerId}/fap/settings`
        ),
        apiService.get<{ success: boolean; data: ProviderFAPSummary }>(
          `/api/me/vendor/providers/${providerId}/fap/summary`
        )
      ]);

      if (settingsRes.success) {
        setSettings(settingsRes.data);
      }
      if (summaryRes.success && summaryRes.data) {
        setSummary(summaryRes.data);
      }
    } catch (err: any) {
      console.error('Error loading FAP overview:', err);
      setError(err.message || 'Failed to load FAP overview');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* FAP Settings */}
      <div className="bg-gray-50 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">FAP Program Information</h3>
          <button className="text-sm text-oe-primary hover:text-blue-800 font-medium">
            Edit Settings
          </button>
        </div>
        {settings ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {settings.fapWebsiteUrl && (
              <div>
                <label className="text-sm font-medium text-gray-500">FAP Website</label>
                <a
                  href={settings.fapWebsiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-oe-primary hover:text-blue-800 block"
                >
                  {settings.fapWebsiteUrl}
                </a>
              </div>
            )}
            {settings.primaryContactName && (
              <div>
                <label className="text-sm font-medium text-gray-500">Primary Contact</label>
                <p className="text-sm text-gray-900">{settings.primaryContactName}</p>
                {settings.primaryContactPhone && (
                  <p className="text-sm text-gray-600">{settings.primaryContactPhone}</p>
                )}
                {settings.primaryContactEmail && (
                  <p className="text-sm text-gray-600">{settings.primaryContactEmail}</p>
                )}
              </div>
            )}
            {settings.expectedProcessingTimeDays && (
              <div>
                <label className="text-sm font-medium text-gray-500">Expected Processing Time</label>
                <p className="text-sm text-gray-900">{settings.expectedProcessingTimeDays} days</p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No FAP settings configured. Click "Edit Settings" to get started.</p>
        )}
      </div>

      {/* FAP Summary Stats */}
      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Total Submissions</p>
                <p className="text-2xl font-semibold text-gray-900">{summary.totalSubmissions || 0}</p>
              </div>
              <FileText className="h-8 w-8 text-oe-primary" />
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Approved</p>
                <p className="text-2xl font-semibold text-green-600">{summary.approvedSubmissions || 0}</p>
              </div>
              <TrendingUp className="h-8 w-8 text-green-600" />
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Average Discount</p>
                <p className="text-2xl font-semibold text-oe-primary">
                  {summary.averageDiscountPercentage
                    ? `${summary.averageDiscountPercentage.toFixed(1)}%`
                    : 'N/A'}
                </p>
              </div>
              <DollarSign className="h-8 w-8 text-oe-primary" />
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Overall Score</p>
                <p className="text-2xl font-semibold text-purple-600">
                  {summary.overallScore ? summary.overallScore.toFixed(1) : 'N/A'}
                </p>
              </div>
              <Star className="h-8 w-8 text-purple-600" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProviderProfile;


// File: src/pages/tenant-admin/TenantSettings.tsx
// Main TenantSettings Summary Page with modular edit modals
import {
    AlertCircle,
    Bell,
    Building,
    CheckCircle,
    Edit,
    ExternalLink,
    Globe,
    Loader2,
    Mail,
    MapPin,
    Monitor,
    Settings
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import SessionExpiryText from '../../components/shared/SessionExpiryText';
import UnifiedTenantSettingsModal from '../../components/UnifiedTenantSettingsModal';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
import TenantSettingsEdit from './TenantSettingsEdit';

// Remove unused interface to fix TS warning

// Frontend display interface
interface TenantSettingsData {
  tenantId: string;
  name?: string; // CHANGED: Made optional, no fallbacks
  contactEmail?: string; // CHANGED: Made optional, no fallbacks
  contactPhone?: string;
  website?: string;
  address?: { // CHANGED: Made optional, no fallbacks
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
  };
  branding: {
    logoUrl?: string;
    primaryColorHex: string;
    secondaryColorHex: string;
    accentColorHex: string;
    fontFamily: string;
    customCSS?: string;
    customDomain?: string;
    memberIDPrefix?: string;
  };
  emailSettings: {
    customFromAddress?: string;
    dkimEnabled: boolean;
    dkimDomain?: string;
    dkimSelector?: string;
    dkimPublicKey?: string;
    dkimPrivateKey?: string;
    smtpEnabled: boolean;
    smtpHost?: string;
    smtpPort?: number;
    smtpUsername?: string;
    smtpSettings?: {
      host: string;
      port: number;
      secure: boolean;
      username: string;
    };
  };
  domainSettings: {
    customUrl?: string;
    defaultUrlPath?: string;
    verificationStatus: 'pending' | 'verified' | 'failed';
    sslEnabled: boolean;
    dnsInstructions?: string;
    provisioningState?: string;
    deploymentStatus?: string;
    endpointAssociation?: string;
    domainValidationState?: string;
    statusUpdatedAt?: string;
  };
  notificationSettings: {
    enrollmentNotifications: boolean;
    paymentNotifications: boolean;
    systemAlerts: boolean;
    marketingEmails: boolean;
  };
  features: {
    showLandingPage: boolean;
    enableSelfService: boolean;
    requireEmailVerification: boolean;
    allowGuestCheckout: boolean;
    enableReferrals: boolean;
  };
  apiKeys: {
    enabled: boolean;
    keyCount: number;
    keys?: any[];
  };
  agentOnboarding: {
    hasAgreementDocument: boolean;
    documentCount: number;
  };
}

const normalizeDomainStatus = (value?: string): 'pending' | 'verified' | 'failed' => {
  if (!value) return 'pending';
  const normalized = value.toString().toLowerCase();
  if (normalized === 'verified') return 'verified';
  if (normalized === 'failed') return 'failed';
  return 'pending';
};

const deriveDomainStatus = (domain?: Record<string, any>): 'pending' | 'verified' | 'failed' => {
  const normalized = normalizeDomainStatus(domain?.verificationStatus || domain?.status);
  if (normalized === 'verified' || normalized === 'failed') {
    return normalized;
  }

  const provisioning = domain?.provisioningState?.toString().toLowerCase();
  const deployment = domain?.deploymentStatus?.toString().toLowerCase();
  const validation = domain?.domainValidationState?.toString().toLowerCase();
  const association = domain?.endpointAssociation?.toString().toLowerCase();

  const isProvisioned = provisioning === 'succeeded' || provisioning === 'success';
  const isDeploymentComplete = !deployment || deployment === 'succeeded' || deployment === 'success';
  const isValidationApproved = validation === 'approved';
  const isAssociated = association === 'associated' || association === 'true';

  if (isProvisioned && isDeploymentComplete && isValidationApproved && isAssociated) {
    return 'verified';
  }

  if (provisioning === 'failed' || deployment === 'failed' || validation === 'failed') {
    return 'failed';
  }

  return 'pending';
};

const TenantSettingsPage: React.FC = () => {
  const [settings, setSettings] = useState<TenantSettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEditInfo, setShowEditInfo] = useState(false);
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setError(null);
      
      // 🔧 ONLY CALL THE WORKING API - REMOVE THE BROKEN SECOND CALL
      const settingsResponse = await TenantAdminService.getTenantSettings();
      
      if (!settingsResponse.success) {
        throw new Error(settingsResponse.message || 'Failed to get tenant info');
      }
      
      if (!settingsResponse.data) {
        throw new Error('No settings data returned');
      }

      // 🔧 USE THE SETTINGS DATA DIRECTLY - IT CONTAINS EVERYTHING WE NEED
      const data = settingsResponse.data as any; // Type cast to avoid TS errors
      
      console.log('🔍 Settings data received:', data); // Debug log
      
      const derivedDomainStatus = deriveDomainStatus(data.domainSettings);

      const transformedData: TenantSettingsData = {
        tenantId: data.tenantId,
        // Use the data from tenant-admin/settings response
        name: data.name,
        contactEmail: data.contactEmail,
        contactPhone: data.contactPhone,
        website: data.website,
        // Map address from the settings response
        address: data.address || {},
        branding: {
          logoUrl: data.branding?.logoUrl || '',
          primaryColorHex: data.branding?.primaryColorHex || '#1f6db0',
          secondaryColorHex: data.branding?.secondaryColorHex || '#424242',
          accentColorHex: data.branding?.accentColorHex || '#FF6B6B',
          fontFamily: data.branding?.fontFamily || 'Inter, system-ui, sans-serif',
          customCSS: data.branding?.customCSS || '',
          customDomain: data.branding?.customDomain || data.domainSettings?.customUrl || '',
          memberIDPrefix: data.branding?.memberIDPrefix || 'OED'
        },
        emailSettings: {
          customFromAddress: data.emailSettings?.customFromAddress || '',
          dkimEnabled: data.emailSettings?.dkimEnabled || false,
          dkimDomain: data.emailSettings?.dkimDomain || '',
          dkimSelector: data.emailSettings?.dkimSelector || '',
          dkimPublicKey: data.emailSettings?.dkimPublicKey || '',
          dkimPrivateKey: data.emailSettings?.dkimPrivateKey || '',
          smtpEnabled: data.emailSettings?.smtpEnabled || false,
          smtpHost: data.emailSettings?.smtpHost || '',
          smtpPort: data.emailSettings?.smtpPort || 587,
          smtpUsername: data.emailSettings?.smtpUsername || '',
          smtpSettings: data.emailSettings?.smtpSettings
        },
        domainSettings: {
          customUrl: data.domainSettings?.customUrl || '',
          defaultUrlPath: data.domainSettings?.defaultUrlPath || data.defaultUrlPath || '', // Load DefaultUrlPath
          verificationStatus: derivedDomainStatus,
          sslEnabled: data.domainSettings?.sslEnabled !== false,
          dnsInstructions: data.domainSettings?.dnsInstructions || '',
          provisioningState: data.domainSettings?.provisioningState,
          deploymentStatus: data.domainSettings?.deploymentStatus,
          endpointAssociation: data.domainSettings?.endpointAssociation,
          domainValidationState: data.domainSettings?.domainValidationState,
          statusUpdatedAt: data.domainSettings?.statusUpdatedAt
        },
        notificationSettings: {
          enrollmentNotifications: data.notificationSettings?.enrollmentNotifications !== false,
          paymentNotifications: data.notificationSettings?.paymentNotifications !== false,
          systemAlerts: data.notificationSettings?.systemAlerts !== false,
          marketingEmails: data.notificationSettings?.marketingEmails || false
        },
        features: {
          showLandingPage: data.features?.showLandingPage !== false,
          enableSelfService: data.features?.enableSelfService !== false,
          requireEmailVerification: data.features?.requireEmailVerification !== false,
          allowGuestCheckout: data.features?.allowGuestCheckout || false,
          enableReferrals: data.features?.enableReferrals || false
        },
        apiKeys: {
          enabled: data.apiKeys?.enabled || false,
          keyCount: data.apiKeys?.keyCount || 0,
          keys: data.apiKeys?.keys || []
        },
        agentOnboarding: {
          hasAgreementDocument: data.agentOnboarding?.hasAgreementDocument || false,
          documentCount: data.agentOnboarding?.documentCount || 0
        }
      };
      
      console.log('🔍 Transformed data:', transformedData); // Debug log
      
      setSettings(transformedData);

    } catch (err: any) {
      console.error('Error loading settings:', err);
      setError(err.message || 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    const normalized = status?.toLowerCase?.() || 'pending';
    switch (normalized) {
      case 'verified':
        return 'text-green-600 bg-green-100';
      case 'failed':
        return 'text-red-600 bg-red-100';
      case 'pending':
      default:
        return 'text-yellow-600 bg-yellow-100';
    }
  };

  const getFeatureCount = () => {
    if (!settings?.features) return 0;
    const features = settings.features;
    return Object.values(features).filter(Boolean).length;
  };

  const getNotificationCount = () => {
    if (!settings?.notificationSettings) return 0;
    const notifications = settings.notificationSettings;
    return Object.values(notifications).filter(Boolean).length;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-oe-neutral-light flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="animate-spin h-12 w-12 text-oe-primary mx-auto mb-4" />
          <p className="text-gray-600">Loading organization settings...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-oe-neutral-light flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-oe-neutral-dark mb-2">Error Loading Settings</h2>
          <p className="text-gray-600 mb-4">{error}</p>
          <button
            onClick={loadSettings}
            className="px-4 py-2 bg-oe-primary text-white rounded-md hover:bg-oe-dark transition-colors"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="space-y-0">
      {/* Settings Overview Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Company Information Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center">
              <Building className="h-5 w-5 text-oe-primary mr-2" />
              <h3 className="text-lg font-medium text-oe-neutral-dark">Company Information</h3>
            </div>
            <button
              onClick={() => setShowEditInfo(true)}
              className="inline-flex items-center px-3 py-1 rounded-md text-sm font-medium bg-oe-primary text-white hover:bg-oe-dark transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2"
            >
              <Edit className="h-4 w-4 mr-1" />
              Edit
            </button>
          </div>
          
          <div className="space-y-3">
            {/* Logo */}
            <div>
              <label className="text-sm font-medium text-gray-500">Logo</label>
              <div className="mt-1">
                {settings.branding.logoUrl ? (
                  <div className="w-32 h-16 rounded-lg border border-gray-200 bg-white flex items-center justify-center overflow-hidden">
                    <img 
                      src={settings.branding.logoUrl} 
                      alt="Organization Logo"
                      className="max-w-full max-h-full object-contain"
                      style={{ maxWidth: '120px', maxHeight: '60px' }}
                    />
                  </div>
                ) : (
                  <div className="w-16 h-16 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center">
                    <span className="text-gray-400 text-sm">No logo</span>
                  </div>
                )}
              </div>
            </div>

            {/* CHANGED: Only show if data exists, no fallbacks */}
            {settings.name && (
              <div>
                <label className="text-sm font-medium text-gray-500">Company Name</label>
                <p className="text-oe-neutral-dark">{settings.name}</p>
              </div>
            )}
            
            <div className="grid grid-cols-2 gap-4">
              {settings.contactEmail && (
                <div>
                  <label className="text-sm font-medium text-gray-500">Contact Email</label>
                  <p className="text-oe-neutral-dark">{settings.contactEmail}</p>
                </div>
              )}
              {settings.contactPhone && (
                <div>
                  <label className="text-sm font-medium text-gray-500">Phone</label>
                  <p className="text-oe-neutral-dark">{settings.contactPhone}</p>
                </div>
              )}
            </div>
            
            {settings.website && (
              <div>
                <label className="text-sm font-medium text-gray-500">Website</label>
                <div className="flex items-center">
                  <p className="text-oe-neutral-dark mr-2">{settings.website}</p>
                  <ExternalLink className="h-4 w-4 text-gray-400" />
                </div>
              </div>
            )}
            
            {/* CHANGED: Only show address if any address data exists */}
            {settings.address && (settings.address.street || settings.address.city) && (
              <div>
                <label className="text-sm font-medium text-gray-500">Address</label>
                <div className="flex items-start">
                  <MapPin className="h-4 w-4 text-gray-400 mr-1 mt-0.5" />
                  <div className="text-oe-neutral-dark">
                    {settings.address.street && <div>{settings.address.street}</div>}
                    {(settings.address.city || settings.address.state) && (
                      <div>
                        {settings.address.city}
                        {settings.address.city && settings.address.state && ', '}
                        {settings.address.state} {settings.address.zip}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ADDED: Show message if no company info is available */}
            {!settings.name && !settings.contactEmail && !settings.contactPhone && !settings.website && (!settings.address || (!settings.address.street && !settings.address.city)) && (
              <div className="text-center py-4">
                <p className="text-gray-500 text-sm">No company information configured</p>
                <button
                  onClick={() => setShowEditInfo(true)}
                  className="mt-2 text-oe-primary text-sm hover:underline"
                >
                  Add company information
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Advanced Configuration Summary */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center">
              <Settings className="h-5 w-5 text-oe-primary mr-2" />
              <h3 className="text-lg font-medium text-oe-neutral-dark">Advanced Configuration</h3>
            </div>
            <button
              onClick={() => setShowAdvancedConfig(true)}
              className="inline-flex items-center px-3 py-1 rounded-md text-sm font-medium bg-oe-primary text-white hover:bg-oe-dark transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2"
            >
              <Settings className="h-4 w-4 mr-1" />
              Configure
            </button>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            {/* Removed: Branding Status - Not needed right now */}

            {/* Email Configuration */}
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-md">
              <div className="flex items-center">
                <Mail className="h-4 w-4 text-blue-500 mr-2" />
                <div>
                  <p className="text-sm font-medium text-gray-900">Email</p>
                  <p className="text-xs text-gray-500">
                    {settings.emailSettings.dkimEnabled ? 'DKIM enabled' : 'Basic setup'}
                  </p>
                </div>
              </div>
              <div className={`px-2 py-1 rounded-full text-xs font-medium ${
                settings.emailSettings.customFromAddress 
                  ? 'bg-green-100 text-green-800' 
                  : 'bg-gray-100 text-gray-800'
              }`}>
                {settings.emailSettings.customFromAddress ? 'Custom' : 'Default'}
              </div>
            </div>

            {/* Domain Configuration */}
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-md">
              <div className="flex items-center">
                <Globe className="h-4 w-4 text-green-500 mr-2" />
                <div>
                  <p className="text-sm font-medium text-gray-900">Domain</p>
                  <p className="text-xs text-gray-500">
                    {settings.domainSettings.customUrl || 'Default domain'}
                  </p>
                </div>
              </div>
              {settings.domainSettings.customUrl && (
                <div className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(settings.domainSettings.verificationStatus)}`}>
                  {settings.domainSettings.verificationStatus}
                </div>
              )}
            </div>

            {/* Notifications */}
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-md">
              <div className="flex items-center">
                <Bell className="h-4 w-4 text-orange-500 mr-2" />
                <div>
                  <p className="text-sm font-medium text-gray-900">Notifications</p>
                  <p className="text-xs text-gray-500">
                    {getNotificationCount()} of 4 enabled
                  </p>
                </div>
              </div>
              <div className="text-right">
                <div className="w-8 h-2 bg-gray-200 rounded-full">
                  <div 
                    className="h-2 bg-orange-500 rounded-full"
                    style={{ width: `${(getNotificationCount() / 4) * 100}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Features */}
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-md">
              <div className="flex items-center">
                <Monitor className="h-4 w-4 text-indigo-500 mr-2" />
                <div>
                  <p className="text-sm font-medium text-gray-900">Features</p>
                  <p className="text-xs text-gray-500">
                    {getFeatureCount()} of 5 enabled
                  </p>
                </div>
              </div>
              <div className="text-right">
                <div className="w-8 h-2 bg-gray-200 rounded-full">
                  <div 
                    className="h-2 bg-indigo-500 rounded-full"
                    style={{ width: `${(getFeatureCount() / 5) * 100}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Removed: API Keys Status - Not needed right now */}
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-medium text-oe-neutral-dark mb-4">Quick Actions</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button
            onClick={() => setShowEditInfo(true)}
            className="flex items-center p-4 border border-gray-200 rounded-lg hover:bg-oe-neutral-light transition-colors"
          >
            <Building className="h-6 w-6 text-oe-primary mr-3" />
            <div className="text-left">
              <p className="font-medium text-oe-neutral-dark">Update Company Info</p>
              <p className="text-sm text-gray-500">Edit name, address, and contact details</p>
            </div>
          </button>

          {/* Removed: Customize Branding - Not needed right now */}
          {/* Removed: Manage API Keys - Not needed right now */}
        </div>
      </div>

      {/* Status Summary */}
      {(settings.emailSettings.dkimEnabled || settings.domainSettings.customUrl) && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-medium text-oe-neutral-dark mb-4">Configuration Status</h3>
          <div className="space-y-3">
            {settings.emailSettings.dkimEnabled && (
              <div className="flex items-center justify-between p-3 bg-green-50 border border-green-200 rounded-lg">
                <div className="flex items-center">
                  <CheckCircle className="h-5 w-5 text-green-500 mr-3" />
                  <div>
                    <p className="font-medium text-green-900">DKIM Email Authentication</p>
                    <p className="text-sm text-green-700">Your emails are authenticated with DKIM</p>
                  </div>
                </div>
              </div>
            )}

            {settings.domainSettings.customUrl && (
              <div className={`flex items-center justify-between p-3 border rounded-lg ${
                settings.domainSettings.verificationStatus === 'verified'
                  ? 'bg-green-50 border-green-200'
                  : settings.domainSettings.verificationStatus === 'failed'
                  ? 'bg-red-50 border-red-200'
                  : 'bg-amber-50 border-amber-200'
              }`}>
                <div className="flex items-start w-full">
                  <Globe className="h-5 w-5 mr-3 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-medium text-gray-900">Custom Domain: {settings.domainSettings.customUrl}</p>
                    <p className="text-sm text-gray-700">
                      Status:{' '}
                      {settings.domainSettings.verificationStatus === 'verified'
                        ? 'Verified'
                        : settings.domainSettings.verificationStatus === 'failed'
                        ? 'Failed'
                        : 'Pending - DNS verification in progress'}
                    </p>
                    <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 text-xs text-gray-600">
                      {settings.domainSettings.provisioningState && (
                        <div>
                          <p className="font-medium text-gray-800">Provisioning</p>
                          <p className="text-gray-600">{settings.domainSettings.provisioningState}</p>
                        </div>
                      )}
                      {settings.domainSettings.deploymentStatus && (
                        <div>
                          <p className="font-medium text-gray-800">Deployment</p>
                          <p className="text-gray-600">{settings.domainSettings.deploymentStatus}</p>
                        </div>
                      )}
                      {settings.domainSettings.endpointAssociation && (
                        <div>
                          <p className="font-medium text-gray-800">Endpoint Association</p>
                          <p className="text-gray-600">{settings.domainSettings.endpointAssociation}</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Removed: API Keys Status - Not needed right now */}
          </div>
        </div>
      )}

      {/* Modals */}
      {showEditInfo && settings && (
        <TenantSettingsEdit
          tenant={{
            tenantId: settings.tenantId,
            name: settings.name || 'Organization', // Provide fallback for required field
            contactEmail: settings.contactEmail || 'admin@company.com', // Provide fallback for required field
            contactPhone: settings.contactPhone,
            website: settings.website,
            address: settings.address || { street: '', city: '', state: '', zip: '' },
            branding: {
              primaryColorHex: settings.branding.primaryColorHex
            }
          }}
          onClose={() => setShowEditInfo(false)}
          onSave={loadSettings}
        />
      )}

      {showAdvancedConfig && settings && (
        <UnifiedTenantSettingsModal
          tenant={{
            TenantId: settings.tenantId,
            Name: settings.name || 'Organization',
            LogoUrl: settings.branding.logoUrl,
            PrimaryColorHex: settings.branding.primaryColorHex,
            SecondaryColorHex: settings.branding.secondaryColorHex,
            CustomDomain: settings.domainSettings.customUrl,
            DefaultUrlPath: settings.domainSettings.defaultUrlPath || '', // Add DefaultUrlPath
            MemberIDPrefix: settings.branding.memberIDPrefix || 'OED', // Add MemberIDPrefix
            AdvancedSettings: JSON.stringify({
              branding: settings.branding,
              domain: settings.domainSettings,
              email: settings.emailSettings,
              notifications: settings.notificationSettings,
              features: settings.features
            }),
            SystemFees: '{}'
          }}
          onClose={() => setShowAdvancedConfig(false)}
          onSave={loadSettings}
          setError={setError}
        />
      )}

      <SessionExpiryText />
    </div>
  );
};

export default TenantSettingsPage;
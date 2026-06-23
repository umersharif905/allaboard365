// frontend/src/components/EmailSettingsSection.tsx
import React, { useEffect, useState } from 'react';
import {
  CheckCircle,
  Clock,
  Copy,
  Info,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
  XCircle
} from 'lucide-react';
import { EmailSettingsService, type EmailSettings } from '../services/email-settings.service';
import { type AdvancedTenantSettings } from './UnifiedTenantSettingsModal';

interface EmailSettingsSectionProps {
  settings: AdvancedTenantSettings;
  setSettings: React.Dispatch<React.SetStateAction<AdvancedTenantSettings>>;
  onSave: () => void;
  loading: boolean;
  tenantId?: string; // Add tenantId prop for SysAdmin access to other tenants
}

const EmailSettingsSection: React.FC<EmailSettingsSectionProps> = ({
  settings,
  setSettings,
  onSave,
  loading,
  tenantId
}) => {
  const [emailSettings, setEmailSettings] = useState<EmailSettings>({
    customFromAddress: settings.email.customFromAddress || '',
    dkimEnabled: settings.email.dkimEnabled || false,
    dkimDomain: settings.email.dkimDomain || '',
    dkimSelector: settings.email.dkimSelector || '',
    sendgridDomainId: settings.email.sendgridDomainId || null,
    dnsRecords: settings.email.dnsRecords || [],
    verificationStatus: settings.email.verificationStatus || 'none'
  });

  const [isGenerating, setIsGenerating] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [copiedRecord, setCopiedRecord] = useState<string | null>(null);
  const [message, setMessage] = useState<{type: 'success' | 'error' | 'info', text: string} | null>(null);

  // Apply theme colors and initialize settings from props
  useEffect(() => {
    // Initialize email settings from the settings passed from parent
    // This ensures we use the correct tenant's data when SysAdmin is viewing another tenant
    setEmailSettings({
      customFromAddress: settings.email.customFromAddress || '',
      dkimEnabled: settings.email.dkimEnabled || false,
      dkimDomain: settings.email.dkimDomain || '',
      dkimSelector: settings.email.dkimSelector || '',
      sendgridDomainId: settings.email.sendgridDomainId || null,
      dnsRecords: settings.email.dnsRecords || [],
      verificationStatus: settings.email.verificationStatus || 'none'
    });
    
    applyTenantTheme();
  }, [settings]);

  // Apply tenant theme colors to CSS custom properties
  const applyTenantTheme = () => {
    const root = document.documentElement;
    
    if (settings.branding?.primaryColor) {
      root.style.setProperty('--tenant-primary', settings.branding.primaryColor);
      
      // Generate lighter and darker variants if not provided
      if (settings.branding.secondaryColor) {
        root.style.setProperty('--tenant-primary-light', settings.branding.secondaryColor);
      } else {
        // Generate a lighter variant of the primary color
        const lightVariant = adjustColorBrightness(settings.branding.primaryColor, 40);
        root.style.setProperty('--tenant-primary-light', lightVariant);
      }
      
      if (settings.branding.accentColor) {
        root.style.setProperty('--tenant-primary-dark', settings.branding.accentColor);
      } else {
        // Generate a darker variant of the primary color
        const darkVariant = adjustColorBrightness(settings.branding.primaryColor, -40);
        root.style.setProperty('--tenant-primary-dark', darkVariant);
      }
      
      // Set the tenant theme attribute
      root.setAttribute('data-tenant-theme', 'custom');
    } else {
      // Reset to default theme
      root.removeAttribute('data-tenant-theme');
      root.style.removeProperty('--tenant-primary');
      root.style.removeProperty('--tenant-primary-light');
      root.style.removeProperty('--tenant-primary-dark');
    }
  };

  // Helper function to adjust color brightness
  const adjustColorBrightness = (hex: string, percent: number) => {
    // Remove the # if present
    hex = hex.replace('#', '');
    
    // Convert to RGB
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);
    
    // Adjust brightness
    const newR = Math.max(0, Math.min(255, r + (r * percent / 100)));
    const newG = Math.max(0, Math.min(255, g + (g * percent / 100)));
    const newB = Math.max(0, Math.min(255, b + (b * percent / 100)));
    
    // Convert back to hex
    const toHex = (n: number) => {
      const hex = Math.round(n).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };
    
    return `#${toHex(newR)}${toHex(newG)}${toHex(newB)}`;
  };

  const loadEmailSettings = async () => {
    try {
      const response = await EmailSettingsService.getEmailSettings();
      if (response.success && response.data) {
        setEmailSettings(response.data);
        // Update the main settings state
        setSettings(prev => ({
          ...prev,
          email: {
            ...prev.email,
            ...response.data
          }
        }));
      }
    } catch (error) {
      console.error('Failed to load email settings:', error);
    }
  };

  const handleCustomFromAddressChange = async (email: string) => {
    // Capture the existing DKIM domain BEFORE updating the state
    const existingDkimDomain = emailSettings.dkimDomain;
    const newDomain = EmailSettingsService.extractDomainFromEmail(email);
    
    // Update the local state
    setEmailSettings(prev => ({ ...prev, customFromAddress: email }));
    
    // Update parent modal settings to ensure Save Changes includes the updated email
    setSettings(prev => ({
      ...prev,
      email: {
        ...prev.email,
        customFromAddress: email
      }
    }));
    
    // Check if domain changed (compare new email domain to existing DKIM domain)
    if (newDomain && existingDkimDomain && newDomain !== existingDkimDomain) {
      setMessage({
        type: 'info',
        text: `Domain changed from ${existingDkimDomain} to ${newDomain}. DKIM configuration will need to be regenerated.`
      });
    }
  };

  const handleGenerateDkim = async () => {
    if (!emailSettings.customFromAddress) {
      setMessage({ type: 'error', text: 'Please enter a custom from address first' });
      return;
    }

    const domain = EmailSettingsService.extractDomainFromEmail(emailSettings.customFromAddress);
    if (!domain) {
      setMessage({ type: 'error', text: 'Invalid email address format' });
      return;
    }

    try {
      setIsGenerating(true);
      setMessage(null);
      
      const response = await EmailSettingsService.generateDkimRecords(domain, tenantId);
      
      if (response.success && response.data) {
        setEmailSettings(prev => ({
          ...prev,
          dkimDomain: response.data!.domain,
          dkimSelector: 'em',
          sendgridDomainId: response.data!.sendgridDomainId,
          dnsRecords: response.data!.dnsRecords,
          verificationStatus: 'pending'
        }));
        
        // Update parent modal settings to prevent Save Changes from overwriting DKIM data
        setSettings(prev => ({
          ...prev,
          email: {
            ...prev.email,
            dkimDomain: response.data!.domain,
            dkimSelector: 'em',
            sendgridDomainId: response.data!.sendgridDomainId,
            dnsRecords: response.data!.dnsRecords,
            verificationStatus: 'pending'
          }
        }));
        
        setMessage({ type: 'success', text: response.message || 'DKIM records generated successfully!' });
      } else {
        setMessage({ type: 'error', text: response.message || 'Failed to generate DKIM records' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'An error occurred while generating DKIM records' });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleVerifyDkim = async () => {
    try {
      setIsVerifying(true);
      setMessage(null);
      
      const response = await EmailSettingsService.verifyDkimDomain(tenantId);
      
      if (response.success && response.data) {
        setEmailSettings(prev => ({
          ...prev,
          verificationStatus: response.data!.verificationStatus,
          dkimEnabled: response.data!.dkimEnabled,
          dnsRecords: response.data!.dnsRecords
        }));
        
        // Update parent modal settings to prevent Save Changes from overwriting DKIM data
        setSettings(prev => ({
          ...prev,
          email: {
            ...prev.email,
            verificationStatus: response.data!.verificationStatus,
            dkimEnabled: response.data!.dkimEnabled,
            dnsRecords: response.data!.dnsRecords
          }
        }));
        
        setMessage({ type: 'success', text: response.message || 'DKIM verification completed!' });
      } else {
        setMessage({ type: 'error', text: response.message || 'Failed to verify DKIM domain' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'An error occurred while verifying DKIM domain' });
    } finally {
      setIsVerifying(false);
    }
  };

  const handleDeleteDkim = async () => {
    if (!confirm('Are you sure you want to delete the DKIM configuration? This action cannot be undone.')) {
      return;
    }

    try {
      setIsDeleting(true);
      setMessage(null);
      
      const response = await EmailSettingsService.deleteDkimConfiguration(tenantId);
      
      if (response.success) {
        setEmailSettings(prev => ({
          ...prev,
          dkimEnabled: false,
          dkimDomain: '',
          dkimSelector: '',
          sendgridDomainId: null,
          dnsRecords: [],
          verificationStatus: 'none'
        }));
        
        // Update parent modal settings to prevent Save Changes from overwriting DKIM data
        setSettings(prev => ({
          ...prev,
          email: {
            ...prev.email,
            dkimEnabled: false,
            dkimDomain: '',
            dkimSelector: '',
            sendgridDomainId: null,
            dnsRecords: [],
            verificationStatus: 'none'
          }
        }));
        
        setMessage({ type: 'success', text: 'DKIM configuration deleted successfully' });
      } else {
        setMessage({ type: 'error', text: response.message || 'Failed to delete DKIM configuration' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'An error occurred while deleting DKIM configuration' });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSaveEmailSettings = async () => {
    try {
      setIsUpdating(true);
      setMessage(null);
      
      const response = await EmailSettingsService.updateEmailSettings({
        customFromAddress: emailSettings.customFromAddress
      });
      
      if (response.success) {
        // Update the main settings state
        setSettings(prev => ({
          ...prev,
          email: {
            ...prev.email,
            customFromAddress: emailSettings.customFromAddress,
            dkimEnabled: emailSettings.dkimEnabled,
            dkimDomain: emailSettings.dkimDomain,
            dkimSelector: emailSettings.dkimSelector,
            sendgridDomainId: emailSettings.sendgridDomainId,
            dnsRecords: emailSettings.dnsRecords,
            verificationStatus: emailSettings.verificationStatus
          }
        }));
        
        setMessage({ type: 'success', text: 'Email settings saved successfully!' });
      } else {
        setMessage({ type: 'error', text: response.message || 'Failed to save email settings' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'An error occurred while saving email settings' });
    } finally {
      setIsUpdating(false);
    }
  };

  const copyToClipboard = async (text: string, recordType: string) => {
    const success = await EmailSettingsService.copyToClipboard(text);
    if (success) {
      setCopiedRecord(recordType);
      setTimeout(() => setCopiedRecord(null), 2000);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'verified':
        return <CheckCircle className="h-4 w-4 text-green-600" />;
      case 'failed':
        return <XCircle className="h-4 w-4 text-red-600" />;
      case 'pending':
        return <Clock className="h-4 w-4 text-yellow-600" />;
      default:
        return <div className="h-4 w-4 rounded-full bg-gray-400" />;
    }
  };

  return (
    <div className="space-y-8">
      {/* Message Display */}
      {message && (
        <div className={`p-4 rounded-lg border ${
          message.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' :
          message.type === 'error' ? 'bg-red-50 border-red-200 text-red-800' :
          'bg-blue-50 border-blue-200 text-blue-800'
        }`}>
          <div className="flex items-center">
            {message.type === 'success' && <CheckCircle className="h-5 w-5 mr-2" />}
            {message.type === 'error' && <XCircle className="h-5 w-5 mr-2" />}
            {message.type === 'info' && <Info className="h-5 w-5 mr-2" />}
            {message.text}
          </div>
        </div>
      )}

      {/* Email Configuration Section */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <div className="mb-4">
          <h3 className="text-lg font-medium text-gray-900 mb-2">Email Configuration</h3>
          <p className="text-sm text-gray-600">Configure your organization's email settings</p>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Custom From Address
          </label>
          <input
            type="email"
            value={emailSettings.customFromAddress}
            onChange={(e) => handleCustomFromAddressChange(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary w-full"
            placeholder="noreply@yourcompany.com"
          />
          <p className="mt-1 text-sm text-gray-500">
            This will be the sender address for all emails sent from your organization
          </p>
        </div>
      </div>

      {/* DKIM Configuration Section */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-lg font-medium text-gray-900">Sender Authentication (DKIM)</h3>
            <p className="text-sm text-gray-600">Configure SendGrid domain authentication for email deliverability</p>
          </div>
          <div className="flex gap-2">
            {!emailSettings.dkimDomain && (
              <button
                onClick={handleGenerateDkim}
                disabled={isGenerating || !emailSettings.customFromAddress}
                className="btn-primary flex items-center"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="animate-spin mr-2" size={16} />
                    Generating...
                  </>
                ) : (
                  <>
                    <RefreshCw size={16} className="mr-2" />
                    Generate DKIM Records
                  </>
                )}
              </button>
            )}
            {emailSettings.dkimDomain && (
              <button
                onClick={handleVerifyDkim}
                disabled={isVerifying}
                className="btn-secondary flex items-center"
              >
                {isVerifying ? (
                  <>
                    <Loader2 className="animate-spin mr-2" size={16} />
                    Verifying...
                  </>
                ) : (
                  <>
                    <CheckCircle size={16} className="mr-2" />
                    Verify Domain
                  </>
                )}
              </button>
            )}
            {emailSettings.dkimDomain && (
              <button
                onClick={handleDeleteDkim}
                disabled={isDeleting}
                className="btn-danger flex items-center"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="animate-spin mr-2" size={16} />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 size={16} className="mr-2" />
                    Delete
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* DKIM Status */}
        {emailSettings.dkimDomain && (
          <div className="mb-6 p-4 bg-gray-50 rounded-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                {getStatusIcon(emailSettings.verificationStatus)}
                <div className="ml-3">
                  <p className="text-sm font-medium text-gray-900">
                    Domain: {emailSettings.dkimDomain}
                  </p>
                  <p className="text-sm text-gray-600">
                    Status: <span className={`px-2 py-1 rounded-full text-xs font-medium ${EmailSettingsService.getStatusColor(emailSettings.verificationStatus)}`}>
                      {emailSettings.verificationStatus}
                    </span>
                  </p>
                </div>
              </div>
              {emailSettings.dkimEnabled && (
                <div className="flex items-center text-green-600">
                  <CheckCircle className="h-5 w-5 mr-1" />
                  <span className="text-sm font-medium">DKIM Enabled</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* DNS Records Table */}
        {emailSettings.dnsRecords.length > 0 && (
          <div className="mb-6">
            <h4 className="text-md font-medium text-gray-900 mb-4">DNS Records to Add</h4>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Host</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Value</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {emailSettings.dnsRecords.map((record, index) => (
                    <tr key={index}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {record.type}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {record.host}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        <code className="bg-gray-100 px-2 py-1 rounded text-xs break-all">
                          {record.value}
                        </code>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${EmailSettingsService.getStatusColor(record.status)}`}>
                          {record.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        <button
                          onClick={() => copyToClipboard(record.value, `record-${index}`)}
                          className="text-oe-primary hover:text-blue-900 flex items-center"
                        >
                          <Copy className="h-4 w-4 mr-1" />
                          {copiedRecord === `record-${index}` ? 'Copied!' : 'Copy'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Instructions */}
        {emailSettings.dnsRecords.length > 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-start">
              <Info className="h-5 w-5 text-blue-500 mr-3 mt-0.5" />
              <div className="text-sm text-blue-800">
                <p className="font-medium mb-2">Next Steps:</p>
                <ol className="list-decimal list-inside space-y-1">
                  <li>Add the DNS records above to your domain's DNS provider</li>
                  <li>Wait 5-30 minutes for DNS propagation</li>
                  <li>Click "Verify Domain" to check the configuration</li>
                  <li>Once verified, DKIM authentication will be automatically enabled</li>
                </ol>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSaveEmailSettings}
          disabled={isUpdating || loading}
          className="btn-primary flex items-center"
        >
          {isUpdating ? (
            <>
              <Loader2 className="animate-spin mr-2" size={16} />
              Saving...
            </>
          ) : (
            <>
              <Save size={16} className="mr-2" />
              Save Email Settings
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export default EmailSettingsSection;

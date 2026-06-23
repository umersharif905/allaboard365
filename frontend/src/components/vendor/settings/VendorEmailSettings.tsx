// Vendor Email Settings (VendorAdmin). Configure the Microsoft 365 (Outlook)
// shared mailbox that powers the Back Office email inbox — Tenant ID, Client ID,
// Client Secret and shared mailbox address. Ported from the legacy (unrouted)
// VendorSettings.tsx "Email" tab; wires to backend routes/me/vendor/profile.js:
//   GET/PUT  /api/me/vendor/profile/email-config
//   POST     /api/me/vendor/profile/email-config/test
// These write the same oe.Vendors Office365* columns that graphClient.js /
// graphEmailService.getVendorEmailConfig() read for the inbox + outbound send.
import { useEffect, useState } from 'react';
import { Mail, CheckCircle, AlertCircle, Send, Save } from 'lucide-react';
import { apiService } from '../../../services/api.service';

interface EmailConfigData {
  emailProvider: string;
  emailFromAddress: string;
  emailFromName: string;
  emailReplyTo: string;
  office365TenantId: string;
  office365ClientId: string;
  hasClientSecret: boolean;
  office365SharedMailbox: string;
}

const VendorEmailSettings = () => {
  const [emailConfig, setEmailConfig] = useState<EmailConfigData>({
    emailProvider: 'Office365',
    emailFromAddress: '',
    emailFromName: '',
    emailReplyTo: '',
    office365TenantId: '',
    office365ClientId: '',
    hasClientSecret: false,
    office365SharedMailbox: '',
  });
  const [emailConfigLoading, setEmailConfigLoading] = useState(false);
  const [emailConfigSaving, setEmailConfigSaving] = useState(false);
  const [emailMessage, setEmailMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [newClientSecret, setNewClientSecret] = useState('');
  const [testEmailAddress, setTestEmailAddress] = useState('');
  const [testingEmail, setTestingEmail] = useState(false);
  const [testEmailResult, setTestEmailResult] = useState<{ success: boolean; message: string } | null>(null);

  const loadEmailConfig = async () => {
    try {
      setEmailConfigLoading(true);
      const response = (await apiService.get('/api/me/vendor/profile/email-config')) as {
        success: boolean;
        data?: EmailConfigData;
      };
      if (response?.success && response.data) {
        setEmailConfig(response.data);
      }
    } catch (error) {
      console.error('Error loading email config:', error);
    } finally {
      setEmailConfigLoading(false);
    }
  };

  useEffect(() => {
    loadEmailConfig();
  }, []);

  const saveEmailConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setEmailConfigSaving(true);
      setEmailMessage(null);

      const payload: Record<string, string> = {
        emailProvider: emailConfig.emailProvider,
        emailFromAddress: emailConfig.emailFromAddress,
        emailFromName: emailConfig.emailFromName,
        emailReplyTo: emailConfig.emailReplyTo,
        office365TenantId: emailConfig.office365TenantId,
        office365ClientId: emailConfig.office365ClientId,
        office365SharedMailbox: emailConfig.office365SharedMailbox,
      };

      // Only include secret if a new one was provided
      if (newClientSecret.trim()) {
        payload.office365ClientSecret = newClientSecret;
      }

      const response = (await apiService.put('/api/me/vendor/profile/email-config', payload)) as {
        success: boolean;
        message?: string;
      };

      if (response.success) {
        setEmailMessage({ type: 'success', text: 'Email configuration saved successfully!' });
        setNewClientSecret('');
        loadEmailConfig(); // Refresh to get updated hasClientSecret flag
      } else {
        throw new Error(response.message || 'Failed to save');
      }
    } catch (error: any) {
      console.error('Error saving email config:', error);
      setEmailMessage({ type: 'error', text: error.message || 'Failed to save email configuration' });
    } finally {
      setEmailConfigSaving(false);
    }
  };

  const testEmail = async () => {
    if (!testEmailAddress.trim()) {
      setTestEmailResult({ success: false, message: 'Please enter a test email address' });
      return;
    }

    try {
      setTestingEmail(true);
      setTestEmailResult(null);

      const response = (await apiService.post('/api/me/vendor/profile/email-config/test', {
        testEmailAddress,
      })) as { success: boolean; message?: string };

      setTestEmailResult({
        success: response.success,
        message: response.message || (response.success ? 'Test email sent successfully!' : 'Failed to send test email'),
      });
    } catch (error: any) {
      console.error('Error testing email:', error);
      setTestEmailResult({
        success: false,
        message: error.message || 'Failed to send test email',
      });
    } finally {
      setTestingEmail(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium text-gray-900">Email Configuration</h2>
            <p className="text-sm text-gray-500 mt-1">
              Microsoft 365 (Outlook) shared mailbox used by the Back Office email inbox
            </p>
          </div>
        </div>
      </div>

      <form onSubmit={saveEmailConfig} className="p-6 space-y-6">
        {emailMessage && (
          <div
            className={`p-4 rounded-lg flex items-center gap-2 ${
              emailMessage.type === 'success'
                ? 'bg-green-50 border border-green-200 text-green-800'
                : 'bg-red-50 border border-red-200 text-red-800'
            }`}
          >
            {emailMessage.type === 'success' ? <CheckCircle className="h-5 w-5" /> : <AlertCircle className="h-5 w-5" />}
            {emailMessage.text}
          </div>
        )}

        {emailConfigLoading ? (
          <div className="py-12 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto"></div>
            <p className="mt-2 text-gray-500">Loading email configuration...</p>
          </div>
        ) : (
          <>
            {/* Office 365 Configuration */}
            <div className="space-y-4">
              <h3 className="font-medium text-gray-900 flex items-center gap-2">
                <Mail className="h-5 w-5" style={{ color: 'var(--oe-primary, #1f8dbf)' }} />
                Office 365 Configuration
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tenant ID <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={emailConfig.office365TenantId}
                    onChange={(e) => setEmailConfig({ ...emailConfig, office365TenantId: e.target.value })}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Client ID <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={emailConfig.office365ClientId}
                    onChange={(e) => setEmailConfig({ ...emailConfig, office365ClientId: e.target.value })}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Client Secret{' '}
                    {emailConfig.hasClientSecret && <span className="text-green-600 text-xs">(configured)</span>}
                  </label>
                  <input
                    type="password"
                    value={newClientSecret}
                    onChange={(e) => setNewClientSecret(e.target.value)}
                    placeholder={emailConfig.hasClientSecret ? 'Enter new secret to change' : 'Enter client secret'}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    {emailConfig.hasClientSecret
                      ? 'Leave blank to keep current secret, or enter a new value to update'
                      : 'Required for authentication. Use the secret VALUE from Azure (not the Secret ID).'}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Shared Mailbox <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="email"
                    value={emailConfig.office365SharedMailbox}
                    onChange={(e) => setEmailConfig({ ...emailConfig, office365SharedMailbox: e.target.value })}
                    placeholder="membersuccess@yourdomain.com"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                </div>
              </div>
            </div>

            {/* Display Settings */}
            <div className="space-y-4 pt-4 border-t border-gray-200">
              <h3 className="font-medium text-gray-900">Display Settings</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">From Name</label>
                  <input
                    type="text"
                    value={emailConfig.emailFromName}
                    onChange={(e) => setEmailConfig({ ...emailConfig, emailFromName: e.target.value })}
                    placeholder="e.g., Sharewell Member Success"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Reply-To Address</label>
                  <input
                    type="email"
                    value={emailConfig.emailReplyTo}
                    onChange={(e) => setEmailConfig({ ...emailConfig, emailReplyTo: e.target.value })}
                    placeholder="Optional - defaults to shared mailbox"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                </div>
              </div>
            </div>

            {/* Test Email */}
            <div className="space-y-4 pt-4 border-t border-gray-200">
              <h3 className="font-medium text-gray-900">Test Configuration</h3>
              <p className="text-xs text-gray-500 -mt-2">
                Sends a real email from the shared mailbox above to verify the credentials work.
              </p>

              <div className="flex items-end gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Test Email Address</label>
                  <input
                    type="email"
                    value={testEmailAddress}
                    onChange={(e) => setTestEmailAddress(e.target.value)}
                    placeholder="your@email.com"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                </div>
                <button
                  type="button"
                  onClick={testEmail}
                  disabled={testingEmail || !testEmailAddress.trim()}
                  className="btn-secondary inline-flex items-center gap-2"
                >
                  <Send className="h-4 w-4" />
                  {testingEmail ? 'Sending...' : 'Send Test'}
                </button>
              </div>

              {testEmailResult && (
                <div
                  className={`p-3 rounded-lg text-sm flex items-center gap-2 ${
                    testEmailResult.success
                      ? 'bg-green-50 text-green-800 border border-green-200'
                      : 'bg-red-50 text-red-800 border border-red-200'
                  }`}
                >
                  {testEmailResult.success ? <CheckCircle className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                  {testEmailResult.message}
                </div>
              )}
            </div>

            {/* Save Button */}
            <div className="pt-4 border-t border-gray-200 flex justify-end">
              <button type="submit" disabled={emailConfigSaving} className="btn-primary inline-flex items-center gap-2">
                <Save className="h-4 w-4" />
                {emailConfigSaving ? 'Saving...' : 'Save Email Settings'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
};

export default VendorEmailSettings;

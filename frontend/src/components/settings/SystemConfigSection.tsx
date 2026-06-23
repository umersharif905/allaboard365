// src/components/settings/SystemConfigSection.tsx
/**
 * System Configuration Section
 * Global platform settings, API configuration, and system parameters
 */

import React, { useState, useEffect } from 'react';
import { 
  Server, 
  Users, 
  Clock, 
  AlertTriangle, 
  Info,
  CheckCircle,
  Mail
} from 'lucide-react';
import { useSystemSettings } from '../../hooks/useSystemSettings';

interface SystemConfigSectionProps {
  onSettingsChange: () => void;
}

interface SystemConfig {
  platformName: string;
  apiRateLimit: number;
  sessionTimeout: number;
  maintenanceMode: boolean;
  maxFileUploadMb: number;
  defaultUserRole: string;
  autoApproveSubscriptions: boolean;
  enableGuestAccess: boolean;
  systemTimezone: string;
  integrationErrorNotificationEmails: string;
}

export function SystemConfigSection({ onSettingsChange }: SystemConfigSectionProps) {
  const { systemSettings, updateSystemSetting, isLoading } = useSystemSettings();
  const [config, setConfig] = useState<SystemConfig>({
    platformName: 'AllAboard365',
    apiRateLimit: 1000,
    sessionTimeout: 60,
    maintenanceMode: false,
    maxFileUploadMb: 10,
    defaultUserRole: 'Member',
    autoApproveSubscriptions: false,
    enableGuestAccess: false,
    systemTimezone: 'UTC',
    integrationErrorNotificationEmails: ''
  });

  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (systemSettings) {
      setConfig({
        platformName: systemSettings["system.platform_name" as keyof typeof systemSettings] || 'AllAboard365',
        apiRateLimit: parseInt(systemSettings["system.api_rate_limit" as keyof typeof systemSettings] || '1000'),
        sessionTimeout: parseInt(systemSettings["system.session_timeout" as keyof typeof systemSettings] || '60'),
        maintenanceMode: systemSettings["system.maintenance_mode" as keyof typeof systemSettings] === 'true',
        maxFileUploadMb: parseInt(systemSettings["system.max_file_upload_mb" as keyof typeof systemSettings] || '10'),
        defaultUserRole: systemSettings["system.default_user_role" as keyof typeof systemSettings] || 'Member',
        autoApproveSubscriptions: systemSettings["system.auto_approve_subscriptions" as keyof typeof systemSettings] === 'true',
        enableGuestAccess: systemSettings["system.enable_guest_access" as keyof typeof systemSettings] === 'true',
        systemTimezone: systemSettings["system.timezone" as keyof typeof systemSettings] || 'UTC',
        integrationErrorNotificationEmails:
          systemSettings["system.integration_error_notification_emails" as keyof typeof systemSettings] || ''
      });
    }
  }, [systemSettings]);

  const validateField = (field: string, value: any): string | null => {
    switch (field) {
      case 'platformName':
        return !value || value.length < 2 ? 'Platform name must be at least 2 characters' : null;
      case 'apiRateLimit':
        return value < 100 || value > 10000 ? 'API rate limit must be between 100 and 10,000' : null;
      case 'sessionTimeout':
        return value < 15 || value > 480 ? 'Session timeout must be between 15 and 480 minutes' : null;
      case 'maxFileUploadMb':
        return value < 1 || value > 100 ? 'File upload limit must be between 1 and 100 MB' : null;
      case 'integrationErrorNotificationEmails': {
        const raw = String(value || '').trim();
        if (!raw) return null;
        const parts = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
        const bad = parts.filter((p) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p));
        return bad.length > 0 ? `Invalid email${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}` : null;
      }
      default:
        return null;
    }
  };

  const handleConfigChange = async (field: keyof SystemConfig, value: any) => {
    const error = validateField(field, value);
    setValidationErrors(prev => ({
      ...prev,
      [field]: error || ''
    }));

    const newConfig = { ...config, [field]: value };
    setConfig(newConfig);
    onSettingsChange();

    // Map to system setting keys and update
    const settingKey = `system.${field.replace(/([A-Z])/g, '_$1').toLowerCase()}`;
    try {
      await updateSystemSetting(settingKey, value.toString());
    } catch (error) {
      console.error(`Failed to update ${settingKey}:`, error);
    }
  };

  const renderSetting = (setting: any) => {
    const hasError = validationErrors[setting.key];

    switch (setting.type) {
      case 'text':
        return (
          <input
            type="text"
            value={setting.value}
            onChange={(e) => handleConfigChange(setting.key, e.target.value)}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
              hasError ? 'border-red-300' : 'border-gray-300'
            }`}
            disabled={isLoading}
          />
        );

      case 'number':
        return (
          <input
            type="number"
            value={setting.value}
            min={setting.min}
            max={setting.max}
            onChange={(e) => handleConfigChange(setting.key, parseInt(e.target.value))}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
              hasError ? 'border-red-300' : 'border-gray-300'
            }`}
            disabled={isLoading}
          />
        );

      case 'select':
        return (
          <select
            value={setting.value}
            onChange={(e) => handleConfigChange(setting.key, e.target.value)}
            className="w-full form-input focus:outline-none focus:ring-2 focus:ring-oe-primary"
            disabled={isLoading}
          >
            {setting.options.map((option: any) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        );

      case 'boolean':
        return (
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => handleConfigChange(setting.key, !setting.value)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                setting.value ? 'bg-oe-primary' : 'bg-gray-200'
              }`}
              disabled={isLoading}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  setting.value ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
            <span className="ml-3 text-sm text-gray-600">
              {setting.value ? 'Enabled' : 'Disabled'}
            </span>
          </div>
        );

      default:
        return null;
    }
  };

  const configSections = [
    {
      title: 'Platform Configuration',
      icon: Server,
      description: 'Core platform settings and branding',
      settings: [
        {
          key: 'platformName',
          label: 'Platform Name',
          type: 'text',
          value: config.platformName,
          description: 'Display name for the platform across all interfaces'
        },
        {
          key: 'systemTimezone',
          label: 'System Timezone',
          type: 'select',
          value: config.systemTimezone,
          options: [
            { value: 'UTC', label: 'UTC' },
            { value: 'America/New_York', label: 'Eastern Time' },
            { value: 'America/Chicago', label: 'Central Time' },
            { value: 'America/Denver', label: 'Mountain Time' },
            { value: 'America/Los_Angeles', label: 'Pacific Time' }
          ],
          description: 'Default timezone for system operations and reporting'
        }
      ]
    },
    {
      title: 'API & Performance',
      icon: Clock,
      description: 'API rate limiting and performance settings',
      settings: [
        {
          key: 'apiRateLimit',
          label: 'API Rate Limit (per hour)',
          type: 'number',
          value: config.apiRateLimit,
          min: 100,
          max: 10000,
          description: 'Maximum API calls per user per hour'
        },
        {
          key: 'sessionTimeout',
          label: 'Session Timeout (minutes)',
          type: 'number',
          value: config.sessionTimeout,
          min: 15,
          max: 480,
          description: 'User session timeout in minutes'
        },
        {
          key: 'maxFileUploadMb',
          label: 'Max File Upload (MB)',
          type: 'number',
          value: config.maxFileUploadMb,
          min: 1,
          max: 100,
          description: 'Maximum file upload size in megabytes'
        }
      ]
    },
    {
      title: 'User Management',
      icon: Users,
      description: 'Default user roles and access settings',
      settings: [
        {
          key: 'defaultUserRole',
          label: 'Default User Role',
          type: 'select',
          value: config.defaultUserRole,
          options: [
            { value: 'Member', label: 'Member' },
            { value: 'Group_Admin', label: 'Group Admin' },
            { value: 'Affiliate_Agent', label: 'Agent' }
          ],
          description: 'Default role assigned to new users'
        },
        {
          key: 'autoApproveSubscriptions',
          label: 'Auto-Approve Subscriptions',
          type: 'boolean',
          value: config.autoApproveSubscriptions,
          description: 'Automatically approve product subscription requests'
        },
        {
          key: 'enableGuestAccess',
          label: 'Enable Guest Access',
          type: 'boolean',
          value: config.enableGuestAccess,
          description: 'Allow limited access without authentication'
        }
      ]
    },
    {
      title: 'System Status',
      icon: AlertTriangle,
      description: 'System maintenance and operational settings',
      settings: [
        {
          key: 'maintenanceMode',
          label: 'Maintenance Mode',
          type: 'boolean',
          value: config.maintenanceMode,
          description: 'Enable to display maintenance message to users'
        }
      ]
    },
    {
      title: 'Error Notifications',
      icon: Mail,
      description: 'Recipients for the every-15-minute integration error digest',
      settings: [
        {
          key: 'integrationErrorNotificationEmails',
          label: 'Integration error digest recipients',
          type: 'text',
          value: config.integrationErrorNotificationEmails,
          description:
            'Comma-separated list of email addresses that receive the every-15-minute digest for high and critical SystemIntegrationErrors (DIME vault failures, webhook failures, etc.). Known user-resolvable errors like bank declines are not included. Leave blank to disable.'
        }
      ]
    }
  ];

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-oe-neutral-dark">System Configuration</h2>
        <p className="text-gray-600 mt-1">
          Configure global platform settings, API parameters, and system behavior
        </p>
      </div>

      <div className="space-y-8">
        {configSections.map((section) => {
          const Icon = section.icon;
          
          return (
            <div key={section.title} className="border border-gray-200 rounded-lg">
              <div className="bg-oe-neutral-light px-6 py-4 border-b border-gray-200">
                <div className="flex items-center space-x-3">
                  <Icon className="h-5 w-5 text-gray-600" />
                  <div>
                    <h3 className="text-lg font-medium text-oe-neutral-dark">
                      {section.title}
                    </h3>
                    <p className="text-sm text-gray-600">{section.description}</p>
                  </div>
                </div>
              </div>

              <div className="p-6 space-y-6">
                {section.settings.map((setting) => (
                  <div key={setting.key} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-gray-700">
                        {setting.label}
                      </label>
                      {validationErrors[setting.key] ? (
                        <span className="text-sm text-oe-error flex items-center space-x-1">
                          <AlertTriangle className="h-4 w-4" />
                          <span>{validationErrors[setting.key]}</span>
                        </span>
                      ) : (
                        <CheckCircle className="h-4 w-4 text-oe-success" />
                      )}
                    </div>
                    
                    {renderSetting(setting)}
                    
                    <div className="flex items-start space-x-2">
                      <Info className="h-4 w-4 text-gray-400 mt-0.5 flex-shrink-0" />
                      <p className="text-sm text-gray-500">{setting.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Maintenance Mode Warning */}
      {config.maintenanceMode && (
        <div className="mt-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-center space-x-2">
            <AlertTriangle className="h-5 w-5 text-oe-warning" />
            <h4 className="font-medium text-yellow-800">Maintenance Mode Active</h4>
          </div>
          <p className="text-sm text-yellow-700 mt-1">
            The platform is currently in maintenance mode. Users will see a maintenance message when accessing the system.
          </p>
        </div>
      )}
    </div>
  );
}





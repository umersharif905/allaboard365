// src/pages/admin/Settings.tsx
/**
 * System Settings & Configuration Management
 * Comprehensive administrative tools for platform configuration
 */

import {
    Activity,
    ExternalLink,
    RefreshCw,
    Save,
    Server,
    Settings as SettingsIcon
} from 'lucide-react';
import { useState } from 'react';
import { SystemConfigSection } from '../../components/settings/SystemConfigSection';
import { useSystemSettings } from '../../hooks/useSystemSettings';

type SettingsTab = 'system';

export default function Settings() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('system');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const { 
    isLoading, 
    saveAllSettings, 
    reloadSettings,
    healthStatus 
  } = useSystemSettings();

  const tabs = [
    {
      id: 'system' as SettingsTab,
      name: 'System Configuration',
      icon: Server,
      description: 'Global platform settings and API configuration'
    }
    // Removed non-functional tabs: Integration, Security, Maintenance
    // These can be added back when implemented
  ];

  const handleSaveAll = async () => {
    try {
      await saveAllSettings();
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  };

  const handleReload = async () => {
    try {
      await reloadSettings();
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error('Failed to reload settings:', error);
    }
  };

  const renderActiveSection = () => {
    const sectionProps = {
      onSettingsChange: () => setHasUnsavedChanges(true)
    };

    return <SystemConfigSection {...sectionProps} />;
  };

  return (
    <div className="min-h-screen bg-oe-neutral-light">
      {/* Header */}
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div className="flex items-center space-x-3">
              <SettingsIcon className="h-8 w-8 text-gray-600" />
              <div>
                <h1 className="text-3xl font-bold text-oe-neutral-dark">System Settings</h1>
                <p className="text-gray-600">Platform configuration and administration</p>
              </div>
            </div>
            
            {/* Action Buttons */}
            <div className="flex items-center space-x-3">
              {/* System Health Indicator */}
              <div className="flex items-center space-x-2">
                <Activity className={`h-5 w-5 ${
                  healthStatus === 'healthy' ? 'text-oe-success' : 
                  healthStatus === 'warning' ? 'text-oe-warning' : 'text-oe-error'
                }`} />
                <span className="text-sm text-gray-600">
                  System: {healthStatus || 'Unknown'}
                </span>
              </div>

              {/* Reload Button */}
              <button
                onClick={handleReload}
                disabled={isLoading}
                className="flex items-center space-x-2 px-4 py-2 border border-gray-300 rounded-md text-gray-700 bg-white hover:bg-oe-neutral-light disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                <span>Reload</span>
              </button>

              {/* Save All Button */}
              <button
                onClick={handleSaveAll}
                disabled={!hasUnsavedChanges || isLoading}
                className={`flex items-center space-x-2 px-4 py-2 rounded-md ${
                  hasUnsavedChanges 
                    ? 'bg-oe-primary text-white hover:bg-oe-dark' 
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                }`}
              >
                <Save className="h-4 w-4" />
                <span>Save All Changes</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex space-x-8">
          {/* Navigation Sidebar */}
          <div className="w-80 flex-shrink-0">
            <div className="bg-white rounded-lg shadow">
              <div className="p-6">
                <h3 className="text-lg font-medium text-oe-neutral-dark mb-4">
                  Configuration Sections
                </h3>
                
                <nav className="space-y-2">
                  {tabs.map((tab) => {
                    const Icon = tab.icon;
                    const isActive = activeTab === tab.id;
                    
                    return (
                      <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`w-full text-left p-3 rounded-md transition-colors ${
                          isActive
                            ? 'bg-oe-light text-oe-dark border-l-4 border-oe-primary'
                            : 'text-gray-600 hover:bg-oe-neutral-light hover:text-oe-neutral-dark'
                        }`}
                      >
                        <div className="flex items-start space-x-3">
                          <Icon className={`h-5 w-5 mt-0.5 ${
                            isActive ? 'text-oe-primary' : 'text-gray-400'
                          }`} />
                          <div>
                            <div className="font-medium">{tab.name}</div>
                            <div className="text-sm text-gray-500 mt-1">
                              {tab.description}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </nav>
              </div>
            </div>

            {/* Unsaved Changes Warning */}
            {hasUnsavedChanges && (
              <div className="mt-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <div className="flex items-center space-x-2">
                  <div className="h-2 w-2 bg-yellow-400 rounded-full"></div>
                  <p className="text-sm text-yellow-800">
                    You have unsaved changes
                  </p>
                </div>
                <p className="text-xs text-oe-warning mt-1">
                  Click "Save All Changes" to apply your modifications
                </p>
              </div>
            )}
          </div>

          {/* Main Content Area */}
          <div className="flex-1 min-w-0">
            <div className="bg-white rounded-lg shadow">
              {isLoading ? (
                <div className="p-8 text-center">
                  <RefreshCw className="h-8 w-8 animate-spin mx-auto text-gray-400" />
                  <p className="mt-2 text-gray-600">Loading settings...</p>
                </div>
              ) : (
                renderActiveSection()
              )}
            </div>
          </div>
        {/* Developer Tools Section */}
        <div className="card mt-6">
          <div className="border-b border-gray-200 pb-4 mb-4">
            <h3 className="text-lg font-medium text-gray-900">Developer Tools</h3>
            <p className="mt-1 text-sm text-gray-600">
              Resources for development and testing
            </p>
          </div>
          
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-medium text-gray-900">Style Guide</h4>
                <p className="text-sm text-gray-500">
                  View corporate design system and component library
                </p>
              </div>
              <a
                href="/style-guide"
                target="_blank"
                className="btn-secondary flex items-center"
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                Open Style Guide
              </a>
            </div>
            
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-medium text-gray-900">Component Testing</h4>
                <p className="text-sm text-gray-500">
                  Test individual components in isolation
                </p>
              </div>
              <button
                onClick={() => window.open('/style-guide', '_blank')}
                className="text-oe-primary hover:text-oe-dark font-medium text-sm"
              >
                View Components →
              </button>
            </div>
          </div>
        </div>

        </div>
      </div>
    </div>
  );
}



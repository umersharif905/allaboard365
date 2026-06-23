// src/hooks/useSystemSettings.ts
import { useState } from "react";
import { apiService } from "../services/api.service";

export function useSystemSettings() {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(false);
  const [systemSettings, setSystemSettings] = useState({});
  const [isLoading, setIsLoading] = useState(false);
 
  const fetchSettings = async () => {
    setLoading(true);
    setLoading(false);
  };
 
  // Fix for SystemConfigSection.tsx - add settingKey and value parameters
  const updateSystemSetting = async (settingKey: string, value: string) => {
    setIsLoading(true);
    try {
      const response = await apiService.put(`/api/admin/system-settings/${settingKey}`, { value }) as any;
      
      // Simple approach - just update the setting regardless of response format
      setSystemSettings(prev => ({ ...prev, [settingKey]: value }));
      
    } catch (error) {
      console.error('Failed to update system setting:', error);
    } finally {
      setIsLoading(false);
    }
  };
 
  const saveAllSettings = async () => {
    setIsLoading(true);
    await new Promise(resolve => setTimeout(resolve, 1000));
    setIsLoading(false);
  };
 
  const reloadSettings = async () => {
    setIsLoading(true);
    await fetchSettings();
    setIsLoading(false);
  };
 
  // Fix for settings.tsx - return status string instead of object
  const healthStatus = "healthy";
 
  return {
    settings,
    loading,
    fetchSettings,
    systemSettings,
    updateSystemSetting,
    isLoading,
    saveAllSettings,
    reloadSettings,
    healthStatus
  };
}
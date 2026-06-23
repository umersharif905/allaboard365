import { CheckCircle, Info, RefreshCw, XCircle } from 'lucide-react';
import React, { useEffect, useState } from 'react';

interface UrlPathManagerProps {
  tenantId: string;
  currentUrlPath?: string;
  onUrlPathSet: (urlPath: string) => void;
  onUrlPathSaved?: () => void; // Callback to refresh parent data
  canEdit?: boolean; // Whether user can edit (SysAdmin) or just view (TenantAdmin)
}

const UrlPathManager: React.FC<UrlPathManagerProps> = ({
  tenantId,
  currentUrlPath,
  onUrlPathSet,
  onUrlPathSaved,
  canEdit = true
}) => {
  console.log('🔍 UrlPathManager received currentUrlPath:', currentUrlPath, 'for tenant:', tenantId);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState(currentUrlPath || '');
  
  // Debug when currentUrlPath prop changes
  useEffect(() => {
    console.log('🔍 UrlPathManager currentUrlPath prop changed to:', currentUrlPath);
    setSelectedPath(currentUrlPath || '');
  }, [currentUrlPath]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Check availability when selectedPath changes
  useEffect(() => {
    // Clear previous validation error
    setValidationError(null);
    
    if (selectedPath && selectedPath !== currentUrlPath) {
      // Validate format first
      const validationError = validateUrlPath(selectedPath);
      if (validationError) {
        setValidationError(validationError);
        setIsAvailable(false);
        return;
      }
      
      checkAvailability(selectedPath);
    } else if (selectedPath === currentUrlPath) {
      setIsAvailable(true);
    }
  }, [selectedPath, currentUrlPath]);

  const checkAvailability = async (urlPath: string) => {
    if (!urlPath) {
      setIsAvailable(null);
      return;
    }

    try {
      setCheckingAvailability(true);
      const response = await fetch(`/api/tenant-identification/check-availability/${urlPath}?excludeTenantId=${tenantId}`);
      const data = await response.json();

      if (data.success) {
        setIsAvailable(data.data.isAvailable);
      } else {
        setIsAvailable(false);
      }
    } catch (err) {
      console.error('Error checking availability:', err);
      setIsAvailable(false);
    } finally {
      setCheckingAvailability(false);
    }
  };

  const generateSuggestions = async (tenantName: string) => {
    try {
      setLoading(true);
      const response = await fetch(`/api/tenant-identification/suggestions/${encodeURIComponent(tenantName)}`);
      const data = await response.json();
      
      if (data.success) {
        setSuggestions(data.data);
      }
    } catch (err) {
      setError('Failed to generate suggestions');
    } finally {
      setLoading(false);
    }
  };

  const setUrlPath = async (urlPath: string) => {
    console.log('🔍 UrlPathManager setUrlPath called with:', urlPath, 'for tenant:', tenantId);
    try {
      setLoading(true);
      setError(null);
      setSuccess(null);
      
      const token = localStorage.getItem('accessToken');
      if (!token) {
        setError('Please log in to set URL path');
        return;
      }
      
      const response = await fetch('/api/tenant-identification/set-url-path', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ tenantId, urlPath })
      });
      
      if (response.status === 401) {
        setError('Authentication required. Please log in again.');
        return;
      }
      
      const data = await response.json();
      
      if (data.success) {
        setSuccess(`URL path "${urlPath}" set successfully! You can now use app.allaboard365.com/${urlPath}`);
        onUrlPathSet(urlPath);
        setIsAvailable(true);
        // Trigger parent data refresh
        if (onUrlPathSaved) {
          onUrlPathSaved();
        }
      } else {
        setError(data.message || 'Failed to set URL path');
      }
    } catch (err) {
      console.error('Error setting URL path:', err);
      setError('Failed to set URL path. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    setSelectedPath(suggestion);
  };

  const validateUrlPath = (path: string): string | null => {
    if (!path) return 'URL path is required';
    
    // Convert to lowercase and check for invalid characters
    const formatted = path.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (formatted !== path.toLowerCase()) {
      return 'URL path can only contain lowercase letters, numbers, and hyphens';
    }
    
    // Check if it starts and ends with alphanumeric
    if (!/^[a-z0-9]/.test(formatted) || !/[a-z0-9]$/.test(formatted)) {
      return 'URL path must start and end with letters or numbers';
    }
    
    // Check for consecutive hyphens
    if (formatted.includes('--')) {
      return 'URL path cannot contain consecutive hyphens';
    }
    
    return null;
  };

  const handleSetClick = () => {
    console.log('🔍 UrlPathManager handleSetClick called with selectedPath:', selectedPath, 'isAvailable:', isAvailable);
    if (!selectedPath) return;
    
    const validationError = validateUrlPath(selectedPath);
    if (validationError) {
      setError(validationError);
      return;
    }
    
    if (isAvailable) {
      console.log('🔍 UrlPathManager calling setUrlPath with:', selectedPath);
      setUrlPath(selectedPath);
    }
  };

  const getAvailabilityStatus = () => {
    if (validationError) {
      return (
        <div className="flex items-center gap-2 text-sm text-red-600">
          <XCircle className="h-4 w-4" />
          {validationError}
        </div>
      );
    }

    if (checkingAvailability) {
      return (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <RefreshCw className="h-4 w-4 animate-spin" />
          Checking availability...
        </div>
      );
    }

    if (isAvailable === true) {
      return (
        <div className="flex items-center gap-2 text-sm text-green-600">
          <CheckCircle className="h-4 w-4" />
          Available
        </div>
      );
    }

    if (isAvailable === false) {
      return (
        <div className="flex items-center gap-2 text-sm text-red-600">
          <XCircle className="h-4 w-4" />
          Not available
        </div>
      );
    }

    return null;
  };

  return (
    <div className="space-y-4">
      {!canEdit && (
        <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
          <div className="flex items-start">
            <Info className="h-4 w-4 text-blue-500 mr-2 mt-0.5" />
            <div className="text-sm text-blue-800">
              <p className="font-medium">Read-Only View</p>
              <p className="text-xs mt-1">Only System Administrators can modify the URL path. Contact your administrator if changes are needed.</p>
            </div>
          </div>
        </div>
      )}
      <div>
        <div className="flex items-center gap-2">
          <div className="flex items-center px-3 py-2 bg-gray-50 border border-gray-300 rounded-l-md text-sm text-gray-700 font-mono">
            app.allaboard365.com/
          </div>
          <input
            type="text"
            value={selectedPath}
            onChange={canEdit ? (e) => setSelectedPath(e.target.value) : undefined}
            placeholder={canEdit ? "mightywellhealth" : ""}
            disabled={!canEdit}
            className={`flex-1 px-3 py-2 border border-gray-300 rounded-r-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
              !canEdit ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''
            }`}
          />
          {canEdit && (
            <button
              onClick={handleSetClick}
              disabled={loading || !selectedPath || !isAvailable || !!validationError || selectedPath === currentUrlPath}
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
            >
              {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : 'Set'}
            </button>
          )}
        </div>
        
        {getAvailabilityStatus()}
      </div>

      {suggestions.length > 0 && canEdit && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Suggested Paths
          </label>
          <div className="grid grid-cols-1 gap-2">
            {suggestions.map((suggestion, index) => (
              <button
                key={index}
                onClick={() => handleSuggestionClick(suggestion)}
                className="flex items-center justify-between p-3 border border-gray-200 rounded-md hover:bg-gray-50 text-left"
              >
                <span className="font-mono text-sm">{suggestion}</span>
                <CheckCircle className="h-4 w-4 text-green-500" />
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-md">
          <XCircle className="h-4 w-4 text-red-500" />
          <span className="text-sm text-red-700">{error}</span>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-md">
          <CheckCircle className="h-4 w-4 text-green-500" />
          <span className="text-sm text-green-700">{success}</span>
        </div>
      )}
    </div>
  );
};

export default UrlPathManager;

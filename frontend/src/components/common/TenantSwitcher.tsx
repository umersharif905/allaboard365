// src/components/common/TenantSwitcher.tsx
import { Building, ChevronDown } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';

interface Tenant {
  TenantId: string;
  Name: string;
}

interface TenantSwitcherProps {
  isExpanded: boolean;
}

const TenantSwitcher: React.FC<TenantSwitcherProps> = ({ isExpanded }) => {
  const { user, switchTenant } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch tenant names for all accessible tenants
  useEffect(() => {
    // Check if user has TenantAdmin role (either as currentRole or in roles array)
    const hasTenantAdminRole = user?.currentRole === 'TenantAdmin' || 
                               (user?.roles && user.roles.includes('TenantAdmin'));
    
    if (!user || !hasTenantAdminRole) {
      return;
    }

    const accessibleTenantIds: string[] = [];
    if (user.tenantId) {
      accessibleTenantIds.push(user.tenantId);
    }
    if (user.additionalTenants && user.additionalTenants.length > 0) {
      accessibleTenantIds.push(...user.additionalTenants);
    }

    if (accessibleTenantIds.length <= 1) {
      // Only one tenant, no need to show switcher
      return;
    }

    const fetchTenants = async () => {
      setLoading(true);
      try {
        // Use the accessible-tenants endpoint for TenantAdmin users
        // This endpoint returns only the tenants the user has access to
        const response = await apiService.get<{ success: boolean; data?: Tenant[] }>('/api/me/tenant-admin/accessible-tenants');
        if (response.success && response.data) {
          setTenants(response.data);
        }
      } catch (error) {
        console.error('Failed to fetch tenants:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchTenants();
  }, [user]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Check if user has TenantAdmin role (either as currentRole or in roles array)
  const hasTenantAdminRole = user?.currentRole === 'TenantAdmin' || 
                             (user?.roles && user.roles.includes('TenantAdmin'));
  
  // Don't show if user doesn't have multiple tenants or isn't TenantAdmin
  if (!user || 
      !hasTenantAdminRole || 
      !user.tenantId ||
      !user.additionalTenants || 
      user.additionalTenants.length === 0) {
    return null;
  }

  // Don't show when collapsed
  if (!isExpanded) {
    return null;
  }

  const allTenantIds = [user.tenantId, ...(user.additionalTenants || [])];
  const currentTenant = tenants.find(t => t.TenantId === user.currentTenantId || t.TenantId === user.tenantId);
  const availableTenants = tenants.filter(t => 
    t.TenantId !== (user.currentTenantId || user.tenantId)
  );

  if (tenants.length <= 1) {
    // Still loading or only one tenant accessible
    return null;
  }

  const handleTenantSwitch = (tenantId: string) => {
    setIsOpen(false);
    switchTenant(tenantId);
  };

  return (
    <div className="relative mb-4" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-oe-neutral-dark transition-colors group border border-oe-neutral-dark"
      >
        <div className="flex items-center flex-1 text-left">
          <Building size={16} className="mr-2 text-oe-light opacity-75" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-oe-light truncate">
              {currentTenant?.Name || 'Select Tenant'}
            </div>
            <div className="text-xs text-oe-light opacity-75">
              {availableTenants.length + 1} tenant{availableTenants.length + 1 !== 1 ? 's' : ''} available
            </div>
          </div>
        </div>
        <ChevronDown 
          size={16} 
          className={`text-oe-light opacity-50 transition-transform ${isOpen ? 'rotate-180' : ''}`} 
        />
      </button>

      {/* Dropdown menu */}
      {isOpen && !loading && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white text-gray-900 rounded-lg shadow-lg border border-gray-200 z-50 max-h-64 overflow-y-auto">
          {/* Current tenant */}
          {currentTenant && (
            <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase border-b border-gray-200">
              Current Tenant
            </div>
          )}
          {currentTenant && (
            <div className="px-3 py-2 text-sm font-medium text-gray-900 bg-blue-50">
              <div className="flex items-center">
                <Building size={14} className="mr-2 text-oe-primary" />
                {currentTenant.Name}
              </div>
            </div>
          )}
          
          {/* Available tenants */}
          {availableTenants.length > 0 && (
            <>
              <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase border-t border-gray-200">
                Switch To
              </div>
              {availableTenants.map((tenant) => (
                <button
                  key={tenant.TenantId}
                  onClick={() => handleTenantSwitch(tenant.TenantId)}
                  className="w-full px-3 py-2 text-left hover:bg-gray-50 flex items-center gap-2"
                >
                  <Building size={14} className="text-gray-400" />
                  <div className="text-sm text-gray-900">{tenant.Name}</div>
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {loading && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white text-gray-900 rounded-lg shadow-lg border border-gray-200 z-50 p-3">
          <div className="text-sm text-gray-500">Loading tenants...</div>
        </div>
      )}
    </div>
  );
};

export default TenantSwitcher;


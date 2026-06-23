// src/components/common/RoleSwitcher.tsx
import { Building, ChevronDown, Settings, Shield, User, Users, Briefcase, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { UserRole } from '../../types/user.types';
import { apiService } from '../../services/api.service';

interface RoleSwitcherProps {
  isExpanded: boolean;
  title?: string;
  subtitle?: string;
}

// Role display configurations
const roleConfig: Record<UserRole, { label: string; icon: React.ReactNode; description: string }> = {
  SysAdmin: {
    label: 'System Admin',
    icon: <Settings size={16} />,
    description: 'System Administration'
  },
  TenantAdmin: {
    label: 'Admin',
    icon: <Building size={16} />,
    description: 'Tenant Management'
  },
  Agent: {
    label: 'Agent Portal',
    icon: <Shield size={16} />,
    description: 'Sales & Members'
  },
  AgencyOwner: {
    label: 'Agency Owner',
    icon: <Building size={16} />,
    description: 'Agency Ownership'
  },
  GroupAdmin: {
    label: 'Group Admin',
    icon: <Users size={16} />,
    description: 'Group Management'
  },
  Member: {
    label: 'Member Portal',
    icon: <User size={16} />,
    description: 'My Benefits'
  },
  VendorAdmin: {
    label: 'Vendor Admin',
    icon: <Briefcase size={16} />,
    description: 'Vendor Administration'
  },
  VendorAgent: {
    label: 'Vendor Agent',
    icon: <Briefcase size={16} />,
    description: 'Vendor Sales'
  }
};

interface Tenant {
  TenantId: string;
  Name: string;
}

const normTenantId = (id: string | null | undefined) =>
  String(id || '').replace(/[{}]/gi, '').toLowerCase();

const tenantIdsMatch = (a: string | null | undefined, b: string | null | undefined) => {
  const na = normTenantId(a);
  const nb = normTenantId(b);
  return na !== '' && na === nb;
};

const RoleSwitcher: React.FC<RoleSwitcherProps> = ({ isExpanded, title, subtitle }) => {
  const { user, switchRole, switchTenant } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredRole, setHoveredRole] = useState<UserRole | null>(null);
  const [showTenantModal, setShowTenantModal] = useState(false);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loadingTenants, setLoadingTenants] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const tenantDropdownRef = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check if user has TenantAdmin role and multiple tenants
  const hasTenantAdminRole = user?.currentRole === 'TenantAdmin' || 
                             (user?.roles && user.roles.includes('TenantAdmin'));
  
  const accessibleTenantIds: string[] = [];
  if (hasTenantAdminRole && user) {
    if (user.tenantId) {
      accessibleTenantIds.push(user.tenantId);
    }
    if (user.additionalTenants && user.additionalTenants.length > 0) {
      // Filter out any null/empty values and the null GUID
      const validAdditional = user.additionalTenants.filter(id => 
        id && 
        id.trim() !== '' && 
        id !== '00000000-0000-0000-0000-000000000000'
      );
      accessibleTenantIds.push(...validAdditional);
    }
  }
  
  const hasMultipleTenants = accessibleTenantIds.length > 1;
  const showTenantSwitcher =
    hasTenantAdminRole && hasMultipleTenants && user?.currentRole === 'TenantAdmin';

  // Fetch accessible tenants for TenantAdmin (primary + AdditionalTenants)
  useEffect(() => {
    const shouldFetch =
      hasTenantAdminRole &&
      (hasMultipleTenants || user?.currentRole === 'TenantAdmin') &&
      tenants.length === 0 &&
      !loadingTenants;

    if (shouldFetch) {
      const fetchTenants = async () => {
        setLoadingTenants(true);
        try {
          const response = await apiService.get<{ success: boolean; data?: Tenant[] }>(
            '/api/me/tenant-admin/accessible-tenants'
          );
          if (response.success && response.data) {
            setTenants(response.data);
          }
        } catch (error) {
          console.error('[RoleSwitcher] Failed to fetch tenants:', error);
        } finally {
          setLoadingTenants(false);
        }
      };
      fetchTenants();
    }
  }, [hasTenantAdminRole, hasMultipleTenants, user?.currentRole, tenants.length, loadingTenants]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setHoveredRole(null);
      }
      if (tenantDropdownRef.current && !tenantDropdownRef.current.contains(event.target as Node)) {
        setHoveredRole(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  const currentTenantId = user?.currentTenantId || user?.tenantId;
  const primaryTenantId = user?.tenantId;
  const currentTenant = tenants.find((t) => tenantIdsMatch(t.TenantId, currentTenantId));
  const currentTenantName = currentTenant?.Name;

  // Single-role users without multi-tenant access: static title only
  if (!user || !user.roles || (user.roles.length <= 1 && !showTenantSwitcher)) {
    if (!isExpanded) {
      return null;
    }
    return (
      <div>
        <div className="text-base font-bold text-gray-900">{title}</div>
        {subtitle && <div className="text-xs text-gray-600">{subtitle}</div>}
      </div>
    );
  }

  // TenantAdmin with multiple orgs but only one role: tenant switcher only (no role dropdown)
  if (user.roles.length <= 1 && showTenantSwitcher) {
    if (!isExpanded) {
      return null;
    }

    const tenantLabel = currentTenantName
      ? `${roleConfig.TenantAdmin.label} / ${currentTenantName}`
      : roleConfig.TenantAdmin.label;

    return (
      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => setShowTenantModal(true)}
          className="w-full flex items-center justify-between p-2 rounded-lg transition-colors group"
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#DDE3EA'; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
        >
          <div className="text-left">
            <div className="text-sm font-bold text-gray-900">{tenantLabel}</div>
            <div className="text-xs text-gray-600">Switch organization</div>
          </div>
          <ChevronDown size={16} className="text-gray-600" />
        </button>

        {showTenantModal && (
          <div
            className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setShowTenantModal(false);
              }
            }}
          >
            <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
              <div className="flex items-center justify-between p-6 border-b border-gray-200">
                <div className="flex items-center space-x-3">
                  <Building className="h-6 w-6 text-oe-primary" />
                  <h3 className="text-lg font-semibold text-gray-900">Select Organization</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setShowTenantModal(false)}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="p-6">
                {loadingTenants ? (
                  <div className="text-center py-8 text-gray-500">Loading organizations...</div>
                ) : (
                  <div className="space-y-2">
                    {tenants.map((tenant) => {
                      const isCurrent = tenantIdsMatch(tenant.TenantId, currentTenantId);
                      const isPrimary = tenantIdsMatch(tenant.TenantId, primaryTenantId);
                      return (
                        <button
                          key={tenant.TenantId}
                          type="button"
                          onClick={() => {
                            setShowTenantModal(false);
                            switchTenant(tenant.TenantId);
                          }}
                          className={`w-full px-4 py-3 text-left rounded-lg border transition-colors ${
                            isCurrent
                              ? 'bg-blue-50 border-blue-200 text-blue-900'
                              : 'bg-white border-gray-200 hover:bg-gray-50 text-gray-900'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <Building size={18} className={isCurrent ? 'text-oe-primary' : 'text-gray-400'} />
                            <div className="flex-1">
                              <div className={`font-medium ${isCurrent ? 'text-blue-900' : 'text-gray-900'}`}>
                                {tenant.Name}
                                {isPrimary && <span className="text-xs text-gray-500 ml-2">(Primary)</span>}
                              </div>
                              {isCurrent && (
                                <div className="text-xs text-oe-primary mt-1">Currently active</div>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const currentRoleConfig = roleConfig[user.currentRole];
  const availableRoles = user.roles.filter(role => role !== user.currentRole);

  const handleRoleSwitch = (role: UserRole) => {
    setIsOpen(false);
    setHoveredRole(null);
    switchRole(role);
  };

  const handleTenantAdminClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasMultipleTenants) {
      // Fetch tenants if not already loaded
      if (tenants.length === 0 && !loadingTenants) {
        const fetchTenants = async () => {
          setLoadingTenants(true);
          try {
            const response = await apiService.get<{ success: boolean; data?: Tenant[] }>(
              '/api/me/tenant-admin/accessible-tenants'
            );
            if (response.success && response.data) {
              setTenants(response.data);
            }
          } catch (error) {
            console.error('Failed to fetch tenants:', error);
          } finally {
            setLoadingTenants(false);
          }
        };
        fetchTenants();
      }
      setShowTenantModal(true);
      setIsOpen(false);
    } else {
      handleRoleSwitch('TenantAdmin');
    }
  };

  const handleTenantSwitch = (tenantId: string) => {
    setShowTenantModal(false);
    setHoveredRole(null);
    switchTenant(tenantId);
    // Also switch to TenantAdmin role if not already
    if (user?.currentRole !== 'TenantAdmin') {
      switchRole('TenantAdmin');
    }
  };

  const handleTenantHover = (role: UserRole, isEntering: boolean) => {
    if (role === 'TenantAdmin' && hasMultipleTenants) {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
      if (isEntering) {
        hoverTimeoutRef.current = setTimeout(() => {
          setHoveredRole('TenantAdmin');
        }, 200); // Small delay to prevent accidental hovers
      } else {
        hoverTimeoutRef.current = setTimeout(() => {
          setHoveredRole(null);
        }, 300); // Delay before hiding to allow moving to submenu
      }
    } else {
      setHoveredRole(null);
    }
  };

  if (!isExpanded) {
    // Don't show anything when sidebar is collapsed
    return null;
  }

  // Expanded state - show current role as title with dropdown
  const isCurrentRoleTenantAdmin = user?.currentRole === 'TenantAdmin';
  const displayLabel = isCurrentRoleTenantAdmin && currentTenantName 
    ? `${currentRoleConfig.label} / ${currentTenantName}`
    : currentRoleConfig.label;
  
  const displayDescription = isCurrentRoleTenantAdmin && currentTenantName
    ? currentRoleConfig.description
    : currentRoleConfig.description;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-2 rounded-lg transition-colors group"
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#DDE3EA'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
      >
        <div className="text-left">
          <div className="text-sm font-bold text-gray-900">{displayLabel}</div>
        </div>
        <ChevronDown 
          size={16} 
          className={`text-gray-600 transition-transform ${isOpen ? 'rotate-180' : ''}`} 
        />
      </button>

      {/* Dropdown menu - simplified, no header */}
      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white text-gray-900 rounded-lg shadow-lg border border-gray-200 z-50">
          {/* Switch Tenant option when on TenantAdmin */}
          {isCurrentRoleTenantAdmin && hasMultipleTenants && (
            <button
              onClick={() => {
                setIsOpen(false);
                setShowTenantModal(true);
              }}
              className="w-full px-3 py-2 text-left hover:bg-gray-50 flex items-center gap-2 border-b border-gray-200"
            >
              <Building size={16} className="text-gray-400" />
              <div className="text-sm font-medium text-gray-900">Switch Tenant</div>
            </button>
          )}
          
          {availableRoles.map((role) => {
            const config = roleConfig[role];
            const isTenantAdmin = role === 'TenantAdmin';
            const showTenantSubmenu = isTenantAdmin && hasMultipleTenants && hoveredRole === 'TenantAdmin';
            
            return (
              <div
                key={role}
                className="relative"
                onMouseEnter={() => handleTenantHover(role, true)}
                onMouseLeave={() => handleTenantHover(role, false)}
              >
                <button
                  onClick={isTenantAdmin && hasMultipleTenants ? handleTenantAdminClick : () => handleRoleSwitch(role)}
                  className="w-full px-3 py-2 text-left hover:bg-gray-50 flex items-center gap-2 first:rounded-t-lg last:rounded-b-lg relative"
                >
                  {config.icon}
                  <div className="flex-1">
                    <div className="text-sm font-medium">{config.label}</div>
                  </div>
                  {isTenantAdmin && hasMultipleTenants && (
                    <ChevronDown size={14} className="text-gray-400 rotate-[-90deg]" />
                  )}
                </button>
                
                {/* Tenant submenu on hover */}
                {showTenantSubmenu && !loadingTenants && tenants.length > 0 && (
                  <div
                    ref={tenantDropdownRef}
                    className="absolute left-full top-0 ml-1 bg-white rounded-lg shadow-lg border border-gray-200 z-50 min-w-[200px]"
                    onMouseEnter={() => setHoveredRole('TenantAdmin')}
                    onMouseLeave={() => setHoveredRole(null)}
                  >
                    <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase border-b border-gray-200">
                      Select Tenant
                    </div>
                    {tenants.map((tenant) => {
                      const isCurrent = tenantIdsMatch(tenant.TenantId, currentTenantId);
                      const isPrimary = tenantIdsMatch(tenant.TenantId, primaryTenantId);
                      return (
                        <button
                          key={tenant.TenantId}
                          onClick={() => handleTenantSwitch(tenant.TenantId)}
                          className={`w-full px-3 py-2 text-left hover:bg-gray-50 flex items-center gap-2 ${
                            isCurrent ? 'bg-blue-50' : ''
                          }`}
                        >
                          <Building size={14} className={isCurrent ? 'text-oe-primary' : 'text-gray-400'} />
                          <div className="flex-1">
                            <div className={`text-sm ${isCurrent ? 'font-medium text-blue-900' : 'text-gray-900'}`}>
                              {tenant.Name}
                              {isPrimary && <span className="text-xs text-gray-500 ml-1">(Primary)</span>}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Tenant Selection Modal */}
      {showTenantModal && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowTenantModal(false);
            }
          }}
        >
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div className="flex items-center space-x-3">
                <Building className="h-6 w-6 text-oe-primary" />
                <h3 className="text-lg font-semibold text-gray-900">Select Tenant Portal</h3>
              </div>
              <button
                onClick={() => setShowTenantModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Content */}
            <div className="p-6">
              {loadingTenants ? (
                <div className="text-center py-8">
                  <div className="text-gray-500">Loading tenants...</div>
                </div>
              ) : tenants.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-gray-500 mb-2">No tenants available</div>
                  <div className="text-xs text-gray-400">
                    Debug: accessibleTenantIds = {JSON.stringify(accessibleTenantIds)}
                    <br />
                    user.tenantId = {user?.tenantId}
                    <br />
                    user.additionalTenants = {JSON.stringify(user?.additionalTenants)}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {tenants.map((tenant) => {
                    const isCurrent = tenantIdsMatch(tenant.TenantId, currentTenantId);
                    const isPrimary = tenantIdsMatch(tenant.TenantId, primaryTenantId);
                    return (
                      <button
                        key={tenant.TenantId}
                        onClick={() => handleTenantSwitch(tenant.TenantId)}
                        className={`w-full px-4 py-3 text-left rounded-lg border transition-colors ${
                          isCurrent
                            ? 'bg-blue-50 border-blue-200 text-blue-900'
                            : 'bg-white border-gray-200 hover:bg-gray-50 text-gray-900'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <Building size={18} className={isCurrent ? 'text-oe-primary' : 'text-gray-400'} />
                          <div className="flex-1">
                            <div className={`font-medium ${isCurrent ? 'text-blue-900' : 'text-gray-900'}`}>
                              {tenant.Name}
                              {isPrimary && <span className="text-xs text-gray-500 ml-2">(Primary)</span>}
                            </div>
                            {isCurrent && (
                              <div className="text-xs text-oe-primary mt-1">Currently active</div>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RoleSwitcher;
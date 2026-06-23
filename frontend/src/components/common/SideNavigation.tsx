import { Tooltip } from '@mui/material';
import { ChevronDown, DollarSign, LogOut, Megaphone, Menu, Plus, User } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useUserProfile from '../../hooks/useUserProfile';
import { apiService } from '../../services/api.service';
import { BugReportModal } from './BugReportFAB';
import ProfileEditModal from './ProfileEditModal';
import RoleSwitcher from './RoleSwitcher';

export interface NavigationItem {
  path: string;
  label: string;
  icon: React.ReactElement;
  description?: string;
}

/** When `show` is true, shows an orange megaphone icon; `tooltip` is shown in a hover tooltip on that icon. */
export type NavItemBadge = {
  show: boolean;
  tooltip: string;
};

export interface QuickAction {
  label: string;
  icon: React.ReactElement;
  action: () => void;
}

export interface ResourceItem {
  path: string;
  label: string;
  icon: React.ReactElement;
  description?: string;
  disabled?: boolean;
}

// Update the UserInfo interface to match what we actually need
export interface UserInfo {
  userId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string;
  role?: string;
  tenantName?: string;
  // Flag to indicate we should use the hook instead of props
  useProfileHook?: boolean;
}

interface SideNavigationProps {
  // Configuration
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  
  // Content
  title: string;
  subtitle?: string;
  navigationItems: NavigationItem[];
  
  // User info
  user?: UserInfo;
  onLogout: () => void;
  
  // Optional sections
  quickActions?: QuickAction[];
  resourceItems?: ResourceItem[];
  /** Per-path alert badge (e.g. incomplete training). */
  navItemBadges?: Record<string, NavItemBadge>;
  /** Agent portal: profile completion row above the role line (expanded sidebar). */
  profileCompletionSlot?: React.ReactNode;
  /** When sidebar is collapsed, show a small attention dot on the profile avatar if profile is incomplete. */
  profileIncompleteCollapsed?: boolean;
  /** Optional label under the user name (e.g. agent commission level). */
  userBadge?: string;
  /** Show the per-user Back Office email-signature field in Profile Settings (vendor only). */
  enableEmailSignature?: boolean;
}

const SideNavigation: React.FC<SideNavigationProps> = ({
  sidebarOpen,
  setSidebarOpen,
  title,
  subtitle,
  navigationItems,
  user,
  onLogout,
  quickActions = [],
  resourceItems = [],
  navItemBadges = {},
  profileCompletionSlot,
  profileIncompleteCollapsed = false,
  userBadge,
  enableEmailSignature = false
}) => {
  const navigate = useNavigate();
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [showBugReportModal, setShowBugReportModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  
  // Fetch user profile data if needed
  const { data: profileData, refetch: refetchProfile } = 
    user?.useProfileHook ? useUserProfile() : { data: null, refetch: () => {} };
  
  // Correctly access properties with PascalCase from the API
  const userData = {
    userId: profileData?.UserId || user?.userId,
    firstName: profileData?.FirstName || user?.firstName,
    lastName: profileData?.LastName || user?.lastName,
    email: profileData?.Email || user?.email,
    phoneNumber: profileData?.PhoneNumber || user?.phoneNumber,
    preferredColor: profileData?.PreferredColor ?? null,
    emailSignature: profileData?.EmailSignature ?? null,
    emailCard: profileData?.EmailCard ?? null,
    role: profileData?.UserType || user?.role
  };

  // Handle profile save
  const handleProfileSave = async (updatedProfile: Partial<typeof userData>) => {
    try {
      setProfileSaving(true);

      // Build payload — only include preferredColor when the modal actually
      // touched it (undefined leaves it alone; null clears).
      const payload: Record<string, unknown> = {
        firstName: updatedProfile.firstName,
        lastName: updatedProfile.lastName,
        phoneNumber: updatedProfile.phoneNumber,
      };
      if (updatedProfile.preferredColor !== undefined) {
        payload.preferredColor = updatedProfile.preferredColor;
      }
      if (updatedProfile.emailSignature !== undefined) {
        payload.emailSignature = updatedProfile.emailSignature;
      }
      if (updatedProfile.emailCard !== undefined) {
        payload.emailCard = updatedProfile.emailCard;
      }

      const response = await apiService.put('/api/users/me', payload) as { success: boolean; message?: string };

      if (response.success) {
        // Refresh profile data
        refetchProfile();
        setShowProfileModal(false);
        // Notify any open lists (share request rail, etc.) that user metadata
        // — most importantly PreferredColor — has changed so they re-fetch
        // and pick up the new color on existing claimer pills.
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('oe-user-profile-updated'));
        }
      }
    } catch (error) {
      console.error('Error updating profile:', error);
    } finally {
      setProfileSaving(false);
    }
  };
  
  // Close profile menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target as Node)) {
        setProfileMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []); // Empty dependency array since this effect only needs to run once

  const isActive = (path: string) => {
    const currentPath = window.location.pathname;
    
    // For index/dashboard routes like '/tenant-admin' or '/tenant-admin/dashboard'
    if (path.endsWith('/dashboard') || path === '/tenant-admin' || path === '/admin' || path === '/agent' || path === '/group-admin') {
      // Only highlight if we're on the dashboard or index page
      return currentPath === path || 
             currentPath === `${path}/` || 
             currentPath === `${path}/dashboard`;
    }
    
    // Exact match
    if (currentPath === path || currentPath === `${path}/`) {
      return true;
    }
    
    // For routes that have detail pages (like /admin/groups -> /admin/groups/:id)
    // Check if current path starts with the navigation path followed by '/'
    // This handles cases like /admin/groups/:groupId keeping /admin/groups active
    // Example: /admin/groups/123-456-789 matches /admin/groups
    if (currentPath.startsWith(`${path}/`)) {
      return true;
    }
    
    return false;
  };

  const handleNavigation = (path: string) => {
    navigate(path);
  };

  return (
    <div className={`${sidebarOpen ? 'w-64' : 'w-20'} transition-all duration-300 ease-in-out flex flex-col h-screen fixed left-0 top-0 z-40`} style={{ backgroundColor: '#E5E7EB', borderRight: '1px solid #E5E7EB' }}>
      {/* Top Header - Fixed */}
      <div className="flex-shrink-0 h-20 flex items-center justify-between px-4" style={{ borderBottom: '1px solid #DDE3EA' }}>
        <div className="flex items-center flex-1">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 rounded-lg transition-colors mr-3 text-gray-700"
            style={{ backgroundColor: 'transparent' }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#DDE3EA'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
            <Menu size={24} />
          </button>
          
          {/* Role Switcher replaces the title when expanded and user has multiple roles */}
          <div className="flex-1">
            <RoleSwitcher 
              isExpanded={sidebarOpen} 
              title={title}
              subtitle={subtitle}
            />
          </div>
        </div>
      </div>
      
      {/* Navigation Menu - Scrollable */}
      <div className="flex-grow overflow-y-auto">
        <nav className="px-4 pt-2 pb-6">
          <ul className="space-y-2">
            {navigationItems.map((item) => {
              const active = isActive(item.path);
              const badge = navItemBadges[item.path];
              const navButtonTitle = !sidebarOpen ? item.label : undefined;
              return (
                <li key={item.path}>
                  <button
                    onClick={() => handleNavigation(item.path)}
                    className={`relative overflow-hidden flex items-center w-full py-3 px-3 rounded-lg transition-all duration-200 group ${
                      active
                        ? 'text-gray-900 font-semibold'
                        : 'text-gray-700'
                    } ${!sidebarOpen && badge?.show ? 'justify-center' : ''}`}
                    style={active ? {
                      borderLeftWidth: '3px',
                      borderLeftColor: 'var(--oe-primary, #2563EB)',
                      backgroundColor: 'rgba(37, 99, 235, 0.08)'
                    } : {}}
                    title={navButtonTitle}
                    aria-label={
                      badge?.show && badge.tooltip ? `${item.label}. ${badge.tooltip}` : undefined
                    }
                  >
                    {/* Hover highlight — instant, no animation (skipped for the active item) */}
                    {!active && (
                      <span
                        aria-hidden
                        className="pointer-events-none absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100"
                        style={{ backgroundColor: '#DDE3EA' }}
                      />
                    )}
                    {!sidebarOpen && badge?.show ? (
                      <span className="relative z-10 inline-flex h-11 w-11 shrink-0 items-center justify-center">
                        <span
                          className={`flex items-center justify-center ${active ? 'text-oe-primary' : 'text-gray-600'}`}
                          style={active ? { color: 'var(--oe-primary, #2563EB)' } : {}}
                        >
                          {item.icon}
                        </span>
                        <Tooltip
                          title={badge.tooltip || 'Needs attention'}
                          arrow
                          placement="top"
                          enterDelay={250}
                          slotProps={{
                            tooltip: {
                              sx: {
                                bgcolor: 'grey.900',
                                fontSize: '0.8125rem',
                                maxWidth: 280,
                                px: 1.25,
                                py: 0.75,
                                '& .MuiTooltip-arrow': { color: 'grey.900' },
                              },
                            },
                          }}
                        >
                          <span
                            className="pointer-events-auto absolute bottom-0 right-0 z-10 h-2.5 w-2.5 translate-x-px translate-y-px rounded-full bg-orange-500 shadow-[0_1px_3px_rgba(0,0,0,0.22)]"
                            aria-hidden
                          />
                        </Tooltip>
                      </span>
                    ) : (
                      <>
                        <div
                          className={`relative z-10 flex-shrink-0 ${active ? 'text-oe-primary' : 'text-gray-600'}`}
                          style={active ? { color: 'var(--oe-primary, #2563EB)' } : {}}
                        >
                          {item.icon}
                        </div>
                        {sidebarOpen && (
                          <div className="relative z-10 ml-3 flex-1 text-left font-medium truncate">
                            {item.label}
                          </div>
                        )}
                        {badge?.show && sidebarOpen ? (
                          <Tooltip
                            title={badge.tooltip || 'Needs attention'}
                            arrow
                            placement="top"
                            enterDelay={250}
                            slotProps={{
                              tooltip: {
                                sx: {
                                  bgcolor: 'grey.900',
                                  fontSize: '0.8125rem',
                                  maxWidth: 280,
                                  px: 1.25,
                                  py: 0.75,
                                  '& .MuiTooltip-arrow': { color: 'grey.900' },
                                },
                              },
                            }}
                          >
                            <span className="relative z-10 ml-2 inline-flex flex-shrink-0 items-center text-orange-500" aria-hidden>
                              <Megaphone className="h-[18px] w-[18px]" strokeWidth={2.25} aria-hidden />
                            </span>
                          </Tooltip>
                        ) : null}
                      </>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          
          {/* Quick Actions Section */}
          {sidebarOpen && quickActions.length > 0 && (
            <div className="mt-6 mb-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Quick Actions
              </div>
              <div className="space-y-2">
                {quickActions.map((action, index) => (
                  <button
                    key={index}
                    onClick={action.action}
                    className="w-full flex items-center px-3 py-2 text-sm text-gray-700 rounded-md transition-colors duration-200"
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#DDE3EA'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                  >
                    <span className="mr-2 text-gray-600">{action.icon}</span>
                    {action.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </nav>
      </div>
      
      {/* User Profile Section - Fixed at bottom */}
      <div className="flex-shrink-0 p-4 mt-auto" style={{ borderTop: '1px solid #DDE3EA' }}>
        {sidebarOpen ? (
          <div className="relative" ref={profileMenuRef}>
            {/* Profile Info with Menu */}
            <div 
              className="flex items-center cursor-pointer group"
              onClick={() => setProfileMenuOpen(!profileMenuOpen)}
            >
              <div className="w-10 h-10 rounded-full bg-oe-primary flex items-center justify-center shrink-0">
                <User size={20} className="text-white" />
              </div>
              <div className="ml-3 flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">
                  {userData.firstName && userData.lastName 
                    ? `${userData.firstName} ${userData.lastName}`
                    : title
                  }
                </p>
                <p className="text-xs text-gray-600 truncate">
                  {userData.email || 'user@openenroll.com'}
                </p>
                {userBadge && (
                  <span className="mt-1 inline-flex items-start gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-100 text-blue-800 border border-blue-200 whitespace-normal break-words leading-tight max-w-full">
                    <DollarSign size={10} className="shrink-0 mt-0.5" aria-hidden />
                    {userBadge}
                  </span>
                )}
                {profileCompletionSlot}
                {(userData.role || subtitle) ? (
                  <p className="text-xs text-gray-500">
                    {userData.role || subtitle}
                  </p>
                ) : null}
              </div>
              <ChevronDown 
                size={16} 
                className={`text-gray-500 group-hover:text-gray-700 transition-all ${profileMenuOpen ? 'transform rotate-180' : ''}`}
              />
            </div>

            {/* Profile Dropdown Menu */}
            {profileMenuOpen && (
              <div className="absolute bottom-full left-0 w-full mb-2 bg-white rounded-lg shadow-lg border border-gray-200 py-2 z-50">
                <div className="p-2 border-b border-gray-200 mb-2">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase">Actions</h3>
                </div>

                {/* Profile Settings */}
                <button
                  type="button"
                  onClick={() => {
                    setProfileMenuOpen(false);
                    if (userData.email) {
                      setShowProfileModal(true);
                    }
                  }}
                  disabled={!userData.email}
                  className={`w-full flex items-center px-4 py-2 text-sm transition-colors ${
                    userData.email
                      ? 'text-gray-700 hover:bg-gray-50'
                      : 'text-gray-400 cursor-not-allowed opacity-60'
                  }`}
                  title={userData.email ? 'Edit name and phone' : 'Profile email unavailable'}
                >
                  <User size={16} className={`mr-2 ${userData.email ? 'text-gray-600' : 'text-gray-400'}`} />
                  Profile Settings
                </button>

                {/* Custom Resource Items */}
                {resourceItems.map((item, index) => (
                  <button
                    key={index}
                    onClick={() => {
                      if (item.disabled) return;
                      setProfileMenuOpen(false);
                      navigate(item.path);
                    }}
                    disabled={item.disabled}
                    className={`w-full flex items-center px-4 py-2 text-sm transition-colors ${
                      item.disabled
                        ? 'text-gray-400 cursor-not-allowed opacity-60'
                        : 'text-gray-700 hover:bg-gray-50'
                    }`}
                    title={item.disabled ? 'Coming soon' : item.description}
                  >
                    <span className={`mr-2 ${item.disabled ? 'text-gray-400' : 'text-gray-600'}`}>
                      {item.icon}
                    </span>
                    {item.label}
                  </button>
                ))}

                {/* New Support Ticket */}
                <button
                  type="button"
                  onClick={() => {
                    setProfileMenuOpen(false);
                    setShowBugReportModal(true);
                  }}
                  className="w-full flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <Plus size={16} className="mr-2 text-gray-600" />
                  New Support Ticket
                </button>

                {/* Logout Button */}
                <button
                  onClick={() => {
                    setProfileMenuOpen(false);
                    onLogout();
                  }}
                  className="w-full flex items-center px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors mt-2 border-t border-gray-200 pt-2"
                >
                  <LogOut size={16} className="mr-2" />
                  Sign Out
                </button>
              </div>
            )}
          </div>
        ) : (
          // Compact user profile when sidebar is collapsed
          <div className="flex flex-col items-center relative">
            <button
              onClick={() => setProfileMenuOpen(!profileMenuOpen)}
              className="relative w-10 h-10 rounded-full bg-oe-primary flex items-center justify-center mb-2"
              title={userData.firstName ? `${userData.firstName} ${userData.lastName}` : 'User Profile'}
            >
              <User size={20} className="text-white" />
              {profileIncompleteCollapsed && (
                <span
                  className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-[#E5E7EB]"
                  aria-hidden
                />
              )}
            </button>
            {userBadge && (
              <span
                className="mb-1 max-w-[5.5rem] text-center text-[10px] font-medium text-blue-800 leading-tight line-clamp-2 px-0.5"
                title={userBadge}
              >
                {userBadge}
              </span>
            )}
            
            {/* Mini dropdown when sidebar is collapsed */}
            {profileMenuOpen && (
              <div className="absolute left-20 bottom-16 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-2 z-50">
                <div className="p-2 border-b border-gray-200">
                  <p className="text-sm font-medium text-gray-900">
                    {userData.firstName && userData.lastName 
                      ? `${userData.firstName} ${userData.lastName}`
                      : title
                    }
                  </p>
                  <p className="text-xs text-gray-600">
                    {userData.email || 'user@openenroll.com'}
                  </p>
                  {userBadge && (
                    <p className="text-[10px] text-blue-800 font-medium mt-1.5 line-clamp-2 break-words">{userBadge}</p>
                  )}
                </div>
                
                <button
                  type="button"
                  onClick={() => {
                    setProfileMenuOpen(false);
                    if (userData.email) {
                      setShowProfileModal(true);
                    }
                  }}
                  disabled={!userData.email}
                  className={`w-full flex items-center px-4 py-2 text-sm transition-colors ${
                    userData.email
                      ? 'text-gray-700 hover:bg-gray-50'
                      : 'text-gray-400 cursor-not-allowed opacity-60'
                  }`}
                  title={userData.email ? 'Edit name and phone' : 'Profile email unavailable'}
                >
                  <User size={16} className={`mr-2 ${userData.email ? 'text-gray-600' : 'text-gray-400'}`} />
                  Profile Settings
                </button>
                
                <button
                  type="button"
                  onClick={() => {
                    setProfileMenuOpen(false);
                    setShowBugReportModal(true);
                  }}
                  className="w-full flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <Plus size={16} className="mr-2 text-gray-600" />
                  New Support Ticket
                </button>

                <button
                  onClick={() => {
                    setProfileMenuOpen(false);
                    onLogout();
                  }}
                  className="w-full flex items-center px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors mt-2 border-t border-gray-200 pt-2"
                >
                  <LogOut size={16} className="mr-2" />
                  Sign Out
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Profile Edit Modal */}
      {showProfileModal && userData.email && (
        <ProfileEditModal
          profile={{
            userId: userData.userId || '',
            firstName: userData.firstName || '',
            lastName: userData.lastName || '',
            email: userData.email,
            phoneNumber: userData.phoneNumber,
            preferredColor: userData.preferredColor,
            emailSignature: userData.emailSignature,
            emailCard: userData.emailCard
          }}
          onClose={() => setShowProfileModal(false)}
          onSave={handleProfileSave}
          loading={profileSaving}
          showEmailSignature={enableEmailSignature}
        />
      )}

      {/* Bug Report / Feature Request Modal */}
      <BugReportModal isOpen={showBugReportModal} onClose={() => setShowBugReportModal(false)} />
    </div>
  );
};

export default SideNavigation;
import {
  BarChart2,
  Building2Icon,
  ClipboardList,
  CreditCard,
  DollarSign,
  GraduationCap,
  HardDrive,
  HelpCircle,
  Link,
  Mail,
  Megaphone,
  FolderOpen,
  Package,
  Palette,
  Receipt,
  Settings,
  Shield,
  UserCheck,
  UserCog,
  UserPlus,
  Users
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import SideNavigation, { NavigationItem, ResourceItem } from '../components/common/SideNavigation';
import { useAuth } from '../contexts/AuthContext';
import { e123MigrationService } from '../services/e123Migration.service';

interface TenantAdminNavigationProps {
  currentUser?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    role?: string;
    tenantName?: string;
    useProfileHook?: boolean;
  };
  title?: string;
  subtitle?: string;
  onLogout?: () => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}

const TenantAdminNavigation: React.FC<TenantAdminNavigationProps> = ({
  currentUser,
  onLogout,
  sidebarOpen = true,
  setSidebarOpen = () => {},
  title,
  subtitle
}) => {
  const { logout, user: authUser } = useAuth();
  const canAccessAgentTraining =
    authUser?.currentRole === 'TenantAdmin' || authUser?.currentRole === 'SysAdmin';
  const [e123MigrationEnabled, setE123MigrationEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    e123MigrationService.getTenantPortalNavStatus()
      .then((res) => {
        if (!cancelled && res.success) {
          setE123MigrationEnabled(!!res.data?.enabled);
        }
      })
      .catch(() => {
        if (!cancelled) setE123MigrationEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authUser?.tenantId, authUser?.currentRole]);

  // Navigation items for TenantAdmin
  const navigationItems: NavigationItem[] = [
    { 
      path: '/tenant-admin/dashboard', 
      label: 'Dashboard', 
      icon: <BarChart2 size={20} />,
      description: 'Tenant overview and metrics'
    },
    { 
      path: '/tenant-admin/products', 
      label: 'Products', 
      icon: <Package size={20} />,
      description: 'Manage products'
    },
    {
      path: '/tenant-admin/groups',
      label: 'Groups',
      icon: <Building2Icon size={20} />,
      description: 'Manage business groups'
    },
    {
      path: '/tenant-admin/members',
      label: 'Members',
      icon: <Users size={20} />,
      description: 'Member management'
    },
    {
      path: '/tenant-admin/enrollment-links',
      label: 'Enrollment Links',
      icon: <Link size={20} />,
      description: 'Manage enrollment links'
    },
    {
      path: '/tenant-admin/marketing',
      label: 'Quote',
      icon: <Megaphone size={20} />,
      description: 'Build and send proposals'
    },
    {
      path: '/tenant-admin/prospects',
      label: 'Prospects',
      icon: <UserCheck size={20} />,
      description: 'Agency and agent leads'
    },
    {
      path: '/tenant-admin/resource-library',
      label: 'Resource Library',
      icon: <FolderOpen size={20} />,
      description: 'Documents and resources library'
    },
    {
      path: '/tenant-admin/message-center',
      label: 'Message Center',
      icon: <Mail size={20} />,
      description: 'Email, SMS, templates & campaigns'
    },
    ...(canAccessAgentTraining
      ? [
          {
            path: '/tenant-admin/training',
            label: 'Agent Training',
            icon: <GraduationCap size={20} />,
            description: 'Configure and manage agent training packages'
          }
        ]
      : []),
    ...(e123MigrationEnabled
      ? [
          {
            path: '/tenant-admin/migration',
            label: 'E123 Migration',
            icon: <HardDrive size={20} />,
            description: 'Import E123 members and map products for your tenant'
          }
        ]
      : []),
    {
      path: '/tenant-admin/sharing-forms',
      label: 'Forms',
      icon: <ClipboardList size={20} />,
      description: 'Build embeddable public forms and review submissions'
    },
    { 
      path: '/tenant-admin/agents', 
      label: 'Agents & Agencies', 
      icon: <UserPlus size={20} />,
      description: 'Manage agents, agencies, and onboarding links'
    },
    { 
      path: '/tenant-admin/accounting', 
      label: 'Payouts', 
      icon: <Receipt size={20} />,
      description: 'See payout reports and generate NACHA files'
    },
    { 
      path: '/tenant-admin/billing', 
      label: 'Billing', 
      icon: <CreditCard size={20} />,
      description: 'Revenue overview and payment transactions'
    },
    { 
      path: '/tenant-admin/commissions', 
      label: 'Commission Rules', 
      icon: <DollarSign size={20} />,
      description: 'Commission tracking and reports'
    },
    { 
      path: '/tenant-admin/users', 
      label: 'User Management', 
      icon: <UserCog size={20} />,
      description: 'Manage tenant users and roles'
    },
    { 
      path: '/tenant-admin/settings', 
      label: 'Settings', 
      icon: <Settings size={20} />,
      description: 'Tenant configuration'
    }
  ];

  // Resource items for user dropdown menu
  const resourceItems: ResourceItem[] = [
    { 
      path: '/tenant-admin/branding', 
      label: 'Branding & Themes', 
      icon: <Palette size={16} />,
      description: 'Customize your portal appearance',
      disabled: true // Coming soon
    },
    { 
      path: '/tenant-admin/help', 
      label: 'Help & Support', 
      icon: <HelpCircle size={16} />,
      description: 'Documentation and support',
      disabled: true // Coming soon
    },
    { 
      path: '/tenant-admin/security', 
      label: 'Security Settings', 
      icon: <Shield size={16} />,
      description: 'Security and compliance',
      disabled: true // Coming soon
    }
  ];

  const handleLogout = () => {
    // If a custom logout handler is provided, use it
    if (onLogout) {
      onLogout();
    } else {
      // Otherwise use the AuthContext logout
      logout();
    }
  };

  // Create user info object
  const userInfo = currentUser || {
    email: authUser?.email,
    tenantName: undefined,
    useProfileHook: true // This will trigger the hook to fetch full profile data
  };

  const navigationTitle = title || userInfo.tenantName || 'Tenant Administration';
  const navigationSubtitle = subtitle || 'Tenant Management';

  return (
    <SideNavigation
      sidebarOpen={sidebarOpen}
      setSidebarOpen={setSidebarOpen}
      title={navigationTitle}
      subtitle={navigationSubtitle}
      navigationItems={navigationItems}
      user={userInfo}
      onLogout={handleLogout}
      resourceItems={resourceItems}
    />
  );
};

export default TenantAdminNavigation;

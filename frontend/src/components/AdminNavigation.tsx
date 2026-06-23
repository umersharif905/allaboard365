import {
    BarChart2,
    Building,
    CheckSquare,
    CreditCard,
    DollarSign,
    FolderOpen,
    Globe,
    HardDrive,
    LayoutGrid,
    LifeBuoy,
    Link,
    RefreshCw,
    Settings,
    ShieldCheck,
    ShoppingCart,
    TrendingUp,
    Users
} from 'lucide-react';
import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import SideNavigation, { NavigationItem, ResourceItem } from './common/SideNavigation';
import { Mail } from 'lucide-react';

interface AdminNavigationProps {
  currentUser?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    role?: string;
  };
  onLogout?: () => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}

const AdminNavigation: React.FC<AdminNavigationProps> = ({
  currentUser,
  onLogout,
  sidebarOpen = true,
  setSidebarOpen = () => {}
}) => {
  // const navigate = useNavigate();
  const { logout, user: authUser } = useAuth();

  // Navigation items for SysAdmin
  const navigationItems: NavigationItem[] = [
    {
      path: '/admin/dashboard', 
      label: 'Dashboard', 
      icon: <BarChart2 size={20} />,
      description: 'System overview and metrics'
    },
    { 
      path: '/admin/marketplace', 
      label: 'Product Marketplace', 
      icon: <ShoppingCart size={20} />,
      description: 'Manage products and subscriptions'
    },
    { 
      path: '/admin/subscription-approvals', 
      label: 'Subscription Approvals', 
      icon: <CheckSquare size={20} />,
      description: 'Review pending subscription requests'
    },
    { 
      path: '/admin/tenants', 
      label: 'Tenants', 
      icon: <Building size={20} />,
      description: 'Insurance agency management'
    },
    {
      path: '/admin/agents',
      label: 'Agents & Agencies',
      icon: <Users size={20} />,
      description: 'View agents and agencies by tenant'
    },
    { 
      path: '/admin/users', 
      label: 'User Management', 
      icon: <Users size={20} />,
      description: 'Manage user accounts and profiles'
    },
  { 
      path: '/admin/vendors', 
      label: 'Vendors', 
      icon: <Building size={20} />,
      description: 'Vendor management'
    },
    {
      path: '/admin/migration',
      label: 'E123 Migration',
      icon: <HardDrive size={20} />,
      description: 'Import E123 members by agent downline'
    },
    {
      path: '/admin/groups',
      label: 'Groups',
      icon: <TrendingUp size={20} />,
      description: 'Business group and organization management'
    },
    {
      path: '/admin/group-type-change-requests',
      label: 'Group Type Changes',
      icon: <RefreshCw size={20} />,
      description: 'Cross-tenant group type conversion requests'
    },
    {
      path: '/admin/prospects',
      label: 'Prospects',
      icon: <Users size={20} />,
      description: 'Leads across tenants'
    },
    {
      path: '/admin/members',
      label: 'Members',
      icon: <Users size={20} />,
      description: 'User and member management'
    },
    { 
      path: '/admin/enrollment-links', 
      label: 'Enrollment Links', 
      icon: <Link size={20} />,
      description: 'Manage enrollment links'
    },
    {
      path: '/admin/marketing-resources',
      label: 'Resource Library',
      icon: <FolderOpen size={20} />,
      description: "Manage tenants' resource libraries and copy between tenants"
    },
    {
      path: '/admin/message-center',
      label: 'Message Center',
      icon: <Mail size={20} />,
      description: 'Email, SMS management'
    },
    { 
      path: '/admin/commissions', 
      label: 'Commission System', 
      icon: <DollarSign size={20} />,
      description: 'Global commission management and rules'
    },
    { 
      path: '/admin/accounting', 
      label: 'Accounting', 
      icon: <DollarSign size={20} />,
      description: 'Financial reporting and analytics'
    },
    { 
      path: '/admin/billing', 
      label: 'Billing', 
      icon: <CreditCard size={20} />,
      description: 'Revenue overview and payment transactions'
    },
    { 
      path: '/admin/settings', 
      label: 'Settings', 
      icon: <Settings size={20} />,
      description: 'System configuration and preferences'
    },
    {
      path: '/admin/system-audit',
      label: 'System Audit',
      icon: <ShieldCheck size={20} />,
      description: 'Integration errors, payout source drift, and AI inspector'
    }
  ];

  // Resource items for user dropdown menu
  const resourceItems: ResourceItem[] = [
    {
      path: '/admin/system-health',
      label: 'System Health',
      icon: <HardDrive size={16} />,
      description: 'Monitor system status'
    },
    {
      path: '/admin/integrations',
      label: 'Integrations',
      icon: <Globe size={16} />,
      description: 'API connections and services'
    },
    {
      path: '/admin/support',
      label: 'Support Dashboard',
      icon: <LifeBuoy size={16} />,
      description: 'Customer support tools'
    },
    {
      path: '/admin/design-system',
      label: 'UI Components',
      icon: <LayoutGrid size={16} />,
      description: 'Design system reference'
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
    useProfileHook: true // This will trigger the hook to fetch full profile data
  };

  return (
    <SideNavigation
      sidebarOpen={sidebarOpen}
      setSidebarOpen={setSidebarOpen}
      title="Admin Portal"
      subtitle="System Administration"
      navigationItems={navigationItems}
      user={userInfo}
      onLogout={handleLogout}
      resourceItems={resourceItems}
    />
  );
};

export default AdminNavigation;
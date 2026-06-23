// frontend/src/components/vendor/VendorNavigation.tsx
// Updated: Force cache refresh
import {
  BarChart2,
  BookOpen,
  Briefcase,
  Building2,
  Calculator,
  ClipboardList,
  DollarSign,
  FileText,
  FolderOpen,
  MessageCircle,
  Inbox,
  MessageSquare,
  Package,
  Phone,
  PhoneCall,
  Receipt,
  Settings,
  Upload,
  Users
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import SideNavigation, { NavigationItem } from '../common/SideNavigation';

interface VendorNavigationProps {
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

const VendorNavigation: React.FC<VendorNavigationProps> = ({
  currentUser,
  onLogout,
  sidebarOpen = true,
  setSidebarOpen = () => {}
}) => {
  const navigate = useNavigate();
  const { logout, user: authUser } = useAuth();
  const [shareRequestEnabled, setShareRequestEnabled] = useState(false);

  // Show Share Request nav when enabled on the vendor (oe.Vendors.ShareRequestEnabled) — set in Vendor Settings
  useEffect(() => {
    const checkShareRequestAccess = async () => {
      try {
        const response = await apiService.get<{ success: boolean; data?: { ShareRequestEnabled?: boolean } }>(
          '/api/me/vendor/profile'
        );
        if (response.success && response.data?.ShareRequestEnabled === true) {
          setShareRequestEnabled(true);
        } else {
          setShareRequestEnabled(false);
        }
      } catch {
        setShareRequestEnabled(false);
      }
    };

    void checkShareRequestAccess();
    const onProfileUpdated = () => {
      void checkShareRequestAccess();
    };
    window.addEventListener('oe-vendor-profile-updated', onProfileUpdated);
    return () => window.removeEventListener('oe-vendor-profile-updated', onProfileUpdated);
  }, []);

  // Base navigation items for Vendor (always shown)
  const baseNavigationItems: NavigationItem[] = [
    { 
      path: '/vendor/dashboard', 
      label: 'Dashboard', 
      icon: <BarChart2 size={20} />,
      description: 'Overview and metrics'
    },
    {
      path: '/vendor/members',
      label: 'Members',
      icon: <Users size={20} />,
      description: 'Members enrolled in your products'
    },
    {
      path: '/vendor/products',
      label: 'Products',
      icon: <Package size={20} />,
      description: 'Manage your products'
    },
    { 
      path: '/vendor/payments', 
      label: 'Payments', 
      icon: <DollarSign size={20} />,
      description: 'Payments from tenants'
    },
    {
      path: '/vendor/resource-library',
      label: 'Resource Library',
      icon: <FolderOpen size={20} />,
      description: 'Documents and resources library'
    },
    {
      path: '/vendor/training',
      label: 'Training',
      icon: <BookOpen size={20} />,
      description: 'Plan training reference (no due date)'
    },
    {
      path: '/vendor/sharing-forms',
      label: 'Forms',
      icon: <FileText size={20} />,
      description: 'Form builder and submissions'
    },
    {
      path: '/vendor/users',
      label: 'Vendor Team',
      icon: <Users size={20} />,
      description: 'Manage your vendor agents'
    },
    {
      path: '/vendor/zoom-settings',
      label: 'Phone & Zoom',
      icon: <PhoneCall size={20} />,
      description: 'Connect your Zoom phone line & map agents'
    },
    {
      path: '/vendor/import',
      label: 'Import',
      icon: <Upload size={20} />,
      description: 'Import members and sharing requests'
    },
    {
      path: '/vendor/tenants',
      label: 'Tenants',
      icon: <Building2 size={20} />,
      description: 'Import tenants and product subscriptions'
    },
    {
      path: '/vendor/invoices',
      label: 'Invoices',
      icon: <Receipt size={20} />,
      description: 'Generate invoices for external tenants'
    },
    {
      path: '/vendor/settings',
      label: 'Settings',
      icon: <Settings size={20} />,
      description: 'Vendor details, ACH accounts & users'
    }
  ];

  // Share Request navigation items (shown only when module is enabled)
  const shareRequestItems: NavigationItem[] = shareRequestEnabled ? [
    {
      path: '/vendor/inbox',
      label: 'Inbox',
      icon: <Inbox size={20} />,
      description: 'Shared mailbox — read, reply, and link email'
    },
    {
      path: '/vendor/share-requests',
      label: 'Share Requests',
      icon: <ClipboardList size={20} />,
      description: 'Manage share request assignments'
    },
    {
      path: '/vendor/cases',
      label: 'Cases',
      icon: <Briefcase size={20} />,
      description: 'Reimbursement, billing, complaints, appeals'
    },
    {
      path: '/vendor/encounters',
      label: 'Encounters',
      icon: <MessageCircle size={20} />,
      description: 'Care-team conversation records'
    },
    {
      path: '/vendor/call-center',
      label: 'Call Center',
      icon: <Phone size={20} />,
      description: 'View calls and call logs'
    },
    {
      path: '/vendor/procedure-pricing',
      label: 'Procedure Pricing',
      icon: <Calculator size={20} />,
      description: 'Medicare rates, target ranges, hospital asking prices'
    },
    {
      path: '/vendor/providers',
      label: 'Providers',
      icon: <Building2 size={20} />,
      description: 'Provider directory'
    },
    {
      path: '/vendor/messaging',
      label: 'Message Center',
      icon: <MessageSquare size={20} />,
      description: 'Templates, blasts, and campaigns'
    },
    {
      path: '/vendor/case-studies',
      label: 'Case Studies',
      icon: <FileText size={20} />,
      description: 'Patient success stories for the website'
    }
  ] : [];

  // Combine navigation items - insert share request items after Dashboard
  const combinedNavigationItems: NavigationItem[] = [
    baseNavigationItems[0], // Dashboard
    ...shareRequestItems,   // Share Request items (if enabled)
    ...baseNavigationItems.slice(1) // Rest of base items (Members, Products, etc.)
  ];

  // Settings and Vendor Team are VendorAdmin-only; hide them for VendorAgent
  // (back-office Agents shouldn't see vendor profile, ACH accounts, or manage other users).
  // Inbox is open to the whole vendor team (VendorAdmin + VendorAgent).
  const isVendorAdmin = authUser?.currentRole === 'VendorAdmin';
  const vendorAdminOnlyPaths = new Set([
    '/vendor/settings',
    '/vendor/users',
    '/vendor/zoom-settings',
    '/vendor/import',
    '/vendor/tenants',
    '/vendor/invoices',
  ]);
  const navigationItems: NavigationItem[] = isVendorAdmin
    ? combinedNavigationItems
    : combinedNavigationItems.filter((item) => !vendorAdminOnlyPaths.has(item.path));

  const handleLogout = () => {
    if (onLogout) {
      onLogout();
    } else {
      logout();
      navigate('/login');
    }
  };

  return (
    <SideNavigation
      sidebarOpen={sidebarOpen}
      setSidebarOpen={setSidebarOpen}
      title="Back Office"
      subtitle="Manage your vendor account"
      navigationItems={navigationItems}
      user={{
        ...currentUser,
        firstName: authUser?.firstName || currentUser?.firstName,
        lastName: authUser?.lastName || currentUser?.lastName,
        email: authUser?.email || currentUser?.email,
        useProfileHook: true
      }}
      onLogout={handleLogout}
      enableEmailSignature
    />
  );
};

export default VendorNavigation;

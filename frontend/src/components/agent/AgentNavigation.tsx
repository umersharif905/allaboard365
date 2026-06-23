import {
  BarChart2,
  Building,
  CreditCard,
  DollarSign,
  FolderOpen,
  GraduationCap,
  Link,
  Megaphone,
  Network,
  Package,
  Settings,
  UserPlus,
  Users
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import {
  AgentProfileCompletionSidebar,
  useAgentProfileValidation,
} from '../../contexts/AgentProfileValidationContext';
import { useAgentTrainingIncomplete } from '../../contexts/AgentTrainingIncompleteContext';
import SideNavigation, { type NavItemBadge, type NavigationItem, type QuickAction } from '../common/SideNavigation';

interface AgentNavigationProps {
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

const AgentNavigation: React.FC<AgentNavigationProps> = ({
  currentUser,
  onLogout,
  sidebarOpen = true,
  setSidebarOpen = () => {}
}) => {
  const { logout, user: authUser } = useAuth();
  const { trainingIncomplete, agentPortalTrainingEnabled } = useAgentTrainingIncomplete();
  const profileValidation = useAgentProfileValidation();
  const [commissionLevelBadge, setCommissionLevelBadge] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<{ success: boolean; data?: { CommissionLevelName?: string | null } }>(
          '/api/me/agent/profile'
        );
        if (cancelled) return;
        const n = res?.data?.CommissionLevelName;
        setCommissionLevelBadge(n && String(n).trim() ? String(n).trim() : undefined);
      } catch {
        if (!cancelled) setCommissionLevelBadge(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const profileIncompleteCollapsed = Boolean(
    profileValidation &&
      !profileValidation.isLoading &&
      !profileValidation.loadFailed &&
      profileValidation.summary &&
      !profileValidation.isProfileComplete
  );

  const navItemBadges = useMemo((): Record<string, NavItemBadge> => {
    if (!agentPortalTrainingEnabled) {
      return {};
    }

    return {
      '/agent/training': {
        show: trainingIncomplete,
        tooltip: 'Please click here to open Training and finish your assigned modules.'
      }
    };
  }, [trainingIncomplete, agentPortalTrainingEnabled]);

  // Navigation items for Agent
  const navigationItems: NavigationItem[] = useMemo(() => {
    const items: NavigationItem[] = [
      {
        path: '/agent/dashboard',
        label: 'Dashboard',
        icon: <BarChart2 size={20} />,
        description: 'Performance overview and metrics'
      },
      {
        path: '/agent/products',
        label: 'Products',
        icon: <Package size={20} />,
        description: 'Manage products'
      },
      {
        path: '/agent/marketing',
        label: 'Quote',
        icon: <Megaphone size={20} />,
        description: 'Build and send proposals'
      },
      {
        path: '/agent/prospects',
        label: 'Prospects',
        icon: <UserPlus size={20} />,
        description: 'Leads and their journey to enrollment'
      },
      {
        path: '/agent/resource-library',
        label: 'Resource Library',
        icon: <FolderOpen size={20} />,
        description: 'Documents and resources library'
      },
      {
        path: '/agent/groups',
        label: 'My Groups',
        icon: <Building size={20} />,
        description: 'Manage assigned groups'
      },
      {
        path: '/agent/members',
        label: 'My Members',
        icon: <Users size={20} />,
        description: 'Manage assigned members'
      },
      {
        path: '/agent/enrollment-links',
        label: 'Enrollment Links',
        icon: <Link size={20} />,
        description: 'Manage enrollment links'
      },
      {
        path: '/agent/agents',
        label: 'Agents',
        icon: <Network size={20} />,
        description: 'View agents and onboarding links'
      },
      {
        path: '/agent/commissions',
        label: 'Commissions',
        icon: <DollarSign size={20} />,
        description: 'Commission tracking and reports'
      },
      {
        path: '/agent/billing',
        label: 'Billing',
        icon: <CreditCard size={20} />,
        description: 'Payments for your members and groups'
      }
    ];

    if (agentPortalTrainingEnabled) {
      items.push({
        path: '/agent/training',
        label: 'Training',
        icon: <GraduationCap size={20} />,
        description: 'Assigned training packages and quizzes'
      });
    }

    items.push({
      path: '/agent/settings',
      label: 'Settings',
      icon: <Settings size={20} />,
      description: 'Account and preferences'
    });

    return items;
  }, [agentPortalTrainingEnabled]);

  // Quick actions - Commented out until features are implemented
  const quickActions: QuickAction[] = [
    // {
    //   label: 'Schedule Call',
    //   icon: <Phone className="h-4 w-4" />,
    //   action: () => navigate('/agent/activities?action=call')
    // },
    // {
    //   label: 'Send Quote',
    //   icon: <MessageCircle className="h-4 w-4" />,
    //   action: () => navigate('/agent/pipeline?action=quote')
    // }
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
      title="Agent Portal"
      navigationItems={navigationItems}
      user={userInfo}
      onLogout={handleLogout}
      quickActions={quickActions}
      profileCompletionSlot={<AgentProfileCompletionSidebar />}
      profileIncompleteCollapsed={profileIncompleteCollapsed}
      userBadge={commissionLevelBadge}
    />
  );
};

export default AgentNavigation;

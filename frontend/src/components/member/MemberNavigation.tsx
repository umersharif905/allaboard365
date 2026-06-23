import React from 'react';
import { useAuth } from '../../contexts/AuthContext';
import SideNavigation, { ResourceItem } from '../common/SideNavigation';
import { useMemberNavigationItems } from '../../hooks/member/useMemberNavigationItems';

interface MemberNavigationProps {
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

const MemberNavigation: React.FC<MemberNavigationProps> = ({
  currentUser,
  onLogout,
  sidebarOpen = true,
  setSidebarOpen = () => {}
}) => {
  const { logout, user: authUser } = useAuth();
  const navigationItems = useMemberNavigationItems();

  const resourceItems: ResourceItem[] = [];

  const handleLogout = () => {
    if (onLogout) {
      onLogout();
    } else {
      logout();
    }
  };

  const userInfo = currentUser || {
    email: authUser?.email,
    useProfileHook: true
  };

  return (
    <SideNavigation
      sidebarOpen={sidebarOpen}
      setSidebarOpen={setSidebarOpen}
      title="Member Portal"
      navigationItems={navigationItems}
      user={userInfo}
      onLogout={handleLogout}
      resourceItems={resourceItems}
    />
  );
};

export default MemberNavigation;

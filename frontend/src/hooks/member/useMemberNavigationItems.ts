import React, { useMemo } from 'react';
import {
  BarChart2,
  CreditCard,
  DollarSign,
  FileText,
  Mail,
  Settings,
  Stethoscope,
  UserPlus,
  Video
} from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import type { NavigationItem } from '../../components/common/SideNavigation';
import { useMemberProfile } from './useMemberProfile';
import { useTelemedicineStatus } from './useTelemedicineStatus';
import { useMemberVendorNavigation } from './useMemberVendorNavigation';
import type { VendorNavigationGroup } from '../../services/member/member-vendor-navigation.service';

const resolveVendorIcon = (iconName?: string | null): React.ReactElement => {
  const defaultIcon = React.createElement(FileText, { size: 20 });
  if (!iconName) return defaultIcon;

  const trimmedName = iconName.trim();
  if (!trimmedName) return defaultIcon;

  const IconComponent = (LucideIcons as Record<string, React.FC<{ size?: number }>>)[trimmedName];
  if (!IconComponent) return defaultIcon;

  return React.createElement(IconComponent, { size: 20 });
};

/**
 * Shared navigation item list for the member portal.
 * Consumed by both the desktop sidebar (`MemberNavigation`) and the
 * mobile off-canvas drawer (`MemberMobileDrawer`).
 */
export function useMemberNavigationItems(): NavigationItem[] {
  const { profile: memberProfile } = useMemberProfile();
  const { data: telemedicineStatus } = useTelemedicineStatus();
  const { data: vendorNavigationGroups } = useMemberVendorNavigation();
  const hasTelemedicine = telemedicineStatus?.hasTelemedicine === true;

  return useMemo(() => {
    const baseItems: NavigationItem[] = [
      {
        path: '/member/dashboard',
        label: 'Dashboard',
        icon: React.createElement(BarChart2, { size: 20 }),
        description: 'Personal overview and information'
      },
      {
        path: '/member/plans',
        label: 'Plans',
        icon: React.createElement(CreditCard, { size: 20 }),
        description: 'View your subscription plans'
      },
      {
        path: '/member/id-cards',
        label: 'ID Cards',
        icon: React.createElement(CreditCard, { size: 20 }),
        description: 'View your ID cards'
      },
      {
        path: '/member/dependents',
        label: 'Dependents',
        icon: React.createElement(UserPlus, { size: 20 }),
        description: 'View your dependents'
      },
      {
        path: '/member/documents',
        label: 'Documents',
        icon: React.createElement(FileText, { size: 20 }),
        description: 'View your documents and signed agreements'
      },
      ...(hasTelemedicine
        ? [{
            path: '/member/telemedicine',
            label: 'Telemedicine',
            icon: React.createElement(Video, { size: 20 }),
            description: 'Access your telemedicine portal'
          }]
        : []),
      {
        path: '/member/communication-preferences',
        label: 'Email & SMS',
        icon: React.createElement(Mail, { size: 20 }),
        description: 'Marketing email and SMS preferences'
      },
      {
        path: '/member/settings',
        label: 'Profile Settings',
        icon: React.createElement(Settings, { size: 20 }),
        description: 'Update your profile information'
      }
    ];

    if (!memberProfile?.groupId) {
      baseItems.splice(baseItems.length - 1, 0, {
        path: '/member/payments',
        label: 'Billing',
        icon: React.createElement(DollarSign, { size: 20 }),
        description: 'View your payments, invoices, and payment methods'
      });
    }

    baseItems.splice(3, 0, {
      path: '/member/sharing-requests',
      label: 'Medical Needs',
      icon: React.createElement(Stethoscope, { size: 20 }),
      description: 'Forms and links for your enrolled plans'
    });

    const vendorItems: NavigationItem[] = [];
    if (Array.isArray(vendorNavigationGroups)) {
      (vendorNavigationGroups as VendorNavigationGroup[]).forEach((group) => {
        group.pages.forEach((page) => {
          vendorItems.push({
            path: `/member/vendor/${group.vendorId}/${page.routeKey}`,
            label: page.label,
            icon: resolveVendorIcon(page.iconName),
            description: page.description || `Resources from ${group.vendorName}`
          });
        });
      });
    }

    return [...baseItems, ...vendorItems];
  }, [hasTelemedicine, memberProfile?.groupId, vendorNavigationGroups]);
}

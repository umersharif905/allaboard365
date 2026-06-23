import { useQuery } from '@tanstack/react-query';
import {
  MemberVendorNavigationService,
  VendorNavigationGroup
} from '../../services/member/member-vendor-navigation.service';

const vendorNavigationKeys = {
  all: ['member', 'vendor-navigation'] as const,
  pages: () => [...vendorNavigationKeys.all, 'pages'] as const
};

export const useMemberVendorNavigation = () => {
  return useQuery({
    queryKey: vendorNavigationKeys.pages(),
    queryFn: async (): Promise<VendorNavigationGroup[]> => {
      const response = await MemberVendorNavigationService.getVendorNavigationPages();
      if (!response.success) {
        throw new Error(response.message || 'Failed to load vendor navigation pages');
      }

      return response.data || [];
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000
  });
};

export default useMemberVendorNavigation;











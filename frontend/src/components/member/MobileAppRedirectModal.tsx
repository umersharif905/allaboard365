import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Smartphone } from 'lucide-react';
import { MemberTenantService } from '../../services/member/member-tenant.service';
import { isMobile, isIOS, isAndroid } from '../../utils/mobile-detection';
import { PlayStoreIcon, AppleIcon } from './PlayStoreIcon';

const SESSION_STORAGE_KEY = 'dismissedMobileAppRedirect';

export default function MobileAppRedirectModal() {
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem(SESSION_STORAGE_KEY) === 'true'
  );

  // Share the same react-query cache key as MobileAppDownload
  const { data: tenantInfo } = useQuery({
    queryKey: ['memberTenantInfo'],
    queryFn: async () => {
      const response = await MemberTenantService.getTenant();
      if (!response?.success || !response.data) {
        throw new Error('Failed to fetch tenant info');
      }
      return response.data;
    },
    staleTime: 60 * 60 * 1000,
    retry: 2,
    enabled: isMobile && !dismissed,
  });

  const appStoreUrl = tenantInfo?.AppStoreUrl || '';
  const playStoreUrl = tenantInfo?.PlayStoreUrl || '';

  // Don't show if: not mobile, already dismissed, or no URLs configured
  if (!isMobile || dismissed || (!appStoreUrl && !playStoreUrl)) {
    return null;
  }

  const dismiss = () => {
    sessionStorage.setItem(SESSION_STORAGE_KEY, 'true');
    setDismissed(true);
  };

  // Determine primary and secondary CTAs based on platform
  const showIOSPrimary = appStoreUrl && (isIOS || !isAndroid);

  const primaryUrl = showIOSPrimary ? appStoreUrl : playStoreUrl;
  const primaryLabel = showIOSPrimary ? 'Download on the App Store' : 'Get it on Google Play';
  const primaryIcon = showIOSPrimary
    ? <AppleIcon className="h-5 w-5 mr-2" />
    : <PlayStoreIcon className="h-5 w-5 mr-2" />;

  // Secondary link (the other platform)
  let secondaryUrl = '';
  let secondaryLabel = '';
  if (showIOSPrimary && playStoreUrl) {
    secondaryUrl = playStoreUrl;
    secondaryLabel = 'Also available on Google Play';
  } else if (!showIOSPrimary && appStoreUrl) {
    secondaryUrl = appStoreUrl;
    secondaryLabel = 'Also available on the App Store';
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="mobile-redirect-heading">
      <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-8 text-center relative">
        {/* Phone icon */}
        <div className="mx-auto mb-4 bg-blue-100 rounded-full p-4 w-16 h-16 flex items-center justify-center">
          <Smartphone size={28} className="text-blue-600" />
        </div>

        {/* Heading */}
        <h2 id="mobile-redirect-heading" className="text-xl font-bold text-gray-900 mb-2">
          The member portal works best in the app
        </h2>
        <p className="text-sm text-gray-500 mb-6">
          Download for the full mobile experience
        </p>

        {/* Primary CTA */}
        <a
          href={primaryUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center w-full px-6 py-3 bg-oe-primary text-white rounded-xl font-semibold text-sm hover:bg-oe-primary/90 transition-colors"
        >
          {primaryIcon}
          {primaryLabel}
        </a>

        {/* Secondary platform link */}
        {secondaryUrl && (
          <a
            href={secondaryUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-3 text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            {secondaryLabel}
          </a>
        )}

        {/* Continue to site — de-emphasized */}
        <button
          onClick={dismiss}
          className="mt-6 text-xs text-gray-300 hover:text-gray-500 transition-colors"
          aria-label="Dismiss and continue to member portal"
        >
          Continue to site anyway
        </button>
      </div>
    </div>
  );
}

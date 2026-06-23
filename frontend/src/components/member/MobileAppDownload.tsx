import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Smartphone } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { MemberTenantService } from '../../services/member/member-tenant.service';
import { isMobile } from '../../utils/mobile-detection';
import { PlayStoreIcon, AppleIcon } from './PlayStoreIcon';

export default function MobileAppDownload() {
  const { data: tenantInfo, isLoading } = useQuery({
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
  });

  const appStoreUrl = tenantInfo?.AppStoreUrl || '';
  const playStoreUrl = tenantInfo?.PlayStoreUrl || '';

  // Don't render if: loading, no URLs configured, or on mobile (modal handles mobile)
  if (isLoading || (!appStoreUrl && !playStoreUrl) || isMobile) {
    return null;
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-white">
        <div className="flex items-center">
          <div className="bg-blue-100 rounded-full p-2 mr-3">
            <Smartphone size={20} className="text-blue-600" />
          </div>
          <div>
            <h2 className="text-lg font-medium text-gray-900">Get the Mobile App</h2>
            <p className="text-sm text-gray-500">Access your benefits on the go</p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="p-6">
        <p className="text-gray-600 mb-6">
          Download our mobile app to manage your benefits, view ID cards, and submit sharing requests anytime, anywhere.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* iOS App */}
          {appStoreUrl && (
            <div className="border border-gray-200 rounded-lg p-6 hover:border-blue-300 transition-colors duration-200">
              <div className="flex items-center mb-4">
                <div className="bg-oe-primary rounded-xl p-2 mr-3">
                  <AppleIcon className="h-6 w-6 text-white" />
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">iOS App</h3>
                  <p className="text-sm text-gray-500">Download on the App Store</p>
                </div>
              </div>
              <div className="flex flex-col items-center">
                <div className="bg-white p-3 rounded-lg border border-gray-100 shadow-sm mb-4">
                  <QRCodeSVG value={appStoreUrl} size={140} level="M" includeMargin={false} />
                </div>
                <p className="text-xs text-gray-500 text-center mb-3">Scan with your iPhone camera</p>
                <a
                  href={appStoreUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary/90 transition-colors text-sm font-medium"
                >
                  <AppleIcon className="h-4 w-4 mr-2" />
                  App Store
                  <ChevronRight size={14} className="ml-1" />
                </a>
              </div>
            </div>
          )}

          {/* Android App */}
          {playStoreUrl && (
            <div className="border border-gray-200 rounded-lg p-6 hover:border-blue-300 transition-colors duration-200">
              <div className="flex items-center mb-4">
                <div className="bg-oe-primary rounded-xl p-2 mr-3 text-white">
                  <PlayStoreIcon className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Android App</h3>
                  <p className="text-sm text-gray-500">Get it on Google Play</p>
                </div>
              </div>
              <div className="flex flex-col items-center">
                <div className="bg-white p-3 rounded-lg border border-gray-100 shadow-sm mb-4">
                  <QRCodeSVG value={playStoreUrl} size={140} level="M" includeMargin={false} />
                </div>
                <p className="text-xs text-gray-500 text-center mb-3">Scan with your Android camera</p>
                <a
                  href={playStoreUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary/90 transition-colors text-sm font-medium"
                >
                  <PlayStoreIcon className="h-4 w-4 mr-2" />
                  Google Play
                  <ChevronRight size={14} className="ml-1" />
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

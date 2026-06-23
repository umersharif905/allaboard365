// frontend/src/components/member/MemberHeader.tsx
import React from 'react';
import { Menu } from 'lucide-react';
import { IMAGES } from '../../constants/images';

interface MemberHeaderProps {
  tenantName?: string;
  logoUrl?: string;
  onMenuClick?: () => void;
}

const MemberHeader: React.FC<MemberHeaderProps> = ({ tenantName, logoUrl, onMenuClick }) => {
  const handleImageError = (event: React.SyntheticEvent<HTMLImageElement>) => {
    event.currentTarget.onerror = null;
    event.currentTarget.src = IMAGES.UI.COMPANY_PLACEHOLDER;
  };

  return (
    <header className="h-14 md:h-20 bg-white border-b border-gray-200 flex items-center justify-between px-4 md:px-6 gap-3">
      {onMenuClick && (
        <button
          type="button"
          onClick={onMenuClick}
          className="md:hidden p-2 -ml-2 rounded-md text-gray-700 hover:bg-gray-100 min-h-11 min-w-11 flex items-center justify-center"
          aria-label="Open navigation menu"
        >
          <Menu size={24} />
        </button>
      )}
      <div className="text-base md:text-lg font-semibold text-gray-900 truncate flex-1 min-w-0">
        {tenantName || ''}
      </div>
      <img
        src={(logoUrl && logoUrl.trim()) ? logoUrl : IMAGES.UI.COMPANY_PLACEHOLDER}
        alt={tenantName ? `${tenantName} logo` : 'Tenant logo'}
        className="h-8 md:h-12 w-auto object-contain flex-shrink-0"
        loading="lazy"
        onError={handleImageError}
      />
    </header>
  );
};

export default MemberHeader;

// frontend/src/components/vendor/VendorHeader.tsx
import React from 'react';
import NotificationsBell from './NotificationsBell';

interface VendorHeaderProps {
  vendorName?: string;
  logoUrl?: string;
}

const VendorHeader: React.FC<VendorHeaderProps> = ({ vendorName, logoUrl }) => {
  return (
    <header className="h-20 bg-white border-b border-gray-200 flex items-center justify-between px-6">
      <div className="text-lg font-semibold text-gray-900">
        {vendorName || 'Back Office'}
      </div>
      <div className="flex items-center gap-4">
        <NotificationsBell />
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={vendorName ? `${vendorName} logo` : 'Vendor logo'}
            className="h-12 w-auto object-contain"
          />
        ) : (
          <div className="h-12 w-12" />
        )}
      </div>
    </header>
  );
};

export default VendorHeader;

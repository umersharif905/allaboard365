// frontend/src/components/tenant-admin/TenantAdminHeader.tsx
import React from 'react';

interface TenantAdminHeaderProps {
  tenantName?: string;
  logoUrl?: string;
}

const TenantAdminHeader: React.FC<TenantAdminHeaderProps> = ({ tenantName, logoUrl }) => {
  return (
    <header className="h-20 bg-white border-b border-gray-200 flex items-center justify-between px-6">
      <div className="text-lg font-semibold text-gray-900">
        {tenantName || ''}
      </div>
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={tenantName ? `${tenantName} logo` : 'Tenant logo'}
          className="h-12 w-auto object-contain"
        />
      ) : (
        <div className="h-12 w-12" />
      )}
    </header>
  );
};

export default TenantAdminHeader;


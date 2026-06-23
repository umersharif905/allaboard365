// frontend/src/components/DomainTenantHandler.tsx
// Handles custom domain tenant identification and branding
import React, { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { API_CONFIG } from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import Login from '../pages/login';

interface TenantInfo {
  tenantId: string;
  name: string;
  urlPath: string;
  customDomain: string;
  logoUrl: string;
  primaryColorHex: string;
  secondaryColorHex: string;
}

const DomainTenantHandler: React.FC = () => {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  const [tenantInfo, setTenantInfo] = useState<TenantInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Get current hostname and path
    const hostname = window.location.hostname;
    const path = location.pathname;

    // LOCAL TESTING: allow ?customDomain=portal.mightywellhealth.com to simulate
    // a custom-domain visit while developing on localhost / default domain.
    const urlParams = new URLSearchParams(window.location.search);
    const customDomainParam = urlParams.get('customDomain');
    if (customDomainParam) {
      sessionStorage.setItem('customDomainOverride', customDomainParam);
    }
    const isDefaultDomain =
      hostname === 'localhost' || hostname.includes('allaboard365.com');
    const overrideHostname = isDefaultDomain
      ? sessionStorage.getItem('customDomainOverride')
      : null;

    console.log(`🌐 DomainTenantHandler - Starting domain analysis`);
    console.log(`🌐 Hostname: ${hostname}`);
    console.log(`🌐 Path: ${path}`);
    console.log(`🌐 Full URL: ${window.location.href}`);
    if (overrideHostname) {
      console.log(`🧪 Custom domain override active: ${overrideHostname}`);
    }

    if (isDefaultDomain && !overrideHostname) {
      console.log(`🌐 Default domain detected (${hostname}) - passing through to other routes`);
      setLoading(false);
    } else {
      const effectiveHostname = overrideHostname || hostname;
      console.log(`🌐 Custom domain detected: ${effectiveHostname} - attempting tenant identification`);
      // Always fetch tenant info for custom domains, even on /login route
      fetchTenantByDomain(effectiveHostname, path);
    }
  }, [location.pathname]);

  const fetchTenantByDomain = async (hostname: string, path: string) => {
    try {
      setLoading(true);
      setError(null);
      
      console.log(`🔍 DomainTenantHandler - Starting tenant lookup`);
      console.log(`🔍 Custom domain: ${hostname}`);
      console.log(`🔍 Path: ${path}`);
      console.log(`🔍 Full URL: ${window.location.href}`);
      console.log(`🔍 API endpoint: ${API_CONFIG.BASE_URL}/api/tenant-identification?path=${path}`);
      
      // Pass hostname explicitly to help backend identify the tenant
      const apiUrl = `${API_CONFIG.BASE_URL}/api/tenant-identification?path=${path}&hostname=${encodeURIComponent(hostname)}`;
      console.log(`🔍 Full API URL: ${apiUrl}`);
      
      const response = await fetch(apiUrl);
      
      console.log(`🔍 API response status: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        console.error(`❌ API call failed with status ${response.status}`);
        // Try to read error message
        try {
          const errorData = await response.json();
          console.error(`❌ Error response:`, errorData);
        } catch (e) {
          console.error(`❌ Could not parse error response`);
        }
        setError(`Failed to load tenant information (${response.status})`);
        return;
      }
      
      const data = await response.json();
      console.log(`🔍 API response data:`, data);
      
      if (data.success && data.data) {
        console.log(`✅ TENANT FOUND for custom domain ${hostname}:`);
        console.log(`✅ Tenant ID: ${data.data.tenantId}`);
        console.log(`✅ Tenant Name: ${data.data.name}`);
        console.log(`✅ Logo URL: ${data.data.logoUrl}`);
        console.log(`✅ Primary Color: ${data.data.primaryColorHex}`);
        console.log(`✅ Secondary Color: ${data.data.secondaryColorHex}`);
        
        setTenantInfo(data.data);
        // Store tenant info in localStorage with domain-specific key for branding consistency
        const storageKey = `currentTenantInfo_${hostname}`;
        localStorage.setItem(storageKey, JSON.stringify(data.data));
        console.log('✅ Custom domain tenant info stored in localStorage');
      } else {
        console.log(`❌ NO TENANT FOUND for custom domain: ${hostname}`);
        console.log(`❌ API response:`, data);
        setError('Tenant not found');
      }
    } catch (err: unknown) {
      const error = err as Error;
      console.error('❌ ERROR loading custom domain tenant info:', err);
      console.error('❌ Error details:', {
        message: error.message,
        stack: error.stack,
        hostname,
        path
      });
      setError('Failed to load tenant information');
    } finally {
      setLoading(false);
    }
  };

  // If not a custom domain (and no override), render the outlet to let other routes handle it
  const hostname = window.location.hostname;
  const isDefaultDomain =
    hostname === 'localhost' || hostname.includes('allaboard365.com');
  const hasOverride = Boolean(sessionStorage.getItem('customDomainOverride'));
  if (isDefaultDomain && !hasOverride) {
    console.log(`🌐 DomainTenantHandler - Not a custom domain, rendering outlet for other routes`);
    return <Outlet />;
  }

  if (isLoading || loading) {
    console.log(`🌐 DomainTenantHandler - Loading state, showing spinner`);
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
      </div>
    );
  }

  if (error || !tenantInfo) {
    console.log(`🌐 DomainTenantHandler - Error or no tenant found, redirecting to default login`);
    console.log(`🌐 Error: ${error}`);
    console.log(`🌐 TenantInfo: ${tenantInfo ? 'Present' : 'Missing'}`);
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // If user is logged in, redirect to their dashboard
  if (user) {
    const roleToUse = user.currentRole || (user.roles && user.roles.length > 0 ? user.roles[0] : user.userType);
    const redirectPath = getRedirectPath(roleToUse);
    console.log(`🌐 DomainTenantHandler - User logged in (${roleToUse}), redirecting to ${redirectPath}`);
    return <Navigate to={redirectPath} replace />;
  }

  // Show tenant-branded login for custom domain
  console.log(`🌐 DomainTenantHandler - Showing tenant-branded login for ${tenantInfo.name}`);
  return <Login tenantInfo={tenantInfo} />;
};

const getRedirectPath = (role: string | null | undefined): string => {
  switch (role) {
    case 'SysAdmin':
      return '/admin/dashboard';
    case 'TenantAdmin':
      return '/tenant-admin/dashboard';
    case 'VendorAdmin':
    case 'VendorAgent':
      return '/vendor/dashboard';
    case 'Agent':
      return '/agent/dashboard';
    case 'GroupAdmin':
      return '/group-admin';
    case 'Member':
    default:
      return '/member/dashboard';
  }
};

export default DomainTenantHandler;

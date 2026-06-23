import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { API_CONFIG } from '../config/api';

export interface PublicPageTenantInfo {
  tenantId: string;
  name: string;
  urlPath: string;
  customDomain: string;
  logoUrl: string;
  primaryColorHex: string;
  secondaryColorHex: string;
}

const DEFAULT_LOGO =
  '/images/branding/allaboard365/allaboard365-logo-primary-transparent.png';
const DEFAULT_BRAND_NAME = 'AllAboard365';

/** Resolve effective hostname for tenant lookup (supports localhost ?customDomain= override). */
export function getEffectiveCustomDomainHostname(
  searchParams?: URLSearchParams
): string | null {
  const hostname = window.location.hostname;
  const isDefaultDomain =
    hostname === 'localhost' || hostname.includes('allaboard365.com');

  const customDomainParam = searchParams?.get('customDomain');
  if (customDomainParam) {
    sessionStorage.setItem('customDomainOverride', customDomainParam);
  }
  const overrideHostname = isDefaultDomain
    ? sessionStorage.getItem('customDomainOverride')
    : null;

  if (isDefaultDomain && !overrideHostname) {
    return null;
  }
  return overrideHostname || hostname;
}

/**
 * Loads tenant branding for public pages on custom domains (privacy policy, terms, etc.).
 * Uses /api/tenant-identification, which picks the best tenant when multiple share a domain.
 */
export function useCustomDomainTenantBranding() {
  const [searchParams] = useSearchParams();
  const [tenantInfo, setTenantInfo] = useState<PublicPageTenantInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const effectiveHostname = getEffectiveCustomDomainHostname(searchParams);
    if (!effectiveHostname) {
      setTenantInfo(null);
      setLoading(false);
      return;
    }

    const storageKey = `currentTenantInfo_${effectiveHostname}`;
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try {
        setTenantInfo(JSON.parse(stored));
        setLoading(false);
        return;
      } catch {
        localStorage.removeItem(storageKey);
      }
    }

    let cancelled = false;
    (async () => {
      try {
        const path = window.location.pathname || '/';
        const apiUrl = `${API_CONFIG.BASE_URL}/api/tenant-identification?path=${encodeURIComponent(path)}&hostname=${encodeURIComponent(effectiveHostname)}`;
        const response = await fetch(apiUrl);
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data?.success && data?.data) {
          setTenantInfo(data.data);
          localStorage.setItem(storageKey, JSON.stringify(data.data));
        }
      } catch (err) {
        console.error('Error fetching custom domain tenant branding:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  const logoUrl = tenantInfo?.logoUrl?.trim() || DEFAULT_LOGO;
  const brandName = tenantInfo?.name?.trim() || DEFAULT_BRAND_NAME;

  return {
    tenantInfo,
    loading,
    logoUrl,
    brandName,
    isCustomDomain: Boolean(tenantInfo),
  };
}

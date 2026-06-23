import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import SharedHeader from '../../components/layout/SharedHeader';
import { apiService } from '../../services/api.service';
import Vendors from '../admin/Vendors';

/**
 * Vendor-portal settings page at /vendor/settings.
 *
 * Wraps the SysAdmin `<Vendors />` detail workspace in "vendor portal" mode:
 * resolves the logged-in user's own VendorId from /api/me/vendor/profile, then
 * delegates to the shared component with admin-only UI (list view,
 * "Back to Vendors", delete vendor) hidden. Backend auth is gated by
 * authorizeVendorDetail() — /api/vendors/:id/... now accepts VendorAdmin for
 * their own vendor.
 */
const VendorSelfSettings: React.FC = () => {
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<{
          success: boolean;
          data?: { Id?: string; VendorId?: string };
        }>('/api/me/vendor/profile');
        if (cancelled) return;
        if (!res.success || !res.data) {
          setError('Unable to load vendor profile.');
          return;
        }
        const id = res.data.Id || res.data.VendorId;
        if (!id) {
          setError('No vendor is associated with your account.');
          return;
        }
        setVendorId(id);
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Unable to load vendor profile.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="flex h-screen flex-col bg-oe-neutral-light">
        <SharedHeader title="Settings" showSearch={false} showNotifications onSearch={() => {}} />
        <div className="flex-1 overflow-auto p-6">
          <p className="text-red-600 mb-4">{error}</p>
          <Link to="/vendor/dashboard" className="text-oe-primary font-medium">
            ← Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (!vendorId) {
    return (
      <div className="flex h-screen flex-col bg-oe-neutral-light">
        <SharedHeader title="Settings" showSearch={false} showNotifications onSearch={() => {}} />
        <div className="flex-1 overflow-auto p-6">
          <div className="text-sm text-gray-500">Loading vendor settings…</div>
        </div>
      </div>
    );
  }

  return <Vendors mode="detail" routeVendorId={vendorId} portal="vendor" />;
};

export default VendorSelfSettings;

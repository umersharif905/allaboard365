import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import VendorImportPanel from '../../components/vendor/import/VendorImportPanel';
import { apiService } from '../../services/api.service';

/**
 * Vendor-portal import page at /vendor/import.
 * VendorAdmin-only — members eligibility + Sharewell share request migration.
 * Uses VendorLayout header (single notifications bell); no SharedHeader here.
 */
const VendorImportPage: React.FC = () => {
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
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to load vendor profile.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="p-6">
        <p className="text-red-600 mb-4">{error}</p>
        <Link to="/vendor/dashboard" className="text-oe-primary font-medium">
          ← Back to Dashboard
        </Link>
      </div>
    );
  }

  if (!vendorId) {
    return (
      <div className="p-6">
        <div className="text-sm text-gray-500">Loading import tools…</div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <VendorImportPanel vendorId={vendorId} />
    </div>
  );
};

export default VendorImportPage;

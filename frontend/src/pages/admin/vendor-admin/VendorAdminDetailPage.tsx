import type { FC } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import Vendors from '../Vendors';

/**
 * Full-page vendor admin workspace for a single vendor (SysAdmin).
 * @see Vendors list at /admin/vendors
 */
const VendorAdminDetailPage: FC = () => {
  const { vendorId } = useParams<{ vendorId: string }>();
  if (!vendorId) {
    return <Navigate to="/admin/vendors" replace />;
  }
  return <Vendors mode="detail" routeVendorId={vendorId} />;
};

export default VendorAdminDetailPage;

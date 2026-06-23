import React, { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { setE123MigrationPortalMode } from '../../utils/e123MigrationPortal';

const TenantE123MigrationLayout: React.FC = () => {
  // Must run before child routes render — useEffect runs after children mount and
  // would leave MigrationHub calling /api/admin/migration/* on first load.
  setE123MigrationPortalMode(true);

  useEffect(() => () => setE123MigrationPortalMode(false), []);

  return <Outlet />;
};

export default TenantE123MigrationLayout;

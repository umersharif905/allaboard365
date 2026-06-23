// frontend/src/pages/admin/GroupTypeChangeRequests.tsx
// SysAdmin cross-tenant view — wraps the shared TenantAdmin component with
// crossTenant=true so the backend returns all tenants and a Tenant column
// is shown in the table.
import React from 'react';
import GroupTypeChangeRequestsBase from '../tenant-admin/GroupTypeChangeRequests';

const GroupTypeChangeRequests: React.FC = () => (
  <GroupTypeChangeRequestsBase crossTenant />
);

export default GroupTypeChangeRequests;

// src/hooks/tenant-admin/useTenantAdmin.ts
import { useState } from 'react';
import TenantAdminService from '../../services/tenant-admin/tenant-admin.service';
import type { TenantMetrics, TenantUser, TenantGroup } from '../../types/index';

export function useTenantAdmin() {
  const [loading, setLoading] = useState(false);
  const [metrics, setMetrics] = useState<TenantMetrics | null>(null);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [groups, setGroups] = useState<TenantGroup[]>([]);

  const fetchMetrics = async () => {
    setLoading(true);
    try {
      const response = await TenantAdminService.getTenantMetrics();
      if (response.success && response.data) {
        setMetrics(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch metrics:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchUsers = async (filters: any = {}) => {
    setLoading(true);
    try {
      const response = await TenantAdminService.getTenantUsers(filters);
      if (response.success && response.data) {
        setUsers(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch users:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchGroups = async (filters: any = {}) => {
    setLoading(true);
    try {
      const response = await TenantAdminService.getTenantGroups(filters);
      if (response.success && response.data) {
        setGroups(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch groups:', error);
    } finally {
      setLoading(false);
    }
  };

  return {
    loading,
    metrics,
    users,
    groups,
    fetchMetrics,
    fetchUsers,
    fetchGroups
  };
}

export default useTenantAdmin;

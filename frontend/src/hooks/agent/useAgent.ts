// src/hooks/agent/useAgent.ts
import { useState } from 'react';
import { AgentService } from '../../services/agent/agent.service';
import type { AgentMember, AgentMetrics, CommissionRecord, SalesActivity, TenantGroup } from '../../types/index';

export function useAgent() {
  const [loading, setLoading] = useState(false);
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [members, setMembers] = useState<AgentMember[]>([]);
  const [groups, setGroups] = useState<TenantGroup[]>([]);
  const [commissions, setCommissions] = useState<CommissionRecord[]>([]);
  const [activities, setSalesActivities] = useState<SalesActivity[]>([]);
  const [leads, setLeads] = useState<any[]>([]);

  const fetchMetrics = async () => {
    setLoading(true);
    try {
      const response = await AgentService.getAgentDashboard();
      if (response.success && response.data) {
        setMetrics(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch metrics:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchMembers = async (filters: any = {}) => {
    setLoading(true);
    try {
      const response = await AgentService.getAssignedMembers(filters);
      if (response.success && response.data) {
        setMembers(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch members:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchGroups = async (filters: any = {}) => {
    setLoading(true);
    try {
      const response = await AgentService.getAssignedGroups(filters);
      if (response.success && response.data) {
        setGroups(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch groups:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchCommissions = async (filters: any = {}) => {
    setLoading(true);
    try {
      const response = await AgentService.getCommissions(filters);
      if (response.success && response.data) {
        setCommissions(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch commissions:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchActivities = async (filters: any = {}) => {
    setLoading(true);
    try {
      const response = await AgentService.getSalesActivities(filters);
      if (response.success && response.data) {
        setSalesActivities(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch activities:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchLeads = async (filters: any = {}) => {
    setLoading(true);
    try {
      const response = await AgentService.getLeads(filters);
      if (response.success && response.data) {
        setLeads(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch leads:', error);
    } finally {
      setLoading(false);
    }
  };

  return {
    loading,
    metrics,
    members,
    groups,
    commissions,
    activities,
    leads,
    fetchMetrics,
    fetchMembers,
    fetchGroups,
    fetchCommissions,
    fetchActivities,
    fetchLeads,
  };
}

export default useAgent;

import { useCallback, useState } from 'react';
import {
  e123MigrationService,
  GroupMigrationBatch,
  GroupMigrationDetectResult,
  GroupMigrationPreviewResult,
  GroupMigrationApplyResult,
} from '../../services/e123Migration.service';

export interface UseGroupMigrationBatchReturn {
  batch: GroupMigrationBatch | null;
  loadBatch: (batchId: string) => Promise<void>;
  createBatch: (payload: {
    instanceId: string;
    tenantId: string;
    rootBrokerId?: number | null;
    rootAgentLabel?: string | null;
  }) => Promise<GroupMigrationBatch>;
  patchBatch: (batchId: string, body: Record<string, unknown>) => Promise<void>;
  detect: (batchId: string) => Promise<GroupMigrationDetectResult>;
  preview: (batchId: string) => Promise<GroupMigrationPreviewResult>;
  apply: (batchId: string, groups: Array<Record<string, unknown>>) => Promise<GroupMigrationApplyResult>;
  loading: boolean;
  error: string | null;
  clearError: () => void;
}

export function useGroupMigrationBatch(): UseGroupMigrationBatchReturn {
  const [batch, setBatch] = useState<GroupMigrationBatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const loadBatch = useCallback(async (batchId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await e123MigrationService.getGroupMigrationBatch(batchId);
      if (!res.success || !res.data) throw new Error(res.message || 'Batch not found');
      setBatch(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load batch');
    } finally {
      setLoading(false);
    }
  }, []);

  const createBatch = useCallback(async (payload: {
    instanceId: string;
    tenantId: string;
    rootBrokerId?: number | null;
    rootAgentLabel?: string | null;
  }): Promise<GroupMigrationBatch> => {
    setLoading(true);
    setError(null);
    try {
      const res = await e123MigrationService.createGroupMigrationBatch(payload);
      if (!res.success || !res.data) throw new Error(res.message || 'Failed to create batch');
      setBatch(res.data);
      return res.data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create batch';
      setError(msg);
      throw new Error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  const patchBatch = useCallback(async (batchId: string, body: Record<string, unknown>) => {
    try {
      await e123MigrationService.patchGroupMigrationBatch(batchId, body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update batch');
      throw err;
    }
  }, []);

  const detect = useCallback(async (batchId: string): Promise<GroupMigrationDetectResult> => {
    setLoading(true);
    setError(null);
    try {
      const res = await e123MigrationService.detectGroupMigration(batchId);
      if (!res.success || !res.data) throw new Error(res.message || 'Detect failed');
      return res.data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Detect failed';
      setError(msg);
      throw new Error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  const preview = useCallback(async (batchId: string): Promise<GroupMigrationPreviewResult> => {
    setLoading(true);
    setError(null);
    try {
      const res = await e123MigrationService.previewGroupMigration(batchId);
      if (!res.success || !res.data) throw new Error(res.message || 'Preview failed');
      return res.data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Preview failed';
      setError(msg);
      throw new Error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  const apply = useCallback(async (
    batchId: string,
    groups: Array<Record<string, unknown>>
  ): Promise<GroupMigrationApplyResult> => {
    setLoading(true);
    setError(null);
    try {
      const res = await e123MigrationService.applyGroupMigration(batchId, groups);
      if (!res.success || !res.data) throw new Error(res.message || 'Apply failed');
      return res.data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Apply failed';
      setError(msg);
      throw new Error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    batch,
    loadBatch,
    createBatch,
    patchBatch,
    detect,
    preview,
    apply,
    loading,
    error,
    clearError,
  };
}

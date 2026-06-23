// frontend/src/hooks/vendor/useVendorImportJobRuns.ts
import { useQuery } from '@tanstack/react-query';
import { vendorSftpImportService } from '../../services/vendorSftpImport.service';
import type { RunHistoryFilters } from '../../types/vendor/vendorSftpImport.types';

export const useVendorImportJobRuns = (filters: RunHistoryFilters = {}) => {
  const query = useQuery({
    queryKey: ['vendorImportJobRuns', filters],
    queryFn: () => vendorSftpImportService.listRuns(filters),
    refetchInterval: (query) => {
      const runs = query.state.data?.runs ?? [];
      const hasRunning = runs.some((r) => r.status === 'running');
      return hasRunning ? 5000 : false;
    },
  });

  return query;
};

export const useVendorImportJobRun = (runId: string | null) =>
  useQuery({
    queryKey: ['vendorImportJobRun', runId],
    queryFn: () => vendorSftpImportService.getRun(runId as string),
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 3000 : false),
  });

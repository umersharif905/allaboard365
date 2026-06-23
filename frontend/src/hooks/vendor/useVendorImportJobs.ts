// frontend/src/hooks/vendor/useVendorImportJobs.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { vendorSftpImportService } from '../../services/vendorSftpImport.service';
import type { ImportJobFormValues } from '../../types/vendor/vendorSftpImport.types';

const QUERY_KEY = ['vendorImportJobs'];

export const useVendorImportJobs = () =>
  useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => vendorSftpImportService.listJobs(),
    refetchInterval: (query) => {
      const jobs = query.state.data;
      if (jobs?.some((j) => j.isRunning)) return 5000;
      return false;
    },
  });

export const useCreateImportJob = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportJobFormValues) => vendorSftpImportService.createJob(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
};

export const useUpdateImportJob = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, body }: { jobId: string; body: Partial<ImportJobFormValues> }) =>
      vendorSftpImportService.updateJob(jobId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
};

export const useDeleteImportJob = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => vendorSftpImportService.deleteJob(jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
};

export const useSetImportJobEnabled = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, enabled }: { jobId: string; enabled: boolean }) =>
      vendorSftpImportService.setJobEnabled(jobId, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
};

export const useRunImportJobNow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => vendorSftpImportService.runJobNow(jobId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      qc.invalidateQueries({ queryKey: ['vendorImportJobRuns'] });
    },
  });
};

export const useCancelImportJobRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => vendorSftpImportService.cancelJobRun(jobId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      qc.invalidateQueries({ queryKey: ['vendorImportJobRuns'] });
      qc.invalidateQueries({ queryKey: ['vendorImportJobRun'] });
    },
  });
};
